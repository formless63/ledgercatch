import { chromium, expect } from '@playwright/test';
import { mkdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
if(process.env.LEDGERCATCH_DEMO!=='true'||process.env.APP_BASE_URL!=='http://127.0.0.1:4300')throw new Error('Screenshots require the local synthetic demo');
const base=process.env.APP_BASE_URL;
const fixture=JSON.parse(readFileSync('.demo/fixture.json','utf8'));
mkdirSync('docs/images',{recursive:true});
const browser=await chromium.launch({headless:true});
try {
 const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'UTC',colorScheme:'dark',reducedMotion:'reduce'});
 // Block any unexpected external request in the screenshot browser.
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 const page=await context.newPage();
 await page.goto(base);
 const beforeMail=await (await fetch('http://127.0.0.1:58025/api/v1/messages')).json() as {messages:Array<{ID:string}>};
 const oldMail=new Set(beforeMail.messages.map(m=>m.ID));
 const signIn=await context.request.post(base+'/api/auth/sign-in/magic-link',{headers:{Origin:base},data:{email:'demo@example.test',callbackURL:'/app'}});
 if(!signIn.ok())throw new Error(`Normal magic-link request failed: ${signIn.status()}`);
 let link='';
 for(let i=0;i<40&&!link;i++){
  const list=await (await fetch('http://127.0.0.1:58025/api/v1/messages')).json() as {messages:Array<{ID:string}>};
  for(const message of list.messages.filter(m=>!oldMail.has(m.ID)).slice(0,5)){
   const detail=await (await fetch(`http://127.0.0.1:58025/api/v1/message/${message.ID}`)).json() as {Text:string};
   const match=detail.Text.match(/http:\/\/127\.0\.0\.1:4300\/api\/auth\/magic-link\/verify[^\s<>]+/);
   if(match){link=match[0];break;}
  }
  if(!link)await new Promise(r=>setTimeout(r,250));
 }
 if(!link)throw new Error('Mailpit did not receive a sign-in link');
 const verified=await context.request.get(link);if(!verified.ok())throw new Error('Normal magic-link verification failed');
 await page.goto(base+'/app');await page.waitForURL('**/app**');
 await page.clock.setFixedTime(new Date('2026-10-01T12:00:00Z'));
 const routes=[['inbox','/app'],['order-detail',`/app/orders/${fixture.orderId}`],['reimbursements','/app/reimbursements'],['insights','/app/insights'],['reconciliation','/app/reconcile']] as const;
 for(const [name,path] of routes){
  await page.goto(base+path);await page.waitForTimeout(1200);await expect(page.getByText('Loading…',{exact:true})).toHaveCount(0,{timeout:30000});await expect(page.locator('.animate-pulse.bg-muted')).toHaveCount(0,{timeout:30000});
  await expect(page.locator('body')).not.toContainText('Something went wrong');
  await page.evaluate(()=>document.fonts.ready);
  if(name==='reconciliation')await expect(page.getByText('SYNTHETIC EXAMPLE SUPPLIES',{exact:false}).first()).toBeVisible({timeout:30000});
  if(name==='inbox')await expect(page.getByText('DEMO-0001',{exact:false}).first()).toBeVisible({timeout:30000});
  await page.screenshot({path:`docs/images/${name}.png`,fullPage:true,animations:'disabled'});
 }
 // Exercise a real authenticated mutation and its undo before mobile capture.
 await page.goto(base+'/app');
 const purchase=page.getByText('DEMO-0001',{exact:false}).first();
 await expect(purchase).toBeVisible({timeout:30000});await purchase.click();
 await page.keyboard.press('e');
 await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
 await expect(page.getByText('DEMO-0001',{exact:false})).toHaveCount(0,{timeout:30000});
 await page.getByRole('button',{name:'Undo',exact:true}).click();
 await expect(page.getByText('DEMO-0001',{exact:false}).first()).toBeVisible({timeout:30000});
 await page.setViewportSize({width:390,height:844});
 await page.goto(base+'/app/capture');await page.waitForTimeout(1200);await expect(page.getByText('Loading…',{exact:true})).toHaveCount(0,{timeout:30000});await expect(page.locator('.animate-pulse.bg-muted')).toHaveCount(0,{timeout:30000});
 await expect(page.locator('.animate-spin')).toHaveCount(0,{timeout:30000});
 await page.screenshot({path:'docs/images/mobile-capture.png',fullPage:true,animations:'disabled'});
 await context.close();
} finally {await browser.close();}
// Actual installed MV3 extension, with an empty fresh browser profile and no API key.
const profile=mkdtempSync(join(tmpdir(),'ledgercatch-extension-demo-'));
const extension=resolve('extension/.output/chrome-mv3');
try {
 const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1100,height:900}});
 try {
  const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
  const page=await context.newPage();
  for(const name of ['popup','options']){await page.setViewportSize(name==='popup'?{width:420,height:650}:{width:1100,height:900});await page.goto(`chrome-extension://${id}/${name}.html`);await page.waitForLoadState('networkidle');await page.screenshot({path:`docs/images/extension-${name}.png`,fullPage:true});}
 }finally{await context.close();}
}finally{rmSync(profile,{recursive:true,force:true});}
console.log('Eight screenshots captured from synthetic app and actual MV3 extension.');
