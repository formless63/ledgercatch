/**
 * Per-user notification preferences and the single "notify an owner" path
 * used by digests, budget alerts and instant alerts.
 */
import { eq } from "drizzle-orm";
import { db } from "#/db";
import type { NotificationChannel } from "#/integrations/notifications/jobs.server";
import { alertEnabled } from "./digest";
import {
	type AlertKind,
	type ChannelToggles,
	notificationPreferences,
} from "./schema";

export type Preferences = typeof notificationPreferences.$inferSelect;

export const DEFAULT_CHANNELS: ChannelToggles = {
	inApp: true,
	email: false,
	ntfy: false,
};

export async function getPreferences(ownerId: string): Promise<Preferences> {
	const [row] = await db
		.select()
		.from(notificationPreferences)
		.where(eq(notificationPreferences.ownerId, ownerId))
		.limit(1);
	return (
		row ?? {
			ownerId,
			channels: DEFAULT_CHANNELS,
			ntfyTopic: null,
			digestEnabled: true,
			digestHour: 8,
			timezone: "UTC",
			alerts: {},
			lastDigestDate: null,
			updatedAt: new Date(0),
		}
	);
}

export function externalChannels(prefs: Preferences): NotificationChannel[] {
	const channels: NotificationChannel[] = [];
	if (prefs.channels.email) channels.push("email");
	if (prefs.channels.ntfy && prefs.ntfyTopic) channels.push("ntfy");
	return channels;
}

/**
 * Create one notification for `ownerId` when `alert` is enabled, delivering
 * to the owner's external channels. The in-app row is always the record
 * (the bell lists it); returns null when the alert is switched off.
 */
export async function notifyOwner(
	ownerId: string,
	input: {
		alert: AlertKind;
		type: string;
		title: string;
		body: string;
		link?: string;
		metadata?: Record<string, string | number | boolean | null>;
	},
	prefs?: Preferences,
) {
	const current = prefs ?? (await getPreferences(ownerId));
	if (!alertEnabled(current.alerts, input.alert)) return null;
	const { notifyInApplication } = await import("#/lib/notifications.server");
	const { notification } = await notifyInApplication(
		{
			recipientId: ownerId,
			type: input.type,
			title: input.title.slice(0, 200),
			body: input.body.slice(0, 3500),
			metadata: { ...(input.metadata ?? {}), link: input.link ?? null },
		},
		externalChannels(current),
	);
	return notification.id;
}
