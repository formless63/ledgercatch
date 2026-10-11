import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
	flagDefinitions as definitions,
	flagOverrides as overrides,
} from "./schema";
import {
	actionId,
	cursorFor,
	type FeatureFlagsCode,
	FeatureFlagsError,
	opaqueId,
	pageInput,
	safeError,
} from "./validation";
export interface FlagContext {
	readonly userId?: string;
	readonly tenantId?: string;
}
export type FlagReason =
	| "not-found"
	| "disabled"
	| "tenant-target"
	| "user-target"
	| "rollout"
	| "default"
	| "error";
export type FlagDetails = Readonly<{
	value: boolean;
	reason: FlagReason;
	revision?: number;
	errorCode?: FeatureFlagsCode;
}>;
export type FlagTransaction = Pick<
	NodePgDatabase,
	"select" | "insert" | "update" | "delete" | "execute"
>;
export interface FlagDatabase {
	transaction<T>(run: (tx: FlagTransaction) => Promise<T>): Promise<T>;
}
export interface FlagActor {
	readonly userId: string;
	readonly authority?: "operator";
}
export interface FlagOptions {
	readonly managementGuard?: (
		actor: FlagActor,
		operation: "create" | "update" | "override" | "list",
		tx: FlagTransaction,
	) => boolean | Promise<boolean>;
	readonly audit?: (
		tx: FlagTransaction,
		event: {
			action: "flags.create" | "flags.update" | "flags.override";
			flagId: string;
			revision: number;
		},
	) => Promise<void>;
}
export function rolloutBucket(
	key: string,
	kind: "tenant" | "user",
	id: string,
) {
	const bytes = createHash("sha256")
		.update(JSON.stringify(["feature-flags-v1", key, kind, id]), "utf8")
		.digest();
	return Math.floor((bytes.readUInt32BE(0) * 10000) / 4294967296);
}
function keyId(value: unknown) {
	return actionId(value, 128, false);
}
function contextValue(context: FlagContext) {
	if (!context || typeof context !== "object" || Array.isArray(context))
		throw new FeatureFlagsError("invalid-input");
	return Object.freeze({
		...(context.userId === undefined
			? {}
			: { userId: opaqueId(context.userId) }),
		...(context.tenantId === undefined
			? {}
			: { tenantId: opaqueId(context.tenantId) }),
	});
}
function definitionValues(input: {
	description?: string;
	enabled?: boolean;
	defaultValue?: boolean;
	rolloutBasisPoints?: number | null;
}) {
	if (
		typeof input.description !== "string" ||
		input.description.length > 200 ||
		Array.from(input.description).some(
			(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
		)
	)
		throw new FeatureFlagsError("invalid-input");
	if (
		typeof input.enabled !== "boolean" ||
		typeof input.defaultValue !== "boolean" ||
		(input.rolloutBasisPoints !== null &&
			(!Number.isInteger(input.rolloutBasisPoints) ||
				Number(input.rolloutBasisPoints) < 0 ||
				Number(input.rolloutBasisPoints) > 10000))
	)
		throw new FeatureFlagsError("invalid-input");
	return {
		description: input.description,
		enabled: input.enabled,
		defaultValue: input.defaultValue,
		rolloutBasisPoints: input.rolloutBasisPoints as number | null,
	};
}
function expected(value: unknown) {
	if (!Number.isSafeInteger(value) || Number(value) < 1)
		throw new FeatureFlagsError("invalid-input");
	return value as number;
}
export async function setFlagTransactionBounds(
	tx: Pick<NodePgDatabase, "execute">,
	evaluation = false,
) {
	await tx.execute(
		sql.raw(`SET LOCAL statement_timeout='${evaluation ? "1s" : "5s"}'`),
	);
	await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
}
export function defineFeatureFlags(options: FlagOptions = {}) {
	if (
		!options ||
		typeof options !== "object" ||
		[options.managementGuard, options.audit].some(
			(value) => value !== undefined && typeof value !== "function",
		)
	)
		throw new FeatureFlagsError("configuration");
	async function guard(
		tx: FlagTransaction,
		actor: FlagActor,
		operation: "create" | "update" | "override" | "list",
	) {
		if (!actor?.userId) throw new FeatureFlagsError("unauthenticated");
		opaqueId(actor.userId);
		if (
			!options.managementGuard ||
			(await options.managementGuard(actor, operation, tx)) !== true
		)
			throw new FeatureFlagsError("forbidden");
	}
	async function owned<T>(
		db: FlagDatabase,
		run: (tx: FlagTransaction) => Promise<T>,
	): Promise<T> {
		try {
			return await db.transaction(async (tx) => {
				await setFlagTransactionBounds(tx);
				return run(tx);
			});
		} catch (error) {
			throw safeError(error);
		}
	}
	async function evaluateMany(
		db: FlagDatabase,
		keys: readonly string[],
		context: FlagContext,
	): Promise<Record<string, FlagDetails>> {
		if (
			!Array.isArray(keys) ||
			keys.length > 50 ||
			new Set(keys).size !== keys.length
		)
			throw new FeatureFlagsError("invalid-input");
		for (const key of keys) keyId(key);
		const trusted = contextValue(context);
		if (!keys.length) return {};
		try {
			// One SELECT sees definitions and overrides from one PostgreSQL statement snapshot.
			const rows = await db.transaction(async (tx) => {
				await setFlagTransactionBounds(tx, true);
				return tx
					.select({ definition: definitions, override: overrides })
					.from(definitions)
					.leftJoin(
						overrides,
						and(
							eq(overrides.flagKey, definitions.key),
							sql`((${overrides.targetKind}='tenant' AND ${overrides.targetId}=${trusted.tenantId ?? null}) OR (${overrides.targetKind}='user' AND ${overrides.targetId}=${trusted.userId ?? null}))`,
						),
					)
					.where(inArray(definitions.key, [...keys]));
			});
			const result: Record<string, FlagDetails> = {};
			for (const key of keys) {
				const matches = rows.filter((r) => r.definition.key === key),
					definition = matches[0]?.definition;
				if (!definition) {
					result[key] = { value: false, reason: "not-found" };
					continue;
				}
				try {
					keyId(definition.key);
					definitionValues(definition);
					expected(definition.revision);
					if (
						matches.some(
							(r) =>
								r.override &&
								(typeof r.override.value !== "boolean" ||
									!["user", "tenant"].includes(r.override.targetKind)),
						)
					)
						throw 0;
					const revision = definition.revision;
					if (!definition.enabled) {
						result[key] = { value: false, reason: "disabled", revision };
						continue;
					}
					const tenant = matches.find(
							(r) => r.override?.targetKind === "tenant",
						)?.override,
						user = matches.find(
							(r) => r.override?.targetKind === "user",
						)?.override;
					if (tenant) {
						result[key] = {
							value: tenant.value,
							reason: "tenant-target",
							revision,
						};
						continue;
					}
					if (user) {
						result[key] = {
							value: user.value,
							reason: "user-target",
							revision,
						};
						continue;
					}
					const identity = trusted.tenantId ?? trusted.userId;
					if (
						definition.rolloutBasisPoints !== null &&
						identity !== undefined
					) {
						result[key] = {
							value:
								rolloutBucket(
									key,
									trusted.tenantId !== undefined ? "tenant" : "user",
									identity,
								) < definition.rolloutBasisPoints,
							reason: "rollout",
							revision,
						};
						continue;
					}
					result[key] = {
						value: definition.defaultValue,
						reason: "default",
						revision,
					};
				} catch {
					result[key] = {
						value: false,
						reason: "error",
						errorCode: "configuration",
					};
				}
			}
			return result;
		} catch (error) {
			const errorCode = safeError(error).code;
			return Object.fromEntries(
				keys.map((key) => [
					key,
					{ value: false, reason: "error" as const, errorCode },
				]),
			);
		}
	}
	async function createInTransaction(
		tx: FlagTransaction,
		actor: FlagActor,
		input: {
			key: string;
			description?: string;
			enabled?: boolean;
			defaultValue?: boolean;
			rolloutBasisPoints?: number | null;
		},
	) {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new FeatureFlagsError("invalid-input");
		const key = keyId(input.key),
			values = definitionValues({
				description: input.description ?? "",
				enabled: input.enabled ?? false,
				defaultValue: input.defaultValue ?? false,
				rolloutBasisPoints: input.rolloutBasisPoints ?? null,
			});
		try {
			await setFlagTransactionBounds(tx);
			await guard(tx, actor, "create");
			const now = new Date();
			const [created] = await tx
				.insert(definitions)
				.values({ key, ...values, revision: 1, createdAt: now, updatedAt: now })
				.returning();
			await options.audit?.(tx, {
				action: "flags.create",
				flagId: key,
				revision: 1,
			});
			return created;
		} catch (error) {
			throw safeError(error);
		}
	}
	async function locked(tx: FlagTransaction, key: string, revision: number) {
		const [row] = await tx
			.select()
			.from(definitions)
			.where(eq(definitions.key, key))
			.for("update");
		if (!row) throw new FeatureFlagsError("not-found");
		if (row.revision !== revision) throw new FeatureFlagsError("conflict");
		return row;
	}
	async function updateInTransaction(
		tx: FlagTransaction,
		actor: FlagActor,
		input: {
			key: string;
			expectedRevision: number;
			description?: string;
			enabled?: boolean;
			defaultValue?: boolean;
			rolloutBasisPoints?: number | null;
		},
	) {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new FeatureFlagsError("invalid-input");
		const key = keyId(input.key),
			revision = expected(input.expectedRevision);
		if (
			Object.keys(input).some(
				(k) =>
					![
						"key",
						"expectedRevision",
						"description",
						"enabled",
						"defaultValue",
						"rolloutBasisPoints",
					].includes(k),
			)
		)
			throw new FeatureFlagsError("invalid-input");
		try {
			await setFlagTransactionBounds(tx);
			await guard(tx, actor, "update");
			const row = await locked(tx, key, revision);
			const values = definitionValues({
				...row,
				...Object.fromEntries(
					Object.entries(input).filter(([k]) =>
						[
							"description",
							"enabled",
							"defaultValue",
							"rolloutBasisPoints",
						].includes(k),
					),
				),
			});
			if (Object.entries(values).every(([k, v]) => Reflect.get(row, k) === v))
				return row;
			const [updated] = await tx
				.update(definitions)
				.set({ ...values, revision: revision + 1, updatedAt: new Date() })
				.where(eq(definitions.key, key))
				.returning();
			await options.audit?.(tx, {
				action: "flags.update",
				flagId: key,
				revision: updated.revision,
			});
			return updated;
		} catch (error) {
			throw safeError(error);
		}
	}
	async function overrideInTransaction(
		tx: FlagTransaction,
		actor: FlagActor,
		input: {
			key: string;
			expectedRevision: number;
			targetKind: "user" | "tenant";
			targetId: string;
			value?: boolean;
		},
		remove = false,
	) {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new FeatureFlagsError("invalid-input");
		const key = keyId(input.key),
			revision = expected(input.expectedRevision),
			targetId = opaqueId(input.targetId);
		if (
			!["user", "tenant"].includes(input.targetKind) ||
			(!remove && typeof input.value !== "boolean")
		)
			throw new FeatureFlagsError("invalid-input");
		try {
			await setFlagTransactionBounds(tx);
			await guard(tx, actor, "override");
			const row = await locked(tx, key, revision),
				predicate = and(
					eq(overrides.flagKey, key),
					eq(overrides.targetKind, input.targetKind),
					eq(overrides.targetId, targetId),
				);
			const [old] = await tx.select().from(overrides).where(predicate);
			if (remove ? !old : old?.value === input.value) return row;
			if (remove) await tx.delete(overrides).where(predicate);
			else if (old)
				await tx
					.update(overrides)
					.set({ value: input.value as boolean })
					.where(predicate);
			else
				await tx.insert(overrides).values({
					id: randomUUID(),
					flagKey: key,
					targetKind: input.targetKind,
					targetId,
					value: input.value as boolean,
					createdAt: new Date(),
				});
			const [updated] = await tx
				.update(definitions)
				.set({ revision: revision + 1, updatedAt: new Date() })
				.where(eq(definitions.key, key))
				.returning();
			await options.audit?.(tx, {
				action: "flags.override",
				flagId: key,
				revision: updated.revision,
			});
			return updated;
		} catch (error) {
			throw safeError(error);
		}
	}
	async function listDefinitionsInTransaction(
		tx: FlagTransaction,
		actor: FlagActor,
		input: { limit?: number; cursor?: string } = {},
	) {
		const { limit, cursor } = pageInput(input, "key");
		try {
			await setFlagTransactionBounds(tx);
			await guard(tx, actor, "list");
			const rows = await tx
				.select()
				.from(definitions)
				.where(
					cursor
						? sql`(${definitions.createdAt},${definitions.key})<(${cursor.createdAt},${cursor.id})`
						: undefined,
				)
				.orderBy(desc(definitions.createdAt), desc(definitions.key))
				.limit(limit + 1);
			return {
				items: rows.slice(0, limit),
				nextCursor:
					rows.length > limit
						? cursorFor({
								id: rows[limit - 1].key,
								createdAt: rows[limit - 1].createdAt,
							})
						: null,
			};
		} catch (error) {
			throw safeError(error);
		}
	}
	async function listOverridesInTransaction(
		tx: FlagTransaction,
		actor: FlagActor,
		keyInput: string,
		input: { limit?: number; cursor?: string } = {},
	) {
		const key = keyId(keyInput),
			{ limit, cursor } = pageInput(input);
		try {
			await setFlagTransactionBounds(tx);
			await guard(tx, actor, "list");
			const rows = await tx
				.select()
				.from(overrides)
				.where(
					and(
						eq(overrides.flagKey, key),
						cursor
							? sql`(${overrides.createdAt},${overrides.id})<(${cursor.createdAt},${cursor.id})`
							: undefined,
					),
				)
				.orderBy(desc(overrides.createdAt), desc(overrides.id))
				.limit(limit + 1);
			return {
				items: rows.slice(0, limit),
				nextCursor: rows.length > limit ? cursorFor(rows[limit - 1]) : null,
			};
		} catch (error) {
			throw safeError(error);
		}
	}
	return Object.freeze({
		evaluateMany,
		evaluateBooleanDetails: async (
			db: FlagDatabase,
			key: string,
			context: FlagContext,
		) => (await evaluateMany(db, [key], context))[key],
		evaluateBoolean: async (
			db: FlagDatabase,
			key: string,
			context: FlagContext,
		) => (await evaluateMany(db, [key], context))[key].value,
		createDefinitionInTransaction: createInTransaction,
		createDefinition: (
			db: FlagDatabase,
			actor: FlagActor,
			input: Parameters<typeof createInTransaction>[2],
		) => owned(db, (tx) => createInTransaction(tx, actor, input)),
		updateDefinitionInTransaction: updateInTransaction,
		updateDefinition: (
			db: FlagDatabase,
			actor: FlagActor,
			input: Parameters<typeof updateInTransaction>[2],
		) => owned(db, (tx) => updateInTransaction(tx, actor, input)),
		setOverrideInTransaction: (
			tx: FlagTransaction,
			actor: FlagActor,
			input: Parameters<typeof overrideInTransaction>[2],
		) => overrideInTransaction(tx, actor, input),
		setOverride: (
			db: FlagDatabase,
			actor: FlagActor,
			input: Parameters<typeof overrideInTransaction>[2],
		) => owned(db, (tx) => overrideInTransaction(tx, actor, input)),
		removeOverrideInTransaction: (
			tx: FlagTransaction,
			actor: FlagActor,
			input: Omit<Parameters<typeof overrideInTransaction>[2], "value">,
		) => overrideInTransaction(tx, actor, input, true),
		removeOverride: (
			db: FlagDatabase,
			actor: FlagActor,
			input: Omit<Parameters<typeof overrideInTransaction>[2], "value">,
		) => owned(db, (tx) => overrideInTransaction(tx, actor, input, true)),
		listDefinitionsInTransaction,
		listDefinitions: (
			db: FlagDatabase,
			actor: FlagActor,
			input: Parameters<typeof listDefinitionsInTransaction>[2] = {},
		) => owned(db, (tx) => listDefinitionsInTransaction(tx, actor, input)),
		listOverridesInTransaction,
		listOverrides: (
			db: FlagDatabase,
			actor: FlagActor,
			key: string,
			input: Parameters<typeof listOverridesInTransaction>[3] = {},
		) => owned(db, (tx) => listOverridesInTransaction(tx, actor, key, input)),
	});
}
