import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dependencyInventory } from '../src/dependency-inventory.js';
import { prepareObservation, collectObservation } from '../src/observation.js';
import { observationPreload } from '../src/observation-runtime.js';
import { observationFixture } from './support/observation-fixture.js';
import { compareUsage, loadUsage, usageMarkdown, type UsageReport } from '../src/observe-command.js';
import { hash } from '../src/filesystem.js';
import { parseUsage } from '../src/usage-report.js';

test('npm inventory counts nested instances and scopes separately from lock records', async t => {
  const f = await observationFixture(t);
  await fs.writeFile(path.join(f.roots.workspace, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {},
    'node_modules/alpha': { version: '1.0.0' }, 'node_modules/optional-missing': { version: '1.0.0', optional: true } } }));
  const inventory = await dependencyInventory(f.roots.workspace);
  assert.equal(inventory.complete, true); assert.equal(inventory.packages.length, 5);
  assert.equal(inventory.packages.filter(p => p.name === 'shared').length, 2);
  assert.deepEqual(inventory.packages.find(p => p.name === 'alpha')!.declarations, ['dependencies']);
  assert.equal(inventory.locked_instances, 2); assert.deepEqual(inventory.locked_not_installed, ['@workspace/node_modules/optional-missing']);
});
test('links, unreadable metadata and enumeration limits produce explicit partial inventory', async t => {
  const f = await observationFixture(t);
  await fs.symlink('alpha', path.join(f.roots.workspace, 'node_modules', 'linked'));
  await f.pkg('broken', 'broken', '');
  const inventory = await dependencyInventory(f.roots.workspace);
  assert.equal(inventory.complete, false); assert.match(inventory.issues.join(' '), /Unsupported dependency entry/);
  assert.match(inventory.issues.join(' '), /Unreadable package metadata/);
  const bounded = await dependencyInventory(f.roots.workspace, 1);
  assert.equal(bounded.packages.length, 1); assert.equal(bounded.complete, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(dependencyInventory(f.roots.workspace, 2048, controller.signal), /interrupted/);
  const setup = await prepareObservation(f.roots);
  await fs.writeFile(path.join(setup.directory, '42-0.jsonl'), [
    { kind: 'start', pid: 42, thread: 0, node: 'v24', hooks: true, entry: '' },
    { kind: 'load', url: new URL('node_modules/broken/index.js', 'file://' + f.roots.workspace + '/').href },
    { kind: 'end', count: 1, truncated: false, io_error: false },
  ].map(v => JSON.stringify(v)).join('\n') + '\n');
  const observed = await collectObservation(setup, f.roots);
  assert.equal(observed.module_capture_status, 'captured'); assert.equal(observed.capture_status, 'incomplete');
  assert.ok(observed.attribution_issues!.length); assert.equal(observed.inventory.complete, false);
});
test('builtin preload observes CJS, ESM and inherited Node children with stable normalized edges', async t => {
  const f = await observationFixture(t);
  const run = async () => {
    const setup = await prepareObservation(f.roots);
    const execution = spawnSync(process.execPath, ['task.cjs'], { cwd: f.roots.workspace, env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(setup.bootstrap)}` }, encoding: 'utf8' });
    assert.equal(execution.status, 0, execution.stderr);
    const observation = await collectObservation(setup, f.roots);
    await fs.rm(path.dirname(setup.bootstrap), { recursive: true, force: true });
    return observation;
  };
  const first = await run(), second = await run();
  assert.equal(first.capture_status, 'captured', first.issues.join('\n'));
  assert.equal(first.processes.length, 2);
  assert.deepEqual(first.loaded_packages.map(p => p.path), ['@workspace/node_modules/@scope/esm', '@workspace/node_modules/alpha', '@workspace/node_modules/alpha/node_modules/shared', '@workspace/node_modules/shared']);
  assert.deepEqual(first.not_observed.map(p => p.name), ['unused']);
  assert.ok(first.edges.some(e => e.parent === '@workspace/node_modules/alpha/index.js' && e.package === '@workspace/node_modules/alpha/node_modules/shared'));
  assert.deepEqual(first.loaded_packages, second.loaded_packages); assert.deepEqual(first.edges, second.edges);
});
test('a trace with no footer, malformed data or an unsupported Node never reports complete capture', async t => {
  const f = await observationFixture(t), setup = await prepareObservation(f.roots);
  const file = path.join(setup.directory, '42-0.jsonl');
  const start = { kind: 'start', pid: 42, thread: 0, node: 'v20', hooks: false, entry: '' };
  await fs.writeFile(file, JSON.stringify(start) + '\n');
  let observation = await collectObservation(setup, f.roots);
  assert.equal(observation.capture_status, 'incomplete'); assert.match(observation.issues.join(' '), /unsupported|did not finish/);
  assert.deepEqual(observation.trace_diagnostics![0].reasons, ['missing_footer']);
  await fs.writeFile(file, 'invalid\n'); observation = await collectObservation(setup, f.roots);
  assert.equal(observation.capture_status, 'unavailable');
  await fs.writeFile(file, JSON.stringify({ ...start, hooks: true }) + '\n' + JSON.stringify({ kind: 'load', url: new URL('node_modules/alpha/index.js', 'file://' + f.roots.workspace + '/').href }) + '\n{"kind":');
  observation = await collectObservation(setup, f.roots);
  assert.equal(observation.capture_status, 'incomplete'); assert.ok(observation.loaded_packages.some(p => p.name === 'alpha'));
  assert.match(observation.issues.join(' '), /valid prefix/);
});
test('bounded preload preserves task execution and reports truncation rather than absent packages', async t => {
  const f = await observationFixture(t), setup = await prepareObservation(f.roots);
  const source = observationPreload(setup.directory, 1, 2_000_000);
  await fs.chmod(setup.bootstrap, 0o600);
  await fs.writeFile(setup.bootstrap, source); setup.bootstrap_hash = hash(source);
  const execution = spawnSync(process.execPath, ['task.cjs'], { cwd: f.roots.workspace, env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(setup.bootstrap)}` }, encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  const observation = await collectObservation(setup, f.roots);
  assert.equal(observation.capture_status, 'incomplete'); assert.match(observation.issues.join(' '), /bounded/);
  assert.ok(observation.trace_diagnostics!.some(d => d.reasons.includes('event_limit')));
});
test('byte limits and footer inconsistencies are diagnosed without turning partial captures into complete ones', async t => {
  const f = await observationFixture(t), setup = await prepareObservation(f.roots);
  const source = observationPreload(setup.directory, 10_000, 9000);
  await fs.chmod(setup.bootstrap, 0o600); await fs.writeFile(setup.bootstrap, source); setup.bootstrap_hash = hash(source);
  const execution = spawnSync(process.execPath, ['task.cjs'], { cwd: f.roots.workspace, env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(setup.bootstrap)}` }, encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  let observed = await collectObservation(setup, f.roots);
  assert.ok(observed.trace_diagnostics!.some(d => d.reasons.includes('byte_limit'))); assert.equal(observed.module_capture_status, 'incomplete');
  for (const file of await fs.readdir(setup.directory)) await fs.rm(path.join(setup.directory, file));
  const start = { kind: 'start', pid: 42, thread: 0, node: 'v24', hooks: true, entry: '' };
  for (const footer of [{ kind: 'end', count: 1, truncated: false, io_error: false }, { kind: 'end', count: 0, truncated: true, io_error: false }, { kind: 'end', count: 0, truncated: false, io_error: true }, { kind: 'end', count: 0, truncated: false, io_error: false, reasons: ['text_limit'] }]) {
    await fs.writeFile(path.join(setup.directory, '42-0.jsonl'), JSON.stringify(start) + '\n' + JSON.stringify(footer) + '\n');
    observed = await collectObservation(setup, f.roots); assert.equal(observed.capture_status, 'incomplete');
    assert.ok(observed.trace_diagnostics![0].reasons.includes(footer.count ? 'count_mismatch' : footer.truncated ? 'truncation_reason_not_saved' : footer.io_error ? 'io_error' : 'text_limit'));
  }
  const raw = { schema_version: 1, kind: 'dependency_usage', observer_version: observed.observer_version, status: 'incomplete', environment: {},
    inputs: { config_hash: hash('config'), limits_hash: hash('limits') }, tasks: [{ ...observed, task: 'type', task_definition_hash: hash('task'), verdict: 'pass' }] };
  assert.doesNotThrow(() => parseUsage(raw));
  assert.throws(() => parseUsage({ ...raw, tasks: [{ ...raw.tasks[0], module_capture_status: 'captured' }] }), /contradicts trace/);
  const broken = structuredClone(raw); broken.tasks[0].trace_diagnostics![0].reported_events = 1;
  assert.throws(() => parseUsage(broken), /count diagnostics/);
});
test('default worker inheritance is observed and non-file URL contents are not stored', async t => {
  const f = await observationFixture(t), setup = await prepareObservation(f.roots);
  await fs.writeFile(path.join(f.roots.workspace, 'worker.cjs'), `
const {Worker}=require('node:worker_threads');
const w=new Worker("require('unused')",{eval:true});
w.on('error',e=>{throw e;});
import('data:text/javascript,export default "fake-observation-secret"');
`);
  const execution = spawnSync(process.execPath, ['worker.cjs'], { cwd: f.roots.workspace, env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(setup.bootstrap)}` }, encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  const observation = await collectObservation(setup, f.roots);
  assert.equal(observation.capture_status, 'captured', observation.issues.join(' '));
  assert.equal(observation.processes.length, 2); assert.ok(observation.loaded_packages.some(p => p.name === 'unused'));
  for (const file of await fs.readdir(setup.directory)) assert.ok(!(await fs.readFile(path.join(setup.directory, file), 'utf8')).includes('fake-observation-secret'));
});
test('reader refuses linked/oversized logs and reports its process-file ceiling', async t => {
  const f = await observationFixture(t), setup = await prepareObservation(f.roots);
  await fs.symlink(setup.bootstrap, path.join(setup.directory, '1-0.jsonl'));
  await fs.writeFile(path.join(setup.directory, '2-0.jsonl'), Buffer.alloc(2_000_001));
  for (let pid = 3; pid <= 67; pid++) await fs.writeFile(path.join(setup.directory, `${pid}-0.jsonl`), JSON.stringify({ kind: 'start', pid, thread: 0, node: 'v24', hooks: true, entry: '' }) + '\n' + JSON.stringify({ kind: 'end', count: 0, truncated: false, io_error: false }) + '\n');
  const observation = await collectObservation(setup, f.roots);
  assert.equal(observation.capture_status, 'incomplete'); assert.ok(observation.processes.length <= 64);
  assert.match(observation.issues.join(' '), /Process-log limit/); assert.match(observation.issues.join(' '), /oversized/);
});
test('usage comparison separates additions, version changes and incomplete observations', async t => {
  const f = await observationFixture(t), setup = await prepareObservation(f.roots);
  const capture = await collectObservation(setup, f.roots);
  const task = { ...capture, task: 'build', trial: 'abc', task_definition_hash: hash('task'), command: ['node'], verdict: 'pass' as const,
    capture_status: 'captured' as const, loaded_packages: [{ path: '@workspace/node_modules/alpha', name: 'alpha', version: '1.0.0', declarations: [], modules: [] }] };
  const report: UsageReport = { schema_version: 1, kind: 'dependency_usage', version: '0.9.0', observer_version: capture.observer_version, status: 'observed', output: '', execution_report: 'report.json', started_at: '',
    environment: { node: 'v24', permsift: '0.9.0' }, inputs: { snapshot_hash: hash('input'), config_hash: hash('config'), limits_hash: hash('limits') }, limits: { max_events_per_process: 10000, max_bytes_per_process: 2000000, max_process_logs: 64, max_total_bytes: 32000000, max_packages: 2048 }, tasks: [task], limitations: [] };
  const baselinePath = path.join(f.root, 'usage.json'); await fs.writeFile(baselinePath, JSON.stringify(report));
  const previous = await loadUsage(baselinePath);
  const next = structuredClone(report); const current = next.tasks[0]; assert.notEqual(current.capture_status, 'not_run');
  if (current.capture_status === 'not_run') throw new Error();
  current.loaded_packages[0].version = '2.0.0'; current.loaded_packages.push({ path: '@workspace/node_modules/new', name: 'new', version: '1', declarations: [], modules: [] });
  current.capture_status = 'incomplete';
  const comparison = compareUsage(previous, next, baselinePath);
  assert.equal(comparison.tasks[0].added.length, 1); assert.equal(comparison.tasks[0].version_changes.length, 1); assert.equal(comparison.tasks[0].removed.length, 0);
  assert.match(comparison.tasks[0].warnings.join(' '), /partial/);
  next.comparison = comparison; assert.match(usageMarkdown(next), /Observed version changed/);
  await fs.writeFile(baselinePath, JSON.stringify({ ...report, kind: 'experiment' }));
  await assert.rejects(loadUsage(baselinePath));
});
