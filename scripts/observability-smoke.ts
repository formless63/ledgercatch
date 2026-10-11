import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";
import { observeApi, observeJob, observeRequest, routeLabel } from "../src/integrations/observability/http.server";
import { createStructuredLogger, exportEnabled, flushObservability, getLogger, getRequestId, initObservability, serviceMetadata, shutdownObservability, withLogContext, withSpan } from "../src/integrations/observability/runtime.server";

const mode = process.argv[2];
if (mode === "export" || mode === "offline") {
	initObservability({ registerSignals: false });
	await observeRequest(new Request("http://example.test/"), "/", async () => ({ response: Response.json({ ok: true }) }));
	await shutdownObservability();
} else {
	const logs: string[] = [];
	const spans = new InMemorySpanExporter();
	const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
	initObservability({ destination: { write: (line) => { logs.push(line); } }, registerSignals: false,
		spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
		metricReaders: [new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 60_000 })] });
	const logger = createStructuredLogger({ write: (line) => { logs.push(line); } }, { LOG_REDACT_FIELDS: "billingCredential" });
	logger.child({ component: "test", password: "child-password" }).info({
		projectId: "safe-project", authorization: "secret-auth", cookie: "secret-cookie", "set-cookie": "secret-set-cookie", "x-api-key": "secret-key",
		password: "secret-password", secret: "secret-secret", token: "secret-token", accessToken: "secret-access", refreshToken: "secret-refresh", clientSecret: "secret-client",
		deep: { array: [{ PASSWORD: "deep-secret", billingCredential: "custom-secret" }] },
		databaseUrl: "postgresql://user:password@internal/db", headers: { anything: "header-secret" },
		body: { text: "body-secret" }, payload: "payload-secret", session: { anything: "session-secret" },
		err: new Error("postgresql://user:password@internal/db app_raw-secret token-secret"),
	}, "Structured log test");
	const record = JSON.parse(logs[0]);
	assert.equal(record.component, "test");
	assert.equal(record.projectId, "safe-project");
	for (const field of ["level", "time", "msg", "service", "environment", "version", "revision"]) assert.ok(field in record);
	for (const secret of ["child-password", "secret-auth", "secret-cookie", "secret-set-cookie", "secret-key", "secret-password", "secret-secret", "secret-token", "secret-access", "secret-refresh", "secret-client", "deep-secret", "custom-secret", "header-secret", "body-secret", "payload-secret", "session-secret", "user:password", "app_raw-secret", "token-secret"]) assert.ok(!logs.join("").includes(secret), secret);
	assert.ok(!("body" in record));
	assert.ok(!("stack" in record.err));

	const parentTrace = "0123456789abcdef0123456789abcdef";
	for (const incoming of [undefined, "safe.request-123", "a".repeat(65), "bad request id"]) {
		const request = new Request("http://example.test/?token=query-secret", { headers: { ...(incoming ? { "X-Request-ID": incoming } : {}), traceparent: `00-${parentTrace}-0123456789abcdef-01` } });
		const result = await observeRequest(request, "/", async () => {
			assert.ok(getRequestId());
			await withSpan("nested.operation", async () => { getLogger().info({ component: "test" }, "Nested work"); });
			return { response: Response.json({ id: getRequestId() }) };
		});
		const id = result.response.headers.get("X-Request-ID");
		assert.equal((await result.response.json()).id, id);
		if (incoming === "safe.request-123") assert.equal(id, incoming);
		else assert.match(id ?? "", /^[a-f0-9-]{36}$/);
		const nested = logs.map((line) => JSON.parse(line)).reverse().find((entry) => entry.msg === "Nested work");
		assert.equal(nested.requestId, id);
		assert.equal(nested.traceId, parentTrace);
		assert.match(nested.spanId, /^[a-f0-9]{16}$/);
	}
	// Concurrent contexts must not bleed into one another.
	await Promise.all(["context-a", "context-b"].map((requestId) => withLogContext({ requestId }, async () => {
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(getRequestId(), requestId);
	})));
	assert.equal(getRequestId(), undefined);
	await assert.rejects(withSpan("failure.operation", async () => { throw new Error("error-secret"); }));
	await flushObservability();
	const failure = spans.getFinishedSpans().find((span) => span.name === "failure.operation");
	assert.equal(failure?.status.code, SpanStatusCode.ERROR);
	assert.equal(failure?.events[0]?.name, "exception");
	assert.ok(!JSON.stringify(failure?.events).includes("error-secret"));
	await observeRequest(new Request("http://example.test/"), "/", async () => ({ response: new Response(null, { status: 503 }) }));
	try {
		await observeRequest(new Request("http://example.test/", { headers: { "X-Request-ID": "redirect-safe" } }), "/", async () => { throw Response.redirect("http://example.test/next", 302); });
		assert.fail("Expected original redirect behavior");
	} catch (error) {
		assert.ok(error instanceof Response);
		assert.equal(error.status, 302);
		assert.equal(error.headers.get("X-Request-ID"), "redirect-safe");
	}
	for (const status of [401, 403, 429]) {
		const response = await observeApi("listProjects", new Request("http://example.test/?password=secret", { headers: { "X-API-Key": "app_super-secret" } }), async () => Response.json({ error: { code: `safe-${status}` } }, { status }));
		assert.equal(response.status, status);
		assert.deepEqual(await response.json(), { error: { code: `safe-${status}` } });
	}
	assert.equal(await observeJob({ name: "health.probe", id: "job-safe" }, async () => ({ echoed: "payload-secret" })).then((result) => result.echoed), "payload-secret");
	await assert.rejects(observeJob({ name: "health.probe", id: "job-failure" }, async () => { throw new Error("job-error-secret"); }));
	await flushObservability();
	const metricData = metrics.getMetrics().flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
	for (const name of ["http.server.request.count", "http.server.request.duration", "http.server.error.count", "api.request.count", "api.request.duration", "api.auth.failure.count", "job.execution.count", "job.execution.duration", "job.failure.count"]) assert.ok(metricData.some((metric) => metric.descriptor.name === name), name);
	const allowed = new Set(["http.request.method", "http.route", "http.response.status_code", "api.operation_id", "messaging.destination.name", "outcome"]);
	for (const metric of metricData) for (const point of metric.dataPoints) for (const key of Object.keys(point.attributes)) assert.ok(allowed.has(key), key);
	assert.equal(routeLabel(new Request("http://example.test/unknown/id?key=secret"), ["/"]), "unmatched");
	assert.ok(!logs.join("").includes("query-secret"));
	assert.ok(!logs.join("").includes("app_super-secret"));
	assert.ok(!logs.join("").includes("payload-secret"));
	assert.ok(logs.map((line) => JSON.parse(line)).some((entry) => entry.jobId === "job-safe" && entry.traceId));
	assert.ok(trace.getSpan(context.active()) === undefined);
	await shutdownObservability();
	await shutdownObservability();
	assert.equal(exportEnabled("TRACES", {}), false);
	assert.equal(serviceMetadata({ NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "" }).environment, "production");
	assert.equal(exportEnabled("METRICS", {}), false);
	assert.equal(exportEnabled("TRACES", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://example.test", OTEL_TRACES_EXPORTER: "none" }), false);
	assert.equal(exportEnabled("METRICS", { OTEL_EXPORTER_OTLP_ENDPOINT: "http://example.test", OTEL_SDK_DISABLED: "true" }), false);
	assert.throws(() => exportEnabled("TRACES", { OTEL_TRACES_EXPORTER: "otlp" }));

	// Fixture-owned OTLP/HTTP JSON receiver: actual SDK exports, no collector dependency.
	const received: { path: string; data: Record<string, unknown> }[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		received.push({ path: request.url ?? "", data: JSON.parse(Buffer.concat(chunks).toString()) });
		if (request.url?.startsWith("/unavailable/")) return;
		response.writeHead(200, { "content-type": "application/json" }).end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	async function child(childMode: string, extraEnv: Record<string, string>, unavailable = false) {
		const processChild = spawn(process.execPath, [process.argv[1], childMode], { env: { ...process.env, OTEL_SDK_DISABLED: "false", ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		processChild.stdout.on("data", (chunk) => { output += chunk; });
		processChild.stderr.on("data", (chunk) => { output += chunk; });
		const timeout = setTimeout(() => processChild.kill("SIGKILL"), 10_000);
		try {
			const code = await new Promise((resolve, reject) => { processChild.once("error", reject); processChild.once("exit", resolve); });
			assert.equal(code, 0, output);
			if (!unavailable) assert.ok(!/ECONNREFUSED|Telemetry flush incomplete/.test(output), output);
		} finally { clearTimeout(timeout); }
	}
	try {
		const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		await child("export", { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_TRACES_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" });
		assert.ok(received.some(({ path, data }) => path === "/v1/traces" && Array.isArray(data.resourceSpans)));
		assert.ok(received.some(({ path, data }) => path === "/v1/metrics" && Array.isArray(data.resourceMetrics)));
		const count = received.length;
		await child("offline", { OTEL_EXPORTER_OTLP_ENDPOINT: "", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "", OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "", OTEL_TRACES_EXPORTER: "", OTEL_METRICS_EXPORTER: "" });
		assert.equal(received.length, count);
		await child("export", { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_TRACES_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "none" });
		assert.ok(received.slice(count).every(({ path }) => path === "/v1/traces"));
		const traceOnlyCount = received.length;
		await child("export", { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "otlp" });
		assert.ok(received.slice(traceOnlyCount).every(({ path }) => path === "/v1/metrics"));
		await child("export", { OTEL_EXPORTER_OTLP_ENDPOINT: `${endpoint}/unavailable`, OTEL_TRACES_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "otlp" }, true);
	} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
	console.info("Observability smoke passed: safe logs, correlation, spans, metrics, OTLP and shutdown");
}
