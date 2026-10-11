import { eq } from "drizzle-orm";
import { db } from "#/db";
import { orders } from "./schema";

export async function getOrderOwner(orderId: string): Promise<string | null> {
	if (!/^[0-9a-f-]{36}$/i.test(orderId)) return null;
	const [row] = await db
		.select({ ownerId: orders.ownerId })
		.from(orders)
		.where(eq(orders.id, orderId));
	return row?.ownerId ?? null;
}
