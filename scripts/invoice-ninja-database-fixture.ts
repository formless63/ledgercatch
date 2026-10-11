import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as wait } from 'node:timers/promises'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq, sql } from 'drizzle-orm'
import * as pgCore from 'drizzle-orm/pg-core'
import { PgBoss, fromDrizzle } from 'pg-boss'
import { createInvoiceNinja } from '../src/integrations/invoice-ninja/service.server'
import { bindings, invoices, operations, inbox } from '../src/integrations/invoice-ninja/schema'
import type { DraftPolicy } from '../src/integrations/invoice-ninja/schema'
import type { TrustedContext } from '../src/integrations/invoice-ninja/validation'
import { assertTransactionalJobsDatabase } from '../src/integrations/jobs/boss.server'
assert.ok(Object.keys(pgCore).length)
process.env.NODE_ENV = 'test'
const adminUrl = process.env.DATABASE_URL
assert(adminUrl, 'Explicit disposable PostgreSQL URL required')
const name = `invoice_fixture_${randomUUID().replaceAll('-', '')}`
const admin = new pg.Pool({ connectionString: adminUrl })
await admin.query(`create database "${name}"`)
const url = new URL(adminUrl); url.pathname = `/${name}`
process.env.DATABASE_URL = url.href; process.env.PGBOSS_DATABASE_URL = url.href
const pool = new pg.Pool({ connectionString: url.href, max: 6 }), db = drizzle(pool)
const boss = new PgBoss({ connectionString: url.href, schema: 'invoice_fixture_jobs', migrate: true, schedule: false, supervise: false })
boss.on('error', () => {})
let gets = 0, posts = 0, status = '1', amount = '25', responseMode = 'ok', holdNext = false
let entered: (() => void) | undefined, release: (() => void) | undefined
const bodies: string[] = []
const server = createServer(async (request, response) => {
  assert.equal(request.headers['x-api-token'], 'disposable-invoice-token')
  let body = ''; for await (const part of request) body += part
  if (request.method === 'POST') { posts++; bodies.push(body) } else gets++
  if (request.method === 'POST' && responseMode === 'reject') { response.writeHead(422); response.end('{"message":"PRIVATE_REJECTION"}'); return }
  if (request.method === 'POST' && responseMode === 'disconnect') { request.socket.destroy(); return }
  if (responseMode === 'missing') { response.writeHead(404); response.end('{}'); return }
  const isClient = request.url?.includes('/clients/')
  const payload = JSON.stringify({ data: isClient ? { id: 'client-owned', email: 'PRIVATE_CONTACT' } : { id: request.method === 'POST' ? 'invoice-owned' : request.url!.split('/').at(-1)!, client_id: 'client-owned', status_id: status, number: 'FIXTURE-1', amount, balance: '0', last_sent_date: '', auto_bill_enabled: false, is_deleted: false, updated_at: 1790907000, private_notes: 'PRIVATE_NOTES' } })
  if (holdNext && request.method === 'GET') { holdNext = false; entered?.(); await new Promise<void>(resolve => { release = resolve }) }
  response.setHeader('content-type', 'application/json'); response.end(payload)
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const address = server.address(); assert(address && typeof address === 'object')
const baseUrl = `http://127.0.0.1:${address.port}`
const owner: TrustedContext = { actorUserId: 'owner', scope: { kind: 'user', id: 'owner' } }
const foreign: TrustedContext = { actorUserId: 'other', scope: { kind: 'user', id: 'other' } }
const policy: DraftPolicy = { currencyId: '1', currency: 'USD', configurationIdentity: 'disposable-zero-tax-unsent', verifiedPin: '382020072bc79e8c7ede49f7e9ce91b0aeb1a051', numericStrings: true, unsent: true, zeroTax: true, zeroDiscount: true }
let authorized = true, enqueueFails = false
const service = createInvoiceNinja({ database: db,
  authorizeScope: async (actor, scope) => authorized && actor === scope.id,
  authorizeBoundResource: async (ctx, binding) => authorized && ctx.actorUserId === binding.scopeId,
  authorizeReconciliation: async () => authorized,
  resolveConnection: async () => ({ baseUrl, apiToken: 'disposable-invoice-token' }),
  resolveDraftPolicy: async () => policy, resolveCurrency: () => 'USD',
  webhookSecrets: async () => ({ current: 'disposable-webhook-secret-32-chars-long' }),
  enqueue: async (tx, kind, id) => { assertTransactionalJobsDatabase(); if (enqueueFails) throw new Error('fixture enqueue failure'); await boss.send(`invoice-ninja.${kind}`, kind === 'operation' ? { operationId: id } : { inboxId: id }, { db: fromDrizzle(tx, sql) }) },
})
const operationId = (value: { operationId: string } | { id: string }) => 'operationId' in value ? value.operationId : value.id
const receipt = (suffix: string) => new Request(`${baseUrl}/fixture`, { method: 'POST', headers: { 'X-Invoice-Ninja-Webhook-Secret': 'disposable-webhook-secret-32-chars-long' }, body: JSON.stringify({ id: 'invoice-owned', note: `PRIVATE_${suffix}` }) })
try {
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
  const start = journal.entries.findIndex((entry: { tag: string }) => entry.tag === '0009_invoice_ninja_v1')
  let previousHistory: unknown[] = []
  if (start > 0) {
    const directory = await mkdtemp(`${tmpdir()}/invoice-upgrade-`)
    try {
      await mkdir(`${directory}/meta`)
      await writeFile(`${directory}/meta/_journal.json`, JSON.stringify({ ...journal, entries: journal.entries.slice(0, start) }))
      for (const entry of journal.entries.slice(0, start)) await copyFile(`drizzle/${entry.tag}.sql`, `${directory}/${entry.tag}.sql`)
      await migrate(db, { migrationsFolder: directory })
      await pool.query("insert into \"user\"(id,name,email,email_verified,created_at,updated_at) values('invoice-upgrade-owner','Upgrade marker','upgrade@example.test',true,now(),now())")
      await pool.query("insert into project(id,name,owner_id,created_at,updated_at) values('invoice-upgrade-project','Retained main data','invoice-upgrade-owner',now(),now())")
      previousHistory = (await pool.query('select * from drizzle.__drizzle_migrations order by id')).rows
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
  await migrate(db, { migrationsFolder: 'drizzle' }); await migrate(db, { migrationsFolder: 'drizzle' })
  if (start > 0) {
    assert.equal((await pool.query("select name from project where id='invoice-upgrade-project'")).rows[0].name, 'Retained main data')
    assert.deepEqual((await pool.query('select * from drizzle.__drizzle_migrations order by id')).rows.slice(0, previousHistory.length), previousHistory)
  }
  await boss.start(); await boss.createQueue('invoice-ninja.operation'); await boss.createQueue('invoice-ninja.receipt')
  const client = await db.transaction(tx => service.createBinding(tx, owner, { localResourceId: 'client', connectionId: 'default', resourceKind: 'client', remoteId: 'client-owned' }))
  const input = { clientBindingId: client, idempotencyKey: 'first', invoiceDate: '2026-10-02', numbering: { mode: 'explicit', number: 'FIXTURE-1' }, lines: [{ description: 'Disposable fixture', quantity: '1.2500', unitCost: '20.0000' }] }
  await assert.rejects(service.requestDraftInvoice(foreign, input))
  await assert.rejects(db.transaction(async tx => { await service.requestDraftInvoiceInTransaction(tx, owner, input); throw new Error('rollback') }))
  assert.equal((await db.select().from(operations)).length, 0)
  assert.equal((await pool.query('select count(*)::int n from invoice_fixture_jobs.job')).rows[0].n, 0)
  enqueueFails = true; await assert.rejects(service.requestDraftInvoice(owner, input)); enqueueFails = false
  assert.equal((await db.select().from(operations)).length, 0)
  const draft = await service.requestDraftInvoice(owner, input), id = operationId(draft)
  assert.equal(operationId(await service.requestDraftInvoice(owner, { ...input, lines: [{ description: 'Disposable fixture', quantity: '1.25', unitCost: '20' }] })), id)
  await assert.rejects(service.requestDraftInvoice(owner, { ...input, lines: [{ description: 'changed', quantity: '1', unitCost: '20' }] }), { code: 'conflict' })
  assert.deepEqual(await service.runOperation(id), { status: 'processed' })
  assert.equal(posts, 1); assert.equal(JSON.parse(bodies[0]!).line_items[0].cost, '20')
  const completed = await service.getOperation(owner, { operationId: id }); assert.equal(completed.status, 'succeeded'); assert(completed.bindingId)
  const projected = await service.getInvoice(owner, { bindingId: completed.bindingId })
  assert.equal(projected.currency, 'USD'); assert.equal(projected.amount, '25'); assert.equal(projected.balance, '0')
  assert(!JSON.stringify(projected).includes('PRIVATE'))
  await assert.rejects(service.getInvoice(foreign, { bindingId: completed.bindingId }), { code: 'not_found' })
  assert.equal((await service.listInvoices(foreign)).items.length, 0)
  const queued = await service.requestClientReconciliation(owner, { clientBindingId: client })
  await service.cancelOperation(owner, { operationId: operationId(queued) }); const beforeCancel = gets
  assert.deepEqual(await service.runOperation(operationId(queued)), { status: 'ignored' }); assert.equal(gets, beforeCancel)
  responseMode = 'reject'; const rejected = operationId(await service.requestDraftInvoice(owner, { ...input, idempotencyKey: 'reject' }))
  await service.runOperation(rejected); assert.equal((await service.getOperation(owner, { operationId: rejected })).status, 'failed')
  responseMode = 'disconnect'; const ambiguous = operationId(await service.requestDraftInvoice(owner, { ...input, idempotencyKey: 'uncertain' }))
  await service.runOperation(ambiguous); assert.equal((await service.getOperation(owner, { operationId: ambiguous })).status, 'reconciliation_required')
  const beforeDuplicate = posts; await service.runOperation(ambiguous); assert.equal(posts, beforeDuplicate)
  responseMode = 'ok'
  await assert.rejects(service.resolveAmbiguousDraft(foreign, { operationId: ambiguous }, { mode: 'confirm-not-created' }), { code: 'not_found' })
  await service.resolveAmbiguousDraft(owner, { operationId: ambiguous }, { mode: 'confirm-not-created' })
  assert.equal((await service.getOperation(owner, { operationId: ambiguous })).status, 'failed')
  responseMode = 'disconnect'
  const attach = operationId(await service.requestDraftInvoice(owner, { ...input, idempotencyKey: 'attach' }))
  await service.runOperation(attach); responseMode = 'ok'; const priorAttachPosts = posts
  await service.resolveAmbiguousDraft(owner, { operationId: attach }, { mode: 'attach-existing', remoteId: 'invoice-recovered' })
  assert.equal(posts, priorAttachPosts, 'Operator resolution performs GET only and never retries POST')
  const resolved = await service.getOperation(owner, { operationId: attach }); assert.equal(resolved.status, 'succeeded')
  assert.equal((await service.getInvoice(owner, { bindingId: resolved.bindingId! })).remoteId, 'invoice-recovered')
  const hint = receipt('one'); await service.receive(hint, 'default', 'invoice-updated'); await service.receive(receipt('one'), 'default', 'invoice-updated')
  let receipts = await db.select().from(inbox); assert.equal(receipts.length, 1)
  status = '4'; await service.runReceipt(receipts[0]!.id)
  assert.equal((await service.getInvoice(owner, { bindingId: completed.bindingId })).status, 'paid')
  assert.equal((await pool.query("select count(*)::int n from invoice_fixture_jobs.job where name='invoice-ninja.receipt'")).rows[0].n, 1)
  await service.receive(receipt('denied'), 'default', 'invoice-updated'); receipts = await db.select().from(inbox).where(eq(inbox.state, 'received'))
  authorized = false; const beforeDenied = gets; await service.runReceipt(receipts[0]!.id); assert.equal(gets, beforeDenied); authorized = true
  // Expiry recovery must fence the late authoritative response from a prior attempt.
  status = '2'; amount = '12'; holdNext = true
  const ready = new Promise<void>(resolve => { entered = resolve })
  const refresh = operationId(await service.requestInvoiceReconciliation(owner, { invoiceBindingId: completed.bindingId }))
  const late = service.runOperation(refresh); await ready
  await db.update(operations).set({ leaseUntil: new Date(0) }).where(eq(operations.id, refresh))
  await db.update(bindings).set({ leaseUntil: new Date(0) }).where(eq(bindings.id, completed.bindingId))
  await db.transaction(tx => service.recover(tx))
  release!(); await late
  assert.equal((await service.getOperation(owner, { operationId: refresh })).status, 'queued', 'Late expired attempt cannot fail an explicitly recovered queued operation')
  status = '4'; amount = '25'; await service.runOperation(refresh)
  assert.equal((await service.getInvoice(owner, { bindingId: completed.bindingId })).status, 'paid')
  assert.equal((await service.getInvoice(owner, { bindingId: completed.bindingId })).amount, '25')
  responseMode = 'missing'; const missing = operationId(await service.requestInvoiceReconciliation(owner, { invoiceBindingId: completed.bindingId })); await service.runOperation(missing)
  const tombstone = await service.getInvoice(owner, { bindingId: completed.bindingId }); assert.equal(tombstone.deleted, true); assert.equal(tombstone.amount, '25')
  const jobs = (await pool.query('select data from invoice_fixture_jobs.job')).rows
  assert(jobs.every(row => Object.keys(row.data).length === 1)); assert(!JSON.stringify(jobs).includes('PRIVATE'))
  await db.transaction(tx => service.retireBinding(tx, owner, { bindingId: completed.bindingId }))
  await assert.rejects(service.getInvoice(owner, { bindingId: completed.bindingId }), { code: 'not_found' })
  assert.equal((await db.select().from(invoices)).length, 2)
  if (process.env.INVOICE_FIXTURE_REMOVE === 'true') {
    const bun = process.env.INVOICE_FIXTURE_BUN; assert(bun)
    const snapshot = async () => (await pool.query(`select
      (select jsonb_agg(to_jsonb(t) order by id) from invoice_ninja_binding t) bindings,
      (select jsonb_agg(to_jsonb(t) order by binding_id) from invoice_ninja_client t) clients,
      (select jsonb_agg(to_jsonb(t) order by binding_id) from invoice_ninja_invoice t) invoices,
      (select jsonb_agg(to_jsonb(t) order by id) from invoice_ninja_operation t) operations,
      (select jsonb_agg(to_jsonb(t) order by id) from invoice_ninja_inbox t) inbox,
      (select jsonb_agg(to_jsonb(t) order by id) from drizzle.__drizzle_migrations t) migrations`)).rows
    const before = await snapshot(); await boss.stop({ graceful: false })
    assert.equal(spawnSync(bun, ['scripts/invoice-ninja-removal-fixture.ts'], { stdio: 'inherit' }).status, 0)
    assert.equal(spawnSync(bun, ['run', 'build'], { stdio: 'inherit' }).status, 0)
    assert.deepEqual(await snapshot(), before)
    assert.equal((await pool.query("select count(*)::int n from pg_namespace where nspname='invoice_fixture_jobs'")).rows[0].n, 1)
  }
  console.info(`Invoice Ninja ${process.versions.bun ? 'Bun' : 'Node'} PostgreSQL/Jobs rollback, scope, exact native-shaped projection, definitive rejection, uncertainty, recovery and retention passed; mocked wire only.`)
}
finally {
  release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  await boss.stop({ graceful: false }); await pool.end()
  for (let n = 0; n < 200 && (await admin.query('select 1 from pg_stat_activity where datname=$1', [name])).rowCount; n++) await wait(10)
  assert.equal((await admin.query('select 1 from pg_stat_activity where datname=$1', [name])).rowCount, 0)
  await admin.query(`drop database "${name}"`); await admin.end()
}
