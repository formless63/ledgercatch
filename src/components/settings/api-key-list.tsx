import { IconKey, IconPuzzle } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDate, formatRelative } from "#/components/app/format";
import { Button, Tag } from "#/components/app/primitives";
import {
	listApiKeys,
	revokeApiKey,
} from "#/integrations/api-platform/api-keys.functions";
import { cn } from "#/lib/utils";
import { errorText } from "./ui";

export const apiKeysQueryKey = ["api-keys"] as const;
export type ApiKeyRow = Awaited<ReturnType<typeof listApiKeys>>[number];

export function isExtensionKey(key: ApiKeyRow) {
	return Boolean(key.permissions?.captures?.includes("write"));
}

export function useApiKeys() {
	return useQuery({
		queryKey: apiKeysQueryKey,
		queryFn: () => listApiKeys(),
	});
}

function describePermissions(key: ApiKeyRow) {
	const out: string[] = [];
	for (const [resource, actions] of Object.entries(key.permissions ?? {}))
		for (const action of actions ?? []) out.push(`${resource}:${action}`);
	return out;
}

export function ApiKeyList({
	filter,
	emptyText = "No API keys yet.",
}: {
	filter?: (key: ApiKeyRow) => boolean;
	emptyText?: string;
}) {
	const client = useQueryClient();
	const keys = useApiKeys();
	const revoke = useMutation({
		mutationFn: (keyId: string) => revokeApiKey({ data: { keyId } }),
		onSuccess: async () => {
			toast.success("Key revoked — clients using it stop working immediately");
			await client.invalidateQueries({ queryKey: apiKeysQueryKey });
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const rows = (keys.data ?? []).filter((key) => !filter || filter(key));

	if (keys.isLoading)
		return <p className="py-4 text-xs text-muted-foreground">Loading keys…</p>;
	if (keys.isError)
		return (
			<p className="py-4 text-xs text-red-600 dark:text-red-400">
				API keys could not be loaded.
			</p>
		);
	if (rows.length === 0)
		return (
			<p className="py-4 text-center text-xs text-muted-foreground">
				{emptyText}
			</p>
		);
	return (
		<ul className="divide-y divide-border">
			{rows.map((key) => {
				const expired =
					key.expiresAt != null && new Date(key.expiresAt) < new Date();
				return (
					<li
						key={key.id}
						className={cn(
							"flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs",
							(!key.enabled || expired) && "opacity-60",
						)}
					>
						<span className="text-muted-foreground [&_svg]:size-3.5">
							{isExtensionKey(key) ? <IconPuzzle /> : <IconKey />}
						</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate font-medium">
								{key.name ?? "Unnamed key"}
							</span>
							<span className="block truncate font-mono text-[11px] text-muted-foreground">
								{key.start ?? key.prefix ?? key.id}… ·{" "}
								{describePermissions(key).join(" ") || "no permissions"}
							</span>
						</span>
						<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
							created {formatDate(key.createdAt)} ·{" "}
							{key.lastRequest
								? `used ${formatRelative(key.lastRequest)}`
								: "never used"}
							{key.expiresAt
								? ` · ${expired ? "expired" : "expires"} ${formatDate(key.expiresAt)}`
								: ""}
						</span>
						{key.enabled && !expired ? (
							<Button
								size="xs"
								variant="danger"
								disabled={revoke.isPending}
								onClick={() => {
									if (
										window.confirm(
											`Revoke “${key.name ?? key.id}”? Anything using it stops working.`,
										)
									)
										revoke.mutate(key.id);
								}}
							>
								Revoke
							</Button>
						) : (
							<Tag tone="neutral">{expired ? "expired" : "revoked"}</Tag>
						)}
					</li>
				);
			})}
		</ul>
	);
}
