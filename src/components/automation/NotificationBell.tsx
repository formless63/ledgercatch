/**
 * Header bell: unread count and the latest in-app notifications. Refreshes
 * through the ledger live stream (query key under ["ledger"]) with a 60s
 * polling fallback. Mount anywhere inside the app shell.
 */
import { IconBell, IconCheck, IconSettings } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { formatRelative } from "#/components/app/format";
import { Button } from "#/components/app/primitives";
import {
	listNotifications,
	markAllNotificationsRead,
	markNotificationRead,
} from "#/features/automation/automation.functions";
import { cn } from "#/lib/utils";

export const notificationKeys = {
	list: ["ledger", "notifications"] as const,
};

export function NotificationBell({ className }: { className?: string }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const client = useQueryClient();
	const navigate = useNavigate();
	const query = useQuery({
		queryKey: notificationKeys.list,
		queryFn: () => listNotifications({ data: { limit: 15 } }),
		refetchInterval: 60_000,
	});
	const invalidate = () =>
		client.invalidateQueries({ queryKey: notificationKeys.list });
	const markRead = useMutation({
		mutationFn: (id: string) =>
			markNotificationRead({ data: { id, read: true } }),
		onSuccess: invalidate,
	});
	const markAll = useMutation({
		mutationFn: () => markAllNotificationsRead(),
		onSuccess: invalidate,
	});

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node))
				setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const unread = query.data?.unread ?? 0;
	const items = query.data?.items ?? [];
	return (
		<div ref={ref} className={cn("relative", className)}>
			<button
				type="button"
				aria-label={
					unread ? `Notifications (${unread} unread)` : "Notifications"
				}
				aria-expanded={open}
				aria-haspopup="dialog"
				onClick={() => setOpen((value) => !value)}
				className="relative inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
			>
				<IconBell className="size-4" />
				{unread > 0 && (
					<span className="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 font-mono text-[9px] font-bold text-primary-foreground">
						{unread > 99 ? "99+" : unread}
					</span>
				)}
			</button>
			{open && (
				<div
					role="dialog"
					aria-label="Notifications"
					className="absolute right-0 z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded border border-border bg-popover text-popover-foreground shadow-lg"
				>
					<header className="flex h-8 items-center justify-between gap-2 border-b border-border px-3">
						<span className="label-caps">Notifications</span>
						<div className="flex items-center gap-1">
							<Button
								size="xs"
								variant="ghost"
								disabled={unread === 0 || markAll.isPending}
								onClick={() => markAll.mutate()}
								title="Mark all read"
							>
								<IconCheck /> All read
							</Button>
							<Link
								to="/app/settings/notifications"
								onClick={() => setOpen(false)}
								className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
								aria-label="Notification settings"
							>
								<IconSettings className="size-3.5" />
							</Link>
						</div>
					</header>
					<ul className="max-h-96 overflow-y-auto">
						{items.length === 0 && (
							<li className="px-3 py-6 text-center text-xs text-muted-foreground">
								{query.isLoading ? "Loading…" : "Nothing new."}
							</li>
						)}
						{items.map((item) => (
							<li
								key={item.id}
								className="border-b border-border last:border-b-0"
							>
								<button
									type="button"
									onClick={() => {
										if (!item.readAt) markRead.mutate(item.id);
										if (item.link?.startsWith("/")) {
											setOpen(false);
											void navigate({ to: item.link });
										}
									}}
									className={cn(
										"flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-accent",
										!item.readAt && "bg-primary/5",
									)}
								>
									<span className="flex items-center gap-1.5 text-xs font-medium">
										{!item.readAt && (
											<span className="size-1.5 shrink-0 rounded-full bg-primary" />
										)}
										<span className="truncate">{item.title}</span>
									</span>
									<span className="line-clamp-3 whitespace-pre-line text-[11px] text-muted-foreground">
										{item.body}
									</span>
									<span className="font-mono text-[10px] text-muted-foreground">
										{formatRelative(item.createdAt)}
									</span>
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
