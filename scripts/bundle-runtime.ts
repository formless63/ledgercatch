import { spawnSync } from 'node:child_process';
for(const file of ['migrate.mjs','jobs-migrate.ts','jobs-doctor.ts','jobs-worker.ts','storage-init.ts']){
 const name=file.replace(/\.(ts|mjs)$/,'');
 const r=spawnSync('bun',['build',`scripts/${file}`,'--target=node','--external','@tanstack/react-start','--external','@tanstack/react-start/*',`--outfile=.output/${name}.mjs`],{stdio:'inherit'});if(r.status)process.exit(r.status);
}
