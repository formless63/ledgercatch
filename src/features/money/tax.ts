/**
 * Tax categorization *hints* (pure, client-safe). Advisory only: nothing here
 * assigns a treatment. Suggestions are shown with reasons and a disclaimer
 * and must be accepted by the user (stored in `allocation_tax`).
 */
import type {
	TaxBusinessType,
	TaxJurisdiction,
	TaxTreatment,
} from "./constants";

export const TAX_DISCLAIMER =
	"Advisory hints only, not tax advice. Treatment depends on your jurisdiction, entity and facts; confirm with your accountant. Nothing is applied until you accept it.";

/** IRS de minimis safe harbor without an applicable financial statement (per item/invoice). */
export const DE_MINIMIS_USD_MINOR = 250_000;

export const TAX_TREATMENT_LABELS: Record<TaxTreatment, string> = {
	supplies: "Supplies",
	office: "Office expense",
	software: "Software & subscriptions",
	advertising: "Advertising",
	travel: "Travel",
	meals: "Meals",
	shipping: "Postage & shipping",
	cogs: "Cost of goods sold (inventory / parts for resale)",
	de_minimis: "De minimis safe harbor (expensed equipment)",
	section_179: "Section 179 candidate",
	depreciable_asset: "Depreciable asset",
	non_deductible: "Not deductible (personal)",
	other_expense: "Other business expense",
	needs_review: "Needs accountant review",
};

export const EXPENSE_TREATMENTS: TaxTreatment[] = [
	"supplies",
	"office",
	"software",
	"advertising",
	"travel",
	"meals",
	"shipping",
	"other_expense",
	"de_minimis",
];

const SCHEDULE_C: Partial<Record<TaxTreatment, string>> = {
	advertising: "Schedule C line 8",
	office: "Schedule C line 18",
	supplies: "Schedule C line 22",
	travel: "Schedule C line 24a",
	meals: "Schedule C line 24b (generally 50% limit)",
	software: "Schedule C line 27a (other expenses)",
	shipping: "Schedule C line 27a (other expenses)",
	other_expense: "Schedule C line 27a (other expenses)",
	cogs: "Schedule C Part III (line 36 purchases)",
	de_minimis:
		"expensed under the de minimis safe harbor election (≤ $2,500 per item/invoice); usually Schedule C line 22",
	section_179: "Form 4562 Part I → Schedule C line 13",
	depreciable_asset: "Form 4562 → Schedule C line 13",
};

const CORPORATE_FORM: Partial<Record<TaxBusinessType, string>> = {
	partnership: "Form 1065",
	s_corp: "Form 1120-S",
	c_corp: "Form 1120",
};

export type TaxProfile = {
	jurisdiction: TaxJurisdiction | null;
	businessType: TaxBusinessType | null;
};

/** Where a treatment usually lands for this profile ("Schedule C line 22"). */
export function treatmentHint(
	treatment: TaxTreatment,
	profile: TaxProfile,
	entityKind: "personal" | "business",
): string | null {
	if (treatment === "non_deductible")
		return "personal spending is generally not deductible";
	if (treatment === "needs_review") return null;
	if (profile.jurisdiction !== "US") return null;
	const type =
		profile.businessType ??
		(entityKind === "business" ? "sole_prop" : "personal");
	if (type === "sole_prop" || type === "single_member_llc")
		return SCHEDULE_C[treatment] ?? null;
	const form = CORPORATE_FORM[type];
	if (!form) return null;
	if (treatment === "cogs") return `${form} cost of goods sold (Form 1125-A)`;
	if (treatment === "section_179" || treatment === "depreciable_asset")
		return `${form} depreciation (Form 4562)`;
	return `${form} deductions`;
}

export function treatmentDisplay(
	treatment: TaxTreatment,
	profile: TaxProfile,
	entityKind: "personal" | "business",
) {
	const hint = treatmentHint(treatment, profile, entityKind);
	const label = TAX_TREATMENT_LABELS[treatment];
	return hint ? `${label} — ${hint}` : label;
}

/* ───────────────────────── keyword rules ───────────────────────── */

const CATEGORY_RULES: Array<{ re: RegExp; treatment: TaxTreatment }> = [
	{
		re: /\b(cogs|cost of goods|inventory|resale|materials? for resale|parts? for resale|components? for (products?|resale)|merch(andise)?)\b/i,
		treatment: "cogs",
	},
	{
		re: /\b(software|saas|subscriptions?|licen[cs]es?|hosting|cloud|domains?)\b/i,
		treatment: "software",
	},
	{ re: /\b(advertis\w*|marketing|ads)\b/i, treatment: "advertising" },
	{ re: /\b(travel|airfare|lodging|hotel)\b/i, treatment: "travel" },
	{
		re: /\b(meals?|food|dining|restaurant|entertainment)\b/i,
		treatment: "meals",
	},
	{ re: /\b(postage|shipping|freight|courier)\b/i, treatment: "shipping" },
	{ re: /\b(office)\b/i, treatment: "office" },
	{
		re: /\b(equipment|hardware|computers?|tools?|machinery|furniture|capital|assets?|fixed)\b/i,
		treatment: "depreciable_asset",
	},
	{
		re: /\b(supplies|consumables?|components?|parts|materials?|electronics?)\b/i,
		treatment: "supplies",
	},
	{
		re: /\b(personal|household|groceries|gifts?|private)\b/i,
		treatment: "non_deductible",
	},
];

const EQUIPMENT_RE =
	/\b(laptop|notebook|macbook|computer|desktop|workstation|server|nas|monitor|display|printer|3d printer|plotter|scanner|oscilloscope|multimeter|spectrum analy[sz]er|signal generator|power supply|bench supply|soldering station|rework station|hot air station|microscope|camera|lens|drone|router|switch|firewall|ipad|tablet|iphone|smartphone|phone|desk|chair|cabinet|shelving|drill|saw|lathe|mill|cnc|laser cutter|engraver|compressor|generator|vehicle|forklift|tool ?kit|toolset)\b/i;
const SUPPLIES_RE =
	/\b(resistors?|capacitors?|inductors?|diodes?|transistors?|mosfets?|connectors?|headers?|cables?|wires?|solder|flux|filament|resin|pcbs?|ics?|chips?|leds?|batter(y|ies)|fuses?|screws?|nuts|bolts|washers|standoffs?|heat ?shrink|tape|glue|adhesive|paper|ink|toner|labels?|envelopes?|sensors?|modules?|breakouts?|jumpers?|crimps?|terminals?|enclosures?)\b/i;
const SOFTWARE_RE =
	/\b(software|licen[cs]e|subscription|saas|annual plan|monthly plan|cloud|hosting|domain|app store|plugin|seat)\b/i;
const OFFICE_RE =
	/\b(stapler|binder|folders?|notebook paper|pens?|pencils?|printer paper|postage stamps?)\b/i;

export type TaxSuggestionInput = {
	entityKind: "personal" | "business";
	profile: TaxProfile;
	category: { name: string; code: string | null } | null;
	items: Array<{ title: string; quantity: number; totalMinor: number | null }>;
	/** Allocation amount in its own currency. */
	amountMinor: number;
	currency: string;
	/**
	 * USD per 1 unit of `currency` in minor-unit terms (amount × factor = USD
	 * minor). null when unknown (non-USD without a rate).
	 */
	usdFactor: number | null;
};

export type TaxSuggestion = {
	treatment: TaxTreatment;
	label: string;
	hint: string | null;
	/** 0..1, shown to the user; never used to auto-apply. */
	confidence: number;
	reasons: string[];
};

export type TaxSuggestionResult = {
	suggestions: TaxSuggestion[];
	disclaimer: string;
	/** Items whose unit price is ≥ $2,500 (capitalization review). */
	largeItems: Array<{ title: string; unitUsdMinor: number }>;
};

export function suggestTaxTreatments(
	input: TaxSuggestionInput,
): TaxSuggestionResult {
	const scores = new Map<
		TaxTreatment,
		{ confidence: number; reasons: string[] }
	>();
	const add = (treatment: TaxTreatment, confidence: number, reason: string) => {
		const current = scores.get(treatment);
		if (current) {
			current.confidence = Math.min(
				0.95,
				Math.max(current.confidence, confidence) + 0.1,
			);
			current.reasons.push(reason);
		} else scores.set(treatment, { confidence, reasons: [reason] });
	};

	const largeItems: TaxSuggestionResult["largeItems"] = [];
	if (
		input.entityKind === "personal" ||
		input.profile.businessType === "personal"
	) {
		add("non_deductible", 0.85, "allocated to a personal entity");
	} else {
		const categoryText = input.category
			? `${input.category.name} ${input.category.code ?? ""}`
			: "";
		for (const rule of CATEGORY_RULES)
			if (categoryText && rule.re.test(categoryText)) {
				add(rule.treatment, 0.6, `category "${input.category?.name}"`);
				break;
			}

		const titles = input.items.map((item) => item.title).join(" · ");
		let equipment = false;
		for (const item of input.items) {
			const unitMinor =
				item.totalMinor != null && item.quantity > 0
					? Math.round(item.totalMinor / item.quantity)
					: null;
			const unitUsd =
				unitMinor != null && input.usdFactor != null
					? Math.round(unitMinor * input.usdFactor)
					: null;
			if (EQUIPMENT_RE.test(item.title)) {
				equipment = true;
				if (unitUsd != null && unitUsd > DE_MINIMIS_USD_MINOR) {
					largeItems.push({ title: item.title, unitUsdMinor: unitUsd });
					add(
						"section_179",
						0.55,
						`"${truncate(item.title)}" looks like equipment over the $2,500 de minimis threshold`,
					);
					add(
						"depreciable_asset",
						0.45,
						"equipment over $2,500 can also be depreciated",
					);
				} else if (unitUsd != null) {
					add(
						"de_minimis",
						0.5,
						`"${truncate(item.title)}" looks like equipment at or under $2,500 per item`,
					);
				} else {
					add(
						"needs_review",
						0.4,
						"equipment-like item with unknown USD value",
					);
				}
			} else if (unitUsd != null && unitUsd > DE_MINIMIS_USD_MINOR) {
				largeItems.push({ title: item.title, unitUsdMinor: unitUsd });
			}
		}
		if (!equipment && SUPPLIES_RE.test(titles))
			add("supplies", 0.45, "item titles look like consumables/components");
		if (SOFTWARE_RE.test(titles))
			add("software", 0.45, "item titles mention software/subscriptions");
		if (OFFICE_RE.test(titles))
			add("office", 0.4, "item titles look like office supplies");

		// Category says supplies/inventory but an item is large: flag it.
		if (
			largeItems.length &&
			[...scores.keys()].some(
				(t) => EXPENSE_TREATMENTS.includes(t) && t !== "de_minimis",
			)
		)
			add(
				"needs_review",
				0.5,
				"an item ≥ $2,500 is classified as an expense; consider capitalizing",
			);
		// A category of "equipment" alone: de minimis vs. asset depends on the amount.
		const asset = scores.get("depreciable_asset");
		if (asset && !largeItems.length && input.usdFactor != null) {
			const totalUsd = Math.round(input.amountMinor * input.usdFactor);
			if (totalUsd <= DE_MINIMIS_USD_MINOR)
				add("de_minimis", 0.55, "equipment category, total at or under $2,500");
		}
		if (!scores.size)
			add(
				"other_expense",
				0.25,
				"no specific signal; generic business expense",
			);
	}

	const suggestions = [...scores.entries()]
		.map(([treatment, value]) => ({
			treatment,
			label: TAX_TREATMENT_LABELS[treatment],
			hint: treatmentHint(treatment, input.profile, input.entityKind),
			confidence: Math.round(value.confidence * 100) / 100,
			reasons: value.reasons,
		}))
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, 4);
	return { suggestions, disclaimer: TAX_DISCLAIMER, largeItems };
}

function truncate(text: string, max = 40) {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
