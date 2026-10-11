import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if(!process.env.VERIFY_IMAGE)throw new Error('Set VERIFY_IMAGE to the locally built image');
const project=`ledgercatch-verify-${process.pid}`;const file=`.demo/${project}.env`;mkdirSync('.demo',{recursive:true});
const secret=()=>randomBytes(32).toString('hex');
const values={APP_IMAGE:process.env.VERIFY_IMAGE,APP_ENV_FILE:file,POSTGRES_PASSWORD:secret(),BETTER_AUTH_SECRET:secret(),APP_ENCRYPTION_KEY:secret(),APP_BASE_URL:'http://127.0.0.1:44300',APP_PORT:'44300',APP_NAME:'LedgerCatch',MAGIC_LINK_ENABLED:'false',STORAGE_BUCKET:'ledgercatch-verify',STORAGE_REGION:'us-east-1',STORAGE_ACCESS_KEY_ID:secret(),STORAGE_SECRET_ACCESS_KEY:secret(),STORAGE_FORCE_PATH_STYLE:'true',OTEL_SDK_DISABLED:'true',LEDGERCATCH_DEMO:'true'};
writeFileSync(file,Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
const prefix=['compose','-p',project,'--env-file',file,'-f','compose.yaml','-f','compose.verify.yaml'];
function compose(args:string[],capture=false){const r=spawnSync('docker',[...prefix,...args],{encoding:'utf8',stdio:capture?'pipe':'inherit'});if(r.status)throw new Error(`Disposable container check failed: ${args[0]}`);return r.stdout;}
try {
 compose(['up','-d','--wait']);
 compose(['exec','-T','worker','node','.output/jobs-doctor.mjs']);
 for(const path of ['/api/health','/api/openapi.json','/downloads/ledgercatch-extension.zip']){const response=await fetch('http://127.0.0.1:44300'+path);if(!response.ok)throw new Error(`Smoke HTTP ${response.status} for ${path}`);if(path.endsWith('.zip')){const expected=readFileSync('public/downloads/ledgercatch-extension.zip');if(!expected.equals(Buffer.from(await response.arrayBuffer())))throw new Error('Served extension differs from verified ZIP');}}
 const image=spawnSync('docker',['image','inspect',process.env.VERIFY_IMAGE,'--format','{{.Id}} {{.Architecture}}'],{encoding:'utf8'}).stdout.trim();
 writeFileSync('artifacts/container-verification.json',JSON.stringify({image,checks:['fresh migrations','jobs schema doctor','app readiness','OpenAPI','exact served extension ZIP'],verifiedAt:new Date().toISOString()},null,2));
 console.log('Disposable app/worker container verification passed.');
}finally{compose(['down','--volumes','--remove-orphans']);}
