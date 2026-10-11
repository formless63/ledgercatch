/**
 * Reconciliation: run the matcher over open statement transactions, list
 * what needs attention, and apply user decisions (confirm / reject / create
 * a manual order / not a purchase). Every function is owner-scoped.
 */
import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	lte,
	ne,
	notExists,
	or,
	sql,
} from "drizzle-orm";
import { db } from "#/db";
import { createManualOrderForOwner } from "#/features/ledger/ledger.server";
import { recomputeAllocations } from "#/features/ledger/orders.server";
import {
	entities,
	orderItems,
	orders,
	paymentMethods,
} from "#/features/ledger/schema";
import { minorDigits } from "#/features/parsing/money";
import { addDays, convertMinorWithRate, minorToDecimal } from "./fx";
import { ensureFxRates, loadRateTable } from "./fx.server";
import {
	type Converter,
	type MatchOrder,
	type MatchTransaction,
	matchTransactions,
	REFUND_WINDOW_DAYS,
	SPLIT_WINDOW_DAYS,
} from "./matcher";
import { normalizeMerchant, orderMerchantKey } from "./merchant";
import {
	statementImports,
	statementTransactions,
	transactionMatches,
} from "./schema";

const OPEN_STATUSES = ["unmatched", "suggested"] as const;

/* ───────────────────────── matching run ───────────────────────── */

/**
 * Recomputes suggestions for open transactions (all, or one import's).
 * Confirmed and rejected decisions are kept; stale suggestions are replaced.
 */
export async function runReconciliation(
	ownerId: string,
	statementImportId?: string | null,
) {
	const txRows = await db
		.select({
			id: statementTransactions.id,
			date: statementTransactions.postedDate,
			amountMinor: statementTransactions.amountMinor,
			currency: statementTransactions.currency,
			merchantKey: statementTransactions.merchantKey,
			paymentMethodId: statementTransactions.paymentMethodId,
			kind: statementTransactions.kind,
		})
		.from(statementTransactions)
		.where(
			and(
				eq(statementTransactions.ownerId, ownerId),
				inArray(statementTransactions.status, [...OPEN_STATUSES]),
				...(statementImportId
					? [eq(statementTransactions.importId, statementImportId)]
					: []),
			),
		);
	if (!txRows.length)
		return { transactions: 0, suggestions: 0, splits: 0, refunds: 0 };
	const txIds = txRows.map((row) => row.id);

	const dates = txRows.map((row) => row.date).sort();
	const minDate = dates[0] as string;
	const maxDate = dates.at(-1) as string;
	const orderFrom = addDays(
		minDate,
		-Math.max(REFUND_WINDOW_DAYS, SPLIT_WINDOW_DAYS),
	);
	const orderTo = addDays(maxDate, 2);

	const orderRows = await db
		.select({
			id: orders.id,
			date: orders.orderDate,
			totalMinor: orders.totalMinor,
			currency: orders.currency,
			source: orders.source,
			merchantName: orders.merchantName,
			paymentMethodId: orders.paymentMethodId,
			status: orders.status,
		})
		.from(orders)
		.where(
			and(
				eq(orders.ownerId, ownerId),
				ne(orders.reviewState, "ignored"),
				isNotNull(orders.totalMinor),
				isNotNull(orders.orderDate),
				gte(orders.orderDate, orderFrom),
				lte(orders.orderDate, orderTo),
			),
		);
	const orderIds = orderRows.map((row) => row.id);

	const [decided, items] = await Promise.all([
		orderIds.length || txIds.length
			? db
					.select({
						transactionId: transactionMatches.transactionId,
						orderId: transactionMatches.orderId,
						status: transactionMatches.status,
						kind: transactionMatches.kind,
					})
					.from(transactionMatches)
					.where(
						and(
							eq(transactionMatches.ownerId, ownerId),
							inArray(transactionMatches.status, ["confirmed", "rejected"]),
							or(
								inArray(transactionMatches.transactionId, txIds),
								orderIds.length
									? inArray(transactionMatches.orderId, orderIds)
									: sql`false`,
							),
						),
					)
			: Promise.resolve([]),
		orderIds.length
			? db
					.select({
						orderId: orderItems.orderId,
						totalMinor: orderItems.totalMinor,
					})
					.from(orderItems)
					.where(inArray(orderItems.orderId, orderIds))
			: Promise.resolve([]),
	]);
	const rejected = new Set(
		decided
			.filter((row) => row.status === "rejected")
			.map((row) => `${row.transactionId}|${row.orderId}`),
	);
	const ordersWithCharge = new Set(
		decided
			.filter((row) => row.status === "confirmed" && row.kind !== "refund")
			.map((row) => row.orderId),
	);
	const itemTotals = new Map<string, number[]>();
	for (const item of items)
		if (item.totalMinor != null && item.totalMinor > 0)
			itemTotals.set(item.orderId, [
				...(itemTotals.get(item.orderId) ?? []),
				item.totalMinor,
			]);

	const transactions: MatchTransaction[] = txRows.map((row) => ({
		...row,
		currency: row.currency.toUpperCase(),
	}));
	const matchOrders: MatchOrder[] = orderRows.map((row) => ({
		id: row.id,
		date: row.date as string,
		totalMinor: row.totalMinor as number,
		currency: (row.currency ?? "USD").toUpperCase(),
		merchantKey: orderMerchantKey(row.source, row.merchantName),
		paymentMethodId: row.paymentMethodId,
		status: row.status,
		itemTotals: itemTotals.get(row.id) ?? [],
	}));

	const currencies = new Set([
		...transactions.map((tx) => tx.currency),
		...matchOrders.map((order) => order.currency),
	]);
	let convert: Converter | undefined;
	if (currencies.size > 1) {
		try {
			await ensureFxRates(orderFrom, orderTo);
		} catch {
			// Matching still works for same-currency pairs.
		}
		const table = await loadRateTable(orderFrom, orderTo, [...currencies]);
		convert = (amountMinor, from, to, date) => {
			const rate = table.rate(from, to, date);
			return rate
				? convertMinorWithRate(amountMinor, from, to, rate.rate)
				: null;
		};
	}

	const suggestions = matchTransactions({
		transactions,
		orders: matchOrders,
		convert,
		rejected,
		ordersWithCharge,
	});

	await db.transaction(async (tx) => {
		await tx
			.delete(transactionMatches)
			.where(
				and(
					eq(transactionMatches.ownerId, ownerId),
					eq(transactionMatches.status, "suggested"),
					inArray(transactionMatches.transactionId, txIds),
				),
			);
		const values = suggestions.flatMap((suggestion) =>
			suggestion.transactionIds.map((transactionId) => ({
				ownerId,
				transactionId,
				orderId: suggestion.orderId,
				kind: suggestion.kind,
				groupKey:
					suggestion.kind === "split" ? `split:${suggestion.orderId}` : null,
				score: suggestion.score,
				status: "suggested" as const,
				reasons: suggestion.reasons,
			})),
		);
		for (let i = 0; i < values.length; i += 500)
			await tx
				.insert(transactionMatches)
				.values(values.slice(i, i + 500))
				.onConflictDoNothing();
		const suggestedIds = [
			...new Set(values.map((value) => value.transactionId)),
		];
		await tx
			.update(statementTransactions)
			.set({
				status: sql`case when ${statementTransactions.id} in (${
					suggestedIds.length
						? sql.join(
								suggestedIds.map((id) => sql`${id}::uuid`),
								sql`, `,
							)
						: sql`null`
				}) then 'suggested' else 'unmatched' end`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(statementTransactions.ownerId, ownerId),
					inArray(statementTransactions.id, txIds),
					inArray(statementTransactions.status, [...OPEN_STATUSES]),
				),
			);
	});

	return {
		transactions: txRows.length,
		suggestions: suggestions.length,
		splits: suggestions.filter((s) => s.kind === "split").length,
		refunds: suggestions.filter((s) => s.kind === "refund").length,
	};
}

/* ───────────────────────── decisions ───────────────────────── */

async function ownedMatch(ownerId: string, matchId: string) {
	const [row] = await db
		.select()
		.from(transactionMatches)
		.where(
			and(
				eq(transactionMatches.id, matchId),
				eq(transactionMatches.ownerId, ownerId),
			),
		);
	if (!row) throw new Error("NOT_FOUND");
	return row;
}

/** Recomputes the open/matched status of transactions from their matches. */
async function refreshTransactionStatus(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	ownerId: string,
	transactionIds: string[],
) {
	if (!transactionIds.length) return;
	await tx
		.update(statementTransactions)
		.set({
			status: sql`case
				when exists (select 1 from ${transactionMatches} m where m.transaction_id = ${statementTransactions.id} and m.status = 'confirmed') then 'matched'
				when exists (select 1 from ${transactionMatches} m where m.transaction_id = ${statementTransactions.id} and m.status = 'suggested') then 'suggested'
				else 'unmatched' end`,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(statementTransactions.ownerId, ownerId),
				inArray(statementTransactions.id, transactionIds),
				ne(statementTransactions.status, "ignored"),
			),
		);
}

export async function confirmMatchesForOwner(
	ownerId: string,
	matchIds: string[],
) {
	let confirmed = 0;
	for (const matchId of matchIds) {
		const match = await ownedMatch(ownerId, matchId).catch(() => null);
		if (!match || match.status !== "suggested") continue;
		await db.transaction(async (tx) => {
			const group = match.groupKey
				? await tx
						.select({
							id: transactionMatches.id,
							transactionId: transactionMatches.transactionId,
						})
						.from(transactionMatches)
						.where(
							and(
								eq(transactionMatches.ownerId, ownerId),
								eq(transactionMatches.groupKey, match.groupKey),
								eq(transactionMatches.orderId, match.orderId),
								eq(transactionMatches.status, "suggested"),
							),
						)
				: [{ id: match.id, transactionId: match.transactionId }];
			const transactionIds = group.map((row) => row.transactionId);
			await tx
				.update(transactionMatches)
				.set({ status: "confirmed", decidedAt: new Date() })
				.where(
					inArray(
						transactionMatches.id,
						group.map((row) => row.id),
					),
				);
			// The transactions are spoken for; other suggestions for them go away.
			await tx
				.delete(transactionMatches)
				.where(
					and(
						eq(transactionMatches.ownerId, ownerId),
						eq(transactionMatches.status, "suggested"),
						inArray(transactionMatches.transactionId, transactionIds),
					),
				);
			// The order's charge is found; competing charge suggestions go away.
			const others =
				match.kind === "refund"
					? []
					: await tx
							.delete(transactionMatches)
							.where(
								and(
									eq(transactionMatches.ownerId, ownerId),
									eq(transactionMatches.status, "suggested"),
									eq(transactionMatches.orderId, match.orderId),
									ne(transactionMatches.kind, "refund"),
								),
							)
							.returning({ transactionId: transactionMatches.transactionId });
			await refreshTransactionStatus(tx, ownerId, [
				...transactionIds,
				...others.map((row) => row.transactionId),
			]);
			confirmed += group.length;
		});
	}
	return { confirmed };
}

/** Confirms every suggestion at or above `minScore`. */
export async function confirmAllAboveForOwner(
	ownerId: string,
	minScore: number,
) {
	const rows = await db
		.select({ id: transactionMatches.id })
		.from(transactionMatches)
		.where(
			and(
				eq(transactionMatches.ownerId, ownerId),
				eq(transactionMatches.status, "suggested"),
				gte(transactionMatches.score, minScore),
			),
		)
		.orderBy(desc(transactionMatches.score));
	return confirmMatchesForOwner(
		ownerId,
		rows.map((row) => row.id),
	);
}

export async function rejectMatchForOwner(ownerId: string, matchId: string) {
	const match = await ownedMatch(ownerId, matchId);
	await db.transaction(async (tx) => {
		const updated = await tx
			.update(transactionMatches)
			.set({ status: "rejected", decidedAt: new Date() })
			.where(
				and(
					eq(transactionMatches.ownerId, ownerId),
					match.groupKey
						? and(
								eq(transactionMatches.groupKey, match.groupKey),
								eq(transactionMatches.orderId, match.orderId),
							)
						: eq(transactionMatches.id, match.id),
				),
			)
			.returning({ transactionId: transactionMatches.transactionId });
		await refreshTransactionStatus(
			tx,
			ownerId,
			updated.map((row) => row.transactionId),
		);
	});
	return { ok: true };
}

/** Undo: drops confirmed matches of a transaction and reopens it. */
export async function unmatchTransactionForOwner(
	ownerId: string,
	transactionId: string,
) {
	await db.transaction(async (tx) => {
		await tx
			.delete(transactionMatches)
			.where(
				and(
					eq(transactionMatches.ownerId, ownerId),
					eq(transactionMatches.transactionId, transactionId),
					inArray(transactionMatches.status, ["confirmed", "suggested"]),
				),
			);
		await tx
			.update(statementTransactions)
			.set({ status: "unmatched", updatedAt: new Date() })
			.where(
				and(
					eq(statementTransactions.ownerId, ownerId),
					eq(statementTransactions.id, transactionId),
				),
			);
	});
	return runReconciliation(ownerId);
}

/** "Not a purchase" (ignored) or back to open. */
export async function setTransactionsIgnoredForOwner(
	ownerId: string,
	input: { transactionIds: string[]; ignored: boolean },
) {
	await db.transaction(async (tx) => {
		if (input.ignored)
			await tx
				.delete(transactionMatches)
				.where(
					and(
						eq(transactionMatches.ownerId, ownerId),
						eq(transactionMatches.status, "suggested"),
						inArray(transactionMatches.transactionId, input.transactionIds),
					),
				);
		await tx
			.update(statementTransactions)
			.set({
				status: input.ignored ? "ignored" : "unmatched",
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(statementTransactions.ownerId, ownerId),
					inArray(statementTransactions.id, input.transactionIds),
				),
			);
	});
	if (!input.ignored) await runReconciliation(ownerId);
	return { updated: input.transactionIds.length };
}

/** One click: manual order from a charge, confirmed as its match. */
export async function createOrderFromTransactionForOwner(
	ownerId: string,
	input: {
		transactionId: string;
		entityId?: string | null;
		categoryId?: string | null;
	},
) {
	const [txn] = await db
		.select()
		.from(statementTransactions)
		.where(
			and(
				eq(statementTransactions.id, input.transactionId),
				eq(statementTransactions.ownerId, ownerId),
			),
		);
	if (!txn) throw new Error("NOT_FOUND");
	if (txn.amountMinor <= 0)
		throw new Error(
			"Only charges can become orders; mark credits as not a purchase or match them to a refund.",
		);
	const merchant = normalizeMerchant(txn.description);
	const total = minorToDecimal(txn.amountMinor, txn.currency);
	const created = await createManualOrderForOwner(ownerId, {
		merchantName: (merchant.label || txn.description).slice(0, 200),
		externalOrderId: `STMT-${txn.id.slice(0, 8).toUpperCase()}`,
		orderDate: txn.postedDate,
		currency: txn.currency.toUpperCase(),
		total,
		entityId: input.entityId ?? null,
		categoryId: input.categoryId ?? null,
		paymentMethodId: txn.paymentMethodId,
		notes: `Created from statement transaction "${txn.description}" (${txn.postedDate}).`,
		items: [{ title: txn.description.slice(0, 500), quantity: 1, total }],
	});
	await db.transaction(async (tx) => {
		// The manual-order helper assumes 2-decimal currencies.
		if (minorDigits(txn.currency) !== 2) {
			await tx
				.update(orders)
				.set({ totalMinor: txn.amountMinor })
				.where(eq(orders.id, created.id));
			await tx
				.update(orderItems)
				.set({ totalMinor: txn.amountMinor })
				.where(eq(orderItems.orderId, created.id));
			await recomputeAllocations(tx, created.id);
		}
		await tx
			.delete(transactionMatches)
			.where(
				and(
					eq(transactionMatches.ownerId, ownerId),
					eq(transactionMatches.transactionId, txn.id),
					eq(transactionMatches.status, "suggested"),
				),
			);
		await tx.insert(transactionMatches).values({
			ownerId,
			transactionId: txn.id,
			orderId: created.id,
			kind: "manual",
			score: 1,
			status: "confirmed",
			reasons: ["order created from transaction"],
			decidedAt: new Date(),
		});
		await tx
			.update(statementTransactions)
			.set({ status: "matched", updatedAt: new Date() })
			.where(eq(statementTransactions.id, txn.id));
	});
	return { orderId: created.id };
}

/* ───────────────────────── page data ───────────────────────── */

export async function getReconcileDataForOwner(
	ownerId: string,
	input: { paymentMethodId?: string | null } = {},
) {
	const cardFilter = input.paymentMethodId
		? [eq(statementTransactions.paymentMethodId, input.paymentMethodId)]
		: [];
	const txBase = [eq(statementTransactions.ownerId, ownerId), ...cardFilter];

	const [imports, cards, perCard, suggested, unmatched, ignored] =
		await Promise.all([
			db
				.select()
				.from(statementImports)
				.where(eq(statementImports.ownerId, ownerId))
				.orderBy(desc(statementImports.createdAt))
				.limit(50),
			db
				.select({
					id: paymentMethods.id,
					label: paymentMethods.label,
					brand: paymentMethods.brand,
					last4: paymentMethods.last4,
					payingEntityId: paymentMethods.payingEntityId,
				})
				.from(paymentMethods)
				.where(eq(paymentMethods.ownerId, ownerId)),
			db
				.select({
					paymentMethodId: statementTransactions.paymentMethodId,
					currency: statementTransactions.currency,
					charges:
						sql<number>`count(*) filter (where ${statementTransactions.kind} = 'charge' and ${statementTransactions.amountMinor} > 0)`.mapWith(
							Number,
						),
					matched:
						sql<number>`count(*) filter (where ${statementTransactions.kind} = 'charge' and ${statementTransactions.amountMinor} > 0 and ${statementTransactions.status} = 'matched')`.mapWith(
							Number,
						),
					ignored:
						sql<number>`count(*) filter (where ${statementTransactions.kind} = 'charge' and ${statementTransactions.amountMinor} > 0 and ${statementTransactions.status} = 'ignored')`.mapWith(
							Number,
						),
					suggested:
						sql<number>`count(*) filter (where ${statementTransactions.status} = 'suggested')`.mapWith(
							Number,
						),
					unmatched:
						sql<number>`count(*) filter (where ${statementTransactions.status} = 'unmatched')`.mapWith(
							Number,
						),
					chargeMinor:
						sql<number>`coalesce(sum(${statementTransactions.amountMinor}) filter (where ${statementTransactions.kind} = 'charge' and ${statementTransactions.amountMinor} > 0), 0)::bigint`.mapWith(
							Number,
						),
					matchedMinor:
						sql<number>`coalesce(sum(${statementTransactions.amountMinor}) filter (where ${statementTransactions.kind} = 'charge' and ${statementTransactions.amountMinor} > 0 and ${statementTransactions.status} = 'matched'), 0)::bigint`.mapWith(
							Number,
						),
					minDate: sql<string | null>`min(${statementTransactions.postedDate})`,
					maxDate: sql<string | null>`max(${statementTransactions.postedDate})`,
				})
				.from(statementTransactions)
				.where(eq(statementTransactions.ownerId, ownerId))
				.groupBy(
					statementTransactions.paymentMethodId,
					statementTransactions.currency,
				),
			db
				.select({
					id: transactionMatches.id,
					kind: transactionMatches.kind,
					groupKey: transactionMatches.groupKey,
					score: transactionMatches.score,
					reasons: transactionMatches.reasons,
					transactionId: statementTransactions.id,
					txDate: statementTransactions.postedDate,
					txDescription: statementTransactions.description,
					txAmountMinor: statementTransactions.amountMinor,
					txCurrency: statementTransactions.currency,
					txPaymentMethodId: statementTransactions.paymentMethodId,
					orderId: orders.id,
					orderSource: orders.source,
					orderExternalId: orders.externalOrderId,
					orderMerchant: orders.merchantName,
					orderDate: orders.orderDate,
					orderTotalMinor: orders.totalMinor,
					orderCurrency: orders.currency,
					orderEntityId: orders.entityId,
					orderStatus: orders.status,
				})
				.from(transactionMatches)
				.innerJoin(
					statementTransactions,
					eq(statementTransactions.id, transactionMatches.transactionId),
				)
				.innerJoin(orders, eq(orders.id, transactionMatches.orderId))
				.where(
					and(
						eq(transactionMatches.ownerId, ownerId),
						eq(transactionMatches.status, "suggested"),
						...cardFilter,
					),
				)
				.orderBy(
					desc(transactionMatches.score),
					asc(statementTransactions.postedDate),
				)
				.limit(300),
			db
				.select({
					id: statementTransactions.id,
					date: statementTransactions.postedDate,
					description: statementTransactions.description,
					merchantKey: statementTransactions.merchantKey,
					amountMinor: statementTransactions.amountMinor,
					currency: statementTransactions.currency,
					kind: statementTransactions.kind,
					paymentMethodId: statementTransactions.paymentMethodId,
				})
				.from(statementTransactions)
				.where(and(...txBase, eq(statementTransactions.status, "unmatched")))
				.orderBy(desc(statementTransactions.postedDate))
				.limit(300),
			db
				.select({
					id: statementTransactions.id,
					date: statementTransactions.postedDate,
					description: statementTransactions.description,
					amountMinor: statementTransactions.amountMinor,
					currency: statementTransactions.currency,
					kind: statementTransactions.kind,
					paymentMethodId: statementTransactions.paymentMethodId,
				})
				.from(statementTransactions)
				.where(and(...txBase, eq(statementTransactions.status, "ignored")))
				.orderBy(desc(statementTransactions.postedDate))
				.limit(100),
		]);

	/* Orders with no charge found: within each card's statement coverage. */
	const coverage = perCard.filter((row) => row.minDate && row.maxDate);
	const covered = coverage
		.filter(
			(row) =>
				!input.paymentMethodId || row.paymentMethodId === input.paymentMethodId,
		)
		.map((row) => ({
			paymentMethodId: row.paymentMethodId,
			from: row.minDate as string,
			// Charges post a few days after the order.
			to: addDays(row.maxDate as string, -3),
		}))
		.filter((row) => row.from <= row.to);
	const knownCards = covered.filter((row) => row.paymentMethodId);
	const overall = covered.length
		? {
				from: covered.map((row) => row.from).sort()[0] as string,
				to: covered
					.map((row) => row.to)
					.sort()
					.at(-1) as string,
			}
		: null;
	const missingConditions = [
		...knownCards.map((row) =>
			and(
				eq(orders.paymentMethodId, row.paymentMethodId as string),
				gte(orders.orderDate, row.from),
				lte(orders.orderDate, row.to),
			),
		),
		...(overall && !input.paymentMethodId
			? [
					and(
						sql`${orders.paymentMethodId} is null`,
						gte(orders.orderDate, overall.from),
						lte(orders.orderDate, overall.to),
					),
				]
			: []),
	];
	const missing = missingConditions.length
		? await db
				.select({
					id: orders.id,
					source: orders.source,
					externalOrderId: orders.externalOrderId,
					merchantName: orders.merchantName,
					orderDate: orders.orderDate,
					totalMinor: orders.totalMinor,
					currency: orders.currency,
					entityId: orders.entityId,
					paymentMethodId: orders.paymentMethodId,
					status: orders.status,
				})
				.from(orders)
				.where(
					and(
						eq(orders.ownerId, ownerId),
						ne(orders.reviewState, "ignored"),
						ne(orders.status, "cancelled"),
						sql`coalesce(${orders.totalMinor}, 0) > 0`,
						or(...missingConditions),
						notExists(
							db
								.select({ one: sql`1` })
								.from(transactionMatches)
								.where(
									and(
										eq(transactionMatches.orderId, orders.id),
										inArray(transactionMatches.status, [
											"suggested",
											"confirmed",
										]),
										ne(transactionMatches.kind, "refund"),
									),
								),
						),
					),
				)
				.orderBy(desc(orders.orderDate))
				.limit(200)
		: [];

	const cardById = new Map(cards.map((card) => [card.id, card]));
	const completeness = perCard.map((row) => {
		const denominator = row.charges - row.ignored;
		return {
			...row,
			card: row.paymentMethodId
				? (cardById.get(row.paymentMethodId) ?? null)
				: null,
			percent:
				denominator > 0
					? Math.round((row.matched / denominator) * 1000) / 10
					: null,
		};
	});

	const confirmed = await db
		.select({
			id: transactionMatches.id,
			kind: transactionMatches.kind,
			decidedAt: transactionMatches.decidedAt,
			transactionId: statementTransactions.id,
			txDate: statementTransactions.postedDate,
			txDescription: statementTransactions.description,
			txAmountMinor: statementTransactions.amountMinor,
			txCurrency: statementTransactions.currency,
			orderId: orders.id,
			orderSource: orders.source,
			orderExternalId: orders.externalOrderId,
		})
		.from(transactionMatches)
		.innerJoin(
			statementTransactions,
			eq(statementTransactions.id, transactionMatches.transactionId),
		)
		.innerJoin(orders, eq(orders.id, transactionMatches.orderId))
		.where(
			and(
				eq(transactionMatches.ownerId, ownerId),
				eq(transactionMatches.status, "confirmed"),
				...cardFilter,
			),
		)
		.orderBy(desc(transactionMatches.decidedAt))
		.limit(100);

	const entityRows = await db
		.select({ id: entities.id })
		.from(entities)
		.where(eq(entities.ownerId, ownerId));

	return {
		imports: imports.map((row) => ({
			...row,
			createdAt: row.createdAt.toISOString(),
		})),
		completeness,
		suggested: suggested.map((row) => ({
			...row,
			reasons: row.reasons ?? [],
		})),
		unmatched,
		ignored,
		confirmed: confirmed.map((row) => ({
			...row,
			decidedAt: row.decidedAt?.toISOString() ?? null,
		})),
		missingCharges: missing,
		coverage: overall,
		hasEntities: entityRows.length > 0,
	};
}

export type ReconcileData = Awaited<
	ReturnType<typeof getReconcileDataForOwner>
>;
