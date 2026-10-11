/**
 * Server functions for pipeline health and the AI disclosure. Implementations
 * load lazily so nothing server-only reaches the client bundle.
 */
import { createServerFn } from "@tanstack/react-start";

/** Owner-scoped pipeline health for the Captures page panel. */
export const getPipelineHealth = createServerFn({ method: "GET" }).handler(
	async () => {
		const { requireUser } = await import("#/lib/session.server");
		const { getPipelineHealthForOwner } = await import(
			"./pipeline-health.server"
		);
		return getPipelineHealthForOwner((await requireUser()).id);
	},
);

/** Where AI extraction sends redacted text (host only; never the key). Any signed-in user. */
export const getAiDisclosure = createServerFn({ method: "GET" }).handler(
	async () => {
		const { requireUser } = await import("#/lib/session.server");
		await requireUser();
		const { aiDisclosure } = await import("./ai-disclosure.server");
		return aiDisclosure();
	},
);

/** Platform-wide pipeline detail for /admin/ops; same operator allowlist as the Ops summary. */
export const loadOpsPipelineDetail = createServerFn({ method: "GET" }).handler(
	async () => {
		const { getRequestHeaders, setResponseHeader } = await import(
			"@tanstack/react-start/server"
		);
		const { auth } = await import("#/lib/auth");
		const { requireOperator, safeOpsError } = await import(
			"#/integrations/ops-admin/ops.server"
		);
		setResponseHeader("Cache-Control", "private, no-store");
		setResponseHeader("Vary", "Cookie");
		try {
			const session = await auth.api.getSession({
				headers: getRequestHeaders(),
			});
			await requireOperator(
				session?.user.id ?? null,
				process.env.OPS_ADMIN_USER_IDS ?? "",
			);
			const { getPipelineDetail } = await import("./pipeline-health.server");
			return { ok: true as const, detail: await getPipelineDetail() };
		} catch (error) {
			return { ok: false as const, error: safeOpsError(error).error };
		}
	},
);
