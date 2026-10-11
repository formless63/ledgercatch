import {createHmac,randomUUID} from 'node:crypto';
import {expect,test} from '@playwright/test';
import pg from 'pg';
test('Ops requires human operator session on API and SSR; refresh and signout are safe',async({page,context,request,baseURL})=>{
 test.skip(!process.env.E2E_DATABASE_URL, "Requires an explicitly isolated E2E database");
 const pool=new pg.Pool({connectionString:process.env.E2E_DATABASE_URL});
 const operator='ops-e2e-operator';const ordinary=`ops-e2e-${randomUUID()}`;
 let sessionCookie='';let apiKeyId:string|undefined;
 const secret=process.env.BETTER_AUTH_SECRET ?? 'development-only-secret-change-me-now';
 async function login(id:string){
  const token=randomUUID();await pool.query('INSERT INTO "session" (id,user_id,token,expires_at,created_at,updated_at) VALUES ($1,$2,$3,now()+interval \'1 hour\',now(),now())',[randomUUID(),id,token]);
  const value=encodeURIComponent(`${token}.${createHmac('sha256',secret).update(token).digest('base64')}`);
  sessionCookie=`${process.env.E2E_BASE_URL ? '__Secure-' : ''}better-auth.session_token=${value}`;
  await context.clearCookies();await context.addCookies([{name:'better-auth.session_token',value,domain:new URL(baseURL as string).hostname,path:'/',httpOnly:true,sameSite:'Lax'},{name:'__Secure-better-auth.session_token',value,domain:new URL(baseURL as string).hostname,path:'/',httpOnly:true,sameSite:'Lax',secure:true}]);
 }
 try{
  for(const id of [operator,ordinary])await pool.query('INSERT INTO "user" (id,name,email,email_verified,created_at,updated_at) VALUES ($1,$2,$3,true,now(),now())',[id,'Ops fixture',`${id}@example.test`]);
  const denied=await request.get('/api/ops/summary');expect(denied.status()).toBe(401);expect(await denied.json()).toEqual({code:'unauthenticated',message:'Authentication is required.',retryable:false});
  expect(denied.headers()['cache-control']).toBe('private, no-store');expect(denied.headers().vary).toContain('Cookie');
  expect((await request.get('/api/ops/summary',{headers:{'x-api-key':'fixture-nonhuman','x-user-id':operator,'x-organization-role':'owner'}})).status()).toBe(401);
  const anonymousPrefetch=await request.get('/admin/ops',{headers:{purpose:'prefetch'},maxRedirects:0});expect(anonymousPrefetch.status()).toBeGreaterThanOrEqual(300);expect(anonymousPrefetch.status()).toBeLessThan(400);expect(await anonymousPrefetch.text()).not.toContain('Jobs cached');
  await login(ordinary);const forbiddenPrefetch=await context.request.get('/admin/ops',{headers:{cookie:sessionCookie,purpose:'prefetch'}});expect(await forbiddenPrefetch.text()).toContain('Operational access is denied.');expect(await forbiddenPrefetch.text()).not.toContain('Jobs cached');expect((await context.request.get('/api/ops/summary',{headers:{cookie:sessionCookie}})).status()).toBe(403);
  await page.goto('/admin/ops');await expect(page.getByRole('alert')).toHaveText('Operational access is denied.');expect(await page.content()).not.toContain('queued');
  await login(operator);const response=await context.request.get('/api/ops/summary',{headers:{cookie:sessionCookie}});expect(response.status()).toBe(200);
  const created=await context.request.post('/api/auth/api-key/create',{headers:{cookie:sessionCookie,origin:baseURL as string},data:{name:'Ops boundary fixture'}});expect(created.status()).toBe(200);const machine=await created.json();apiKeyId=machine.id;expect((await request.get('/api/ops/summary',{headers:{'x-api-key':machine.key}})).status()).toBe(401);
  const summary=await response.json();expect(summary.adapters.length).toBeGreaterThan(0);expect(JSON.stringify(summary)).not.toContain(secret);expect(JSON.stringify(summary)).not.toContain('@example.test');
  await page.goto('/admin/ops');await expect(page.getByRole('heading',{name:'Operational overview'})).toBeVisible();await expect(page.getByText('Last checked:',{exact:false})).toBeVisible();
  async function delayedRefresh(action:'navigate'|'signout'){
   let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let captured:()=>void=()=>{};const ready=new Promise<void>(resolve=>{captured=resolve;});let finished:()=>void=()=>{};const complete=new Promise<void>(resolve=>{finished=resolve;});let requests=0;
   const pattern='**/_serverFn/**';
   await page.route(pattern,async route=>{requests++;const response=await route.fetch();captured();await gate;try{await route.fulfill({response});}catch{}finally{finished();}});
   try{
    await page.getByRole('button',{name:'Refresh',exact:true}).dblclick();await ready;expect(requests).toBe(1);await expect(page.getByRole('button',{name:'Refreshing…',exact:true})).toBeDisabled();
    if(action==='navigate')await page.getByRole('link',{name:'Home',exact:true}).click();else await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await expect(page).toHaveURL(/\/$|\/?redirect=/);release();await complete;await expect(page.getByRole('heading',{name:'Operational overview'})).toHaveCount(0);expect(await page.content()).not.toContain('Jobs cached');
   }finally{release();await page.unroute(pattern);}
  }
  await delayedRefresh('navigate');await page.goto('/admin/ops');await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
  await context.clearCookies();await page.getByRole('button',{name:'Refresh',exact:true}).click();await expect(page.getByRole('alert')).toHaveText('Authentication is required.');expect(await page.content()).not.toContain('Jobs cached');
  await login(operator);await page.goto('/admin/ops');await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeEnabled();await delayedRefresh('signout');expect((await context.request.get('/api/ops/summary')).status()).toBe(401);
  await page.setViewportSize({width:375,height:700});await page.goto('/admin/ops');await expect(page).toHaveURL(/\/$|\/?redirect=/);
 }finally{if(apiKeyId)await pool.query('DELETE FROM apikey WHERE id=$1',[apiKeyId]);await pool.query('DELETE FROM "session" WHERE user_id = ANY($1)',[[operator,ordinary]]);await pool.query('DELETE FROM "user" WHERE id = ANY($1)',[[operator,ordinary]]);await pool.end();}
});
