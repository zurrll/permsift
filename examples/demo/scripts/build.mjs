import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const source = await readFile(new URL('../src/invoice.js', import.meta.url), 'utf8');
await writeFile('dist/index.js', '// demo-version: 1.0.0\n' + source);
const built = await import(new URL('../dist/index.js', import.meta.url));
assert.equal(built.totalWithTax([{ cents: 1000, quantity: 2 }], 10), 2200);
await writeFile('dist/manifest.json', JSON.stringify({ version: '1.0.0', smoke_test: 'passed' }));
console.log('Built and smoke-tested dist/index.js');
