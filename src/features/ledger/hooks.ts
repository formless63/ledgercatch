/** Client data hooks shared across ledger pages (TanStack Query). */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { getBootstrap } from "./ledger.functions";

export const ledgerKeys = {
	bootstrap: ["ledger", "bootstrap"] as const,
	orders: (filters: unknown) => ["ledger", "orders", filters] as const,
	order: (id: string) => ["ledger", "order", id] as const,
	reimbursements: ["ledger", "reimbursements"] as const,
	rules: ["ledger", "rules"] as const,
	captures: (filters: unknown) => ["ledger", "captures", filters] as const,
	capture: (id: string) => ["ledger", "capture", id] as const,
	connections: ["ledger", "connections"] as const,
	insights: (filters: unknown) => ["ledger", "insights", filters] as const,
};

export type Bootstrap = Awaited<ReturnType<typeof getBootstrap>>;
export type EntityRow = Bootstrap["entities"][number];
export type CategoryRow = Bootstrap["categories"][number];
export type PaymentMethodRow = Bootstrap["paymentMethods"][number];

/** Entities, categories, payment methods and nav counts. Refreshes every 30s. */
export function useBootstrap() {
	const query = useQuery({
		queryKey: ledgerKeys.bootstrap,
		queryFn: () => getBootstrap(),
		refetchInterval: 30_000,
	});
	const lookups = useMemo(() => {
		const data = query.data;
		return {
			entityById: new Map((data?.entities ?? []).map((e) => [e.id, e])),
			categoryById: new Map((data?.categories ?? []).map((c) => [c.id, c])),
			paymentMethodById: new Map(
				(data?.paymentMethods ?? []).map((p) => [p.id, p]),
			),
			activeEntities: (data?.entities ?? []).filter((e) => !e.archivedAt),
			activeCategories: (data?.categories ?? []).filter((c) => !c.archivedAt),
		};
	}, [query.data]);
	return { ...query, ...lookups };
}

/** Invalidate everything ledger-related after a mutation. */
export function useInvalidateLedger() {
	const client = useQueryClient();
	return useCallback(
		() => client.invalidateQueries({ queryKey: ["ledger"] }),
		[client],
	);
}

/**
 * Subscribe to server change hints (SSE) and refetch ledger queries when the
 * worker ingests captures or finishes exports. Polling remains the fallback.
 */
export function useLedgerLive() {
	const client = useQueryClient();
	useEffect(() => {
		if (typeof EventSource === "undefined") return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const source = new EventSource("/api/realtime/sse");
		source.addEventListener("ledger.changed", () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				void client.invalidateQueries({ queryKey: ["ledger"] });
			}, 400);
		});
		return () => {
			clearTimeout(timer);
			source.close();
		};
	}, [client]);
}
