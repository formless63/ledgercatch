import assert from "node:assert/strict";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace";
import {
	initObservability,
	flushObservability,
	shutdownObservability,
} from "../src/integrations/observability/runtime.server";
import { createStorage } from "../src/integrations/storage/storage.server";
import { storageConfig } from "../src/integrations/storage/config.server";
import { StorageError } from "../src/integrations/storage/errors.server";
import { observeStorage } from "../src/lib/storage.server";
const logs: string[] = [];
const spans = new InMemorySpanExporter();
const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
initObservability({
	destination: { write: (line) => logs.push(line) },
	registerSignals: false,
	spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
	metricReaders: [
		new PeriodicExportingMetricReader({
			exporter: metrics,
			exportIntervalMillis: 60000,
		}),
	],
});
const storage = createStorage(
	storageConfig({
		STORAGE_BUCKET: "private-bucket",
		STORAGE_REGION: "us-east-1",
		STORAGE_ACCESS_KEY_ID: "private-access",
		STORAGE_SECRET_ACCESS_KEY: "private-secret",
	}),
	observeStorage,
);
const signed = await storage.presignUpload("private-object-key", {
	contentType: "text/plain",
});
await assert.rejects(
	observeStorage("put", async () => {
		throw new StorageError("provider_error", { cause: new Error(signed.url) });
	}),
);
await flushObservability();
const exported = JSON.stringify({
	logs: logs.map((line) => JSON.parse(line)),
	spans: spans
		.getFinishedSpans()
		.map((span) => ({
			name: span.name,
			attributes: span.attributes,
			events: span.events,
		})),
	metrics: metrics.getMetrics(),
});
for (const secret of [
	"private-bucket",
	"private-object-key",
	"private-access",
	"private-secret",
	"X-Amz-Signature",
	"X-Amz-Credential",
])
	assert.ok(!exported.includes(secret), secret);
assert.ok(exported.includes("app.storage.operation.count"));
assert.ok(exported.includes("app.storage.operation.duration"));
assert.ok(exported.includes("failure"));
for (const resource of metrics.getMetrics())
	for (const scope of resource.scopeMetrics)
		for (const metric of scope.metrics)
			for (const point of metric.dataPoints)
				assert.deepEqual(Object.keys(point.attributes).sort(), [
					"app.storage.operation",
					"app.storage.outcome",
				]);
storage.close();
await shutdownObservability();
console.info(
	"Storage telemetry is bounded and contains no keys, buckets, URLs or credentials",
);
