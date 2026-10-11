/**
 * Server functions for Settings → Sources. Implementations live in
 * sources-ui.server.ts (lazy-imported; owner-scoped via requireUser).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const sourcesUi = () => import("./sources-ui.server");

/** Mirrors INGRESS_SOURCE_KINDS (schema.ts stays out of the client bundle). */
export const SOURCE_KINDS = [
	"imap",
	"inbound_email",
	"paperless",
	"digikey_api",
] as const;

const fieldValues = z
	.record(
		z.string().max(100),
		z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]),
	)
	.optional();

const idInput = z.object({ id: z.string().uuid() });

export const sourceCreateInput = z.object({
	kind: z.enum(SOURCE_KINDS),
	name: z.string().trim().min(1).max(120),
	config: fieldValues,
	secret: fieldValues,
	intervalMinutes: z.number().int().min(5).max(1440).optional(),
	enabled: z.boolean().optional(),
});

export const sourceUpdateInput = z.object({
	id: z.string().uuid(),
	name: z.string().trim().min(1).max(120).optional(),
	config: fieldValues,
	secret: fieldValues,
	intervalMinutes: z.number().int().min(5).max(1440).optional(),
	enabled: z.boolean().optional(),
});

export const listIngressSources = createServerFn({ method: "GET" }).handler(
	async () => (await sourcesUi()).listSources(),
);

export const createIngressSource = createServerFn({ method: "POST" })
	.validator(sourceCreateInput)
	.handler(async ({ data }) => (await sourcesUi()).createSource(data));

export const updateIngressSource = createServerFn({ method: "POST" })
	.validator(sourceUpdateInput)
	.handler(async ({ data }) => (await sourcesUi()).updateSource(data));

export const deleteIngressSource = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await sourcesUi()).deleteSource(data.id));

export const testIngressSource = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await sourcesUi()).testSource(data.id));

export const pollIngressSourceNow = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await sourcesUi()).pollSourceNow(data.id));

export const rotateIngressPushToken = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await sourcesUi()).rotatePushToken(data.id));
