import { readdirSync,readFileSync,writeFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
const locked=new Set([...readFileSync('bun.lock','utf8').matchAll(/^\s*"[^"]+": \["([^" ]+@[^" ]+)"/gm),...readFileSync('extension/bun.lock','utf8').matchAll(/^\s*"[^"]+": \["([^" ]+@[^" ]+)"/gm)].map(m=>m[1]));
const upstream=JSON.parse(readFileSync('docs/licenses/sources.json','utf8')) as Array<{name:string;version:string;file?:string}>;
const entries=new Map<string,{name:string;version:string;license:unknown;text:string}>();
for(const root of ['node_modules','extension/node_modules']){
 const paths:string[]=[];
 for(const name of readdirSync(root)){if(name.startsWith('.'))continue;if(name.startsWith('@'))for(const child of readdirSync(join(root,name)))paths.push(join(root,name,child));else paths.push(join(root,name));}
 for(const path of paths){if(!existsSync(join(path,'package.json')))continue;const pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));if(!pkg.name||!pkg.version)continue;const key=`${pkg.name}@${pkg.version}`;if(entries.has(key)||!locked.has(key))continue;
 const files=readdirSync(path).filter(f=>/^(license|licence|copying|notice)([-_.]|$)/i.test(f));
 if(!files.length)files.push(...readdirSync(path).filter(f=>/^readme/i.test(f)&&/license|copyright/i.test(readFileSync(join(path,f),'utf8'))));
 let text=files.map(file=>{try{return readFileSync(join(path,file),'utf8');}catch{return '';}}).join('\n');if(!text){const source=upstream.find(s=>s.name===pkg.name&&s.version===pkg.version&&s.file);if(source?.file)text=readFileSync(join('docs/licenses',source.file),'utf8');}
 entries.set(key,{name:pkg.name,version:pkg.version,license:pkg.license??pkg.licenses??'UNDECLARED',text});
 }
}
const sorted=[...entries.values()].sort((a,b)=>`${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
writeFileSync('docs/dependency-licenses.json',JSON.stringify(sorted.map(({text,...entry})=>({...entry,licenseTextIncluded:!!text})),null,2)+'\n');
writeFileSync('THIRD_PARTY_NOTICES.txt','Third-party dependencies installed from the committed app and extension lockfiles. Development tools are included conservatively. These licenses do not replace the application MIT license.\n\n'+sorted.map(e=>`${e.name}@${e.version}\nDeclared license: ${JSON.stringify(e.license)}\n${e.text||'License text not present in the installed package; consult its upstream distribution before publication.'}`).join('\n\n----------------------------------------\n\n'));
console.log(`Recorded ${sorted.length} installed dependency notices; ${sorted.filter(e=>!e.text).length} packages require upstream notice review.`);
