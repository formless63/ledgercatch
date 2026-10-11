/**
 * Session-scoped wrappers behind money server functions. Each resolves the
 * signed-in user and calls the *ForOwner implementation.
 */
import type { z } from "zod";
import { requireUser } from "#/features/ledger/ledger.server";
import { getFxStatus, refreshFxRates } from "./fx.server";
import type * as inputs from "./inputs";
import {
	getInsightsConvertedForOwner,
	getReimbursementsConvertedForOwner,
} from "./insights.server";
import {
	confirmAllAboveForOwner,
	confirmMatchesForOwner,
	createOrderFromTransactionForOwner,
	getReconcileDataForOwner,
	rejectMatchForOwner,
	runReconciliation,
	setTransactionsIgnoredForOwner,
	unmatchTransactionForOwner,
} from "./reconcile.server";
import {
	getMoneySettingsForOwner,
	saveEntitySettingsForOwner,
	saveUserReportingCurrencyForOwner,
} from "./settings.server";
import {
	deleteStatementImportForOwner,
	importStatementForOwner,
	MAX_STATEMENT_BYTES,
	previewStatementForOwner,
	StatementFileError,
	setStatementCardForOwner,
} from "./statements.server";
import {
	acceptTaxTreatmentForOwner,
	clearTaxTreatmentForOwner,
	getTaxSuggestionsForOwner,
	getTaxSummaryForOwner,
} from "./tax.server";

const owner = async () => (await requireUser()).id;

function decodeFile(input: z.output<typeof inputs.statementFileInput>) {
	const bytes = new Uint8Array(Buffer.from(input.base64, "base64"));
	if (bytes.byteLength > MAX_STATEMENT_BYTES)
		throw new Error("File too large (max 10 MB)");
	return {
		fileName: input.fileName,
		bytes,
		presetId: input.presetId ?? null,
		signConvention: input.signConvention ?? null,
		currency: input.currency ?? null,
		dayFirst: input.dayFirst,
		paymentMethodId: input.paymentMethodId ?? null,
	};
}

/** File errors surface as plain messages for the UI. */
async function friendly<T>(work: () => Promise<T>) {
	try {
		return await work();
	} catch (error) {
		if (error instanceof StatementFileError) throw new Error(error.message);
		throw error;
	}
}

export async function previewStatement(
	input: z.output<typeof inputs.statementFileInput>,
) {
	const ownerId = await owner();
	return friendly(() => previewStatementForOwner(ownerId, decodeFile(input)));
}
export async function importStatement(
	input: z.output<typeof inputs.statementFileInput>,
) {
	const ownerId = await owner();
	return friendly(() => importStatementForOwner(ownerId, decodeFile(input)));
}
export async function deleteStatementImport(importId: string) {
	return deleteStatementImportForOwner(await owner(), importId);
}
export async function setStatementCard(
	input: z.output<typeof inputs.statementCardInput>,
) {
	return setStatementCardForOwner(await owner(), input);
}
export async function getReconcileData(
	input: z.output<typeof inputs.reconcileFilterInput>,
) {
	return getReconcileDataForOwner(await owner(), input);
}
export async function rerunReconciliation() {
	return runReconciliation(await owner());
}
export async function confirmMatches(matchIds: string[]) {
	return confirmMatchesForOwner(await owner(), matchIds);
}
export async function confirmAllAbove(minScore: number) {
	return confirmAllAboveForOwner(await owner(), minScore);
}
export async function rejectMatch(matchId: string) {
	return rejectMatchForOwner(await owner(), matchId);
}
export async function unmatchTransaction(transactionId: string) {
	return unmatchTransactionForOwner(await owner(), transactionId);
}
export async function setTransactionsIgnored(
	input: z.output<typeof inputs.ignoreInput>,
) {
	return setTransactionsIgnoredForOwner(await owner(), input);
}
export async function createOrderFromTransaction(
	input: z.output<typeof inputs.createOrderFromTxInput>,
) {
	return createOrderFromTransactionForOwner(await owner(), input);
}
export async function getMoneySettings() {
	const ownerId = await owner();
	const [settings, fx] = await Promise.all([
		getMoneySettingsForOwner(ownerId),
		getFxStatus(),
	]);
	return { ...settings, fx };
}
export async function saveUserReportingCurrency(currency: string) {
	return saveUserReportingCurrencyForOwner(await owner(), currency);
}
export async function saveEntitySettings(
	input: z.output<typeof inputs.entitySettingsInput>,
) {
	return saveEntitySettingsForOwner(await owner(), input);
}
export async function refreshFx(input: z.output<typeof inputs.fxRefreshInput>) {
	await owner();
	return refreshFxRates(input);
}
export async function getInsightsConverted(
	input: z.output<typeof inputs.convertedInsightsInput>,
) {
	return getInsightsConvertedForOwner(await owner(), input);
}
export async function getReimbursementsConverted(currency?: string) {
	return getReimbursementsConvertedForOwner(await owner(), { currency });
}
export async function getTaxSuggestions(orderId: string) {
	return getTaxSuggestionsForOwner(await owner(), orderId);
}
export async function acceptTaxTreatment(
	input: z.output<typeof inputs.acceptTaxInput>,
) {
	return acceptTaxTreatmentForOwner(await owner(), input);
}
export async function clearTaxTreatment(allocationId: string) {
	return clearTaxTreatmentForOwner(await owner(), allocationId);
}
export async function getTaxSummary(
	input: z.output<typeof inputs.taxSummaryInput>,
) {
	return getTaxSummaryForOwner(await owner(), input);
}
