// Value verification: one ordinary compile, one observed compile, then one
// controlled change. Never runs tighten or re-executes a historical baseline.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { runExperiment } from '../dist/src/engine.js';
import { runObservation } from '../dist/src/observe-command.js';
import { compilationFixture } from '../dist/test/support/compilation-fixture.js';

const repository = fileURLToPath(new URL('../', import.meta.url)); process.chdir(repository);
const { values } = parseArgs({ options: { 'medium-baseline': { type: 'string' } } });
await fs.mkdir('.permsift', { recursive: true });
const root = await fs.mkdtemp(path.join(repository, '.permsift/compiler-inputs-'));
console.error(`Evidence directory: ${root}`);
const controller = new AbortController(), interrupt = () => controller.abort();
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const summary = { root, samples: [], limitations: 'Source-specific evidence from one ordinary and one observed compile per project, plus a controlled type-reference change. Not a timing guarantee, deletion recommendation or permission-search saving.' };
const cleanup = [], write = () => fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
async function sample(name, configPath, sourceLimits) {
  const limits = parse(await fs.readFile(sourceLimits, 'utf8')); limits.repetitions = 1; limits.max_output_bytes = 2_000_000;
  const limitsPath = path.join(root, name + '-limits.json'); await fs.writeFile(limitsPath, JSON.stringify(limits));
  const options = { configPath, limitsPath, signal: controller.signal, onProgress: s => console.error(`${name}: ${s}`) };
  const normal = await runExperiment({ ...options, mode: 'run', output: path.join(root, name + '-normal') }); assert.equal(normal.status, 'verified', normal.error);
  const report = await runObservation({ ...options, output: path.join(root, name + '-observe') });
  const task = report.tasks[0]; assert.notEqual(task.capture_status, 'not_run'); assert.equal(task.verdict, 'pass');
  assert.equal(task.compilation.capture_status, 'captured', task.compilation.issues.join('\n'));
  assert.equal(normal.inputs.snapshot_hash, report.inputs.snapshot_hash);
  const execution = JSON.parse(await fs.readFile(path.join(report.output, 'report.json'), 'utf8'));
  assert.equal(execution.trials.length, 1); assert.deepEqual(execution.searches, {});
  const row = { project: name, status: report.status, installed_instances: task.inventory.packages.length,
    loaded_instances: task.loaded_packages.length, module_capture: task.capture_status,
    compilation_files: task.compilation.files.length, compilation_packages: task.compilation.packages.map(p => ({ name: p.name, version: p.version, files: p.files.length })),
    compiler: task.compilation.compiler, coverage_gaps: task.coverage_gaps,
    normal_total_ms: normal.timings.total_ms, observed_total_ms: execution.timings.total_ms,
    normal_task_ms: normal.trials[0].timings.phases.task.duration_ms, observed_task_ms: execution.trials[0].timings.phases.task.duration_ms,
    usage_report: path.join(report.output, 'usage.json') };
  summary.samples.push(row); await write(); return { options, report, task, row };
}
try {
  // Small fixture proves a type-only dependency is a compiler input, not a JS
  // module load. It is explicitly not presented as an upstream real project.
  const fixture = await compilationFixture({ after: fn => cleanup.push(fn) });
  const controlled = await sample('controlled-type-import', fixture.configPath, fixture.limitsPath);
  assert.ok(controlled.task.compilation.packages.some(p => p.name === 'type-a'));
  assert.ok(!controlled.task.loaded_packages.some(p => p.name === 'type-a'));
  const source = path.join(fixture.roots.workspace, 'src/index.ts');
  await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace("'type-a'", "'type-b'"));
  await fixture.pkg('@types/ambient-a', '2.0.0', 'declare const AmbientFixture: number;');
  const changed = await runObservation({ ...controlled.options, output: path.join(root, 'controlled-type-import-changed'), baselinePath: controlled.row.usage_report });
  assert.equal(changed.tasks[0].compilation.capture_status, 'captured'); assert.equal(changed.tasks[0].verdict, 'pass');
  const diff = changed.comparison.tasks[0]; assert.equal(diff.added.length, 0);
  assert.deepEqual(diff.compilation.added.map(p => p.name), ['type-b']); assert.deepEqual(diff.compilation.removed.map(p => p.name), ['type-a']);
  assert.deepEqual(diff.compilation.version_changes.map(p => [p.name, p.before, p.after]), [['@types/ambient-a', '1.0.0', '2.0.0']]);
  controlled.row.change_report = path.join(changed.output, 'usage.json'); controlled.row.change = diff.compilation; await write();
  if (values['medium-baseline']) {
    const baseline = JSON.parse(await fs.readFile(values['medium-baseline'], 'utf8'));
    const config = parse(await fs.readFile(baseline.warm_config, 'utf8')), original = config.scenarios[0];
    config.scenarios = [{ ...original, id: 'compile', initial_network_grants: [], initial_write_grants: ['@workspace/out'], initial_read_grants: ['@workspace'], auto_discover: false, narrower_candidates: [],
      install: { ...original.install, initial_write_grants: ['@workspace/node_modules'], auto_discover: false, narrower_candidates: [] },
      command: ['node', 'node_modules/typescript/bin/tsc', '--pretty', 'false', '--skipLibCheck'],
      observation: { typescript: { compiler: '@workspace/node_modules/typescript' } },
      assertions: [{ type: 'file_contains', path: '@workspace/out/index.d.ts', text: 'declare' }] }];
    const configPath = path.join(root, 'fast-glob.yaml'); await fs.writeFile(configPath, stringify(config, { aliasDuplicateObjects: false }));
    const real = await sample('fast-glob', configPath, path.join(repository, 'examples/third-party/fast-glob/limits.json'));
    assert.equal(real.report.status, 'observed'); assert.equal(real.task.loaded_packages.length, 1);
    const nodeTypes = real.task.compilation.files.find(f => f.path === '@workspace/node_modules/@types/node/index.d.ts'); assert.ok(nodeTypes);
    const micromatch = real.task.compilation.files.find(f => f.path === '@workspace/node_modules/@types/micromatch/index.d.ts'); assert.ok(micromatch);
    real.row.examples = { node_types: nodeTypes, micromatch_types: micromatch };
    await write();
  }
  console.log(`Evidence: ${path.join(root, 'summary.json')}`); console.log(JSON.stringify(summary.samples, null, 2));
} finally {
  await write(); for (const fn of cleanup) await fn(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
}
