// Public CLI replay of the two saved stories. No project, installer or sandbox executable is used.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const repository = fileURLToPath(new URL('../', import.meta.url)); process.chdir(repository);
await fs.mkdir('.permsift', { recursive: true });
const root = await fs.mkdtemp(path.join(repository, '.permsift/result-replay-')), runs = [];
const files = ['examples/model-cases/permission-read-change.json', 'examples/model-cases/permission-repair-replay.json',
  'examples/reports/fast-glob-bundle-before.json', 'examples/reports/fast-glob-bundle-after.json'];
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const before = await Promise.all(files.map(digest));
async function materialize(file, name) {
  const pack = JSON.parse(await fs.readFile(file, 'utf8')), directory = path.join(root, name); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(pack.report));
  await fs.writeFile(path.join(directory, 'inputs.json'), JSON.stringify(pack.inputs));
  for (const [name, evidence] of Object.entries(pack.evidence)) {
    const target = path.join(directory, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(evidence));
  }
  return directory;
}
async function run(name, args, expectedExit) {
  const start = performance.now(), result = spawnSync(process.execPath, ['dist/cli.js', ...args], {
    encoding: 'utf8', maxBuffer: 8_000_000, env: { ...process.env, PATH: path.join(root, 'no-executables') },
  });
  assert.equal(result.status, expectedExit, result.stderr); assert.equal(result.stderr, '');
  await fs.writeFile(path.join(root, name), result.stdout); runs.push({ command: args, exit_code: result.status, wall_ms: performance.now() - start });
  return args.includes('--json') ? JSON.parse(result.stdout) : result.stdout;
}
const repair = await materialize(files[0], 'permission-change'), replay = await materialize(files[1], 'repair-replay');
const permission = await run('permission.summary.json', ['inspect', repair, '--json'], 2);
assert.equal(permission.workflow.reported_status, 'regressed'); assert.equal(permission.tasks[0].claims.find(c => c.dimension === 'suggestion').status, 'reported_only');
assert.ok(permission.tasks[0].stages.every(s => s.task === 'not_saved'));
await run('permission.summary.md', ['inspect', repair], 2);
const verified = await run('replay.summary.json', ['inspect', replay, '--json'], 2);
assert.equal(verified.workflow.reported_status, 'verified'); assert.equal(verified.analysis.status, 'partial');
const comparisonDirectory = path.join(root, 'upgrade-comparison');
await run('upgrade.stdout.json', ['compare', ...files.slice(2), '--output', comparisonDirectory, '--json'], 0);
const upgrade = await run('upgrade.summary.json', ['inspect', comparisonDirectory, '--json'], 0);
assert.match(upgrade.tasks[0].claims.find(c => c.dimension === 'build_changes').statement, /glob-parent 5\.1\.2 → 6\.0\.2/);
await run('upgrade.summary.md', ['inspect', comparisonDirectory], 0);
const after = await Promise.all(files.map(digest)); assert.deepEqual(after, before);
await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify({ root, verified_at: new Date().toISOString(),
  task_executions: 0, installations: 0, source_files_unchanged: true, runs,
  limitations: ['Permission stories are retained projections, with absent stage/sidecar material explicitly visible.',
    'This checks report interpretation and the public CLI, not isolation, cross-host execution or independent user understanding.'] }, null, 2) + '\n');
console.log('Result explanation evidence: ' + path.join(root, 'verification.json'));
