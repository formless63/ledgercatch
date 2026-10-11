/** Reporting currency (per user / per entity) and per-entity tax profiles. */
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { entities } from "#/features/ledger/schema";
import {
	entitySettings,
	moneySettings,
	type TaxBusinessType,
	type TaxJurisdiction,
} from "./schema";

export const DEFAULT_REPORTING_CURRENCY = "USD";

export async function getUserReportingCurrency(ownerId: string) {
	const [row] = await db
		.select({ currency: moneySettings.reportingCurrency })
		.from(moneySettings)
		.where(eq(moneySettings.ownerId, ownerId));
	return row?.currency ?? DEFAULT_REPORTING_CURRENCY;
}

/** Entity setting → user setting → USD. */
export async function getReportingCurrency(
	ownerId: string,
	entityId?: string | null,
) {
	if (entityId) {
		const [row] = await db
			.select({ currency: entitySettings.reportingCurrency })
			.from(entitySettings)
			.where(
				and(
					eq(entitySettings.entityId, entityId),
					eq(entitySettings.ownerId, ownerId),
				),
			);
		if (row?.currency) return row.currency;
	}
	return getUserReportingCurrency(ownerId);
}

export async function getMoneySettingsForOwner(ownerId: string) {
	const [reportingCurrency, rows] = await Promise.all([
		getUserReportingCurrency(ownerId),
		db
			.select({
				entityId: entities.id,
				name: entities.name,
				kind: entities.kind,
				color: entities.color,
				archivedAt: entities.archivedAt,
				reportingCurrency: entitySettings.reportingCurrency,
				taxJurisdiction: entitySettings.taxJurisdiction,
				taxBusinessType: entitySettings.taxBusinessType,
			})
			.from(entities)
			.leftJoin(entitySettings, eq(entitySettings.entityId, entities.id))
			.where(eq(entities.ownerId, ownerId))
			.orderBy(entities.sort),
	]);
	return {
		reportingCurrency,
		entities: rows.map((row) => ({
			...row,
			archivedAt: row.archivedAt?.toISOString() ?? null,
		})),
	};
}

export async function saveUserReportingCurrencyForOwner(
	ownerId: string,
	currency: string,
) {
	await db
		.insert(moneySettings)
		.values({ ownerId, reportingCurrency: currency.toUpperCase() })
		.onConflictDoUpdate({
			target: moneySettings.ownerId,
			set: { reportingCurrency: currency.toUpperCase(), updatedAt: new Date() },
		});
	return { ok: true };
}

export async function saveEntitySettingsForOwner(
	ownerId: string,
	input: {
		entityId: string;
		reportingCurrency: string | null;
		taxJurisdiction: TaxJurisdiction | null;
		taxBusinessType: TaxBusinessType | null;
	},
) {
	const [entity] = await db
		.select({ id: entities.id })
		.from(entities)
		.where(and(eq(entities.id, input.entityId), eq(entities.ownerId, ownerId)));
	if (!entity) throw new Error("Unknown entity");
	const values = {
		reportingCurrency: input.reportingCurrency?.toUpperCase() || null,
		taxJurisdiction: input.taxJurisdiction,
		taxBusinessType: input.taxBusinessType,
	};
	await db
		.insert(entitySettings)
		.values({ entityId: input.entityId, ownerId, ...values })
		.onConflictDoUpdate({
			target: entitySettings.entityId,
			set: { ...values, updatedAt: new Date() },
		});
	return { ok: true };
}

export async function getTaxProfiles(ownerId: string) {
	const rows = await db
		.select({
			entityId: entities.id,
			kind: entities.kind,
			name: entities.name,
			jurisdiction: entitySettings.taxJurisdiction,
			businessType: entitySettings.taxBusinessType,
			reportingCurrency: entitySettings.reportingCurrency,
		})
		.from(entities)
		.leftJoin(entitySettings, eq(entitySettings.entityId, entities.id))
		.where(eq(entities.ownerId, ownerId));
	return new Map(rows.map((row) => [row.entityId, row]));
}
