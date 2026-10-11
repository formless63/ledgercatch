/**
 * Extension-facing enrichment API (X-API-Key with orders:read + captures:write).
 *   GET  /api/v1/enrichment/next?limit=N   claim pending extension_fetch tasks
 *   POST /api/v1/enrichment/{id}/result    report done | failed | skipped
 * Contract: src/shared/capture.ts.
 */
import {
	and,
	asc,
	count,
	eq,
	gte,
	inArray,
	lt,
	notInArray,
	sql,
} from "drizzle-orm";
import { db } from "#/db";
import type { ApiPermissionRequirement } from "#/integrations/api-platform/permissions";
import { requireApiKey } from "#/integrations/api-platform/principal.server";
import {
	ApiHttpError,
	apiErrorResponse,
} from "#/integrations/api-platform/responses";
import {
	enrichmentNextResponseSchema,
	enrichmentResultRequestSchema,
	enrichmentResultResponseSchema,
	MAX_ENRICHMENT_CLAIM,
	storeIdSchema,
} from "#/shared/capture";
import { enrichmentTasks } from "../schema";
import { MAX_ENRICHMENT_ATTEMPTS } from "./urls";

const PERMISSIONS: ApiPermissionRequirement = {
	orders: ["read"],
	captures: ["write"],
};
const STALE_CLAIM_MS = 30 * 60 * 1000;
const MAX_RESULT_BODY = 16 * 1024;

function parseLimit(url: URL): number {
	const raw = url.searchParams.get("limit");
	if (raw === null || raw === "") return 5;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0)
		throw new ApiHttpError(
			400,
			"bad_request",
			"`limit` must be an integer ≥ 0.",
		);
	return Math.min(n, MAX_ENRICHMENT_CLAIM);
}

/**
 * `skipSources=aliexpress,alibaba`: stores the extension cannot complete
 * right now (client-rendered detail pages with background tabs off). Their
 * tasks stay pending instead of burning attempts on certain failures.
 */
function parseSkipSources(url: URL): string[] {
	const raw = url.searchParams.get("skipSources");
	if (!raw) return [];
	const out: string[] = [];
	for (const part of raw.split(",")) {
		const source = storeIdSchema.safeParse(part.trim());
		if (!source.success)
			throw new ApiHttpError(
				400,
				"bad_request",
				"`skipSources` must be a comma-separated list of store ids.",
			);
		out.push(source.data);
	}
	return out;
}

/** Claimed tasks the extension never reported: retry, or give up after max attempts. */
async function releaseStaleClaims(ownerId: string) {
	const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
	const stale = and(
		eq(enrichmentTasks.ownerId, ownerId),
		eq(enrichmentTasks.kind, "extension_fetch"),
		eq(enrichmentTasks.status, "claimed"),
		lt(enrichmentTasks.claimedAt, cutoff),
	);
	await db
		.update(enrichmentTasks)
		.set({
			status: "failed",
			lastError: "claim expired (no result reported)",
			finishedAt: new Date(),
		})
		.where(and(stale, gte(enrichmentTasks.attempts, MAX_ENRICHMENT_ATTEMPTS)));
	await db
		.update(enrichmentTasks)
		.set({ status: "pending", claimedAt: null })
		.where(and(stale, lt(enrichmentTasks.attempts, MAX_ENRICHMENT_ATTEMPTS)));
}

async function countPending(ownerId: string): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(enrichmentTasks)
		.where(
			and(
				eq(enrichmentTasks.ownerId, ownerId),
				eq(enrichmentTasks.kind, "extension_fetch"),
				eq(enrichmentTasks.status, "pending"),
			),
		);
	return row?.n ?? 0;
}

export async function claimEnrichmentTasks(
	ownerId: string,
	limit: number,
	skipSources: string[] = [],
) {
	await releaseStaleClaims(ownerId);
	const claimed =
		limit === 0
			? []
			: await db.transaction(async (tx) => {
					const rows = await tx
						.select({
							id: enrichmentTasks.id,
							source: enrichmentTasks.source,
							externalOrderId: enrichmentTasks.externalOrderId,
							url: enrichmentTasks.url,
						})
						.from(enrichmentTasks)
						.where(
							and(
								eq(enrichmentTasks.ownerId, ownerId),
								eq(enrichmentTasks.kind, "extension_fetch"),
								eq(enrichmentTasks.status, "pending"),
								lt(enrichmentTasks.attempts, MAX_ENRICHMENT_ATTEMPTS),
								skipSources.length
									? notInArray(enrichmentTasks.source, skipSources)
									: undefined,
							),
						)
						.orderBy(asc(enrichmentTasks.createdAt))
						.limit(limit)
						.for("update", { skipLocked: true });
					if (rows.length === 0) return [];
					await tx
						.update(enrichmentTasks)
						.set({
							status: "claimed",
							claimedAt: new Date(),
							attempts: sql`${enrichmentTasks.attempts} + 1`,
						})
						.where(
							inArray(
								enrichmentTasks.id,
								rows.map((r) => r.id),
							),
						);
					return rows;
				});
	const tasks = claimed.flatMap((row) => {
		const source = storeIdSchema.safeParse(row.source);
		return row.url && source.success
			? [
					{
						id: row.id,
						source: source.data,
						externalOrderId: row.externalOrderId,
						url: row.url,
					},
				]
			: [];
	});
	return enrichmentNextResponseSchema.parse({
		tasks,
		pending: await countPending(ownerId),
	});
}

export async function recordEnrichmentResult(
	ownerId: string,
	taskId: string,
	body: {
		status: "done" | "failed" | "skipped";
		captureId?: string;
		error?: string;
	},
) {
	const note =
		body.status === "done"
			? body.captureId
				? null
				: (body.error ?? null)
			: (body.error ?? body.status);
	const [row] = await db
		.update(enrichmentTasks)
		.set({
			status: body.status,
			lastError: note ? note.slice(0, 2000) : null,
			finishedAt: new Date(),
		})
		.where(
			and(
				eq(enrichmentTasks.id, taskId),
				eq(enrichmentTasks.ownerId, ownerId),
				eq(enrichmentTasks.kind, "extension_fetch"),
				inArray(enrichmentTasks.status, ["claimed", "pending"]),
			),
		)
		.returning({ id: enrichmentTasks.id, status: enrichmentTasks.status });
	if (row) return enrichmentResultResponseSchema.parse(row);
	const [existing] = await db
		.select({ id: enrichmentTasks.id, status: enrichmentTasks.status })
		.from(enrichmentTasks)
		.where(
			and(
				eq(enrichmentTasks.id, taskId),
				eq(enrichmentTasks.ownerId, ownerId),
				eq(enrichmentTasks.kind, "extension_fetch"),
			),
		);
	if (!existing)
		throw new ApiHttpError(404, "not_found", "Enrichment task not found.");
	throw new ApiHttpError(
		409,
		"bad_request",
		`Enrichment task is already ${existing.status}.`,
	);
}

export async function nextEnrichmentApi(request: Request) {
	try {
		const principal = await requireApiKey(request, PERMISSIONS);
		const url = new URL(request.url);
		const limit = parseLimit(url);
		return Response.json(
			await claimEnrichmentTasks(
				principal.userId,
				limit,
				parseSkipSources(url),
			),
		);
	} catch (error) {
		return apiErrorResponse(error);
	}
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function enrichmentResultApi(request: Request, taskId: string) {
	try {
		const principal = await requireApiKey(request, PERMISSIONS);
		if (!UUID_RE.test(taskId))
			throw new ApiHttpError(404, "not_found", "Enrichment task not found.");
		const declared = request.headers.get("content-length");
		if (declared && Number(declared) > MAX_RESULT_BODY)
			throw new ApiHttpError(
				413,
				"payload_too_large",
				"Request body is too large.",
			);
		const text = await request.text();
		if (text.length > MAX_RESULT_BODY)
			throw new ApiHttpError(
				413,
				"payload_too_large",
				"Request body is too large.",
			);
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw new ApiHttpError(400, "bad_request", "Request body must be JSON.");
		}
		const parsed = enrichmentResultRequestSchema.safeParse(json);
		if (!parsed.success)
			throw new ApiHttpError(
				422,
				"validation_error",
				"Request body is invalid.",
				parsed.error.issues.slice(0, 20).map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			);
		return Response.json(
			await recordEnrichmentResult(principal.userId, taskId, parsed.data),
		);
	} catch (error) {
		return apiErrorResponse(error);
	}
}
