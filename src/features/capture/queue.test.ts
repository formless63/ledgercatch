import { describe, expect, it } from "vitest";
import {
	applyOutcome,
	backoffMs,
	type CaptureMeta,
	createCaptureQueue,
	isDue,
	memoryStore,
	pruneUploaded,
	type QueueItem,
	type QueueStore,
	type UploadOutcome,
} from "./queue";
import { buildForm, classifyResponse } from "./upload";

const meta: CaptureMeta = {
	kind: "receipt",
	source: "generic",
	merchantHint: "Hardware",
	entityId: null,
	note: "",
};
const file = (name = "a.jpg") => ({
	blob: new Blob(["x".repeat(10)], { type: "image/jpeg" }),
	fileName: name,
	contentType: "image/jpeg",
	originalSize: 100,
	thumbnail: null,
});

function setup(outcomes: UploadOutcome[], store: QueueStore = memoryStore()) {
	let clock = 1_000_000;
	let online = true;
	let ids = 0;
	const calls: string[] = [];
	const queue = createCaptureQueue({
		store,
		now: () => clock,
		isOnline: () => online,
		newId: () => `id-${++ids}`,
		upload: async (item, progress) => {
			calls.push(item.fileName);
			progress(0.5);
			const next = outcomes.shift();
			if (!next) throw new Error("no outcome scripted");
			return next;
		},
	});
	return {
		queue,
		store,
		calls,
		tick: (ms: number) => {
			clock += ms;
		},
		setOnline: (v: boolean) => {
			online = v;
		},
	};
}

const ok = (n: number): UploadOutcome => ({
	type: "ok",
	captureId: `cap-${n}`,
	documentId: `doc-${n}`,
	duplicate: false,
});

describe("pure helpers", () => {
	it("backs off exponentially with a cap", () => {
		expect(backoffMs(1)).toBe(5_000);
		expect(backoffMs(2)).toBe(10_000);
		expect(backoffMs(4)).toBe(40_000);
		expect(backoffMs(50)).toBe(300_000);
	});

	it("applies outcomes", () => {
		const base = {
			status: "uploading",
			attempts: 0,
			blob: new Blob(["a"]),
		} as QueueItem;
		const done = applyOutcome(base, ok(1), 5);
		expect(done).toMatchObject({
			status: "uploaded",
			blob: null,
			captureId: "cap-1",
			uploadedAt: 5,
		});
		const failed = applyOutcome(base, { type: "retry", error: "net" }, 100);
		expect(failed).toMatchObject({
			status: "failed",
			attempts: 1,
			nextAttemptAt: 5_100,
		});
		expect(isDue(failed, 5_099)).toBe(false);
		expect(isDue(failed, 5_100)).toBe(true);
		expect(isDue(failed, 0, true)).toBe(true);
		const rejected = applyOutcome(base, { type: "rejected", error: "HEIC" }, 1);
		expect(rejected.status).toBe("rejected");
		expect(isDue(rejected, 1e12, true)).toBe(false);
	});

	it("prunes old and excess uploaded items", () => {
		const items = Array.from({ length: 5 }, (_, i) => ({
			id: `u${i}`,
			status: "uploaded",
			createdAt: i,
			uploadedAt: 1000 + i,
		})) as QueueItem[];
		expect(pruneUploaded(items, 1004, 10_000, 3).sort()).toEqual(["u0", "u1"]);
		expect(pruneUploaded(items, 1012, 10, 50)).toEqual(["u1", "u0"]);
	});

	it("classifies upload responses", () => {
		expect(classifyResponse(0, null).type).toBe("retry");
		expect(classifyResponse(401, { error: "Unauthorized" })).toMatchObject({
			type: "retry",
			auth: true,
		});
		expect(classifyResponse(503, null).type).toBe("retry");
		expect(classifyResponse(413, { error: "Upload too large" }).type).toBe(
			"rejected",
		);
		expect(
			classifyResponse(400, { results: [{ ok: false, error: "Only PDF" }] }),
		).toEqual({ type: "rejected", error: "Only PDF" });
		expect(
			classifyResponse(201, {
				results: [
					{ ok: true, captureId: "c", documentId: "d", created: false },
				],
			}),
		).toEqual({ type: "ok", captureId: "c", documentId: "d", duplicate: true });
	});

	it("builds multipart fields", () => {
		const form = buildForm(new Blob(["a"]), "r.jpg", {
			...meta,
			note: "lunch",
		});
		expect(form.get("kind")).toBe("receipt");
		expect(form.get("source")).toBe("generic");
		expect(form.get("merchantHint")).toBe("Hardware");
		expect(form.get("note")).toBe("lunch");
		expect(form.get("entityId")).toBeNull();
		expect((form.get("file") as File).name).toBe("r.jpg");
	});
});

describe("capture queue", () => {
	it("uploads queued items oldest first and drops their bytes", async () => {
		const t = setup([ok(1), ok(2)]);
		await t.queue.load();
		await t.queue.enqueue([file("first.jpg"), file("second.jpg")], meta);
		const summary = await t.queue.flush();
		expect(summary.uploaded).toBe(2);
		expect(t.calls).toEqual(["first.jpg", "second.jpg"]);
		const stored = await t.store.list();
		expect(
			stored.every((i) => i.status === "uploaded" && i.blob === null),
		).toBe(true);
		expect(t.queue.getSnapshot().progress).toEqual({});
	});

	it("keeps items while offline and uploads when back online", async () => {
		const t = setup([ok(1)]);
		await t.queue.load();
		t.setOnline(false);
		await t.queue.enqueue([file()], meta);
		expect((await t.queue.flush()).skipped).toBe("offline");
		expect(t.calls).toEqual([]);
		expect((await t.store.list())[0]?.status).toBe("pending");
		t.setOnline(true);
		expect((await t.queue.flush()).uploaded).toBe(1);
	});

	it("survives a reload: items persisted mid-upload are retried", async () => {
		const store = memoryStore();
		const first = setup([], store);
		await first.queue.load();
		await first.queue.enqueue([file("crash.jpg")], meta);
		const [item] = await store.list();
		if (!item) throw new Error("missing");
		await store.put({ ...item, status: "uploading" });
		const second = setup([ok(9)], store);
		await second.queue.load();
		expect(second.queue.getSnapshot().items[0]?.status).toBe("pending");
		await second.queue.flush();
		expect(second.calls).toEqual(["crash.jpg"]);
		expect((await store.list())[0]?.captureId).toBe("cap-9");
	});

	it("stops on a transient failure and honours backoff", async () => {
		const t = setup([{ type: "retry", error: "HTTP 502" }, ok(1), ok(2)]);
		await t.queue.load();
		await t.queue.enqueue([file("a.jpg"), file("b.jpg")], meta);
		const summary = await t.queue.flush();
		expect(summary).toMatchObject({ uploaded: 0, failed: 1 });
		expect(t.calls).toEqual(["a.jpg"]);
		// b is still due, a is backing off.
		await t.queue.flush();
		expect(t.calls).toEqual(["a.jpg", "b.jpg"]);
		t.tick(5_000);
		await t.queue.flush();
		expect(t.calls).toEqual(["a.jpg", "b.jpg", "a.jpg"]);
		expect(
			t.queue.getSnapshot().items.every((i) => i.status === "uploaded"),
		).toBe(true);
	});

	it("pauses after 401 until an explicit retry", async () => {
		const t = setup([
			{ type: "retry", error: "Signed out", auth: true },
			ok(1),
		]);
		await t.queue.load();
		const [id] = await t.queue.enqueue([file()], meta);
		await t.queue.flush();
		expect(t.queue.getSnapshot().authRequired).toBe(true);
		t.tick(60_000);
		expect((await t.queue.flush()).skipped).toBe("auth");
		await t.queue.retry(id as string);
		expect(t.queue.getSnapshot()).toMatchObject({ authRequired: false });
		expect(t.queue.getSnapshot().items[0]?.status).toBe("uploaded");
	});

	it("does not auto-retry server rejections but allows manual retry", async () => {
		const t = setup([{ type: "rejected", error: "Only PDF" }, ok(1)]);
		await t.queue.load();
		const [id] = await t.queue.enqueue([file()], meta);
		await t.queue.flush();
		await t.queue.flush(true);
		expect(t.calls.length).toBe(1);
		await t.queue.retry(id as string);
		expect(t.calls.length).toBe(2);
	});

	it("shares one run for concurrent flushes", async () => {
		const t = setup([ok(1)]);
		await t.queue.load();
		await t.queue.enqueue([file()], meta);
		const [a, b] = await Promise.all([t.queue.flush(), t.queue.flush()]);
		expect(a).toBe(b);
		expect(t.calls.length).toBe(1);
	});

	it("treats thrown uploads as transient and falls back when storage fails", async () => {
		const broken: QueueStore = {
			list: async () => [],
			put: async () => {
				throw new Error("QuotaExceededError");
			},
			remove: async () => {},
		};
		const t = setup([], broken);
		await t.queue.load();
		await t.queue.enqueue([file()], meta);
		expect(t.queue.getSnapshot().persistent).toBe(false);
		const summary = await t.queue.flush();
		expect(summary.failed).toBe(1);
		expect(t.queue.getSnapshot().items[0]?.status).toBe("failed");
	});

	it("records share-target captures once and clears finished items", async () => {
		const t = setup([]);
		await t.queue.load();
		await t.queue.recordUploaded(
			[{ captureId: "c1" }, { captureId: "c2" }],
			meta,
		);
		await t.queue.recordUploaded([{ captureId: "c1" }], meta);
		expect(t.queue.getSnapshot().items.length).toBe(2);
		await t.queue.clearUploaded();
		expect(await t.store.list()).toEqual([]);
	});

	it("notifies subscribers", async () => {
		const t = setup([]);
		let n = 0;
		const off = t.queue.subscribe(() => {
			n += 1;
		});
		await t.queue.load();
		off();
		await t.queue.enqueue([file()], meta);
		expect(n).toBe(1);
	});
});
