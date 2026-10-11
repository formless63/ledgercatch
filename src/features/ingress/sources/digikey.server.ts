/**
 * DigiKey API v4 Order Status source (https://developer.digikey.com).
 *
 *   GET {api}/orderstatus/v4/orders?StartDate&EndDate&PageNumber&PageSize≤25
 *       → { TotalOrders, Orders: [{ OrderNumber, DateEntered, Currency,
 *           SalesOrders: [SalesOrder] }] }
 *   GET {api}/orderstatus/v4/salesorder/{salesOrderId} → SalesOrder
 *
 * The OpenAPI spec lists both 2-legged (client credentials) and 3-legged
 * OAuth for this product. A personal developer app uses client credentials
 * (optionally with X-DIGIKEY-Account-Id); if a refresh token is configured we
 * use the 3-legged refresh grant instead and persist the rotated refresh token
 * (DigiKey issues a new one on every refresh).
 *
 * Captures are written as kind "agent" with ParsedOrder[] mapped here: the
 * store parser would treat the outer Order (OrderNumber) as the order and
 * misses v4's field names (DigiKeyProductNumber, Description, ItemShipments).
 * The website and invoices use the Sales Order ID, so that is our order id.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "#/db";
import {
	decryptSecret,
	encryptSecret,
} from "#/features/connectors/crypto.server";
import { toMinor } from "#/features/parsing/money";
import type {
	OrderStatus,
	ParsedItem,
	ParsedOrder,
	ParsedShipment,
} from "#/features/parsing/types";
import { createServerCapture } from "../captures.server";
import { ingressSources } from "../schema";
import type { IngressSourceRow, SourceModule } from "../types";

type DigikeyConfig = {
	clientId: string;
	environment: "production" | "sandbox";
	customerId?: string;
	/** Days to look back on the first poll (default 90). */
	initialDays?: number;
};
type DigikeySecret = { clientSecret: string; refreshToken?: string };

const API_BASE = {
	production: "https://api.digikey.com",
	sandbox: "https://sandbox-api.digikey.com",
} as const;
const PAGE_SIZE = 25;
const MAX_PAGES = 8;
const TIMEOUT_MS = 30_000;

export function digikeyConfig(source: IngressSourceRow): DigikeyConfig {
	const raw = source.config as Record<string, unknown>;
	const clientId = typeof raw.clientId === "string" ? raw.clientId.trim() : "";
	if (!clientId) throw new Error("DigiKey source: client ID is not set");
	const customerId =
		raw.customerId === undefined || raw.customerId === null
			? undefined
			: String(raw.customerId).trim() || undefined;
	const days = Number(raw.initialDays);
	return {
		clientId,
		environment: raw.environment === "sandbox" ? "sandbox" : "production",
		customerId,
		initialDays:
			Number.isFinite(days) && days > 0 ? Math.min(days, 365 * 3) : 90,
	};
}

function digikeySecret(source: IngressSourceRow): DigikeySecret {
	if (!source.secretCiphertext)
		throw new Error("DigiKey source: client secret is not set");
	const secret = decryptSecret<Partial<DigikeySecret>>(source.secretCiphertext);
	if (!secret.clientSecret)
		throw new Error("DigiKey source: client secret is not set");
	return {
		clientSecret: secret.clientSecret,
		refreshToken: secret.refreshToken?.trim() || undefined,
	};
}

/* ------------------------------- OAuth ---------------------------------- */

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
	ErrorMessage?: string;
};

async function accessToken(source: IngressSourceRow): Promise<string> {
	const cached = tokenCache.get(source.id);
	if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
	const config = digikeyConfig(source);
	const secret = digikeySecret(source);
	const body = new URLSearchParams({
		client_id: config.clientId,
		client_secret: secret.clientSecret,
		...(secret.refreshToken
			? { grant_type: "refresh_token", refresh_token: secret.refreshToken }
			: { grant_type: "client_credentials" }),
	});
	const res = await fetch(`${API_BASE[config.environment]}/v1/oauth2/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const json = (await res.json().catch(() => ({}))) as TokenResponse;
	if (!res.ok || !json.access_token) {
		const detail =
			json.error_description ?? json.ErrorMessage ?? json.error ?? "";
		throw new Error(
			`DigiKey token request failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
		);
	}
	if (secret.refreshToken && json.refresh_token) {
		// Refresh tokens rotate: store the new one or the next refresh fails.
		const ciphertext = encryptSecret({
			...secret,
			refreshToken: json.refresh_token,
		});
		await db
			.update(ingressSources)
			.set({ secretCiphertext: ciphertext, updatedAt: new Date() })
			.where(eq(ingressSources.id, source.id));
		source.secretCiphertext = ciphertext;
	}
	tokenCache.set(source.id, {
		token: json.access_token,
		expiresAt: Date.now() + (json.expires_in ?? 600) * 1000,
	});
	return json.access_token;
}

async function apiGet(
	source: IngressSourceRow,
	path: string,
): Promise<{ url: string; body: unknown }> {
	const config = digikeyConfig(source);
	const url = `${API_BASE[config.environment]}/orderstatus/v4${path}`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${await accessToken(source)}`,
		"X-DIGIKEY-Client-Id": config.clientId,
		Accept: "application/json",
	};
	if (config.customerId) headers["X-DIGIKEY-Account-Id"] = config.customerId;
	const res = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (res.status === 401) tokenCache.delete(source.id);
	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).slice(0, 300);
		throw new Error(
			`DigiKey ${path.split("?")[0]} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
		);
	}
	return { url, body: await res.json() };
}

/* ------------------------------- Mapping -------------------------------- */

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined;
const recs = (v: unknown): Rec[] =>
	Array.isArray(v) ? v.map(rec).filter((r): r is Rec => Boolean(r)) : [];
const str = (v: unknown): string | undefined =>
	typeof v === "string" && v.trim()
		? v.trim()
		: typeof v === "number" && Number.isFinite(v)
			? String(v)
			: undefined;
const num = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v)
		? v
		: typeof v === "string" && v.trim() && Number.isFinite(Number(v))
			? Number(v)
			: undefined;

export function mapDigikeyStatus(raw: string | undefined): OrderStatus {
	if (!raw) return "unknown";
	if (/^delivered$/i.test(raw)) return "delivered";
	if (/^shipped$/i.test(raw)) return "shipped";
	if (/^cancel+ed$/i.test(raw)) return "cancelled";
	if (/^received$/i.test(raw)) return "placed";
	if (/^(processing|genericdelay|proforma|actionrequired)/i.test(raw))
		return "processing";
	return "unknown";
}

/** UnitPrice may be a decimal or a fixed-point integer; infer from the line total. */
function unitPriceMinor(
	unit: number | undefined,
	totalMinor: number | undefined,
	quantity: number,
	currency: string | undefined,
): number | undefined {
	if (unit === undefined) {
		return totalMinor !== undefined && quantity > 0
			? Math.round(totalMinor / quantity)
			: undefined;
	}
	if (totalMinor !== undefined && quantity > 0) {
		for (const scale of [1, 100, 1000, 10000, 100000, 1000000]) {
			const candidate = toMinor((unit / scale) * quantity, currency);
			if (Math.abs(candidate - totalMinor) <= Math.max(1, totalMinor * 0.01))
				return toMinor(unit / scale, currency);
		}
		return Math.round(totalMinor / quantity);
	}
	return toMinor(unit, currency);
}

function isoDate(v: unknown): string | undefined {
	const s = str(v);
	return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}

/** Map one v4 SalesOrder (optionally with its parent Order) to a ParsedOrder. */
export function mapSalesOrder(
	salesOrder: Rec,
	parent?: Rec,
): ParsedOrder | null {
	const id = str(salesOrder.SalesOrderId);
	if (!id || !/^\d{4,16}$/.test(id)) return null;
	const currency =
		str(salesOrder.Currency)?.toUpperCase() ??
		str(parent?.Currency)?.toUpperCase();
	const status = rec(salesOrder.Status) ?? rec(parent?.EntireOrderStatus);
	const statusCode = str(status?.SalesOrderStatus ?? status?.OrderStatus);
	const items: ParsedItem[] = [];
	const shipments = new Map<string, ParsedShipment>();
	for (const line of recs(salesOrder.LineItems)) {
		const quantity =
			num(line.QuantityOrdered) ?? num(line.QuantityInitialRequested) ?? 1;
		const total = num(line.TotalPrice);
		const totalMinor =
			total === undefined ? undefined : toMinor(total, currency);
		const dkPart = str(line.DigiKeyProductNumber);
		const mpn = str(line.ManufacturerProductNumber);
		items.push({
			externalItemId: str(line.DetailId) ?? dkPart,
			title: str(line.Description) ?? mpn ?? dkPart ?? "DigiKey part",
			sku: dkPart ?? mpn,
			variant: mpn && dkPart ? `MPN ${mpn}` : undefined,
			quantity,
			unitPriceMinor: unitPriceMinor(
				num(line.UnitPrice),
				totalMinor,
				quantity,
				currency,
			),
			totalMinor,
			itemUrl: dkPart
				? `https://www.digikey.com/en/products/result?keywords=${encodeURIComponent(dkPart)}`
				: undefined,
		});
		for (const ship of recs(line.ItemShipments)) {
			const tracking = str(ship.TrackingNumber);
			if (!tracking || shipments.has(tracking)) continue;
			shipments.set(tracking, {
				trackingNumber: tracking,
				shippedAt: isoDate(ship.ShippedDate),
				etaText: isoDate(ship.ExpectedDeliveryDate),
			});
		}
	}
	const subtotal = items.every((i) => i.totalMinor !== undefined)
		? items.reduce((sum, i) => sum + (i.totalMinor ?? 0), 0)
		: undefined;
	const totalPrice = num(salesOrder.TotalPrice);
	const po = str(salesOrder.PurchaseOrder) ?? str(parent?.PONumber);
	return {
		externalOrderId: id,
		merchantName: "DigiKey",
		orderUrl: `https://www.digikey.com/OrderHistory/ReviewOrder/${id}`,
		orderDate: isoDate(salesOrder.DateEntered) ?? isoDate(parent?.DateEntered),
		status: mapDigikeyStatus(statusCode),
		statusText: str(status?.ShortDescription) ?? statusCode,
		currency,
		subtotalMinor: items.length ? subtotal : undefined,
		totalMinor:
			totalPrice === undefined ? undefined : toMinor(totalPrice, currency),
		paymentHint: po ? `PO ${po}` : undefined,
		items: items.length ? items : undefined,
		shipments: shipments.size ? [...shipments.values()] : undefined,
	};
}

/** Flatten an /orders response into (salesOrder, parent) pairs. */
export function salesOrdersOf(body: unknown): Array<{ so: Rec; parent?: Rec }> {
	const root = rec(body);
	if (!root) return [];
	if (root.SalesOrderId !== undefined) return [{ so: root }];
	return recs(root.Orders).flatMap((order) =>
		recs(order.SalesOrders).map((so) => ({ so, parent: order })),
	);
}

async function captureSalesOrder(
	source: IngressSourceRow,
	so: Rec,
	parent: Rec | undefined,
	requestUrl: string,
) {
	const parsed = mapSalesOrder(so, parent);
	if (!parsed) return { created: false, captureId: null };
	const raw = JSON.stringify(so);
	const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	const result = await createServerCapture({
		ownerId: source.ownerId,
		channel: "api",
		// New content → new capture; unchanged orders stay idempotent.
		sourceRef: `digikey:${parsed.externalOrderId}:${digest}`,
		source: "digikey",
		kind: "agent",
		pageType: "order_detail",
		pageUrl: requestUrl,
		pageTitle: `DigiKey sales order ${parsed.externalOrderId}`,
		bodyJson: {
			orders: [parsed],
			digikey: { requestUrl, salesOrder: so, order: parent ?? null },
		},
		orderIdHints: [parsed.externalOrderId],
	});
	return { created: result.created, captureId: result.captureId };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export const digikeySource: SourceModule = {
	label: "DigiKey API",
	description:
		"Order history and status from the DigiKey API v4 (Order Status). Needs a DigiKey developer app subscribed to the Order Status product.",
	configFields: [
		{
			key: "clientId",
			label: "Client ID",
			type: "text",
			required: true,
			help: "From your app at developer.digikey.com (My Apps).",
		},
		{
			key: "environment",
			label: "Environment",
			type: "select",
			options: [
				{ value: "production", label: "Production" },
				{ value: "sandbox", label: "Sandbox" },
			],
		},
		{
			key: "customerId",
			label: "Account ID",
			type: "text",
			help: "Your DigiKey account/customer number. Needed when your login belongs to more than one account (sent as X-DIGIKEY-Account-Id).",
		},
		{
			key: "initialDays",
			label: "First import: days back",
			type: "number",
			placeholder: "90",
		},
	],
	secretFields: [
		{
			key: "clientSecret",
			label: "Client secret",
			type: "password",
			required: true,
		},
		{
			key: "refreshToken",
			label: "Refresh token (3-legged, optional)",
			type: "password",
			help: "Only if your app uses the authorization-code flow. Leave empty for client credentials.",
		},
	],

	async poll(source) {
		const config = digikeyConfig(source);
		const cursor = (source.cursor ?? {}) as { lastEndDate?: string };
		const now = new Date();
		// Re-read a week of history: statuses and shipments keep changing.
		const start = cursor.lastEndDate
			? new Date(Date.parse(cursor.lastEndDate) - 7 * 86_400_000)
			: new Date(now.getTime() - (config.initialDays ?? 90) * 86_400_000);
		let created = 0;
		let seen = 0;
		for (let page = 1; page <= MAX_PAGES; page++) {
			const query = new URLSearchParams({
				StartDate: ymd(start),
				EndDate: ymd(now),
				PageNumber: String(page),
				PageSize: String(PAGE_SIZE),
			});
			const { url, body } = await apiGet(source, `/orders?${query}`);
			const pairs = salesOrdersOf(body);
			for (const { so, parent } of pairs) {
				seen++;
				if ((await captureSalesOrder(source, so, parent, url)).created)
					created++;
			}
			const orders = recs(rec(body)?.Orders).length;
			const total = num(rec(body)?.TotalOrders) ?? 0;
			if (orders < PAGE_SIZE || page * PAGE_SIZE >= total) break;
		}
		return {
			cursor: { lastEndDate: ymd(now) },
			created,
			summary: `${seen} sales order(s) since ${ymd(start)}, ${created} new/changed`,
		};
	},

	async test(source) {
		try {
			const today = new Date();
			const query = new URLSearchParams({
				StartDate: ymd(new Date(today.getTime() - 30 * 86_400_000)),
				EndDate: ymd(today),
				PageNumber: "1",
				PageSize: "1",
			});
			const { body } = await apiGet(source, `/orders?${query}`);
			const total = num(rec(body)?.TotalOrders) ?? 0;
			return {
				ok: true,
				message: `Connected. ${total} order(s) in the last 30 days.`,
			};
		} catch (error) {
			return {
				ok: false,
				message: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

/** Fetch one sales order and create a capture for it (provider enrichment). */
export async function fetchDigikeySalesOrder(
	source: IngressSourceRow,
	salesOrderId: string,
): Promise<{ captureId: string | null; created: boolean }> {
	if (!/^\d{4,16}$/.test(salesOrderId))
		throw new Error(`Not a DigiKey sales order id: ${salesOrderId}`);
	const { url, body } = await apiGet(source, `/salesorder/${salesOrderId}`);
	const so = rec(body);
	if (!so) throw new Error("DigiKey returned no sales order");
	return captureSalesOrder(source, so, undefined, url);
}
