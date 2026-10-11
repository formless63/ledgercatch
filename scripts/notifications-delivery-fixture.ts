import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import { user } from "../src/db/schema";
import { createJobsBoss } from "../src/integrations/jobs/boss.server";
import { getJobsClient, stopJobsClient } from "../src/integrations/jobs/client.server";
import { createNotificationInTransaction } from "../src/integrations/notifications/transaction.server";
import { notifications } from "../src/integrations/notifications/schema";
const suffix = randomUUID().replaceAll("-",""), recipientId = `delivery-${suffix}`, schema = `notif_delivery_${suffix}`;
const containers: string[] = []; let worker: ChildProcess | undefined;
const docker = (...args: string[]) => execFileSync("docker",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const port = (name: string, internal: number) => docker("port",name,`${internal}/tcp`).split(":").at(-1);
async function ready(url: string) { for(let i=0;i<100;i++) { try{if((await fetch(url,{signal:AbortSignal.timeout(500)})).ok)return;}catch{}await new Promise(r=>setTimeout(r,100)); }throw new Error("Disposable delivery service did not become healthy"); }
try {
  const mailpit = `notification-mailpit-${suffix}`, ntfy = `notification-ntfy-${suffix}`; containers.push(mailpit,ntfy);
  docker("run","-d","--name",mailpit,"-p","127.0.0.1::1025","-p","127.0.0.1::8025","-e","MP_MAX_MESSAGES=100","axllent/mailpit:v1.31.3");
  docker("run","-d","--name",ntfy,"-p","127.0.0.1::80","binwiederhier/ntfy:v2.28.0","serve","--listen-http",":80","--cache-file","/tmp/ntfy.db");
  const mailpitUrl = `http://127.0.0.1:${port(mailpit,8025)}`, ntfyUrl=`http://127.0.0.1:${port(ntfy,80)}`;
  await Promise.all([ready(`${mailpitUrl}/api/v1/messages`),ready(`${ntfyUrl}/v1/health`)]);
  process.env.PGBOSS_SCHEMA=schema; process.env.PGBOSS_DATABASE_URL=process.env.DATABASE_URL; process.env.PGBOSS_USE_LISTEN_NOTIFY="false";
  const migration = createJobsBoss("migration"); await migration.start(); await migration.stop();
  await db.insert(user).values({id:recipientId,name:"Delivery fixture",email:`initial-${suffix}@example.test`});
  const queued = await db.transaction(tx=>createNotificationInTransaction(tx,{recipientId,type:"fixture.delivery",title:"Current delivery",body:"Initially queued body"},["email","ntfy"]));
  // Resolve current recipient/content AFTER enqueue, never from a copied Jobs payload.
  await db.update(user).set({email:`current-${suffix}@example.test`}).where(eq(user.id,recipientId));
  await db.update(notifications).set({body:"Reloaded authoritative body"}).where(eq(notifications.id,queued.notification.id));
  assert.ok(process.env.NOTIFICATION_WORKER_SCRIPT,"Compile the actual production Jobs worker entrypoint for Node before this fixture");
  worker=spawn("node",[process.env.NOTIFICATION_WORKER_SCRIPT],{stdio:["ignore","ignore","inherit"],env:{...process.env,NODE_ENV:"test",SMTP_HOST:"127.0.0.1",SMTP_PORT:port(mailpit,1025),SMTP_SECURITY:"opportunistic",EMAIL_FROM_ADDRESS:"fixture@example.test",NTFY_BASE_URL:ntfyUrl,NTFY_REFERENCE_RECIPIENT_ID:recipientId,NTFY_REFERENCE_TOPIC:"fixture",OTEL_SDK_DISABLED:"true",LOG_LEVEL:"silent"}});
  const boss = await getJobsClient(); const deadline = Date.now()+30000;
  for(;;){const jobs=await Promise.all(queued.jobIds.map(async id=>(await boss.findJobs("notifications.deliver",{id}))[0])); if(jobs.every(job=>job?.state==="completed")){for(const job of jobs)assert.deepEqual(job.output,{outcome:"delivered"});break;} assert.ok(Date.now()<deadline,"Node worker must complete actual SMTP/ntfy attempts"); assert.ok(worker.exitCode===null,"Node worker must stay alive"); await new Promise(r=>setTimeout(r,100));}
  const messages = await (await fetch(`${mailpitUrl}/api/v1/messages`)).json() as {messages:{ID:string;To:{Address:string}[]}[]}; assert.equal(messages.messages.length,1);assert.equal(messages.messages[0].To[0].Address,`current-${suffix}@example.test`);
  const message = await (await fetch(`${mailpitUrl}/api/v1/message/${messages.messages[0].ID}`)).json() as {Text:string};assert.ok(message.Text.includes("Reloaded authoritative body"));
  const events=(await(await fetch(`${ntfyUrl}/fixture/json?poll=1`)).text()).trim().split("\n").map(line=>JSON.parse(line));assert.ok(events.some(event=>event.message==="Reloaded authoritative body"));
  console.info("Actual Node24 production worker: private atomic notification Jobs reload current records/targets and deliver once through existing Email/Mailpit and pinned ntfy");
} finally {
  if(worker?.exitCode===null){worker.kill("SIGTERM");await new Promise<void>(resolve=>{const timer=setTimeout(()=>{worker?.kill("SIGKILL");resolve();},15000);worker?.once("exit",()=>{clearTimeout(timer);resolve();});});}
  await stopJobsClient(); await db.delete(notifications).where(eq(notifications.recipientId,recipientId));await db.delete(user).where(eq(user.id,recipientId));
  assert.ok(/^notif_delivery_[a-f0-9]+$/.test(schema));await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));await db.$client.end();
  for(const name of containers)try{docker("rm","-f",name);}catch{}
}
