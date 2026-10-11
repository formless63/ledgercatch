import type { db } from "../../db";
import { sendJobInTransaction } from "../jobs/client.server";
import {
	type NotificationChannel,
	notificationDeliveryPayload,
} from "./jobs.server";
import {
	createNotification,
	type NotificationInput,
} from "./notifications.server";

import { NotificationError } from "./validation";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Caller owns the transaction/commit. This helper deliberately emits no realtime hint. */
export async function createNotificationInTransaction(
	tx: Transaction,
	input: NotificationInput,
	channels: readonly NotificationChannel[] = [],
) {
	if (
		!Array.isArray(channels) ||
		new Set(channels).size !== channels.length ||
		channels.some((c) => c !== "email" && c !== "ntfy")
	)
		throw new NotificationError("invalid-input");
	const notification = await createNotification(tx, input);
	const jobIds: string[] = [];
	for (const channel of channels)
		jobIds.push(
			await sendJobInTransaction(
				tx,
				"notifications.deliver",
				notificationDeliveryPayload.parse({
					notificationId: notification.id,
					channel,
				}),
			),
		);
	return { notification, jobIds };
}
