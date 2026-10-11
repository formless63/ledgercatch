# Synthetic demo

`bun run demo:setup` generates `.demo/env` with random local credentials, starts the named `ledgercatch-demo` PostgreSQL, RustFS and Mailpit services and applies the ordinary migrations. `bun run demo:start` runs the application on port 4300, its worker and a local fake HTTP provider on 59090. PostgreSQL uses 55432, storage 59000, SMTP 51025 and Mailpit UI 58025; all published ports bind loopback. The network and volumes belong only to this Compose project. `DEMO_SUBNET` can override the dedicated subnet if the default conflicts with local routing.

The environment file is ignored and never part of screenshots, source archives or images. The seed refuses non-demo database identities, endpoints, buckets and unknown user identities; it never resets arbitrary configured data. Repeating `bun run demo:seed` preserves stable fixture identities and totals. Do not add real accounts or captures to the demo.

The local inbox has no relay. Worker polling/digest/tracking/FX schedules are disabled in the designated demo environment; no external sources, sessions, tokens or notification destinations are seeded. The fake provider connection is disabled for automatic exports. Optional manual testing calls only the local fake provider. The demo host processes are not a security sandbox; use the supplied synthetic configuration only.

Sign in normally as `demo@example.test`; read the magic link at http://127.0.0.1:58025. `bookkeeper@example.test` has a synthetic read-only share for Juniper Studio. `other@example.test` is a separate owner.

For screenshots:

```sh
bun run extension:package
bunx playwright install chromium
bun run demo:screenshots
```

Playwright uses a fresh browser profile, UTC, dark mode, fixed client time and consistent desktop/mobile dimensions. It signs in through the normal magic-link API and local inbox, waits for loaded data, captures six actual app pages and loads the actual built MV3 extension for popup/options screenshots. Its browser rejects external requests. Selected PNGs are stored under `docs/images/`; inspect all regenerated images before committing them. Extension screenshots show the honest unconfigured state, without a key or live browser session.

Stop infrastructure while keeping data:

```sh
docker compose --env-file .demo/env -f compose.demo.yaml down
```

Only append `--volumes` when intentionally discarding this synthetic demo.
