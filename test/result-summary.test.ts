import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { readResult } from '../src/result-reader.js';
import { explainResult, summaryMarkdown, summaryText, type ResultSummary } from '../src/result-explanation.js';
import { publishSummary } from '../src/result-output.js';
import { parseNativeExecution } from '../src/model/native-reader.js';
import { nativeExecution } from '../src/model/native.js';
import { executionRequest } from '../src/execution-request.js';
import { configSchema, limitsSchema } from '../src/config.js';
import { legacyHash, objectId } from '../src/model/identity.js';
import { compareSavedUsage, saveComparison } from '../src/offline-usage.js';
import type { ExecutionDetails } from '../src/execute-once.js';

// Existing real-record projections; every alteration below is a labelled synthetic counterexample.
type Pack = { report: any; inputs: any; evidence: Record<string, any> };
const pack = async (name = 'current-demo'): Promise<Pack> => JSON.parse(await fs.readFile(`examples/model-cases/${name}.json`, 'utf8'));
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-summary-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name: string, value: unknown) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); return file; };
  const bundle = async (p: Pack, prefix = '') => {
    await write(path.join(prefix, 'inputs.json'), p.inputs);
    for (const [file, value] of Object.entries(p.evidence)) await write(path.join(prefix, file), value);
    return write(path.join(prefix, 'report.json'), p.report);
  };
  return { root, write, bundle };
}
const taskClaim = (s: ResultSummary, dimension: string, task = s.tasks[0].task) => s.tasks.find(t => t.task === task)!.claims.find(c => c.dimension === dimension)!;
const cli = (...args: string[]) => spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
async function assertPointers(root: string, s: ResultSummary) {
  const refs = [...s.claims.flatMap(c => c.evidence), ...s.tasks.flatMap(t => [...t.claims.flatMap(c => c.evidence), ...t.decisions.flatMap(d => d.evidence), ...t.stages.flatMap(s => s.evidence)])];
  for (const ref of refs) {
    if (ref.availability === 'not_supplied') continue;
    let value = JSON.parse(await fs.readFile(path.join(root, ref.file), 'utf8'));
    for (const part of ref.pointer === '' ? [] : ref.pointer.slice(1).split('/')) {
      const key = part.replaceAll('~1', '/').replaceAll('~0', '~'); assert.ok(Object.hasOwn(value, key), ref.file + ' ' + ref.pointer); value = value[key];
    }
  }
}

function native(p: Pack, trial = p.report.trials.find((t: any) => p.evidence[t.evidence])) {
  const scenario = configSchema.parse(p.inputs.config).scenarios.find(s => s.id === trial.scenario)!;
  const e = p.evidence[trial.evidence];
  const request = executionRequest({ scenario, policy: { write: trial.grants, read: trial.read_grants, readMode: trial.read_mode, network: trial.network_grants ?? [], installWrite: trial.install_grants ?? trial.grants },
    conditions: { input: { path: '/tmp/synthetic-input', hash: p.report.inputs.snapshot_hash }, configHash: p.report.inputs.config_hash, limitsHash: p.report.inputs.limits_hash,
      scenarioHash: legacyHash(p.inputs.config.scenarios.find((s: any) => s.id === trial.scenario)), environment: p.report.environment, preparation: e.prepared_directories },
    limits: limitsSchema.parse(p.inputs.limits), sources: { inputDirectories: false, installedDirectories: false, afterTaskDirectories: false, readInventory: false, dependencies: false, installedState: false },
    workspace: { kind: 'input' }, budget: { deadline: Date.now() + 1000 }, resources: { scratch: '/tmp/synthetic-runs', protectedPaths: [],
      fixtures: { secret: '/tmp/fake-secret', outside: '/tmp/fake-outside', report: '/tmp/fake-report', marker: 'synthetic', port: 12345 }, readProbeDirectories: [''] } });
  return nativeExecution(request, { id: trial.id, verdict: trial.verdict, duration_ms: 1, details: e as ExecutionDetails,
    actualCommand: e.task ? scenario.command : undefined, installationAttempted: false, installationReused: false },
    { producer_id: p.report.id, record: `executions/${trial.id}.json`, phase: trial.phase });
}
async function index(f: Awaited<ReturnType<typeof fixture>>, p: Pack) {
  const records = [];
  for (const trial of p.report.trials.filter((t: any) => p.evidence[t.evidence])) {
    const facts = native(p, trial), file = `executions/${trial.id}.json`; await f.write(file, facts);
    records.push({ trial: trial.id, facts: file, evidence: trial.evidence, execution_id: facts.execution.id });
  }
  await f.write('executions/index.json', { schema_version: 1, kind: 'permsift_execution_index', entries: records }); return records;
}

test('saved permission repair explains the workflow and missing stage material without inferring adoption', async t => {
  const f = await fixture(t), file = await f.bundle(await pack('permission-read-change'));
  const s = explainResult(await readResult(file));
  assert.equal(s.workflow!.reported_status, 'regressed'); assert.equal(s.analysis.status, 'partial');
  assert.deepEqual(s.tasks[0].stages.map(s => s.reported_verdict), ['fail', 'pass', 'fail', 'pass', 'pass', 'pass']);
  assert.ok(s.tasks[0].stages.every(s => s.task === 'not_saved' && !s.retained));
  assert.equal(taskClaim(s, 'suggestion').status, 'reported_only'); assert.match(taskClaim(s, 'suggestion').statement, /Adoption is not recorded/);
  assert.ok(taskClaim(s, 'suggestion').action.command!.includes('suggested.yaml'));
  assert.ok(!JSON.stringify(s).includes('baseline adoption verified'));
});

test('real permission search has traceable candidate/recovery decisions and shared renderers, with projected gaps', async t => {
  const f = await fixture(t), p = await pack(), file = await f.bundle(p), s = explainResult(await readResult(file));
  assert.equal(s.workflow!.reported_status, 'verified'); assert.equal(s.analysis.status, 'partial');
  assert.equal(s.tasks.reduce((n, t) => n + t.decisions.length, 0), Object.values(p.report.searches).reduce((n: number, x: any) => n + x.steps.length, 0));
  for (const task of s.tasks) {
    for (const claim of task.claims) { assert.ok(claim.evidence.length); assert.ok(claim.action.text); }
    const rejected = task.decisions.find(d => d.reported_decision === 'rejected')!;
    assert.equal(rejected.candidate, 'not_saved'); assert.equal(rejected.recovery, 'not_applicable'); assert.equal(rejected.support, 'reported_only');
    assert.ok(rejected.evidence.length); // projected search steps retain decisions, not trial linkage
  }
  assert.match(summaryMarkdown(s), /Candidate decisions and recovery evidence/); assert.match(summaryText(s), /Result overview/);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s); assert.ok(Object.isFrozen(s));
  const original = JSON.parse(await fs.readFile(file, 'utf8')); assert.deepEqual(original, p.report);
  await assertPointers(f.root, s);
});

test('verified but budget-stopped search and redundant-grant removal retain separate meanings', async t => {
  const f = await fixture(t), p = await pack(); p.report.search_complete = false; p.report.searches.test.stop = 'budget';
  const accepted = p.report.searches.test.steps.find((s: any) => s.decision === 'accepted'); accepted.semantic_change = false; accepted.operation = 'synthetic redundant removal';
  const s = explainResult(await readResult(await f.bundle(p)));
  assert.equal(s.workflow!.reported_status, 'verified'); assert.equal(taskClaim(s, 'search', 'test').status, 'budget');
  assert.equal(s.tasks.find(t => t.task === 'test')!.decisions.find(d => d.operation.state === 'recorded' && d.operation.value === accepted.operation)!.scope_change, 'reported_no_scope_change');
  assert.match(taskClaim(s, 'search', 'test').action.text, /worth its cost/); assert.match(summaryMarkdown(s), /globally minimum/);
});

test('synthetic failed recovery cannot support a rejected comparison or get hidden by workflow verified', async t => {
  const f = await fixture(t), p = await pack(), step = p.report.searches.test.steps.find((s: any) => s.decision === 'rejected');
  const candidate = p.report.trials.find((x: any) => x.scenario === 'test' && x.phase === 'candidate' && x.verdict === 'fail' && p.evidence[x.evidence]);
  const recovery = p.report.trials.find((x: any) => x.scenario === 'test' && x.phase === 'recovery' && p.evidence[x.evidence]);
  Object.assign(step, { operation: 'synthetic linked removal', trial_id: candidate.id, recovery_id: recovery.id, before: recovery.grants, after: candidate.grants });
  const trial = p.report.trials.find((x: any) => x.id === step.recovery_id), e = p.evidence[trial.evidence];
  trial.verdict = 'unknown'; e.summary.verdict = 'unknown'; e.task.process = { status: 'timeout', exit_code: null };
  const s = explainResult(await readResult(await f.bundle(p))), decision = s.tasks.find(t => t.task === 'test')!.decisions.find(d => d.recovery === 'unknown')!;
  assert.equal(decision.support, 'contradictory'); assert.match(decision.action, /unstable/);
});

test('synthetic task pass with boundary failure keeps both dimensions and questions verification', async t => {
  const f = await fixture(t), p = await pack('permission-repair-replay'), trial = p.report.trials[0], e = p.evidence[trial.evidence];
  e.after.checks[0].status = 'fail';
  const s = explainResult(await readResult(await f.bundle(p)));
  assert.equal(taskClaim(s, 'task').status, 'not_saved'); // another projected repetition lacks its sidecar
  assert.equal(taskClaim(s, 'boundaries').status, 'fail'); assert.equal(taskClaim(s, 'verification').status, 'contradictory');
  await fs.rm(path.join(f.root, 'evidence', p.report.trials[1].id + '.json'), { force: true });
});

test('synthetic exported/current policy mismatch is visible even with verified flags', async t => {
  const f = await fixture(t), p = await pack('permission-repair-replay'); p.report.policies.build = ['@workspace'];
  const s = explainResult(await readResult(await f.bundle(p)));
  assert.equal(s.workflow!.reported_status, 'verified'); assert.equal(taskClaim(s, 'verification').status, 'contradictory');
});

test('native reader validates version, object identities, roles and independently derived outcomes', async () => {
  const p = await pack('permission-repair-replay'), n = native(p); assert.deepEqual(parseNativeExecution(n), n);
  for (const change of [(x: any) => x.model_version = 2, (x: any) => x.execution.task_id = x.policy.id,
    (x: any) => x.policy.task.write.value = [], (x: any) => x.execution.outcomes.task.status = 'fail',
    (x: any) => x.task.definition.value.command[0] = 'changed']) {
    const bad = structuredClone(n); change(bad); assert.throws(() => parseNativeExecution(bad));
  }
  const bad = structuredClone(n) as any; bad.execution.outcomes.task.status = 'fail'; const { id, ...content } = bad.execution;
  bad.execution.id = objectId('execution', content); assert.throws(() => parseNativeExecution(bad), /outcomes/);
});

test('native indexed facts supplement absent legacy sidecars and single execution never becomes workflow verification', async t => {
  const f = await fixture(t), p = await pack('permission-repair-replay'), file = await f.bundle(p), entries = await index(f, p);
  for (const e of entries) await fs.rm(path.join(f.root, e.evidence));
  const r = await readResult(file); assert.equal(r.executions.filter(e => e.native).length, entries.length);
  const n = explainResult(await readResult(path.join(f.root, entries[0].facts)));
  assert.equal(n.workflow, null); assert.equal(taskClaim(n, 'task').status, 'pass'); assert.equal(taskClaim(n, 'workflow').status, 'not_saved');
  await assertPointers(path.join(f.root, 'executions'), n);
});

test('native workflow contradictions and index path substitutions are refused', async t => {
  const f = await fixture(t), p = await pack('permission-repair-replay'), file = await f.bundle(p), entries = await index(f, p);
  const bad = structuredClone(entries); bad[0].facts = '../outside.json';
  await f.write('executions/index.json', { schema_version: 1, kind: 'permsift_execution_index', entries: bad }); await assert.rejects(readResult(file), /reference/);
  await f.write('executions/index.json', { schema_version: 1, kind: 'permsift_execution_index', entries });
  p.report.trials[0].verdict = 'fail'; p.evidence[p.report.trials[0].evidence].summary.verdict = 'fail'; await f.bundle(p);
  await assert.rejects(readResult(file), /Native\/report mismatch/);
});

test('extra journal entry cannot create a completed workflow trial', async t => {
  const f = await fixture(t), p = await pack('permission-repair-replay'), file = await f.bundle(p), entries = await index(f, p);
  entries.push({ trial: 'orphan', facts: 'executions/orphan.json', evidence: 'evidence/orphan.json', execution_id: 'execution:v1:' + '0'.repeat(64) });
  await f.write('executions/index.json', { schema_version: 1, kind: 'permsift_execution_index', entries });
  const r = await readResult(file); assert.equal(r.executions.length, p.report.trials.length); assert.match(r.gaps.join(' '), /absent from the workflow/);
});

test('companion traversal, linked ancestors, linked files and invalid retained config are refused', async t => {
  const f = await fixture(t), p = await pack('permission-repair-replay');
  const bad = structuredClone(p); bad.report.trials[0].evidence = '../outside.json'; await assert.rejects(readResult(await f.bundle(bad)), /reference/);
  const file = await f.bundle(p); await fs.rm(path.join(f.root, 'evidence'), { recursive: true });
  const elsewhere = path.join(f.root, 'elsewhere'); await fs.mkdir(elsewhere); await fs.symlink(elsewhere, path.join(f.root, 'evidence'));
  await assert.rejects(readResult(file), /directory must not be a link/);
  await fs.rm(path.join(f.root, 'evidence')); await f.bundle(p); await fs.rm(path.join(f.root, 'inputs.json'));
  await f.write('real-inputs.json', p.inputs); await fs.symlink(path.join(f.root, 'real-inputs.json'), path.join(f.root, 'inputs.json')); await assert.rejects(readResult(file));
  await fs.rm(path.join(f.root, 'inputs.json')); p.inputs.config.scenarios[0].command.push('changed'); await f.write('inputs.json', p.inputs); await assert.rejects(readResult(file), /config_hash/);
});

test('regression child report with foreign task or different input does not corroborate a repair', async t => {
  const f = await fixture(t), p = await pack('permission-read-change'), child = await pack('permission-old-rule-fails');
  const file = await f.bundle(p); await f.bundle(child, 'tasks/build/old');
  let r = await readResult(file); assert.equal(r.children[0].result!.executions[0].facts.outcomes.task.status, 'fail');
  child.report.inputs.snapshot_hash = 'b'.repeat(64); await f.bundle(child, 'tasks/build/old'); await assert.rejects(readResult(file), /regression input/);
  p.report.tasks[0].stages[0].report = '/arbitrary/report.md'; await f.bundle(p); await assert.rejects(readResult(file), /stage reference/);
});

test('source capture gaps, positive observations, uncollected compiler and recorded zero bytes remain distinct', async t => {
  const f = await fixture(t), usage = JSON.parse(await fs.readFile('examples/reports/fast-glob-bundle-after.json', 'utf8'));
  const task = usage.tasks[0]; task.capture_status = 'incomplete'; task.issues.push('synthetic missing footer');
  task.bundling.packages[0].contributions[0].bytes_in_output = 0;
  // Keep the per-output fact consistent with the package aggregate validated by parseUsage.
  const contribution = task.bundling.packages[0].contributions[0], files = task.bundling.packages[0].files;
  for (const o of task.bundling.outputs.filter((o: any) => o.path === contribution.output)) for (const input of o.inputs.filter((i: any) => files.includes(i.path))) input.bytes_in_output = 0;
  const s = explainResult(await readResult(await f.write('usage.json', usage)));
  assert.equal(taskClaim(s, 'modules').status, 'incomplete'); assert.match(taskClaim(s, 'modules').statement, /2 package instance/);
  assert.equal(taskClaim(s, 'compiler').status, 'not_collected'); assert.equal(taskClaim(s, 'build').status, 'captured');
  assert.match(taskClaim(s, 'build_contribution').statement, /recorded zero-byte/); assert.ok(taskClaim(s, 'build_contribution').action.command!.includes('--package'));
});

test('old usage missing inventory and a task never observed remain explicit without inventing an empty population', async t => {
  const f = await fixture(t), usage = JSON.parse(await fs.readFile('examples/reports/fast-glob-tasks.json', 'utf8'));
  delete usage.tasks[0].inventory; usage.tasks.push({ task: 'skipped', capture_status: 'not_run', reason: 'synthetic budget exhausted' });
  const s = explainResult(await readResult(await f.write('usage.json', usage)));
  assert.equal(taskClaim(s, 'inventory').status, 'not_saved'); assert.match(taskClaim(s, 'inventory').statement, /no package count/);
  assert.equal(taskClaim(s, 'observation', 'skipped').status, 'not_run');
});

test('saved upgrade comparison survives removal of its original before/after files and never follows baseline paths', async t => {
  const f = await fixture(t), before = path.resolve('examples/reports/fast-glob-bundle-before.json'), after = path.resolve('examples/reports/fast-glob-bundle-after.json');
  const c = await compareSavedUsage(before, after); c.comparison.baseline = '/not-loaded/private/baseline.json';
  const output = path.join(f.root, 'comparison'); await saveComparison(output, c);
  const s = explainResult(await readResult(path.join(output, 'comparison.json')));
  assert.match(taskClaim(s, 'build_changes').statement, /glob-parent 5\.1\.2 → 6\.0\.2/);
  assert.match(s.claims[0].action.text, /not loaded/); assert.ok(!JSON.stringify(s).includes('safe to delete'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'summary.json'), 'utf8')), s);
});

test('overview CLI is read only, accepts report directory/native/comparison and preserves package inspection', async t => {
  const f = await fixture(t), p = await pack('permission-repair-replay'), file = await f.bundle(p), entries = await index(f, p);
  const before = await fs.readFile(file), names = (await fs.readdir(f.root)).sort();
  const expected = explainResult(await readResult(file)), r = cli('inspect', f.root, '--json');
  assert.equal(r.status, 2, r.stderr); assert.equal(r.stderr, ''); assert.deepEqual(JSON.parse(r.stdout), expected);
  assert.equal(cli('inspect', path.join(f.root, entries[0].facts), '--json').status, 2);
  assert.equal(cli('inspect', file, '--limits', 'missing').status, 2);
  assert.equal(cli('inspect', 'examples/reports/fast-glob-bundle-after.json', '--package', 'esbuild', '--json').status, 0);
  assert.deepEqual(await fs.readFile(file), before); assert.deepEqual((await fs.readdir(f.root)).sort(), names);
});

test('published summary is the exact offline projection and leads the existing Markdown while JSON stays unchanged', async t => {
  const f = await fixture(t), p = await pack('permission-repair-replay'), file = await f.bundle(p), details = '# Existing report\n';
  await fs.writeFile(path.join(f.root, 'report.md'), details); const before = await fs.readFile(file);
  const s = await publishSummary(file, path.join(f.root, 'report.md'));
  assert.deepEqual(s, explainResult(await readResult(file))); assert.deepEqual(await fs.readFile(file), before);
  assert.equal(await fs.readFile(path.join(f.root, 'summary.md'), 'utf8'), summaryMarkdown(s));
  assert.equal(await fs.readFile(path.join(f.root, 'report.md'), 'utf8'), summaryMarkdown(s) + '\n---\n\n' + details);
});

test('summary text and Markdown neutralize control/markup characters without turning commands into executable recommendations', async t => {
  const f = await fixture(t), p = await pack('permission-read-change'); p.report.tasks[0].reason = 'synthetic \u001b[31m <script> [link]';
  const s = explainResult(await readResult(await f.bundle(p)));
  assert.ok(!summaryText(s).includes('\u001b')); assert.ok(!summaryMarkdown(s).includes('<script>'));
});
