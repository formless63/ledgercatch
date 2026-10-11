# Chrome Web Store preparation

Status: no publisher account, extension ID, service account or store submission has been configured for this project. Local builds and downloads work without them.

## Publisher setup

1. Register a Chrome Web Store developer account, complete the dashboard requirements and enable two-step verification. Create the first draft item by uploading the verified release ZIP; record its extension ID and publisher ID.
2. Complete the listing, support details, distribution selection and privacy declarations. Host [PRIVACY.md](PRIVACY.md) at a stable public URL. Use the actual extension screenshots in `images/extension-popup.png` and `images/extension-options.png`, adjusting canvas dimensions to the dashboard requirements. Icons are generated from the repository's SVG by `bun run --cwd extension icons`. No third-party merchant branding is required.
3. Enable the Chrome Web Store API in a Google Cloud project. Create a service account and link its email under the publisher account's API access settings. Configure GitHub OIDC Workload Identity Federation restricted to this repository, `main`, and its protected `chrome-store` environment. Grant only the service-account impersonation required for token creation. Do not save a JSON private key in GitHub or the repository.
4. Set GitHub variables `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT`. The workflow obtains a short-lived token with the `https://www.googleapis.com/auth/chromewebstore` scope.
5. After explicit authorization, dispatch **Optional Chrome Web Store upload** for an existing GitHub release version. Default `submit=false` uploads only. `submit=true` requests staged review. Inspect saved upload/submission/status JSON and the dashboard. An in-progress upload stops before submission; fetch status and resolve it before retrying. Approval remains Google's decision. Publish an approved staged item separately in the dashboard after review.

The workflow uses API v2 upload, `:fetchStatus` and `:publish`. Missing configuration reports an optional unconfigured status and makes no request. Failed/processing uploads are not treated as success. A submission does not imply approval or publication; retain review outcomes, rejection reasons and remediation as release evidence.

## Listing draft

**Name:** LedgerCatch

**Summary:** Capture your own purchase orders and invoices into your self-hosted ledger.

**Description:** Bring purchase records together on a server you control. Capture supported order pages and invoice documents, queue uploads when offline, and send them to your LedgerCatch installation. Review purchases, split costs between personal and business entities, reconcile statements and prepare reimbursements in the web app. Requires a self-hosted LedgerCatch server and an API key. No central hosted account is provided. Automatic capture can be disabled globally or per store. Optional recorder and wider-site detection are off by default. Merchant layouts change; inspect captured results before accounting exports.

## Permission and data disclosure

| Permission | Purpose |
| --- | --- |
| storage, unlimitedStorage | Settings, API key, queued captures and local capture history |
| activeTab, scripting | User-triggered page capture and supported capture scripts |
| alarms | Retry queued uploads and scheduled enrichment |
| tabs | Locate source tabs and optional background detail capture |
| supported merchant hosts | Read relevant order pages and responses while browsing |
| optional HTTP/HTTPS hosts | Connect to the user-selected server; optional wider-site detection |

Disclose purchase/financial information, page content, URLs and any personal information contained in orders/invoices. Do not select “no data collected” merely because the server is self-hosted. Explain user-selected destinations and session-based fetching. The standard build excludes debugger permission. Recorder mode and all-sites detection need accurate, visible consent explanations. Use an HTTPS remote server for store review; localhost HTTP is for development. The extension rejects non-loopback HTTP servers and redirects.

The publisher must review these declarations against the final build and dashboard questions; this draft is not a policy-compliance certification.

Official references checked 2026-10-11: [API usage](https://developer.chrome.com/docs/webstore/using-api), [service accounts](https://developer.chrome.com/docs/webstore/service-accounts), [upload states](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/UploadState), [publish and staged review](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish), [user-data policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).
