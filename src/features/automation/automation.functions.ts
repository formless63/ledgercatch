/**
 * Server functions for notifications, budgets, outbound webhooks and Invoice
 * Ninja reimbursement invoices. Every handler resolves the session user via
 * requireUser; implementations are imported lazily (server-only).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { appName } from "#/lib/app-name";
import {
	budgetInput,
	claimSettingsInput,
	clientMappingInput,
	endpointInput,
} from "./inputs";
import { ALERT_KINDS } from "./schema";

const owner = async () => {
	const { requireUser } = await import("#/features/ledger/ledger.server");
	return (await requireUser()).id;
};
const idInput = z.object({ id: z.string().uuid() });

/* ───────────── notifications ───────────── */

export const preferencesInput = z.object({
	channels: z.object({
		inApp: z.boolean(),
		email: z.boolean(),
		ntfy: z.boolean(),
	}),
	ntfyTopic: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9_-]{1,64}$/, "Topic: letters, digits, _ and - (max 64)")
		.nullable(),
	digestEnabled: z.boolean(),
	digestHour: z.number().int().min(0).max(23),
	timezone: z.string().trim().min(1).max(64),
	alerts: z.partialRecord(z.enum(ALERT_KINDS), z.boolean()),
});

export const getNotificationSettings = createServerFn({
	method: "GET",
}).handler(async () => {
	const ownerId = await owner();
	const { getPreferences } = await import("./notify.server");
	const prefs = await getPreferences(ownerId);
	return {
		channels: prefs.channels,
		ntfyTopic: prefs.ntfyTopic,
		digestEnabled: prefs.digestEnabled,
		digestHour: prefs.digestHour,
		timezone: prefs.timezone,
		alerts: prefs.alerts,
		lastDigestDate: prefs.lastDigestDate,
		ntfyConfigured: !!process.env.NTFY_BASE_URL,
		ntfyServer: process.env.NTFY_BASE_URL ?? null,
		emailConfigured: !!process.env.SMTP_HOST,
	};
});

export const saveNotificationSettings = createServerFn({ method: "POST" })
	.validator(preferencesInput)
	.handler(async ({ data }) => {
		const ownerId = await owner();
		const { isValidTimeZone } = await import("./digest");
		if (!isValidTimeZone(data.timezone)) throw new Error("Unknown time zone");
		if (data.channels.ntfy && !data.ntfyTopic)
			throw new Error("Set an ntfy topic to enable ntfy");
		const { db } = await import("#/db");
		const { notificationPreferences } = await import("./schema");
		const values = { ...data, updatedAt: new Date() };
		await db
			.insert(notificationPreferences)
			.values({ ownerId, ...values })
			.onConflictDoUpdate({
				target: notificationPreferences.ownerId,
				set: values,
			});
		return { ok: true };
	});

export const sendDigestNow = createServerFn({ method: "POST" }).handler(
	async () => {
		const ownerId = await owner();
		const { sendDigest } = await import("./digest.server");
		const id = await sendDigest(ownerId);
		return { sent: !!id };
	},
);

export const sendTestNotification = createServerFn({ method: "POST" }).handler(
	async () => {
		const ownerId = await owner();
		const { getPreferences, externalChannels } = await import(
			"./notify.server"
		);
		const { notifyInApplication } = await import("#/lib/notifications.server");
		const prefs = await getPreferences(ownerId);
		const channels = externalChannels(prefs);
		await notifyInApplication(
			{
				recipientId: ownerId,
				type: "notifications.test",
				title: "Test notification",
				body: `Notifications from ${appName} reach you here.`,
				metadata: { link: "/app/settings/notifications" },
			},
			channels,
		);
		return { channels };
	},
);

export const listNotifications = createServerFn({ method: "GET" })
	.validator(
		z.object({
			unreadOnly: z.boolean().optional(),
			limit: z.number().int().min(1).max(100).optional(),
			cursor: z.string().max(512).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const ownerId = await owner();
		const { db } = await import("#/db");
		const { queryNotifications } = await import(
			"#/integrations/notifications/notifications.server"
		);
		const { and, count, eq, isNull } = await import("drizzle-orm");
		const { notifications } = await import(
			"#/integrations/notifications/schema"
		);
		const page = await queryNotifications(db, ownerId, {
			...(data.unreadOnly ? { unreadOnly: true } : {}),
			limit: data.limit ?? 20,
			...(data.cursor ? { cursor: data.cursor } : {}),
		});
		const [unread] = await db
			.select({ n: count() })
			.from(notifications)
			.where(
				and(
					eq(notifications.recipientId, ownerId),
					isNull(notifications.readAt),
				),
			);
		return {
			unread: unread?.n ?? 0,
			nextCursor: page.nextCursor,
			items: page.notifications.map((n) => ({
				id: n.id,
				type: n.type,
				title: n.title,
				body: n.body,
				link: typeof n.metadata.link === "string" ? n.metadata.link : null,
				createdAt: n.createdAt.toISOString(),
				readAt: n.readAt?.toISOString() ?? null,
			})),
		};
	});

export const markNotificationRead = createServerFn({ method: "POST" })
	.validator(z.object({ id: z.string().uuid(), read: z.boolean() }))
	.handler(async ({ data }) => {
		const ownerId = await owner();
		const { db } = await import("#/db");
		const { markRead, markUnread } = await import(
			"#/integrations/notifications/notifications.server"
		);
		return {
			ok: await (data.read ? markRead : markUnread)(db, ownerId, data.id),
		};
	});

export const markAllNotificationsRead = createServerFn({
	method: "POST",
}).handler(async () => {
	const ownerId = await owner();
	const { db } = await import("#/db");
	const { and, eq, isNull } = await import("drizzle-orm");
	const { notifications } = await import("#/integrations/notifications/schema");
	await db
		.update(notifications)
		.set({ readAt: new Date() })
		.where(
			and(eq(notifications.recipientId, ownerId), isNull(notifications.readAt)),
		);
	return { ok: true };
});

/* ───────────── budgets ───────────── */

export const listBudgets = createServerFn({ method: "GET" }).handler(
	async () => {
		const { listBudgetsForOwner } = await import("./budgets.server");
		return listBudgetsForOwner(await owner());
	},
);

export const saveBudget = createServerFn({ method: "POST" })
	.validator(budgetInput)
	.handler(async ({ data }) => {
		const ownerId = await owner();
		const { saveBudgetForOwner, evaluateBudgetsForOwner } = await import(
			"./budgets.server"
		);
		const result = await saveBudgetForOwner(ownerId, data);
		await evaluateBudgetsForOwner(ownerId).catch(() => null);
		return result;
	});

export const deleteBudget = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => {
		const { deleteBudgetForOwner } = await import("./budgets.server");
		return deleteBudgetForOwner(await owner(), data.id);
	});

/* ───────────── webhooks ───────────── */

export const listWebhookEndpoints = createServerFn({ method: "GET" }).handler(
	async () => {
		const { listEndpointsForOwner } = await import("./webhooks.server");
		return {
			...(await listEndpointsForOwner(await owner())),
			allowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === "true",
		};
	},
);

export const saveWebhookEndpoint = createServerFn({ method: "POST" })
	.validator(endpointInput)
	.handler(async ({ data }) => {
		const { saveEndpointForOwner } = await import("./webhooks.server");
		return saveEndpointForOwner(await owner(), data);
	});

export const deleteWebhookEndpoint = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => {
		const { deleteEndpointForOwner } = await import("./webhooks.server");
		return deleteEndpointForOwner(await owner(), data.id);
	});

export const revealWebhookSecret = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => {
		const { revealEndpointSecretForOwner } = await import("./webhooks.server");
		return revealEndpointSecretForOwner(await owner(), data.id);
	});

export const testWebhookEndpoint = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => {
		const { testEndpointForOwner } = await import("./webhooks.server");
		return testEndpointForOwner(await owner(), data.id);
	});

/* ───────────── Invoice Ninja reimbursement invoices ───────────── */

export const getInvoiceNinjaSetup = createServerFn({ method: "GET" }).handler(
	async () => {
		const { getInvoiceNinjaSetupForOwner } = await import(
			"./invoice-ninja.server"
		);
		return getInvoiceNinjaSetupForOwner(await owner());
	},
);

export const saveInvoiceNinjaClaimSettings = createServerFn({ method: "POST" })
	.validator(claimSettingsInput)
	.handler(async ({ data }) => {
		const { saveClaimSettingsForOwner } = await import(
			"./invoice-ninja.server"
		);
		return saveClaimSettingsForOwner(await owner(), data);
	});

export const mapInvoiceNinjaClient = createServerFn({ method: "POST" })
	.validator(clientMappingInput)
	.handler(async ({ data }) => {
		const { mapEntityClientForOwner } = await import("./invoice-ninja.server");
		return mapEntityClientForOwner(await owner(), data);
	});

export const rotateInvoiceNinjaWebhookSecret = createServerFn({
	method: "POST",
})
	.validator(z.object({ connectionId: z.string().uuid() }))
	.handler(async ({ data }) => {
		const { rotateInvoiceNinjaWebhookSecretForOwner } = await import(
			"./invoice-ninja.server"
		);
		return rotateInvoiceNinjaWebhookSecretForOwner(
			await owner(),
			data.connectionId,
		);
	});

export const revealInvoiceNinjaWebhookSecret = createServerFn({
	method: "POST",
})
	.validator(z.object({ connectionId: z.string().uuid() }))
	.handler(async ({ data }) => {
		const { revealInvoiceNinjaWebhookSecretForOwner } = await import(
			"./invoice-ninja.server"
		);
		return revealInvoiceNinjaWebhookSecretForOwner(
			await owner(),
			data.connectionId,
		);
	});

/** "Create draft invoice" action for one claim (mount on the reimbursements page). */
export const requestClaimInvoiceDraft = createServerFn({ method: "POST" })
	.validator(
		z.object({
			claimId: z.string().uuid(),
			connectionId: z.string().uuid().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const { requestClaimDraftForOwner } = await import(
			"./invoice-ninja.server"
		);
		return requestClaimDraftForOwner(
			await owner(),
			data.claimId,
			data.connectionId,
		);
	});
