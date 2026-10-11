# Application architecture

Browser extension, mobile capture, email and imports create immutable captures. Versioned parsers generate orders, items and shipment evidence. Owner rules and allocations assign purchases to personal/business entities; claims, reconciliation, refunds and documents share those identities. Exports use the existing typed background queue.

`src/features/**` contains owner-scoped domain cores. TanStack Start session functions and native API routes restore identity/permissions and delegate. SQL owner/share predicates are required independently of route protection. Accountant sharing grants read-only access to one entity. API keys are hashed, permission-restricted and cannot manage human sessions or other keys.

PostgreSQL/Drizzle owns persistence and additive migration history. Better Auth provides passwordless authentication. `src/integrations` contains application runtime services: jobs, storage, observability, email, audit, AI, search, realtime, notifications, webhooks and Invoice Ninja. These are app source, not distributable add-ons. There is no generator, capability catalog or containing-repository dependency.

`src/integrations/jobs/registry.ts` is the typed queue registry. Workers import no request runtime statically. App and worker never migrate schema on startup; deployment runs the app and queue migrations first. Object storage holds private invoice/receipt bytes. The request-owning domain authorizes uploads/downloads; the generic storage client has no tenancy model.

Browser code does not import database/auth server modules. Product names come from APP_NAME/VITE_APP_NAME and extension build overrides. The extension shares `src/shared` from this same repository and has an independent Bun lockfile.
