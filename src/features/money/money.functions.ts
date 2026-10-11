/**
 * Server functions for reconciliation, FX/reporting currency and tax hints.
 * Implementations are lazy-imported so server code never reaches the client.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	acceptTaxInput,
	allocationIdInput,
	confirmAboveInput,
	convertedInsightsInput,
	createOrderFromTxInput,
	entitySettingsInput,
	fxRefreshInput,
	idInput,
	ignoreInput,
	matchIdsInput,
	reconcileFilterInput,
	statementCardInput,
	statementFileInput,
	taxSummaryInput,
	userCurrencyInput,
} from "./inputs";

const money = () => import("./money-ui.server");

export const previewStatement = createServerFn({ method: "POST" })
	.validator(statementFileInput)
	.handler(async ({ data }) => (await money()).previewStatement(data));

export const importStatement = createServerFn({ method: "POST" })
	.validator(statementFileInput)
	.handler(async ({ data }) => (await money()).importStatement(data));

export const deleteStatementImport = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await money()).deleteStatementImport(data.id));

export const setStatementCard = createServerFn({ method: "POST" })
	.validator(statementCardInput)
	.handler(async ({ data }) => (await money()).setStatementCard(data));

export const getReconcileData = createServerFn({ method: "POST" })
	.validator(reconcileFilterInput)
	.handler(async ({ data }) => (await money()).getReconcileData(data));

export const rerunReconciliation = createServerFn({ method: "POST" }).handler(
	async () => (await money()).rerunReconciliation(),
);

export const confirmMatches = createServerFn({ method: "POST" })
	.validator(matchIdsInput)
	.handler(async ({ data }) => (await money()).confirmMatches(data.matchIds));

export const confirmAllAbove = createServerFn({ method: "POST" })
	.validator(confirmAboveInput)
	.handler(async ({ data }) => (await money()).confirmAllAbove(data.minScore));

export const rejectMatch = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await money()).rejectMatch(data.id));

export const unmatchTransaction = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await money()).unmatchTransaction(data.id));

export const setTransactionsIgnored = createServerFn({ method: "POST" })
	.validator(ignoreInput)
	.handler(async ({ data }) => (await money()).setTransactionsIgnored(data));

export const createOrderFromTransaction = createServerFn({ method: "POST" })
	.validator(createOrderFromTxInput)
	.handler(async ({ data }) =>
		(await money()).createOrderFromTransaction(data),
	);

export const getMoneySettings = createServerFn({ method: "GET" }).handler(
	async () => (await money()).getMoneySettings(),
);

export const saveUserReportingCurrency = createServerFn({ method: "POST" })
	.validator(userCurrencyInput)
	.handler(async ({ data }) =>
		(await money()).saveUserReportingCurrency(data.reportingCurrency),
	);

export const saveEntitySettings = createServerFn({ method: "POST" })
	.validator(entitySettingsInput)
	.handler(async ({ data }) => (await money()).saveEntitySettings(data));

export const refreshFx = createServerFn({ method: "POST" })
	.validator(fxRefreshInput)
	.handler(async ({ data }) => (await money()).refreshFx(data));

export const getInsightsConverted = createServerFn({ method: "POST" })
	.validator(convertedInsightsInput)
	.handler(async ({ data }) => (await money()).getInsightsConverted(data));

export const getReimbursementsConverted = createServerFn({ method: "POST" })
	.validator(z.object({ currency: z.string().length(3).optional() }))
	.handler(async ({ data }) =>
		(await money()).getReimbursementsConverted(data.currency),
	);

export const getTaxSuggestions = createServerFn({ method: "GET" })
	.validator(idInput)
	.handler(async ({ data }) => (await money()).getTaxSuggestions(data.id));

export const acceptTaxTreatment = createServerFn({ method: "POST" })
	.validator(acceptTaxInput)
	.handler(async ({ data }) => (await money()).acceptTaxTreatment(data));

export const clearTaxTreatment = createServerFn({ method: "POST" })
	.validator(allocationIdInput)
	.handler(async ({ data }) =>
		(await money()).clearTaxTreatment(data.allocationId),
	);

export const getTaxSummary = createServerFn({ method: "POST" })
	.validator(taxSummaryInput)
	.handler(async ({ data }) => (await money()).getTaxSummary(data));
