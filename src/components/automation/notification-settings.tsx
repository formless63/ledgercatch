/** Notification channels, digest schedule and alert toggles. */
import { IconBellRinging, IconSend } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	Button,
	Field,
	Input,
	Panel,
	Select,
} from "#/components/app/primitives";
import { Callout, errorText, Switch } from "#/components/settings/ui";
import {
	getNotificationSettings,
	saveNotificationSettings,
	sendDigestNow,
	sendTestNotification,
} from "#/features/automation/automation.functions";

export const automationKeys = {
	settings: ["ledger", "automation", "settings"] as const,
	endpoints: ["ledger", "automation", "endpoints"] as const,
	invoiceNinja: ["ledger", "automation", "invoice-ninja"] as const,
	budgets: ["ledger", "automation", "budgets"] as const,
};

type AlertKey =
	| "inbox"
	| "missingInvoices"
	| "pendingReimbursements"
	| "exports"
	| "captures"
	| "enrichment"
	| "budgets"
	| "captureFailures"
	| "exportFailures"
	| "claimPaid";

const DIGEST_ALERTS: Array<[AlertKey, string]> = [
	["inbox", "Unassigned inbox orders"],
	["missingInvoices", "Assigned orders (>3 days) without an invoice"],
	["pendingReimbursements", "Pending reimbursements by entity"],
	["exports", "Failed or out-of-date exports"],
	["captures", "Failed / needs-review captures"],
	["enrichment", "Orders waiting for store details"],
];
const INSTANT_ALERTS: Array<[AlertKey, string]> = [
	["budgets", "Budget thresholds"],
	["captureFailures", "Capture failures (batched hourly)"],
	["exportFailures", "Export failures (batched hourly)"],
	["claimPaid", "Reimbursement invoice paid"],
];

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

type Settings = Awaited<ReturnType<typeof getNotificationSettings>>;

export function NotificationSettingsPanel() {
	const client = useQueryClient();
	const query = useQuery({
		queryKey: automationKeys.settings,
		queryFn: () => getNotificationSettings(),
	});
	const [draft, setDraft] = useState<Settings | null>(null);
	useEffect(() => {
		if (query.data && !draft) setDraft(query.data);
	}, [query.data, draft]);
	const save = useMutation({
		mutationFn: (value: Settings) =>
			saveNotificationSettings({
				data: {
					channels: value.channels,
					ntfyTopic: value.ntfyTopic?.trim() ? value.ntfyTopic.trim() : null,
					digestEnabled: value.digestEnabled,
					digestHour: value.digestHour,
					timezone: value.timezone,
					alerts: value.alerts,
				},
			}),
		onSuccess: () => {
			toast.success("Notification settings saved");
			void client.invalidateQueries({ queryKey: automationKeys.settings });
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const test = useMutation({
		mutationFn: () => sendTestNotification(),
		onSuccess: (result) =>
			toast.success(
				`Test sent in-app${result.channels.length ? ` + ${result.channels.join(", ")}` : ""}`,
			),
		onError: (error) => toast.error(errorText(error)),
	});
	const digest = useMutation({
		mutationFn: () => sendDigestNow(),
		onSuccess: (result) =>
			toast.success(result.sent ? "Digest sent" : "Nothing needs attention"),
		onError: (error) => toast.error(errorText(error)),
	});

	if (!draft) return <Panel title="Notifications">Loading…</Panel>;
	const set = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
	const alertOn = (key: AlertKey) => draft.alerts[key] !== false;
	const toggleAlert = (key: AlertKey, value: boolean) =>
		set({ alerts: { ...draft.alerts, [key]: value } });
	const zones =
		typeof Intl.supportedValuesOf === "function"
			? Intl.supportedValuesOf("timeZone")
			: [draft.timezone];

	return (
		<Panel
			title="Notifications"
			action={
				<div className="flex gap-1">
					<Button
						size="xs"
						onClick={() => test.mutate()}
						disabled={test.isPending}
					>
						<IconBellRinging /> Test
					</Button>
					<Button
						size="xs"
						onClick={() => digest.mutate()}
						disabled={digest.isPending}
					>
						<IconSend /> Send digest now
					</Button>
				</div>
			}
			bodyClassName="flex flex-col gap-4"
		>
			<section className="grid gap-3 sm:grid-cols-3">
				<ChannelRow
					label="In-app"
					hint="Bell in the header; always recorded."
					checked={draft.channels.inApp}
					onChange={(inApp) => set({ channels: { ...draft.channels, inApp } })}
				/>
				<ChannelRow
					label="Email"
					hint={
						draft.emailConfigured
							? "Sent to your account email."
							: "SMTP is not configured on this server."
					}
					checked={draft.channels.email}
					disabled={!draft.emailConfigured && !draft.channels.email}
					onChange={(email) => set({ channels: { ...draft.channels, email } })}
				/>
				<ChannelRow
					label="ntfy"
					hint={
						draft.ntfyConfigured
							? `Server: ${draft.ntfyServer}`
							: "NTFY_BASE_URL is not configured."
					}
					checked={draft.channels.ntfy}
					disabled={!draft.ntfyConfigured && !draft.channels.ntfy}
					onChange={(ntfy) => set({ channels: { ...draft.channels, ntfy } })}
				/>
			</section>
			{draft.channels.ntfy && (
				<Field
					label="ntfy topic"
					hint="Pick an unguessable topic; anyone who knows it can read it on a public server."
				>
					<Input
						value={draft.ntfyTopic ?? ""}
						maxLength={64}
						onChange={(event) => set({ ntfyTopic: event.target.value })}
						placeholder="ledgercatch-7f3k2"
					/>
				</Field>
			)}
			<section className="grid gap-3 sm:grid-cols-3">
				<ChannelRow
					label="Daily digest"
					hint={
						draft.lastDigestDate
							? `Last sent ${draft.lastDigestDate}`
							: "Skipped when nothing needs attention."
					}
					checked={draft.digestEnabled}
					onChange={(digestEnabled) => set({ digestEnabled })}
				/>
				<Field label="Send at (local hour)">
					<Select
						value={draft.digestHour}
						onChange={(event) =>
							set({ digestHour: Number(event.target.value) })
						}
					>
						{HOURS.map((hour) => (
							<option key={hour} value={hour}>
								{String(hour).padStart(2, "0")}:00
							</option>
						))}
					</Select>
				</Field>
				<Field label="Time zone">
					<Select
						value={draft.timezone}
						onChange={(event) => set({ timezone: event.target.value })}
					>
						{[...new Set(["UTC", draft.timezone, ...zones])].map((zone) => (
							<option key={zone} value={zone}>
								{zone}
							</option>
						))}
					</Select>
				</Field>
			</section>
			<section className="grid gap-4 sm:grid-cols-2">
				<AlertList
					title="In the digest"
					items={DIGEST_ALERTS}
					isOn={alertOn}
					onToggle={toggleAlert}
				/>
				<AlertList
					title="Instant alerts"
					items={INSTANT_ALERTS}
					isOn={alertOn}
					onToggle={toggleAlert}
				/>
			</section>
			{draft.channels.ntfy && !draft.ntfyTopic?.trim() && (
				<Callout tone="warning">Set a topic to receive ntfy pushes.</Callout>
			)}
			<div className="flex justify-end">
				<Button
					variant="primary"
					onClick={() => save.mutate(draft)}
					disabled={save.isPending}
				>
					Save
				</Button>
			</div>
		</Panel>
	);
}

function ChannelRow({
	label,
	hint,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	hint: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (value: boolean) => void;
}) {
	return (
		<div className="flex items-start gap-2 rounded-sm border border-border px-2.5 py-2">
			<Switch
				checked={checked}
				onChange={onChange}
				label={label}
				disabled={disabled}
			/>
			<div className="min-w-0">
				<div className="text-xs font-medium">{label}</div>
				<div className="text-[11px] text-muted-foreground">{hint}</div>
			</div>
		</div>
	);
}

function AlertList({
	title,
	items,
	isOn,
	onToggle,
}: {
	title: string;
	items: Array<[AlertKey, string]>;
	isOn: (key: AlertKey) => boolean;
	onToggle: (key: AlertKey, value: boolean) => void;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="label-caps">{title}</div>
			{items.map(([key, label]) => (
				<div key={key} className="flex items-center gap-2 text-xs">
					<Switch
						checked={isOn(key)}
						onChange={(v) => onToggle(key, v)}
						label={label}
					/>
					<span>{label}</span>
				</div>
			))}
		</div>
	);
}
