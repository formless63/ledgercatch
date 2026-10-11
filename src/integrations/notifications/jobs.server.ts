import { z } from "zod";
import type { JobDefinition, JobHandlerContext } from "../jobs/types";
import type { Notification } from "./schema";
import { NotificationError } from "./validation";
export const notificationDeliveryPayload = z.strictObject({
	notificationId: z.uuid(),
	channel: z.enum(["email", "ntfy"]),
});
export type NotificationChannel = z.infer<
	typeof notificationDeliveryPayload
>["channel"];
const deliveryResult = z.object({
	outcome: z.enum(["delivered", "partial", "permanent", "ambiguous"]),
	category: z.enum(["rejected", "not-found", "disabled"]).optional(),
});
export interface DeliveryResult {
	outcome: "delivered" | "partial" | "permanent" | "ambiguous";
	category?: "rejected" | "not-found" | "disabled";
}
export type NotificationAdapter = (
	notification: Notification,
	context: { signal: AbortSignal },
) => Promise<DeliveryResult>;
export function createNotificationJobs(options: {
	load(id: string, signal: AbortSignal): Promise<Notification | null>;
	adapters: Partial<Record<NotificationChannel, NotificationAdapter>>;
}) {
	return {
		"notifications.deliver": {
			payload: notificationDeliveryPayload,
			queue: {
				retryLimit: 5,
				retryDelay: 30,
				retryBackoff: true,
				retryDelayMax: 900,
				expireInSeconds: 60,
				deleteAfterSeconds: 86400,
			},
			async handler(
				payload: z.output<typeof notificationDeliveryPayload>,
				context?: Pick<JobHandlerContext, "signal">,
			) {
				const controller = new AbortController();
				let invoked = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				let cancel: (() => void) | undefined;
				const terminal = (): DeliveryResult => ({
					outcome: invoked ? "ambiguous" : "permanent",
					category: "rejected",
				});
				if (context?.signal?.aborted) return terminal();
				try {
					const interrupted = new Promise<DeliveryResult>((resolve) => {
						cancel = () => {
							controller.abort();
							resolve(terminal());
						};
						context?.signal?.addEventListener("abort", cancel, { once: true });
						timer = setTimeout(cancel, 55000);
					});
					return await Promise.race([
						interrupted,
						(async (): Promise<DeliveryResult> => {
							const row = await options.load(
								payload.notificationId,
								controller.signal,
							);
							if (controller.signal.aborted) return terminal();
							if (!row) return { outcome: "permanent", category: "not-found" };
							const adapter = options.adapters[payload.channel];
							if (!adapter)
								return { outcome: "permanent", category: "disabled" };
							if (controller.signal.aborted) return terminal();
							invoked = true;
							const result = await adapter(row, { signal: controller.signal });
							// Application adapters are untrusted output: never persist extra fields.
							return deliveryResult.parse(result);
						})(),
					]);
				} catch (error) {
					if (error instanceof NotificationError && error.retryable)
						throw new NotificationError("unavailable", true);
					if (error instanceof NotificationError)
						return { outcome: "permanent", category: "rejected" };
					return terminal();
				} finally {
					clearTimeout(timer);
					if (cancel) context?.signal?.removeEventListener("abort", cancel);
					controller.abort();
				}
			},
		} satisfies JobDefinition<typeof notificationDeliveryPayload>,
	} as const;
}
