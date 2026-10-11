/**
 * Server functions for the Reimbursements, Insights and Captures pages.
 * Implementations are lazy-imported so server code never reaches the client.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { STORE_IDS } from "#/shared/capture";
import { idInput, insightsInput } from "./inputs";

const reviewUi = () => import("./review-ui.server");

export const getClaimStats = createServerFn({ method: "GET" }).handler(
	async () => (await reviewUi()).getClaimStats(),
);

export const getClaimReport = createServerFn({ method: "GET" })
	.validator(idInput)
	.handler(async ({ data }) => (await reviewUi()).getClaimReport(data.id));

export const getInsightsSupplement = createServerFn({ method: "POST" })
	.validator(insightsInput)
	.handler(async ({ data }) => (await reviewUi()).getInsightsSupplement(data));

export const getCaptureFacets = createServerFn({ method: "GET" }).handler(
	async () => (await reviewUi()).getCaptureFacets(),
);

export const reprocessFailedCaptures = createServerFn({ method: "POST" })
	.validator(
		z.object({
			source: z.enum(STORE_IDS).optional(),
			includeNeedsReview: z.boolean().optional(),
		}),
	)
	.handler(async ({ data }) =>
		(await reviewUi()).reprocessFailedCaptures(data),
	);

export const getCaptureFixture = createServerFn({ method: "GET" })
	.validator(idInput)
	.handler(async ({ data }) => (await reviewUi()).getCaptureFixture(data.id));
