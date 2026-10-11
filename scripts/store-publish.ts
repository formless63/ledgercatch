/** Explicit Chrome Web Store v2 release upload. Never used by ordinary CI. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const {CWS_PUBLISHER_ID:publisher,CWS_EXTENSION_ID:extension,CWS_ACCESS_TOKEN:token,RELEASE_VERSION:version}=process.env;
if(!publisher||!extension||!token){console.log('Optional store publishing is not configured. No request made.');process.exit(0);}
if(!/^[A-Za-z0-9_-]+$/.test(publisher)||!/^[a-p]{32}$/.test(extension)||!/^\d+\.\d+\.\d+$/.test(version??''))throw new Error('Invalid store identifiers/version');
const file=`ledgercatch-extension-${version}.zip`;const bytes=readFileSync('artifacts/'+file);
const checks=readFileSync('artifacts/SHA256SUMS','utf8').split('\n');const expected=checks.find(line=>line.endsWith('  '+file))?.split(' ')[0];
if(createHash('sha256').update(bytes).digest('hex')!==expected)throw new Error('Release ZIP checksum mismatch');
const name=`publishers/${publisher}/items/${extension}`;
async function call(url:string,method:string,body?:BodyInit,type?:string){
 const r=await fetch(url,{method,headers:{Authorization:`Bearer ${token}`,...(type?{'Content-Type':type}:{})},body,redirect:'error',signal:AbortSignal.timeout(120000)});
 const text=await r.text();if(text.length>1024*1024)throw new Error('Store response exceeds limit');
 if(!r.ok)throw new Error(`Store API HTTP ${r.status}; inspect the publisher dashboard`);
 return JSON.parse(text) as Record<string,unknown>;
}
mkdirSync('artifacts',{recursive:true});
const upload=await call(`https://chromewebstore.googleapis.com/upload/v2/${name}:upload`,'POST',bytes,'application/zip');
writeFileSync('artifacts/store-upload.json',JSON.stringify(upload,null,2));
if(upload.uploadState!=='SUCCEEDED')throw new Error('Upload not yet successful; inspect saved upload state and fetchStatus before submission');
if(process.env.CWS_SUBMIT==='true'){
 const submitted=await call(`https://chromewebstore.googleapis.com/v2/${name}:publish`,'POST',JSON.stringify({publishType:'STAGED_PUBLISH',skipReview:false,blockOnWarnings:true}),'application/json');
 writeFileSync('artifacts/store-submission.json',JSON.stringify(submitted,null,2));
}
const status=await call(`https://chromewebstore.googleapis.com/v2/${name}:fetchStatus`,'GET');
writeFileSync('artifacts/store-status.json',JSON.stringify(status,null,2));
console.log('Store API status saved. Upload/submission is not approval or publication.');
