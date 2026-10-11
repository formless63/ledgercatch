/**
 * Shared building blocks for the Inbox, Orders list and Order detail pages:
 * mutation hooks with optimistic cache patches, keyboard helpers and small
 * selector controls.
 */
import { IconCreditCard } from "@tabler/icons-react";
import {
	type QueryClient,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { EntityChip, Select, Tag } from "#/components/app/primitives";
import {
	type CategoryRow,
	type EntityRow,
	ledgerKeys,
	type PaymentMethodRow,
	useBootstrap,
	useInvalidateLedger,
} from "#/features/ledger/hooks";
import type {
	bulkOrderUpdateInput,
	OrderUpdateInput,
} from "#/features/ledger/inputs";
import {
	bulkUpdateOrders,
	queueExports,
	updateOrder,
	updateOrderItem,
} from "#/features/ledger/ledger.functions";
import type {
	OrderDetail,
	OrderListResult,
} from "#/features/ledger/ledger.server";
import { cn } from "#/lib/utils";

export type ReviewState = "inbox" | "filed" | "ignored";
type OrderPatch = Partial<{
	entityId: string | null;
	categoryId: string | null;
	paymentMethodId: string | null;
	reimbursableOverride: boolean | null;
	reviewState: ReviewState;
	notes: string | null;
	tags: string[];
}>;

export function errorMessage(error: unknown) {
	if (error instanceof Error) return error.message;
	return "Something went wrong";
}

/* ───────────────────────── keyboard ───────────────────────── */

export function isTypingTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Global page hotkeys. Ignores keystrokes while typing, with modifier keys
 * (except shift), or while any modal dialog is open (command palette etc.).
 */
export function useHotkeys(
	handler: (event: KeyboardEvent) => void,
	enabled = true,
) {
	const ref = useRef(handler);
	ref.current = handler;
	useEffect(() => {
		if (!enabled) return;
		const listener = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (isTypingTarget(event.target)) return;
			if (document.querySelector('[role="dialog"], dialog[open]')) return;
			ref.current(event);
		};
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, [enabled]);
}

export function useMediaQuery(query: string, fallback = true) {
	const [matches, setMatches] = useState(fallback);
	useEffect(() => {
		const media = window.matchMedia(query);
		setMatches(media.matches);
		const onChange = () => setMatches(media.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

/* ───────────────────────── optimistic cache ───────────────────────── */

async function patchCaches(
	client: QueryClient,
	ids: string[],
	patch: OrderPatch,
) {
	await client.cancelQueries({ queryKey: ["ledger", "orders"] });
	const idSet = new Set(ids);
	for (const [key, data] of client.getQueriesData<OrderListResult>({
		queryKey: ["ledger", "orders"],
	})) {
		if (!data?.orders) continue;
		const filters = (key[2] ?? {}) as { view?: string };
		const view = filters.view ?? "all";
		const leaves =
			patch.reviewState !== undefined &&
			view !== "all" &&
			view !== patch.reviewState;
		let removed = 0;
		const next = data.orders.flatMap((row) => {
			if (!idSet.has(row.id)) return [row];
			if (leaves) {
				removed++;
				return [];
			}
			return [{ ...row, ...patch }];
		});
		client.setQueryData<OrderListResult>(key, {
			total: Math.max(0, data.total - removed),
			orders: next,
		});
	}
	for (const id of ids) {
		const key = ledgerKeys.order(id);
		const detail = client.getQueryData<OrderDetail>(key);
		if (detail)
			client.setQueryData<OrderDetail>(key, {
				...detail,
				order: { ...detail.order, ...patch },
			});
	}
}

const MUTATION_KEY = ["ledger", "orders-ui"] as const;

/**
 * Mutations shared by triage surfaces. Patches the cached lists immediately,
 * then invalidates everything ledger-related once the last in-flight
 * mutation settles (avoids flicker during rapid keyboard triage).
 */
export function useOrderActions() {
	const client = useQueryClient();
	const invalidate = useInvalidateLedger();
	const settle = () => {
		if (client.isMutating({ mutationKey: MUTATION_KEY }) <= 1)
			void invalidate();
	};
	const onError = (error: unknown) => {
		toast.error(errorMessage(error));
		void invalidate();
	};

	const update = useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: (input: OrderUpdateInput) => updateOrder({ data: input }),
		onMutate: async (input) => {
			const { id, merchantName: _merchant, ...patch } = input;
			await patchCaches(client, [id], patch as OrderPatch);
		},
		onError,
		onSettled: settle,
	});

	const bulk = useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: (input: z.input<typeof bulkOrderUpdateInput>) =>
			bulkUpdateOrders({ data: input }),
		onMutate: async (input) => {
			const { ids, ...patch } = input;
			await patchCaches(client, ids, patch as OrderPatch);
		},
		onSuccess: (result, input) => {
			if (input.ids.length > 1)
				toast.success(
					`Updated ${result.updated} order${result.updated === 1 ? "" : "s"}`,
				);
		},
		onError,
		onSettled: settle,
	});

	const updateItem = useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: (input: {
			itemId: string;
			entityId?: string | null;
			categoryId?: string | null;
		}) => updateOrderItem({ data: input }),
		onError,
		onSettled: settle,
	});

	const exportOrders = useMutation({
		mutationKey: MUTATION_KEY,
		mutationFn: (input: {
			orderIds?: string[];
			allocationIds?: string[];
			connectionId?: string;
			force?: boolean;
		}) => queueExports({ data: input }),
		onSuccess: (result) => {
			if (result.queued === 0)
				toast.warning(
					result.skipped
						? `Nothing queued — ${result.skipped} skipped (already sent or no connection for that entity)`
						: "Nothing to export",
				);
			else
				toast.success(
					`Queued ${result.queued} export${result.queued === 1 ? "" : "s"}${result.skipped ? ` · ${result.skipped} skipped` : ""}`,
				);
		},
		onError,
		onSettled: settle,
	});

	return { update, bulk, updateItem, exportOrders };
}

/* ───────────────────────── labels ───────────────────────── */

export function paymentMethodLabel(method: PaymentMethodRow) {
	const tail = method.last4 ? ` ••${method.last4}` : "";
	return `${method.label}${tail}`;
}

export function categoryLabel(category: CategoryRow) {
	return category.code ? `${category.code} · ${category.name}` : category.name;
}

export function reimbursableLabel(value: boolean | null | undefined) {
	if (value === true) return "Yes";
	if (value === false) return "No";
	return "Auto";
}

export function nextReimbursable(value: boolean | null | undefined) {
	if (value == null) return true;
	if (value === true) return false;
	return null;
}

export const REVIEW_TONES = {
	inbox: "primary",
	filed: "success",
	ignored: "neutral",
} as const;

export function ReviewTag({ state }: { state: string }) {
	return (
		<Tag tone={REVIEW_TONES[state as ReviewState] ?? "neutral"}>{state}</Tag>
	);
}

/* ───────────────────────── selectors ───────────────────────── */

export function EntitySelect({
	value,
	onChange,
	entities,
	placeholder = "Unassigned",
	className,
	label,
	disabled,
}: {
	value: string | null | undefined;
	onChange: (value: string | null) => void;
	entities: EntityRow[];
	placeholder?: string;
	className?: string;
	label: string;
	disabled?: boolean;
}) {
	return (
		<Select
			aria-label={label}
			value={value ?? ""}
			disabled={disabled}
			className={className}
			onChange={(event) => onChange(event.target.value || null)}
		>
			<option value="">{placeholder}</option>
			{entities.map((entity) => (
				<option key={entity.id} value={entity.id}>
					{entity.name}
				</option>
			))}
		</Select>
	);
}

export function CategorySelect({
	value,
	onChange,
	categories,
	entityId,
	placeholder = "No category",
	className,
	label,
}: {
	value: string | null | undefined;
	onChange: (value: string | null) => void;
	categories: CategoryRow[];
	/** Show shared categories plus those of this entity. */
	entityId?: string | null;
	placeholder?: string;
	className?: string;
	label: string;
}) {
	const visible = categories.filter(
		(category) =>
			!category.entityId ||
			!entityId ||
			category.entityId === entityId ||
			category.id === value,
	);
	return (
		<Select
			aria-label={label}
			value={value ?? ""}
			className={className}
			onChange={(event) => onChange(event.target.value || null)}
		>
			<option value="">{placeholder}</option>
			{visible.map((category) => (
				<option key={category.id} value={category.id}>
					{categoryLabel(category)}
				</option>
			))}
		</Select>
	);
}

export function PaymentMethodSelect({
	value,
	onChange,
	methods,
	className,
	label,
}: {
	value: string | null | undefined;
	onChange: (value: string | null) => void;
	methods: PaymentMethodRow[];
	className?: string;
	label: string;
}) {
	return (
		<Select
			aria-label={label}
			value={value ?? ""}
			className={className}
			onChange={(event) => onChange(event.target.value || null)}
		>
			<option value="">Unknown payment method</option>
			{methods
				.filter((method) => !method.archivedAt || method.id === value)
				.map((method) => (
					<option key={method.id} value={method.id}>
						{paymentMethodLabel(method)}
					</option>
				))}
		</Select>
	);
}

/** Payment method + who funds it, with a nudge to map unmapped cards. */
export function PaymentSummary({
	paymentMethodId,
	paymentHint,
	className,
}: {
	paymentMethodId: string | null | undefined;
	paymentHint?: string | null;
	className?: string;
}) {
	const { paymentMethodById, entityById } = useBootstrap();
	const method = paymentMethodId
		? paymentMethodById.get(paymentMethodId)
		: undefined;
	const payer = method?.payingEntityId
		? entityById.get(method.payingEntityId)
		: undefined;
	return (
		<div
			className={cn(
				"flex min-w-0 flex-wrap items-center gap-1.5 text-xs",
				className,
			)}
		>
			<IconCreditCard className="size-3.5 shrink-0 text-muted-foreground" />
			{method ? (
				<span className="truncate font-mono">{paymentMethodLabel(method)}</span>
			) : (
				<span className="truncate text-muted-foreground">
					{paymentHint || "Unknown card"}
				</span>
			)}
			{method &&
				(payer ? (
					<>
						<span className="text-muted-foreground">paid by</span>
						<EntityChip entity={payer} short />
					</>
				) : (
					<Link
						to="/app/settings"
						className="text-[11px] text-amber-600 underline-offset-2 hover:underline dark:text-amber-400"
					>
						Map paying entity
					</Link>
				))}
		</div>
	);
}

/* ───────────────────────── history ───────────────────────── */

const ACTION_LABELS: Record<string, string> = {
	"order.captured": "Captured from store page",
	"order.created_manually": "Created manually",
	"order.updated": "Updated",
	"order.item_updated": "Line item updated",
	"order.rules_applied": "Rules applied",
	"order.reimbursement": "Reimbursement status changed",
	"order.claim_created": "Added to a reimbursement claim",
	"order.exported": "Exported",
	"order.document_removed": "Document removed",
};

const FIELD_LABELS: Record<string, string> = {
	entityId: "entity",
	categoryId: "category",
	paymentMethodId: "payment method",
	reimbursableOverride: "reimbursable",
	reviewState: "review state",
	notes: "notes",
	tags: "tags",
	merchantName: "merchant",
};

export function humanizeAction(action: string) {
	if (ACTION_LABELS[action]) return ACTION_LABELS[action];
	const tail = action.split(".").pop() ?? action;
	const words = tail.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One-line summary of an audit event's metadata, resolving ids to names. */
export function describeHistoryMetadata(
	action: string,
	metadata: unknown,
	lookups: {
		entityName: (id: string) => string | undefined;
		categoryName: (id: string) => string | undefined;
		paymentName: (id: string) => string | undefined;
	},
): string | null {
	if (!metadata || typeof metadata !== "object") return null;
	const meta = metadata as Record<string, unknown>;
	const resolve = (key: string, value: unknown): string => {
		if (value === null) return "none";
		if (typeof value === "string") {
			if (key === "entityId") return lookups.entityName(value) ?? "unknown";
			if (key === "categoryId") return lookups.categoryName(value) ?? "unknown";
			if (key === "paymentMethodId")
				return lookups.paymentName(value) ?? "unknown";
			return value.length > 60 ? `${value.slice(0, 57)}…` : value;
		}
		if (typeof value === "boolean")
			return key === "reimbursableOverride" ? (value ? "yes" : "no") : "yes";
		if (Array.isArray(value)) return value.join(", ") || "none";
		return String(value);
	};
	if (action === "order.updated" || action === "order.item_updated") {
		const parts = Object.entries(meta)
			.filter(([key]) => key !== "itemId")
			.map(
				([key, value]) =>
					`${FIELD_LABELS[key] ?? key} → ${resolve(key, value)}`,
			);
		return parts.join(" · ") || null;
	}
	if (action === "order.exported")
		return [meta.connection, meta.status].filter(Boolean).join(" · ");
	if (action === "order.reimbursement")
		return typeof meta.status === "string" ? `→ ${meta.status}` : null;
	if (action === "order.captured")
		return [meta.source, meta.parser].filter(Boolean).join(" · ");
	if (action === "order.rules_applied") {
		const actions = (meta.actions ?? {}) as Record<string, unknown>;
		const parts = Object.entries(actions).map(
			([key, value]) => `${FIELD_LABELS[key] ?? key} → ${resolve(key, value)}`,
		);
		return parts.join(" · ") || null;
	}
	if (action === "order.document_removed")
		return typeof meta.fileName === "string" ? meta.fileName : null;
	return null;
}

/* ───────────────────────── CSV ───────────────────────── */

export function toCsv(rows: Array<Array<string | number | null | undefined>>) {
	return rows
		.map((row) =>
			row
				.map((cell) => {
					const text = cell == null ? "" : String(cell);
					return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
				})
				.join(","),
		)
		.join("\r\n");
}

export function downloadText(fileName: string, text: string, type: string) {
	const blob = new Blob([text], { type });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Minor units → plain decimal string for CSV. */
export function minorToDecimal(minor: number | null | undefined) {
	if (minor == null) return "";
	const sign = minor < 0 ? "-" : "";
	const abs = Math.abs(minor);
	return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
