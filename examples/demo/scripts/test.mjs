import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { subtotal, totalWithTax } from '../src/invoice.js';

const cases = [
  ['empty-cart', () => assert.equal(subtotal([]), 0)],
  ['quantity', () => assert.equal(subtotal([{ cents: 125, quantity: 3 }]), 375)],
  ['tax-rounding', () => assert.equal(totalWithTax([{ cents: 199, quantity: 1 }], 8), 215)],
  ['reject-negative-price', () => assert.throws(() => subtotal([{ cents: -1, quantity: 1 }]))],
];
const tests = cases.map(([name, run]) => {
  try { run(); return { name, status: 'passed' }; }
  catch (error) { console.error(error); return { name, status: 'failed' }; }
});
await mkdir('reports', { recursive: true });
await writeFile('reports/tests.json', JSON.stringify({ tests }, null, 2));
console.log(`${tests.filter(t => t.status === 'passed').length}/${tests.length} tests passed`);
process.exitCode = tests.some(t => t.status !== 'passed') ? 1 : 0;
