import { createHmac, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import pg from 'pg';
test('File UI native session routes enforce owner scope and CSRF in dev and production', async ({ context, request, baseURL }) => {
 test.skip(!process.env.E2E_DATABASE_URL, "Requires an explicitly isolated E2E database");
 const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }); const owner = `file-ui-${randomUUID()}`; const foreign = `file-ui-${randomUUID()}`; const token = randomUUID(); const id = randomUUID(); const foreignId = randomUUID();
 try {
  expect((await request.get('/api/files/list')).status()).toBe(401);
  for (const person of [owner, foreign]) await pool.query('insert into "user"(id,name,email) values($1,$1,$1||\'@example.test\')', [person]);
  await pool.query('insert into session(id,user_id,token,expires_at) values($1,$2,$3,now()+interval \'1 hour\')', [randomUUID(), owner, token]);
  for (const [fileId, person, name] of [[id, owner, 'Visible receipt.txt'], [foreignId, foreign, 'Private foreign receipt.txt']]) await pool.query('insert into file_ui_files(id,owner,object_key,idempotency_key,digest,fingerprint,name,type,size,state,revision,writer_stopped,created_at) values($1,$2,$3,$4,$5,$5,$6,\'text/plain\',5,\'removed\',0,true,1)', [fileId, person, `file-ui/${randomUUID()}`, randomUUID(), 'a'.repeat(64), name]);
  const secret = process.env.BETTER_AUTH_SECRET; expect(secret).toBeTruthy(); const encoded = encodeURIComponent(`${token}.${createHmac('sha256', secret!).update(token).digest('base64')}`);
  const cookies = `better-auth.session_token=${encoded}; __Secure-better-auth.session_token=${encoded}`; const headers = { cookie: cookies, origin: baseURL!, 'x-file-ui': '1' };
  await context.addCookies([{ name: 'better-auth.session_token', value: encoded, domain: new URL(baseURL!).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }, { name: '__Secure-better-auth.session_token', value: encoded, domain: new URL(baseURL!).hostname, path: '/', httpOnly: true, sameSite: 'Lax', secure: true }]);
  const list = await request.get('/api/files/list', { headers }); expect(list.status()).toBe(200); expect((await list.json()).map((r: { id: string }) => r.id)).toEqual([id]); expect(await list.text()).not.toContain('object_key');
  expect((await request.post(`/api/files/remove?id=${id}`, { headers: { cookie: cookies } })).status()).toBe(403);
  expect((await request.post(`/api/files/remove?id=${id}`, { headers: { ...headers, origin: 'https://evil.example' } })).status()).toBe(403);
  expect((await request.post(`/api/files/remove?id=${foreignId}`, { headers })).status()).toBe(404);
  expect((await request.get(`/api/files/download?id=${foreignId}`, { headers })).status()).toBe(404);
  expect((await request.post(`/api/files/remove?id=${id}`, { headers })).status()).toBe(200);
 } finally { await pool.query('delete from file_ui_files where owner=any($1)', [[owner, foreign]]); await pool.query('delete from session where user_id=any($1)', [[owner, foreign]]); await pool.query('delete from "user" where id=any($1)', [[owner, foreign]]); await pool.end(); }
});
