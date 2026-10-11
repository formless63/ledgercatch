/**
 * TanStack server functions for the ledger UI. Implementations live in
 * *.server.ts modules and are imported lazily so they never reach the client.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	bulkOrderUpdateInput,
	captureListInput,
	categoryInput,
	claimStatusInput,
	createClaimInput,
	entityInput,
	idInput,
	insightsInput,
	manualOrderInput,
	orderItemUpdateInput,
	orderListInput,
	orderUpdateInput,
	paymentMethodInput,
	reimbursementStatusInput,
	ruleInput,
} from "./inputs";

const ledger = () => import("./ledger.server");
const exportsModule = () => import("./exports.server");
const insightsModule = () => import("./insights.server");

/* bootstrap */
export const getBootstrap = createServerFn({ method: "GET" }).handler(
	async () => (await ledger()).getBootstrap(),
);

/* orders */
export const listOrders = createServerFn({ method: "POST" })
	.validator(orderListInput)
	.handler(async ({ data }) => (await ledger()).listOrders(data));
export const getOrder = createServerFn({ method: "GET" })
	.validator(idInput)
	.handler(async ({ data }) => (await ledger()).getOrder(data.id));
export const updateOrder = createServerFn({ method: "POST" })
	.validator(orderUpdateInput)
	.handler(async ({ data }) => (await ledger()).updateOrder(data));
export const bulkUpdateOrders = createServerFn({ method: "POST" })
	.validator(bulkOrderUpdateInput)
	.handler(async ({ data }) => (await ledger()).bulkUpdateOrders(data));
export const updateOrderItem = createServerFn({ method: "POST" })
	.validator(orderItemUpdateInput)
	.handler(async ({ data }) => (await ledger()).updateOrderItem(data));
export const createManualOrder = createServerFn({ method: "POST" })
	.validator(manualOrderInput)
	.handler(async ({ data }) => (await ledger()).createManualOrder(data));
export const explainRules = createServerFn({ method: "GET" })
	.validator(idInput)
	.handler(async ({ data }) => (await ledger()).explainRules(data.id));

/* documents */
export const deleteDocument = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await ledger()).deleteDocument(data.id));
export const attachDocumentToOrder = createServerFn({ method: "POST" })
	.validator(
		z.object({ id: z.string().uuid(), orderId: z.string().uuid().nullable() }),
	)
	.handler(async ({ data }) =>
		(await ledger()).attachDocumentToOrder(data.id, data.orderId),
	);

/* reimbursements */
export const getReimbursements = createServerFn({ method: "GET" }).handler(
	async () => (await ledger()).getReimbursements(),
);
export const setReimbursementStatus = createServerFn({ method: "POST" })
	.validator(reimbursementStatusInput)
	.handler(async ({ data }) => (await ledger()).setReimbursementStatus(data));
export const createClaim = createServerFn({ method: "POST" })
	.validator(createClaimInput)
	.handler(async ({ data }) => (await ledger()).createClaim(data));
export const setClaimStatus = createServerFn({ method: "POST" })
	.validator(claimStatusInput)
	.handler(async ({ data }) => (await ledger()).setClaimStatus(data));
export const getClaim = createServerFn({ method: "GET" })
	.validator(idInput)
	.handler(async ({ data }) => (await ledger()).getClaim(data.id));

/* settings */
export const saveEntity = createServerFn({ method: "POST" })
	.validator(entityInput)
	.handler(async ({ data }) => (await ledger()).saveEntity(data));
export const saveCategory = createServerFn({ method: "POST" })
	.validator(categoryInput)
	.handler(async ({ data }) => (await ledger()).saveCategory(data));
export const savePaymentMethod = createServerFn({ method: "POST" })
	.validator(paymentMethodInput)
	.handler(async ({ data }) => (await ledger()).savePaymentMethod(data));

/* rules */
export const listRules = createServerFn({ method: "GET" }).handler(async () =>
	(await ledger()).listRules(),
);
export const saveRule = createServerFn({ method: "POST" })
	.validator(ruleInput)
	.handler(async ({ data }) => (await ledger()).saveRule(data));
export const deleteRule = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await ledger()).deleteRule(data.id));
export const dryRunRule = createServerFn({ method: "POST" })
	.validator(ruleInput)
	.handler(async ({ data }) => (await ledger()).dryRunRule(data));
export const runRulesOnInbox = createServerFn({ method: "POST" }).handler(
	async () => (await ledger()).runRulesOnInbox(),
);

/* captures */
export const listCaptures = createServerFn({ method: "POST" })
	.validator(captureListInput)
	.handler(async ({ data }) => (await ledger()).listCaptures(data));
export const getCapture = createServerFn({ method: "GET" })
	.validator(idInput)
	.handler(async ({ data }) => (await ledger()).getCapture(data.id));
export const reprocessCaptures = createServerFn({ method: "POST" })
	.validator(z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }))
	.handler(async ({ data }) => (await ledger()).reprocessCaptures(data.ids));
export const ignoreCapture = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await ledger()).ignoreCapture(data.id));

/* connections & exports */
export const listConnectorProviders = createServerFn({ method: "GET" }).handler(
	async () => (await exportsModule()).describeProviders(),
);
export const listConnections = createServerFn({ method: "GET" }).handler(
	async () => (await exportsModule()).listConnections(),
);
export const saveConnection = createServerFn({ method: "POST" })
	.validator(
		z.object({
			id: z.string().uuid().optional(),
			provider: z.enum(["custom_http", "invoice_ninja"]),
			name: z.string().trim().min(1).max(120),
			entityId: z.string().uuid(),
			enabled: z.boolean().default(true),
			config: z.record(z.string(), z.unknown()),
			secret: z.record(z.string(), z.unknown()).optional(),
		}),
	)
	.handler(async ({ data }) => (await exportsModule()).saveConnection(data));
export const deleteConnection = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) =>
		(await exportsModule()).deleteConnection(data.id),
	);
export const testConnection = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => (await exportsModule()).testConnection(data.id));
export const getConnectionOptions = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) =>
		(await exportsModule()).connectionOptions(data.id),
	);
export const queueExports = createServerFn({ method: "POST" })
	.validator(
		z.object({
			allocationIds: z.array(z.string().uuid()).max(500).optional(),
			orderIds: z.array(z.string().uuid()).max(500).optional(),
			connectionId: z.string().uuid().optional(),
			force: z.boolean().optional(),
		}),
	)
	.handler(async ({ data }) => (await exportsModule()).queueExports(data));

/* insights */
export const getInsights = createServerFn({ method: "POST" })
	.validator(insightsInput)
	.handler(async ({ data }) => (await insightsModule()).getInsights(data));
