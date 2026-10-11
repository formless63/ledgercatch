/**
 * Server functions for Settings / Rules pages. Implementations
 * live in settings-ui.server.ts and are imported lazily.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ENTITY_COLOR_OPTIONS } from "./inputs";

const settingsUi = () => import("./settings-ui.server");

export const onboardInput = z.object({
	entities: z
		.array(
			z.object({
				name: z.string().trim().min(1).max(120),
				shortName: z.string().trim().max(24).nullable().optional(),
				kind: z.enum(["personal", "business"]),
				color: z.enum(ENTITY_COLOR_OPTIONS),
				isDefault: z.boolean().optional(),
			}),
		)
		.min(1)
		.max(20),
	categories: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
});
export const reorderInput = z.object({
	ids: z.array(z.string().uuid()).min(1).max(500),
});
export const ruleEnabledInput = z.object({
	id: z.string().uuid(),
	enabled: z.boolean(),
});
export const getSettingsUsage = createServerFn({ method: "GET" }).handler(
	async () => (await settingsUi()).getSettingsUsage(),
);
export const onboardEntities = createServerFn({ method: "POST" })
	.validator(onboardInput)
	.handler(async ({ data }) => (await settingsUi()).onboardEntities(data));
export const reorderEntities = createServerFn({ method: "POST" })
	.validator(reorderInput)
	.handler(async ({ data }) => (await settingsUi()).reorderEntities(data.ids));
export const reorderRules = createServerFn({ method: "POST" })
	.validator(reorderInput)
	.handler(async ({ data }) => (await settingsUi()).reorderRules(data.ids));
export const setRuleEnabled = createServerFn({ method: "POST" })
	.validator(ruleEnabledInput)
	.handler(async ({ data }) => (await settingsUi()).setRuleEnabled(data));
