/** Client-safe enums shared by schema, inputs and UI. */
export const TAX_JURISDICTIONS = ["US", "other"] as const;
export type TaxJurisdiction = (typeof TAX_JURISDICTIONS)[number];
export const TAX_BUSINESS_TYPES = [
	"personal",
	"sole_prop",
	"single_member_llc",
	"partnership",
	"s_corp",
	"c_corp",
	"other",
] as const;
export type TaxBusinessType = (typeof TAX_BUSINESS_TYPES)[number];
export const TAX_TREATMENTS = [
	"supplies",
	"office",
	"software",
	"advertising",
	"travel",
	"meals",
	"shipping",
	"cogs",
	"de_minimis",
	"section_179",
	"depreciable_asset",
	"non_deductible",
	"other_expense",
	"needs_review",
] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];
