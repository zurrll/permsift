import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runExperiment } from '../../src/engine.js';
import { runRegression } from '../../src/regression.js';
import { runObservation } from '../../src/observe-command.js';
import { diagnoseSuccess } from '../../src/success-diagnostics.js';
import { writeFileSync } from 'node:fs';
import { bundledRegistry } from '../support/bundled-registry.js';
import { assertNativeEvidence } from '../support/native-evidence.js';

const macOnly = { skip: process.platform !== 'darwin' ? 'Requires real macOS isolation' : false };
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-success-real-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const script = "const fs=require('node:fs'); fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/out.json',JSON.stringify({checked:'passed'}));";
  await fs.writeFile(path.join(project, 'task.cjs'), script);
  const configPath = path.join(root, 'tasks.json'), limitsPath = path.join(root, 'limits.json');
  const config = { schema_version: 1, project, scenarios: [{ id: 'build', command: [process.execPath, 'task.cjs'], initial_write_grants: ['@workspace'], auto_discover: false, auto_read_discover: false,
    narrower_candidates: [{ from: '@workspace', to: ['@workspace/dist'] }], assertions: [{ type: 'file_exists', path: '@workspace/dist/out.json' }, { type: 'json_equals', path: '@workspace/dist/out.json', pointer: '/checked', value: 'passed' }] }] };
  await fs.writeFile(configPath, JSON.stringify(config)); await fs.writeFile(limitsPath, JSON.stringify({ schema_version: 1, allowed_write_roots: ['@workspace'], allowed_read_roots: ['@workspace'], repetitions: 2, budget_seconds: 120, max_candidates: 4 }));
  return { root, project, configPath, limitsPath, config };
}

test('real tightening saves one final-policy repetition and no search/baseline artifacts; diagnosis is offline after relocation', macOnly, async t => {
  const f = await fixture(t), output = path.join(f.root, 'tighten');
  const report = await runExperiment({ ...f, mode: 'tighten', saveArtifacts: true, output });
  assert.equal(report.status, 'verified', report.error); assert.deepEqual(report.policies.build, ['@workspace/dist']);
  await assertNativeEvidence(report);
  const final = report.trials.filter(t => t.phase === 'final'); assert.equal(final.length, 2);
  assert.deepEqual(await fs.readdir(path.join(output, 'artifacts')), [final[0].id]);
  for (const trial of report.trials) {
    const sidecar = JSON.parse(await fs.readFile(path.join(output, trial.evidence), 'utf8'));
    assert.equal(Boolean(sidecar.success_artifacts), trial.id === final[0].id);
    assert.equal(sidecar.assertion_evaluations.length, 2);
  }
  const before = await fs.readFile(path.join(output, 'report.json'));
  await fs.rm(f.project, { recursive: true }); const moved = path.join(f.root, 'moved'); await fs.rename(output, moved);
  const diagnosis = await diagnoseSuccess(moved); assert.equal(diagnosis.status, 'diagnosed', JSON.stringify(diagnosis));
  assert.equal(diagnosis.tasks[0].sample?.trial, final[0].id); assert.equal(diagnosis.tasks[0].sample?.phase, 'final');
  const mutations = diagnosis.tasks[0].artifacts[0].mutations;
  assert.equal(mutations.find(m => m.kind === 'change_json_value')!.checks[1].cause, 'content_mismatch');
  assert.deepEqual(await fs.readFile(path.join(moved, 'report.json')), before);
});
test('default runs do not retain output bytes; check diagnoses selected compatible and repaired verification', macOnly, async t => {
  const f = await fixture(t), first = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'run') });
  assert.equal(first.status, 'verified'); await assert.rejects(fs.stat(path.join(first.output, 'artifacts')), { code: 'ENOENT' });
  assert.equal((await diagnoseSuccess(first.output)).tasks[0].state, 'not_saved');
  const checked = await runRegression({ ...f, baselinePath: path.join(first.output, 'report.json'), output: path.join(f.root, 'check'), saveArtifacts: true });
  assert.equal(checked.status, 'compatible', checked.error);
  const diagnosis = await diagnoseSuccess(checked.output); assert.equal(diagnosis.status, 'diagnosed', JSON.stringify(diagnosis));
  assert.equal(diagnosis.tasks[0].final_repetitions, 2); assert.match(diagnosis.source, /report.json$/);
  // A changed input needs a tested read addition; only the final repair proof may supply bytes.
  const script = await fs.readFile(path.join(f.project, 'task.cjs'), 'utf8');
  const scoped = { ...f.config, scenarios: [{ ...f.config.scenarios[0], initial_write_grants: ['@workspace/dist'], initial_read_grants: ['@workspace/task.cjs'] }] };
  await fs.writeFile(f.configPath, JSON.stringify(scoped));
  const baseline = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'scoped') }); assert.equal(baseline.status, 'verified');
  await fs.writeFile(path.join(f.project, 'input.json'), '42');
  await fs.writeFile(path.join(f.project, 'task.cjs'), "require('node:fs').readFileSync('input.json');\n" + script);
  await fs.writeFile(f.configPath, JSON.stringify({ ...f.config, scenarios: [{ ...f.config.scenarios[0], initial_read_grants: ['@workspace'] }] }));
  const repaired = await runRegression({ ...f, baselinePath: path.join(baseline.output, 'report.json'), output: path.join(f.root, 'repair'), saveArtifacts: true });
  assert.equal(repaired.tasks[0].status, 'permission_change', repaired.tasks[0].reason); assert.equal(repaired.tasks[0].suggestion?.verified, true);
  const repairedDiagnostic = await diagnoseSuccess(repaired.output); assert.equal(repairedDiagnostic.status, 'diagnosed', JSON.stringify(repairedDiagnostic));
  const phase = repaired.tasks[0].stages.find(s => s.phase.startsWith('repair-verify-'))!.phase;
  const finalRoot = path.join(repaired.output, 'tasks/build', phase);
  assert.equal(await fs.readdir(path.join(finalRoot, 'artifacts')).then(v => v.length), 1);
  for (const stage of repaired.tasks[0].stages.filter(s => !s.phase.startsWith('repair-verify-'))) {
    await assert.rejects(fs.stat(path.join(repaired.output, 'tasks/build', stage.phase, 'artifacts')), { code: 'ENOENT' });
  }

});
test('observe uses its actual recorded task, and optional retention failures do not change a passing run', macOnly, async t => {
  const f = await fixture(t), observed = await runObservation({ ...f, output: path.join(f.root, 'observe'), saveArtifacts: true });
  assert.equal(observed.status, 'observed'); const diagnostic = await diagnoseSuccess(observed.output);
  assert.equal(diagnostic.status, 'diagnosed', JSON.stringify(diagnostic)); assert.equal(diagnostic.tasks[0].sample?.phase, 'observe');
  assert.equal(diagnostic.tasks[0].final_repetitions, 1);
  const registry = await bundledRegistry({ directory: path.join(f.root, 'local-registry') });
  try {
    const installed = await runObservation({ configPath: registry.configPath, limitsPath: registry.limitsPath, output: path.join(f.root, 'installed-observe'), saveArtifacts: true });
    assert.equal(installed.status, 'observed');
    assert.equal((await diagnoseSuccess(installed.output)).status, 'diagnosed', 'Fresh bundled installation proof can supply actual task artifacts');
  } finally { await registry.close(); }

  // After task evaluation, occupy the optional store before capture. It must remain a passing trial.
  const broken = path.join(f.root, 'broken'); let once = false;
  const report = await runExperiment({ ...f, mode: 'run', saveArtifacts: true, output: broken, onProgress: message => {
    if (!once && message.includes('baseline')) { once = true; writeFileSync(path.join(broken, 'artifacts'), 'occupied'); }
  } });
  assert.equal(report.status, 'verified', report.error);
  const sidecar = JSON.parse(await fs.readFile(path.join(broken, report.trials[0].evidence), 'utf8'));
  assert.equal(sidecar.success_artifacts.state, 'not_saved'); assert.equal((await diagnoseSuccess(broken)).tasks[0].state, 'not_saved');
});
