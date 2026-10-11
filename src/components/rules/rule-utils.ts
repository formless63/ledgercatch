/** Client-side rule draft model, field metadata and templates. */
import type { RuleInput } from "#/features/ledger/inputs";
import type { listRules } from "#/features/ledger/ledger.functions";

export type RuleRow = Awaited<ReturnType<typeof listRules>>[number];
export type ConditionField = RuleInput["conditions"][number]["field"];
export type ConditionOp = RuleInput["conditions"][number]["op"];

export const FIELDS: Array<{
	value: ConditionField;
	label: string;
	kind: "text" | "number" | "store" | "last4" | "currency";
	placeholder?: string;
}> = [
	{ value: "source", label: "Store", kind: "store" },
	{
		value: "merchant",
		label: "Merchant",
		kind: "text",
		placeholder: "e.g. Adafruit",
	},
	{
		value: "item_title",
		label: "Item title",
		kind: "text",
		placeholder: "e.g. resistor",
	},
	{
		value: "sku",
		label: "SKU",
		kind: "text",
		placeholder: "e.g. 296-1395-5-ND",
	},
	{
		value: "payment_last4",
		label: "Card last-4",
		kind: "last4",
		placeholder: "4821",
	},
	{
		value: "placed_by_group",
		label: "Placed by group",
		kind: "text",
		placeholder: "Example LLC",
	},
	{
		value: "ship_to_address",
		label: "Ship-to address",
		kind: "text",
		placeholder: "1 Example St",
	},
	{
		value: "checkout_email_domain",
		label: "Checkout email domain",
		kind: "text",
		placeholder: "example.com",
	},
	{ value: "total", label: "Total", kind: "number", placeholder: "500.00" },
	{
		value: "currency",
		label: "Currency",
		kind: "currency",
		placeholder: "USD",
	},
];

export const OPS: Array<{ value: ConditionOp; label: string }> = [
	{ value: "equals", label: "equals" },
	{ value: "contains", label: "contains" },
	{ value: "matches", label: "matches regex" },
	{ value: "gt", label: ">" },
	{ value: "lt", label: "<" },
];

export function opsFor(field: ConditionField): ConditionOp[] {
	if (field === "total") return ["gt", "lt", "equals"];
	if (field === "source" || field === "currency") return ["equals"];
	if (field === "payment_last4") return ["equals", "matches"];
	return ["contains", "equals", "matches"];
}

export type ConditionDraft = {
	key: string;
	field: ConditionField;
	op: ConditionOp;
	value: string;
};

export type RuleDraft = {
	id?: string;
	name: string;
	enabled: boolean;
	priority: number;
	match: "all" | "any";
	conditions: ConditionDraft[];
	entityId: string;
	categoryId: string;
	reimbursable: "" | "auto" | "yes" | "no";
	file: "" | "yes" | "no";
	tags: string;
};

let keySeq = 0;
export const newKey = () => `c${++keySeq}`;

export function condition(
	field: ConditionField,
	value = "",
	op?: ConditionOp,
): ConditionDraft {
	return {
		key: newKey(),
		field,
		op: op ?? opsFor(field)[0] ?? "equals",
		value,
	};
}

export function emptyDraft(priority: number): RuleDraft {
	return {
		name: "",
		enabled: true,
		priority,
		match: "all",
		conditions: [condition("merchant")],
		entityId: "",
		categoryId: "",
		reimbursable: "",
		file: "",
		tags: "",
	};
}

export function draftFromRule(rule: RuleRow): RuleDraft {
	const a = rule.actions;
	return {
		id: rule.id,
		name: rule.name,
		enabled: rule.enabled,
		priority: rule.priority,
		match: rule.match,
		conditions: rule.conditions.map((c) => ({ key: newKey(), ...c })),
		entityId: a.entityId ?? "",
		categoryId: a.categoryId ?? "",
		reimbursable: a.reimbursable ?? "",
		file: a.file === undefined ? "" : a.file ? "yes" : "no",
		tags: (a.tags ?? []).join(", "),
	};
}

export function parseTags(tags: string) {
	return [
		...new Set(
			tags
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean)
				.map((t) => t.slice(0, 40)),
		),
	].slice(0, 10);
}

export function draftToInput(draft: RuleDraft): RuleInput {
	const tags = parseTags(draft.tags);
	return {
		id: draft.id,
		name: draft.name.trim() || "Draft rule",
		enabled: draft.enabled,
		priority: draft.priority,
		match: draft.match,
		conditions: draft.conditions
			.filter((c) => c.value.trim())
			.map(({ field, op, value }) => ({ field, op, value: value.trim() })),
		actions: {
			...(draft.entityId ? { entityId: draft.entityId } : {}),
			...(draft.categoryId ? { categoryId: draft.categoryId } : {}),
			...(draft.reimbursable ? { reimbursable: draft.reimbursable } : {}),
			...(draft.file ? { file: draft.file === "yes" } : {}),
			...(tags.length ? { tags } : {}),
		},
	};
}

/** Per-condition problems (keyed by condition key). */
export function conditionErrors(draft: RuleDraft) {
	const errors: Record<string, string> = {};
	for (const c of draft.conditions) {
		const value = c.value.trim();
		if (!value) {
			errors[c.key] = "Value required";
			continue;
		}
		if (c.op === "matches") {
			try {
				new RegExp(value, "i");
			} catch {
				errors[c.key] = "Invalid regex";
			}
		}
		if (c.field === "total" && !Number.isFinite(Number.parseFloat(value)))
			errors[c.key] = "Enter an amount like 500 or 12.50";
	}
	return errors;
}

export function hasActions(draft: RuleDraft) {
	const input = draftToInput(draft);
	return Object.keys(input.actions).length > 0;
}

export function describeConditions(
	rule: Pick<RuleRow, "conditions" | "match">,
	storeLabel: (s: string) => string,
) {
	const parts = rule.conditions.map((c) => {
		const field = FIELDS.find((f) => f.value === c.field)?.label ?? c.field;
		const op = OPS.find((o) => o.value === c.op)?.label ?? c.op;
		const value = c.field === "source" ? storeLabel(c.value) : c.value;
		return `${field} ${op} ${c.field === "total" ? value : `“${value}”`}`;
	});
	return parts.join(rule.match === "all" ? " AND " : " OR ");
}

export type RuleTemplate = {
	id: string;
	label: string;
	description: string;
	build: (priority: number) => RuleDraft;
};

export const TEMPLATES: RuleTemplate[] = [
	{
		id: "card",
		label: "Card last-4 → entity",
		description: "Everything paid with a specific card belongs to one entity.",
		build: (priority) => ({
			...emptyDraft(priority),
			name: "Card ••____ → entity",
			conditions: [condition("payment_last4")],
		}),
	},
	{
		id: "store",
		label: "Store → entity",
		description: "e.g. all DigiKey orders are for the business.",
		build: (priority) => ({
			...emptyDraft(priority),
			name: "DigiKey → business",
			conditions: [condition("source", "digikey")],
			file: "yes",
		}),
	},
	{
		id: "large",
		label: "Over $X → keep in inbox",
		description: "Big purchases are never auto-filed; tagged for review.",
		build: (priority) => ({
			...emptyDraft(priority),
			name: "Over $500 → review",
			conditions: [condition("total", "500", "gt")],
			file: "no",
			tags: "review",
		}),
	},
	{
		id: "keyword",
		label: "Keyword → category",
		description: "Item titles containing a word get a category.",
		build: (priority) => ({
			...emptyDraft(priority),
			name: "Components",
			match: "any",
			conditions: [
				condition("item_title", "resistor"),
				condition("item_title", "capacitor"),
			],
		}),
	},
];
