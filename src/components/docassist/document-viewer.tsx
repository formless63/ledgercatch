/**
 * Document canvas for assisted review: renders PDF pages (pdf.js) or an
 * image, overlays extracted word boxes, glows the boxes behind form fields,
 * and lets the user click or drag-select words to fill the active field.
 */
import {
	IconLoader2,
	IconZoomIn,
	IconZoomOut,
	IconZoomReset,
} from "@tabler/icons-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button, Kbd } from "#/components/app/primitives";
import {
	type BBox,
	type DocumentLayout,
	refKey,
	refsInRect,
	type WordRef,
} from "#/features/ingress/documents/layout";
import { cn } from "#/lib/utils";
import { hexAlpha } from "./field-meta";
import { openPdf } from "./pdf-client";

export type Highlight = { color: string; strong?: boolean; title?: string };

type PageSize = { width: number; height: number };

export function DocumentViewer({
	documentUrl,
	contentType,
	layout,
	highlights,
	focusRefs,
	picking,
	onPick,
	className,
}: {
	documentUrl: string | null;
	contentType: string | null;
	layout: DocumentLayout | null;
	/** refKey → highlight. */
	highlights: Map<string, Highlight>;
	/** Scrolls the first of these word boxes into view when it changes. */
	focusRefs?: WordRef[] | null;
	/** Active pick target (enables click/drag selection). */
	picking: { color: string; label: string } | null;
	onPick: (refs: WordRef[], append: boolean) => void;
	className?: string;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [containerWidth, setContainerWidth] = useState(0);
	const [zoom, setZoom] = useState(1);
	const isPdf = contentType === "application/pdf";
	const isImage = !!contentType?.startsWith("image/");
	const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
	const [pdfSizes, setPdfSizes] = useState<PageSize[]>([]);
	const [imageSize, setImageSize] = useState<PageSize | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			setContainerWidth(Math.max(0, Math.floor(width) - 24));
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!isPdf || !documentUrl) return;
		let cancelled = false;
		let destroy: (() => void) | undefined;
		setPdf(null);
		setLoadError(null);
		openPdf(documentUrl)
			.then(async (opened) => {
				destroy = opened.destroy;
				if (cancelled) return opened.destroy();
				const count = Math.min(opened.doc.numPages, 20);
				const sizes: PageSize[] = [];
				for (let n = 1; n <= count; n++) {
					const page = await opened.doc.getPage(n);
					const vp = page.getViewport({ scale: 1 });
					sizes.push({ width: vp.width, height: vp.height });
				}
				if (cancelled) return;
				setPdfSizes(sizes);
				setPdf(opened.doc);
			})
			.catch((error: unknown) => {
				if (!cancelled)
					setLoadError(
						error instanceof Error ? error.message : "PDF failed to load",
					);
			});
		return () => {
			cancelled = true;
			destroy?.();
		};
	}, [documentUrl, isPdf]);

	const pages: PageSize[] = useMemo(() => {
		if (isPdf)
			return pdfSizes.map((size, i) => {
				const lp = layout?.pages[i];
				return lp && !layout?.synthetic
					? { width: lp.width, height: lp.height }
					: size;
			});
		if (isImage) {
			const lp = layout?.pages[0];
			if (lp && !layout?.synthetic)
				return [{ width: lp.width, height: lp.height }];
			return imageSize ? [imageSize] : [];
		}
		return [];
	}, [isPdf, isImage, pdfSizes, layout, imageSize]);

	useEffect(() => {
		const first = focusRefs?.[0];
		if (!first) return;
		const el = scrollRef.current?.querySelector<HTMLElement>(
			`[data-ref="${refKey(first)}"]`,
		);
		el?.scrollIntoView({
			block: "center",
			inline: "nearest",
			behavior: "smooth",
		});
	}, [focusRefs]);

	const fitWidth = containerWidth > 0 ? containerWidth : 600;
	const overlayEnabled = !!layout && !layout.synthetic;

	return (
		<div className={cn("flex min-h-0 flex-col bg-muted/40", className)}>
			<div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-card px-2">
				{picking ? (
					<span className="flex min-w-0 items-center gap-1.5 text-[11px]">
						<span
							className="size-2 shrink-0 rounded-full"
							style={{ background: picking.color }}
						/>
						<span className="truncate">
							Filling <strong>{picking.label}</strong> — click a word or drag a
							box; <Kbd>Shift</Kbd> adds
						</span>
					</span>
				) : (
					<span className="truncate text-[11px] text-muted-foreground">
						{overlayEnabled
							? "Focus a field, then click or drag on the document to fill it"
							: layout?.synthetic
								? "Text without positions — run OCR to enable box selection"
								: "No word boxes yet"}
					</span>
				)}
				<div className="ml-auto flex items-center gap-0.5">
					<Button
						variant="ghost"
						size="xs"
						aria-label="Zoom out"
						onClick={() => setZoom((z) => Math.max(0.5, z / 1.25))}
					>
						<IconZoomOut />
					</Button>
					<span className="w-9 text-center font-mono text-[10px] tabular-nums text-muted-foreground">
						{Math.round(zoom * 100)}%
					</span>
					<Button
						variant="ghost"
						size="xs"
						aria-label="Zoom in"
						onClick={() => setZoom((z) => Math.min(4, z * 1.25))}
					>
						<IconZoomIn />
					</Button>
					<Button
						variant="ghost"
						size="xs"
						aria-label="Fit width"
						onClick={() => setZoom(1)}
					>
						<IconZoomReset />
					</Button>
				</div>
			</div>
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-3">
				{!documentUrl && (
					<div className="py-16 text-center text-xs text-muted-foreground">
						No file attached to this capture.
					</div>
				)}
				{loadError && (
					<div className="py-16 text-center text-xs text-red-500">
						{loadError}
					</div>
				)}
				{isPdf && documentUrl && !pdf && !loadError && (
					<div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
						<IconLoader2 className="size-4 animate-spin" /> Loading PDF…
					</div>
				)}
				{isImage && documentUrl && pages.length === 0 && (
					// Measure the image when no layout gives its size yet.
					<img
						src={documentUrl}
						alt=""
						className="hidden"
						onLoad={(event) =>
							setImageSize({
								width: event.currentTarget.naturalWidth,
								height: event.currentTarget.naturalHeight,
							})
						}
					/>
				)}
				<div className="mx-auto flex w-fit flex-col gap-3">
					{pages.map((size, index) => {
						const cssWidth = Math.round(fitWidth * zoom);
						const cssHeight = Math.round((cssWidth * size.height) / size.width);
						return (
							<PageView
								// biome-ignore lint/suspicious/noArrayIndexKey: pages are positional
								key={index}
								index={index}
								width={cssWidth}
								height={cssHeight}
								size={size}
								pdf={isPdf ? pdf : null}
								imageUrl={isImage ? documentUrl : null}
								layout={overlayEnabled ? layout : null}
								highlights={highlights}
								picking={picking}
								onPick={onPick}
							/>
						);
					})}
				</div>
			</div>
		</div>
	);
}

function PageView({
	index,
	width,
	height,
	size,
	pdf,
	imageUrl,
	layout,
	highlights,
	picking,
	onPick,
}: {
	index: number;
	width: number;
	height: number;
	size: PageSize;
	pdf: PDFDocumentProxy | null;
	imageUrl: string | null;
	layout: DocumentLayout | null;
	highlights: Map<string, Highlight>;
	picking: { color: string; label: string } | null;
	onPick: (refs: WordRef[], append: boolean) => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<{
		start: [number, number];
		end: [number, number];
	} | null>(null);
	const [hover, setHover] = useState<number | null>(null);
	const words = layout?.pages[index]?.words ?? [];

	useEffect(() => {
		if (!pdf || !canvasRef.current || width <= 0) return;
		let task: RenderTask | null = null;
		let cancelled = false;
		const canvas = canvasRef.current;
		void pdf.getPage(index + 1).then((page) => {
			if (cancelled) return;
			const base = page.getViewport({ scale: 1 });
			const ratio = window.devicePixelRatio || 1;
			const viewport = page.getViewport({
				scale: (width / base.width) * ratio,
			});
			canvas.width = Math.floor(viewport.width);
			canvas.height = Math.floor(viewport.height);
			task = page.render({ canvas, viewport });
			task.promise.catch(() => {});
		});
		return () => {
			cancelled = true;
			task?.cancel();
		};
	}, [pdf, index, width]);

	const toPage = (event: ReactPointerEvent): [number, number] => {
		const rect = overlayRef.current?.getBoundingClientRect();
		if (!rect) return [0, 0];
		return [
			((event.clientX - rect.left) / rect.width) * size.width,
			((event.clientY - rect.top) / rect.height) * size.height,
		];
	};

	const wordAtPoint = ([x, y]: [number, number]) => {
		let best = -1;
		let bestDist = Number.POSITIVE_INFINITY;
		const slack = size.width * 0.004;
		words.forEach((word, i) => {
			const [x0, y0, x1, y1] = word.bbox;
			const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
			const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
			const d = Math.hypot(dx, dy);
			if (d < bestDist) {
				bestDist = d;
				best = i;
			}
		});
		return bestDist <= slack ? best : -1;
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!picking || !layout || event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		const point = toPage(event);
		setDrag({ start: point, end: point });
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!picking || !layout) return;
		const point = toPage(event);
		if (drag) setDrag({ ...drag, end: point });
		else {
			const i = wordAtPoint(point);
			setHover(i >= 0 ? i : null);
		}
	};
	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!drag || !layout) return;
		const [sx, sy] = drag.start;
		const [ex, ey] = toPage(event);
		setDrag(null);
		const moved = Math.hypot(
			((ex - sx) / size.width) * width,
			((ey - sy) / size.height) * height,
		);
		if (moved < 4) {
			const i = wordAtPoint([ex, ey]);
			if (i >= 0) onPick([{ page: index, index: i }], event.shiftKey);
			return;
		}
		const rect: BBox = [
			Math.min(sx, ex),
			Math.min(sy, ey),
			Math.max(sx, ex),
			Math.max(sy, ey),
		];
		const refs = refsInRect(layout, index, rect);
		if (refs.length) onPick(refs, event.shiftKey);
	};

	const pct = (v: number, of: number) => `${(v / of) * 100}%`;
	const dragRect: BBox | null = drag
		? [
				Math.min(drag.start[0], drag.end[0]),
				Math.min(drag.start[1], drag.end[1]),
				Math.max(drag.start[0], drag.end[0]),
				Math.max(drag.start[1], drag.end[1]),
			]
		: null;

	return (
		<div
			className="relative bg-white shadow-sm ring-1 ring-border"
			style={{ width, height }}
		>
			{pdf && <canvas ref={canvasRef} className="absolute inset-0 size-full" />}
			{imageUrl && (
				<img
					src={imageUrl}
					alt={`Page ${index + 1}`}
					className="absolute inset-0 size-full select-none"
					draggable={false}
				/>
			)}
			<div
				ref={overlayRef}
				className={cn(
					"absolute inset-0 select-none",
					picking && layout && "cursor-crosshair",
				)}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerLeave={() => setHover(null)}
			>
				{words.map((word, i) => {
					const key = `${index}:${i}`;
					const hl = highlights.get(key);
					const isHover = hover === i && !!picking;
					if (!hl && !isHover && !picking) return null;
					const [x0, y0, x1, y1] = word.bbox;
					const color = hl?.color ?? picking?.color ?? "#38bdf8";
					return (
						<div
							key={key}
							data-ref={key}
							title={hl?.title}
							className="pointer-events-none absolute rounded-[2px] transition-shadow"
							style={{
								left: pct(x0, size.width),
								top: pct(y0, size.height),
								width: pct(x1 - x0, size.width),
								height: pct(y1 - y0, size.height),
								background: hl
									? hexAlpha(color, hl.strong ? 0.38 : 0.2)
									: isHover
										? hexAlpha(color, 0.25)
										: "transparent",
								outline: hl
									? `1px solid ${hexAlpha(color, hl.strong ? 1 : 0.7)}`
									: `1px solid ${hexAlpha(color, isHover ? 0.9 : 0.18)}`,
								boxShadow: hl?.strong
									? `0 0 0 2px ${hexAlpha(color, 0.55)}, 0 0 10px 2px ${hexAlpha(color, 0.6)}`
									: undefined,
							}}
						/>
					);
				})}
				{dragRect && (
					<div
						className="pointer-events-none absolute border border-dashed"
						style={{
							left: pct(dragRect[0], size.width),
							top: pct(dragRect[1], size.height),
							width: pct(dragRect[2] - dragRect[0], size.width),
							height: pct(dragRect[3] - dragRect[1], size.height),
							borderColor: picking?.color,
							background: hexAlpha(picking?.color ?? "#38bdf8", 0.1),
						}}
					/>
				)}
			</div>
			<span className="pointer-events-none absolute right-1 bottom-1 rounded-sm bg-black/50 px-1 font-mono text-[9px] text-white">
				{index + 1}
			</span>
		</div>
	);
}
