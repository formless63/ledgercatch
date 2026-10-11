import type { OrderStatus } from "./types";

/**
 * Maps store status text (any of the supported stores, en/de/fr/es) to the
 * normalized OrderStatus. Order of checks matters: the most specific and the
 * "terminal" states are tested first.
 */
const RULES: Array<[RegExp, OrderStatus]> = [
	// Alibaba/AliExpress trade state codes ("WAIT_SELLER_SEND_GOODS").
	[
		/wait[\s_]+buyer[\s_]+pay|place[\s_]+order[\s_]+success|risk[\s_]+control/i,
		"placed",
	],
	[
		/wait[\s_]+seller[\s_]+(send|ship)|seller[\s_]+part[\s_]+send|in[\s_]+production|wait[\s_]+send/i,
		"processing",
	],
	[
		/wait[\s_]+buyer[\s_]+(accept|confirm|receive)|seller[\s_]+send[\s_]+goods|goods[\s_]+shipped/i,
		"shipped",
	],
	[/trade[\s_]+(finished|success)|finish(ed)?[\s_]+trade/i, "delivered"],
	[/trade[\s_]+closed|order[\s_]+closed/i, "cancelled"],
	// Phrases that contain misleading keywords.
	[/^\s*order (received|confirmed)\b|bestellung eingegangen/i, "placed"],
	[/payment (received|confirmed|complete)/i, "processing"],
	[
		/not\s+(yet\s+)?shipped|noch nicht versandt|awaiting (shipment|dispatch)|to ship\b|ready to ship|preparing (for )?ship/i,
		"processing",
	],
	[
		/\bcancel+(ed|led|lation)?\b|storniert|annul|cancelad|order closed|^closed$|\bvoid(ed)?\b/i,
		"cancelled",
	],
	[
		/\brefund(ed)?\b|\breturn(ed)?\b(?! window| eligib| or replace| items?\b| policy)|return (started|complete|received)|erstattet|zurückgesendet|rücksendung|retourn|devuelto|reembols/i,
		"returned",
	],
	[
		/\bdeliver(ed|y complete)|zugestellt|geliefert|livré|entregado|\bcompleted?\b|\bfinished\b|order complete|picked up|signed|\breceived\b(?! by seller)|abgeschlossen|abgeholt/i,
		"delivered",
	],
	[
		/\bshipped\b|\bin transit\b|on (the|its) way|out for delivery|\bdispatched\b|versandt|verschickt|unterwegs|expédié|enviado|en camino|awaiting delivery|shipment (sent|on)|partially shipped|label created|handed (over )?to carrier/i,
		"shipped",
	],
	[
		/\bprocessing\b|\bpreparing\b|being prepared|in bearbeitung|in progress|en preparación|\bpaid\b|payment (received|confirmed|complete)|\bconfirmed\b|\bpacked\b|\bpacking\b|backorder|arriving|\bpending shipment/i,
		"processing",
	],
	[
		/\bplaced\b|\bordered\b|order received|awaiting payment|\bunpaid\b|to pay\b|\bpending\b|\bnew\b|\bopen\b|bestellt|eingegangen|submitted|on hold/i,
		"placed",
	],
];

export function normalizeStatus(
	text: string | null | undefined,
): OrderStatus | undefined {
	if (!text) return undefined;
	const value = text.replace(/\s+/g, " ").trim();
	if (!value) return undefined;
	for (const [re, status] of RULES) if (re.test(value)) return status;
	return "unknown";
}
