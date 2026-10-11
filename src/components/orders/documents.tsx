/** Order documents: list, inline preview, upload (click or drop) and delete. */
import {
	IconDownload,
	IconExternalLink,
	IconEye,
	IconEyeOff,
	IconFileText,
	IconTrash,
	IconUpload,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { formatBytes, formatRelative } from "#/components/app/format";
import { Button, Panel, Select, Tag } from "#/components/app/primitives";
import { useInvalidateLedger } from "#/features/ledger/hooks";
import { deleteDocument } from "#/features/ledger/ledger.functions";
import type { OrderDetail } from "#/features/ledger/ledger.server";
import { cn } from "#/lib/utils";
import { errorMessage } from "./shared";

type DocumentRow = OrderDetail["documents"][number];

const KINDS = [
	["invoice", "Invoice"],
	["receipt", "Receipt"],
	["packing_slip", "Packing slip"],
	["order_page", "Order page"],
	["other", "Other"],
] as const;

const PREVIEWABLE = new Set([
	"application/pdf",
	"image/png",
	"image/jpeg",
	"image/webp",
]);

export function documentUrl(id: string, download = false) {
	return `/api/documents/${id}${download ? "?download" : ""}`;
}

async function uploadDocument(file: File, orderId: string, kind: string) {
	const body = new FormData();
	body.set("file", file);
	body.set("orderId", orderId);
	body.set("kind", kind);
	const response = await fetch("/api/documents/upload", {
		method: "POST",
		body,
		credentials: "same-origin",
	});
	const json = (await response.json().catch(() => ({}))) as {
		error?: string;
		duplicate?: boolean;
	};
	if (!response.ok)
		throw new Error(json.error ?? `Upload failed (${response.status})`);
	return json;
}

export function DocumentPreview({ doc }: { doc: DocumentRow }) {
	if (doc.contentType === "application/pdf")
		return (
			<iframe
				title={`Preview of ${doc.fileName}`}
				src={documentUrl(doc.id)}
				className="h-[480px] w-full rounded-sm border border-border bg-white"
			/>
		);
	if (doc.contentType.startsWith("image/") && PREVIEWABLE.has(doc.contentType))
		return (
			<img
				src={documentUrl(doc.id)}
				alt={doc.fileName}
				className="max-h-[480px] w-full rounded-sm border border-border object-contain"
			/>
		);
	return (
		<p className="rounded-sm border border-dashed border-border p-3 text-xs text-muted-foreground">
			No inline preview for {doc.contentType}. Download it instead.
		</p>
	);
}

export function DocumentsPanel({
	orderId,
	documents,
	compact,
	className,
}: {
	orderId: string;
	documents: DocumentRow[];
	/** Inspector mode: no inline previews, smaller upload controls. */
	compact?: boolean;
	className?: string;
}) {
	const invalidate = useInvalidateLedger();
	const inputRef = useRef<HTMLInputElement>(null);
	const [kind, setKind] = useState<string>("invoice");
	const [previewId, setPreviewId] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);

	const upload = useMutation({
		mutationFn: async (files: File[]) => {
			let duplicates = 0;
			for (const file of files) {
				const result = await uploadDocument(file, orderId, kind);
				if (result.duplicate) duplicates++;
			}
			return { count: files.length, duplicates };
		},
		onSuccess: ({ count, duplicates }) => {
			toast.success(
				`Uploaded ${count} file${count === 1 ? "" : "s"}${duplicates ? ` (${duplicates} already stored)` : ""}`,
			);
		},
		onError: (error) => toast.error(errorMessage(error)),
		onSettled: () => void invalidate(),
	});

	const remove = useMutation({
		mutationFn: (id: string) => deleteDocument({ data: { id } }),
		onSuccess: () => toast.success("Document deleted"),
		onError: (error) => toast.error(errorMessage(error)),
		onSettled: () => void invalidate(),
	});

	const onFiles = (list: FileList | null) => {
		const files = Array.from(list ?? []);
		if (files.length) upload.mutate(files);
	};

	const hasInvoice = documents.some(
		(doc) => doc.kind === "invoice" || doc.kind === "receipt",
	);

	return (
		<Panel
			title={
				<span className="flex items-center gap-2">
					Documents
					{!hasInvoice && <Tag tone="danger">Missing invoice</Tag>}
				</span>
			}
			className={className}
			bodyClassName="p-0"
			action={
				<div className="flex items-center gap-1">
					<Select
						aria-label="Document kind for upload"
						value={kind}
						onChange={(event) => setKind(event.target.value)}
						className="h-5 w-auto text-[11px]"
					>
						{KINDS.map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</Select>
					<Button
						size="xs"
						onClick={() => inputRef.current?.click()}
						disabled={upload.isPending}
						aria-label="Upload document"
					>
						<IconUpload />
						{upload.isPending ? "Uploading…" : "Upload"}
					</Button>
					<input
						ref={inputRef}
						type="file"
						multiple
						hidden
						accept="application/pdf,image/png,image/jpeg,image/webp,text/html,.pdf,.png,.jpg,.jpeg,.webp,.html"
						onChange={(event) => {
							onFiles(event.target.files);
							event.target.value = "";
						}}
					/>
				</div>
			}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone supplements the Upload button */}
			<div
				onDragOver={(event) => {
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(event) => {
					event.preventDefault();
					setDragging(false);
					onFiles(event.dataTransfer.files);
				}}
				className={cn(
					"min-h-10",
					dragging && "bg-primary/5 outline-1 outline-dashed outline-primary",
				)}
			>
				{documents.length === 0 ? (
					<p className="px-3 py-3 text-xs text-muted-foreground">
						No documents yet. Drop an invoice PDF or image here, or let the
						extension fetch it.
					</p>
				) : (
					<ul className="divide-y divide-border">
						{documents.map((doc) => {
							const open = previewId === doc.id;
							return (
								<li key={doc.id} className="px-3 py-1.5">
									<div className="flex min-h-6 items-center gap-2">
										<IconFileText className="size-3.5 shrink-0 text-muted-foreground" />
										<Tag
											tone={
												doc.kind === "invoice" || doc.kind === "receipt"
													? "success"
													: "neutral"
											}
										>
											{doc.kind.replace("_", " ")}
										</Tag>
										<a
											href={documentUrl(doc.id)}
											target="_blank"
											rel="noreferrer"
											className="min-w-0 flex-1 truncate text-xs hover:underline"
											title={doc.fileName}
										>
											{doc.fileName}
										</a>
										<span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
											{formatBytes(doc.sizeBytes)} ·{" "}
											{formatRelative(doc.createdAt)}
										</span>
										{!compact && (
											<Button
												variant="ghost"
												size="xs"
												aria-label={open ? "Hide preview" : "Show preview"}
												aria-expanded={open}
												onClick={() => setPreviewId(open ? null : doc.id)}
											>
												{open ? <IconEyeOff /> : <IconEye />}
											</Button>
										)}
										{compact && (
											<a
												href={documentUrl(doc.id)}
												target="_blank"
												rel="noreferrer"
												aria-label={`Open ${doc.fileName}`}
												className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
											>
												<IconExternalLink className="size-3.5" />
											</a>
										)}
										<a
											href={documentUrl(doc.id, true)}
											aria-label={`Download ${doc.fileName}`}
											className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
										>
											<IconDownload className="size-3.5" />
										</a>
										<Button
											variant="ghost"
											size="xs"
											aria-label={`Delete ${doc.fileName}`}
											disabled={remove.isPending}
											onClick={() => {
												if (window.confirm(`Delete ${doc.fileName}?`))
													remove.mutate(doc.id);
											}}
										>
											<IconTrash />
										</Button>
									</div>
									{open && (
										<div className="mt-1.5">
											<DocumentPreview doc={doc} />
										</div>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</Panel>
	);
}
