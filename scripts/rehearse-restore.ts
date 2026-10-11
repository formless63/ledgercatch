/** Synthetic-only backup/restore rehearsal; never accepts deployment configuration. */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { S3Client,ListObjectsV2Command,GetObjectCommand,PutObjectCommand,CreateBucketCommand,DeleteObjectsCommand,DeleteBucketCommand } from '@aws-sdk/client-s3';
const url=new URL(process.env.DATABASE_URL??'');
if(process.env.LEDGERCATCH_DEMO!=='true'||url.hostname!=='127.0.0.1'||url.port!=='55432'||url.pathname!=='/ledgercatch_demo'||process.env.STORAGE_ENDPOINT!=='http://127.0.0.1:59000'||process.env.STORAGE_BUCKET!=='ledgercatch-demo')throw new Error('Only the explicitly designated synthetic demo may be rehearsed');
const name='ledgercatch_restore_'+randomBytes(6).toString('hex');const bucket=name.replaceAll('_','-');
const admin=new pg.Pool({connectionString:url.toString()});const dest=new URL(url);dest.pathname='/'+name;const pool=new pg.Pool({connectionString:dest.toString()});
const s3=new S3Client({endpoint:process.env.STORAGE_ENDPOINT,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:process.env.STORAGE_ACCESS_KEY_ID as string,secretAccessKey:process.env.STORAGE_SECRET_ACCESS_KEY as string}});
const copied:string[]=[];
const tables=['user','entities','categories','orders','order_items','order_captures','documents','allocations','claims','statement_imports','statement_transactions','transaction_matches','entity_shares','connections'];
async function fingerprint(client:pg.Pool){const out:Record<string,unknown>={};for(const table of tables){const {rows}=await client.query(`SELECT row_to_json(t)::text AS row FROM "${table}" t ORDER BY row_to_json(t)::text`);out[table]={count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};}const history=await client.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id');out.migrations=history.rows;return out;}
try {
 const dump=spawnSync('docker',['compose','--env-file','.demo/env','-f','compose.demo.yaml','exec','-T','postgres','pg_dump','-U','demo','-d','ledgercatch_demo','-Fc'],{maxBuffer:64*1024*1024});if(dump.status)throw new Error('Synthetic dump failed');
 mkdirSync('.demo',{recursive:true});writeFileSync('.demo/synthetic-rehearsal.dump',dump.stdout,{mode:0o600});
 const before=await fingerprint(admin);
 await admin.query(`CREATE DATABASE "${name}"`);
 const restored=spawnSync('docker',['compose','--env-file','.demo/env','-f','compose.demo.yaml','exec','-T','postgres','pg_restore','-U','demo','-d',name,'--exit-on-error'],{input:dump.stdout,maxBuffer:1024*1024});if(restored.status)throw new Error('Synthetic restore failed');
 await migrate(drizzle(pool),{migrationsFolder:'drizzle'});
 const after=await fingerprint(pool);if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Identity/data/history fingerprint changed');
 await s3.send(new CreateBucketCommand({Bucket:bucket}));
 const listed=await s3.send(new ListObjectsV2Command({Bucket:'ledgercatch-demo'}));if(listed.IsTruncated)throw new Error('Unexpected unbounded demo objects');
 for(const object of listed.Contents??[]){if(!object.Key)continue;const source=await s3.send(new GetObjectCommand({Bucket:'ledgercatch-demo',Key:object.Key}));const bytes=await source.Body?.transformToByteArray();if(!bytes)throw new Error('Missing source bytes');await s3.send(new PutObjectCommand({Bucket:bucket,Key:object.Key,Body:bytes,ContentType:source.ContentType,Metadata:source.Metadata}));copied.push(object.Key);const target=await s3.send(new GetObjectCommand({Bucket:bucket,Key:object.Key}));const actual=await target.Body?.transformToByteArray();if(!actual||!Buffer.from(bytes).equals(Buffer.from(actual)))throw new Error('Object restore mismatch');}
 mkdirSync('artifacts',{recursive:true});writeFileSync('artifacts/restore-verification.json',JSON.stringify({synthetic:true,tables:before,objects:copied.length,objectKeysAndBytesPreserved:true,migrationsUnchanged:true,verifiedAt:new Date().toISOString()},null,2));
 console.log(`Synthetic restore verified: ${tables.length} table fingerprints and ${copied.length} document objects; migrations unchanged.`);
}finally{await pool.end();await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();if(copied.length)await s3.send(new DeleteObjectsCommand({Bucket:bucket,Delete:{Objects:copied.map(Key=>({Key}))}}));await s3.send(new DeleteBucketCommand({Bucket:bucket})).catch(()=>{});s3.destroy();}
