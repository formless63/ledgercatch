/**
 * Job `imports.process {importId}`: read the stored spreadsheet, group rows
 * into orders with the saved mapping and create one capture per order
 * (channel "import", kind "import_row"). Parsing/merging then happens in the
 * normal captures.process pipeline.
 *
 * Idempotency: sourceRef = hash(source, pageUrl, order content), so importing
 * the same file twice creates no new captures.
 *
 * Generic imports (source "generic", e.g. PayPal or "other store" files):
 * process.server namespaces generic order ids by the host of orderUrl or the
 * capture pageUrl. Import captures therefore use pageUrl
 * `import://<merchant-slug>` so "#1001" from two merchants never merges
 * (stored key `<merchant-slug>:1001`) unless the row has its own http(s)
 * order URL, whose host is used instead.
 */
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { genericOrderKey } from "#/features/ledger/process.server";
import { orders } from "#/features/ledger/schema";
import { createServerCapture } from "../captures.server";
import { imports } from "../schema";
import { loadImportBytes, MAX_IMPORT_ROWS, parseMapping } from "./files.server";
import { importSourceRef } from "./keys.server";
import { readSpreadsheet, splitHeader } from "./read.server";
import { buildOrders, merchantSlug } from "./transform";
import type { ImportPreview, ImportStats } from "./types";

export function importPageUrl(source: string, merchantName?: string) {
	return source === "generic"
		? `import://${merchantSlug(merchantName)}`
		: `import://${source}`;
}

export async function processImport(importId: string) {
	const [row] = await db.select().from(imports).where(eq(imports.id, importId));
	if (!row) return { skipped: "missing" };
	// Retries after a crash simply run again: captures are idempotent.
	const fail = async (message: string) => {
		await db
			.update(imports)
			.set({
				status: "failed",
				error: message.slice(0, 2000),
				finishedAt: new Date(),
			})
			.where(eq(imports.id, importId));
		return { failed: message };
	};
	const mapping = parseMapping(row.mapping);
	if (!mapping) return fail("No valid column mapping saved");
	if (!row.documentId) return fail("The uploaded file is no longer stored");
	await db
		.update(imports)
		.set({ status: "processing", error: null, finishedAt: null })
		.where(eq(imports.id, importId));

	try {
		const preview = (row.preview ?? {}) as Partial<ImportPreview>;
		const bytes = await loadImportBytes(row.ownerId, row.documentId);
		const read = await readSpreadsheet(bytes, row.fileName, {
			sheet: preview.sheet ?? null,
			maxRows: MAX_IMPORT_ROWS + (preview.headerRow ?? 0) + 1,
		});
		const { headerRow, headers, data } = splitHeader(
			read.rows,
			preview.headerRow,
		);
		const result = buildOrders({
			headers,
			rows: data.slice(0, MAX_IMPORT_ROWS),
			mapping,
			fileName: row.fileName,
			firstRowNumber: headerRow + 2,
			maxErrors: 100,
		});
		const errors = [...result.errors];
		const stats: ImportStats = {
			orders: result.orders.length,
			newCaptures: 0,
			unchanged: 0,
			skippedRows: result.skippedRows,
			errorRows: result.errorRows,
		};
		let ordersCreated = 0;
		let ordersUpdated = 0;
		for (const imported of result.orders) {
			const { order } = imported;
			const pageUrl = importPageUrl(mapping.source, order.merchantName);
			const storedId =
				mapping.source === "generic"
					? genericOrderKey(order.orderUrl ?? pageUrl, order.externalOrderId)
					: order.externalOrderId;
			try {
				const [existing] = await db
					.select({ id: orders.id })
					.from(orders)
					.where(
						and(
							eq(orders.ownerId, row.ownerId),
							eq(orders.source, mapping.source),
							eq(orders.externalOrderId, storedId),
						),
					)
					.limit(1);
				const { created } = await createServerCapture({
					ownerId: row.ownerId,
					channel: "import",
					kind: "import_row",
					sourceRef: importSourceRef(mapping.source, pageUrl, order),
					source: mapping.source,
					pageType: "order_detail",
					pageUrl,
					pageTitle: row.fileName,
					bodyJson: { importId, order },
					documentId: row.documentId,
					note: `Import ${row.fileName} rows ${imported.rows.slice(0, 5).join(", ")}${imported.rows.length > 5 ? "…" : ""}`,
					orderIdHints: [order.externalOrderId],
				});
				if (!created) stats.unchanged++;
				else {
					stats.newCaptures++;
					if (existing) ordersUpdated++;
					else ordersCreated++;
				}
				if (order.orderDate) {
					if (!stats.minDate || order.orderDate < stats.minDate)
						stats.minDate = order.orderDate;
					if (!stats.maxDate || order.orderDate > stats.maxDate)
						stats.maxDate = order.orderDate;
				}
			} catch (error) {
				stats.errorRows++;
				if (errors.length < 100)
					errors.push({
						row: imported.rows[0] ?? 0,
						message: `Order ${order.externalOrderId}: ${error instanceof Error ? error.message : String(error)}`,
					});
			}
		}
		await db
			.update(imports)
			.set({
				status: "done",
				rowCount: result.dataRows,
				ordersCreated,
				ordersUpdated,
				finishedAt: new Date(),
				error: read.truncated
					? `Only the first ${MAX_IMPORT_ROWS.toLocaleString("en")} rows were imported`
					: null,
				preview: { ...preview, errors, stats },
			})
			.where(eq(imports.id, importId));
		return { orders: result.orders.length, ordersCreated, ordersUpdated };
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}
