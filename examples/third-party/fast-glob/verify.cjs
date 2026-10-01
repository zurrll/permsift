// Runs upstream compilation and its entire unit suite, then checks the built API.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
function run(args) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.stderr.write(result.stderr || result.stdout); process.exit(result.status || 1); }
  return result.stdout;
}
// Upstream pins Node 14 declarations; current glob/minipass declarations expect
// newer EventEmitter types. Skip dependency .d.ts checks, still check src and emit.
run(['node_modules/typescript/bin/tsc', '--pretty', 'false', '--skipLibCheck']);
const report = JSON.parse(run(['node_modules/mocha/bin/mocha', 'out/**/*.spec.js', '--reporter', 'json', '--slow', '0']));
assert.equal(report.stats.tests, 246, 'The entire pinned upstream suite must actually run');
assert.equal(report.stats.passes, 246);
assert.equal(report.stats.failures, 0); assert.equal(report.stats.pending, 0);
fs.mkdirSync('reports', { recursive: true });
fs.writeFileSync('reports/tests.json', JSON.stringify(report));
const fg = require('./out');
const expected = fg.sync(['fixtures/**/*.md']).sort();
assert.equal(expected.length, 9);
(async () => {
  assert.deepEqual((await fg(['fixtures/**/*.md'])).sort(), expected);
  fs.writeFileSync('reports/build.json', JSON.stringify({ files: expected, count: expected.length, async_matches_sync: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
