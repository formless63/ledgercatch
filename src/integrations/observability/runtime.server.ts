import { AsyncLocalStorage } from "node:async_hooks";
import {
	context,
	propagation,
	ROOT_CONTEXT,
	type Span,
	type SpanOptions,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	type IMetricReader,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	AlwaysOffSampler,
	BatchSpanProcessor,
	type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import pino, { type DestinationStream } from "pino";
import { safeError, safeText, sanitize } from "./safety.server";

export type LogContext = {
	requestId?: string;
	component?: string;
	operation?: string;
	jobName?: string;
	jobId?: string;
};
const storage = new AsyncLocalStorage<LogContext>();
type Environment = Record<string, string | undefined>;

export function serviceMetadata(environment: Environment = process.env) {
	const field = (value: string | undefined, fallback: string) =>
		/^[\w .@/-]{1,120}$/.test(value ?? "") ? value : fallback;
	return {
		service: field(environment.OTEL_SERVICE_NAME, "tanstack-app"),
		environment: field(
			environment.DEPLOYMENT_ENVIRONMENT || environment.NODE_ENV,
			"development",
		),
		version: field(environment.APP_VERSION, "unknown"),
		revision: field(environment.APP_REVISION, "unknown"),
		runtime: `node ${process.versions.node}`,
	};
}

export function exportEnabled(
	signal: "TRACES" | "METRICS",
	environment: Environment,
) {
	const setting = environment[`OTEL_${signal}_EXPORTER`];
	if (setting && !["none", "otlp"].includes(setting))
		throw new Error(`OTEL_${signal}_EXPORTER supports none or otlp`);
	if (environment.OTEL_SDK_DISABLED === "true" || setting === "none")
		return false;
	const endpoint =
		environment[`OTEL_EXPORTER_OTLP_${signal}_ENDPOINT`] ||
		environment.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (setting === "otlp" && !endpoint)
		throw new Error(
			`OTLP ${signal.toLowerCase()} requires an explicit endpoint`,
		);
	if (!endpoint) return false;
	const url = new URL(endpoint);
	if (!["http:", "https:"].includes(url.protocol))
		throw new Error("OTLP endpoint must use HTTP(S)");
	return true;
}

export function createStructuredLogger(
	destination?: DestinationStream,
	environment: Environment = process.env,
) {
	const extraSecrets = (environment.LOG_REDACT_FIELDS ?? "")
		.split(",")
		.filter(Boolean);
	return pino(
		{
			level: environment.LOG_LEVEL || "info",
			base: serviceMetadata(environment),
			timestamp: pino.stdTimeFunctions.isoTime,
			formatters: {
				bindings: (bindings) =>
					sanitize(bindings, extraSecrets) as Record<string, unknown>,
				log: (object) =>
					sanitize(object, extraSecrets) as Record<string, unknown>,
			},
			serializers: {
				err: (error) => sanitize(error, extraSecrets),
				error: (error) => sanitize(error, extraSecrets),
			},
			mixin() {
				const active = trace.getSpan(context.active())?.spanContext();
				return {
					...storage.getStore(),
					...(active && trace.isSpanContextValid(active)
						? { traceId: active.traceId, spanId: active.spanId }
						: {}),
				};
			},
			hooks: {
				streamWrite(line) {
					// Covers child bindings too: Pino does not re-run the root binding formatter.
					return `${JSON.stringify(sanitize(JSON.parse(line), extraSecrets))}\n`;
				},
				logMethod(args, method) {
					const safeArgs = args.map((arg) => sanitize(arg, extraSecrets));
					// No printf interpolation of arbitrary objects/inputs.
					method.apply(this, safeArgs.slice(0, 2) as Parameters<typeof method>);
				},
			},
		},
		destination,
	);
}

interface InitOptions {
	environment?: Environment;
	destination?: DestinationStream;
	spanProcessors?: SpanProcessor[];
	metricReaders?: IMetricReader[];
	registerSignals?: boolean;
}
let runtime: ReturnType<typeof createRuntime> | undefined;
function createRuntime(options: InitOptions) {
	const environment = options.environment ?? process.env;
	const metadata = serviceMetadata(environment);
	const attributes: Record<string, string> = {};
	for (const entry of (environment.OTEL_RESOURCE_ATTRIBUTES ?? "").split(",")) {
		const index = entry.indexOf("=");
		if (index > 0)
			attributes[entry.slice(0, index).trim()] = safeText(
				decodeURIComponent(entry.slice(index + 1).trim()),
			);
	}
	const resource = resourceFromAttributes({
		...(sanitize(attributes) as Record<string, string>),
		"service.name": metadata.service,
		"service.version": metadata.version,
		"vcs.ref.head.revision": metadata.revision,
		"deployment.environment.name": metadata.environment,
		"process.runtime.name": "nodejs",
		"process.runtime.version": process.versions.node,
	});
	const disabled = environment.OTEL_SDK_DISABLED === "true";
	const processors = disabled
		? []
		: (options.spanProcessors ??
			(exportEnabled("TRACES", environment)
				? [
						new BatchSpanProcessor({
							exporter: new OTLPTraceExporter({ timeoutMillis: 2_000 }),
							exportTimeoutMillis: 2_000,
						}),
					]
				: []));
	const readers = disabled
		? []
		: (options.metricReaders ??
			(exportEnabled("METRICS", environment)
				? [
						new PeriodicExportingMetricReader({
							exporter: new OTLPMetricExporter({ timeoutMillis: 2_000 }),
							exportIntervalMillis: 60_000,
							exportTimeoutMillis: 2_000,
						}),
					]
				: []));
	const manager = new AsyncLocalStorageContextManager().enable();
	const tracerProvider = new NodeTracerProvider({
		resource,
		spanProcessors: processors,
		...(disabled ? { sampler: new AlwaysOffSampler() } : {}),
	});
	tracerProvider.register({
		contextManager: manager,
		propagator: new W3CTraceContextPropagator(),
	});
	const meterProvider = new MeterProvider({ resource, readers });
	const logger = createStructuredLogger(options.destination, environment);
	let shutdown: Promise<void> | undefined;
	const bounded = async (work: Promise<unknown>) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				work,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Telemetry flush timed out")),
						4_000,
					);
				}),
			]);
		} catch {
			logger.warn({ component: "observability" }, "Telemetry flush incomplete");
		} finally {
			clearTimeout(timer);
		}
	};
	const result = {
		logger,
		metadata,
		tracer: tracerProvider.getTracer("ledger.observability", "1.0.0"),
		meter: meterProvider.getMeter("ledger.observability", "1.0.0"),
		forceFlush: () =>
			bounded(
				Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]),
			),
		shutdown: () =>
			(shutdown ??= bounded(
				Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]),
			)),
	};
	if (options.registerSignals !== false) {
		for (const signal of ["SIGTERM", "SIGINT"] as const)
			process.once(signal, () => {
				void result.shutdown();
			});
	}
	return result;
}

export function initObservability(options: InitOptions = {}) {
	if (!runtime) runtime = createRuntime(options);
	return runtime;
}
export function getLogger() {
	return initObservability().logger;
}
export function getTracer() {
	return initObservability().tracer;
}
export function getMeter() {
	return initObservability().meter;
}
export function getRequestContext() {
	return storage.getStore();
}
export function getRequestId() {
	return storage.getStore()?.requestId;
}
export function withLogContext<T>(fields: LogContext, work: () => T): T {
	return storage.run({ ...storage.getStore(), ...fields }, work);
}
export function captureException(error: unknown, fields: LogContext = {}) {
	getLogger().error({ ...fields, err: safeError(error) }, "Operation failed");
	const span = trace.getSpan(context.active());
	const safe = safeError(error);
	span?.recordException({ name: safe.type, message: safe.message });
	span?.setStatus({ code: SpanStatusCode.ERROR });
}
export async function withSpan<T>(
	name: string,
	work: (span: Span) => Promise<T>,
	options: SpanOptions = {},
) {
	return getTracer().startActiveSpan(name, options, async (span) => {
		try {
			return await work(span);
		} catch (error) {
			if (!(error instanceof Response) || error.status >= 500)
				captureException(error);
			throw error;
		} finally {
			span.end();
		}
	});
}
export function inboundTrace<T>(request: Request, work: () => T): T {
	initObservability();
	const carrier = {
		traceparent: request.headers.get("traceparent") ?? "",
		tracestate: request.headers.get("tracestate") ?? "",
	};
	return context.with(propagation.extract(ROOT_CONTEXT, carrier), work);
}
export function flushObservability() {
	return initObservability().forceFlush();
}
export function shutdownObservability() {
	return initObservability().shutdown();
}
