/** Turn drafts from content scripts / popup into validated outbox items. */

import type { DocumentUploadMeta } from "@app/shared/capture";
import { documentUploadMetaSchema } from "@app/shared/capture";
import { formatCaptureTimestamp } from "@app/shared/capture-time";
import { extensionVersion } from "@/lib/app";
import { isRecentDuplicate, rememberHash } from "@/lib/dedupe";
import { buildEnvelope, type CaptureDraft, dedupeMaterial } from "@/lib/envelope";
import type { SubmitOutcome } from "@/lib/messaging";
import { getSettings, isConfigured } from "@/lib/settings";
import { getState, setState } from "@/lib/state";
import { STORE_LABELS } from "@/lib/stores";
import { sha256Hex } from "@/lib/util";
import { enqueue } from "./flusher";
import { addHistory, serialized } from "./history";
import { rememberMouserInvoiceOrders } from "./mouser-invoices";

const KIND_LABEL = { api_json: "API JSON", html_snapshot: "HTML snapshot", page_text: "Page text" } as const;

export async function ingestCapture(draft: CaptureDraft): Promise<SubmitOutcome> {
	const settings = await getSettings();
	const passive = draft.trigger === "passive";
	if (passive) {
		if (!isConfigured(settings)) return { status: "skipped", reason: "unconfigured" };
		if (!settings.passiveCapture) return { status: "skipped", reason: "disabled" };
		// Passive "generic" captures only come from the opt-in auto-detector.
		if (draft.source === "generic" ? !settings.autoDetectOrders : !settings.stores[draft.source]) {
			return { status: "skipped", reason: "disabled" };
		}
	}

	const captureId = crypto.randomUUID();
	const built = buildEnvelope(draft, {
		captureId,
		capturedAt: formatCaptureTimestamp(),
		extensionVersion: extensionVersion(),
	});
	if (!built.ok) {
		await addHistory({
			id: captureId,
			at: Date.now(),
			type: "capture",
			kind: draft.kind,
			source: draft.source,
			pageType: draft.pageType,
			url: draft.pageUrl.slice(0, 500),
			label: `${STORE_LABELS[draft.source]} ${KIND_LABEL[draft.kind]}`,
			status: "error",
			message: `invalid capture: ${built.error.slice(0, 250)}`,
		});
		return { status: "invalid", error: built.error };
	}

	if (draft.source === "mouser" && draft.payload.type === "json") await rememberMouserInvoiceOrders(draft.payload.body);

	// Passive captures: skip identical content for the same URL within 24h.
	if (passive) {
		const hash = await sha256Hex(dedupeMaterial(draft));
		const duplicate = await serialized(async () => {
			const now = Date.now();
			const map = await getState("recentHashes");
			if (isRecentDuplicate(map, hash, now)) return true;
			await setState("recentHashes", rememberHash(map, hash, now));
			return false;
		});
		if (duplicate) return { status: "skipped", reason: "duplicate" };
	}

	const env = built.envelope;
	await enqueue({
		type: "capture",
		id: captureId,
		historyId: captureId,
		createdAt: Date.now(),
		attempts: 0,
		nextAttemptAt: 0,
		status: "pending",
		envelope: env,
		label: `${STORE_LABELS[env.source]} ${KIND_LABEL[env.kind]} · ${env.pageType.replace("_", " ")}`,
	});
	return { status: "queued", captureId };
}

export async function ingestDocument(input: { meta: DocumentUploadMeta; file: Blob; label: string }): Promise<string> {
	const meta = documentUploadMetaSchema.parse(input.meta);
	const id = crypto.randomUUID();
	await enqueue({
		type: "document",
		id,
		historyId: id,
		createdAt: Date.now(),
		attempts: 0,
		nextAttemptAt: 0,
		status: "pending",
		meta,
		file: input.file,
		label: `${STORE_LABELS[meta.source]} ${meta.kind} · ${meta.fileName}`,
	});
	return id;
}
