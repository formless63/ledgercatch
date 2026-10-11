/**
 * Carrier detection and public tracking links (#21). Client-safe.
 */

export type CarrierId =
	| "usps"
	| "ups"
	| "fedex"
	| "dhl"
	| "cainiao"
	| "yunexpress"
	| "unknown";

export const CARRIER_LABELS: Record<CarrierId, string> = {
	usps: "USPS",
	ups: "UPS",
	fedex: "FedEx",
	dhl: "DHL",
	cainiao: "Cainiao",
	yunexpress: "YunExpress",
	unknown: "Carrier",
};

const NAME_PATTERNS: Array<[CarrierId, RegExp]> = [
	["usps", /\busps\b|postal service/i],
	["ups", /\bups\b|united parcel/i],
	["fedex", /fed\s?ex/i],
	["dhl", /\bdhl\b/i],
	["cainiao", /cainiao|aliexpress standard|ali\s?express shipping/i],
	["yunexpress", /yun\s?express|\byun\b/i],
];

/** Guess the carrier from its free-text name, then from number shape. */
export function detectCarrier(
	carrier: string | null | undefined,
	trackingNumber: string,
): CarrierId {
	for (const [id, pattern] of NAME_PATTERNS)
		if (carrier && pattern.test(carrier)) return id;
	const n = trackingNumber.replace(/\s+/g, "").toUpperCase();
	if (/^1Z[0-9A-Z]{16}$/.test(n)) return "ups";
	if (/^YT\d{16}$/.test(n)) return "yunexpress";
	if (/^(LP|CN|AE)\d{10,}/.test(n) || /^CAINIAO/.test(n)) return "cainiao";
	if (/^(94|93|92|95)\d{20}$/.test(n) || /^[A-Z]{2}\d{9}US$/.test(n))
		return "usps";
	if (/^(\d{12}|\d{15}|\d{20})$/.test(n)) return "fedex";
	if (/^\d{10}$/.test(n) || /^JJD\d+$/.test(n) || /^JVGL\d+$/.test(n))
		return "dhl";
	return "unknown";
}

/** Public tracking page; unknown carriers fall back to 17TRACK. */
export function trackingLink(
	carrier: string | null | undefined,
	trackingNumber: string,
): { carrier: CarrierId; label: string; url: string } {
	const id = detectCarrier(carrier, trackingNumber);
	const n = encodeURIComponent(trackingNumber.trim());
	const urls: Record<CarrierId, string> = {
		usps: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
		ups: `https://www.ups.com/track?tracknum=${n}`,
		fedex: `https://www.fedex.com/fedextrack/?trknbr=${n}`,
		dhl: `https://www.dhl.com/global-en/home/tracking/tracking-express.html?tracking-id=${n}`,
		cainiao: `https://global.cainiao.com/newDetail.htm?mailNoList=${n}`,
		yunexpress: `https://www.yuntrack.com/parcelTracking?id=${n}`,
		unknown: `https://t.17track.net/en#nums=${n}`,
	};
	return {
		carrier: id,
		label: id === "unknown" ? (carrier ?? "Carrier") : CARRIER_LABELS[id],
		url: urls[id],
	};
}

/** 17TRACK fallback link (works for nearly any carrier). */
export function seventeenTrackLink(trackingNumber: string): string {
	return `https://t.17track.net/en#nums=${encodeURIComponent(trackingNumber.trim())}`;
}

/** Normalized shipment states written back to `shipments.status`. */
export type TrackingState =
	| "info_received"
	| "in_transit"
	| "out_for_delivery"
	| "delivered"
	| "exception"
	| "expired"
	| "unknown";

export function isTerminal(state: TrackingState): boolean {
	return state === "delivered" || state === "expired";
}

/** Map aggregator status text (17TRACK v2 main statuses and friends). */
export function normalizeTrackingState(
	raw: string | null | undefined,
): TrackingState {
	const s = (raw ?? "").toLowerCase().replace(/[\s_-]+/g, "");
	if (!s) return "unknown";
	if (s.includes("delivered") && !s.includes("undelivered")) return "delivered";
	if (s.includes("outfordelivery") || s.includes("availableforpickup"))
		return "out_for_delivery";
	if (s.includes("intransit") || s.includes("transit")) return "in_transit";
	if (s.includes("inforeceived") || s.includes("pickedup"))
		return "info_received";
	if (
		s.includes("exception") ||
		s.includes("undelivered") ||
		s.includes("deliveryfailure") ||
		s.includes("alert")
	)
		return "exception";
	if (s.includes("expired")) return "expired";
	return "unknown";
}
