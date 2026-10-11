import { type ConstructorOptions, PgBoss } from "pg-boss";

const SCHEMA_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROUTING_QUERY_OPTIONS = new Set([
	"host",
	"hostaddr",
	"port",
	"dbname",
	"service",
]);

export function jobsDatabaseUrl() {
	const value = process.env.PGBOSS_DATABASE_URL || process.env.DATABASE_URL;
	if (!value) {
		throw new Error("PGBOSS_DATABASE_URL or DATABASE_URL is required");
	}
	return value;
}

export function jobsSchema() {
	const value = process.env.PGBOSS_SCHEMA || "pgboss";
	if (!SCHEMA_PATTERN.test(value) || Buffer.byteLength(value) > 63) {
		throw new Error("PGBOSS_SCHEMA must be a valid PostgreSQL identifier");
	}
	return value;
}

export function jobsListenNotify() {
	const value = process.env.PGBOSS_USE_LISTEN_NOTIFY || "false";
	if (!["true", "false"].includes(value))
		throw new Error("PGBOSS_USE_LISTEN_NOTIFY must be true or false");
	return value === "true";
}
export function workerConcurrency() {
	const raw = process.env.JOBS_CONCURRENCY || "4";
	const value = Number(raw);
	if (
		!/^\d+$/.test(raw) ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > 100
	)
		throw new Error("JOBS_CONCURRENCY must be an integer between 1 and 100");
	return value;
}
/** Transactional enqueue must use the domain database, not an isolated Jobs database.
 * Use a common canonical host/database URL; credentials may differ. */
export function assertTransactionalJobsDatabase() {
	const domain = process.env.DATABASE_URL;
	if (!domain) throw new Error("Transactional Jobs requires DATABASE_URL");
	const identity = (value: string) => {
		try {
			const url = new URL(value);
			if (
				!["postgres:", "postgresql:"].includes(url.protocol) ||
				!url.hostname ||
				!url.pathname.slice(1) ||
				Array.from(url.searchParams.keys()).some((key) =>
					ROUTING_QUERY_OPTIONS.has(key.toLowerCase()),
				)
			)
				throw new Error();
			return JSON.stringify([
				url.hostname.toLowerCase(),
				url.port || "5432",
				// Match pg-connection-string's database decoding, including escaped separators.
				decodeURI(url.pathname),
			]);
		} catch {
			throw new Error("Jobs database configuration is invalid");
		}
	};
	if (identity(domain) !== identity(jobsDatabaseUrl()))
		throw new Error(
			"Transactional Jobs requires the same canonical database host, port and database as DATABASE_URL",
		);
}
export type JobsRole = "producer" | "admin" | "worker" | "migration";

export function jobsRoleOptions(role: JobsRole) {
	return {
		migrate: role === "migration",
		schedule: role === "worker",
		supervise: role === "worker",
	};
}

export function createJobsBoss(
	role: JobsRole = "producer",
	overrides: Partial<
		Omit<ConstructorOptions, "migrate" | "schedule" | "supervise">
	> = {},
) {
	const boss = new PgBoss({
		connectionString: jobsDatabaseUrl(),
		schema: jobsSchema(),
		useListenNotify: jobsListenNotify(),
		...overrides,
		...jobsRoleOptions(role),
	});
	boss.on("error", (error) => {
		console.error(
			JSON.stringify({
				event: "jobs.error",
				error: error instanceof Error ? error.name : "Error",
			}),
		);
	});
	return boss;
}
