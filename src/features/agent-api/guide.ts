import { appName } from "#/lib/app-name";
/** Workflow guide returned by the MCP `get_started` tool. */
export const AGENT_GUIDE = `# ${appName} — agent workflow

## Model
- **Orders** come from captures (browser extension, email, imports, or you via create_order). (source, externalOrderId) identifies an order; posting it again merges new facts.
- **Entities** are who an expense belongs to (Personal + businesses). An order has one primary entity; individual line items can override it ("split").
- **Allocations** are derived per order: one row per entity with its share of the total (items + proportional shipping/tax/discount). Never write them directly — assign entities and they recompute.
- **Payment methods** (cards) have a *paying entity*. If the entity that paid differs from the allocated entity, that allocation is **reimbursable** and starts \`pending\`.
- **Claims** group reimbursable allocations (payer ↔ owing entity, one currency). Creating a claim marks its allocations \`submitted\`; marking the claim \`paid\` marks them \`reimbursed\`; \`void\` releases them back to \`pending\`.
- Money is always integer **minor units** (cents) + ISO currency.

## Triage loop
1. \`whoami\` — learn entity / category / payment-method ids and your permissions.
2. \`list_inbox\` — orders with reviewState=inbox (untriaged).
3. For each: \`get_order\` if you need items; decide entity (and category).
   - Whole order: \`update_order { orderId, entityId, categoryId, reviewState: "filed" }\`.
   - Mixed order: \`split_order\` / \`assign_item\` per item, then \`file_orders\`.
   - Many at once: \`bulk_update_orders { ids, entityId, reviewState: "filed" }\`.
   - Junk / duplicates: \`file_orders { ids, reviewState: "ignored" }\`.
4. Prefer creating a **rule** for recurring patterns (\`dry_run_rule\` first, then \`upsert_rule\`, then \`apply_rules\` to re-run rules over the inbox).

## Entering orders
\`create_order\` takes structured orders (externalOrderId required; amounts in minor units; items optional). Pass an \`idempotencyKey\` so retries never duplicate. Optional \`triage\` assigns entity/category/state right after ingest. Unknown shops use source \`generic\` (namespaced by the order URL host or merchant name).

## Reimbursement
- \`list_reimbursements\` shows open reimbursable allocations and claims.
- \`set_reimbursement { allocationIds, status }\` to override (status \`none\` makes it non-reimbursable).
- \`create_claim { allocationIds }\` → then \`set_claim_status\` to \`paid\` when settled.

## Exports
\`queue_export { orderIds | allocationIds }\` pushes allocations to the accounting connection of each allocation's entity (asynchronous). \`force: true\` re-sends.

## Safety
- Everything is scoped to the key owner. Writes are audited as the user.
- Prefer filing over ignoring; ignoring hides an order from insights.
- Never guess entity ids: read them from \`whoami\` / \`list_entities\`.
- Errors come back as \`{ error: { code, message, details } }\`; \`forbidden\` means the key lacks a permission (ledger:read, ledger:write, admin:write).
`;
