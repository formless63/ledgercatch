/** TanStack Query keys for money features. */
export const moneyKeys = {
	all: ["money"] as const,
	reconcile: (filters: unknown) => ["money", "reconcile", filters] as const,
	settings: ["money", "settings"] as const,
	tax: (orderId: string) => ["money", "tax", orderId] as const,
	taxSummary: (filters: unknown) => ["money", "tax-summary", filters] as const,
	insights: (filters: unknown) => ["money", "insights", filters] as const,
};
