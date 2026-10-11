/**
 * Statement upload: bytes → StatementRows (reusing the spreadsheet reader's
 * encoding / delimiter / XLSX handling) → idempotent insert → reconcile.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import {
	decodeText,
	ImportFileError,
	readSpreadsheet,
	splitHeader,
} from "#/features/ingress/imports/read.server";
import { paymentMethods } from "#/features/ledger/schema";
import { normalizeMerchant } from "./merchant";
import { runReconciliation } from "./reconcile.server";
import { statementImports, statementTransactions } from "./schema";
import {
	looksLikeOfx,
	looksLikeQif,
	parseOfx,
	parseQif,
	parseStatementRows,
	type StatementParseOptions,
	type StatementParseResult,
	transactionIdentities,
} from "./statements";

export const MAX_STATEMENT_BYTES = 10 * 1024 * 1024;
export const MAX_STATEMENT_ROWS = 20_000;
export const STATEMENT_EXTENSIONS =
	/\.(csv|tsv|txt|xlsx|xlsm|xls|ofx|qfx|qbo|qif)$/i;

export { ImportFileError as StatementFileError };

export async function readStatementFile(
	bytes: Uint8Array,
	fileName: string,
	options: StatementParseOptions,
): Promise<StatementParseResult> {
	if (!bytes.byteLength) throw new ImportFileError("The file is empty");
	if (bytes.byteLength > MAX_STATEMENT_BYTES)
		throw new ImportFileError("File too large (max 10 MB)");
	const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
	if (!isZip) {
		const text = decodeText(bytes);
		if (/\.(ofx|qfx|qbo)$/i.test(fileName) || looksLikeOfx(text))
			return parseOfx(text, options);
		if (/\.qif$/i.test(fileName) || looksLikeQif(text))
			return parseQif(text, options);
	}
	const read = await readSpreadsheet(bytes, fileName, {
		maxRows: MAX_STATEMENT_ROWS + 25,
	});
	if (!read.rows.length) throw new ImportFileError("No rows found in the file");
	const { headerRow, headers, data } = splitHeader(read.rows);
	return parseStatementRows(headers, data.slice(0, MAX_STATEMENT_ROWS), {
		...options,
		format: read.format,
		firstRowNumber: headerRow + 2,
	});
}

const sha256 = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");

async function ownedPaymentMethod(ownerId: string, id: string) {
	const [row] = await db
		.select({ id: paymentMethods.id })
		.from(paymentMethods)
		.where(and(eq(paymentMethods.id, id), eq(paymentMethods.ownerId, ownerId)));
	if (!row) throw new Error("Unknown payment method");
	return row.id;
}

/** Card whose last4 matches the account hint, when exactly one does. */
async function paymentMethodForHint(ownerId: string, hint: string | null) {
	if (!hint) return null;
	const rows = await db
		.select({ id: paymentMethods.id })
		.from(paymentMethods)
		.where(
			and(eq(paymentMethods.ownerId, ownerId), eq(paymentMethods.last4, hint)),
		);
	return rows.length === 1 ? (rows[0]?.id ?? null) : null;
}

export type StatementInput = StatementParseOptions & {
	fileName: string;
	bytes: Uint8Array;
	paymentMethodId?: string | null;
};

function accountKey(paymentMethodId: string | null, hint: string | null) {
	return paymentMethodId ?? (hint ? `acct:${hint}` : "unknown");
}

export async function previewStatementForOwner(
	ownerId: string,
	input: StatementInput,
) {
	const parsed = await readStatementFile(input.bytes, input.fileName, input);
	const suggestedPaymentMethodId = input.paymentMethodId
		? await ownedPaymentMethod(ownerId, input.paymentMethodId)
		: await paymentMethodForHint(ownerId, parsed.accountHint);
	const hashes = transactionIdentities(
		parsed.rows,
		accountKey(suggestedPaymentMethodId, parsed.accountHint),
	).map(sha256);
	let duplicates = 0;
	for (let i = 0; i < hashes.length; i += 1000) {
		const chunk = hashes.slice(i, i + 1000);
		if (!chunk.length) continue;
		const found = await db
			.select({ hash: statementTransactions.hash })
			.from(statementTransactions)
			.where(
				and(
					eq(statementTransactions.ownerId, ownerId),
					inArray(statementTransactions.hash, chunk),
				),
			);
		duplicates += found.length;
	}
	const dates = parsed.rows.map((row) => row.date).sort();
	const charges = parsed.rows.filter((row) => row.kind === "charge");
	return {
		format: parsed.format,
		presetId: parsed.presetId,
		presetLabel: parsed.presetLabel,
		signConvention: parsed.signConvention,
		accountHint: parsed.accountHint,
		currency: parsed.currency,
		suggestedPaymentMethodId,
		rowCount: parsed.rows.length,
		chargeCount: charges.length,
		chargeTotalMinor: charges.reduce((sum, row) => sum + row.amountMinor, 0),
		creditCount: parsed.rows.filter((row) => row.kind === "credit").length,
		paymentCount: parsed.rows.filter((row) => row.kind === "payment").length,
		duplicates,
		skipped: parsed.skipped,
		errors: parsed.errors.slice(0, 20),
		minDate: dates[0] ?? null,
		maxDate: dates.at(-1) ?? null,
		sample: parsed.rows.slice(0, 25).map((row) => ({
			date: row.date,
			description: row.description,
			merchant: normalizeMerchant(row.description).label,
			amountMinor: row.amountMinor,
			currency: row.currency,
			kind: row.kind,
		})),
	};
}

export async function importStatementForOwner(
	ownerId: string,
	input: StatementInput,
) {
	const parsed = await readStatementFile(input.bytes, input.fileName, input);
	if (!parsed.rows.length)
		throw new ImportFileError(
			parsed.errors[0]?.message ?? "No transactions found in the file",
		);
	const paymentMethodId = input.paymentMethodId
		? await ownedPaymentMethod(ownerId, input.paymentMethodId)
		: await paymentMethodForHint(ownerId, parsed.accountHint);
	const identities = transactionIdentities(
		parsed.rows,
		accountKey(paymentMethodId, parsed.accountHint),
	);
	const dates = parsed.rows.map((row) => row.date).sort();
	const result = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(statementImports)
			.values({
				ownerId,
				fileName: input.fileName.slice(0, 250),
				format: parsed.format,
				presetId: parsed.presetId,
				paymentMethodId,
				accountHint: parsed.accountHint,
				sha256: sha256(input.bytes),
				rowCount: parsed.rows.length,
				minDate: dates[0] ?? null,
				maxDate: dates.at(-1) ?? null,
			})
			.returning({ id: statementImports.id });
		if (!created) throw new Error("Insert failed");
		const values = parsed.rows.map((row, index) => ({
			ownerId,
			importId: created.id,
			paymentMethodId,
			postedDate: row.date,
			description: row.description.slice(0, 500),
			merchantKey: normalizeMerchant(row.description).key,
			amountMinor: row.amountMinor,
			currency: row.currency,
			kind: row.kind,
			// Card payments and fees are not purchases.
			status:
				row.kind === "payment" || row.kind === "fee"
					? ("ignored" as const)
					: ("unmatched" as const),
			externalId: row.externalId ?? null,
			raw: row.raw,
			hash: sha256(identities[index] ?? `${index}`),
		}));
		let inserted = 0;
		for (let i = 0; i < values.length; i += 500) {
			const rows = await tx
				.insert(statementTransactions)
				.values(values.slice(i, i + 500))
				.onConflictDoNothing({
					target: [statementTransactions.ownerId, statementTransactions.hash],
				})
				.returning({ id: statementTransactions.id });
			inserted += rows.length;
		}
		await tx
			.update(statementImports)
			.set({
				insertedCount: inserted,
				duplicateCount: values.length - inserted,
			})
			.where(eq(statementImports.id, created.id));
		return {
			importId: created.id,
			inserted,
			duplicates: values.length - inserted,
		};
	});
	const reconciliation = await runReconciliation(ownerId, result.importId);
	return {
		...result,
		rows: parsed.rows.length,
		errors: parsed.errors.length,
		paymentMethodId,
		reconciliation,
	};
}

export async function deleteStatementImportForOwner(
	ownerId: string,
	importId: string,
) {
	return db.transaction(async (tx) => {
		const [owned] = await tx
			.select({ id: statementImports.id })
			.from(statementImports)
			.where(
				and(
					eq(statementImports.id, importId),
					eq(statementImports.ownerId, ownerId),
				),
			);
		if (!owned) throw new Error("NOT_FOUND");
		const removed = await tx
			.delete(statementTransactions)
			.where(
				and(
					eq(statementTransactions.ownerId, ownerId),
					eq(statementTransactions.importId, importId),
				),
			)
			.returning({ id: statementTransactions.id });
		await tx.delete(statementImports).where(eq(statementImports.id, importId));
		return { removed: removed.length };
	});
}

/** Re-point an import (and its transactions) at a card. */
export async function setStatementCardForOwner(
	ownerId: string,
	input: { importId: string; paymentMethodId: string | null },
) {
	const paymentMethodId = input.paymentMethodId
		? await ownedPaymentMethod(ownerId, input.paymentMethodId)
		: null;
	await db.transaction(async (tx) => {
		const updated = await tx
			.update(statementImports)
			.set({ paymentMethodId })
			.where(
				and(
					eq(statementImports.id, input.importId),
					eq(statementImports.ownerId, ownerId),
				),
			)
			.returning({ id: statementImports.id });
		if (!updated.length) throw new Error("NOT_FOUND");
		await tx
			.update(statementTransactions)
			.set({ paymentMethodId, updatedAt: new Date() })
			.where(
				and(
					eq(statementTransactions.ownerId, ownerId),
					eq(statementTransactions.importId, input.importId),
				),
			);
	});
	return runReconciliation(ownerId, input.importId);
}
