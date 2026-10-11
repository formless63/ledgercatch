import type { RuleActions, RuleCondition } from "./schema";

export type RuleSubject = {
	source: string;
	merchant: string | null;
	itemTitles: string[];
	skus: string[];
	paymentLast4: string | null;
	placedByGroup?: string | null;
	shipToAddress?: string | null;
	checkoutEmailDomain?: string | null;
	totalMinor: number | null;
	currency: string | null;
};

export type RuleLike = {
	id: string;
	name: string;
	enabled: boolean;
	priority: number;
	match: "all" | "any";
	conditions: RuleCondition[];
	actions: RuleActions;
};

export type RuleOutcome = {
	actions: RuleActions;
	/** Rules that contributed at least one action, in application order. */
	matchedRuleIds: string[];
};

function safeRegex(pattern: string): RegExp | null {
	try {
		return new RegExp(pattern, "i");
	} catch {
		return null;
	}
}

function textMatches(
	candidates: string[],
	op: RuleCondition["op"],
	value: string,
): boolean {
	const needle = value.trim().toLowerCase();
	if (op === "matches") {
		const regex = safeRegex(value);
		return regex ? candidates.some((text) => regex.test(text)) : false;
	}
	return candidates.some((text) => {
		const hay = text.toLowerCase();
		if (op === "equals") return hay === needle;
		if (op === "contains") return hay.includes(needle);
		return false;
	});
}

export function conditionMatches(
	condition: RuleCondition,
	subject: RuleSubject,
): boolean {
	const { field, op, value } = condition;
	if (field === "total") {
		if (subject.totalMinor == null) return false;
		const threshold = Math.round(Number.parseFloat(value) * 100);
		if (!Number.isFinite(threshold)) return false;
		if (op === "gt") return subject.totalMinor > threshold;
		if (op === "lt") return subject.totalMinor < threshold;
		if (op === "equals") return subject.totalMinor === threshold;
		return false;
	}
	const candidates = (() => {
		switch (field) {
			case "source":
				return [subject.source];
			case "merchant":
				return subject.merchant ? [subject.merchant] : [];
			case "item_title":
				return subject.itemTitles;
			case "sku":
				return subject.skus;
			case "payment_last4":
				return subject.paymentLast4 ? [subject.paymentLast4] : [];
			case "ship_to_address":
				return subject.shipToAddress ? [subject.shipToAddress] : [];
			case "checkout_email_domain":
				return subject.checkoutEmailDomain ? [subject.checkoutEmailDomain] : [];
			case "placed_by_group":
				return subject.placedByGroup ? [subject.placedByGroup] : [];
			case "currency":
				return subject.currency ? [subject.currency] : [];
		}
	})();
	return textMatches(candidates, op, value);
}

export function ruleMatches(rule: RuleLike, subject: RuleSubject): boolean {
	if (!rule.enabled || rule.conditions.length === 0) return false;
	return rule.match === "all"
		? rule.conditions.every((c) => conditionMatches(c, subject))
		: rule.conditions.some((c) => conditionMatches(c, subject));
}

/** Applies rules by ascending priority; the first rule to set a field wins. */
export function evaluateRules(
	rules: RuleLike[],
	subject: RuleSubject,
): RuleOutcome {
	const actions: RuleActions = {};
	const matchedRuleIds: string[] = [];
	const ordered = [...rules].sort((a, b) => a.priority - b.priority);
	for (const rule of ordered) {
		if (!ruleMatches(rule, subject)) continue;
		let contributed = false;
		const a = rule.actions;
		if (a.entityId && !actions.entityId) {
			actions.entityId = a.entityId;
			contributed = true;
		}
		if (a.categoryId && !actions.categoryId) {
			actions.categoryId = a.categoryId;
			contributed = true;
		}
		if (a.reimbursable && !actions.reimbursable) {
			actions.reimbursable = a.reimbursable;
			contributed = true;
		}
		if (a.file !== undefined && actions.file === undefined) {
			actions.file = a.file;
			contributed = true;
		}
		if (a.tags?.length) {
			actions.tags = [...new Set([...(actions.tags ?? []), ...a.tags])];
			contributed = true;
		}
		if (contributed) matchedRuleIds.push(rule.id);
	}
	return { actions, matchedRuleIds };
}
