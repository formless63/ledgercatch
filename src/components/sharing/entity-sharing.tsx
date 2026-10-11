/**
 * Owner-side "Sharing" section: invite a bookkeeper by email as a read-only
 * viewer of one entity, list shares, copy invite links, revoke.
 * Mount in Settings → Ledger: <EntitySharing />.
 */
import {
	IconCheck,
	IconCopy,
	IconMailForward,
	IconShare,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { formatRelative } from "#/components/app/format";
import {
	Button,
	EmptyState,
	EntityChip,
	Input,
	Panel,
	Select,
	Tag,
} from "#/components/app/primitives";
import {
	inviteEntityShare,
	listEntityShares,
	revokeEntityShare,
} from "#/features/sharing/sharing.functions";

const sharingKey = ["sharing", "owner"] as const;

const STATUS_TONES = {
	pending: "warning",
	active: "success",
	expired: "neutral",
	revoked: "neutral",
} as const;

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function CopyButton({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			size="xs"
			variant="ghost"
			aria-label="Copy invite link"
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(value);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				} catch {
					toast.error("Copy failed");
				}
			}}
		>
			{copied ? <IconCheck /> : <IconCopy />}
			{copied ? "Copied" : "Copy link"}
		</Button>
	);
}

export function EntitySharing({ entityId }: { entityId?: string } = {}) {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: sharingKey,
		queryFn: () => listEntityShares(),
	});
	const [showRevoked, setShowRevoked] = useState(false);
	const [email, setEmail] = useState("");
	const [target, setTarget] = useState(entityId ?? "");
	const [lastInvite, setLastInvite] = useState<{
		email: string;
		url: string;
		emailed: boolean;
	} | null>(null);

	const activeEntities = useMemo(
		() => (query.data?.entities ?? []).filter((e) => !e.archivedAt),
		[query.data],
	);
	const entityById = useMemo(
		() => new Map((query.data?.entities ?? []).map((e) => [e.id, e])),
		[query.data],
	);
	const selectedEntity = target || entityId || activeEntities[0]?.id || "";

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: sharingKey });
	const invite = useMutation({
		mutationFn: (input: { entityId: string; email: string }) =>
			inviteEntityShare({ data: input }),
		onSuccess: (result, input) => {
			setLastInvite({
				email: input.email,
				url: result.inviteUrl,
				emailed: result.emailed,
			});
			setEmail("");
			toast.success(
				result.emailed
					? `Invitation sent to ${input.email}`
					: "Invite created. Email delivery is unavailable: copy the link.",
			);
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const revoke = useMutation({
		mutationFn: (shareId: string) => revokeEntityShare({ data: { shareId } }),
		onSuccess: () => {
			toast.success("Access revoked");
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	const shares = (query.data?.shares ?? []).filter(
		(share) =>
			(!entityId || share.entityId === entityId) &&
			(showRevoked || share.status !== "revoked"),
	);

	return (
		<Panel
			title="Sharing · read-only access"
			action={
				<label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<input
						type="checkbox"
						checked={showRevoked}
						onChange={(e) => setShowRevoked(e.target.checked)}
					/>
					Show revoked
				</label>
			}
			bodyClassName="flex flex-col gap-3 p-3"
		>
			<p className="text-xs text-muted-foreground">
				Give an accountant or bookkeeper read-only access to one entity: its
				allocated orders, invoices, claims, monthly totals and CSV export. They
				sign in with their own email at{" "}
				<span className="font-mono">/share</span> and never see other
				entities&apos; amounts. Every invite, acceptance, download and revoke is
				recorded in the audit log.
			</p>
			<form
				className="grid gap-1.5 sm:grid-cols-[12rem_minmax(0,1fr)_auto]"
				onSubmit={(event) => {
					event.preventDefault();
					if (!selectedEntity || !email.trim()) return;
					invite.mutate({ entityId: selectedEntity, email: email.trim() });
				}}
			>
				<Select
					aria-label="Entity"
					value={selectedEntity}
					disabled={!!entityId}
					onChange={(e) => setTarget(e.target.value)}
				>
					{activeEntities.map((entity) => (
						<option key={entity.id} value={entity.id}>
							{entity.name}
						</option>
					))}
				</Select>
				<Input
					type="email"
					aria-label="Grantee email"
					placeholder="accountant@example.com"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					required
				/>
				<Button
					type="submit"
					variant="primary"
					disabled={invite.isPending || !selectedEntity || !email.trim()}
				>
					<IconMailForward />
					Invite viewer
				</Button>
			</form>
			{lastInvite && (
				<div className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-muted/40 px-2 py-1.5 text-[11px]">
					<span className="text-muted-foreground">
						{lastInvite.emailed ? "Emailed" : "Not emailed"} ·{" "}
						{lastInvite.email} · single use, expires in 14 days
					</span>
					<span className="min-w-0 flex-1 truncate font-mono">
						{lastInvite.url}
					</span>
					<CopyButton value={lastInvite.url} />
				</div>
			)}
			{query.isLoading ? (
				<div className="text-xs text-muted-foreground">Loading…</div>
			) : shares.length === 0 ? (
				<EmptyState
					icon={<IconShare className="size-5" />}
					title="Not shared with anyone"
					className="py-6"
				>
					Invite a viewer above. Access is per entity and can be revoked at any
					time.
				</EmptyState>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-xs">
						<thead>
							<tr className="label-caps text-left">
								<th className="py-1 pr-2 font-normal">Entity</th>
								<th className="py-1 pr-2 font-normal">Grantee</th>
								<th className="py-1 pr-2 font-normal">Status</th>
								<th className="py-1 pr-2 font-normal">Last access</th>
								<th className="py-1 font-normal" />
							</tr>
						</thead>
						<tbody>
							{shares.map((share) => (
								<tr key={share.id} className="h-7 border-t border-border">
									<td className="pr-2">
										<EntityChip
											entity={entityById.get(share.entityId) ?? null}
											short
										/>
									</td>
									<td className="truncate pr-2 font-mono">
										{share.granteeEmail}
									</td>
									<td className="pr-2">
										<Tag tone={STATUS_TONES[share.status]}>{share.status}</Tag>
									</td>
									<td className="pr-2 font-mono text-muted-foreground">
										{share.status === "pending"
											? `invited ${formatRelative(share.createdAt)}`
											: formatRelative(share.lastAccessedAt)}
									</td>
									<td className="text-right">
										{share.status !== "revoked" && (
											<div className="flex justify-end gap-1">
												{share.status !== "active" && (
													<Button
														size="xs"
														variant="ghost"
														disabled={invite.isPending}
														onClick={() =>
															invite.mutate({
																entityId: share.entityId,
																email: share.granteeEmail,
															})
														}
													>
														<IconMailForward />
														Resend
													</Button>
												)}
												<Button
													size="xs"
													variant="danger"
													disabled={revoke.isPending}
													onClick={() => {
														if (
															window.confirm(
																`Revoke ${share.granteeEmail}'s access? They lose access immediately.`,
															)
														)
															revoke.mutate(share.id);
													}}
												>
													<IconTrash />
													Revoke
												</Button>
											</div>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Panel>
	);
}
