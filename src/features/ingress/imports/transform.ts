/**
 * Pure spreadsheet rows → ParsedOrder grouping (client-safe; the mapping UI
 * runs it on preview rows, the import job on the whole sheet).
 */
import { parseDate } from "#/features/parsing/dates";
import {
	detectCurrency,
	normalizeCurrencyCode,
	parseDecimalString,
	parseMoney,
} from "#/features/parsing/money";
import { normalizeStatus } from "#/features/parsing/status";
import type {
	OrderStatus,
	ParsedItem,
	ParsedOrder,
	ParsedShipment,
} from "#/features/parsing/types";
import { normalizeHeader } from "./presets";
import {
	type FieldSpec,
	type ImportedOrder,
	type ImportMapping,
	MONEY_ORDER_FIELDS,
	type MoneyOrderField,
	type TargetField,
} from "./types";

export type BuildOrdersInput = {
	headers: string[];
	/** Data rows (after the header row). */
	rows: string[][];
	mapping: ImportMapping;
	fileName?: string;
	/** 1-based sheet row number of rows[0] (for error messages). */
	firstRowNumber?: number;
	maxErrors?: number;
};

export type BuildOrdersResult = {
	orders: ImportedOrder[];
	errors: Array<{ row: number; message: string }>;
	/** Rows that held data (blank rows are ignored). */
	dataRows: number;
	skippedRows: number;
	errorRows: number;
};

/** Strips spreadsheet text-forcing wrappers: `'123`, `="00123"`. */
export function cleanCell(value: string | undefined | null): string {
	if (value == null) return "";
	let text = String(value).replace(/[​-‏⁠﻿]/g, "").trim();
	const formula = /^="(.*)"$/.exec(text);
	if (formula) text = formula[1] ?? "";
	if (text.startsWith("'") && !text.endsWith("'")) text = text.slice(1);
	else if (/^'.*'$/.test(text) && text.length >= 2) text = text.slice(1, -1);
	const trimmed = text.trim();
	return /^(n\/?a|not available|none|null|-|—|–)$/i.test(trimmed)
		? ""
		: trimmed;
}

/** Longest digit run (≥ 5) in a file name: "Sales Order 84512345.csv" → "84512345". */
export function orderIdFromFileName(fileName: string | undefined) {
	if (!fileName) return undefined;
	const base = fileName.replace(/\.[a-z0-9]{2,5}$/i, "");
	const runs = base.match(/\d{5,}/g) ?? [];
	return runs.sort((a, b) => b.length - a.length)[0];
}

/** Quantity text → number (supports "1,000", "2.5", "3 pcs"). */
export function parseQuantity(text: string): number | undefined {
	const match = /-?\d[\d.,\s']*/.exec(text);
	if (!match) return undefined;
	const decimal = parseDecimalString(match[0].trim(), 2);
	if (decimal === undefined) return undefined;
	const value = Number(decimal);
	return Number.isFinite(value) ? value : undefined;
}

/** "Visa ending in 4821", "Mastercard - 1234", "****1234" → "4821". */
export function last4From(text: string): string | undefined {
	const trimmed = text.trim();
	if (/^\d{4}$/.test(trimmed)) return trimmed;
	const match =
		/(?:ending(?:\s+in)?|endet\s+auf|\*{2,}|x{2,}|•{2,}|\.{3}|…|[-–:#])\s*(\d{4})\b/i.exec(
			trimmed,
		);
	return match?.[1];
}

const TRACKING_PIECE_RE = /^(.*?)\s*\(\s*([A-Za-z0-9-]{6,})\s*\)\s*$/;

/** "UPS(1Z999…)", "AMZN_US(TBA123…), USPS(9400…)" → shipments. */
export function parseTracking(
	text: string,
	carrier?: string,
): ParsedShipment[] {
	const out: ParsedShipment[] = [];
	for (const raw of text.split(/[,;|\n]+/)) {
		const piece = raw.trim();
		if (!piece) continue;
		const match = TRACKING_PIECE_RE.exec(piece);
		const number = (match ? match[2] : piece)?.replace(/\s+/g, "") ?? "";
		if (!/^[A-Za-z0-9-]{6,40}$/.test(number) || !/\d/.test(number)) continue;
		const pieceCarrier = match?.[1]?.trim() || carrier || undefined;
		out.push({
			trackingNumber: number,
			...(pieceCarrier ? { carrier: pieceCarrier } : {}),
		});
	}
	return out;
}

function httpUrl(text: string): string | undefined {
	if (!text) return undefined;
	try {
		const url = new URL(text.startsWith("//") ? `https:${text}` : text);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

/** Lowercase dash slug: "Acme Tools, Inc." → "acme-tools-inc". */
export function merchantSlug(name: string | undefined): string {
	const slug = (name ?? "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/g, "");
	return slug || "unknown-merchant";
}

/** FNV-1a 32-bit, hex — for synthetic ids only (not security relevant). */
function fnv(text: string) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function columnIndex(headers: string[]) {
	const exact = new Map<string, number>();
	const loose = new Map<string, number>();
	headers.forEach((header, index) => {
		if (!exact.has(header)) exact.set(header, index);
		const key = normalizeHeader(header);
		if (key && !loose.has(key)) loose.set(key, index);
	});
	return (column: string | undefined) => {
		if (!column) return -1;
		return exact.get(column) ?? loose.get(normalizeHeader(column)) ?? -1;
	};
}

type Accessor = (row: string[], field: TargetField) => string;

function makeAccessor(
	headers: string[],
	mapping: ImportMapping,
	fileName: string | undefined,
): Accessor {
	const indexOf = columnIndex(headers);
	const resolved = new Map<
		TargetField,
		{ index: number; spec: FieldSpec; fileId?: string }
	>();
	for (const [field, spec] of Object.entries(mapping.fields) as Array<
		[TargetField, FieldSpec | undefined]
	>) {
		if (!spec) continue;
		resolved.set(field, {
			index: indexOf(spec.column),
			spec,
			fileId: spec.fromFileName ? orderIdFromFileName(fileName) : undefined,
		});
	}
	return (row, field) => {
		const entry = resolved.get(field);
		if (!entry) return "";
		const value = entry.index >= 0 ? cleanCell(row[entry.index]) : "";
		return value || entry.spec.constant?.trim() || entry.fileId || "";
	};
}

function compileFilters(headers: string[], mapping: ImportMapping) {
	const indexOf = columnIndex(headers);
	return (mapping.options.filters ?? []).flatMap((filter) => {
		const index = indexOf(filter.column);
		if (index < 0) return [];
		let re: RegExp;
		try {
			re = new RegExp(filter.pattern, "i");
		} catch {
			return [];
		}
		return [
			(row: string[]) => re.test(cleanCell(row[index])) !== !!filter.negate,
		];
	});
}

type Group = {
	key: string;
	id: string;
	rows: Array<{ row: string[]; number: number }>;
};

/** Groups mapped rows into orders. Never throws on bad cells. */
export function buildOrders(input: BuildOrdersInput): BuildOrdersResult {
	const { headers, rows, mapping } = input;
	const maxErrors = input.maxErrors ?? 100;
	const first = input.firstRowNumber ?? 2;
	const get = makeAccessor(headers, mapping, input.fileName);
	const filters = compileFilters(headers, mapping);
	const errors: BuildOrdersResult["errors"] = [];
	let errorRows = 0;
	let skippedRows = 0;
	let dataRows = 0;
	const pushError = (row: number, message: string) => {
		errorRows++;
		if (errors.length < maxErrors) errors.push({ row, message });
	};

	const hasIdSpec = Boolean(mapping.fields.externalOrderId);
	const groups = new Map<string, Group>();
	rows.forEach((row, index) => {
		const number = first + index;
		if (!row.some((cell) => cleanCell(cell))) return;
		dataRows++;
		if (!filters.every((test) => test(row))) {
			skippedRows++;
			return;
		}
		let id = get(row, "externalOrderId");
		if (!id) {
			if (hasIdSpec) {
				pushError(number, "Missing order ID");
				return;
			}
			// No id column: one order per row, keyed by its content.
			id = `row-${fnv(
				[
					get(row, "orderDate"),
					get(row, "merchantName"),
					get(row, "total"),
					get(row, "title"),
				].join("|"),
			)}`;
		}
		id = id.replace(/^#/, "").trim().slice(0, 200);
		const merchantKey =
			mapping.source === "generic"
				? merchantSlug(get(row, "merchantName"))
				: "";
		const key = `${merchantKey}\u0000${id}`;
		let group = groups.get(key);
		if (!group) {
			group = { key, id, rows: [] };
			groups.set(key, group);
		}
		group.rows.push({ row, number });
	});

	const orders: ImportedOrder[] = [];
	for (const group of groups.values()) {
		try {
			orders.push(buildOrder(group, mapping, get, hasIdSpec));
		} catch (error) {
			pushError(
				group.rows[0]?.number ?? first,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	return { orders, errors, dataRows, skippedRows, errorRows };
}

function firstValue(group: Group, get: Accessor, field: TargetField) {
	for (const { row } of group.rows) {
		const value = get(row, field);
		if (value) return value;
	}
	return "";
}

function buildOrder(
	group: Group,
	mapping: ImportMapping,
	get: Accessor,
	hasIdSpec: boolean,
): ImportedOrder {
	const { options } = mapping;
	const warnings: string[] = [];
	const firstCell = (field: TargetField) => firstValue(group, get, field);

	const currencyText = firstCell("currency");
	let currency =
		normalizeCurrencyCode(currencyText) ??
		(currencyText ? detectCurrency(currencyText) : undefined) ??
		normalizeCurrencyCode(options.currency);
	if (!currency) {
		// Fall back to markers inside the amounts ("€12,30").
		for (const field of ["total", "unitPrice", "lineTotal"] as const) {
			const text = firstCell(field);
			const detected = text ? detectCurrency(text) : undefined;
			if (detected) {
				currency = detected;
				break;
			}
		}
	}

	const money = (text: string, field: string, absolute = false) => {
		if (!text) return undefined;
		const parsed = parseMoney(text, { currency, allowFree: true });
		if (!parsed || !Number.isFinite(parsed.amountMinor)) {
			warnings.push(`Unreadable ${field} “${text.slice(0, 40)}”`);
			return undefined;
		}
		return absolute || options.absoluteAmounts
			? Math.abs(parsed.amountMinor)
			: parsed.amountMinor;
	};

	const sumFields = new Set(options.sumFields ?? []);
	const orderMoney = (field: MoneyOrderField) => {
		const absolute = field === "discount";
		if (!sumFields.has(field)) return money(firstCell(field), field, absolute);
		let sum: number | undefined;
		for (const { row } of group.rows) {
			const value = money(get(row, field), field, absolute);
			if (value !== undefined) sum = (sum ?? 0) + value;
		}
		return sum;
	};

	const order: ParsedOrder = { externalOrderId: group.id };
	if (!hasIdSpec) warnings.push("No order ID column: synthetic ID used");
	const merchant = firstCell("merchantName");
	if (merchant) order.merchantName = merchant.slice(0, 200);
	const dateText = firstCell("orderDate");
	if (dateText) {
		const date = parseDate(dateText, { dayFirst: options.dayFirst });
		if (date) order.orderDate = date;
		else warnings.push(`Unreadable date “${dateText.slice(0, 40)}”`);
	}
	if (currency) order.currency = currency;
	for (const field of MONEY_ORDER_FIELDS) {
		const value = orderMoney(field);
		if (value !== undefined) order[`${field}Minor`] = value;
	}

	const statusText = firstCell("status");
	if (statusText) {
		order.statusText = statusText.slice(0, 200);
		const mapped: OrderStatus | undefined =
			options.statusMap?.[statusText.toLowerCase()] ??
			normalizeStatus(statusText);
		if (mapped) order.status = mapped;
	}
	const payment = firstCell("paymentHint");
	if (payment) {
		order.paymentHint = payment.slice(0, 200);
		const last4 = last4From(payment);
		if (last4) order.paymentLast4 = last4;
	}
	const orderUrl = httpUrl(firstCell("orderUrl"));
	if (orderUrl) order.orderUrl = orderUrl;

	const shipments = new Map<string, ParsedShipment>();
	for (const { row } of group.rows) {
		const tracking = get(row, "trackingNumber");
		if (!tracking) continue;
		for (const shipment of parseTracking(
			tracking,
			get(row, "carrier") || undefined,
		))
			if (!shipments.has(shipment.trackingNumber))
				shipments.set(shipment.trackingNumber, shipment);
	}
	if (shipments.size) order.shipments = [...shipments.values()];

	const items: ParsedItem[] = [];
	for (const { row, number } of group.rows) {
		const title = get(row, "title");
		const sku = get(row, "sku");
		if (!title && !sku) continue;
		const quantityText = get(row, "quantity");
		let quantity = quantityText ? parseQuantity(quantityText) : 1;
		if (quantity === undefined || quantity <= 0) {
			if (quantityText)
				warnings.push(`Row ${number}: unreadable quantity “${quantityText}”`);
			quantity = 1;
		}
		let unit = money(get(row, "unitPrice"), "unit price");
		let line = money(get(row, "lineTotal"), "line total");
		if (line === undefined && unit !== undefined)
			line = Math.round(unit * quantity);
		if (unit === undefined && line !== undefined)
			unit = Math.round(line / quantity);
		const item: ParsedItem = {
			title: (title || sku).slice(0, 500),
			quantity,
		};
		if (sku) item.sku = sku.slice(0, 200);
		if (unit !== undefined) item.unitPriceMinor = unit;
		if (line !== undefined) item.totalMinor = line;
		const itemUrl = httpUrl(get(row, "itemUrl"));
		if (itemUrl) item.itemUrl = itemUrl;
		items.push(item);
	}
	if (items.length) {
		order.items = items;
		const priced = items.every((item) => item.totalMinor !== undefined);
		const lineSum = items.reduce(
			(sum, item) => sum + (item.totalMinor ?? 0),
			0,
		);
		if (priced && order.subtotalMinor === undefined && !mapping.fields.subtotal)
			order.subtotalMinor = lineSum;
		if (priced && order.totalMinor === undefined) {
			order.totalMinor =
				lineSum +
				(order.shippingMinor ?? 0) +
				(order.taxMinor ?? 0) -
				(order.discountMinor ?? 0);
			warnings.push("Total computed from line items");
		}
	}
	if (order.totalMinor === undefined && !items.length)
		warnings.push("No total and no items");

	return {
		order,
		rows: group.rows.map((r) => r.number),
		warnings: [...new Set(warnings)].slice(0, 20),
	};
}
