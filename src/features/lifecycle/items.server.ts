/**
 * "Where did I buy X" item search (#5) and price history (#16).
 *
 * Search uses ILIKE over title/SKU/variant until `order_items.search_vector`
 * exists (see schema.ts notes); then flip ITEM_FTS_ENABLED to rank with the
 * Search capability helpers.
 */
import { and, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import { orderItems, orders } from "#/features/ledger/schema";
import { searchQuery, searchRank } from "#/integrations/search/search.server";
import type { itemHistoryInput, itemSearchInput } from "./inputs";
import {
	groupPurchases,
	itemKey,
	likeEscape,
	type PurchaseRow,
	searchTerms,
	titleTokens,
} from "./items";

/** Set once the generated `order_items.search_vector` column is migrated. */
export const ITEM_FTS_ENABLED = true;

const purchaseColumns = {
	itemId: orderItems.id,
	orderId: orders.id,
	title: orderItems.title,
	sku: orderItems.sku,
	variant: orderItems.variant,
	quantity: orderItems.quantity,
	unitPriceMinor: orderItems.unitPriceMinor,
	totalMinor: orderItems.totalMinor,
	itemUrl: orderItems.itemUrl,
	imageUrl: orderItems.imageUrl,
	source: orders.source,
	merchantName: orders.merchantName,
	orderDate: orders.orderDate,
	currency: orders.currency,
	externalOrderId: orders.externalOrderId,
};

const itemHaystack = sql`(${orderItems.title} || ' ' || coalesce(${orderItems.sku}, '') || ' ' || coalesce(${orderItems.variant}, ''))`;

function termPredicates(query: string): SQL[] {
	return searchTerms(query).map(
		(term) => sql`${itemHaystack} ilike ${`%${likeEscape(term)}%`}`,
	);
}

export async function searchItemsForOwner(
	ownerId: string,
	input: z.output<typeof itemSearchInput>,
) {
	const base: SQL[] = [
		eq(orders.ownerId, ownerId),
		sql`${orders.reviewState} <> 'ignored'`,
	];
	let rows: PurchaseRow[];
	if (input.q && ITEM_FTS_ENABLED) {
		const vector = sql`"order_items"."search_vector"`;
		const query = searchQuery(input.q);
		rows = await db
			.select(purchaseColumns)
			.from(orderItems)
			.innerJoin(orders, eq(orders.id, orderItems.orderId))
			.where(and(...base, sql`${vector} @@ ${query}`))
			.orderBy(desc(searchRank(vector, query)), desc(orders.orderDate))
			.limit(input.limit);
	} else {
		const terms = input.q ? termPredicates(input.q) : [];
		rows = await db
			.select(purchaseColumns)
			.from(orderItems)
			.innerJoin(orders, eq(orders.id, orderItems.orderId))
			.where(and(...base, ...terms))
			.orderBy(desc(orders.orderDate), desc(orderItems.id))
			.limit(input.limit);
	}
	const groups = groupPurchases(rows);
	return {
		total: rows.length,
		truncated: rows.length >= input.limit,
		groups: groups.map(({ rows: groupRows, ...group }) => ({
			...group,
			// Keep payload small: latest 5 purchases per group.
			recent: groupRows.slice(0, 5),
		})),
	};
}
export type ItemSearchResult = Awaited<ReturnType<typeof searchItemsForOwner>>;

/** All purchases of the same thing (same itemKey), newest first. */
export async function getItemHistoryForOwner(
	ownerId: string,
	input: z.output<typeof itemHistoryInput>,
) {
	const key = itemKey({ title: input.title, sku: input.sku });
	const prefilter: SQL[] = [];
	if (key.startsWith("sku:")) {
		prefilter.push(
			sql`regexp_replace(upper(coalesce(${orderItems.sku}, '')), '[\\s\\-_./]+', '', 'g') = ${key.slice(4)}`,
		);
	} else {
		const tokens = titleTokens(input.title).slice(0, 3);
		const match = and(
			...tokens.map((t) => ilike(orderItems.title, `%${likeEscape(t)}%`)),
		);
		if (match) prefilter.push(match);
	}
	const rows = await db
		.select(purchaseColumns)
		.from(orderItems)
		.innerJoin(orders, eq(orders.id, orderItems.orderId))
		.where(
			and(
				eq(orders.ownerId, ownerId),
				sql`${orders.reviewState} <> 'ignored'`,
				or(...prefilter) ?? sql`true`,
			),
		)
		.orderBy(desc(orders.orderDate))
		.limit(2000);
	const same = rows.filter((row) => itemKey(row) === key);
	const [group] = groupPurchases(same);
	return group ?? null;
}
export type ItemHistory = NonNullable<
	Awaited<ReturnType<typeof getItemHistoryForOwner>>
>;
