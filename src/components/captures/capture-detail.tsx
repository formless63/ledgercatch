import {
	IconCopy,
	IconDownload,
	IconExternalLink,
	IconEyeOff,
	IconRefresh,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import {
	CAPTURE_STATUS_TONES,
	formatBytes,
	storeLabel,
} from "#/components/app/format";
import {
	Button,
	SectionLabel,
	StoreMark,
	Tag,
} from "#/components/app/primitives";
import { ledgerKeys, useInvalidateLedger } from "#/features/ledger/hooks";
import {
	getCapture,
	ignoreCapture,
	reprocessCaptures,
} from "#/features/ledger/ledger.functions";
import { getCaptureFixture } from "#/features/ledger/review-ui.functions";
import { cn } from "#/lib/utils";
import { Drawer, downloadText, errorMessage, MetaList } from "./drawer";

/** Characters rendered in the payload viewer before "show all". */
const PREVIEW_CHARS = 120_000;

export function CaptureDetailDrawer({
	captureId,
	onClose,
}: {
	captureId: string | null;
	onClose: () => void;
}) {
	const invalidate = useInvalidateLedger();
	const query = useQuery({
		queryKey: ledgerKeys.capture(captureId ?? "none"),
		queryFn: () => getCapture({ data: { id: captureId as string } }),
		enabled: !!captureId,
		refetchInterval: 10_000,
	});
	const capture = query.data;

	const reprocess = useMutation({
		mutationFn: (id: string) => reprocessCaptures({ data: { ids: [id] } }),
		onSuccess: () => {
			toast.success("Queued for re-processing");
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const ignore = useMutation({
		mutationFn: (id: string) => ignoreCapture({ data: { id } }),
		onSuccess: () => {
			toast.success("Capture ignored");
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const fixture = useMutation({
		mutationFn: (id: string) => getCaptureFixture({ data: { id } }),
		onSuccess: (result) => {
			downloadText(result.fileName, result.json, "application/json");
			toast.success(`Downloaded ${result.fileName}`);
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	return (
		<Drawer
			open={!!captureId}
			onClose={onClose}
			title={capture ? capture.pageTitle || capture.pageUrl : "Capture details"}
			subtitle={
				<span className="font-mono">{captureId?.slice(0, 8) ?? ""}</span>
			}
			actions={
				capture && (
					<>
						<Button
							disabled={reprocess.isPending}
							onClick={() => reprocess.mutate(capture.id)}
						>
							<IconRefresh />
							Re-process
						</Button>
						<Button
							variant="ghost"
							disabled={ignore.isPending || capture.status === "ignored"}
							onClick={() => ignore.mutate(capture.id)}
						>
							<IconEyeOff />
							Ignore
						</Button>
					</>
				)
			}
		>
			{query.isError ? (
				<div className="p-4 text-xs text-red-600 dark:text-red-400">
					{errorMessage(query.error)}
				</div>
			) : !capture ? (
				<div className="p-4 text-xs text-muted-foreground">Loading…</div>
			) : (
				<div className="flex flex-col gap-4 p-3">
					<MetaList
						items={[
							{
								label: "Status",
								value: (
									<Tag tone={CAPTURE_STATUS_TONES[capture.status] ?? "neutral"}>
										{capture.status.replace(/_/g, " ")}
									</Tag>
								),
							},
							{ label: "Store", value: <StoreMark source={capture.source} /> },
							{
								label: "Kind",
								value: (
									<span className="font-mono">
										{capture.kind} · {capture.trigger} · {capture.pageType}
									</span>
								),
							},
							{
								label: "Page",
								value: (
									<a
										href={capture.pageUrl}
										target="_blank"
										rel="noreferrer noopener"
										className="inline-flex items-center gap-1 break-all font-mono text-[11px] text-primary hover:underline"
									>
										{capture.pageUrl}
										<IconExternalLink className="size-3 shrink-0" />
									</a>
								),
							},
							...(capture.requestUrl
								? [
										{
											label: "Request",
											value: (
												<span className="break-all font-mono text-[11px]">
													{capture.requestUrl}
												</span>
											),
										},
									]
								: []),
							{
								label: "Captured",
								value: (
									<span className="font-mono tabular-nums">
										{new Date(capture.capturedAt).toLocaleString()}
									</span>
								),
							},
							{
								label: "Received",
								value: (
									<span className="font-mono tabular-nums">
										{new Date(capture.receivedAt).toLocaleString()}
									</span>
								),
							},
							{
								label: "Parsed",
								value: (
									<span className="font-mono tabular-nums">
										{capture.parsedAt
											? new Date(capture.parsedAt).toLocaleString()
											: "—"}
									</span>
								),
							},
							{
								label: "Parser",
								value: (
									<span className="font-mono">
										{capture.parserId
											? `${capture.parserId}@${capture.parserVersion ?? "?"}`
											: "—"}
									</span>
								),
							},
							{
								label: "Extension",
								value: (
									<span className="font-mono">
										{capture.extensionVersion || "—"}
									</span>
								),
							},
							{
								label: "Order hints",
								value: capture.orderIdHints.length ? (
									<span className="font-mono text-[11px]">
										{capture.orderIdHints.join(", ")}
									</span>
								) : (
									"—"
								),
							},
							{
								label: "Hash",
								value: (
									<span className="break-all font-mono text-[10px] text-muted-foreground">
										{capture.contentHash}
									</span>
								),
							},
							...(capture.note ? [{ label: "Note", value: capture.note }] : []),
						]}
					/>

					{capture.error && (
						<section aria-label="Error">
							<SectionLabel className="mb-1">Error</SectionLabel>
							<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-red-500/30 bg-red-500/10 p-2 font-mono text-[11px] text-red-700 dark:text-red-300">
								{capture.error}
							</pre>
						</section>
					)}

					<section aria-label="Linked orders">
						<SectionLabel className="mb-1">
							Linked orders ({capture.orders.length})
						</SectionLabel>
						{capture.orders.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								No orders linked to this capture.
							</p>
						) : (
							<ul className="flex flex-wrap gap-1.5">
								{capture.orders.map((order) => (
									<li key={order.id}>
										<Link
											to="/app/orders/$orderId"
											params={{ orderId: order.id }}
											className="inline-flex h-6 items-center gap-1.5 rounded-sm border border-border bg-muted px-2 font-mono text-[11px] hover:bg-accent"
										>
											<span className="text-muted-foreground">
												{storeLabel(order.source)}
											</span>
											{order.externalOrderId ?? order.id.slice(0, 8)}
										</Link>
									</li>
								))}
							</ul>
						)}
					</section>

					{capture.screenshotDocumentId && (
						<section aria-label="Screenshot">
							<SectionLabel className="mb-1">Screenshot</SectionLabel>
							<a
								href={`/api/documents/${capture.screenshotDocumentId}`}
								target="_blank"
								rel="noreferrer"
							>
								<img
									src={`/api/documents/${capture.screenshotDocumentId}`}
									alt={`Screenshot of ${capture.pageTitle || capture.pageUrl}`}
									className="max-h-80 w-full rounded-sm border border-border object-contain object-top"
									loading="lazy"
								/>
							</a>
						</section>
					)}

					<PayloadViewer
						text={capture.bodyJsonText ?? capture.bodyText}
						isJson={capture.bodyJsonText != null}
						truncated={capture.truncated}
						fixturePending={fixture.isPending}
						onFixture={() => fixture.mutate(capture.id)}
					/>
				</div>
			)}
		</Drawer>
	);
}

function PayloadViewer({
	text,
	isJson,
	truncated,
	fixturePending,
	onFixture,
}: {
	text: string | null;
	isJson: boolean;
	truncated: boolean;
	fixturePending: boolean;
	onFixture: () => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const [wrap, setWrap] = useState(true);
	const body = text ?? "";
	const visible = showAll ? body : body.slice(0, PREVIEW_CHARS);
	return (
		<section aria-label="Raw payload" className="flex flex-col gap-1.5">
			<SectionLabel
				action={
					<div className="flex flex-wrap items-center gap-1">
						<Button
							size="xs"
							variant="ghost"
							aria-pressed={wrap}
							onClick={() => setWrap((value) => !value)}
						>
							Wrap
						</Button>
						<Button
							size="xs"
							disabled={!body}
							onClick={() =>
								void navigator.clipboard
									.writeText(body)
									.then(() =>
										toast.success(
											truncated
												? "Copied (truncated preview — download the fixture for the full payload)"
												: "Payload copied",
										),
									)
									.catch(() => toast.error("Clipboard unavailable"))
							}
						>
							<IconCopy />
							Copy
						</Button>
						<Button size="xs" disabled={fixturePending} onClick={onFixture}>
							<IconDownload />
							Download as fixture
						</Button>
					</div>
				}
			>
				Raw payload · {isJson ? "JSON" : "text / HTML source"} ·{" "}
				{formatBytes(body.length)}
			</SectionLabel>
			{truncated && (
				<p className="text-[11px] text-amber-600 dark:text-amber-400">
					Server preview is truncated; the fixture download contains the full
					payload.
				</p>
			)}
			{body ? (
				<pre
					// biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
					tabIndex={0}
					className={cn(
						"max-h-[60vh] overflow-auto rounded-sm border border-border bg-background p-2 font-mono text-[11px] leading-relaxed",
						wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
					)}
				>
					{visible}
				</pre>
			) : (
				<p className="text-xs text-muted-foreground">Empty payload.</p>
			)}
			{body.length > PREVIEW_CHARS && !showAll && (
				<Button
					size="xs"
					variant="ghost"
					className="self-start"
					onClick={() => setShowAll(true)}
				>
					Show all ({formatBytes(body.length)})
				</Button>
			)}
		</section>
	);
}
