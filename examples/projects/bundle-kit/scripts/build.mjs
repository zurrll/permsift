import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const result = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'node', outfile: 'dist/index.mjs', sourcemap: true, metafile: true });
const { total } = await import('../dist/index.mjs');
assert.equal(total([{ price: 125, quantity: 3 }, { price: 25, quantity: 1 }]), 400);
await writeFile('dist/build.json', JSON.stringify({ smoke_test: 'passed', inputs: Object.keys(result.metafile.inputs) }));
await writeFile('dist/meta.json', JSON.stringify(result.metafile));
