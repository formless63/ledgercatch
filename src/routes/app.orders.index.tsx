import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { OrdersPage } from "#/components/orders/orders-page";

/**
 * URL filters for the Orders table. Kept lenient (strings) so a malformed link
 * never breaks the page; values are narrowed in `toListInput`. The app shell
 * links here with `q` and `entity`.
 */
export const ordersSearchSchema = z.object({
	q: z.string().optional(),
	entity: z.string().optional(),
	source: z.string().optional(),
	status: z.string().optional(),
	reimbursement: z.string().optional(),
	missingInvoice: z.boolean().optional(),
	view: z.string().optional(),
	from: z.string().optional(),
	to: z.string().optional(),
	sort: z.string().optional(),
	page: z.number().int().min(1).optional(),
	size: z.number().int().optional(),
});

export const Route = createFileRoute("/app/orders/")({
	validateSearch: ordersSearchSchema,
	component: OrdersPage,
});
