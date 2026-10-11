/**
 * TanStack server functions for order lifecycle features. Implementations
 * are imported lazily so they never reach the client; every call resolves
 * the session user and passes its id to *ForOwner functions.
 */
import { createServerFn } from "@tanstack/react-start";
import {
	assetListInput,
	assetSaveInput,
	dismissDuplicateInput,
	documentLinkInput,
	duplicateFlagsInput,
	idOnlyInput,
	itemHistoryInput,
	itemSearchInput,
	mergeOrdersInput,
	netSpendInput,
	orderIdInput,
	refundCreateInput,
	refundUpdateInput,
} from "./inputs";

const userId = async () =>
	(await (await import("#/features/ledger/ledger.server")).requireUser()).id;
const refundsModule = () => import("./refunds.server");
const assetsModule = () => import("./assets.server");
const itemsModule = () => import("./items.server");
const duplicatesModule = () => import("./duplicates.server");
const linksModule = () => import("./document-links.server");
const trackingModule = () => import("./tracking.server");

/* refunds */
export const getOrderRefunds = createServerFn({ method: "GET" })
	.validator(orderIdInput)
	.handler(async ({ data }) =>
		(await refundsModule()).listRefundsForOwner(await userId(), data.orderId),
	);
export const createRefund = createServerFn({ method: "POST" })
	.validator(refundCreateInput)
	.handler(async ({ data }) =>
		(await refundsModule()).createRefundForOwner(await userId(), data),
	);
export const updateRefund = createServerFn({ method: "POST" })
	.validator(refundUpdateInput)
	.handler(async ({ data }) =>
		(await refundsModule()).updateRefundForOwner(await userId(), data),
	);
export const deleteRefund = createServerFn({ method: "POST" })
	.validator(idOnlyInput)
	.handler(async ({ data }) =>
		(await refundsModule()).deleteRefundForOwner(await userId(), data.id),
	);
export const getNetSpend = createServerFn({ method: "POST" })
	.validator(netSpendInput)
	.handler(async ({ data }) =>
		(await refundsModule()).getNetSpendForOwner(await userId(), data),
	);

/* assets */
export const listAssets = createServerFn({ method: "POST" })
	.validator(assetListInput)
	.handler(async ({ data }) =>
		(await assetsModule()).listAssetsForOwner(await userId(), data),
	);
export const getOrderAssets = createServerFn({ method: "GET" })
	.validator(orderIdInput)
	.handler(async ({ data }) =>
		(await assetsModule()).listOrderAssetsForOwner(
			await userId(),
			data.orderId,
		),
	);
export const saveAsset = createServerFn({ method: "POST" })
	.validator(assetSaveInput)
	.handler(async ({ data }) =>
		(await assetsModule()).saveAssetForOwner(await userId(), data),
	);
export const deleteAsset = createServerFn({ method: "POST" })
	.validator(idOnlyInput)
	.handler(async ({ data }) =>
		(await assetsModule()).deleteAssetForOwner(await userId(), data.id),
	);

/* items */
export const searchItems = createServerFn({ method: "POST" })
	.validator(itemSearchInput)
	.handler(async ({ data }) =>
		(await itemsModule()).searchItemsForOwner(await userId(), data),
	);
export const getItemHistory = createServerFn({ method: "POST" })
	.validator(itemHistoryInput)
	.handler(async ({ data }) =>
		(await itemsModule()).getItemHistoryForOwner(await userId(), data),
	);

/* duplicates */
export const getDuplicateCandidates = createServerFn({ method: "GET" })
	.validator(orderIdInput)
	.handler(async ({ data }) =>
		(await duplicatesModule()).getDuplicateCandidatesForOwner(
			await userId(),
			data.orderId,
		),
	);
export const getDuplicateFlags = createServerFn({ method: "POST" })
	.validator(duplicateFlagsInput)
	.handler(async ({ data }) =>
		(await duplicatesModule()).getDuplicateFlagsForOwner(
			await userId(),
			data.orderIds,
		),
	);
export const dismissDuplicate = createServerFn({ method: "POST" })
	.validator(dismissDuplicateInput)
	.handler(async ({ data }) =>
		(await duplicatesModule()).dismissDuplicateForOwner(
			await userId(),
			data.orderId,
			data.otherId,
		),
	);
export const mergeOrders = createServerFn({ method: "POST" })
	.validator(mergeOrdersInput)
	.handler(async ({ data }) =>
		(await duplicatesModule()).mergeOrdersForOwner(
			await userId(),
			data.keepId,
			data.dropId,
		),
	);

/* document links */
export const linkDocumentToOrder = createServerFn({ method: "POST" })
	.validator(documentLinkInput)
	.handler(async ({ data }) =>
		(await linksModule()).linkDocumentToOrderForOwner(
			await userId(),
			data.documentId,
			data.orderId,
		),
	);
export const unlinkDocumentFromOrder = createServerFn({ method: "POST" })
	.validator(documentLinkInput)
	.handler(async ({ data }) =>
		(await linksModule()).unlinkDocumentFromOrderForOwner(
			await userId(),
			data.documentId,
			data.orderId,
		),
	);
export const getLinkedDocuments = createServerFn({ method: "GET" })
	.validator(orderIdInput)
	.handler(async ({ data }) =>
		(await linksModule()).listLinkedDocumentsForOwner(
			await userId(),
			data.orderId,
		),
	);

/* tracking */
export const getOrderTracking = createServerFn({ method: "GET" })
	.validator(orderIdInput)
	.handler(async ({ data }) =>
		(await trackingModule()).orderTrackingForOwner(
			await userId(),
			data.orderId,
		),
	);
