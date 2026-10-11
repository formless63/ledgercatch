import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { user } from "../db/schema";
import { notificationPreferences } from "../features/automation/schema";
import {
	createNotificationJobs,
	type NotificationAdapter,
	type NotificationChannel,
} from "../integrations/notifications/jobs.server";
import type { NotificationInput } from "../integrations/notifications/notifications.server";
import { publishNtfy } from "../integrations/notifications/ntfy.server";
import { notifications } from "../integrations/notifications/schema";
import { getApplicationEmail } from "./email.server";
import { notificationEmailAdapter } from "./notification-email.server";

async function preferencesFor(recipientId: string) {
	const [row] = await db
		.select({
			channels: notificationPreferences.channels,
			ntfyTopic: notificationPreferences.ntfyTopic,
		})
		.from(notificationPreferences)
		.where(eq(notificationPreferences.ownerId, recipientId))
		.limit(1);
	return row ?? null;
}

const email = notificationEmailAdapter({
	async resolveEmail(recipientId) {
		// Current preference is re-checked at delivery time, never frozen in the job.
		const prefs = await preferencesFor(recipientId);
		if (!prefs?.channels.email) return null;
		const [recipient] = await db
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, recipientId))
			.limit(1);
		return recipient?.email ?? null;
	},
	email: getApplicationEmail,
});

// Topic comes from the recipient's current preferences. Never queued.
const ntfy: NotificationAdapter = async (notification, { signal }) => {
	const prefs = await preferencesFor(notification.recipientId);
	if (!prefs?.channels.ntfy || !prefs.ntfyTopic)
		return { outcome: "permanent", category: "disabled" };
	return publishNtfy(notification, prefs.ntfyTopic, { signal });
};

export const applicationNotificationJobs = createNotificationJobs({
	async load(id) {
		const [row] = await db
			.select()
			.from(notifications)
			.where(eq(notifications.id, id))
			.limit(1);
		return row ?? null;
	},
	adapters: { email, ntfy },
});

/**
 * Persist one notification and queue its external channels in one
 * transaction, then send a best-effort, id-free change hint. Works from both
 * the web and worker processes: the hint travels through PostgreSQL NOTIFY
 * (`ledger_events`), which the web process relays to open browsers.
 */
export async function notifyInApplication(
	input: NotificationInput,
	channels: readonly NotificationChannel[] = [],
) {
	const { createNotificationInTransaction } = await import(
		"../integrations/notifications/transaction.server"
	);
	const result = await db.transaction((tx) =>
		createNotificationInTransaction(tx, input, channels),
	);
	db.execute(
		sql`select pg_notify('ledger_events', ${JSON.stringify({ ownerId: result.notification.recipientId, type: "notifications" })})`,
	).catch(() => {
		/* Persistence is already authoritative. */
	});
	return result;
}
