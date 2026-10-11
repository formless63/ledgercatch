import assert from "node:assert/strict";
import { Client } from "pg";
import { assertTransactionalJobsDatabase } from "../src/integrations/jobs/boss.server";

// Read-only URL/driver proof; no connection is opened and original settings are restored.
const saved = { DATABASE_URL: process.env.DATABASE_URL, PGBOSS_DATABASE_URL: process.env.PGBOSS_DATABASE_URL };
try {
 for (const [key, value] of [["host", "other.invalid"], ["hostaddr", "127.0.0.2"], ["port", "5433"], ["dbname", "other"], ["service", "other"]])
  for (const side of ["DATABASE_URL", "PGBOSS_DATABASE_URL"]) {
   process.env.DATABASE_URL = "postgres://app@db.example/app";
   process.env.PGBOSS_DATABASE_URL = "postgres://jobs@db.example/app";
   process.env[side] += `?${key}=${value}`;
   assert.throws(assertTransactionalJobsDatabase, /configuration is invalid/);
  }
 for (const missing of ["postgres:///app", "postgres://db.example", "postgres://db.example/"]) {
  process.env.DATABASE_URL = process.env.PGBOSS_DATABASE_URL = missing;
  assert.throws(assertTransactionalJobsDatabase, /configuration is invalid/);
 }
 process.env.DATABASE_URL = "postgresql://app:one@DB.EXAMPLE/app?sslmode=disable&application_name=domain";
 process.env.PGBOSS_DATABASE_URL = "postgres://jobs:two@db.example:5432/app?sslmode=verify-full&application_name=jobs";
 assert.doesNotThrow(assertTransactionalJobsDatabase);
 process.env.PGBOSS_DATABASE_URL = "postgres://jobs@alias.example/app";
 assert.throws(assertTransactionalJobsDatabase, /same canonical/);
 process.env.DATABASE_URL = "postgres://app@db.example/app%2Fother";
 process.env.PGBOSS_DATABASE_URL = "postgres://jobs@db.example/app/other";
 assert.throws(assertTransactionalJobsDatabase, /same canonical/);
 const parameters = (connectionString: string) => (new Client({ connectionString }) as unknown as { connectionParameters: { host: string; port: number } }).connectionParameters;
 assert.equal(parameters("postgres://app@db.example/app?host=other.invalid").host, "other.invalid");
 assert.equal(parameters("postgres://app@db.example/app?port=5433").port, 5433);
} finally {
 for (const [key,value] of Object.entries(saved)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
 }
}
console.info("Jobs transactional routing guard and actual driver parsing passed without network access");
