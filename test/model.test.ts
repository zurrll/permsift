import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { adaptLegacy, adaptExperiment, adaptUsage, compareModels, evaluateTask, evaluateBoundaries, readLegacyJson } from '../src/model/index.js';
import { recorded, missing, legacyHash, semanticHash, objectId, finishModel } from '../src/model/identity.js';
import { configSchema } from '../src/config.js';
import { taskDefinition } from '../src/model/legacy.js';
import type { Check } from '../src/assertions.js';

// Mutable fixture data is deliberately used only to construct labelled synthetic counterexamples.
type Pack = { report: any; inputs: any; evidence: Record<string, any> };
const pack = async (name: string): Promise<Pack> => JSON.parse(await fs.readFile('examples/model-cases/' + name + '.json', 'utf8'));
const adapt = (p: Pack) => adaptLegacy(p.report, { inputs: p.inputs, evidence: p.evidence });
const rehash = (p: Pack) => { p.report.inputs.config_hash = legacyHash(p.inputs.config); };
const pass: Check = { name: 'check', status: 'pass', detail: 'synthetic expectation' };
const fail: Check = { ...pass, status: 'fail' }, unknown: Check = { ...pass, status: 'unknown' };

test('real compatibility corpus preserves old verdicts/hashes and explicitly retains missing data', async () => {
  const manifest = JSON.parse(await fs.readFile('examples/model-cases/manifest.json', 'utf8'));
  for (const item of manifest.cases) {
    const p = await pack(item.case), snapshot = JSON.stringify(p), a = adapt(p), b = adapt(p);
    assert.deepEqual(a, b); assert.equal(JSON.stringify(p), snapshot);
    assert.equal(a.source.recorded_hashes.config.state, 'recorded');
    if (a.source.recorded_hashes.config.state === 'recorded') assert.equal(a.source.recorded_hashes.config.value, p.report.inputs.config_hash);
    assert.ok(a.agreements.every(g => g.declaration.state === 'not_declared'));
    assert.ok(a.baselines.every(g => g.adoption === 'not_recorded'));
    assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.tasks[0]));
    if (Array.isArray(p.report.trials)) {
      assert.equal(a.executions.length, p.report.trials.length);
      for (const e of a.executions) {
        const trial = p.report.trials.find((t: any) => t.evidence === e.origin.record);
        assert.deepEqual(e.reported_verdict, recorded(trial.verdict));
        if (!p.evidence[trial.evidence]) assert.equal(e.outcomes.task.status, 'not_saved');
      }
    }
  }
});

test('task, assertions and boundaries have independent conclusions, including unknown and skipped states', () => {
  const completed = recorded({ status: 'completed', exit_code: 0 });
  assert.equal(evaluateTask(completed, recorded([pass])).status, 'pass');
  assert.equal(evaluateTask(completed, recorded([fail])).status, 'fail');
  assert.equal(evaluateTask(completed, recorded([unknown])).status, 'unknown');
  assert.equal(evaluateTask(completed, recorded([])).status, 'unknown');
  assert.equal(evaluateTask(completed, missing('not_saved', 'checks omitted')).status, 'not_saved');
  assert.equal(evaluateTask(recorded({ status: 'completed', exit_code: 1 }), recorded([unknown])).status, 'fail');
  assert.equal(evaluateTask(recorded({ status: 'timeout', exit_code: null }), recorded([pass])).status, 'unknown');
  assert.equal(evaluateTask(missing('not_run', 'install failed'), recorded([])).status, 'not_run');
  assert.equal(evaluateBoundaries(recorded([{ stage: 'before', checks: [pass] }])).status, 'unknown');
  assert.equal(evaluateBoundaries(recorded([{ stage: 'before', checks: [pass] }, { stage: 'after', checks: [fail] }])).status, 'fail');
  assert.equal(evaluateBoundaries(recorded([{ stage: 'before', checks: [fail] }, { stage: 'after', checks: [unknown] }])).status, 'unknown');
});

test('synthetic boundary failure does not change a passing task into a task failure', async () => {
  const p = await pack('permission-repair-replay'), trial = p.report.trials[0], e = p.evidence[trial.evidence];
  trial.verdict = 'fail'; e.summary.verdict = 'fail'; e.after.checks[0].status = 'fail';
  const result = adapt(p).executions.find(x => x.origin.record === trial.evidence)!;
  assert.equal(result.reported_verdict.state === 'recorded' && result.reported_verdict.value, 'fail');
  assert.equal(result.outcomes.task.status, 'pass'); assert.equal(result.outcomes.boundaries.status, 'fail');
});

test('finalized evidence summary validates the stale pre-execution copy; mismatched references are rejected', async () => {
  const p = await pack('current-demo'), file = Object.keys(p.evidence)[0], e = p.evidence[file];
  assert.equal(e.verdict, 'unknown'); assert.equal(e.summary.verdict, 'pass'); adapt(p);
  for (const mutate of [(x: Pack) => x.evidence[file].scenario = 'build',
    (x: Pack) => x.evidence[file].summary.verdict = 'fail',
    (x: Pack) => x.evidence[file].grants = [],
    (x: Pack) => x.evidence['not-a-trial'] = x.evidence[file],
    (x: Pack) => x.report.trials.push(x.report.trials[0])]) {
    const bad = structuredClone(p); mutate(bad); assert.throws(() => adapt(bad));
  }
});

test('historical hashes are checked before current defaults; semantic identities cannot rewrite them', async () => {
  const p = await pack('permission-repair-replay');
  const raw = p.inputs.config.scenarios[0]; delete raw.auto_discover; delete raw.narrower_candidates;
  rehash(p); const result = adapt(p);
  assert.equal(result.source.inputs_status, 'matched');
  assert.notEqual(legacyHash(p.inputs.config), legacyHash(configSchema.parse(p.inputs.config)));
  assert.notEqual(legacyHash(p.inputs.config), semanticHash(p.inputs.config));
  const bad = structuredClone(p); bad.inputs.config.scenarios[0].command.push('altered'); assert.throws(() => adapt(bad), /config_hash/);
  const badLimits = structuredClone(p); badLimits.inputs.limits.repetitions++; assert.throws(() => adapt(badLimits), /limits_hash/);
});

test('task identities ignore grant ordering, project input and timeout, while preserving command argument ordering', async () => {
  const p = await pack('current-demo'), scenario = configSchema.parse(p.inputs.config).scenarios[0];
  const id = taskDefinition(scenario.id, scenario).id;
  assert.equal(taskDefinition(scenario.id, { ...scenario, timeout_seconds: 600, initial_write_grants: [] }).id, id);
  const assertion = scenario.assertions[0]; assert.ok('expected_tests' in assertion);
  assert.equal(taskDefinition(scenario.id, { ...scenario, assertions: [{ ...assertion, expected_tests: [...assertion.expected_tests].reverse() }] }).id, id);
  assert.notEqual(taskDefinition(scenario.id, { ...scenario, command: [...scenario.command].reverse() }).id, id);
  const changed = structuredClone(p); changed.report.inputs.snapshot_hash = 'a'.repeat(64);
  changed.inputs.config.scenarios[0].timeout_seconds++; rehash(changed);
  const compared = compareModels(adapt(p), adapt(changed));
  assert.equal(compared.input, 'changed'); assert.equal(compared.tasks[1].definition, 'same');
  assert.equal(compared.tasks.find(t => t.key === 'test')!.execution_conditions, 'changed');
  const reordered = structuredClone(p);
  for (const t of reordered.report.trials) t.grants.reverse();
  for (const e of Object.values(reordered.evidence)) { e.grants.reverse(); e.summary.grants.reverse(); }
  for (const key of Object.keys(reordered.report.policies)) reordered.report.policies[key].reverse();
  assert.deepEqual(adapt(p).policies.map(x => x.id).sort(), adapt(reordered).policies.map(x => x.id).sort());
});

test('synthetic success-condition change remains reviewable even if the producer reports verified', async () => {
  const p = await pack('permission-repair-replay'), next = structuredClone(p);
  next.inputs.config.scenarios[0].assertions[0].value = 'new success condition'; rehash(next);
  const after = adapt(next); assert.equal(after.workflow.reported_status, 'verified');
  const row = compareModels(adapt(p), after).tasks[0];
  assert.equal(row.definition, 'changed'); assert.ok(row.review_reasons.some(s => s.includes('original agreement')));
  assert.equal(row.agreement, 'not_declared'); assert.equal(after.baselines.length, 0);
});

test('verified policies and budget-stopped searches coexist; recovery unknown does not become a task pass', async () => {
  const p = await pack('current-demo'); p.report.search_complete = false;
  p.report.searches.test.stop = 'budget';
  const m = adapt(p); assert.equal(m.workflow.reported_status, 'verified'); assert.deepEqual(m.workflow.search_complete, recorded(false));
  assert.ok(m.workflow.review_reasons.some(s => s.includes('budget')));
  const recovery = p.report.trials.find((t: any) => t.phase === 'recovery' && p.evidence[t.evidence]);
  assert.ok(recovery); recovery.verdict = 'unknown';
  p.evidence[recovery.evidence].summary.verdict = 'unknown'; p.evidence[recovery.evidence].task.process = { status: 'timeout', exit_code: null };
  assert.equal(adapt(p).executions.find(e => e.origin.record === recovery.evidence)!.outcomes.task.status, 'unknown');
});

test('read file-to-directory changes affect the plan, not the task definition; partial retention stays uncertain', async () => {
  const p = await pack('permission-repair-replay'), next = structuredClone(p);
  for (const e of Object.values(next.evidence)) e.read_grant_kinds['@workspace/build.cjs'] = 'directory';
  const row = compareModels(adapt(p), adapt(next)).tasks[0];
  assert.equal(row.definition, 'same'); assert.equal(row.policies, 'changed');
  assert.equal(compareModels(adapt(p), adaptExperiment(p.report)).tasks[0].policies, 'not_saved');
  const bad = structuredClone(p); Object.values(bad.evidence)[0].read_grant_kinds['@workspace/extra'] = 'file';
  assert.throws(() => adapt(bad), /target kinds/);
});

test('installation is distinct from the offline task, including reused installation and skipped task', async () => {
  const p = await pack('staged-warm'), model = adapt(p);
  const fresh = model.executions.find(e => e.installation.state === 'recorded')!, reused = model.executions.find(e => e.installation.state === 'not_run')!;
  assert.ok(fresh); assert.ok(reused); assert.equal(reused.outcomes.task.status, 'pass');
  const current = model.policies.find(p => p.id === model.workflow.current_policies[0].policy_id)!;
  assert.deepEqual(current.task.network, recorded([])); assert.equal(current.installation.state, 'recorded');
  if (current.installation.state === 'recorded') {
    assert.equal(current.installation.value.mode, 'separate'); assert.equal(current.installation.value.reads, 'producer_fixed_workspace_reads');
    assert.notDeepEqual(current.task.write, recorded(current.installation.value.write));
  }
  const next = structuredClone(p), file = fresh.origin.record, e = next.evidence[file];
  next.report.trials.find((t: any) => t.evidence === file).verdict = 'fail'; e.summary.verdict = 'fail';
  delete e.task; delete e.assertions; e.task_skipped = 'Synthetic installation failed';
  e.installation.execution.process.exit_code = 1; e.installation.verdict = 'fail';
  const skipped = adapt(next).executions.find(x => x.origin.record === file)!;
  assert.equal(skipped.outcomes.task.status, 'not_run'); assert.equal(skipped.installation.state, 'recorded');
});

test('synthetic passing checks without controls or an installation transition remain inconclusive', async () => {
  const p = await pack('permission-repair-replay'), file = Object.keys(p.evidence)[0];
  assert.equal(adapt(p).executions.find(e => e.origin.record === file)!.outcomes.boundaries.status, 'pass');
  p.evidence[file].after.checks = p.evidence[file].after.checks.filter((c: Check) => !c.name.startsWith('control:'));
  assert.equal(adapt(p).executions.find(e => e.origin.record === file)!.outcomes.boundaries.status, 'unknown');
  const staged = await pack('staged-warm');
  const freshFile = Object.keys(staged.evidence).find(f => staged.evidence[f].installation)!;
  delete staged.evidence[freshFile].after_installation;
  assert.equal(adapt(staged).executions.find(e => e.origin.record === freshFile)!.outcomes.boundaries.status, 'unknown');
});

test('current experiment observation links to its own trial and retains instrumentation independently', async () => {
  const p = await pack('current-observe'), m = adapt(p);
  const api = m.executions.find(e => e.observations.records.state === 'recorded')!;
  assert.equal(api.outcomes.task.status, 'pass'); assert.equal(api.observations.modules.status, 'captured');
  assert.equal(api.conditions.instrumentation.state, 'recorded');
  if (api.conditions.instrumentation.state === 'recorded') assert.equal((api.conditions.instrumentation.value.producer_observer as any).internal_write_exception, '@tmp/.permsift-observer/logs');
  assert.ok(m.executions.some(e => e.observations.modules.status === 'not_saved'));
  const bad = structuredClone(p); bad.report.dependency_observations.api.trial = p.report.trials.find((t: any) => t.scenario !== 'api').id;
  assert.throws(() => adapt(bad), /different or missing/);
  const synthetic = structuredClone(p), file = api.origin.record;
  synthetic.evidence[file].observer.compilation = { source: 'typescript_explain_files', output: 'same execution stdout', executed_command: ['node', 'tsc', '--explainFiles'] };
  assert.deepEqual(adapt(synthetic).executions.find(e => e.origin.record === file)!.conditions.actual_command, recorded(['node', 'tsc', '--explainFiles']));
  const lostSource = structuredClone(p);
  lostSource.inputs.config.scenarios.find((s: any) => s.id === 'api').observation = { typescript: { compiler: '@workspace/node_modules/typescript' } };
  rehash(lostSource);
  lostSource.report.dependency_observations.api.task_definition_hash = legacyHash(lostSource.inputs.config.scenarios.find((s: any) => s.id === 'api'));
  assert.equal(adapt(lostSource).executions.find(e => e.origin.record === file)!.observations.compiler.status, 'not_saved');
});

test('synthetic declaration and environment changes stay distinct from task and policy changes', async () => {
  const p = await pack('permission-repair-replay'), a = adapt(p), b = structuredClone(a);
  const previousAgreement = b.agreements[0].id;
  b.agreements[0].declaration = recorded([{ key: 'secret', target: '@workspace/secret.json', target_kind: 'file', operation: 'read', stage: 'task', expected: 'denied' }]);
  b.agreements[0].id = objectId('agreement', { key: b.agreements[0].task_key, declaration: b.agreements[0].declaration });
  for (const e of b.executions) if (e.agreement_id === previousAgreement) {
    e.agreement_id = b.agreements[0].id;
    const { id: _, ...facts } = e; e.id = objectId('execution', facts);
  }
  const row = compareModels(a, finishModel(b)).tasks[0];
  assert.equal(row.agreement, 'changed'); assert.equal(row.definition, 'same'); assert.equal(row.policies, 'same');
  const changedEnvironment = structuredClone(p); changedEnvironment.report.environment.node = 'v22.0.0';
  const comparison = compareModels(a, adapt(changedEnvironment));
  assert.equal(comparison.environment, 'changed'); assert.equal(comparison.tasks[0].definition, 'same');
});

test('regression stages remain aggregates and a verified suggestion is not adopted', async () => {
  const repaired = adapt(await pack('permission-read-change')), error = adapt(await pack('permission-code-error'));
  assert.equal(repaired.executions.length, 0); assert.equal(repaired.workflow.comparisons[0].stages.at(-1)!.trials, 3);
  assert.deepEqual(repaired.workflow.comparisons[0].suggestion_verified, recorded(true));
  assert.equal(repaired.baselines[0].selection, 'comparison_reference'); assert.equal(repaired.baselines[0].adoption, 'not_recorded');
  assert.equal(error.workflow.comparisons[0].reported_status, 'unresolved_failure');
  assert.equal(error.workflow.comparisons[0].suggestion_policy.state, 'not_saved');
  assert.ok(error.workflow.comparisons[0].stages.every(s => s.reported_verdict === 'fail'));
});

test('usage facts keep collection completeness separate from producer verdict and unretained execution details', async () => {
  const raw = JSON.parse(await fs.readFile('examples/reports/fast-glob-tasks.json', 'utf8'));
  const model = adaptUsage(raw);
  assert.equal(model.executions[0].reported_verdict.state, 'recorded'); assert.equal(model.executions[0].outcomes.task.status, 'not_saved');
  assert.equal(model.executions[0].observations.modules.status, 'captured'); assert.equal(model.executions[0].observations.compiler.status, 'not_collected');
  raw.tasks[0].verdict = 'fail'; raw.tasks[1].capture_status = 'incomplete'; raw.tasks[1].issues = ['Synthetic lost collector output'];
  const next = adaptUsage(raw); assert.deepEqual(next.executions[0].reported_verdict, recorded('fail'));
  assert.equal(next.executions[0].observations.modules.status, 'captured'); assert.equal(next.executions[1].observations.modules.status, 'incomplete');
  assert.equal(next.executions[1].reported_verdict.state === 'recorded' && next.executions[1].reported_verdict.value, 'pass');
  const skipped = structuredClone(raw); skipped.tasks[0] = { task: raw.tasks[0].task, capture_status: 'not_run', reason: 'Synthetic preflight failed' };
  assert.equal(adaptUsage(skipped).executions[0].outcomes.task.status, 'not_run');
  const absentInventory = structuredClone(raw); delete absentInventory.tasks[0].inventory;
  assert.equal(adaptUsage(absentInventory).executions[0].observations.inventory.status, 'not_saved');
  raw.tasks[0].task_definition_hash = 'b'.repeat(64);
  const comparison = compareModels(model, adaptUsage(raw)).tasks[0];
  assert.equal(comparison.definition, 'not_saved'); assert.equal(comparison.legacy_scenario_fingerprint, 'changed');
});

test('final models reject cross-task references and unsupported identity-version comparison', async () => {
  const m = structuredClone(adapt(await pack('current-demo')));
  m.executions[0].agreement_id = m.agreements[1].id;
  assert.throws(() => finishModel(m), /different or missing/);
  const invalidRole = structuredClone(adapt(await pack('current-demo')));
  invalidRole.workflow.current_policies.push(invalidRole.workflow.current_policies[0]);
  assert.throws(() => finishModel(invalidRole), /Duplicate current policy role/);
  const a = adapt(await pack('permission-repair-replay')), b = structuredClone(a);
  (b as unknown as { identity_version: number }).identity_version = 2;
  assert.throws(() => compareModels(a, b), /explicit migration/);
  assert.throws(() => { (a.tasks[0] as { key: string }).key = 'changed'; }, TypeError);
});

test('bounded artifact loading refuses directories, symlinks and oversized files without following report references', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-model-'));
  try {
    const file = path.join(root, 'data.json'); await fs.writeFile(file, JSON.stringify({ baseline: '/unavailable/not-followed' }));
    assert.deepEqual(await readLegacyJson(file), { baseline: '/unavailable/not-followed' });
    const link = path.join(root, 'link.json'); await fs.symlink(file, link); await assert.rejects(readLegacyJson(link));
    await assert.rejects(readLegacyJson(root));
    const big = path.join(root, 'big.json'); const handle = await fs.open(big, 'w'); await handle.truncate(32_000_001); await handle.close();
    await assert.rejects(readLegacyJson(big), /at most 32 MB/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
