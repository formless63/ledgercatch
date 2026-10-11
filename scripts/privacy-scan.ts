import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const prohibited=/(^|\/)(\.beads|\.agents|planning|node_modules)(\/|$)|^(backups|recordings|captures)(\/|$)|\.capture\.json$|\.env(?!\.example$)|\.dump$|\.pem$|\.key$/;
const contentPatterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/gh[pousr]_[A-Za-z0-9]{30,}/,/github_pat_[A-Za-z0-9_]{40,}/,/AKIA[A-Z0-9]{16}/];
const failures:string[]=[];
for(const path of paths){if(prohibited.test(path))failures.push(path+': prohibited path');if(!statSync(path).isFile())continue;const content=readFileSync(path);for(const pattern of contentPatterns)if(pattern.test(content.toString('utf8')))failures.push(path+': credential pattern');}
// ZIP is produced by WXT, contains only extension runtime files, and must not embed source/config.
try {const zip=readdirSync('artifacts').find(f=>f.endsWith('.zip'));if(zip){const names=execFileSync('unzip',['-Z1',join('artifacts',zip)],{encoding:'utf8'});for(const name of names.split('\n'))if(prohibited.test(name))failures.push('ZIP: prohibited path');const unpacked=execFileSync('unzip',['-p',join('artifacts',zip)],{maxBuffer:20*1024*1024});for(const pattern of contentPatterns)if(pattern.test(unpacked.toString('utf8')))failures.push('ZIP: credential pattern');}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
if(failures.length)throw new Error(failures.join('\n'));
console.log(`Privacy pattern scan passed for ${paths.length} source paths and available extension ZIP. This is not a provenance certification.`);
