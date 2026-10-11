import { describe, expect, it } from "vitest";
import vectors from "../../../fixtures/notifications-contract.json";
import {
	createNotificationJobs,
	notificationDeliveryPayload,
} from "./jobs.server";
import {
	decodeNotificationCursor,
	encodeNotificationCursor,
	notificationValues,
	queryNotifications,
} from "./notifications.server";
import { ntfyConfig, publishNtfy } from "./ntfy.server";
import { validateNotificationMetadata } from "./validation";

const input = {
	recipientId: "user-a",
	type: "fixture.created",
	title: "Hello",
	body: "Plain text",
};
describe("notification canonical contracts", () => {
	it("shares strict create/list type, preserved plain-title and metadata-key vectors", async () => {
		const executor = {
			select: () => ({
				from: () => ({
					where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
				}),
			}),
		} as unknown as Parameters<typeof queryNotifications>[0];
		for (const type of vectors.types.accepted) {
			expect(notificationValues({ ...input, type }).type).toBe(type);
			await expect(
				queryNotifications(executor, input.recipientId, { type }),
			).resolves.toMatchObject({ notifications: [] });
		}
		await expect(
			queryNotifications(executor, input.recipientId, { type: undefined }),
		).resolves.toMatchObject({ notifications: [] });
		for (const type of vectors.types.rejected) {
			expect(() => notificationValues({ ...input, type })).toThrow();
			await expect(
				queryNotifications(executor, input.recipientId, { type }),
			).rejects.toMatchObject({ code: "invalid-input" });
		}
		for (const title of vectors.titles.accepted)
			expect(notificationValues({ ...input, title }).title).toBe(title);
		for (const title of vectors.titles.rejected)
			expect(() => notificationValues({ ...input, title })).toThrow();
		for (const key of vectors.metadataKeys.accepted)
			expect(validateNotificationMetadata({ [key]: 1 })).toEqual({ [key]: 1 });
		for (const key of vectors.metadataKeys.rejected)
			expect(() => validateNotificationMetadata({ [key]: 1 })).toThrow();
	});

	it("preserves plain text and the exact metadata 8KiB/1024-node ceilings", () => {
		expect(
			notificationValues({ ...input, title: "  plain text  " }).title,
		).toBe("  plain text  ");
		expect(() => notificationValues({ ...input, title: "" })).toThrow();
		expect(() => validateNotificationMetadata({ "": 1 })).toThrow();
		const exact = Object.fromEntries(
			Array.from({ length: 8 }, (_, i) => [
				`k${i}`,
				"x".repeat(i === 7 ? 959 : 1024),
			]),
		);
		expect(Buffer.byteLength(JSON.stringify(exact))).toBe(8192);
		expect(validateNotificationMetadata(exact)).toEqual(exact);
		expect(() =>
			validateNotificationMetadata({ ...exact, k7: `${exact.k7}x` }),
		).toThrow();
		const nodes = {
			values: Array.from({ length: 11 }, (_, i) =>
				Array.from({ length: i === 10 ? 11 : 100 }, () => 0),
			),
		};
		expect(validateNotificationMetadata(nodes)).toEqual(nodes);
		nodes.values[10].push(0);
		expect(() => validateNotificationMetadata(nodes)).toThrow();
	});
	it("owns IDs/timestamps/read state, plain text and UTF8 limits", () => {
		const row = notificationValues(input);
		expect(row.readAt).toBeNull();
		expect(row.metadata).toEqual({});
		expect(row.id).toMatch(/^[a-f0-9-]{36}$/);
		for (const extra of [
			{ id: row.id },
			{ createdAt: new Date() },
			{ readAt: new Date() },
		])
			expect(() => notificationValues({ ...input, ...extra })).toThrow();
		expect(() =>
			notificationValues({
				...input,
				title: "x".repeat(200),
				body: "🦀".repeat(1024),
			}),
		).not.toThrow();
		for (const extra of [
			{ title: "x".repeat(201) },
			{ title: "x\n" },
			{ body: "🦀".repeat(1025) },
			{ body: "<b>html</b>" },
			{ recipientId: "x".repeat(129) },
			{ type: "Upper" },
			{ type: "single" },
			{ type: "fixture..created" },
		])
			expect(() => notificationValues({ ...input, ...extra })).toThrow();
	});
	it("rejects unsafe metadata, hidden properties/getters and exact structural bounds", () => {
		for (const key of [
			"Pass_word",
			"passwd",
			"pwd",
			"secret",
			"accessToken",
			"authorization",
			"cookie",
			"api-key",
			"credential",
			"__proto__",
			"constructor",
			"request",
			"session",
			"body",
			"headers",
		])
			expect(() => validateNotificationMetadata({ [key]: "value" })).toThrow();
		const getter = Object.defineProperty({}, "safe", {
			get() {
				throw new Error("not evaluated");
			},
			enumerable: true,
		});
		const hidden = Object.defineProperty({}, "safe", { value: 1 });
		const cycle: Record<string, unknown> = {};
		cycle.value = cycle;
		for (const value of [
			getter,
			hidden,
			cycle,
			{ value: new Date() },
			{ value: new Error() },
			{ value: BigInt(1) },
			{ value: undefined },
			{ value: new (class Value {})() },
			{ value: new Array(2) },
			{ value: Symbol() },
			{ value: "x\u0000" },
			{ value: "\uD800" },
		])
			expect(() => validateNotificationMetadata(value)).toThrow();
		expect(
			validateNotificationMetadata({
				value: Array.from({ length: 100 }, () => "safe"),
			}).value,
		).toHaveLength(100);
		for (const value of [
			{ value: Array.from({ length: 101 }, () => 1) },
			Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`key${i}`, 1])),
			{ ["x".repeat(65)]: 1 },
			{ value: "x".repeat(1025) },
			{ a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
			{ values: Array.from({ length: 9 }, () => "x".repeat(1024)) },
		])
			expect(() => validateNotificationMetadata(value)).toThrow();
	});
	it("uses canonical versioned keyset cursor", () => {
		const row = notificationValues(input),
			cursor = encodeNotificationCursor(row);
		expect(decodeNotificationCursor(cursor)).toEqual({
			id: row.id,
			createdAt: row.createdAt,
		});
		for (const value of [
			`${cursor}=`,
			"e30",
			Buffer.from(
				JSON.stringify([2, row.createdAt.toISOString(), row.id]),
			).toString("base64url"),
		])
			expect(() => decodeNotificationCursor(value)).toThrow();
	});
	it("keeps Jobs payload private and distinguishes business permanent outcome from retry failure", async () => {
		const row = notificationValues(input);
		const jobs = createNotificationJobs({
			load: async () => row,
			adapters: {},
		});
		const job = jobs["notifications.deliver"];
		expect(job.queue).toEqual({
			retryLimit: 5,
			retryDelay: 30,
			retryBackoff: true,
			retryDelayMax: 900,
			expireInSeconds: 60,
			deleteAfterSeconds: 86400,
		});
		expect(() =>
			notificationDeliveryPayload.parse({
				notificationId: row.id,
				channel: "email",
				email: "private",
			}),
		).toThrow();
		expect(
			await job.handler({ notificationId: row.id, channel: "email" }),
		).toEqual({ outcome: "permanent", category: "disabled" });
		const failing = createNotificationJobs({
			load: async () => row,
			adapters: {
				email: async () => {
					throw new Error("private backend error");
				},
			},
		});
		await expect(
			failing["notifications.deliver"].handler({
				notificationId: row.id,
				channel: "email",
			}),
		).resolves.toEqual({ outcome: "ambiguous", category: "rejected" });
	});
	it("ntfy defaults are lazy/private, redirects permanent, retry statuses bounded and response body never read", async () => {
		expect(() => ntfyConfig({})).toThrow();
		const config = ntfyConfig({ NTFY_BASE_URL: "https://ntfy.example.test" });
		expect(config.timeoutSeconds).toBe(10);
		for (const environment of [
			{ NTFY_BASE_URL: "http://ntfy.sh" },
			{ NTFY_BASE_URL: "http://127.0.0.1", NODE_ENV: "production" },
			{ NTFY_BASE_URL: "http://localhost" },
			{ NTFY_BASE_URL: "https://user:password@ntfy.example" },
			{ NTFY_BASE_URL: "https://ntfy.example", NTFY_TIMEOUT_SECONDS: "31" },
		])
			expect(() => ntfyConfig(environment)).toThrow();
		const row = notificationValues(input);
		let cancelled = false;
		for (const status of [204, 302, 400, 401, 404, 408, 425, 429, 500, 503]) {
			const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
				expect(init?.redirect).toBe("manual");
				expect(JSON.parse(String(init?.body))).toEqual({
					topic: "fixture",
					title: row.title,
					message: row.body,
				});
				return {
					status,
					body: {
						cancel: async () => {
							cancelled = true;
						},
						getReader() {
							throw new Error("must not read");
						},
					},
				};
			}) as unknown as typeof fetch;
			const result = publishNtfy(row, "fixture", { config, fetch: fetcher });
			if ([408, 425, 429].includes(status) || status >= 500)
				await expect(result).rejects.toMatchObject({ retryable: true });
			else
				expect((await result).outcome).toBe(
					status === 204 ? "delivered" : "permanent",
				);
		}
		expect(cancelled).toBe(true);
	});
});
