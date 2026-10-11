import {
	createOpsInspector,
	opsHeaders,
	requireOperator,
	safeOpsError,
} from "#/integrations/ops-admin/ops.server";
import { auth } from "#/lib/auth";
import { opsAdapters } from "./ops-adapters.server";

let inspect: ReturnType<typeof createOpsInspector> | undefined;
export async function opsResponse(request: Request) {
	try {
		const session = await auth.api.getSession({ headers: request.headers });
		await requireOperator(
			session?.user.id ?? null,
			process.env.OPS_ADMIN_USER_IDS ?? "",
		);
		inspect ??= createOpsInspector(opsAdapters);
		return Response.json(await inspect(), { headers: opsHeaders });
	} catch (error) {
		const safe = safeOpsError(error);
		return Response.json(safe.error, {
			status: safe.status,
			headers: opsHeaders,
		});
	}
}
