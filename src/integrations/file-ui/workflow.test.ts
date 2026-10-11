import { describe, expect, test } from "vitest";
import { createMemoryFileMetadata } from "./memory.server";
import { createFileWorkflow, type FileStorage } from "./workflow.server";

function fixture(metadata = createMemoryFileMetadata()) {
	const objects = new Map<
		string,
		{ bytes: Uint8Array; type: string; hash: string }
	>();
	let puts = 0;
	let failDelete = false;
	const storage = {
		createKey: () => `file-ui/${crypto.randomUUID()}`,
		async putObject(
			key: string,
			bytes: unknown,
			options?: { contentType?: string; metadata?: Record<string, string> },
		) {
			puts++;
			objects.set(key, {
				bytes: bytes as Uint8Array,
				type: options?.contentType ?? "",
				hash: options?.metadata?.sha256 ?? "",
			});
			return { etag: undefined };
		},
		async headObject(key: string) {
			const r = objects.get(key);
			if (!r) throw Error();
			return {
				contentLength: r.bytes.length,
				contentType: r.type,
				metadata: { sha256: r.hash },
			};
		},
		async getObject(key: string) {
			const r = objects.get(key);
			if (!r) throw Error();
			return {
				body: {
					transformToWebStream: () =>
						new Response(new Uint8Array(r.bytes)).body!,
				},
			};
		},
		async deleteObject(key: string) {
			if (failDelete) throw Error();
			objects.delete(key);
		},
	} as unknown as FileStorage;
	const workflow = createFileWorkflow({
		metadata,
		storage: () => storage,
		authorize: async () => true,
		maxBytes: 100,
	});
	return {
		workflow,
		metadata,
		storage,
		objects,
		puts: () => puts,
		failDelete: (value: boolean) => {
			failDelete = value;
		},
	};
}
const ctx = { owner: "alice" };
const input = (text = "hello", token = "token-for-fixture-0001") => ({
	name: "hello.txt",
	type: "text/plain",
	token,
	body: new Response(text).body,
});
describe("File UI atomic lifecycle", () => {
	test("identical replay after lost response, conflict and owner isolation", async () => {
		const f = fixture();
		const one = await f.workflow.upload(ctx, input());
		expect(one.state).toBe("ready");
		expect(await f.workflow.upload(ctx, input())).toEqual(one);
		expect(f.puts()).toBe(1);
		await expect(
			f.workflow.upload(ctx, input("different")),
		).rejects.toMatchObject({ code: "conflict" });
		expect(await f.workflow.list({ owner: "bob" })).toEqual([]);
		await expect(
			f.workflow.remove({ owner: "bob" }, one.id),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			f.workflow.download({ owner: "bob" }, one.id),
		).rejects.toMatchObject({ code: "not_found" });
		const download = await f.workflow.download(ctx, one.id);
		expect(download.headers["Content-Disposition"]).toContain("attachment");
		expect(download.headers["X-Content-Type-Options"]).toBe("nosniff");
	});
	test("size, hash and metadata are verified before any reservation/PUT", async () => {
		const f = fixture();
		await expect(
			f.workflow.upload(ctx, input("x".repeat(101))),
		).rejects.toMatchObject({ code: "too_large" });
		await expect(
			f.workflow.upload(ctx, { ...input(), expectedSize: 100 }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			f.workflow.upload(ctx, { ...input(), expectedDigest: "bad" }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			f.workflow.upload(ctx, { ...input(), name: "../unsafe" }),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(f.puts()).toBe(0);
		expect(await f.workflow.list(ctx)).toEqual([]);
	});
	test("ambiguous metadata publication rereads ready before deleting", async () => {
		const base = createMemoryFileMetadata();
		let once = true;
		const f = fixture({
			...base,
			async cas(...args) {
				const result = await base.cas(...args);
				if (once) {
					once = false;
					throw Error("lost commit reply");
				}
				return result;
			},
		});
		expect((await f.workflow.upload(ctx, input())).state).toBe("ready");
		expect(f.objects.size).toBe(1);
	});
	test("metadata outage after PUT retains object and never claims readiness", async () => {
		const base = createMemoryFileMetadata();
		const f = fixture({
			...base,
			async cas() {
				throw Error();
			},
			async get() {
				throw Error();
			},
		});
		await expect(f.workflow.upload(ctx, input())).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(f.objects.size).toBe(1);
	});
	test("uncertain reservation never starts a PUT", async () => {
		const base = createMemoryFileMetadata();
		const f = fixture({
			...base,
			async reserve(record) {
				await base.reserve(record);
				throw Error();
			},
		});
		expect((await f.workflow.upload(ctx, input())).state).toBe("uploading");
		expect(f.puts()).toBe(0);
	});
	test("upload replay never launches another PUT, cancellation quarantines late writers", async () => {
		const f = fixture();
		let entered!: () => void;
		const reached = new Promise<void>((r) => {
			entered = r;
		});
		let release!: () => void;
		const blocked = new Promise<void>((r) => {
			release = r;
		});
		const original = f.storage.putObject;
		f.storage.putObject = async (...args) => {
			entered();
			await blocked;
			await original(...args);
			throw Error("ambiguous put");
		};
		const controller = new AbortController();
		const pending = f.workflow.upload(
			{ ...ctx, signal: controller.signal },
			input(),
		);
		await reached;
		const replay = await f.workflow.upload(ctx, input());
		expect(replay.state).toBe("uploading");
		controller.abort();
		expect((await f.workflow.remove(ctx, replay.id)).state).toBe(
			"cleanup-pending",
		);
		release();
		expect((await pending).state).toBe("cleanup-pending");
		expect(f.puts()).toBe(1);
		expect(f.objects.size).toBe(1);
		expect(
			(await f.workflow.reconcile(ctx, replay.id, { writersStopped: false }))
				.state,
		).toBe("cleanup-pending");
		expect(f.objects.size).toBe(1);
		expect(
			(await f.workflow.reconcile(ctx, replay.id, { writersStopped: true }))
				.state,
		).toBe("removed");
		expect(f.objects.size).toBe(0);
	});
	test("failed cleanup can retry after workflow restart and receipts remain terminal", async () => {
		const f = fixture();
		const row = await f.workflow.upload(ctx, input());
		f.failDelete(true);
		expect((await f.workflow.remove(ctx, row.id)).state).toBe(
			"cleanup-pending",
		);
		const restarted = createFileWorkflow({
			metadata: f.metadata,
			storage: () => f.storage,
			authorize: async () => true,
		});
		f.failDelete(false);
		expect((await restarted.remove(ctx, row.id)).state).toBe("removed");
		expect((await restarted.upload(ctx, input())).state).toBe("removed");
		expect(f.puts()).toBe(1);
	});
	test("readback corruption fails closed", async () => {
		const f = fixture();
		f.storage.getObject = async () =>
			({
				body: { transformToWebStream: () => new Response("corrupt").body! },
			}) as Awaited<ReturnType<FileStorage["getObject"]>>;
		expect((await f.workflow.upload(ctx, input())).state).toBe("removed");
		expect(f.objects.size).toBe(0);
	});
	test("successful PUT cancellation during HEAD cleans with an independent transport", async () => {
		const f = fixture();
		const controller = new AbortController();
		f.storage.headObject = async () => {
			controller.abort();
			throw Error("cancelled HEAD");
		};
		let deleted = false;
		const remove = f.storage.deleteObject;
		f.storage.deleteObject = async (...args) => {
			expect(controller.signal.aborted).toBe(true);
			expect(args).toHaveLength(1);
			deleted = true;
			await remove(...args);
		};
		expect(
			(await f.workflow.upload({ ...ctx, signal: controller.signal }, input()))
				.state,
		).toBe("removed");
		expect(deleted).toBe(true);
		expect(f.objects.size).toBe(0);
	});
	test("a successful in-flight writer racing removal completes cleanup instead of publishing ready", async () => {
		const f = fixture();
		let enter!: () => void;
		const reached = new Promise<void>((r) => {
			enter = r;
		});
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const put = f.storage.putObject;
		f.storage.putObject = async (...args) => {
			enter();
			await gate;
			return put(...args);
		};
		const pending = f.workflow.upload(ctx, input());
		await reached;
		const [row] = await f.workflow.list(ctx);
		expect((await f.workflow.remove(ctx, row.id)).state).toBe(
			"cleanup-pending",
		);
		release();
		expect((await pending).state).toBe("removed");
		expect(f.objects.size).toBe(0);
	});
	test("bounded adapter fails closed rather than evicting idempotency receipts", async () => {
		const f = fixture(createMemoryFileMetadata(1));
		await f.workflow.upload(ctx, input());
		await expect(
			f.workflow.upload(ctx, input("hello", "token-for-fixture-0002")),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(f.puts()).toBe(1);
	});
});
