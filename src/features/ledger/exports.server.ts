/**
 * Accounting connections (per entity) and expense exports.
 * Providers live in src/features/connectors; this module owns persistence,
 * secrets-at-rest and job orchestration.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { encryptSecret } from "#/features/connectors/crypto.server";
import { getProvider, listProviders } from "#/features/connectors/registry";
import { errorMessage } from "#/features/connectors/types";
import { sendJobInTransaction } from "#/integrations/jobs/client.server";
import { contextFor } from "./export-push.server";
import { requireUser } from "./ledger.server";
import { allocations, connections, entities, exports, orders } from "./schema";

export const connectionInput = z.object({
	id: z.string().uuid().optional(),
	provider: z.enum(["custom_http", "invoice_ninja"]),
	name: z.string().trim().min(1).max(120),
	entityId: z.string().uuid(),
	enabled: z.boolean().default(true),
	config: z.record(z.string(), z.unknown()),
	/** Omit to keep the stored secret. */
	secret: z.record(z.string(), z.unknown()).optional(),
});

export function describeProviders() {
	return listProviders().map((provider) => ({
		id: provider.id,
		label: provider.label,
		description: provider.description,
		configFields: provider.configFields,
		secretFields: provider.secretFields,
	}));
}

async function ownedConnection(ownerId: string, id: string) {
	const [row] = await db
		.select()
		.from(connections)
		.where(and(eq(connections.id, id), eq(connections.ownerId, ownerId)));
	if (!row) throw new Error("NOT_FOUND");
	return row;
}

export async function listConnections() {
	return listConnectionsForOwner((await requireUser()).id);
}

export async function listConnectionsForOwner(ownerId: string) {
	const user = { id: ownerId };
	const rows = await db
		.select()
		.from(connections)
		.where(eq(connections.ownerId, user.id))
		.orderBy(asc(connections.name));
	return rows.map(({ secretCiphertext, ...row }) => ({
		...row,
		config: row.config as Record<string, string | Record<string, string>>,
		hasSecret: Boolean(secretCiphertext),
		lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	}));
}

export async function saveConnection(input: z.output<typeof connectionInput>) {
	return saveConnectionForOwner((await requireUser()).id, input);
}

export async function saveConnectionForOwner(
	ownerId: string,
	input: z.output<typeof connectionInput>,
) {
	const user = { id: ownerId };
	const [entity] = await db
		.select({ id: entities.id })
		.from(entities)
		.where(and(eq(entities.id, input.entityId), eq(entities.ownerId, user.id)));
	if (!entity) throw new Error("Unknown entity");
	const provider = getProvider(input.provider);
	const config = provider.configSchema.safeParse(input.config);
	if (!config.success)
		throw new Error(
			`Invalid settings: ${config.error.issues.map((i) => i.message).join("; ")}`,
		);
	let secretCiphertext: string | undefined;
	if (
		input.secret &&
		Object.values(input.secret).some((v) => v !== "" && v != null)
	) {
		const secret = provider.secretSchema.safeParse(input.secret);
		if (!secret.success) throw new Error("Invalid credentials");
		secretCiphertext = encryptSecret(secret.data);
	}
	const values = {
		provider: input.provider,
		name: input.name,
		entityId: input.entityId,
		enabled: input.enabled,
		config: config.data as Record<string, unknown>,
		...(secretCiphertext ? { secretCiphertext } : {}),
		updatedAt: new Date(),
	};
	if (input.id) {
		const current = await ownedConnection(user.id, input.id);
		if (current.provider !== input.provider)
			throw new Error("Create a new connection to change providers");
		// Any configuration change resets the prior test result.
		const endpointChanged =
			JSON.stringify(current.config) !== JSON.stringify(config.data);
		if (
			secretCiphertext ||
			endpointChanged ||
			current.provider !== input.provider
		)
			Object.assign(values, { status: "untested" as const });
		await db
			.update(connections)
			.set(values)
			.where(
				and(eq(connections.id, input.id), eq(connections.ownerId, ownerId)),
			);
		return { id: input.id };
	}
	const [row] = await db
		.insert(connections)
		.values({ ...values, ownerId: user.id })
		.returning({ id: connections.id });
	if (!row) throw new Error("Insert failed");
	return { id: row.id };
}

export async function deleteConnection(id: string) {
	return deleteConnectionForOwner((await requireUser()).id, id);
}

export async function deleteConnectionForOwner(ownerId: string, id: string) {
	const user = { id: ownerId };
	await ownedConnection(user.id, id);
	await db
		.delete(connections)
		.where(and(eq(connections.id, id), eq(connections.ownerId, ownerId)));
	return { ok: true };
}

export async function testConnection(id: string) {
	return testConnectionForOwner((await requireUser()).id, id);
}

export async function testConnectionForOwner(ownerId: string, id: string) {
	const user = { id: ownerId };
	const row = await ownedConnection(user.id, id);
	let result: { ok: boolean; summary?: string; error?: string };
	try {
		const { provider, ctx } = contextFor(row);
		result = await provider.test(ctx);
	} catch (error) {
		result = { ok: false, error: errorMessage(error) };
	}
	await db
		.update(connections)
		.set({
			status: result.ok ? "ok" : "error",
			lastCheckedAt: new Date(),
			lastError: result.ok ? null : (result.error ?? "Unknown error"),
		})
		.where(and(eq(connections.id, id), eq(connections.ownerId, ownerId)));
	return result;
}

export async function connectionOptions(id: string) {
	return connectionOptionsForOwner((await requireUser()).id, id);
}

export async function connectionOptionsForOwner(ownerId: string, id: string) {
	const user = { id: ownerId };
	const row = await ownedConnection(user.id, id);
	const { provider, ctx } = contextFor(row);
	return provider.listOptions(ctx);
}

/** Queue exports for allocations (or every allocation of the given orders). */
export async function queueExports(input: {
	allocationIds?: string[];
	orderIds?: string[];
	connectionId?: string;
	force?: boolean;
}) {
	return queueExportsForOwner((await requireUser()).id, input);
}

export async function queueExportsForOwner(
	ownerId: string,
	input: {
		allocationIds?: string[];
		orderIds?: string[];
		connectionId?: string;
		force?: boolean;
	},
) {
	const user = { id: ownerId };
	const where = [eq(orders.ownerId, user.id)];
	if (input.allocationIds?.length)
		where.push(inArray(allocations.id, input.allocationIds));
	else if (input.orderIds?.length)
		where.push(inArray(allocations.orderId, input.orderIds));
	else throw new Error("Nothing selected");
	const targets = await db
		.select({
			allocationId: allocations.id,
			entityId: allocations.entityId,
			orderId: orders.id,
		})
		.from(allocations)
		.innerJoin(orders, eq(orders.id, allocations.orderId))
		.where(and(...where));
	const userConnections = await db
		.select({
			id: connections.id,
			entityId: connections.entityId,
			enabled: connections.enabled,
		})
		.from(connections)
		.where(eq(connections.ownerId, user.id));
	let queued = 0;
	let skipped = 0;
	await db.transaction(async (tx) => {
		for (const target of targets) {
			const matches = userConnections.filter(
				(c) =>
					c.enabled &&
					c.entityId === target.entityId &&
					(!input.connectionId || c.id === input.connectionId),
			);
			if (matches.length === 0) {
				skipped++;
				continue;
			}
			for (const connection of matches) {
				const [existing] = await tx
					.select({ id: exports.id, status: exports.status })
					.from(exports)
					.where(
						and(
							eq(exports.connectionId, connection.id),
							eq(exports.allocationId, target.allocationId),
						),
					);
				if (existing && existing.status === "sent" && !input.force) {
					skipped++;
					continue;
				}
				let exportId = existing?.id;
				if (existing) {
					await tx
						.update(exports)
						.set({ status: "queued", error: null })
						.where(eq(exports.id, existing.id));
				} else {
					const [row] = await tx
						.insert(exports)
						.values({
							connectionId: connection.id,
							allocationId: target.allocationId,
						})
						.returning({ id: exports.id });
					exportId = row?.id;
				}
				if (!exportId) continue;
				await sendJobInTransaction(tx, "exports.push", {
					exportId,
					skipFuzzyDuplicateCheck: Boolean(input.force),
				});
				queued++;
			}
		}
	});
	return { queued, skipped };
}
