import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runExperiment } from '../../src/engine.js';
import { runRegression, loadBaseline } from '../../src/regression.js';
import { executeSandbox } from '../../src/backend.js';
import { assertNativeEvidence } from '../support/native-evidence.js';
import { assertSummary } from '../support/result-summary.js';
import { parseNativeExecution } from '../../src/model/native-reader.js';
import { objectId } from '../../src/model/identity.js';
import { runObservation } from '../../src/observe-command.js';
import { protectionChecks } from '../../src/protection.js';
const macOnly = { skip: process.platform !== 'darwin' ? 'Requires the real macOS sandbox' : false };
const goals = [
  { key: 'private-file', target: '@workspace/private.json', target_kind: 'file', operation: 'read', stage: 'task', expected: 'denied' },
  { key: 'private-directory', target: '@workspace/private', target_kind: 'directory', operation: 'read', stage: 'task', expected: 'denied' },
  { key: 'source', target: '@workspace/src', target_kind: 'directory', operation: 'write', stage: 'task', expected: 'denied' },
  { key: 'config', target: '@workspace/config.txt', target_kind: 'file', operation: 'write', stage: 'task', expected: 'denied' },
  { key: 'no-create', target: '@workspace/no-create', target_kind: 'directory', operation: 'create', stage: 'task', expected: 'denied' },
] as const;
const writer = `const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out',fs.readFileSync('public.txt','utf8'));`;
async function fixture(t: TestContext, script = writer) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-protection-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  for (const d of ['private', 'src', 'no-create']) await fs.mkdir(path.join(project, d));
  for (const f of ['private.json', 'private/secret', 'src/input', 'config.txt', 'public.txt']) await fs.writeFile(path.join(project, f), 'real-task-input');
  await fs.writeFile(path.join(project, 'task.cjs'), script);
  const config = { schema_version: 1, project: './project', scenarios: [{ id: 'build', command: [process.execPath, 'task.cjs'], timeout_seconds: 10,
    initial_write_grants: ['@workspace'], initial_read_grants: ['@workspace', '@workspace/private', '@workspace/private.json'],
    protection_goals: goals, auto_discover: false, auto_read_discover: false, narrower_candidates: [{ from: '@workspace', to: ['@workspace/dist'] }],
    assertions: [{ type: 'file_contains', path: '@workspace/dist/out', text: 'real-task-input' }] }] };
  const configPath = path.join(root, 'tasks.json'), limitsPath = path.join(root, 'limits.json');
  await fs.writeFile(configPath, JSON.stringify(config)); await fs.writeFile(limitsPath, JSON.stringify({ schema_version: 1, allowed_write_roots: ['@workspace'], allowed_read_roots: ['@workspace'], repetitions: 1, budget_seconds: 120, max_candidates: 20 }));
  return { root, project, config, configPath, limitsPath };
}

test('the real adapter keeps read denials fixed for parent, equal-directory and descendant-file grants', macOnly, async t => {
  const f = await fixture(t), cache = path.join(f.root, 'cache'), tmp = path.join(f.root, 'tmp'); await fs.mkdir(cache); await fs.mkdir(tmp);
  const script = `const fs=require('node:fs');for(const p of ['private/secret','private.json']){try{fs.readFileSync(p);process.exit(9)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}}`;
  for (const reads of [['@workspace'], ['@workspace/private', '@workspace/private.json'], ['@workspace/private/secret']]) {
    const result = await executeSandbox([process.execPath, '-e', script], { roots: { workspace: f.project, cache, tmp }, experimentRoot: f.root, protectedPaths: [], grants: ['@workspace'], readGrants: reads, protectionGoals: [...goals], invocationId: 'protection-capability', timeoutMs: 5000, maxOutputBytes: 8192 });
    assert.equal(result.process.exit_code, 0, result.process.stderr);
  }
});

test('an interrupted protection probe retains unknown facts, cleans its tiny workspace and cannot verify denial', macOnly, async t => {
  const f = await fixture(t), cache = path.join(f.root, 'cache'), tmp = path.join(f.root, 'tmp'); await fs.mkdir(cache); await fs.mkdir(tmp);
  const checked = await protectionChecks([...goals], { roots: { workspace: f.project, cache, tmp }, experimentRoot: f.root, protectedPaths: [], grants: ['@workspace'], readGrants: ['@workspace'], invocationId: 'probe-interrupted', timeoutMs: 1, maxOutputBytes: 8192 }, 'before');
  assert.ok(checked.results.every(r => r.status === 'unknown'));
  assert.ok(checked.results.every(r => r.controls_before[0].status === 'pass' && r.controls_after.some(c => c.name === 'probe_execution' && c.status === 'unknown')));
  assert.deepEqual(await fs.readdir(path.join(f.root, 'protection-probes')), []);
  assert.equal(await fs.readFile(path.join(f.project, 'public.txt'), 'utf8'), 'real-task-input');
});

test('task inputs stay real, all declared operations are denied, search/recovery/export retain the agreement and replay explains it offline', macOnly, async t => {
  const script = `const fs=require('node:fs');for(const f of [()=>fs.readFileSync('private.json'),()=>fs.readdirSync('private'),()=>fs.writeFileSync('src/input','changed'),()=>fs.writeFileSync('no-create/new','changed'),()=>fs.appendFileSync('config.txt','changed')]){try{f();process.exit(9)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}}${writer.replace("const fs=require('node:fs');",'')}`;
  const f = await fixture(t, script);
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified', report.error ?? JSON.stringify(report.trials.at(-1)?.diagnosis));
  const records = await assertNativeEvidence(report);
  assert.equal(new Set(records.map(r => r.agreement.id)).size, 1);
  assert.ok(records.every(r => r.execution.outcomes.protections?.status === 'pass'));
  for (const record of records) parseNativeExecution(record);
  const summary = await assertSummary(report.output);
  assert.equal(summary.analysis.status, 'complete', JSON.stringify(summary.analysis.gaps));
  assert.equal(summary.tasks[0].claims.find(c => c.dimension === 'protections')!.status, 'pass');
  assert.equal(summary.tasks[0].claims.filter(c => c.dimension.startsWith('protection_goal:')).length, goals.length);
  const detail = JSON.parse(await fs.readFile(path.join(report.output, report.trials[0].evidence), 'utf8'));
  assert.equal(detail.protections.length, 2); assert.ok(detail.protections.every((p: { fixture_files: number }) => p.fixture_files < 32));
  assert.equal(report.trials[0].timings?.phases.protections?.calls, 2);
  assert.equal(await fs.readFile(path.join(f.project, 'src/input'), 'utf8'), 'real-task-input');
  await fs.access(path.join(f.project, 'private.json')); await assert.rejects(fs.access(path.join(f.project, 'dist/out')));
  const replay = await runExperiment({ mode: 'run', configPath: path.join(report.output, 'recommended.yaml'), limitsPath: f.limitsPath, output: path.join(f.root, 'replay') });
  assert.equal(replay.status, 'verified', replay.error);
  const changed = structuredClone(records[0]); const protections = changed.execution.protections!;
  if (protections.state === 'recorded') protections.value[0].results[0].status = 'fail';
  const { id: _id, ...content } = changed.execution; changed.execution.id = objectId('execution', content);
  assert.throws(() => parseNativeExecution(changed), /protection stage\/result/);
});

test('a missing or changed-kind target blocks verification while retaining another goal that was checked', macOnly, async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.project, 'private.json'));
  // Remove the corresponding positive file grant so setup itself does not fail first.
  f.config.scenarios[0].initial_read_grants = ['@workspace']; await fs.writeFile(f.configPath, JSON.stringify(f.config));
  const report = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'missing') });
  assert.equal(report.status, 'incomplete'); assert.equal(report.trials[0].verdict, 'unknown');
  const facts = (await assertNativeEvidence(report))[0];
  assert.equal(facts.execution.outcomes.task.status, 'not_run'); assert.equal(facts.execution.outcomes.protections?.status, 'unknown');
  const summary = await assertSummary(report.output);
  assert.equal(summary.tasks[0].claims.find(c => c.dimension === 'protection_goal:private-file')!.status, 'unknown');
  // Before-only passing checks are not a complete task-stage verification.
  assert.equal(summary.tasks[0].claims.find(c => c.dimension === 'protection_goal:source')!.status, 'unknown');
  await fs.mkdir(path.join(f.project, 'private.json'));
  const changed = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'changed-kind') });
  assert.equal(changed.status, 'incomplete');
  const details = JSON.parse(await fs.readFile(path.join(changed.output, changed.trials[0].evidence), 'utf8'));
  assert.match(details.protections[0].results.find((r: { key: string }) => r.key === 'private-file').target.detail, /kind differs/);
});

test('a task requiring protected input fails under old and wider policies; check cannot repair by opening that target', macOnly, async t => {
  const f = await fixture(t);
  const baseline = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'baseline') }); assert.equal(baseline.status, 'verified');
  await fs.writeFile(path.join(f.project, 'task.cjs'), `require('node:fs').readFileSync('private.json');${writer}`);
  const baselinePath = path.join(baseline.output, 'report.json');
  const check = await runRegression({ ...f, baselinePath, output: path.join(f.root, 'check') });
  assert.equal(check.status, 'regressed'); assert.equal(check.tasks[0].status, 'unresolved_failure'); assert.equal(check.tasks[0].suggestion, undefined);
  const summary = await assertSummary(check.output);
  assert.ok(summary.tasks[0].claims.some(c => c.dimension === 'protections' && c.status === 'pass'));
  f.config.scenarios[0].protection_goals = [] as unknown as typeof goals; await fs.writeFile(f.configPath, JSON.stringify({ ...f.config, scenarios: f.config.scenarios.map(({ protection_goals: _goals, ...s }) => s) }));
  await assert.rejects(runRegression({ ...f, baselinePath, output: path.join(f.root, 'changed-agreement') }), /Protection agreement changed/);
  const trial = baseline.trials.at(-1)!; const evidencePath = path.join(baseline.output, trial.evidence); const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8')); delete evidence.protections; await fs.writeFile(evidencePath, JSON.stringify(evidence));
  await assert.rejects(loadBaseline(baselinePath), /passing declared protection evidence/);
});

test('an exact read repair for an unprotected input keeps every protection fixed through control, confirmation and repeated verification', macOnly, async t => {
  const f = await fixture(t);
  f.config.scenarios[0].initial_read_grants = ['@workspace/task.cjs', '@workspace/public.txt']; await fs.writeFile(f.configPath, JSON.stringify(f.config));
  const baseline = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'baseline') }); assert.equal(baseline.status, 'verified');
  await fs.writeFile(path.join(f.project, 'added.json'), '42'); await fs.writeFile(path.join(f.project, 'task.cjs'), `if(require('node:fs').readFileSync('added.json','utf8')!=='42')process.exit(9);${writer}`);
  f.config.scenarios[0].initial_read_grants = ['@workspace']; await fs.writeFile(f.configPath, JSON.stringify(f.config));
  const checked = await runRegression({ ...f, baselinePath: path.join(baseline.output, 'report.json'), output: path.join(f.root, 'repaired') });
  assert.equal(checked.tasks[0].status, 'permission_change', checked.error); assert.deepEqual(checked.tasks[0].suggestion?.added_read, ['@workspace/added.json']);
  const identities = new Set<string>();
  for (const s of checked.tasks[0].stages) {
    const report = JSON.parse(await fs.readFile(path.join(checked.output, path.dirname(s.report), 'report.json'), 'utf8'));
    for (const record of await assertNativeEvidence(report)) { identities.add(record.agreement.id); assert.equal(record.execution.outcomes.protections?.status, 'pass'); }
  }
  assert.equal(identities.size, 1);
  const summary = await assertSummary(checked.output); assert.equal(summary.analysis.status, 'complete', JSON.stringify(summary.analysis.gaps));
  const replay = await runExperiment({ mode: 'run', configPath: path.join(checked.output, 'suggested.yaml'), limitsPath: f.limitsPath, output: path.join(f.root, 'replay') }); assert.equal(replay.status, 'verified');
});

test('dependency observation and its offline usage overview retain the same task protections', macOnly, async t => {
  const f = await fixture(t);
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') });
  assert.equal(report.status, 'observed', JSON.stringify(report.tasks));
  const summary = await assertSummary(report.output, 'usage');
  assert.equal(summary.tasks[0].claims.find(c => c.dimension === 'protections')?.status, 'pass');
});
