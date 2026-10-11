# Releases

The intended upstream is `formless63/ledgercatch`. Version 0.1.0 is a local release candidate; no repository, registry package or store listing is created by these instructions.

Use Bun 1.4.2 and Node 24.21.0. App and extension versions must be the same numeric `major.minor.patch`. The initial release tooling intentionally rejects prerelease versions. Increment both versions before a store update; never reuse a published version.

```sh
bun install --frozen-lockfile
bun install --cwd extension --frozen-lockfile
bun run lint
bun run typecheck
bun run demo:setup
bun run test:demo
bun run --cwd extension typecheck
bun run --cwd extension test
bun run extension:package
bun run build:runtime
# In another terminal: bun run demo:start
bun run demo:screenshots
bun scripts/privacy-scan.ts
docker build -t ledgercatch:verify .
VERIFY_IMAGE=ledgercatch:verify bun scripts/container-smoke.ts
```

`extension:package` builds one MV3 ZIP and copies its exact bytes to `artifacts/ledgercatch-extension-VERSION.zip` and `public/downloads/ledgercatch-extension.zip`, with SHA-256 manifests. Docker serves that ZIP; the store workflow downloads the same release asset and verifies its hash. Debugger permission is forbidden in this distribution. Source tarballs come from `git archive HEAD`, not the working directory.

CI runs installs, formatting, types, isolated database and extension tests, app builds, normal-login synthetic browser checks and screenshots, then a disposable container installation. Database tests require an explicit administrator `TEST_DATABASE_URL`; the runner creates and drops only a unique test database. Container verification records its image ID and architecture in `artifacts/container-verification.json`. Only `linux/amd64` is tested and initially advertised. ARM64 remains unverified.

All third-party workflow actions use full commit SHAs. `actions-lock.json` records the upstream stable versions, commits and verification date. Dependabot checks action and container references. Bun lock updates require running both frozen installs and audits. The app contains targeted overrides for inherited dependency advisories; recheck them during upgrades.

Before first publication, create the destination and configure protected `release` and `chrome-store` environments with reviewer gates. Enable GitHub Actions package writes for the release job. Review the complete source archive, license notices, synthetic screenshots, privacy policy and permission disclosure. Publication is an explicit operator decision.

The **Prepare or publish release** dispatch defaults to `publish=false`: verification only. With explicit approval, dispatch from `main` with its exact package version and `publish=true`. After successful verification it publishes GHCR version, source-SHA and stable `latest` tags with provenance and SBOM, then creates a GitHub release containing source, extension ZIP, checksums and image digest. Builds for publication use the verified source and extension bytes; the published digest must be checked separately. Nothing deploys to a running installation. A GitHub failure after image upload can leave a registry artifact: inspect state before rerunning. Never overwrite a release to conceal that partial state.

Store publishing is a separate optional dispatch described in [CHROME-STORE.md](CHROME-STORE.md). Upload, review submission, approval and publication are different states. No store credentials are required for CI or ZIP downloads.
