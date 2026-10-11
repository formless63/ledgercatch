import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import {
	clearEnrichmentDiagnostic,
	ENRICHMENT_DIAGNOSTIC_KEY,
	type EnrichmentDiagnostic,
	readEnrichmentDiagnostic,
} from "@/lib/enrichment-diagnostics";
import { Button } from "@/ui/components";

export function EnrichmentDiagnostics({ recorderMode }: { recorderMode: boolean }) {
	const [diagnostic, setDiagnostic] = useState<EnrichmentDiagnostic | null>(null);
	const [message, setMessage] = useState("");
	useEffect(() => {
		let current = true;
		const refresh = () => {
			void readEnrichmentDiagnostic()
				.then((record) => {
					if (current) setDiagnostic(record);
				})
				.catch(() => {
					if (current) setDiagnostic(null);
				});
		};
		const changed = (changes: Record<string, unknown>, area: string) => {
			if (area === "local" && changes[ENRICHMENT_DIAGNOSTIC_KEY]) refresh();
		};
		if (recorderMode) refresh();
		else {
			setDiagnostic(null);
			void clearEnrichmentDiagnostic().catch(() => {});
		}
		browser.storage.onChanged.addListener(changed);
		return () => {
			current = false;
			browser.storage.onChanged.removeListener(changed);
		};
	}, [recorderMode]);
	if (!recorderMode || !diagnostic) return null;
	const download = async () => {
		const current = await readEnrichmentDiagnostic();
		if (!current) {
			setDiagnostic(null);
			return;
		}
		const url = URL.createObjectURL(new Blob([JSON.stringify(current)], { type: "application/json" }));
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `enrichment-diagnostic-${current.source}.json`;
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};
	return (
		<div className="space-y-2 border-t border-line pt-3 text-[11px] text-muted">
			<p>
				Recorder mode saved the latest empty response ({diagnostic.source}, {diagnostic.via}
				{diagnostic.truncated ? ", truncated" : ""}). Raw page HTML may contain personal account data. It stays in this
				extension, is never uploaded as an order, and expires after 24 hours. Turning recorder mode off clears it.
			</p>
			<div className="flex gap-2">
				<Button
					onClick={() => {
						void download().catch(() => setMessage("Could not download diagnostic"));
					}}
				>
					Download diagnostic
				</Button>
				<Button
					onClick={() => {
						void clearEnrichmentDiagnostic().catch(() => setMessage("Could not clear diagnostic"));
					}}
				>
					Clear diagnostic
				</Button>
			</div>
			{message && <p>{message}</p>}
		</div>
	);
}
