/**
 * Query keys for lifecycle data. They live under ["ledger", …] so the
 * existing useInvalidateLedger() refreshes them after any ledger mutation.
 */
export const lifecycleKeys = {
	refunds: (orderId: string) =>
		["ledger", "lifecycle", "refunds", orderId] as const,
	orderAssets: (orderId: string) =>
		["ledger", "lifecycle", "order-assets", orderId] as const,
	assets: (filters: unknown) =>
		["ledger", "lifecycle", "assets", filters] as const,
	items: (q: string) => ["ledger", "lifecycle", "items", q] as const,
	itemHistory: (title: string, sku: string | null) =>
		["ledger", "lifecycle", "item-history", title, sku] as const,
	duplicates: (orderId: string) =>
		["ledger", "lifecycle", "duplicates", orderId] as const,
	duplicateFlags: (ids: string[]) =>
		["ledger", "lifecycle", "duplicate-flags", ids] as const,
	tracking: (orderId: string) =>
		["ledger", "lifecycle", "tracking", orderId] as const,
	netSpend: (filters: unknown) =>
		["ledger", "lifecycle", "net-spend", filters] as const,
};
