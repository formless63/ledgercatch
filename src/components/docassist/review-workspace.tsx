/**
 * Review workspace: the document (left) with word boxes, the order form
 * (right). Pre-filled fields glow their source boxes; focusing a field and
 * clicking/dragging on the document fills it (money/date parsing applied).
 */
import {
	IconBan,
	IconExternalLink,
	IconLink,
	IconLoader2,
	IconPlus,
	IconRefresh,
	IconScan,
	IconSparkles,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { formatDate, storeLabel } from "#/components/app/format";
import {
	Button,
	Input,
	Kbd,
	Money,
	Select,
	Tag,
	Textarea,
} from "#/components/app/primitives";
import {
	CategorySelect,
	EntitySelect,
	errorMessage,
} from "#/components/orders/shared";
import {
	type DocumentExtraction,
	decimalToMinor,
	FIELD_KEYS,
	type FieldKey,
	type FieldVia,
	parseFieldValue,
} from "#/features/ingress/documents/fields";
import {
	refKey,
	textOfRefs,
	type WordRef,
} from "#/features/ingress/documents/layout";
import {
	analyzeDocument,
	attachDocumentCapture,
	createOrderFromDocument,
	ignoreDocumentCapture,
	restoreDocumentCapture,
	searchOrdersForAttach,
} from "#/features/ingress/documents/review-ui.functions";
import type { DocumentReview } from "#/features/ingress/documents/review-ui.server";
import { useBootstrap, useInvalidateLedger } from "#/features/ledger/hooks";
import { cn } from "#/lib/utils";
import { DocumentViewer, type Highlight } from "./document-viewer";
import { FIELD_META, FORM_FIELDS, hexAlpha, ITEM_COLOR } from "./field-meta";

type ItemCol = "title" | "quantity" | "unitPrice" | "total";
const ITEM_COLS: ItemCol[] = ["title", "quantity", "unitPrice", "total"];

type ItemDraft = {
	key: number;
	title: string;
	quantity: string;
	unitPrice: string;
	total: string;
	refs: WordRef[];
};

type Target =
	| { type: "field"; key: FieldKey }
	| { type: "item"; index: number; col: ItemCol };

type FieldState = {
	value: string;
	refs: WordRef[];
	via?: FieldVia | "manual";
	confidence?: number;
};

let itemKey = 1;

function initialFields(extraction: DocumentExtraction | null) {
	const out = {} as Record<FieldKey, FieldState>;
	for (const key of FIELD_KEYS) {
		const guess = extraction?.fields[key];
		out[key] = guess
			? {
					value: guess.value,
					refs: guess.refs,
					via: guess.via,
					confidence: guess.confidence,
				}
			: { value: "", refs: [] };
	}
	if (!out.currency.value) out.currency = { value: "USD", refs: [] };
	return out;
}

function initialItems(extraction: DocumentExtraction | null): ItemDraft[] {
	return (extraction?.items ?? []).map((item) => ({
		key: itemKey++,
		title: item.title,
		quantity: item.quantity || "1",
		unitPrice: item.unitPrice ?? "",
		total: item.total ?? "",
		refs: item.refs,
	}));
}

/** "2 x Widget blue $4.00 $8.00" → columns. */
function splitItemRow(text: string, currency: string) {
	const money = [
		...text.matchAll(
			/[-−]?[$€£¥]?\s?\d[\d,.' ]*[.,]\d{2}\b(?:\s?[€A-Z]{1,3})?/g,
		),
	];
	let title = text;
	const out: Partial<Record<ItemCol, string>> = {};
	if (money.length) {
		const first = money[0];
		title = text.slice(0, first?.index ?? text.length).trim();
		const last = money[money.length - 1]?.[0];
		out.total = last ? parseFieldValue("total", last, { currency }) : undefined;
		if (money.length >= 2) {
			const unit = money[money.length - 2]?.[0];
			out.unitPrice = unit
				? parseFieldValue("total", unit, { currency })
				: undefined;
		}
	}
	const qty =
		/^(\d{1,4})\s*[x×]?\s+(.+)$/.exec(title) ??
		/^(.+?)\s+(\d{1,4})$/.exec(title);
	if (qty?.[1] && qty[2]) {
		if (/^\d+$/.test(qty[1])) {
			out.quantity = qty[1];
			title = qty[2];
		} else {
			out.quantity = qty[2];
			title = qty[1];
		}
	}
	out.title = title.trim();
	return out;
}

function sameTarget(a: Target | null, b: Target | null) {
	if (!a || !b) return false;
	if (a.type === "field" && b.type === "field") return a.key === b.key;
	if (a.type === "item" && b.type === "item")
		return a.index === b.index && a.col === b.col;
	return false;
}

const targetId = (t: Target) =>
	t.type === "field" ? `f:${t.key}` : `i:${t.index}:${t.col}`;

export function ReviewWorkspace({
	review,
	onResolved,
	onAnalyzed,
}: {
	review: DocumentReview;
	onResolved: () => void;
	onAnalyzed: (next: DocumentReview) => void;
}) {
	const { activeEntities, activeCategories } = useBootstrap();
	const invalidate = useInvalidateLedger();
	const { capture, document: doc, layout, extraction, linkedOrders } = review;
	const [fields, setFields] = useState(() => initialFields(extraction));
	const [items, setItems] = useState<ItemDraft[]>(() =>
		initialItems(extraction),
	);
	const [entityId, setEntityId] = useState<string | null>(null);
	const [categoryId, setCategoryId] = useState<string | null>(null);
	const [documentKind, setDocumentKind] = useState<"invoice" | "receipt">(
		doc?.kind === "receipt" ? "receipt" : "invoice",
	);
	const [notes, setNotes] = useState("");
	const [learn, setLearn] = useState(true);
	const [target, setTarget] = useState<Target | null>(null);
	const [hovered, setHovered] = useState<Target | null>(null);
	const [focusRefs, setFocusRefs] = useState<WordRef[] | null>(null);
	const [attachOpen, setAttachOpen] = useState(false);
	const inputs = useRef(new Map<string, HTMLInputElement | null>());
	const resolved = linkedOrders.length > 0 || capture.status === "ignored";

	const currency = fields.currency.value.toUpperCase();
	const dayFirst = currency ? !["USD", "CAD", "PHP"].includes(currency) : false;

	const setField = (key: FieldKey, next: Partial<FieldState>) =>
		setFields((prev) => ({ ...prev, [key]: { ...prev[key], ...next } }));

	const refsOf = useCallback(
		(t: Target | null): WordRef[] => {
			if (!t) return [];
			if (t.type === "field") return fields[t.key].refs;
			return items[t.index]?.refs ?? [];
		},
		[fields, items],
	);

	const focusTarget = (t: Target) => {
		const el = inputs.current.get(targetId(t));
		if (el) {
			el.focus();
			el.select();
		}
	};

	const activate = (t: Target) => {
		setTarget(t);
		const refs = refsOf(t);
		if (refs.length) setFocusRefs(refs);
	};

	/* highlights: every field's source boxes, glowing for hovered/active */
	const highlights = useMemo(() => {
		const map = new Map<string, Highlight>();
		items.forEach((item, index) => {
			const strong =
				(hovered?.type === "item" && hovered.index === index) ||
				(target?.type === "item" && target.index === index);
			for (const ref of item.refs)
				map.set(refKey(ref), {
					color: ITEM_COLOR,
					strong,
					title: `Item ${index + 1}`,
				});
		});
		for (const key of FORM_FIELDS) {
			const state = fields[key];
			const strong =
				(hovered?.type === "field" && hovered.key === key) ||
				(target?.type === "field" && target.key === key);
			for (const ref of state.refs)
				map.set(refKey(ref), {
					color: FIELD_META[key].color,
					strong,
					title: FIELD_META[key].label,
				});
		}
		return map;
	}, [fields, items, hovered, target]);

	const onPick = (picked: WordRef[], append: boolean) => {
		if (!target || !layout) return;
		if (target.type === "field") {
			const key = target.key;
			const refs = append ? [...fields[key].refs, ...picked] : picked;
			const text = textOfRefs(layout, refs);
			const parsed = parseFieldValue(key, text, { currency, dayFirst });
			if (!parsed) {
				toast.error(
					`Couldn't read ${FIELD_META[key].label.toLowerCase()} from “${text.slice(0, 60)}”`,
				);
				return;
			}
			setField(key, { value: parsed, refs, via: "manual", confidence: 1 });
			if (key === "total" || key === "subtotal") {
				const detected = parseFieldValue("currency", text);
				if (detected && !fields.currency.refs.length && detected !== currency)
					setField("currency", { value: detected, via: "manual" });
			}
		} else {
			const item = items[target.index];
			if (!item) return;
			const refs = append ? [...item.refs, ...picked] : picked;
			const text = textOfRefs(layout, append ? picked : refs);
			let patch: Partial<ItemDraft> = {};
			if (target.col === "title") {
				const split = splitItemRow(text, currency);
				patch = append
					? { title: `${item.title} ${text}`.trim() }
					: {
							title: split.title ?? text,
							...(split.quantity ? { quantity: split.quantity } : {}),
							...(split.unitPrice ? { unitPrice: split.unitPrice } : {}),
							...(split.total ? { total: split.total } : {}),
						};
			} else if (target.col === "quantity") {
				const q = /\d+(?:[.,]\d+)?/.exec(text)?.[0]?.replace(",", ".");
				if (q) patch = { quantity: q };
			} else {
				const v = parseFieldValue("total", text, { currency });
				if (v) patch = { [target.col]: v };
			}
			setItems((prev) =>
				prev.map((it, i) =>
					i === target.index ? { ...it, ...patch, refs } : it,
				),
			);
		}
		requestAnimationFrame(() => focusTarget(target));
	};

	/* keyboard: Enter → next field, Ctrl/⌘+Enter → create, Esc → stop picking */
	const order: Target[] = useMemo(
		() => [
			...FORM_FIELDS.map((key) => ({ type: "field", key }) as Target),
			...items.flatMap((_, index) =>
				ITEM_COLS.map((col) => ({ type: "item", index, col }) as Target),
			),
		],
		[items],
	);

	const onFieldKeyDown = (
		event: KeyboardEvent<HTMLInputElement>,
		t: Target,
	) => {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit();
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const i = order.findIndex((o) => sameTarget(o, t));
			const next = order[i + 1];
			if (next) {
				activate(next);
				focusTarget(next);
			} else submit();
		}
		if (event.key === "Escape") {
			setTarget(null);
			event.currentTarget.blur();
		}
	};

	/* totals check */
	const sumCheck = useMemo(() => {
		const m = (k: FieldKey) => decimalToMinor(fields[k].value, currency);
		const total = m("total");
		const subtotal = m("subtotal");
		if (total === undefined || subtotal === undefined) return null;
		const sum =
			subtotal +
			(m("shipping") ?? 0) +
			(m("tax") ?? 0) -
			Math.abs(m("discount") ?? 0);
		return { ok: Math.abs(sum - total) <= 1, sum, total };
	}, [fields, currency]);
	const itemsSum = useMemo(() => {
		const totals = items.map((it) => decimalToMinor(it.total, currency));
		if (!totals.length || totals.some((t) => t === undefined)) return null;
		return totals.reduce<number>((s, t) => s + (t ?? 0), 0);
	}, [items, currency]);

	/* mutations */
	const create = useMutation({
		mutationFn: () => {
			const fieldRefs: Partial<Record<FieldKey, WordRef[]>> = {};
			for (const key of FIELD_KEYS)
				if (fields[key].refs.length) fieldRefs[key] = fields[key].refs;
			return createOrderFromDocument({
				data: {
					captureId: capture.id,
					merchantName: fields.merchantName.value.trim(),
					externalOrderId: fields.externalOrderId.value.trim() || undefined,
					orderDate: fields.orderDate.value || undefined,
					currency,
					subtotal: fields.subtotal.value || undefined,
					shipping: fields.shipping.value || undefined,
					tax: fields.tax.value || undefined,
					discount: fields.discount.value || undefined,
					total: fields.total.value,
					paymentLast4: fields.paymentLast4.value || undefined,
					entityId,
					categoryId,
					documentKind,
					notes: notes.trim() || undefined,
					items: items
						.filter((it) => it.title.trim())
						.map((it) => ({
							title: it.title.trim(),
							quantity:
								Number.parseFloat(it.quantity) > 0
									? Number.parseFloat(it.quantity)
									: 1,
							unitPrice: it.unitPrice || undefined,
							total: it.total || undefined,
						})),
					fieldRefs,
					learn,
				},
			});
		},
		onSuccess: (result) => {
			if (!result.ok) {
				toast.error(result.message, {
					action: {
						label: "Attach",
						onClick: () => attach.mutate(result.existingOrderId),
					},
				});
				return;
			}
			toast.success("Order created from document");
			void invalidate();
			onResolved();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	const attach = useMutation({
		mutationFn: (orderId: string) =>
			attachDocumentCapture({
				data: { captureId: capture.id, orderId, documentKind },
			}),
		onSuccess: () => {
			toast.success("Document attached to order");
			void invalidate();
			onResolved();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	const ignore = useMutation({
		mutationFn: () =>
			ignoreDocumentCapture({ data: { captureId: capture.id } }),
		onSuccess: () => {
			toast.success("Marked as not an order");
			void invalidate();
			onResolved();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	const restore = useMutation({
		mutationFn: () =>
			restoreDocumentCapture({ data: { captureId: capture.id } }),
		onSuccess: () => void invalidate(),
		onError: (error) => toast.error(errorMessage(error)),
	});

	const analyze = useMutation({
		mutationFn: (ocr: "auto" | "force") =>
			analyzeDocument({ data: { captureId: capture.id, ocr } }),
		onSuccess: (next) => {
			toast.success("Document analyzed");
			onAnalyzed(next);
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	function submit() {
		if (resolved || create.isPending) return;
		if (!fields.merchantName.value.trim()) {
			toast.error("Merchant is required");
			activate({ type: "field", key: "merchantName" });
			focusTarget({ type: "field", key: "merchantName" });
			return;
		}
		if (!/^-?\d+(\.\d{1,3})?$/.test(fields.total.value)) {
			toast.error("Total is required");
			activate({ type: "field", key: "total" });
			focusTarget({ type: "field", key: "total" });
			return;
		}
		if (!/^[A-Z]{3}$/.test(currency)) {
			toast.error("Currency must be a 3-letter code");
			return;
		}
		create.mutate();
	}

	// Global Ctrl/⌘+Enter → create (when focus is outside inputs too).
	const submitRef = useRef(submit);
	submitRef.current = submit;
	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				if (document.querySelector('[role="dialog"]')) return;
				event.preventDefault();
				submitRef.current();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const documentUrl = review.document
		? `/api/documents/${review.document.id}`
		: null;
	const picking =
		target && layout && !layout.synthetic
			? target.type === "field"
				? {
						color: FIELD_META[target.key].color,
						label: FIELD_META[target.key].label,
					}
				: { color: ITEM_COLOR, label: `item ${target.index + 1} ${target.col}` }
			: null;
	const analyzed = !!extraction;
	const busy = create.isPending || attach.isPending || ignore.isPending;

	const fieldInput = (key: FieldKey, className?: string) => {
		const meta = FIELD_META[key];
		const state = fields[key];
		const t: Target = { type: "field", key };
		const active = sameTarget(target, t);
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: hover only previews highlights
			<div
				key={key}
				className={cn("flex flex-col gap-1", className)}
				onMouseEnter={() => setHovered(t)}
				onMouseLeave={() => setHovered(null)}
			>
				<label
					htmlFor={`docfield-${key}`}
					className="flex items-center gap-1.5"
				>
					<span
						className="size-2 shrink-0 rounded-full"
						style={{ background: meta.color }}
					/>
					<span className="label-caps">{meta.label}</span>
					<ViaBadge state={state} />
				</label>
				<Input
					id={`docfield-${key}`}
					ref={(el) => {
						inputs.current.set(targetId(t), el);
					}}
					value={state.value}
					placeholder={
						meta.placeholder ??
						(meta.input === "money"
							? "0.00"
							: meta.input === "date"
								? "YYYY-MM-DD"
								: "")
					}
					inputMode={
						meta.input === "money" || meta.input === "last4"
							? "decimal"
							: undefined
					}
					maxLength={
						meta.input === "currency"
							? 3
							: meta.input === "last4"
								? 4
								: undefined
					}
					disabled={resolved}
					className={cn(meta.input !== "text" && "tabular-nums")}
					style={
						active
							? {
									borderColor: meta.color,
									boxShadow: `0 0 0 1px ${meta.color}`,
								}
							: state.refs.length
								? { background: hexAlpha(meta.color, 0.06) }
								: undefined
					}
					onFocus={() => activate(t)}
					onChange={(event) =>
						setField(key, {
							value:
								meta.input === "currency"
									? event.target.value.toUpperCase()
									: event.target.value,
							via: "manual",
							// Typed values keep their boxes only if unchanged.
							refs: [],
						})
					}
					onBlur={(event) => {
						// Normalize typed money/dates on blur.
						const raw = event.target.value;
						if (!raw || (meta.input !== "money" && meta.input !== "date"))
							return;
						const parsed = parseFieldValue(key, raw, { currency, dayFirst });
						if (parsed && parsed !== raw) setField(key, { value: parsed });
					}}
					onKeyDown={(event) => onFieldKeyDown(event, t)}
				/>
			</div>
		);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
			<DocumentViewer
				className="min-h-[50vh] flex-1 lg:min-h-0"
				documentUrl={documentUrl}
				contentType={review.document?.contentType ?? null}
				layout={layout}
				highlights={highlights}
				focusRefs={focusRefs}
				picking={picking}
				onPick={onPick}
			/>
			<aside className="flex min-h-0 w-full shrink-0 flex-col border-t border-border bg-card lg:w-[400px] lg:border-t-0 lg:border-l">
				<div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
					<span
						className="min-w-0 flex-1 truncate text-xs font-semibold"
						title={capture.title}
					>
						{review.document?.fileName ?? capture.title ?? "Document"}
					</span>
					<Tag tone="neutral">{capture.channel}</Tag>
					{capture.source !== "generic" && (
						<Tag tone="info">{storeLabel(capture.source)}</Tag>
					)}
					{extraction?.aiUsed && (
						<Tag tone="primary" title="AI filled some fields">
							<IconSparkles className="size-3" /> AI
						</Tag>
					)}
					{extraction?.templateId && (
						<Tag
							tone="success"
							title="Field positions remembered from a previous document of this merchant"
						>
							template
						</Tag>
					)}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
					{linkedOrders.length > 0 && (
						<Notice tone="success">
							Linked to{" "}
							{linkedOrders.map((o) => (
								<Link
									key={o.id}
									to="/app/orders/$orderId"
									params={{ orderId: o.id }}
									className="inline-flex items-center gap-0.5 font-medium underline"
								>
									{o.merchantName ?? "order"} #
									{o.externalOrderId.split(":").pop()}
									<IconExternalLink className="size-3" />
								</Link>
							))}
						</Notice>
					)}
					{capture.status === "ignored" && (
						<Notice tone="neutral">
							Marked as not an order.{" "}
							<button
								type="button"
								className="underline"
								onClick={() => restore.mutate()}
							>
								Restore to review
							</button>
						</Notice>
					)}
					{!resolved && capture.status === "needs_review" && capture.error && (
						<Notice tone="warning">{capture.error}</Notice>
					)}
					{!analyzed && (
						<Notice tone="warning">
							{capture.status === "pending"
								? "Text extraction is queued…"
								: "This document has not been analyzed yet."}{" "}
							<button
								type="button"
								className="underline"
								disabled={analyze.isPending}
								onClick={() => analyze.mutate("auto")}
							>
								Analyze now
							</button>
						</Notice>
					)}
					{extraction && extraction.warnings.length > 0 && (
						<div className="mb-3 space-y-0.5 text-[11px] text-amber-600 dark:text-amber-400">
							{extraction.warnings.map((w) => (
								<div key={w}>• {w}</div>
							))}
						</div>
					)}

					<div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
						{fieldInput("merchantName", "col-span-2")}
						{fieldInput("externalOrderId")}
						{fieldInput("orderDate")}
						{fieldInput("currency")}
						{fieldInput("paymentLast4")}
						{fieldInput("subtotal")}
						{fieldInput("shipping")}
						{fieldInput("tax")}
						{fieldInput("discount")}
						{fieldInput("total", "col-span-2")}
					</div>
					{sumCheck && (
						<div
							className={cn(
								"mt-1.5 font-mono text-[10px]",
								sumCheck.ok
									? "text-emerald-600 dark:text-emerald-400"
									: "text-amber-600 dark:text-amber-400",
							)}
						>
							{sumCheck.ok ? (
								"✓ subtotal + shipping + tax − discount = total"
							) : (
								<>
									Sum is <Money minor={sumCheck.sum} currency={currency} /> but
									total is <Money minor={sumCheck.total} currency={currency} />
								</>
							)}
						</div>
					)}

					<div className="mt-4 grid grid-cols-2 gap-2">
						<div className="flex flex-col gap-1">
							<span className="label-caps">Entity</span>
							<EntitySelect
								label="Entity"
								value={entityId}
								onChange={setEntityId}
								entities={activeEntities}
								disabled={resolved}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<span className="label-caps">Category</span>
							<CategorySelect
								label="Category"
								value={categoryId}
								onChange={setCategoryId}
								categories={activeCategories}
								entityId={entityId}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<span className="label-caps">Document is</span>
							<Select
								value={documentKind}
								onChange={(e) =>
									setDocumentKind(
										e.target.value === "receipt" ? "receipt" : "invoice",
									)
								}
							>
								<option value="invoice">Invoice</option>
								<option value="receipt">Receipt</option>
							</Select>
						</div>
						<label className="flex items-end gap-1.5 pb-1 text-[11px] text-muted-foreground">
							<input
								type="checkbox"
								checked={learn}
								onChange={(e) => setLearn(e.target.checked)}
								className="accent-primary"
							/>
							Remember field positions for this merchant
						</label>
					</div>

					<div className="mt-4">
						<div className="mb-1 flex items-center justify-between">
							<span className="label-caps">Line items</span>
							<div className="flex items-center gap-2">
								{itemsSum !== null && (
									<span className="font-mono text-[10px] text-muted-foreground">
										Σ <Money minor={itemsSum} currency={currency} />
									</span>
								)}
								<Button
									size="xs"
									variant="ghost"
									disabled={resolved}
									onClick={() => {
										const index = items.length;
										setItems((prev) => [
											...prev,
											{
												key: itemKey++,
												title: "",
												quantity: "1",
												unitPrice: "",
												total: "",
												refs: [],
											},
										]);
										const t: Target = { type: "item", index, col: "title" };
										setTarget(t);
										requestAnimationFrame(() => focusTarget(t));
									}}
								>
									<IconPlus /> Add
								</Button>
							</div>
						</div>
						{items.length === 0 ? (
							<p className="text-[11px] text-muted-foreground">
								No line items detected. Add one and drag across a row on the
								document to fill it.
							</p>
						) : (
							<div className="space-y-1">
								<div className="grid grid-cols-[1fr_44px_64px_64px_20px] gap-1 px-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
									<span>Title</span>
									<span>Qty</span>
									<span>Unit</span>
									<span>Total</span>
									<span />
								</div>
								{items.map((item, index) => (
									// biome-ignore lint/a11y/noStaticElementInteractions: hover only previews highlights
									<div
										key={item.key}
										className="grid grid-cols-[1fr_44px_64px_64px_20px] gap-1"
										onMouseEnter={() =>
											setHovered({ type: "item", index, col: "title" })
										}
										onMouseLeave={() => setHovered(null)}
									>
										{ITEM_COLS.map((col) => {
											const t: Target = { type: "item", index, col };
											const active = sameTarget(target, t);
											return (
												<Input
													key={col}
													aria-label={`Item ${index + 1} ${col}`}
													ref={(el) => {
														inputs.current.set(targetId(t), el);
													}}
													value={item[col]}
													disabled={resolved}
													className={cn(
														col !== "title" && "px-1 text-right tabular-nums",
														col === "title" && "font-sans",
													)}
													style={
														active
															? {
																	borderColor: ITEM_COLOR,
																	boxShadow: `0 0 0 1px ${ITEM_COLOR}`,
																}
															: undefined
													}
													onFocus={() => activate(t)}
													onChange={(e) =>
														setItems((prev) =>
															prev.map((it, i) =>
																i === index
																	? { ...it, [col]: e.target.value }
																	: it,
															),
														)
													}
													onKeyDown={(event) => onFieldKeyDown(event, t)}
												/>
											);
										})}
										<button
											type="button"
											aria-label="Remove item"
											className="flex items-center justify-center text-muted-foreground hover:text-red-500"
											onClick={() => {
												setItems((prev) => prev.filter((_, i) => i !== index));
												setTarget(null);
											}}
										>
											<IconTrash className="size-3.5" />
										</button>
									</div>
								))}
							</div>
						)}
					</div>

					<div className="mt-4 flex flex-col gap-1">
						<span className="label-caps">Notes</span>
						<Textarea
							value={notes}
							onChange={(e) => setNotes(e.target.value)}
							disabled={resolved}
						/>
					</div>

					{attachOpen && !resolved && (
						<AttachPanel
							totalMinor={decimalToMinor(fields.total.value, currency)}
							defaultQuery={
								fields.externalOrderId.value || fields.merchantName.value
							}
							busy={attach.isPending}
							onPick={(orderId) => attach.mutate(orderId)}
						/>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
					<Button
						variant="primary"
						size="md"
						disabled={resolved || busy}
						onClick={submit}
						title="Ctrl/⌘ + Enter"
					>
						{create.isPending ? (
							<IconLoader2 className="animate-spin" />
						) : (
							<IconPlus />
						)}
						Create order
						<Kbd className="border-primary-foreground/30 bg-transparent text-primary-foreground/80">
							⌘↵
						</Kbd>
					</Button>
					<Button
						size="md"
						disabled={resolved || busy}
						onClick={() => setAttachOpen((v) => !v)}
					>
						<IconLink /> Attach…
					</Button>
					<Button
						size="md"
						variant="ghost"
						disabled={resolved || busy}
						onClick={() => ignore.mutate()}
					>
						<IconBan /> Not an order
					</Button>
					<Button
						size="md"
						variant="ghost"
						className="ml-auto"
						disabled={analyze.isPending || !review.document}
						title={
							layout?.synthetic
								? "Run OCR to get word positions"
								: "Re-run text extraction and OCR"
						}
						onClick={() => analyze.mutate("force")}
					>
						{analyze.isPending ? (
							<IconLoader2 className="animate-spin" />
						) : layout?.synthetic || !layout?.pages.length ? (
							<IconScan />
						) : (
							<IconRefresh />
						)}
						{layout?.synthetic || !layout?.pages.length ? "Run OCR" : "Re-scan"}
					</Button>
				</div>
			</aside>
		</div>
	);
}

function ViaBadge({ state }: { state: FieldState }) {
	if (!state.via || !state.value) return null;
	const label =
		state.via === "manual"
			? "you"
			: state.via === "ai"
				? "AI"
				: state.via === "template"
					? "learned"
					: state.via === "position"
						? "guess"
						: "found";
	const low = state.via !== "manual" && (state.confidence ?? 1) < 0.6;
	return (
		<span
			className={cn(
				"ml-auto font-mono text-[9px] uppercase tracking-wide",
				low ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
			)}
			title={
				state.confidence !== undefined
					? `Confidence ${Math.round(state.confidence * 100)}%`
					: undefined
			}
		>
			{label}
			{low ? " ?" : ""}
		</span>
	);
}

function Notice({
	tone,
	children,
}: {
	tone: "success" | "warning" | "neutral";
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"mb-3 rounded-sm border px-2 py-1.5 text-[11px]",
				tone === "success" &&
					"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
				tone === "warning" &&
					"border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
				tone === "neutral" && "border-border bg-muted text-muted-foreground",
			)}
		>
			{children}
		</div>
	);
}

function AttachPanel({
	totalMinor,
	defaultQuery,
	busy,
	onPick,
}: {
	totalMinor: number | undefined;
	defaultQuery: string;
	busy: boolean;
	onPick: (orderId: string) => void;
}) {
	const [q, setQ] = useState(defaultQuery);
	const [debounced, setDebounced] = useState(defaultQuery);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(q), 250);
		return () => clearTimeout(t);
	}, [q]);
	const results = useQuery({
		queryKey: ["ledger", "documents", "attach-search", debounced, totalMinor],
		queryFn: () =>
			searchOrdersForAttach({ data: { q: debounced, totalMinor } }),
	});
	return (
		<div className="mt-4 rounded-sm border border-border bg-background p-2">
			<div className="label-caps mb-1">Attach to existing order</div>
			<Input
				autoFocus
				value={q}
				placeholder="Search merchant or order #"
				onChange={(e) => setQ(e.target.value)}
			/>
			<div className="mt-1.5 max-h-56 overflow-y-auto">
				{results.isLoading && (
					<div className="py-2 text-[11px] text-muted-foreground">
						Searching…
					</div>
				)}
				{results.data?.length === 0 && (
					<div className="py-2 text-[11px] text-muted-foreground">
						No matching orders.
					</div>
				)}
				{results.data?.map((order) => (
					<button
						key={order.id}
						type="button"
						disabled={busy}
						onClick={() => onPick(order.id)}
						className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs hover:bg-accent disabled:opacity-50"
					>
						<span className="min-w-0 flex-1 truncate">
							{order.merchantName ?? storeLabel(order.source)}{" "}
							<span className="font-mono text-[10px] text-muted-foreground">
								#{order.externalOrderId.split(":").pop()}
							</span>
						</span>
						<span className="font-mono text-[10px] text-muted-foreground">
							{formatDate(order.orderDate)}
						</span>
						<Money
							minor={order.totalMinor}
							currency={order.currency}
							className={cn(
								"text-[11px]",
								totalMinor !== undefined &&
									order.totalMinor === totalMinor &&
									"text-emerald-600 dark:text-emerald-400",
							)}
						/>
						{order.hasInvoice && <Tag tone="neutral">doc</Tag>}
					</button>
				))}
			</div>
		</div>
	);
}
