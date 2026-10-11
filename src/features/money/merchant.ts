/**
 * Merchant normalization for statement descriptors (pure, client-safe).
 *
 * "AMZN Mktp US*2K4AB12C3"   → amazon
 * "PAYPAL *EBAY O*12-34567"   → ebay
 * "SQ *BLUE BOTTLE COFFEE 12" → blue bottle coffee
 */

export type MerchantInfo = {
	/** Stable comparison key (lowercase words, or a known store id). */
	key: string;
	/** Display label ("Amazon", "Blue Bottle Coffee"). */
	label: string;
	/** True when the key is a known store (strong match signal). */
	known: boolean;
};

const KNOWN: Array<{ key: string; label: string; re: RegExp }> = [
	{
		key: "amazon",
		label: "Amazon",
		re: /\b(amzn|amazon|amz\s?mktp|amazon\s?mktpl?|amazon\s?mktplace|prime\s?video|audible|kindle\s+svcs|whole\s?foods)\b|amazon\.(com|ca|co\.uk|de|fr|it|es|co\.jp)/i,
	},
	{
		key: "aliexpress",
		label: "AliExpress",
		re: /ali\s?express|aliexp|alipay\s*\*?\s*ali/i,
	},
	{ key: "alibaba", label: "Alibaba", re: /alibaba/i },
	{ key: "ebay", label: "eBay", re: /\bebay\b|\bebay\s?o\*|ebay\s?inc/i },
	{ key: "digikey", label: "DigiKey", re: /digi[\s-]?key/i },
	{ key: "mouser", label: "Mouser", re: /mouser/i },
	{ key: "lcsc", label: "LCSC", re: /\blcsc\b/i },
	{ key: "jlcpcb", label: "JLCPCB", re: /jlc\s?pcb|\bjlc\b/i },
	{ key: "adafruit", label: "Adafruit", re: /adafruit/i },
	{ key: "sparkfun", label: "SparkFun", re: /sparkfun/i },
	{ key: "mcmaster", label: "McMaster-Carr", re: /mcmaster/i },
	{ key: "temu", label: "Temu", re: /\btemu\b/i },
	{ key: "walmart", label: "Walmart", re: /wal[\s-]?mart|wm\s?supercenter/i },
	{ key: "target", label: "Target", re: /\btarget\b/i },
	{ key: "bestbuy", label: "Best Buy", re: /best\s?buy/i },
	{ key: "homedepot", label: "Home Depot", re: /home\s?depot/i },
	{ key: "apple", label: "Apple", re: /apple\.com|\bapple\s?store\b/i },
	{ key: "costco", label: "Costco", re: /costco/i },
	{ key: "newegg", label: "Newegg", re: /newegg/i },
];

/** Payment-processor / POS prefixes that precede the real merchant. */
const PREFIXES = [
	/^(?:paypal|pp)\s*\*\s*/i,
	/^(?:sq|sqr|square)\s*\*\s*/i,
	/^(?:tst|toast)\s*\*\s*/i,
	/^(?:sp|shp|shopify)\s*\*?\s+/i,
	/^(?:py|pay)\s*\*\s*/i,
	/^(?:stripe|stp)\s*\*\s*/i,
	/^(?:google|ggl)\s*\*\s*/i,
	/^(?:in|ic|ck|dd|bt|fs|zsk|lsp|cke)\s*\*\s*/i,
	/^(?:pos|debit card|check ?card|purchase|recurring)\s+(?:purchase\s+|debit\s+)?/i,
	/^purchase authorized on \d{1,2}\/\d{1,2}\s+/i,
	/^card purchase(?: with pin)?\s+\d{1,2}\/\d{1,2}\s+/i,
];

const NOISE_WORDS = new Set([
	"inc",
	"llc",
	"ltd",
	"co",
	"corp",
	"com",
	"www",
	"the",
	"us",
	"usa",
	"store",
	"online",
	"mktp",
	"mktplace",
	"marketplace",
	"payment",
	"purchase",
	"pos",
	"debit",
	"credit",
	"card",
	"intl",
	"international",
]);

const US_STATES =
	/\s+(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\s+\d{5})?\s*$/;

function titleCase(text: string) {
	return text
		.split(" ")
		.filter(Boolean)
		.map((word) =>
			word.length <= 3 && /^[a-z]+$/.test(word) && word !== "the"
				? word.toUpperCase()
				: `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`,
		)
		.join(" ");
}

/** Strips processor prefixes, reference codes, locations and numbers. */
export function cleanDescriptor(description: string): string {
	let text = description.replace(/\s+/g, " ").trim();
	for (let pass = 0; pass < 2; pass++)
		for (const prefix of PREFIXES) text = text.replace(prefix, "");
	text = text
		// "*2K4AB12C3", "#1234", "O*12-34567-89012"
		.replace(/\*\s*[A-Z0-9][A-Z0-9-]{3,}/gi, " ")
		.replace(/#\s*\d+/g, " ")
		// URLs / phone numbers
		.replace(/\b(?:https?:\/\/)?(?:www\.)/gi, "")
		.replace(/\+?\d[\d\s().-]{8,}\d/g, " ")
		.replace(/\.(?:com|net|org|co|io)(?:\.[a-z]{2})?\b/gi, " ")
		// trailing "SEATTLE WA", "LUXEMBOURG LU"
		.replace(US_STATES, "")
		.replace(/\s+[A-Z]{2}\s*$/, "")
		.replace(/\b\d{2}\/\d{2}(?:\/\d{2,4})?\b/g, " ")
		.replace(/\b[A-Z0-9]*\d[A-Z0-9]*\b/gi, (token) =>
			/^\d{1,2}$/.test(token) ? token : " ",
		)
		.replace(/[*_|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return text;
}

/** Comparable key from free text: lowercase significant words. */
export function merchantWords(text: string): string[] {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.split(" ")
		.filter((word) => word.length > 1 && !NOISE_WORDS.has(word))
		.filter((word) => !/^\d+$/.test(word));
}

export function normalizeMerchant(
	description: string | null | undefined,
): MerchantInfo {
	const text = (description ?? "").trim();
	if (!text) return { key: "", label: "", known: false };
	for (const known of KNOWN)
		if (known.re.test(text))
			return { key: known.key, label: known.label, known: true };
	const cleaned = cleanDescriptor(text);
	// PayPal with nothing after the prefix.
	if (!cleaned && /paypal/i.test(text))
		return { key: "paypal", label: "PayPal", known: false };
	const words = merchantWords(cleaned || text).slice(0, 3);
	if (!words.length) return { key: "", label: cleaned || text, known: false };
	return {
		key: words.join(" "),
		label: titleCase(words.join(" ")),
		known: false,
	};
}

/** Merchant key for an order: known store id, else its merchant name. */
export function orderMerchantKey(
	source: string,
	merchantName: string | null | undefined,
): string {
	if (source && source !== "generic") {
		const known = KNOWN.find((entry) => entry.key === source);
		if (known) return known.key;
	}
	const fromName = normalizeMerchant(merchantName);
	if (fromName.key) return fromName.key;
	return source === "generic" ? "" : source;
}

function bigrams(text: string) {
	const compact = text.replace(/\s+/g, "");
	const grams = new Map<string, number>();
	for (let i = 0; i < compact.length - 1; i++) {
		const gram = compact.slice(i, i + 2);
		grams.set(gram, (grams.get(gram) ?? 0) + 1);
	}
	return grams;
}

/** 0..1 similarity of two merchant keys. */
export function merchantSimilarity(a: string, b: string): number {
	if (!a || !b) return 0;
	if (a === b) return 1;
	const compactA = a.replace(/\s+/g, "");
	const compactB = b.replace(/\s+/g, "");
	if (compactA === compactB) return 1;
	if (compactA.length >= 4 && compactB.length >= 4) {
		if (compactA.startsWith(compactB) || compactB.startsWith(compactA))
			return 0.85;
		if (compactA.includes(compactB) || compactB.includes(compactA)) return 0.75;
	}
	const wordsA = new Set(a.split(" "));
	const wordsB = new Set(b.split(" "));
	const shared = [...wordsA].filter((word) => wordsB.has(word)).length;
	const jaccard = shared / new Set([...wordsA, ...wordsB]).size;
	const gramsA = bigrams(a);
	const gramsB = bigrams(b);
	let overlap = 0;
	let total = 0;
	for (const [gram, countA] of gramsA) {
		overlap += Math.min(countA, gramsB.get(gram) ?? 0);
		total += countA;
	}
	for (const count of gramsB.values()) total += count;
	const dice = total ? (2 * overlap) / total : 0;
	return Math.max(jaccard, dice * 0.9);
}
