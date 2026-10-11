import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { FileView } from "../integrations/file-ui/contract";

export type { FileView } from "../integrations/file-ui/contract";

/** The application owns authentication, authorization, validation and persistence. */
export type FileUIClient = {
	list: (signal?: AbortSignal) => Promise<FileView[]>;
	upload: (
		file: File,
		idempotencyKey: string,
		signal: AbortSignal,
	) => Promise<FileView>;
	remove: (id: string) => Promise<FileView>;
	/** Return an authorized attachment endpoint, never an executable preview URL. */
	downloadUrl: (id: string) => string;
};

export type FileUIProps = {
	client: FileUIClient;
	maxBytes?: number;
	label?: string;
};

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const buttonClass =
	"rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";
const stateLabels: Record<FileView["state"], string> = {
	uploading: "Awaiting upload confirmation",
	ready: "Ready",
	"cleanup-pending": "Cleanup pending",
	removed: "Removed",
};

function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function attachmentUrl(client: FileUIClient, id: string) {
	try {
		const value = client.downloadUrl(id);
		if (!value.trim()) return undefined;
		const parsed = new URL(value, "https://file-ui.invalid");
		return parsed.protocol === "https:" || parsed.protocol === "http:"
			? value
			: undefined;
	} catch {
		return undefined;
	}
}

/** Keep the client identity stable; changing it clears all prior scope and pending UI. */
export function FileUI(props: FileUIProps) {
	const [scope, setScope] = useState({ client: props.client, generation: 0 });
	if (scope.client !== props.client) {
		setScope({ client: props.client, generation: scope.generation + 1 });
		return null;
	}
	return <FileUISession key={scope.generation} {...props} />;
}

function FileUISession({
	client,
	maxBytes = DEFAULT_MAX_BYTES,
	label = "Files",
}: FileUIProps) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
		throw new RangeError("FileUI maxBytes must be a positive safe integer");
	const id = useId();
	const [files, setFiles] = useState<FileView[]>([]);
	const [selection, setSelection] = useState<{
		file: File;
		key: string;
	} | null>(null);
	const [retry, setRetry] = useState(false);
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState<"upload" | "cancel" | "remove" | null>(
		null,
	);
	const [status, setStatus] = useState("Loading files…");
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const mounted = useRef(true);
	const listRequest = useRef<{
		controller: AbortController;
		token: symbol;
	} | null>(null);
	const mutation = useRef<{
		token: symbol;
		controller?: AbortController;
	} | null>(null);

	const loadFiles = useCallback(async () => {
		if (mutation.current) return;
		listRequest.current?.controller.abort();
		const request = { controller: new AbortController(), token: Symbol() };
		listRequest.current = request;
		setLoading(true);
		setError(null);
		setStatus("Loading files…");
		try {
			const result = await client.list(request.controller.signal);
			if (!mounted.current || listRequest.current?.token !== request.token)
				return;
			setFiles(result);
			setStatus(
				`${result.length} file${result.length === 1 ? "" : "s"} loaded.`,
			);
		} catch {
			if (!mounted.current || listRequest.current?.token !== request.token)
				return;
			setError(
				"Could not refresh files. The displayed list may be out of date.",
			);
			setStatus("");
		} finally {
			if (mounted.current && listRequest.current?.token === request.token) {
				listRequest.current = null;
				setLoading(false);
			}
		}
	}, [client]);

	useEffect(() => {
		mounted.current = true;
		void loadFiles();
		return () => {
			mounted.current = false;
			listRequest.current?.controller.abort();
			listRequest.current = null;
			mutation.current?.controller?.abort();
		};
	}, [loadFiles]);

	const stopListRequest = () => {
		listRequest.current?.controller.abort();
		listRequest.current = null;
		setLoading(false);
	};
	const upsert = (file: FileView) => {
		setFiles((current) => {
			const found = current.some((item) => item.id === file.id);
			return found
				? current.map((item) => (item.id === file.id ? file : item))
				: [file, ...current];
		});
	};
	const upload = async () => {
		// A ref closes the interval before React commits the disabled button.
		if (mutation.current || !selection) return;
		if (selection.file.size > maxBytes) {
			setError(`Choose a file no larger than ${formatBytes(maxBytes)}.`);
			return;
		}
		const operation = { token: Symbol(), controller: new AbortController() };
		mutation.current = operation;
		stopListRequest();
		setPending("upload");
		setError(null);
		setStatus(`Uploading ${selection.file.name}…`);
		try {
			// Retries reuse the very same File object and idempotency key.
			const result = await client.upload(
				selection.file,
				selection.key,
				operation.controller.signal,
			);
			if (!mounted.current || mutation.current?.token !== operation.token)
				return;
			upsert(result);
			if (result.state === "ready") {
				setStatus(
					operation.controller.signal.aborted
						? "The server confirmed the upload completed despite local cancellation."
						: `Uploaded ${result.name}.`,
				);
				setSelection(null);
				setRetry(false);
				if (input.current) input.current.value = "";
			} else {
				setRetry(true);
				setStatus(
					result.state === "uploading"
						? "Upload is awaiting confirmation. Refresh or retry this upload to check its status."
						: `Upload is not available: ${stateLabels[result.state].toLowerCase()}. Refresh to check its status.`,
				);
			}
		} catch {
			if (!mounted.current || mutation.current?.token !== operation.token)
				return;
			setRetry(true);
			if (operation.controller.signal.aborted) {
				setStatus(
					"Upload cancelled locally. The server may still have received it. Refresh or retry this upload to confirm.",
				);
			} else {
				setStatus("");
				setError(
					"Upload could not be confirmed. The server may still have received it. Refresh or retry this upload; its original file and request key are preserved.",
				);
			}
		} finally {
			if (mounted.current && mutation.current?.token === operation.token) {
				mutation.current = null;
				setPending(null);
			}
		}
	};
	const remove = async (file: FileView) => {
		if (mutation.current) return;
		const operation = { token: Symbol() };
		mutation.current = operation;
		stopListRequest();
		setPending("remove");
		setError(null);
		setStatus(`Removing ${file.name}…`);
		try {
			const result = await client.remove(file.id);
			if (!mounted.current || mutation.current?.token !== operation.token)
				return;
			upsert(result);
			setStatus(
				result.state === "removed"
					? `Removed ${result.name}.`
					: result.state === "cleanup-pending"
						? "Removal is pending storage cleanup. Refresh or retry removal to confirm."
						: "Removal has not been confirmed. Refresh to check the file status.",
			);
		} catch {
			if (!mounted.current || mutation.current?.token !== operation.token)
				return;
			setStatus("");
			setError(
				"Removal could not be confirmed. Refresh to check the file status before retrying.",
			);
		} finally {
			if (mounted.current && mutation.current?.token === operation.token) {
				mutation.current = null;
				setPending(null);
			}
		}
	};

	return (
		<section aria-labelledby={`${id}-heading`} className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h2 id={`${id}-heading`} className="text-xl font-semibold">
					{label}
				</h2>
				<button
					type="button"
					className={buttonClass}
					disabled={loading || pending !== null}
					onClick={() => void loadFiles()}
				>
					Refresh files
				</button>
			</div>
			<form
				className="space-y-3 rounded-lg border p-4"
				onSubmit={(event) => {
					event.preventDefault();
					void upload();
				}}
			>
				<label htmlFor={`${id}-file`} className="block font-medium">
					Choose a file
				</label>
				<input
					ref={input}
					id={`${id}-file`}
					type="file"
					aria-describedby={`${id}-limit ${id}-selection`}
					disabled={pending !== null}
					className="block max-w-full rounded-md text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					onChange={(event) => {
						if (mutation.current) return;
						const file = event.target.files?.[0];
						setError(null);
						setRetry(false);
						if (!file) {
							setSelection(null);
							return;
						}
						if (file.size > maxBytes) {
							setSelection(null);
							event.target.value = "";
							setError(
								`Choose a file no larger than ${formatBytes(maxBytes)}.`,
							);
							setStatus("");
							return;
						}
						setSelection({ file, key: crypto.randomUUID() });
						setStatus(`${file.name} selected. Ready to upload.`);
					}}
				/>
				<p id={`${id}-limit`} className="text-sm text-muted-foreground">
					Maximum size: {formatBytes(maxBytes)}. Files are downloaded as
					attachments. Only metadata is previewed here.
				</p>
				<p id={`${id}-selection`} className="break-all text-sm">
					{selection
						? `Selected: ${selection.file.name} (${formatBytes(selection.file.size)})`
						: "No file selected."}
				</p>
				<div className="flex flex-wrap gap-2">
					<button
						type="submit"
						className={buttonClass}
						disabled={!selection || pending !== null}
					>
						{retry ? "Retry upload" : "Upload file"}
					</button>
					{(pending === "upload" || pending === "cancel") && (
						<button
							type="button"
							className={buttonClass}
							disabled={pending === "cancel"}
							onClick={() => {
								const operation = mutation.current;
								if (
									!operation?.controller ||
									operation.controller.signal.aborted
								)
									return;
								operation.controller.abort();
								setPending("cancel");
								setStatus(
									"Cancellation requested. Waiting for this request to settle; the server may still finish the upload.",
								);
							}}
						>
							{pending === "cancel" ? "Cancelling…" : "Cancel upload"}
						</button>
					)}
					<button
						type="button"
						className={buttonClass}
						disabled={!selection || pending !== null}
						onClick={() => {
							if (mutation.current) return;
							setSelection(null);
							setStatus(
								retry
									? "Selection cleared. The earlier upload is still unconfirmed; refresh files to check it."
									: "Selection cleared.",
							);
							setRetry(false);
							if (input.current) input.current.value = "";
						}}
					>
						Clear selection
					</button>
				</div>
			</form>
			<output aria-live="polite" aria-atomic="true" className="block text-sm">
				{status}
			</output>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="overflow-x-auto rounded-lg border" aria-busy={loading}>
				<table className="w-full text-left text-sm">
					<caption className="sr-only">{label}</caption>
					<thead>
						<tr className="border-b">
							{["Name", "Size", "Status", "Actions"].map((heading) => (
								<th key={heading} scope="col" className="px-4 py-3">
									{heading}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{files.map((file) => {
							const url =
								file.state === "ready"
									? attachmentUrl(client, file.id)
									: undefined;
							return (
								<tr key={file.id} className="border-b last:border-0">
									<th
										scope="row"
										className="max-w-72 break-all px-4 py-3 font-medium"
									>
										{file.name}
									</th>
									<td className="whitespace-nowrap px-4 py-3">
										{formatBytes(file.size)}
									</td>
									<td className="px-4 py-3">{stateLabels[file.state]}</td>
									<td className="px-4 py-3">
										<div className="flex flex-wrap items-start gap-2">
											{url && (
												<a
													className={buttonClass}
													href={url}
													download={file.name}
													aria-label={`Download ${file.name}`}
												>
													Download
												</a>
											)}
											{file.state === "ready" && !url && (
												<span>Download unavailable</span>
											)}
											{file.state !== "removed" && (
												<button
													type="button"
													className={buttonClass}
													disabled={pending !== null}
													aria-label={`${file.state === "cleanup-pending" ? "Retry removal of" : "Remove"} ${file.name}`}
													onClick={() => void remove(file)}
												>
													{file.state === "cleanup-pending"
														? "Retry removal"
														: "Remove"}
												</button>
											)}
											<details className="max-w-72 break-all">
												<summary
													className="cursor-pointer rounded-md px-2 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
													aria-label={`Details for ${file.name}`}
												>
													Details
												</summary>
												<dl className="space-y-1 py-2">
													<dt className="font-medium">File name</dt>
													<dd>{file.name}</dd>
													<dt className="font-medium">Media type</dt>
													<dd>{file.type || "Not provided"}</dd>
													<dt className="font-medium">Size in bytes</dt>
													<dd>{file.size}</dd>
												</dl>
											</details>
										</div>
									</td>
								</tr>
							);
						})}
						{files.length === 0 && (
							<tr>
								<td colSpan={4} className="px-4 py-6 text-muted-foreground">
									{loading ? "Loading files…" : "No files to display."}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</section>
	);
}
