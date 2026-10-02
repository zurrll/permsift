import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scenarioSchema, limitsSchema } from '../src/config.js';
import { executionRequest } from '../src/execution-request.js';
import type { ExecutionResult } from '../src/execute-once.js';
import { nativeExecution } from '../src/model/native.js';
import { ExecutionJournal } from '../src/execution-journal.js';
import { phaseVerdict, type ExecutionPhase } from '../src/execution-phase.js';
import { saveJson } from '../src/filesystem.js';
import { adaptExperiment } from '../src/model/legacy.js';

const digest = 'a'.repeat(64);
function input() {
  return { scenario: scenarioSchema.parse({ id: 'build', command: ['node', 'build.cjs'], initial_write_grants: ['@workspace/dist'], initial_read_grants: ['@workspace/build.cjs'], assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }] }),
    policy: { write: ['@workspace/dist'], read: ['@workspace/build.cjs'], readMode: 'explicit' as const, network: [], installWrite: ['@workspace/dist'] },
    conditions: { input: { path: '/tmp/input', hash: digest }, configHash: digest, limitsHash: digest, scenarioHash: digest, environment: { node: process.version }, preparation: ['@workspace/dist'] },
    limits: limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace/dist'], allowed_read_roots: ['@workspace/build.cjs'] }),
    sources: { inputDirectories: false, installedDirectories: false, afterTaskDirectories: false, readInventory: false, dependencies: false, installedState: false },
    workspace: { kind: 'input' as const }, budget: { deadline: Date.now() + 10000 },
    resources: { scratch: '/tmp/trials', protectedPaths: ['/tmp/project'], fixtures: { secret: '/tmp/secret', outside: '/tmp/outside', report: '/tmp/report', marker: 'fake', port: 12345 }, readProbeDirectories: [''] } };
}
const result = (): ExecutionResult => ({ id: 'trial', verdict: 'unknown', duration_ms: 1, details: {}, installationAttempted: false, installationReused: false });
const origin = { producer_id: 'experiment', record: 'executions/trial.json', phase: 'baseline' };

test('executable requests reject missing commands, absent fields and grants outside each trusted ceiling', () => {
  const valid = input(); executionRequest(valid);
  const changes: ((v: ReturnType<typeof input>) => void)[] = [v => v.scenario.command = [],
    v => v.policy.write = ['@workspace'], v => v.policy.read = ['@workspace'],
    v => v.policy.network = ['example.com'] as never[], v => v.conditions.preparation = ['@cache'],
    v => v.policy.write.push('@workspace/dist'), v => v.conditions.input.hash = 'missing'];
  for (const change of changes) {
    const bad = input(); change(bad); assert.throws(() => executionRequest(bad));
  }
  assert.throws(() => executionRequest({ ...valid, policy: { ...valid.policy, write: undefined } } as never));
});

test('execution requests own immutable task, policy, preparation and source selections', () => {
  const source = input(), request = executionRequest(source);
  source.scenario.command[0] = 'changed'; source.policy.write.length = 0; source.conditions.preparation.push('@tmp'); source.sources.dependencies = true;
  assert.equal(request.task.command[0], 'node'); assert.deepEqual(request.policy.write, ['@workspace/dist']);
  assert.deepEqual(request.conditions.preparation, ['@workspace/dist']); assert.equal(request.sources.dependencies, false);
  assert.ok(Object.isFrozen(request.definition)); assert.ok(Object.isFrozen(request.plan));
  assert.equal('narrower_candidates' in request.task, false); assert.equal('auto_discover' in request.task, false);
});

test('snapshot-only and capture requests require a separate installation; shared stage writes cannot diverge', () => {
  const source = input();
  assert.throws(() => executionRequest({ ...source, capture: { key: digest, directory: '/tmp/snapshots' } }));
  assert.throws(() => executionRequest({ ...source, workspace: { kind: 'installed', snapshot: { key: digest, roots: { workspace: '/tmp/a', cache: '/tmp/b', tmp: '/tmp/c' }, hashes: { workspace: digest, cache: digest, tmp: digest }, source_trial: 'x' } } }));
  assert.throws(() => executionRequest({ ...source, policy: { ...source.policy, installWrite: [] } }));
});

test('native facts distinguish an unexecuted task from installation process diagnostics', () => {
  const request = executionRequest(input()), r = result();
  r.details.task_skipped = 'installation did not pass'; r.execution_stage = 'install';
  const facts = nativeExecution(request, r, origin);
  assert.equal(facts.execution.process.state, 'not_run'); assert.equal(facts.execution.outcomes.task.status, 'not_run');
  assert.equal(facts.execution.conditions.actual_command.state, 'not_run');
  assert.equal(facts.execution.observations.modules.status, 'not_collected');
  assert.equal(facts.agreement.declaration.state, 'not_declared');
  assert.equal('baselines' in facts, false, 'Successful execution does not imply adoption');
});

test('native actual command and resolved read types have independent identities and survive serialization', () => {
  const request = executionRequest(input()), r = result();
  r.actualCommand = ['node', 'build.cjs', '--explainFiles']; r.details.read_grant_kinds = { '@workspace/build.cjs': 'file' };
  const facts = nativeExecution(request, r, origin), again = nativeExecution(request, r, origin);
  assert.deepEqual(facts, again); assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts);
  assert.deepEqual(facts.execution.conditions.actual_command, { state: 'recorded', value: r.actualCommand });
  assert.equal(facts.execution.process.state, 'not_saved', 'An issued command without process facts cannot be called unexecuted');
  assert.notEqual(facts.policy.id, request.plan.id, 'A resolved target is not an unresolved policy condition');
  assert.equal(facts.task.id, request.definition.id); assert.equal(facts.execution.task_id, facts.task.id);
  assert.deepEqual(facts.execution.policy_id, { state: 'recorded', value: facts.policy.id });
  r.actualCommand[0] = 'changed'; assert.equal(facts.execution.conditions.actual_command.state === 'recorded' && facts.execution.conditions.actual_command.value[0], 'node');
});

test('a complete task and unknown boundaries retain separate native conclusions', async () => {
  const pack = JSON.parse(await fs.readFile('examples/model-cases/current-demo.json', 'utf8'));
  const e = Object.values(pack.evidence)[0] as ExecutionResult['details'];
  const r = result(); r.details = structuredClone(e); r.verdict = 'unknown';
  r.details.after!.checks[0].status = 'unknown';
  const facts = nativeExecution(executionRequest(input()), r, origin);
  assert.equal(facts.execution.outcomes.task.status, 'pass'); assert.equal(facts.execution.outcomes.boundaries.status, 'unknown');
  assert.deepEqual(facts.execution.reported_verdict, { state: 'recorded', value: 'unknown' });
});

test('native and imported task, agreement and policy identities match across real retained fixtures', async () => {
  for (const name of ['current-demo', 'staged-warm', 'current-observe']) {
    const pack = JSON.parse(await fs.readFile(`examples/model-cases/${name}.json`, 'utf8'));
    const imported = adaptExperiment(pack.report, { inputs: pack.inputs, evidence: pack.evidence });
    const retained = pack.report.trials.filter((trial: { evidence: string }) => pack.evidence[trial.evidence]);
    assert.ok(retained.length > 0);
    for (const trial of retained) {
      const source = input(), e = pack.evidence[trial.evidence];
      source.scenario = scenarioSchema.parse(pack.inputs.config.scenarios.find((s: { id: string }) => s.id === trial.scenario));
      source.limits = limitsSchema.parse(pack.inputs.limits);
      const request = executionRequest({ ...source,
        policy: { write: trial.grants, read: trial.read_grants, readMode: trial.read_mode, network: trial.network_grants ?? [], installWrite: trial.install_grants ?? trial.grants },
        conditions: { ...source.conditions, preparation: e.prepared_directories, input: { ...source.conditions.input, hash: pack.report.inputs.snapshot_hash }, environment: pack.report.environment },
        resources: { ...source.resources, installInput: pack.report.inputs.installations?.[trial.scenario] } });
      const r = { ...result(), id: trial.id, verdict: trial.verdict, details: e, installationReused: !!trial.installation_reused, observation: e.dependency_observation };
      const native = nativeExecution(request, r, { ...origin, record: trial.evidence });
      const old = imported.executions.find(e => e.origin.record === trial.evidence)!;
      assert.equal(native.task.id, old.task_id); assert.equal(native.agreement.id, old.agreement_id); assert.deepEqual(native.execution.policy_id, old.policy_id);
    }
  }
});

test('phase consumers conservatively handle missing trials, boundary failures and unfinished workflows', () => {
  const phase: ExecutionPhase = { status: 'verified', baselineVerified: true, finalVerified: true, taskKeys: ['build'], trials: [], observations: {} };
  assert.equal(phaseVerdict(phase), 'unknown'); phase.trials.push({ id: 'x', verdict: 'pass' }); assert.equal(phaseVerdict(phase), 'pass');
  phase.status = 'incomplete'; assert.equal(phaseVerdict(phase), 'unknown'); phase.status = 'failed'; phase.trials[0].verdict = 'fail'; assert.equal(phaseVerdict(phase), 'fail');
  phase.trials[0].diagnosis = { kind: 'boundary_failure', denials: [], failed_assertions: [], boundary_issues: ['check failed'], stderr_excerpt: '', limitations: [] } as never;
  assert.equal(phaseVerdict(phase), 'unknown');
});

test('journal persists both artifacts and index before a result can become usable', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-journal-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'evidence')); await fs.mkdir(path.join(root, 'executions'));
  const facts = nativeExecution(executionRequest(input()), result(), origin), journal = new ExecutionJournal(root);
  let committed = false;
  await journal.record({ id: 'trial', evidence: 'evidence/trial.json' }, { retained: true }, facts, async () => {
    const index = JSON.parse(await fs.readFile(path.join(root, 'executions/index.json'), 'utf8'));
    assert.equal(index.entries.length, 1); assert.equal(index.entries[0].execution_id, facts.execution.id);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, index.entries[0].facts), 'utf8')), facts);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, index.entries[0].evidence), 'utf8')), { retained: true }); committed = true;
  });
  assert.equal(committed, true);
});

for (const failure of ['evidence', 'facts', 'index', 'checkpoint']) test(`journal ${failure} failure does not release a result or start the next trial`, async () => {
  let calls = 0, released = false, checkpointed = false, nextTrial = false;
  const failAt = { evidence: 1, facts: 2, index: 3, checkpoint: 4 }[failure];
  const journal = new ExecutionJournal('/tmp/not-written', async () => { if (++calls === failAt) throw new Error('injected write failure'); });
  const work = async () => {
    await journal.record({ id: 'trial', evidence: 'evidence/trial.json' }, {}, nativeExecution(executionRequest(input()), result(), origin), async () => { checkpointed = true; if (failAt === 4) throw new Error('injected checkpoint failure'); });
    released = true; nextTrial = true;
  };
  await assert.rejects(work, /injected/); assert.equal(released, false); assert.equal(nextTrial, false);
  assert.equal(checkpointed, failure === 'checkpoint');
});

test('real filesystem journal failure preserves existing evidence and skips the workflow checkpoint', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-journal-fail-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'evidence')); await fs.writeFile(path.join(root, 'executions'), 'blocked directory');
  let checkpointed = false;
  await assert.rejects(new ExecutionJournal(root, saveJson).record({ id: 'trial', evidence: 'evidence/trial.json' }, { retained: true }, nativeExecution(executionRequest(input()), result(), origin), async () => { checkpointed = true; }));
  assert.equal(checkpointed, false); assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'evidence/trial.json'), 'utf8')), { retained: true });
});
