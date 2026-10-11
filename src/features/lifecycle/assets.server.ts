/** Asset register (#13): serials, warranty and attachments. */
import {
	and,
	asc,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	lte,
	or,
	type SQL,
} from "drizzle-orm";
import type { z } from "zod";
import { db } from "#/db";
import { audit } from "#/features/ledger/orders.server";
import { documents, orderItems, orders } from "#/features/ledger/schema";
import { warrantyExpiry } from "./assets";
import type { assetListInput, assetSaveInput } from "./inputs";
import { likeEscape } from "./items";
import {
	assertOwnedDocuments,
	assertOwnedEntity,
	assertOwnedOrder,
	findOwnedItem,
} from "./owner.server";
import { assetDocuments, assets } from "./schema";

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (days: number) =>
	new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export async function listAssetsForOwner(
	ownerId: string,
	input: z.output<typeof assetListInput>,
) {
	const where: SQL[] = [eq(assets.ownerId, ownerId)];
	if (input.status) where.push(eq(assets.status, input.status));
	if (input.entityId) where.push(eq(assets.entityId, input.entityId));
	if (input.expiringWithinDays) {
		where.push(gte(assets.warrantyExpiresAt, today()));
		where.push(
			lte(assets.warrantyExpiresAt, plusDays(input.expiringWithinDays)),
		);
	}
	if (input.q) {
		const like = `%${likeEscape(input.q)}%`;
		const match = or(
			ilike(assets.name, like),
			ilike(assets.serial, like),
			ilike(assets.location, like),
			ilike(assets.notes, like),
		);
		if (match) where.push(match);
	}
	const rows = await db
		.select({
			asset: assets,
			source: orders.source,
			externalOrderId: orders.externalOrderId,
			merchantName: orders.merchantName,
			currency: orders.currency,
			unitPriceMinor: orderItems.unitPriceMinor,
			itemUrl: orderItems.itemUrl,
			imageUrl: orderItems.imageUrl,
		})
		.from(assets)
		.leftJoin(orders, eq(orders.id, assets.orderId))
		.leftJoin(orderItems, eq(orderItems.id, assets.orderItemId))
		.where(and(...where))
		.orderBy(
			input.expiringWithinDays
				? asc(assets.warrantyExpiresAt)
				: desc(assets.createdAt),
		)
		.limit(2000);
	const ids = rows.map((r) => r.asset.id);
	const docs = ids.length
		? await db
				.select({
					assetId: assetDocuments.assetId,
					id: documents.id,
					kind: documents.kind,
					fileName: documents.fileName,
				})
				.from(assetDocuments)
				.innerJoin(documents, eq(documents.id, assetDocuments.documentId))
				.where(inArray(assetDocuments.assetId, ids))
		: [];
	return rows.map((r) => ({
		...r.asset,
		createdAt: r.asset.createdAt.toISOString(),
		updatedAt: r.asset.updatedAt.toISOString(),
		source: r.source,
		externalOrderId: r.externalOrderId,
		merchantName: r.merchantName,
		currency: r.currency,
		unitPriceMinor: r.unitPriceMinor,
		itemUrl: r.itemUrl,
		imageUrl: r.imageUrl,
		documents: docs
			.filter((d) => d.assetId === r.asset.id)
			.map(({ assetId: _a, ...d }) => d),
	}));
}
export type AssetRow = Awaited<ReturnType<typeof listAssetsForOwner>>[number];

/** Assets registered from this order's items (for the order detail action). */
export async function listOrderAssetsForOwner(
	ownerId: string,
	orderId: string,
) {
	await assertOwnedOrder(ownerId, orderId);
	return db
		.select({
			id: assets.id,
			orderItemId: assets.orderItemId,
			name: assets.name,
			serial: assets.serial,
			status: assets.status,
			warrantyExpiresAt: assets.warrantyExpiresAt,
		})
		.from(assets)
		.where(and(eq(assets.ownerId, ownerId), eq(assets.orderId, orderId)));
}

export async function saveAssetForOwner(
	ownerId: string,
	input: z.output<typeof assetSaveInput>,
) {
	let orderId = input.orderId ?? null;
	let entityId = input.entityId ?? null;
	let purchaseDate = input.purchaseDate ?? null;
	if (input.orderItemId) {
		const item = await findOwnedItem(ownerId, input.orderItemId);
		if (!item) throw new Error("Unknown order item");
		orderId = item.orderId;
		entityId = entityId ?? item.entityId ?? item.orderEntityId;
		purchaseDate = purchaseDate ?? item.orderDate;
	} else if (orderId) await assertOwnedOrder(ownerId, orderId);
	await assertOwnedEntity(ownerId, entityId);
	if (input.documentIds) await assertOwnedDocuments(ownerId, input.documentIds);

	const values = {
		ownerId,
		orderId,
		orderItemId: input.orderItemId ?? null,
		entityId,
		name: input.name,
		serial: input.serial || null,
		purchaseDate,
		warrantyMonths: input.warrantyMonths ?? null,
		warrantyExpiresAt: warrantyExpiry({
			purchaseDate,
			warrantyMonths: input.warrantyMonths,
			warrantyExpiresAt: input.warrantyExpiresAt,
		}),
		location: input.location || null,
		notes: input.notes || null,
		status: input.status,
		updatedAt: new Date(),
	};

	return db.transaction(async (tx) => {
		let id = input.id;
		if (id) {
			const [row] = await tx
				.update(assets)
				.set(values)
				.where(and(eq(assets.id, id), eq(assets.ownerId, ownerId)))
				.returning({ id: assets.id });
			if (!row) throw new Error("NOT_FOUND");
		} else {
			const [row] = await tx
				.insert(assets)
				.values(values)
				.returning({ id: assets.id });
			if (!row) throw new Error("Asset insert failed");
			id = row.id;
			// New asset from an order: attach its invoices/receipts by default.
			if (orderId && !input.documentIds) {
				const docs = await tx
					.select({ id: documents.id })
					.from(documents)
					.where(
						and(
							eq(documents.orderId, orderId),
							inArray(documents.kind, ["invoice", "receipt"]),
						),
					);
				if (docs.length)
					await tx
						.insert(assetDocuments)
						.values(
							docs.map((d) => ({ assetId: id as string, documentId: d.id })),
						)
						.onConflictDoNothing();
			}
			if (orderId)
				await audit(
					tx,
					{ type: "user", id: ownerId },
					"order.asset_registered",
					orderId,
					{
						assetId: id,
						name: input.name,
						serial: input.serial ?? null,
					},
				);
		}
		if (input.documentIds) {
			await tx.delete(assetDocuments).where(eq(assetDocuments.assetId, id));
			if (input.documentIds.length)
				await tx
					.insert(assetDocuments)
					.values(
						input.documentIds.map((documentId) => ({
							assetId: id as string,
							documentId,
						})),
					)
					.onConflictDoNothing();
		}
		return { id };
	});
}

export async function deleteAssetForOwner(ownerId: string, id: string) {
	const rows = await db
		.delete(assets)
		.where(and(eq(assets.id, id), eq(assets.ownerId, ownerId)))
		.returning({ id: assets.id });
	if (!rows[0]) throw new Error("NOT_FOUND");
	return { ok: true };
}
