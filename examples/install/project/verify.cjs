const fs = require('node:fs');
const assert = require('node:assert/strict');
const clsx = require('clsx');
const cases = [
  ['strings', () => assert.equal(clsx('alpha', 'beta'), 'alpha beta')],
  ['conditional', () => assert.equal(clsx({ active: true, disabled: false }), 'active')],
  ['arrays', () => assert.equal(clsx(['alpha', ['beta', false]]), 'alpha beta')],
  ['empty', () => assert.equal(clsx(null, undefined, false, ''), '')],
];
for (const [, check] of cases) check();
fs.mkdirSync('reports', { recursive: true });
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('reports/tests.json', JSON.stringify({ tests: cases.map(([name]) => ({ name, status: 'passed' })) }));
fs.writeFileSync('dist/classes.json', JSON.stringify({ classes: clsx('button', { active: true, hidden: false }) }));
console.log('4 dependency behavior checks and build passed offline');
