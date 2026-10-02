import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Report } from '../../src/experiment-report.js';
import type { NativeExecution } from '../../src/model/native.js';
import { adaptExperiment } from '../../src/model/legacy.js';
import { evaluateBoundaries, evaluateTask } from '../../src/model/conclusions.js';

export async function assertNativeEvidence(report: Report) {
  const index = JSON.parse(await fs.readFile(path.join(report.output, 'executions/index.json'), 'utf8')) as { entries: { trial: string; facts: string; evidence: string; execution_id: string }[] };
  assert.equal(index.entries.length, report.trials.length);
  const inputs = JSON.parse(await fs.readFile(path.join(report.output, 'inputs.json'), 'utf8'));
  const evidence = Object.fromEntries(await Promise.all(report.trials.map(async t => [t.evidence, JSON.parse(await fs.readFile(path.join(report.output, t.evidence), 'utf8'))])));
  // The adapter accepts retained JSON, not runtime objects with optional undefined members.
  const imported = adaptExperiment(JSON.parse(JSON.stringify(report)), { inputs, evidence });
  const records: NativeExecution[] = [];
  for (const trial of report.trials) {
    const entry = index.entries.find(e => e.trial === trial.id)!;
    assert.ok(entry); assert.equal(entry.evidence, trial.evidence);
    const facts: NativeExecution = JSON.parse(await fs.readFile(path.join(report.output, entry.facts), 'utf8'));
    records.push(facts);
    assert.equal(facts.kind, 'permsift_execution'); assert.equal(facts.execution.id, entry.execution_id);
    assert.equal(facts.execution.task_id, facts.task.id); assert.equal(facts.execution.agreement_id, facts.agreement.id);
    assert.deepEqual(facts.execution.policy_id, { state: 'recorded', value: facts.policy.id });
    assert.deepEqual(facts.execution.reported_verdict, { state: 'recorded', value: trial.verdict });
    assert.equal(facts.execution.conditions.input_hash.state === 'recorded' && facts.execution.conditions.input_hash.value, report.inputs.snapshot_hash);
    const old = imported.executions.find(e => e.origin.record === trial.evidence)!;
    assert.equal(facts.task.id, old.task_id);
    assert.equal(facts.agreement.id, old.agreement_id); assert.deepEqual(facts.execution.policy_id, old.policy_id);
    if (old.process.state === 'recorded') assert.deepEqual(facts.execution.process, old.process);
    assert.deepEqual(facts.execution.outcomes.task, evaluateTask(facts.execution.process, facts.execution.assertions));
    assert.equal(facts.execution.outcomes.boundaries.status, old.outcomes.boundaries.status);
    const required = inputs.config.scenarios.find((s: { id: string }) => s.id === trial.scenario).install ? trial.installation_reused ? ['before', 'before_offline_task', 'after'] as const : ['before', 'after_installation', 'before_offline_task', 'after'] as const : ['before', 'after'] as const;
    assert.deepEqual(facts.execution.outcomes.boundaries, evaluateBoundaries(facts.execution.boundaries, [...required]));
    if (evidence[trial.evidence].task) assert.equal(facts.execution.conditions.actual_command.state, 'recorded');
    else if (facts.execution.conditions.actual_command.state === 'not_run') assert.equal(facts.execution.process.state, 'not_run');
    assert.equal(facts.agreement.declaration.state, 'not_declared');
  }
  return records;
}
