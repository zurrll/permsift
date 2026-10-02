// Value/cost verification: one ordinary build, one observed build, one change.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { runExperiment } from '../dist/src/engine.js';
import { runObservation } from '../dist/src/observe-command.js';
import { bundlingFixture } from '../dist/test/support/bundling-fixture.js';

const repository = fileURLToPath(new URL('../', import.meta.url)); process.chdir(repository);
const { values } = parseArgs({ options: { real: { type: 'boolean', default: false } } });
await fs.mkdir('.permsift', { recursive: true }); const root = await fs.mkdtemp(path.join(repository, '.permsift/bundle-inputs-'));
console.error(`Evidence directory: ${root}`);
const controller = new AbortController(), interrupt = () => controller.abort(); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const cleanup = [], summary = { root, samples: [], limitations: 'One ordinary/observed pair plus one changed observed build per project. Controlled packages are synthetic; real sample is pinned fast-glob with an explicit esbuild task. Not a statistical timing guarantee or a deletion/permission recommendation.' };
const write = () => fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
async function sample(name, configPath, sourceLimits) {
  const limits = parse(await fs.readFile(sourceLimits, 'utf8')); limits.repetitions = 1; limits.max_candidates = 0;
  const limitsPath = path.join(root, name + '-limits.json'); await fs.writeFile(limitsPath, JSON.stringify(limits));
  const options = { configPath, limitsPath, signal: controller.signal, onProgress: s => console.error(`${name}: ${s}`) };
  const normal = await runExperiment({ ...options, mode: 'run', output: path.join(root, name + '-normal') }); assert.equal(normal.status, 'verified', normal.error);
  const report = await runObservation({ ...options, output: path.join(root, name + '-observe') }); assert.equal(report.status, 'observed');
  const task = report.tasks[0], execution = JSON.parse(await fs.readFile(path.join(report.output, 'report.json'), 'utf8'));
  assert.equal(normal.inputs.snapshot_hash, report.inputs.snapshot_hash); assert.equal(execution.trials.length, 1); assert.deepEqual(execution.searches, {});
  const row = { project: name, installed_instances: task.inventory.packages.length, module_packages: task.loaded_packages.map(p => p.name),
    metadata_inputs: task.bundling.inputs.length, metadata_packages: task.bundling.packages.map(p => ({ name: p.name, version: p.version, files: p.files.length, contributions: p.contributions })),
    outputs: task.bundling.outputs.map(o => ({ path: o.path, bytes: o.bytes, entry_point: o.entry_point, imports: o.imports })),
    normal_total_ms: normal.timings.total_ms, observed_total_ms: execution.timings.total_ms,
    normal_task_ms: normal.trials[0].timings.phases.task.duration_ms, observed_task_ms: execution.trials[0].timings.phases.task.duration_ms,
    usage_report: path.join(report.output, 'usage.json') };
  summary.samples.push(row); await write(); return { options, task, row };
}
try {
  const fixture = await bundlingFixture({ after: fn => cleanup.push(fn) });
  const controlled = await sample('controlled', fixture.configPath, fixture.limitsPath);
  assert.ok(controlled.task.bundling.packages.some(p => p.name === 'lazy-pkg'));
  assert.ok(!controlled.task.bundling.packages.some(p => p.name === 'type-only'));
  const source = path.join(fixture.roots.workspace, 'src/index.ts'); await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace("'app-a'", "'app-b'"));
  await fixture.pkg('shared', 'export const answer = 42;', '2.0.0');
  const changed = await runObservation({ ...controlled.options, baselinePath: controlled.row.usage_report, output: path.join(root, 'controlled-changed') }); assert.equal(changed.status, 'observed');
  const diff = changed.comparison.tasks[0]; assert.deepEqual(diff.added, []); assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.bundling.added.map(p => p.name), ['app-b']); assert.deepEqual(diff.bundling.removed.map(p => p.name), ['app-a']);
  assert.deepEqual(diff.bundling.version_changes.map(p => [p.name, p.before, p.after]), [['shared', '1.0.0', '2.0.0']]);
  controlled.row.change_report = path.join(changed.output, 'usage.json'); controlled.row.change = diff.bundling; await write();
  if (values.real) {
    const prepared = path.join(repository, '.permsift/third-party/fast-glob-bundle'), project = path.join(root, 'fast-glob-project');
    await fs.mkdir(project);
    // Explicit source assets only; never copy a user's installed node_modules.
    for (const name of ['src', 'fixtures', 'LICENSE', 'build.cjs', 'package.json', 'package-lock.json', 'permsift-source.json']) await fs.cp(path.join(prepared, name), path.join(project, name), { recursive: true });
    const config = parse(await fs.readFile('examples/third-party/fast-glob-bundle/observe.yaml', 'utf8')); config.project = project;
    const configPath = path.join(root, 'fast-glob.yaml'); await fs.writeFile(configPath, stringify(config, { aliasDuplicateObjects: false }));
    const real = await sample('fast-glob', configPath, path.join(repository, 'examples/third-party/fast-glob-bundle/limits.json'));
    const indirect = real.task.bundling.inputs.find(i => i.path === '@workspace/node_modules/is-extglob/index.js'); assert.ok(indirect?.entry_chain.some(p => p.includes('/glob-parent/')));
    real.row.indirect_example = indirect;
    for (const name of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(repository, 'examples/third-party/fast-glob-bundle/next', name), path.join(project, name));
    const next = await runObservation({ ...real.options, baselinePath: real.row.usage_report, output: path.join(root, 'fast-glob-changed') }); assert.equal(next.status, 'observed');
    const comparison = next.comparison.tasks[0]; assert.deepEqual(comparison.version_changes, []);
    assert.deepEqual(comparison.bundling.version_changes.map(p => [p.name, p.before, p.after]), [['glob-parent', '5.1.2', '6.0.2']]);
    assert.ok(comparison.bundling.contribution_changes.some(c => c.name === 'glob-parent' && c.output === '@workspace/dist/fast-glob.cjs'));
    real.row.source = JSON.parse(await fs.readFile(path.join(project, 'permsift-source.json'), 'utf8'));
    real.row.change_report = path.join(next.output, 'usage.json'); real.row.change = comparison.bundling; await write();
  }
  console.log(`Evidence: ${path.join(root, 'summary.json')}`); console.log(JSON.stringify(summary.samples, null, 2));
} finally { await write(); for (const fn of cleanup) await fn(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
