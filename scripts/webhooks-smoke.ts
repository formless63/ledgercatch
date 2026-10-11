import assert from "node:assert/strict";
import { z } from "zod";
import { jobRegistry } from "../src/integrations/jobs/registry";
import { startJobsWorker } from "../src/integrations/jobs/worker.server";
import {
	sendJob,
	stopJobsClient,
} from "../src/integrations/jobs/client.server";
import {
	createWebhookEvent,
	defineWebhookEvents,
} from "../src/integrations/webhooks/events";
import {
	deliverWebhook,
	WebhookDeliveryError,
} from "../src/integrations/webhooks/delivery.server";
import { enqueueWebhook } from "../src/integrations/webhooks/enqueue.server";
import { createWebhookJobs } from "../src/integrations/webhooks/jobs.server";
import {
	generateWebhookSecret,
	signWebhook,
} from "../src/integrations/webhooks/protocol.server";
import { webhookFixture } from "./webhooks-fixture";
import { webhooksUnit } from "./webhooks-unit";

await webhooksUnit();
const secret = generateWebhookSecret();
const previous = generateWebhookSecret();
const registry = defineWebhookEvents({
	"fixture.ping": z.strictObject({ message: z.string() }),
});
const receiver = await webhookFixture(registry, [secret, previous]);
const options = {
	registry,
	resolveTarget: () => ({
		url: receiver.url,
		signingSecret: secret,
		policy: { development: true },
	}),
	timeoutMs: 1000,
};
const prepared = createWebhookEvent(registry, "fixture.ping", {
	message: "private-webhook-body",
});
const delivery = {
	targetRef: "fixture-private-target",
	eventId: prepared.event.id,
	eventType: prepared.event.type,
	body: prepared.body,
};
const logs: string[] = [];
const originals = {
	info: console.info,
	error: console.error,
	warn: console.warn,
};
for (const key of ["info", "error", "warn"] as const)
	console[key] = (...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	};
let worker: Awaited<ReturnType<typeof startJobsWorker>> | undefined;
const jobIds: string[] = [];
const processingIds: string[] = [];
try {
	assert.equal((await deliverWebhook(delivery, options)).status, 204);
	assert.equal(receiver.attempts[0]?.body.toString(), prepared.body);
	assert.equal(receiver.attempts[0]?.id, prepared.event.id);
	assert.equal(receiver.attempts[0]?.method, "POST");
	assert.equal(receiver.attempts[0]?.contentType, "application/json");
	await assert.rejects(
		deliverWebhook(delivery, {
			...options,
			resolveTarget() {
				throw new WebhookDeliveryError("target", true);
			},
		}),
		(error) =>
			error instanceof WebhookDeliveryError &&
			error.retryable &&
			error.category === "target",
	);
	await assert.rejects(
		deliverWebhook(delivery, {
			...options,
			resolveTarget() {
				throw new Error(secret);
			},
		}),
		(error) =>
			error instanceof WebhookDeliveryError &&
			error.retryable &&
			!error.message.includes(secret),
	);
	// Real sender -> raw verification receiver, including unsuccessful authentication/schema/bounds.
	async function inbound(
		value: string,
		key = secret,
		timestamp = Math.floor(Date.now() / 1000),
		mutate = false,
	) {
		const signature = signWebhook(
			delivery.eventId,
			timestamp,
			Buffer.from(mutate ? value + " " : value),
			key,
		);
		return fetch(receiver.url, {
			method: "POST",
			body: value,
			headers: {
				"webhook-id": delivery.eventId,
				"webhook-timestamp": String(timestamp),
				"webhook-signature": signature,
			},
		});
	}
	assert.equal((await inbound(delivery.body, previous)).status, 204);
	for (const response of [
		await inbound(delivery.body, generateWebhookSecret()),
		await inbound(delivery.body, secret, Math.floor(Date.now() / 1000) - 600),
		await inbound(delivery.body, secret, Math.floor(Date.now() / 1000) + 600),
		await inbound(delivery.body, secret, undefined, true),
		await inbound("{malformed"),
		await inbound(JSON.stringify({ ...prepared.event, type: "unknown.event" })),
		await inbound(JSON.stringify({ ...prepared.event, data: { message: 42 } })),
		await inbound("x".repeat(65 * 1024)),
	]) {
		assert.equal(response.status, 401);
		await response.body?.cancel();
	}

	for (const [status, retryable, category] of [
		[400, false, "http"],
		[408, true, "http"],
		[425, true, "http"],
		[429, true, "http"],
		[500, true, "http"],
		[302, false, "redirect"],
	] as const) {
		receiver.configure({ status });
		await assert.rejects(
			deliverWebhook(delivery, options),
			(error) =>
				error instanceof WebhookDeliveryError &&
				error.status === status &&
				error.retryable === retryable &&
				error.category === category,
		);
		assert.equal(receiver.attempts.length, 1);
	}
	for (const timeoutMs of [99, 30_001])
		await assert.rejects(deliverWebhook(delivery, { ...options, timeoutMs }), /configuration/);
	receiver.configure({ delayMs: 300 });
	await assert.rejects(
		deliverWebhook(delivery, { ...options, timeoutMs: 100 }),
		(error) =>
			error instanceof WebhookDeliveryError &&
			error.category === "timeout" &&
			error.retryable,
	);
	await assert.rejects(
		deliverWebhook(delivery, {
			registry,
			resolveTarget: () => ({
				url: "http://127.0.0.1:1",
				signingSecret: secret,
				policy: { development: true },
			}),
		}),
		(error) =>
			error instanceof WebhookDeliveryError &&
			error.category === "network" &&
			error.retryable,
	);
	receiver.configure({ status: 200, responseBytes: 100_000 });
	assert.equal(
		(
			await deliverWebhook(delivery, {
				...options,

				onResult: () => {
					throw new Error("unsafe lifecycle failure");
				},
			})
		).outcome,
		"success",
	);
	// Reuse the existing worker and registry, no alternative queue/consumer implementation.
	Object.assign(
		jobRegistry["webhooks.deliver"],
		createWebhookJobs(options)["webhooks.deliver"],
	);
	worker = await startJobsWorker();
	receiver.configure({ status: 202 });
	receiver.setHandoff(async (event) => {
		const data = event.data as { message: string };
		processingIds.push(
			await sendJob("health.probe", { message: data.message }),
		);
	});
	assert.equal((await inbound(delivery.body)).status, 202);
	assert.equal(processingIds.length, 1);
	receiver.setHandoff(undefined);
	const processingDeadline = Date.now() + 10_000;
	let processed = false;
	while (Date.now() < processingDeadline) {
		const [job] = await worker.findJobs("health.probe", {
			id: processingIds[0],
		});
		if (job?.state === "completed") {
			processed = true;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	assert.ok(
		processed,
		"verified HTTP inbound handed off to the application Jobs processor",
	);

	async function enqueueAndWait(state: "completed" | "failed") {
		const prepared = createWebhookEvent(registry, "fixture.ping", {
			message: "private-webhook-body",
		});
		const payload = {
			...delivery,
			eventId: prepared.event.id,
			body: prepared.body,
		};
		const queued = await enqueueWebhook(payload);
		assert.ok(queued.jobId);
		jobIds.push(queued.jobId);
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const [job] =
				(await worker?.findJobs("webhooks.deliver", { id: queued.jobId })) ??
				[];
			if (job?.state === state) return job;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Webhook job did not settle in time");
	}
	// Explicit short fixture policy only; production defaults remain five bounded backoff retries.
	await worker.updateQueue("webhooks.deliver", {
		retryLimit: 2,
		retryDelay: 1,
		retryBackoff: true,
		retryDelayMax: 1,
	});
	receiver.configure({ failures: 2 });
	const success = await enqueueAndWait("completed");
	assert.equal(success.retryCount, 2);
	assert.equal(receiver.attempts.length, 3);
	assert.equal(
		new Set(receiver.attempts.map((a) => a.body.toString())).size,
		1,
	);
	assert.equal(new Set(receiver.attempts.map((a) => a.id)).size, 1);
	assert.ok(
		Number(receiver.attempts[2]?.timestamp) >
			Number(receiver.attempts[0]?.timestamp),
	);
	receiver.configure({ status: 500 });
	const failed = await enqueueAndWait("failed");
	assert.equal(failed.retryCount, 2);
	assert.equal(receiver.attempts.length, 3);
	receiver.configure({ status: 400 });
	const permanent = await enqueueAndWait("completed");
	assert.equal(permanent.retryCount, 0);
	assert.equal((permanent.output as { outcome: string }).outcome, "permanent");
	assert.equal(receiver.attempts.length, 1);
	const firstEnqueue = await enqueueWebhook(delivery), secondEnqueue = await enqueueWebhook(delivery);
 assert.ok(firstEnqueue.jobId); assert.ok(secondEnqueue.jobId); assert.notEqual(firstEnqueue.jobId, secondEnqueue.jobId);
 jobIds.push(firstEnqueue.jobId, secondEnqueue.jobId);
	assert.ok(!logs.join(" ").includes(secret));
	assert.ok(!logs.join(" ").includes(prepared.body));
	assert.ok(!logs.join(" ").includes("private-webhook-body"));
	assert.ok(!logs.join(" ").includes(receiver.url));
	for (const attempt of receiver.attempts)
		assert.ok(!logs.join(" ").includes(attempt.signature));
	originals.info(
		"Webhooks real HTTP + Jobs: signed bytes/headers, status classification, bounds, timeout/network, deliberate enqueues, success after 2 retries, final failure after 3 attempts, permanent failure once, stable body/ID and safe logs passed",
	);
} finally {
	if (worker) {
		for (const id of processingIds) await worker.deleteJob("health.probe", id);
		for (const id of jobIds) await worker.deleteJob("webhooks.deliver", id);
		await worker.updateQueue(
			"webhooks.deliver",
			jobRegistry["webhooks.deliver"].queue,
		);
		await worker.stop({ graceful: true, timeout: 10_000 });
	}
	await stopJobsClient();
	await receiver.close();
	Object.assign(console, originals);
}
