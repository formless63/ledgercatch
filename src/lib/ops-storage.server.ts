import { storageConfig } from "#/integrations/storage/config.server";
import { createStorage } from "#/integrations/storage/storage.server";
/** Application-owned read-only inspection policy. Ordinary Storage retains its defaults.
 * The older check API has no AbortSignal seam: Ops bounds/reuses pending work until settlement.
 */
export async function inspectOpsStorage() {
	const config = storageConfig();
	const storage = createStorage({
		...config,
		client: { ...config.client, maxAttempts: 1 },
	});
	try {
		await storage.checkStorage();
		return { status: "ok" as const };
	} finally {
		storage.close();
	}
}
