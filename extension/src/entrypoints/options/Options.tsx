import {
	IconCheck,
	IconDeviceFloppy,
	IconEye,
	IconEyeOff,
	IconLoader2,
	IconPackage,
	IconPlugConnected,
	IconTrash,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { appName, extensionVersion } from "@/lib/app";
import { clearEnrichmentDiagnostic } from "@/lib/enrichment-diagnostics";
import { sendToBackground } from "@/lib/messaging";
import { ALL_SITES_PATTERNS } from "@/lib/order-detector";
import { type Settings, saveSettings } from "@/lib/settings";
import type { ConnectionState } from "@/lib/state";
import { STORES } from "@/lib/stores";
import { errorMessage, normalizeServerUrl, originPattern } from "@/lib/util";
import { Button, cx, Label, Mono, Panel, StatusPill, TextField, Toggle, toneText } from "@/ui/components";
import { useSettings, useStoredState } from "@/ui/hooks";
import { EnrichmentDiagnostics } from "./EnrichmentDiagnostics";

type Flash = { tone: "ok" | "warn" | "bad"; text: string } | null;

/** Ask for access to the server origin. Must start inside a click handler. */
function requestServerPermission(serverUrl: string): Promise<boolean> {
	const pattern = originPattern(serverUrl);
	if (!pattern) return Promise.resolve(false);
	return browser.permissions.request({ origins: [pattern] }).catch(() => false);
}

export function Options() {
	const settings = useSettings();
	const conn = useStoredState("connection");
	const summary = useStoredState("outboxSummary");

	const [serverUrl, setServerUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [flash, setFlash] = useState<Flash>(null);
	const [detectFlash, setDetectFlash] = useState<Flash>(null);
	const [debuggerGranted, setDebuggerGranted] = useState(false);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		if (settings && !loaded) {
			setServerUrl(settings.serverUrl);
			setApiKey(settings.apiKey);
			setLoaded(true);
		}
	}, [settings, loaded]);

	useEffect(() => {
		browser.permissions
			.contains({ permissions: ["debugger"] })
			.then(setDebuggerGranted)
			.catch(() => setDebuggerGranted(false));
	}, []);

	const normalized = normalizeServerUrl(serverUrl);
	const dirty = settings !== null && (serverUrl !== settings.serverUrl || apiKey !== settings.apiKey);

	const run = async (key: string, fn: () => Promise<Flash>) => {
		setBusy(key);
		setFlash(null);
		try {
			setFlash(await fn());
		} catch (err) {
			setFlash({ tone: "bad", text: errorMessage(err) });
		} finally {
			setBusy(null);
		}
	};

	const persistConnection = async (granted: boolean): Promise<string> => {
		if (!normalized) throw new Error("Use an HTTPS server URL, or HTTP on localhost for development");
		await saveSettings({ serverUrl: normalized, apiKey: apiKey.trim() });
		setServerUrl(normalized);
		setApiKey(apiKey.trim());
		await sendToBackground("settings/changed", null);
		return granted ? "" : " (host access declined; requests rely on the server's CORS headers)";
	};

	const onSave = () => {
		const permission = normalized ? requestServerPermission(normalized) : Promise.resolve(false);
		void run("save", async () => {
			const suffix = await persistConnection(await permission);
			return { tone: suffix ? "warn" : "ok", text: `Saved${suffix}.` };
		});
	};

	const onTest = () => {
		const permission = normalized ? requestServerPermission(normalized) : Promise.resolve(false);
		void run("test", async () => {
			await persistConnection(await permission);
			const status = await sendToBackground("connection/test", null);
			return { tone: "ok", text: `Connected to ${status.appName} as ${status.user.name} <${status.user.email}>.` };
		});
	};

	const update = (patch: Partial<Settings>) => {
		void saveSettings(patch).then(async () => {
			if (patch.recorderMode === false) await clearEnrichmentDiagnostic();
			await sendToBackground("settings/changed", null).catch(() => null);
		});
	};

	/** Turning auto-detect on asks for all-sites access; must start inside the click. */
	const onAutoDetect = (enabled: boolean) => {
		setDetectFlash(null);
		if (!enabled) {
			update({ autoDetectOrders: false });
			return;
		}
		const permission = browser.permissions.request({ origins: ALL_SITES_PATTERNS }).catch(() => false);
		void (async () => {
			try {
				if (!(await permission)) {
					setDetectFlash({ tone: "warn", text: "Auto-detect needs access to all sites; the permission was declined." });
					return;
				}
				await saveSettings({ autoDetectOrders: true });
				await sendToBackground("settings/changed", null);
				setDetectFlash({ tone: "ok", text: "Auto-detect is on. Reload open shop tabs for it to apply there." });
			} catch (err) {
				setDetectFlash({ tone: "bad", text: errorMessage(err) });
			}
		})();
	};

	const onClear = (history: boolean) => {
		const what = history ? "the outbox AND the capture history" : "all queued (unsent) uploads";
		if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
		void run("clear", async () => {
			const { removed } = await sendToBackground("outbox/clear", { history });
			return { tone: "ok", text: `Removed ${removed} queued item(s)${history ? " and cleared history" : ""}.` };
		});
	};

	if (!settings) return <div className="p-6 text-muted">Loading…</div>;

	return (
		<div className="mx-auto flex max-w-[760px] flex-col gap-3 p-5">
			<header className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<IconPackage size={20} className="text-accent" stroke={1.75} />
					<h1 className="text-[15px] font-semibold">{appName()}</h1>
					<Mono className="text-muted">v{extensionVersion()}</Mono>
				</div>
				<ConnectionSummary conn={conn} />
			</header>

			<Panel title="Server">
				<div className="flex flex-col gap-3">
					<TextField
						label="Server URL"
						value={serverUrl}
						onChange={setServerUrl}
						placeholder="https://orders.example.com"
						spellCheck={false}
						autoComplete="off"
						hint={
							serverUrl && !normalized ? (
								<span className="text-bad">Use HTTPS, or HTTP on localhost.</span>
							) : (
								"The base URL of your self-hosted app. You'll be asked to allow the extension to talk to it."
							)
						}
					/>
					<TextField
						label="API key"
						value={apiKey}
						onChange={setApiKey}
						type={showKey ? "text" : "password"}
						placeholder="Paste the key created in the web app"
						spellCheck={false}
						autoComplete="off"
						hint="Create it in the web app under API keys, with the captures, documents and orders permissions."
						right={
							<Button
								variant="default"
								className="h-8 px-2"
								onClick={() => setShowKey((v) => !v)}
								aria-label={showKey ? "Hide key" : "Show key"}
							>
								{showKey ? <IconEyeOff size={14} /> : <IconEye size={14} />}
							</Button>
						}
					/>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							variant="primary"
							disabled={busy !== null || !normalized || !apiKey.trim()}
							onClick={onSave}
							icon={
								busy === "save" ? <IconLoader2 size={14} className="animate-spin" /> : <IconDeviceFloppy size={14} />
							}
						>
							Save
						</Button>
						<Button
							disabled={busy !== null || !normalized || !apiKey.trim()}
							onClick={onTest}
							icon={
								busy === "test" ? <IconLoader2 size={14} className="animate-spin" /> : <IconPlugConnected size={14} />
							}
						>
							Save &amp; test connection
						</Button>
						{dirty && <span className="font-mono text-[11px] text-warn">unsaved changes</span>}
					</div>
					{flash && <div className={cx("text-[12px]", toneText(flash.tone))}>{flash.text}</div>}
				</div>
			</Panel>

			<Panel title="Passive capture">
				<div className="flex flex-col divide-y divide-line">
					<Toggle
						checked={settings.passiveCapture}
						onChange={(v) => update({ passiveCapture: v })}
						label="Capture automatically while browsing"
						hint="Order lists, order details, confirmations and invoice pages on the stores below are sent to your server."
					/>
					<div className="grid grid-cols-1 gap-x-6 py-1 sm:grid-cols-2">
						{STORES.map((store) => (
							<Toggle
								key={store.id}
								disabled={!settings.passiveCapture}
								checked={settings.stores[store.id]}
								onChange={(v) => update({ stores: { ...settings.stores, [store.id]: v } })}
								label={store.label}
								hint={<Mono className="text-[10px] text-muted">{store.domains.join(" · ")}</Mono>}
							/>
						))}
					</div>
					<Toggle
						disabled={!settings.passiveCapture}
						checked={settings.autoDetectOrders}
						onChange={onAutoDetect}
						label="Auto-detect order confirmations on other sites"
						hint="Recognizes order confirmation and order detail pages of Shopify, WooCommerce, PrestaShop, Magento, BigCommerce and Medusa shops on any site and sends them (once per page) as snapshots. Asks for access to all sites; pages that don't match are only inspected locally and never sent. Your server and the stores above are excluded."
					/>
					{detectFlash && <div className={cx("py-1 text-[12px]", toneText(detectFlash.tone))}>{detectFlash.text}</div>}
					<Toggle
						checked={settings.recorderMode}
						onChange={(v) => update({ recorderMode: v })}
						label={
							<span className="flex items-center gap-2">
								Recorder / debug mode {settings.recorderMode && <StatusPill tone="warn">on</StatusPill>}
							</span>
						}
						hint="Sends EVERY JSON response and a snapshot of EVERY page on enabled store domains. Use briefly to collect fixtures for improving server parsers, then turn it off."
					/>
				</div>
			</Panel>

			<Panel title="Invoices">
				<Toggle
					checked={debuggerGranted && settings.printInvoicesToPdf}
					disabled={!debuggerGranted}
					onChange={(v) => update({ printInvoicesToPdf: v })}
					label="Save HTML invoices as PDF"
					hint={
						debuggerGranted
							? "This build includes the debugger permission (EXT_DEBUGGER_PERMISSION=required). Prints invoice pages to PDF with the browser's debugger API in a background tab; Chrome shows a “started debugging this browser” bar while it runs. When off, HTML invoices are saved as HTML invoice documents instead."
							: "Off in this build: the debugger permission is not included by default (it shows a broad install warning). HTML invoices are saved as HTML invoice documents, which the app shows as text, and their order data is still parsed. To print them to PDF instead, rebuild with EXT_DEBUGGER_PERMISSION=required."
					}
				/>
			</Panel>

			<Panel title="Missing order details">
				<div className="flex flex-col divide-y divide-line">
					<Toggle
						checked={settings.fetchMissingDetails}
						onChange={(v) => update({ fetchMissingDetails: v })}
						label="Fetch missing order details in the background"
						hint="When the server knows an order only partially (for example from an order email), it asks the extension to fetch the store's order-detail page with your logged-in session every 15 minutes (at most 20 pages per run, one request per store every 3 s). Stops for a store when you appear signed out."
					/>
					<Toggle
						disabled={!settings.fetchMissingDetails}
						checked={settings.fetchDetailsInTabs}
						onChange={(v) => update({ fetchDetailsInTabs: v })}
						label="Open client-rendered pages in a background tab"
						hint="AliExpress, DigiKey and Alibaba render orders in the browser. When on, an inactive tab waits up to 20 s for visible order data and queues a snapshot before closing. An unready page stops that store for the current run. While off, these detail requests wait on the server."
					/>
				</div>
				<EnrichmentDiagnostics recorderMode={settings.recorderMode} />
			</Panel>

			<Panel title="Outbox & history">
				<div className="flex flex-wrap items-center gap-3">
					<span className="text-[12px] text-muted">
						<Label>Pending</Label> <Mono>{summary.pending}</Mono> <Label className="ml-2">Failed</Label>{" "}
						<Mono>{summary.failed}</Mono>
					</span>
					<div className="ml-auto flex gap-2">
						<Button
							variant="danger"
							disabled={busy !== null}
							onClick={() => onClear(false)}
							icon={<IconTrash size={14} />}
						>
							Clear outbox
						</Button>
						<Button
							variant="danger"
							disabled={busy !== null}
							onClick={() => onClear(true)}
							icon={<IconTrash size={14} />}
						>
							Clear outbox &amp; history
						</Button>
					</div>
				</div>
			</Panel>
		</div>
	);
}

function ConnectionSummary({ conn }: { conn: ConnectionState }) {
	switch (conn.state) {
		case "ok":
			return (
				<span className="flex items-center gap-2 text-[12px] text-muted">
					<IconCheck size={14} className="text-ok" />
					{conn.userEmail ?? "Connected"}
					<StatusPill tone="ok">Connected</StatusPill>
				</span>
			);
		case "auth_error":
			return <StatusPill tone="bad">Auth error ({conn.status})</StatusPill>;
		case "unreachable":
			return (
				<span title={conn.message}>
					<StatusPill tone="warn">Unreachable</StatusPill>
				</span>
			);
		case "unconfigured":
			return <StatusPill tone="warn">Not configured</StatusPill>;
		default:
			return <StatusPill tone="muted">Not tested</StatusPill>;
	}
}
