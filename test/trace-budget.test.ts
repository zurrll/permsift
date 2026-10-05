import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { observationFixture } from './support/observation-fixture.js';
import { prepareObservation, collectObservation } from '../src/observation.js';
import { observationPreload } from '../src/observation-runtime.js';
import { traceBudget } from '../src/trace-budget.js';
import { hash } from '../src/filesystem.js';
import { parseUsage } from '../src/usage-report.js';

const longWorker = `require('node:worker_threads').parentPort.postMessage('ready');setInterval(()=>{},10000)`;
const usage = (observed: Awaited<ReturnType<typeof collectObservation>>) => ({ schema_version: 1, kind: 'dependency_usage',
  observer_version: observed.observer_version, status: observed.capture_status === 'captured' ? 'observed' : 'incomplete', environment: {},
  inputs: { config_hash: hash('config'), limits_hash: hash('limits') },
  tasks: [{ ...observed, task: 'build', task_definition_hash: hash('task'), verdict: 'pass' }] });

async function run(t: TestContext, code: string, events = 10_000, bytes = 2_000_000, files: Record<string, string> = {}) {
  const f = await observationFixture(t), setup = await prepareObservation(f.roots);
  for (const [name, source] of Object.entries({ ...files, 'budget.cjs': code })) {
    await fs.mkdir(path.dirname(path.join(f.roots.workspace, name)), { recursive: true });
    await fs.writeFile(path.join(f.roots.workspace, name), source);
  }
  const preload = observationPreload(setup.directory, events, bytes);
  await fs.chmod(setup.bootstrap, 0o600); await fs.writeFile(setup.bootstrap, preload); setup.bootstrap_hash = hash(preload); await fs.chmod(setup.bootstrap, 0o400);
  const execution = spawnSync(process.execPath, ['budget.cjs'], { cwd: f.roots.workspace,
    env: { ...process.env, NODE_OPTIONS: '--require ' + JSON.stringify(setup.bootstrap) }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(execution.status, 0, execution.stderr || execution.error?.message);
  const observed = await collectObservation(setup, f.roots);
  for (const file of await fs.readdir(setup.directory)) {
    const source = await fs.readFile(path.join(setup.directory, file), 'utf8'), lines = source.trimEnd().split('\n');
    assert.ok(Buffer.byteLength(source) <= bytes, `${file} exceeds total byte ceiling`);
    assert.ok(lines.length <= events + 2, `${file} exceeds total event ceiling plus header/footer`);
    const footer = JSON.parse(lines.at(-1)!);
    if (footer.kind === 'end') assert.ok(Buffer.byteLength(lines.at(-1)! + '\n') <= 8192);
  }
  assert.doesNotThrow(() => parseUsage(usage(observed)), observed.issues.join('\n'));
  return { ...f, setup, observed, parent: observed.trace_diagnostics!.find(d => d.file.endsWith('-0.jsonl'))! };
}

test('worker evidence survives detail event and byte exhaustion without completing a missing worker footer', async t => {
  const files = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`many/part${i}.cjs`, 'module.exports=1;']));
  for (const [events, bytes, reason] of [[64, 2_000_000, 'event_limit'], [10_000, 10_000, 'byte_limit']] as const) {
    const code = `for(let i=0;i<100;i++)require('./many/part'+i+'.cjs');const {Worker}=require('node:worker_threads');
const w=new Worker(${JSON.stringify(longWorker)},{eval:true});w.once('message',()=>w.unref());`;
    const { observed, parent } = await run(t, code, events, bytes, files);
    assert.equal(parent.footer, 'present'); assert.ok(parent.channels!.details.reasons.includes(reason));
    assert.deepEqual(parent.budget, traceBudget(events, bytes));
    assert.equal(parent.worker_states!.length, 1); assert.equal(parent.worker_states![0].referenced, false);
    const worker = observed.trace_diagnostics!.find(d => !d.file.endsWith('-0.jsonl'))!;
    assert.equal(worker.footer, 'missing'); assert.ok(worker.reasons.includes('worker_unref_at_parent_exit'));
    assert.equal(worker.worker_end!.state_source, 'parent_footer'); assert.equal(observed.capture_status, 'incomplete');
    assert.equal(observed.module_capture_status, 'incomplete');
  }
});

test('exhausted worker API history preserves the final unref and termination states, including late callbacks', async t => {
  for (const mode of ['late-unref', 'terminate'] as const) {
    const code = `const {Worker}=require('node:worker_threads');const w=new Worker(${JSON.stringify(longWorker)},{eval:true});
w.once('message',()=>{for(let i=0;i<200;i++){w.unref();w.ref();}
${mode === 'terminate' ? 'w.terminate();' : "w.unref();process.once('exit',()=>{w.ref();w.unref();});"}});`;
    const { observed, parent } = await run(t, code);
    assert.deepEqual(parent.channels!.details.reasons, []);
    assert.deepEqual(parent.channels!.workers.reasons, ['worker_history_event_limit']);
    assert.equal(parent.channels!.workers.history_events, 112); assert.equal(parent.worker_states!.length, 1);
    const state = parent.worker_states![0], worker = observed.trace_diagnostics!.find(d => !d.file.endsWith('-0.jsonl'))!;
    assert.equal(worker.worker_end!.state_source, 'parent_footer'); assert.equal(worker.footer, 'missing');
    if (mode === 'terminate') { assert.equal(state.termination_requested, true); assert.equal(typeof state.exit_code, 'number'); assert.ok(worker.reasons.includes('worker_termination_requested')); }
    else { assert.equal(state.referenced, false); assert.equal(state.parent_exit, true); assert.ok(worker.reasons.includes('worker_unref_at_parent_exit')); }
    assert.equal(observed.capture_status, 'incomplete');
  }
});

test('worker count and creation-byte limits disclose omitted workers and keep snapshots bounded', async t => {
  const count = await run(t, `const {Worker}=require('node:worker_threads');for(let i=0;i<10;i++)new Worker("require('unused')",{eval:true});`, 64);
  assert.equal(count.parent.worker_states!.length, 8); assert.equal(count.parent.channels!.workers.omitted_workers, 2);
  assert.ok(count.parent.channels!.workers.reasons.includes('worker_state_limit')); assert.equal(count.observed.capture_status, 'incomplete');
  const entry = 'a'.repeat(200) + '/' + 'b'.repeat(200) + '/worker.cjs';
  const bounded = await run(t, `const {Worker}=require('node:worker_threads');for(let i=0;i<8;i++)new Worker('./${entry}');`, 10_000, 20_000, { [entry]: "require('unused');" });
  assert.ok(bounded.parent.worker_states!.length > 0 && bounded.parent.worker_states!.length < 8);
  assert.equal(bounded.parent.channels!.workers.omitted_workers, 8 - bounded.parent.worker_states!.length);
  assert.ok(bounded.parent.channels!.workers.reasons.includes('worker_creation_byte_limit'));
  assert.equal(bounded.observed.capture_status, 'incomplete');
});

test('corrupt counters and final worker states cannot be promoted by raw or saved-report readers', async t => {
  const f = await run(t, `const {Worker}=require('node:worker_threads');new Worker("require('unused')",{eval:true});`);
  assert.equal(f.observed.capture_status, 'captured', f.observed.issues.join('\n'));
  const trace = path.join(f.setup.directory, f.parent.file), original = await fs.readFile(trace, 'utf8'), lines = original.trimEnd().split('\n');
  const mutations = [
    (end: any) => end.channels.details.events++,
    (end: any) => end.channels.workers.bytes++,
    (end: any) => end.worker_states[0].thread++,
    (end: any) => end.worker_states[0].referenced = false,
    (end: any) => end.worker_states[0].termination_requested = true,
    (end: any) => end.worker_states[0].parent_exit = true,
  ];
  for (const mutate of mutations) {
    const end = JSON.parse(lines.at(-1)!); mutate(end);
    await fs.writeFile(trace, [...lines.slice(0, -1), JSON.stringify(end)].join('\n') + '\n');
    const observed = await collectObservation(f.setup, f.roots), parent = observed.trace_diagnostics!.find(d => d.file === f.parent.file)!;
    assert.equal(observed.capture_status, 'incomplete'); assert.equal(parent.footer, 'missing'); assert.equal(parent.worker_states, undefined);
    assert.ok(observed.loaded_packages.some(p => p.name === 'unused'), 'Valid module evidence survives a corrupt footer');
    assert.doesNotThrow(() => parseUsage(usage(observed)));
  }
  await fs.writeFile(trace, original);
  for (const edit of [
    (d: any) => d.channels.details.events++,
    (d: any) => d.channels.details.bytes = 100_000,
    (d: any) => d.worker_states[0].thread++,
    (d: any) => d.worker_states[0].referenced = false,
    (d: any) => d.channels.workers.omitted_workers++,
  ]) {
    const report = structuredClone(usage(f.observed)); edit(report.tasks[0].trace_diagnostics!.find(d => d.file === f.parent.file));
    assert.throws(() => parseUsage(report));
  }
});
