# Machine API

Sign in and create a permissioned API key in Settings → API keys. The secret is shown once and stored hashed. Send it as `X-API-Key`; agent endpoints also accept Bearer authentication. Never put keys in URLs or browser screenshots. Keys cannot manage other keys or create normal human sessions.

The generated contract is served at `/api/openapi.json` and documented at `/docs/api`. REST routes live under `/api/v1`, MCP at `/api/mcp`. Every operation resolves its owner from the authenticated principal and applies the required permission. MCP clients should call `get_started`, then `whoami` to discover their own entity/category identifiers.

Money uses integer minor units at the ledger boundary. Capture requests accept stable idempotency keys and versioned payloads. Multipart uploads count actual bytes even without Content-Length and reject oversized fields. Connector secrets remain write-only. Refer to the generated contract for current schemas and limits; it is built from the same operation schemas used by routes.
