/** Multi-file drop zone posting to /api/import/document. */
import { IconFileUpload, IconLoader2 } from "@tabler/icons-react";
import { type DragEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { STORE_META } from "#/components/app/format";
import { Select } from "#/components/app/primitives";
import type { UploadResult } from "#/features/ingress/documents/upload-http.server";
import { cn } from "#/lib/utils";
import { STORE_IDS } from "#/shared/capture";

const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;

export function UploadZone({
	onUploaded,
}: {
	onUploaded: (results: UploadResult[]) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const [over, setOver] = useState(false);
	const [busy, setBusy] = useState(false);
	const [kind, setKind] = useState<"invoice" | "receipt">("invoice");
	const [source, setSource] = useState("generic");

	async function upload(files: File[]) {
		const valid = files.filter((f) => f.size > 0 && f.size <= MAX_BYTES);
		if (valid.length < files.length)
			toast.error("Files over 25 MB were skipped");
		if (!valid.length) return;
		setBusy(true);
		try {
			const all: UploadResult[] = [];
			for (let i = 0; i < valid.length; i += MAX_FILES) {
				const form = new FormData();
				for (const file of valid.slice(i, i + MAX_FILES))
					form.append("file", file);
				form.append("kind", kind);
				form.append("source", source);
				const response = await fetch("/api/import/document", {
					method: "POST",
					body: form,
					credentials: "same-origin",
				});
				const body = (await response.json().catch(() => ({}))) as {
					results?: UploadResult[];
					error?: string;
				};
				if (!body.results)
					throw new Error(body.error ?? `Upload failed (${response.status})`);
				all.push(...body.results);
			}
			const ok = all.filter((r) => r.ok);
			const duplicates = ok.filter((r) => r.created === false).length;
			for (const failed of all.filter((r) => !r.ok))
				toast.error(`${failed.fileName}: ${failed.error ?? "failed"}`);
			if (ok.length)
				toast.success(
					`Uploaded ${ok.length} document${ok.length === 1 ? "" : "s"}${duplicates ? ` (${duplicates} already known)` : ""}`,
				);
			onUploaded(all);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Upload failed");
		} finally {
			setBusy(false);
			if (input.current) input.current.value = "";
		}
	}

	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		setOver(false);
		void upload(Array.from(event.dataTransfer.files));
	};

	return (
		<div className="flex flex-col gap-1.5">
			<button
				type="button"
				disabled={busy}
				onClick={() => input.current?.click()}
				onDragOver={(event) => {
					event.preventDefault();
					setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={onDrop}
				className={cn(
					"flex h-20 flex-col items-center justify-center gap-1 rounded border border-dashed border-border text-[11px] text-muted-foreground transition-colors hover:border-primary hover:text-foreground",
					over && "border-primary bg-primary/10 text-foreground",
				)}
			>
				{busy ? (
					<IconLoader2 className="size-5 animate-spin" />
				) : (
					<IconFileUpload className="size-5" />
				)}
				<span>
					{busy ? "Uploading…" : "Drop PDFs or photos, or click to choose"}
				</span>
				<span className="font-mono text-[9px]">
					PDF · PNG · JPEG · WebP · ≤25 MB
				</span>
			</button>
			<input
				ref={input}
				type="file"
				accept={ACCEPT}
				multiple
				className="hidden"
				onChange={(event) => void upload(Array.from(event.target.files ?? []))}
			/>
			<div className="grid grid-cols-2 gap-1.5">
				<Select
					aria-label="Document type"
					value={kind}
					onChange={(e) =>
						setKind(e.target.value === "receipt" ? "receipt" : "invoice")
					}
				>
					<option value="invoice">Invoices</option>
					<option value="receipt">Receipts</option>
				</Select>
				<Select
					aria-label="Store"
					value={source}
					onChange={(e) => setSource(e.target.value)}
				>
					{STORE_IDS.map((id) => (
						<option key={id} value={id}>
							{id === "generic" ? "Any store" : STORE_META[id].label}
						</option>
					))}
				</Select>
			</div>
		</div>
	);
}
