import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
// This runner requires explicit disposable admin credentials. No fallback database.
const adminUrl=process.env.TEST_DATABASE_URL;
if(!adminUrl)throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL admin database, or run bun run test:demo');
const target=new URL(adminUrl);
if(!['localhost','127.0.0.1','postgres'].includes(target.hostname))throw new Error('Test admin must be an explicit local/CI PostgreSQL service');
const name=`ledgercatch_test_${randomBytes(8).toString('hex')}`;
const admin=new pg.Pool({connectionString:adminUrl});target.pathname='/'+name;
const pool=new pg.Pool({connectionString:target.toString()});
try {
 await admin.query(`CREATE DATABASE "${name}"`);
 await migrate(drizzle(pool),{migrationsFolder:'drizzle'});
 const env={PATH:process.env.PATH,HOME:process.env.HOME,DATABASE_URL:target.toString(),PGBOSS_DATABASE_URL:target.toString(),BETTER_AUTH_SECRET:randomBytes(32).toString('hex'),APP_BASE_URL:'http://127.0.0.1:4300',NODE_ENV:'test',LEDGERCATCH_DEMO:'true',OTEL_SDK_DISABLED:'false'};
 let r=spawnSync('bun',['scripts/jobs-migrate.ts'],{env,stdio:'inherit'});if(r.status!==0)throw new Error('Jobs migration failed');
 r=spawnSync('bun',['x','vitest','run','--maxWorkers=2','--no-file-parallelism',...process.argv.slice(2)],{env,stdio:'inherit'});process.exitCode=r.status??1;
} finally {await pool.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();}
