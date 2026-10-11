import { expect, it, vi } from "vitest";
import vectors from "../../../fixtures/notifications-contract.json";
import { notificationEmailAdapter } from "../../lib/notification-email.server";
import type { EmailErrorCode } from "../email/errors.server";
import { EmailError } from "../email/errors.server";
import {
	createNotificationJobs,
	type NotificationAdapter,
} from "./jobs.server";
import { notificationValues } from "./notifications.server";
import { NotificationError } from "./validation";

const row = notificationValues({
	recipientId: "fixture",
	type: "fixture.created",
	title: "Title",
	body: "private",
});
const payload = { notificationId: row.id, channel: "email" as const };
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
it("composes preabort and deferred record/recipient cancellation without late dispatch", async () => {
	for (const phase of ["record", "recipient"] as const) {
		const pending = deferred<typeof row | string | null>();
		const sendEmail = vi.fn().mockResolvedValue({ outcome: "accepted" });
		const load = vi.fn(async () =>
			phase === "record" ? ((await pending.promise) as typeof row) : row,
		);
		const resolveEmail = vi.fn(async () => (await pending.promise) as string);
		const adapter = notificationEmailAdapter({
			resolveEmail,
			email: () => ({ sendEmail }),
		});
		const handler = createNotificationJobs({
			load,
			adapters: { email: adapter },
		})["notifications.deliver"].handler;
		const before = new AbortController();
		before.abort();
		await handler(payload, { signal: before.signal });
		expect(load).not.toHaveBeenCalled();
		expect(resolveEmail).not.toHaveBeenCalled();
		const during = new AbortController();
		const result = handler(payload, { signal: during.signal });
		await Promise.resolve();
		during.abort();
		expect((await result).category).toBe("rejected");
		pending.resolve(phase === "record" ? row : "private@example.test");
		await Promise.resolve();
		await Promise.resolve();
		expect(sendEmail).not.toHaveBeenCalled();
	}
});
it("bounds never-resolving lookup and late successful delivery without retry", async () => {
	vi.useFakeTimers();
	try {
		for (const phase of ["lookup", "adapter"] as const) {
			const pending = deferred<typeof row>();
			const adapter = vi.fn(async () => {
				await pending.promise;
				return { outcome: "delivered" as const };
			});
			const handler = createNotificationJobs({
				load: async () => (phase === "lookup" ? pending.promise : row),
				adapters: { email: adapter },
			})["notifications.deliver"].handler;
			const result = handler(payload);
			await Promise.resolve();
			await Promise.resolve();
			vi.advanceTimersByTime(55000);
			expect(await result).toEqual({
				outcome: phase === "lookup" ? "permanent" : "ambiguous",
				category: "rejected",
			});
			pending.resolve(row);
			await Promise.resolve();
			await Promise.resolve();
			vi.advanceTimersByTime(1);
			expect(adapter).toHaveBeenCalledTimes(phase === "lookup" ? 0 : 1);
		}
	} finally {
		vi.useRealTimers();
	}
});
it("retries only explicit safe failure and persists finite allowlisted output", async () => {
	const run = (email: NotificationAdapter) =>
		createNotificationJobs({ load: async () => row, adapters: { email } })[
			"notifications.deliver"
		].handler(payload);
	await expect(
		run(async () => {
			throw new Error("accepted then lost response/private");
		}),
	).resolves.toEqual({ outcome: "ambiguous", category: "rejected" });
	await expect(
		run(async () => {
			throw new NotificationError("unavailable", true);
		}),
	).rejects.toMatchObject({
		retryable: true,
		message: "Notifications unavailable",
	});
	await expect(
		run(async () => ({
			outcome: "delivered",
			recipient: "private",
			body: "private",
			topic: "private",
			providerResponse: "private",
		})),
	).resolves.toEqual({ outcome: "delivered" });
	for (const failure of [
		new EmailError("timeout", false),
		new EmailError("connection", false),
		new EmailError("unknown", false),
		new EmailError("timeout", true),
		new Error("private"),
	]) {
		await expect(
			run(
				notificationEmailAdapter({
					resolveEmail: async () => "private@example.test",
					email: () => ({
						sendEmail: async () => {
							throw failure;
						},
					}),
				}),
			),
		).resolves.toEqual({ outcome: "ambiguous" });
	}
	await expect(
		run(
			notificationEmailAdapter({
				resolveEmail: async () => "private@example.test",
				email: () => ({
					sendEmail: async () => {
						throw new EmailError("temporary-rejection", true);
					},
				}),
			}),
		),
	).rejects.toMatchObject({ retryable: true });
});

it("keeps known recipient-loading failures separate from invoked SMTP failures", async () => {
	const run = (failure: unknown) =>
		createNotificationJobs({
			load: async () => row,
			adapters: {
				email: notificationEmailAdapter({
					resolveEmail: async () => {
						throw failure;
					},
					email: () => {
						throw new Error("must not send");
					},
				}),
			},
		})["notifications.deliver"].handler(payload);
	await expect(run(new Error("private lookup failure"))).resolves.toEqual({
		outcome: "permanent",
		category: "rejected",
	});
	await expect(
		run(new NotificationError("unavailable", true)),
	).rejects.toMatchObject({ retryable: true });
});

it("handles a late adapter rejection after cancellation without redispatch", async () => {
	let reject!: (error: Error) => void;
	const pending = new Promise<never>((_, fail) => {
		reject = fail;
	});
	const adapter = vi.fn(() => pending);
	const controller = new AbortController();
	const result = createNotificationJobs({
		load: async () => row,
		adapters: { email: adapter },
	})["notifications.deliver"].handler(payload, { signal: controller.signal });
	await Promise.resolve();
	await Promise.resolve();
	controller.abort();
	await expect(result).resolves.toEqual({
		outcome: "ambiguous",
		category: "rejected",
	});
	reject(new Error("private late response"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(adapter).toHaveBeenCalledTimes(1);
});

it("composes shared typed Email retry vectors without retrying ambiguous acceptance", async () => {
	for (const vector of vectors.emailErrors) {
		const sendEmail = vi.fn(async () => {
			throw new EmailError(vector.code as EmailErrorCode, vector.retryable);
		});
		const adapter = notificationEmailAdapter({
			resolveEmail: async () => "fixture@example.test",
			email: () => ({ sendEmail }),
		});
		const result = createNotificationJobs({
			load: async () => row,
			adapters: { email: adapter },
		})["notifications.deliver"].handler(payload);
		if (vector.settlement === "retry")
			await expect(result).rejects.toMatchObject({ retryable: true });
		else
			await expect(result).resolves.toEqual(
				vector.settlement === "ambiguous"
					? { outcome: "ambiguous" }
					: { outcome: "permanent", category: "rejected" },
			);
		expect(sendEmail).toHaveBeenCalledTimes(1);
	}
});
