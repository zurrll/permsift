// Offline migration rehearsal: saved facts only, no backend or project invocation.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { adaptLegacy, compareModels, readLegacyJson } from '../dist/src/model/index.js';
import { semanticHash } from '../dist/src/model/identity.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
process.chdir(repository);
await fs.mkdir('.permsift', { recursive: true });
const root = await fs.mkdtemp(path.join(repository, '.permsift/model-replay-'));
const manifest = await readLegacyJson('examples/model-cases/manifest.json');
const models = new Map(), results = [], start = performance.now();
for (const item of manifest.cases) {
  const input = await readLegacyJson(path.join('examples/model-cases', item.file)), hash = semanticHash(input);
  const model = adaptLegacy(input.report, { inputs: input.inputs, evidence: input.evidence });
  assert.deepEqual(adaptLegacy(input.report, { inputs: input.inputs, evidence: input.evidence }), model);
  assert.equal(semanticHash(input), hash); models.set(item.case, model);
  await fs.writeFile(path.join(root, item.case + '.model.json'), JSON.stringify(model, null, 2) + '\n');
  results.push({ case: item.case, tasks: model.tasks.length, executions: model.executions.length,
    retained_task_passes: model.executions.filter(e => e.outcomes.task.status === 'pass').length,
    unretained_task_results: model.executions.filter(e => e.outcomes.task.status === 'not_saved').length,
    source_artifact_hash: model.source.artifact_hash, source_unchanged: true });
}
const repaired = models.get('permission-read-change'), error = models.get('permission-code-error');
assert.equal(repaired.workflow.comparisons[0].reported_status, 'permission_change');
assert.equal(repaired.workflow.comparisons[0].suggestion_verified.value, true);
assert.equal(repaired.baselines[0].adoption, 'not_recorded');
assert.equal(error.workflow.comparisons[0].reported_status, 'unresolved_failure');
assert.ok(error.workflow.comparisons[0].stages.every(s => s.reported_verdict === 'fail'));
assert.equal(models.get('permission-old-rule-fails').executions[0].outcomes.task.status, 'fail');
assert.equal(models.get('permission-wide-rule-fails').executions[0].outcomes.task.status, 'fail');
const permissionComparison = compareModels(models.get('permission-baseline'), models.get('permission-repair-replay'));
assert.equal(permissionComparison.input, 'changed');
assert.equal(permissionComparison.tasks[0].definition, 'same');
assert.equal(permissionComparison.tasks[0].policies, 'changed');
const usageFiles = ['fast-glob-tasks.json', 'fast-glob-bundle-before.json', 'fast-glob-bundle-after.json'];
for (const name of usageFiles) {
  const raw = await readLegacyJson(path.join('examples/reports', name));
  const model = adaptLegacy(raw); models.set(name, model);
  assert.ok(model.executions.every(e => e.outcomes.task.status === 'not_saved'));
  await fs.writeFile(path.join(root, name.replace('.json', '.model.json')), JSON.stringify(model, null, 2) + '\n');
}
const compilerTasks = models.get(usageFiles[0]).executions;
assert.ok(compilerTasks.every(e => e.observations.compiler.status === 'not_collected'));
const bundleComparison = compareModels(models.get(usageFiles[1]), models.get(usageFiles[2]));
const summary = { root, identity_version: 1, model_version: 1, wall_ms: performance.now() - start, task_executions: 0, installations: 0,
  fixtures: results, permission_comparison: permissionComparison, bundle_condition_comparison: bundleComparison,
  questions: {
    permissions: 'Added source read fails under old rules; verified repair passes replay. Both old and wider rules fail for ordinary code error. Suggestions have no adoption record.',
    observation: 'The same saved source records remain available independently: cross-task Node load location and bundle contribution/version differences are checked by offline:verify.',
  }, limitations: ['This validates retained record interpretation, not new sandbox behavior.', 'Selected sidecars were retained; other task details are explicitly not_saved.',
    'Usage-only samples retain source facts and composite verdicts, not independently evaluable process/check details.'] };
await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log('Model evidence: ' + path.join(root, 'summary.json'));
