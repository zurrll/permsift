import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { observationFixture } from './support/observation-fixture.js';
import { prepareObservation, collectObservation } from '../src/observation.js';
import { observationPreload } from '../src/observation-runtime.js';
import { traceBudget, validateChannels } from '../src/trace-budget.js';
import { hash } from '../src/filesystem.js';
import { parseUsage } from '../src/usage-report.js';
import { inspectPackage, inspectionMarkdown } from '../src/usage-inspection.js';
import { packageText, terminalView } from '../src/terminal.js';
import { explainResult } from '../src/result-explanation.js';
import { readResult } from '../src/result-reader.js';

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

test('late package loads survive resolution event and byte pressure with a valid shared dictionary', async t => {
  // Unique equivalent requests exercise real require resolution on Node 22/24;
  // require.resolve hook behavior differs between those runtimes.
  const code = `for(let i=0;i<12000;i++)require('./'+i.toString(2).padStart(14,'0').split('').map(b=>b==='1'?'.//':'./').join('')+'common.cjs');
if(require('unused')!==1)throw Error('late package');require('unused');`;
  for (const [bytes, reason] of [[2_000_000, 'event_limit'], [100_000, 'byte_limit']] as const) {
    const { observed, parent, root } = await run(t, code, 10_000, bytes, { 'common.cjs': 'module.exports=1;' });
    assert.equal(observed.load_capture_status, 'captured', observed.load_issues?.join('\n'));
    assert.equal(observed.resolution_capture_status, 'incomplete');
    assert.equal(observed.module_capture_status, 'incomplete'); assert.equal(observed.capture_status, 'incomplete');
    assert.ok(parent.channels!.details.reasons.includes(reason), JSON.stringify(parent.channels));
    assert.deepEqual(parent.channels!.loads!.reasons, []); assert.ok(observed.loaded_packages.some(p => p.name === 'unused'));
    assert.equal(parent.footer, 'present'); assert.ok(!parent.reasons.includes('missing_footer'));
    assert.equal(parent.reported_events, parent.channels!.loads!.events + parent.channels!.details.events + parent.channels!.workers.events);
    assert.equal(observed.load_issues!.length, 0); assert.ok(observed.resolution_issues!.length);
    const report = usage(observed), parsed = parseUsage(report), query = inspectPackage(parsed, 'unused', 'usage.json');
    assert.equal(query.tasks[0].instances[0].node.capture_status, 'captured'); assert.equal(query.tasks[0].resolution_capture, 'incomplete');
    assert.match(inspectionMarkdown(query), /resolution details incomplete/); assert.match(packageText(query), /解析记录.*采集有缺口/);
    // Independent model facts and terminal presentation use the load status,
    // while the incomplete resolution source remains explicitly visible.
    const file = path.join(root, 'usage.json'); await fs.writeFile(file, JSON.stringify(report));
    const record = await readResult(file);
    assert.equal(record.model!.executions[0].observations.modules.status, 'captured');
    const summary = explainResult(record), view = terminalView(record, summary);
    assert.match(view.lines.join('\n'), /Node 加载.*采集完成/);
    assert.match(view.lines.join('\n'), /解析明细.*不完整/);
    for (const change of [
      (task: any) => task.resolution_capture_status = 'captured',
      (task: any) => task.trace_diagnostics[0].channels.loads.events++,
      (task: any) => delete task.trace_diagnostics[0].channels.loads,
    ]) {
      const broken = structuredClone(report); change(broken.tasks[0]); assert.throws(() => parseUsage(broken));
    }
  }
});

test('load allocation exhaustion is explicit and cannot be promoted by a saved report', async t => {
  const files = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`many/${i}.cjs`, 'module.exports=1;']));
  const { observed, parent } = await run(t, `for(let i=0;i<80;i++)require('./many/'+i+'.cjs');require('unused');`, 64, 2_000_000, files);
  assert.equal(observed.load_capture_status, 'incomplete'); assert.ok(parent.channels!.loads!.reasons.includes('load_event_limit'));
  assert.ok(!observed.loaded_packages.some(p => p.name === 'unused'));
  const broken = structuredClone(usage(observed)); broken.tasks[0].load_capture_status = 'captured'; broken.tasks[0].load_issues = [];
  assert.throws(() => parseUsage(broken), /contradicts trace/);
  const budget = traceBudget(10_000, 2_000_000);
  assert.equal(budget.loads!.events + budget.details.events + budget.workers.events, 10_000);
  assert.equal(budget.loads!.bytes + budget.details.bytes + budget.workers.bytes + budget.footer_bytes, 2_000_000);
  assert.throws(() => validateChannels(budget, { ...parent.channels!, loads: { ...parent.channels!.loads!, reasons: ['load_event_limit', 'load_event_limit'] } }, parent.reported_events!), /inconsistent/);
});

test('v5 shared-channel traces and saved reports remain readable without invented split health', async t => {
  const f = await observationFixture(t), setup = await prepareObservation(f.roots), file = path.join(setup.directory, '42-0.jsonl');
  const budget = { details: { events: 9872, bytes: 1927808 }, workers: { events: 128, bytes: 64000, history_events: 112, history_bytes: 16000, max_workers: 16 }, footer_bytes: 8192 };
  const rows = [JSON.stringify({ kind: 'start', pid: 42, thread: 0, node: 'v24', hooks: true, entry: '', budget }),
    JSON.stringify({ kind: 'load', url: new URL('node_modules/alpha/index.js', 'file://' + f.roots.workspace + '/').href })];
  const channels = { details: { events: 1, bytes: Buffer.byteLength(rows[1] + '\n'), reasons: ['event_limit'] },
    workers: { events: 0, bytes: 0, history_events: 0, history_bytes: 0, omitted_workers: 0, reasons: [] } };
  rows.push(JSON.stringify({ kind: 'end', count: 1, truncated: true, io_error: false, reasons: ['event_limit'], channels, worker_states: [], bytes_before_footer: Buffer.byteLength(rows.join('\n') + '\n') }));
  await fs.writeFile(file, rows.join('\n') + '\n');
  const observed = await collectObservation(setup, f.roots); assert.equal(observed.load_capture_status, 'incomplete'); assert.ok(observed.loaded_packages.some(p => p.name === 'alpha'));
  const old: any = usage(observed); old.observer_version = 'node-module-load-v5';
  for (const field of ['load_capture_status', 'resolution_capture_status', 'load_issues', 'resolution_issues']) delete old.tasks[0][field];
  const parsed = parseUsage(old); assert.equal(parsed.tasks[0].capture_status, 'incomplete');
  assert.equal('load_capture_status' in parsed.tasks[0], false); assert.equal('resolution_capture_status' in parsed.tasks[0], false);
});
