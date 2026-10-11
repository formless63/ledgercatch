import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const cta=JSON.parse(await readFile('.cta.json','utf8'));
assert.equal(cta.projectName,'jobs-addon-clean-install');assert.ok(resolve('.').includes('jobs-addon-'));
const env={...process.env,PGBOSS_SCHEMA:`jobs_fixture_${randomUUID().replaceAll('-','')}`};
function run(args:string[]){assert.equal(spawnSync(process.execPath,args,{env,stdio:'inherit'}).status,0)}
run(['scripts/jobs-transaction-fixture.ts']);
run(['run','jobs:migrate']);run(['run','jobs:doctor']);run(['run','jobs:smoke']);run(['run','build']);
await rm('src/integrations/jobs',{recursive:true});
for(const name of ['worker','migrate','doctor','smoke','transaction-fixture'])await rm(`scripts/jobs-${name}.ts`);
const pkg=JSON.parse(await readFile('package.json','utf8'));delete pkg.dependencies['pg-boss'];
for(const key of Object.keys(pkg.scripts))if(key.startsWith('jobs:'))delete pkg.scripts[key];
await writeFile('package.json',JSON.stringify(pkg,null,2)+'\n');
run(['install']);run(['x','tsc','--noEmit']);run(['run','build']);
console.info('Jobs install/runtime/removal passed; queue schema and baseline database retained');
