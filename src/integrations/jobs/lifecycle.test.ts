import { Client } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import {
	assertTransactionalJobsDatabase,
	jobsDatabaseUrl,
	jobsListenNotify,
	jobsRoleOptions,
	jobsSchema,
	workerConcurrency,
} from "./boss.server";
import { createJobsLifecycle } from "./lifecycle.server";

const previous = new Map<string, string | undefined>();
function setEnv(name: string, value: string) {
	if (!previous.has(name)) previous.set(name, process.env[name]);
	process.env[name] = value;
}
afterEach(() => {
	for (const [name, value] of previous) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	previous.clear();
});
it("recovers failed startup, cleans partial initialization and shares concurrent starts", async () => {
	let fail = true;
	const stop = vi.fn(async () => {});
	const start = vi.fn(async () => {
		if (fail) throw new Error("startup");
		return {} as never;
	});
	const lifecycle = createJobsLifecycle(
		() => ({ start, stop }),
		async () => {},
	);
	await expect(lifecycle.get()).rejects.toThrow("startup");
	expect(stop).toHaveBeenCalledOnce();
	fail = false;
	const [one, two] = await Promise.all([lifecycle.get(), lifecycle.get()]);
	expect(one).toBe(two);
	expect(start).toHaveBeenCalledTimes(2);
	await lifecycle.stop();
	await lifecycle.get();
	expect(start).toHaveBeenCalledTimes(3);
	await lifecycle.stop();
});
it("cleans a queue-registration failure and serializes restart after drain", async () => {
	let complete!: () => void;
	const stop = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
	);
	const start = vi.fn(async () => ({}) as never);
	const lifecycle = createJobsLifecycle(
		() => ({ start, stop }),
		async () => {},
	);
	await lifecycle.get();
	const stopping = lifecycle.stop();
	await Promise.resolve();
	await Promise.resolve();
	const next = lifecycle.get();
	expect(start).toHaveBeenCalledOnce();
	complete();
	await stopping;
	await next;
	expect(start).toHaveBeenCalledTimes(2);
	let first = true;
	const cleanup = vi.fn(async () => {});
	const partial = createJobsLifecycle(
		() => ({ start, stop: cleanup }),
		async () => {
			if (first) {
				first = false;
				throw new Error("queues");
			}
		},
	);
	await expect(partial.get()).rejects.toThrow("queues");
	expect(cleanup).toHaveBeenCalledOnce();
	await partial.get();
	await partial.stop();
});
it("uses empty optional fallback and rejects malformed Jobs settings before networking", () => {
	setEnv("DATABASE_URL", "postgresql://one:secret@localhost/db");
	setEnv("PGBOSS_DATABASE_URL", "");
	expect(jobsDatabaseUrl()).toContain("/db");
	for (const value of ["4garbage", "4.5", "0", "101", "-1", " 4", "1e1"]) {
		setEnv("JOBS_CONCURRENCY", value);
		expect(workerConcurrency).toThrow();
	}
	setEnv("JOBS_CONCURRENCY", "4");
	expect(workerConcurrency()).toBe(4);
	for (const [raw, value] of [
		["", 4],
		["1", 1],
		["100", 100],
	] as const) {
		setEnv("JOBS_CONCURRENCY", raw);
		expect(workerConcurrency()).toBe(value);
	}
	setEnv("PGBOSS_USE_LISTEN_NOTIFY", "yes");
	expect(jobsListenNotify).toThrow();
	setEnv("PGBOSS_SCHEMA", "x".repeat(64));
	expect(jobsSchema).toThrow();
	setEnv(
		"PGBOSS_DATABASE_URL",
		"postgres://different:credential@localhost:5432/db",
	);
	expect(assertTransactionalJobsDatabase).not.toThrow();
	setEnv(
		"PGBOSS_DATABASE_URL",
		"postgres://different:credential@localhost/isolated",
	);
	expect(assertTransactionalJobsDatabase).toThrow(/same canonical/);
});

it("assigns migration, supervision and scheduling to explicit process roles", () => {
	for (const role of ["producer", "admin"] as const) {
		expect(jobsRoleOptions(role)).toEqual({
			migrate: false,
			schedule: false,
			supervise: false,
		});
	}
	expect(jobsRoleOptions("worker")).toEqual({
		migrate: false,
		schedule: true,
		supervise: true,
	});
	expect(jobsRoleOptions("migration")).toEqual({
		migrate: true,
		schedule: false,
		supervise: false,
	});
});

it("refuses routing query overrides on either side before transactional enqueue", () => {
	const canonical = "postgres://app:private-domain@db.example/app";
	for (const [key, value] of [
		["host", "other.example"],
		["hostaddr", "127.0.0.2"],
		["port", "5433"],
		["dbname", "other"],
		["service", "other"],
		["h%6Fst", "other.example"],
		["HOST", "other.example"],
		["host", ""],
		["port", "5432"],
	]) {
		for (const side of ["DATABASE_URL", "PGBOSS_DATABASE_URL"]) {
			setEnv("DATABASE_URL", canonical);
			setEnv(
				"PGBOSS_DATABASE_URL",
				"postgres://jobs:private-jobs@db.example/app",
			);
			setEnv(side, `${process.env[side]}?${key}=${value}`);
			expect(assertTransactionalJobsDatabase).toThrow(
				"Jobs database configuration is invalid",
			);
			try {
				assertTransactionalJobsDatabase();
			} catch (error) {
				expect(String(error)).not.toMatch(
					/private-domain|private-jobs|db\.example|other\.example/,
				);
			}
		}
	}
});

it("requires explicit host/database and compares canonical host, port and driver-decoded database", () => {
	for (const missing of [
		"postgres:///app",
		"postgres://db.example",
		"postgres://db.example/",
		"postgres://app@/app",
	])
		for (const side of ["DATABASE_URL", "PGBOSS_DATABASE_URL"]) {
			setEnv("DATABASE_URL", "postgres://app@db.example/app");
			setEnv("PGBOSS_DATABASE_URL", "postgres://jobs@db.example/app");
			setEnv(side, missing);
			expect(assertTransactionalJobsDatabase).toThrow(
				"Jobs database configuration is invalid",
			);
		}
	for (const missing of [
		"postgres:///app",
		"postgres://db.example",
		"postgres://db.example/",
	]) {
		setEnv("DATABASE_URL", missing);
		setEnv("PGBOSS_DATABASE_URL", missing);
		expect(assertTransactionalJobsDatabase).toThrow(
			"Jobs database configuration is invalid",
		);
	}
	for (const jobs of [
		"postgres://jobs@alias.example/app",
		"postgres://jobs@db.example:5433/app",
		"postgres://jobs@db.example/other",
	]) {
		setEnv("DATABASE_URL", "postgres://app@db.example/app");
		setEnv("PGBOSS_DATABASE_URL", jobs);
		expect(assertTransactionalJobsDatabase).toThrow(/same canonical/);
	}
	setEnv(
		"DATABASE_URL",
		"postgresql://app:one@DB.EXAMPLE/app%20space?sslmode=disable&application_name=domain",
	);
	setEnv(
		"PGBOSS_DATABASE_URL",
		"postgres://jobs:two@db.example:5432/app%20space?sslmode=verify-full&application_name=jobs",
	);
	expect(assertTransactionalJobsDatabase).not.toThrow();
	setEnv("PGBOSS_DATABASE_URL", "");
	expect(assertTransactionalJobsDatabase).not.toThrow();
	setEnv("DATABASE_URL", "postgres://app@db.example/app%2Fother");
	setEnv("PGBOSS_DATABASE_URL", "postgres://jobs@db.example/app/other");
	expect(assertTransactionalJobsDatabase).toThrow(/same canonical/);
});

it("confirms locked pg routing and decoding without opening a connection", () => {
	const parameters = (connectionString: string) => {
		const client = new Client({ connectionString });
		return (
			client as unknown as {
				connectionParameters: { host: string; port: number; database: string };
			}
		).connectionParameters;
	};
	expect(
		parameters("postgres://app@db.example/app?host=other.example").host,
	).toBe("other.example");
	expect(parameters("postgres://app@db.example/app?port=5433").port).toBe(5433);
	expect(parameters("postgres://app@db.example/app%2Fother").database).toBe(
		"app%2Fother",
	);
	expect(parameters("postgres://app@db.example/app%20space").database).toBe(
		"app space",
	);
});
