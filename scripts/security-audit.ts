import { spawnSync } from 'node:child_process';
import { verifyDependencyPatches } from './verify-dependency-patches';

verifyDependencyPatches();
console.log('Verified reviewed deepmerge patch bytes and prototype-poisoning regressions.');
// The registry identifies the original version, not Bun's patched installed bytes.
// Every other advisory remains a failure, including any new deepmerge advisory.
for (const args of [['audit', '--ignore', 'GHSA-gcqx-w48m-w2h4'], ['audit', '--cwd', 'extension']]) {
 const result = spawnSync('bun', args, {stdio:'inherit'});
 if (result.status !== 0) process.exit(result.status ?? 1);
}
