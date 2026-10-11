import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
const file='.demo/env';
const action=process.argv[2] ?? 'setup';
if(action==='setup') {
 mkdirSync('.demo',{recursive:true});
 if(!existsSync(file)) {
  const secret=()=>randomBytes(32).toString('hex');const password=secret();
  const vars={LEDGERCATCH_DEMO:'true',DEMO_DB_PASSWORD:password,DATABASE_URL:`postgresql://demo:${password}@127.0.0.1:55432/ledgercatch_demo`,BETTER_AUTH_SECRET:secret(),APP_ENCRYPTION_KEY:secret(),APP_BASE_URL:'http://127.0.0.1:4300',APP_NAME:'LedgerCatch',VITE_APP_NAME:'LedgerCatch',MAGIC_LINK_ENABLED:'true',ALLOWED_SIGNUP_EMAILS:'demo@example.test,bookkeeper@example.test,other@example.test',SMTP_HOST:'127.0.0.1',SMTP_PORT:'51025',SMTP_SECURITY:'opportunistic',EMAIL_FROM_ADDRESS:'hello@example.test',STORAGE_ENDPOINT:'http://127.0.0.1:59000',STORAGE_REGION:'us-east-1',STORAGE_BUCKET:'ledgercatch-demo',STORAGE_ACCESS_KEY_ID:secret(),STORAGE_SECRET_ACCESS_KEY:secret(),STORAGE_FORCE_PATH_STYLE:'true',CUSTOM_HTTP_ENDPOINTS:JSON.stringify([{origin:'http://127.0.0.1:59090',addresses:['127.0.0.1']}]),OTEL_SDK_DISABLED:'true',OCR_ALLOW_DOWNLOAD:'false'};
  writeFileSync(file,Object.entries(vars).map(([k,v])=>`${k}='${v}'`).join('\n')+'\n',{mode:0o600});
 }
 const r=spawnSync('docker',['compose','--env-file',file,'-f','compose.demo.yaml','up','-d','--wait'],{stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);
}
if(!existsSync(file))throw new Error('Run bun run demo:setup first');
// Never inherit service credentials/endpoints from an operator shell.
const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,VITE_DEMO:"true",...parseEnv(readFileSync(file,'utf8'))};
function run(args:string[]){const r=spawnSync('bun',args,{env,stdio:'inherit'});if(r.status!==0)process.exit(r.status??1);}
if(action==='setup'){run(['run','db:migrate']);run(['run','jobs:migrate']);run(['scripts/storage-init.ts']);run(['scripts/demo-seed.ts']);}
else if(action==='seed')run(['scripts/demo-seed.ts']);
else if(action==='restore')run(['scripts/rehearse-restore.ts']);
else if(action==='test'){Object.assign(env,{TEST_DATABASE_URL:env.DATABASE_URL});run(['scripts/test-isolated.ts',...process.argv.slice(3)]);}
else if(action==='screenshots')run(['scripts/demo-screenshots.ts']);
else if(action==='start'){
 const children=[['run','dev','--port','4300'],['scripts/jobs-worker.ts'],['demo/provider.ts']].map(args=>spawn('bun',args,{env,stdio:'inherit',detached:true}));
 const stop=()=>{for(const c of children)if(c.pid)try{process.kill(-c.pid,'SIGTERM');}catch{}};process.on('SIGINT',stop);process.on('SIGTERM',stop);
 for(const c of children)c.on('exit',code=>{stop();process.exitCode=code??1;});
}else if(action!=='setup')throw new Error('Use setup, seed, start or screenshots');
