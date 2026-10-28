import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const hashes: Record<string, string> = {
 'index.js': '48fd88a90e90ba6fe45487d529a9ab4fda2c67c6d44e53f85067ace7064f739b',
 'dist/cjs.js': '218a3a994f126ee0ae64e9e58d8b315bb01ba1cb096c696118da27212b1c1cbe',
 'dist/umd.js': '74f72617d80ed4d1edad4a0b72ad3305da87da855e7fa825ad2a93f8beea8735',
};

/** Audit exception is permitted only for these exact reviewed, patched bytes. */
export function verifyDependencyPatches() {
 const root = resolve(dirname(require.resolve('deepmerge')), '..');
 assert.equal(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version, '4.3.1');
 for (const [file, expected] of Object.entries(hashes)) {
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex'), expected, `Reviewed deepmerge patch missing or changed: ${file}`);
 }
 const merge = require('deepmerge') as (target: unknown, source: unknown) => Record<string, unknown>;
 const payload = () => JSON.parse('{"__proto__":{"polluted":true}}');
 for (const [target, source] of [[Object.create(null), payload()], [payload(), {}], [payload(), payload()], [{}, payload()]] as const) {
  const result = merge(target, source);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(result.polluted, undefined);
  assert.equal(Object.hasOwn(result, '__proto__'), false);
 }
 for (const placeholder of [null, undefined, 0]) {
  const result = merge({nested: placeholder}, {nested: payload()});
  assert.equal(Object.getPrototypeOf(result.nested), Object.prototype);
  assert.equal((result.nested as Record<string,unknown>).polluted, undefined);
 }
 assert.deepEqual(merge({nested:{a:1}, list:[1]}, {nested:{b:2}, list:[2]}), {nested:{a:1,b:2},list:[1,2]});
}
