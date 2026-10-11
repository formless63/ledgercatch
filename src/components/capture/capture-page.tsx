/**
 * Phone-first receipt capture (/app/capture): take or choose photos/PDFs,
 * downscale images on-device, upload with progress through an
 * IndexedDB-backed retry queue, and follow each capture into review.
 * Deliberately larger than the dense desktop theme: ≥44px touch targets and
 * 16px form text (prevents iOS focus zoom).
 */
import {
	IconCamera,
	IconCloudOff,
	IconFileUpload,
	IconLoader2,
	IconWifi,
} from "@tabler/icons-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { STORE_META } from "#/components/app/format";
import { prepareFile } from "#/features/capture/image";
import type { CaptureMeta } from "#/features/capture/queue";
import { useBootstrap } from "#/features/ledger/hooks";
import { cn } from "#/lib/utils";
import { STORE_IDS, type StoreId } from "#/shared/capture";
import { QueueList } from "./queue-list";
import { useCaptureQueue, useOnline } from "./use-capture-queue";

const CHOOSE_ACCEPT =
	"application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif";
const MAX_SOURCE_BYTES = 60 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export const touchInput =
	"h-11 w-full rounded-md border border-input bg-background px-3 text-base outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50";

export function CapturePage({
	shared,
	sharedFailed,
	onSharedHandled,
}: {
	shared: string[];
	sharedFailed: number | undefined;
	onSharedHandled: () => void;
}) {
	const { queue, snapshot } = useCaptureQueue();
	const online = useOnline();
	const { activeEntities } = useBootstrap();
	const camera = useRef<HTMLInputElement>(null);
	const chooser = useRef<HTMLInputElement>(null);
	const [preparing, setPreparing] = useState(0);
	const [kind, setKind] = useState<CaptureMeta["kind"]>("receipt");
	const [source, setSource] = useState<StoreId>("generic");
	const [entityId, setEntityId] = useState("");
	const [merchantHint, setMerchantHint] = useState("");
	const [note, setNote] = useState("");

	// Share-target redirect: remember server-created captures, then clean the URL.
	const sharedKey = shared.join(",");
	useEffect(() => {
		if (!queue || (!sharedKey && sharedFailed === undefined)) return;
		const ids = sharedKey ? sharedKey.split(",") : [];
		void queue
			.recordUploaded(
				ids.map((captureId) => ({ captureId })),
				{
					kind: "receipt",
					source: "generic",
					merchantHint: "",
					entityId: null,
					note: "",
				},
			)
			.then(() => {
				if (ids.length)
					toast.success(
						`Received ${ids.length} shared file${ids.length === 1 ? "" : "s"}`,
					);
				if (sharedFailed)
					toast.error(
						`${sharedFailed} shared file${sharedFailed === 1 ? " was" : "s were"} not accepted`,
					);
				onSharedHandled();
			});
	}, [queue, sharedKey, sharedFailed, onSharedHandled]);

	async function addFiles(
		list: FileList | null,
		input: HTMLInputElement | null,
	) {
		const files = Array.from(list ?? []);
		if (input) input.value = "";
		if (!files.length || !queue) return;
		const usable = files.filter(
			(f) =>
				f.size > 0 &&
				f.size <=
					(f.type === "application/pdf" ? MAX_PDF_BYTES : MAX_SOURCE_BYTES),
		);
		if (usable.length < files.length)
			toast.error("Skipped empty or oversized files (PDF ≤ 25 MB)");
		if (!usable.length) return;
		setPreparing((n) => n + usable.length);
		try {
			const prepared = [];
			for (const file of usable) {
				prepared.push(await prepareFile(file));
				setPreparing((n) => n - 1);
			}
			await queue.enqueue(prepared, {
				kind,
				source,
				merchantHint: merchantHint.trim(),
				entityId: entityId || null,
				note: note.trim(),
			});
			setMerchantHint("");
			setNote("");
			const summary = await queue.flush();
			if (summary.skipped === "offline")
				toast.message("Offline — saved on this device, will upload later");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not add files",
			);
		} finally {
			setPreparing(0);
		}
	}

	const waiting = snapshot.items.filter(
		(i) => i.status === "pending" || i.status === "failed",
	).length;
	const disabled = !queue || preparing > 0;

	return (
		<div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-sm">
			<header className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<h1 className="text-xl font-semibold tracking-tight">
						Capture receipt
					</h1>
					<p className="text-[13px] text-muted-foreground">
						Photos are shrunk on this phone, then queued for review.
					</p>
				</div>
				<span
					className={cn(
						"inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs",
						online
							? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
							: "border-amber-500/40 text-amber-600 dark:text-amber-400",
					)}
				>
					{online ? (
						<IconWifi className="size-4" />
					) : (
						<IconCloudOff className="size-4" />
					)}
					{online ? "Online" : "Offline"}
				</span>
			</header>

			<div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
				<button
					type="button"
					disabled={disabled}
					onClick={() => camera.current?.click()}
					className="flex h-20 items-center justify-center gap-3 rounded-lg border border-primary bg-primary text-lg font-semibold text-primary-foreground active:opacity-80 disabled:opacity-50"
				>
					{preparing > 0 ? (
						<IconLoader2 className="size-7 animate-spin" />
					) : (
						<IconCamera className="size-7" />
					)}
					{preparing > 0 ? "Preparing…" : "Take photo"}
				</button>
				<button
					type="button"
					disabled={disabled}
					onClick={() => chooser.current?.click()}
					className="flex h-20 items-center justify-center gap-3 rounded-lg border border-border bg-secondary text-lg font-medium text-secondary-foreground active:bg-accent disabled:opacity-50"
				>
					<IconFileUpload className="size-7" />
					Choose file
				</button>
				<input
					ref={camera}
					type="file"
					accept="image/*"
					capture="environment"
					multiple
					className="hidden"
					onChange={(e) => void addFiles(e.target.files, e.currentTarget)}
				/>
				<input
					ref={chooser}
					type="file"
					accept={CHOOSE_ACCEPT}
					multiple
					className="hidden"
					onChange={(e) => void addFiles(e.target.files, e.currentTarget)}
				/>
			</div>

			<details className="group rounded-lg border border-border bg-card">
				<summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 text-[15px] font-medium">
					Details for the next capture
					<span className="text-xs text-muted-foreground group-open:hidden">
						{[
							kind === "invoice" ? "Invoice" : "Receipt",
							merchantHint,
							entityId && "entity",
							note && "note",
						]
							.filter(Boolean)
							.join(" · ")}
					</span>
				</summary>
				<div className="flex flex-col gap-3 border-t border-border p-4">
					<div className="grid grid-cols-2 gap-3">
						<TouchField label="Type">
							<select
								className={touchInput}
								value={kind}
								onChange={(e) =>
									setKind(e.target.value === "invoice" ? "invoice" : "receipt")
								}
							>
								<option value="receipt">Receipt</option>
								<option value="invoice">Invoice</option>
							</select>
						</TouchField>
						<TouchField label="Store">
							<select
								className={touchInput}
								value={source}
								onChange={(e) => setSource(e.target.value as StoreId)}
							>
								{STORE_IDS.map((id) => (
									<option key={id} value={id}>
										{id === "generic" ? "Any / in-store" : STORE_META[id].label}
									</option>
								))}
							</select>
						</TouchField>
					</div>
					<TouchField label="Merchant">
						<input
							className={touchInput}
							value={merchantHint}
							maxLength={200}
							placeholder="e.g. Home Depot"
							autoComplete="off"
							onChange={(e) => setMerchantHint(e.target.value)}
						/>
					</TouchField>
					<TouchField label="Entity">
						<select
							className={touchInput}
							value={entityId}
							onChange={(e) => setEntityId(e.target.value)}
						>
							<option value="">Decide during review</option>
							{activeEntities.map((entity) => (
								<option key={entity.id} value={entity.id}>
									{entity.name}
								</option>
							))}
						</select>
					</TouchField>
					<TouchField label="Note">
						<textarea
							className={cn(touchInput, "h-auto min-h-20 py-2")}
							value={note}
							maxLength={2000}
							placeholder="What was this for?"
							onChange={(e) => setNote(e.target.value)}
						/>
					</TouchField>
				</div>
			</details>

			{!snapshot.persistent && (
				<p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-700 dark:text-amber-300">
					This browser is not keeping an offline copy (private mode or storage
					blocked). Keep this page open until uploads finish.
				</p>
			)}
			{snapshot.authRequired && (
				<p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[13px] text-red-700 dark:text-red-300">
					Your session expired. Sign in again in another tab, then tap Retry —
					queued photos are kept on this device.
				</p>
			)}

			<QueueList
				queue={queue}
				snapshot={snapshot}
				online={online}
				waiting={waiting}
			/>
		</div>
	);
}

export function TouchField({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: wraps its control
		<label className="flex flex-col gap-1.5">
			<span className="label-caps">{label}</span>
			{children}
		</label>
	);
}
