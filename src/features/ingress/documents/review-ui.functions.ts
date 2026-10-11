/**
 * Server functions for the assisted document review page. Implementations
 * are lazy-imported so server code never reaches the client bundle.
 */
import { createServerFn } from "@tanstack/react-start";
import {
	analyzeDocumentInput,
	attachDocumentInput,
	captureIdInput,
	createOrderFromDocumentInput,
	documentQueueInput,
	searchOrdersInput,
} from "./inputs";

const reviewUi = () => import("./review-ui.server");

export const listDocumentQueue = createServerFn({ method: "POST" })
	.validator(documentQueueInput)
	.handler(async ({ data }) => (await reviewUi()).listDocumentQueue(data));

export const getDocumentReview = createServerFn({ method: "GET" })
	.validator(captureIdInput)
	.handler(async ({ data }) =>
		(await reviewUi()).getDocumentReview(data.captureId),
	);

export const analyzeDocument = createServerFn({ method: "POST" })
	.validator(analyzeDocumentInput)
	.handler(async ({ data }) => (await reviewUi()).analyzeDocument(data));

export const createOrderFromDocument = createServerFn({ method: "POST" })
	.validator(createOrderFromDocumentInput)
	.handler(async ({ data }) =>
		(await reviewUi()).createOrderFromDocument(data),
	);

export const attachDocumentCapture = createServerFn({ method: "POST" })
	.validator(attachDocumentInput)
	.handler(async ({ data }) => (await reviewUi()).attachDocumentCapture(data));

export const ignoreDocumentCapture = createServerFn({ method: "POST" })
	.validator(captureIdInput)
	.handler(async ({ data }) =>
		(await reviewUi()).ignoreDocumentCapture(data.captureId),
	);

export const restoreDocumentCapture = createServerFn({ method: "POST" })
	.validator(captureIdInput)
	.handler(async ({ data }) =>
		(await reviewUi()).restoreDocumentCapture(data.captureId),
	);

export const searchOrdersForAttach = createServerFn({ method: "POST" })
	.validator(searchOrdersInput)
	.handler(async ({ data }) => (await reviewUi()).searchOrdersForAttach(data));
