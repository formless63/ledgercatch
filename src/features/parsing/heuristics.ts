import { parseDate } from "./dates";

const ORDER_ID_RES = [
	/\b(?:order|confirmation|reference|purchase)\s*(?:#|no\.?|nr\.?|number|num\.?|id)\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,40})/gi,
	/\border\s*#\s*([A-Z0-9][A-Z0-9-]{3,40})/gi,
	/\b(?:bestellnummer|bestell-nr\.?|auftragsnummer|numéro de commande|número de pedido)\s*:?\s*#?\s*([A-Z0-9][A-Z0-9-]{3,40})/gi,
];

/** Labeled order number from visible text ("Order #1001", "Order number: W123"). */
export function extractOrderIdFromText(text: string): string | undefined {
	for (const re of ORDER_ID_RES) {
		for (const m of text.matchAll(re)) {
			const candidate = (m[1] ?? "").replace(/-+$/, "");
			if (/\d/.test(candidate) && candidate.length >= 4) return candidate;
		}
	}
	return undefined;
}

const DATE_LABEL_RE =
	/\b(?:order(?:ed)?\s+(?:date|placed|on)|placed\s+on|date\s+(?:ordered|placed)|order\s+date|purchase(?:d)?\s+(?:date|on)|invoice\s+date|bestelldatum|bestellt\s+am|rechnungsdatum|date)\b\s*:?\s*/gi;

/** A date that follows an order-date label; never guesses from bare dates. */
export function dateFromText(text: string): string | undefined {
	for (const m of text.matchAll(DATE_LABEL_RE)) {
		const start = (m.index ?? 0) + m[0].length;
		const parsed = parseDate(text.slice(start, start + 40));
		if (parsed) return parsed;
	}
	return undefined;
}
