import { createServerFn } from "@tanstack/react-start";
import { idInput } from "./inputs";

export const listUnsupportedOrders = createServerFn({ method: "GET" }).handler(
	async () => {
		const { requireUser } = await import("#/lib/session.server");
		const { listUnsupportedOrdersForOwner } = await import(
			"./reparse-support.server"
		);
		return listUnsupportedOrdersForOwner((await requireUser()).id);
	},
);

export const deleteUnsupportedOrder = createServerFn({ method: "POST" })
	.validator(idInput)
	.handler(async ({ data }) => {
		const { requireUser } = await import("#/lib/session.server");
		const { deleteUnsupportedOrderForOwner } = await import(
			"./reparse-support.server"
		);
		return deleteUnsupportedOrderForOwner((await requireUser()).id, data.id);
	});
