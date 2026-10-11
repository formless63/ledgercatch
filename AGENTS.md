# Contributor guidance

This is the independently maintained LedgerCatch application. Use Bun and strict TypeScript. Run `bun install --frozen-lockfile` here and in `extension/`.

Preserve owner-scoped `*ForOwner(ownerId, …)` cores. Every database read and mutation requires an owner or verified share predicate. Session and API-key routes resolve identity and permissions before calling cores. Use native TanStack Start functions/routes, PostgreSQL/Drizzle, passwordless Better Auth, Tailwind 4 and existing components.

Worker-reachable modules must not statically import TanStack Start. Use request-only lazy imports. Import `cheerio/slim`, version parser output changes and use synthetic fixtures.

Generate and review additive Drizzle migrations; never edit applied history or use schema push. Qualify correlated SQL columns. Preserve identities and encryption keys during upgrades.

Keep names configurable through APP_NAME, VITE_APP_NAME and EXT_APP_NAME. Never commit secrets, real captures, databases or personal data. Tests run only on disposable development databases. Serialize heavy checks/builds.

Run affected tests, `bun run lint`, `bun run typecheck`, and application/extension builds. Use GitHub Issues for public work tracking. No tooling depends on a containing repository. Publishing, remote pushes and deployment require explicit owner authorization.
