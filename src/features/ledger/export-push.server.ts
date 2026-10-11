/** Worker-side export push (no request/session imports). */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { decryptSecret } from "#/features/connectors/crypto.server";
import { buildContext, getProvider } from "#/features/connectors/registry";
import {
	type ConnectorProviderId,
	type ExpenseDocument,
	errorMessage,
	isConnectorError,
	minorToDecimalString,
	resolveMapping,
} from "#/features/connectors/types";
import { readDocumentBytes } from "./documents.server";
import { audit } from "./orders.server";
import { emitExportEvent } from "./outbound.server";
import {
	allocations,
	categories,
	connections,
	documents,
	exports,
	orderItems,
	orders,
} from "./schema";

export function contextFor(row: typeof connections.$inferSelect) {
	const provider = getProvider(row.provider as ConnectorProviderId);
	if (!provider)
		throw new Error(
			"Unsupported connection provider; retire this connection before exporting",
		);
	const secret = row.secretCiphertext
		? decryptSecret(row.secretCiphertext)
		: {};
	return { provider, ctx: buildContext(provider, row.config, secret) };
}

/** Job handler: push one allocation to one connection. */
export async function pushExport(
	exportId: string,
	skipFuzzyDuplicateCheck: boolean,
) {
	const [row] = await db
		.select({
			export: exports,
			connection: connections,
			allocation: allocations,
			order: orders,
		})
		.from(exports)
		.innerJoin(connections, eq(connections.id, exports.connectionId))
		.innerJoin(allocations, eq(allocations.id, exports.allocationId))
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.where(eq(exports.id, exportId));
	if (!row) return { skipped: "missing" };
	if (
		!row.connection.enabled ||
		row.connection.ownerId !== row.order.ownerId ||
		row.connection.entityId !== row.allocation.entityId
	)
		return { skipped: "disabled or mismatched connection" };
	if (row.export.status === "sent") return { skipped: "already sent" };
	const { connection, allocation, order } = row;
	if (!allocation || !order) return { skipped: "allocation removed" };
	await db
		.update(exports)
		.set({
			status: "sending",
			attempts: row.export.attempts + 1,
			startedAt: new Date(),
		})
		.where(eq(exports.id, exportId));

	try {
		const { provider, ctx } = contextFor(connection);
		const items = await db
			.select({
				title: orderItems.title,
				quantity: orderItems.quantity,
				entityId: orderItems.entityId,
			})
			.from(orderItems)
			.where(eq(orderItems.orderId, order.id));
		const ownItems = items.filter(
			(item) => (item.entityId ?? order.entityId) === allocation.entityId,
		);
		const docs = await db
			.select()
			.from(documents)
			.where(
				and(
					eq(documents.orderId, order.id),
					inArray(documents.kind, ["invoice", "receipt"]),
				),
			);
		const category = allocation.categoryId
			? (
					await db
						.select({ name: categories.name })
						.from(categories)
						.where(
							and(
								eq(categories.id, allocation.categoryId),
								eq(categories.ownerId, order.ownerId),
							),
						)
				)[0]
			: undefined;
		const mapping = resolveMapping(connection.config as never, {
			categoryId: allocation.categoryId,
			paymentMethodId: order.paymentMethodId,
		});
		const orderRef = `${order.source} ${order.externalOrderId}`;
		const isSplit =
			allocation.amountMinor !== (order.totalMinor ?? allocation.amountMinor);
		const money = {
			amount: minorToDecimalString(allocation.amountMinor, allocation.currency),
			currency: allocation.currency,
			memo: null,
		};
		const payloadDocuments: ExpenseDocument[] = docs.map((doc) => ({
			fileName: doc.fileName,
			contentType: doc.contentType,
			sizeBytes: doc.sizeBytes,
			sha256: doc.sha256,
			kind: doc.kind,
			load: () => readDocumentBytes(doc.storageKey),
		}));
		const result = await provider.pushExpense(
			ctx,
			{
				reference:
					connection.provider === "custom_http"
						? `LC-${allocation.id}`
						: `OT-${allocation.id.slice(0, 8)}`,
				orderRef,
				date: order.orderDate ?? order.firstSeenAt.toISOString().slice(0, 10),
				vendorName: order.merchantName || order.source,
				amount: money.amount,
				currency: money.currency,
				memo: [
					`Order ${orderRef}`,
					money.memo,
					category ? `Category: ${category.name}` : null,
					isSplit ? "Split allocation" : null,
					allocation.reimbursable ? "Paid personally — reimbursable" : null,
				]
					.filter(Boolean)
					.join(" · "),
				expenseAccountId: mapping.expenseAccountId,
				paymentAccountId: mapping.paymentAccountId,
				reimbursable: allocation.reimbursable,
				lineSummary: ownItems
					.map((item) => `${item.quantity} × ${item.title}`)
					.slice(0, 30),
				documents: payloadDocuments,
			},
			{ skipFuzzyDuplicateCheck },
		);
		const sent =
			result.status === "created" || ("exact" in result && result.exact);
		await db
			.update(exports)
			.set({
				status: sent ? "sent" : "skipped",
				remoteId: result.remoteId ?? null,
				remoteUrl: result.remoteUrl ?? null,
				error:
					result.status === "duplicate"
						? `Possible duplicate: ${result.reason}`
						: result.warnings.length
							? result.warnings.join("; ")
							: null,
				sentAt: sent ? new Date() : null,
			})
			.where(eq(exports.id, exportId));
		await db.transaction((tx) =>
			audit(tx, { type: "system", id: "exports" }, "order.exported", order.id, {
				connection: connection.name,
				status: result.status,
				remoteId: result.remoteId ?? null,
			}),
		);
		void emitExportEvent(exportId);
		return { status: result.status };
	} catch (error) {
		const retryable = isConnectorError(error) && error.retryable;
		await db
			.update(exports)
			.set({
				status: retryable ? "queued" : "failed",
				error: errorMessage(error).slice(0, 2000),
			})
			.where(eq(exports.id, exportId));
		if (!retryable) void emitExportEvent(exportId);
		if (retryable) throw error;
		return { failed: errorMessage(error) };
	}
}
