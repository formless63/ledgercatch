# Install and configure

Use Bun 1.4.2, Node 24.21.0, PostgreSQL 18 and an S3-compatible object store. App and worker are separate processes. Authentication is passwordless: SMTP magic links, GitHub OAuth or OIDC. Keep a stable `BETTER_AUTH_SECRET` and `APP_ENCRYPTION_KEY`; losing the latter makes encrypted connector/source credentials unreadable.

Start with the isolated demo to verify the host. For a deployment, copy `.env.example` to ignored `.env`, configure explicit database/auth/public URL and storage settings, and set at least one sign-in provider. Set `ALLOWED_SIGNUP_EMAILS` to your permitted addresses or domains; empty permits only the first account. Generate fresh secrets with a cryptographic random generator. Do not use demo credentials.

For the supplied Compose installation also set `POSTGRES_PASSWORD` (a random hex string), `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`. Configure your external SMTP provider or OAuth credentials. Compose overrides the database/storage hostnames to its own services; do not set a conflicting `PGBOSS_DATABASE_URL`. Set `APP_BASE_URL` to your HTTPS origin and put a TLS reverse proxy in front of the loopback app port.

Prepare the image locally:

```sh
bun install --frozen-lockfile
bun install --cwd extension --frozen-lockfile
bun run extension:package
docker build -t ledgercatch:local .
```

The image requires the already verified extension ZIP under `public/downloads`; it never independently rebuilds it. `VITE_APP_NAME` is a Docker build argument. Startup requires explicit configuration; migrations are separate one-shot services and must succeed before app/worker start.

```sh
docker compose --env-file .env up -d
```

Readiness is `/api/health`. Diagnose the queue schema with `docker compose exec worker node .output/jobs-doctor.mjs`. Both processes need the same database, object storage and secret-encryption configuration. Keep optional AI, tracking, IMAP, webhooks and accounting unset until you deliberately configure them.

The extension can be installed without a store account: download `/downloads/ledgercatch-extension.zip`, extract it, open `chrome://extensions`, enable Developer mode and select Load unpacked. In Options, enter your server's HTTPS URL and a capture-scoped API key generated in the app. Recorder mode and broad storefront detection are optional; review what is captured before enabling them. Standard builds omit the debugger permission. Store publication is separate from unpacked installation.
