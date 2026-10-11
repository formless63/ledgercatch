/** Carrier tracking links and refresh state (#21). */
import { IconExternalLink, IconTruckDelivery } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { formatRelative } from "#/components/app/format";
import { Tag } from "#/components/app/primitives";
import { lifecycleKeys } from "#/features/lifecycle/hooks";
import { getOrderTracking } from "#/features/lifecycle/lifecycle.functions";
import {
	seventeenTrackLink,
	trackingLink,
} from "#/features/lifecycle/tracking";
import { cn } from "#/lib/utils";

/**
 * Tracking number linked to the carrier's page (USPS, UPS, FedEx, DHL,
 * Cainiao, YunExpress), with a 17TRACK fallback link.
 */
export function TrackingLink({
	carrier,
	trackingNumber,
	className,
	showCarrier = true,
}: {
	carrier: string | null | undefined;
	trackingNumber: string;
	className?: string;
	showCarrier?: boolean;
}) {
	const link = trackingLink(carrier, trackingNumber);
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
			{showCarrier && (
				<span className="inline-flex items-center gap-1 text-muted-foreground">
					<IconTruckDelivery className="size-3.5" />
					{link.label}
				</span>
			)}
			<a
				href={link.url}
				target="_blank"
				rel="noreferrer"
				className="truncate font-mono hover:underline"
				title={`Track on ${link.label}`}
			>
				{trackingNumber}
			</a>
			{link.carrier !== "unknown" && (
				<a
					href={seventeenTrackLink(trackingNumber)}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-0.5 font-mono text-[9px] uppercase text-muted-foreground hover:text-foreground"
					title="Track on 17TRACK"
				>
					17t
					<IconExternalLink className="size-2.5" />
				</a>
			)}
		</span>
	);
}

export function useOrderTracking(orderId: string) {
	return useQuery({
		queryKey: lifecycleKeys.tracking(orderId),
		queryFn: () => getOrderTracking({ data: { orderId } }),
		staleTime: 5 * 60_000,
	});
}

/** Last automatic check for one shipment (renders nothing when untracked). */
export function TrackingRefreshNote({
	orderId,
	shipmentId,
}: {
	orderId: string;
	shipmentId: string;
}) {
	const query = useOrderTracking(orderId);
	const row = query.data?.shipments.find((s) => s.shipmentId === shipmentId);
	if (!row) return null;
	return (
		<span
			className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground"
			title={row.lastEventText ?? undefined}
		>
			{row.error ? (
				<Tag tone="danger" title={row.error}>
					track err
				</Tag>
			) : (
				row.lastEventText && (
					<span className="max-w-48 truncate">{row.lastEventText}</span>
				)
			)}
			checked {formatRelative(row.lastCheckedAt)}
		</span>
	);
}
