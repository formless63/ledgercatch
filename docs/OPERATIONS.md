# Backups and upgrades

Back up PostgreSQL (including pg-boss and Drizzle history), all document objects, and the secret-encryption configuration together. Keep secrets outside Git and encrypt off-host backups. A database dump alone cannot restore invoices. Preserve storage keys and stable order/entity/allocation/claim/share identities.

For a running installation, schedule `pg_dump -Fc` using an operator-scoped database credential and separately copy the object bucket with a provider-supported tool that retains keys and metadata. Verify restoration into a new isolated database and bucket before relying on the backup. Never restore over the only live copy. The synthetic-only `scripts/rehearse-restore.ts` demonstrates table fingerprints, migration no-op behavior and byte-exact object restore without accepting live configuration.

Existing installations retain the committed Drizzle migration history. Do not reset history, use schema push, edit applied SQL or apply a fresh baseline over existing data. Compare the installed migration hashes before upgrading. Run `migrate`, `jobs-migrate`, then `jobs-doctor` with the candidate image before starting app/worker.

When adopting an existing Order Tracker database, retain the original `APP_ENCRYPTION_KEY` (or `BETTER_AUTH_SECRET` if no separate key was configured). LedgerCatch authenticates and reads predecessor connector credentials using their original encryption namespace; new or edited credentials use the LedgerCatch namespace. No bulk credential rewrite is needed. Keep the original backup for rollback: an older image cannot read newly encrypted LedgerCatch credentials.

Before replacing a deployment, stop old producers and workers, drain or quarantine incompatible queued work, and record a recovery point. Unsupported connection providers must be disabled and pending exports reviewed; never silently map them to a new custom endpoint. Retain historical connection/export rows and encryption keys. The worker refuses disabled, unsupported or owner/entity-mismatched connections.

Check login, ledger totals, document downloads, processing, claims, shares and remaining integrations after startup. Keep the previous image and backup recoverable. Before candidate writes begin, rollback can restore the previous image. After writes begin, preserve those writes and follow a reviewed restore/reconciliation procedure; do not blindly roll back the database. Real-data rehearsal and cutover require explicit operator authorization.
