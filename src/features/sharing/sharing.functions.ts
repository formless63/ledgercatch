/**
 * Server functions for entity sharing. Owner functions act on the session
 * user's own entities; grantee functions always resolve a Grant first.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const server = () => import("./sharing.server");

const uuid = z.string().uuid();
const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.optional();
const rangeInput = z.object({
	entityId: uuid,
	from: isoDate,
	to: isoDate,
	q: z.string().max(200).optional(),
});

/* owner */
export const listEntityShares = createServerFn({ method: "GET" }).handler(
	async () => {
		const s = await server();
		const owner = await s.requireSessionUser();
		return s.listSharesForOwner(owner.id);
	},
);

export const inviteEntityShare = createServerFn({ method: "POST" })
	.validator(z.object({ entityId: uuid, email: z.string().min(3).max(254) }))
	.handler(async ({ data }) => {
		const s = await server();
		const owner = await s.requireSessionUser();
		return s.createShareForOwner(owner.id, data);
	});

export const revokeEntityShare = createServerFn({ method: "POST" })
	.validator(z.object({ shareId: uuid }))
	.handler(async ({ data }) => {
		const s = await server();
		const owner = await s.requireSessionUser();
		return s.revokeShareForOwner(owner.id, data.shareId);
	});

/* grantee */
export const acceptEntityShare = createServerFn({ method: "POST" })
	.validator(z.object({ token: z.string().min(16).max(256) }))
	.handler(async ({ data }) => {
		const s = await server();
		const viewer = await s.requireSessionUser();
		return s.acceptShareForUser(
			{
				id: viewer.id,
				email: viewer.email,
				emailVerified: viewer.emailVerified,
			},
			data.token,
		);
	});

export const listMyShares = createServerFn({ method: "GET" }).handler(
	async () => {
		const s = await server();
		const viewer = await s.requireSessionUser();
		return s.listSharesForViewer(viewer.id);
	},
);

export const getSharedSummary = createServerFn({ method: "GET" })
	.validator(rangeInput)
	.handler(async ({ data }) => {
		const s = await server();
		const viewer = await s.requireSessionUser();
		const grant = await s.requireGrant(viewer.id, data.entityId);
		return s.getSharedSummaryForGrantee(grant, data);
	});

export const listSharedOrders = createServerFn({ method: "GET" })
	.validator(
		rangeInput.extend({
			limit: z.number().int().min(1).max(500).optional(),
			offset: z.number().int().min(0).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const s = await server();
		const viewer = await s.requireSessionUser();
		const grant = await s.requireGrant(viewer.id, data.entityId);
		return s.listSharedOrdersForGrantee(grant, data);
	});

export const getSharedOrder = createServerFn({ method: "GET" })
	.validator(z.object({ entityId: uuid, orderId: uuid }))
	.handler(async ({ data }) => {
		const s = await server();
		const viewer = await s.requireSessionUser();
		const grant = await s.requireGrant(viewer.id, data.entityId);
		return s.getSharedOrderForGrantee(grant, data.orderId);
	});

export const listSharedClaims = createServerFn({ method: "GET" })
	.validator(z.object({ entityId: uuid }))
	.handler(async ({ data }) => {
		const s = await server();
		const viewer = await s.requireSessionUser();
		const grant = await s.requireGrant(viewer.id, data.entityId);
		return s.listSharedClaimsForGrantee(grant);
	});

export const exportSharedCsv = createServerFn({ method: "POST" })
	.validator(rangeInput)
	.handler(async ({ data }) => {
		const s = await server();
		const viewer = await s.requireSessionUser();
		const grant = await s.requireGrant(viewer.id, data.entityId);
		return s.exportSharedCsvForGrantee(grant, data);
	});
