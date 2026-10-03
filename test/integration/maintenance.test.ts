import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runExperiment } from '../../src/engine.js';
import { runRegression } from '../../src/regression.js';
import { adopt, defaultStore, readAdoption } from '../../src/adoption.js';
import { configSchema } from '../../src/config.js';
import { readResult } from '../../src/result-reader.js';
import { explainResult } from '../../src/result-explanation.js';

const macOnly = { skip: process.platform !== 'darwin' ? 'Requires real macOS sandbox' : false };
const writer = "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out','fresh');";
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-maintenance-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(path.join(project, 'private'), { recursive: true }); await fs.mkdir(path.join(project, 'src'));
  await fs.writeFile(path.join(project, 'task.cjs'), writer); await fs.writeFile(path.join(project, 'private/key'), 'secret');
  const config = configSchema.parse({ schema_version: 1, project: './project', scenarios: [{ id: 'build', command: [process.execPath, 'task.cjs'],
    initial_write_grants: ['@workspace/dist'], initial_read_grants: ['@workspace/task.cjs'], auto_discover: false, auto_read_discover: false,
    protection_goals: [
      { key: 'private', target: '@workspace/private', target_kind: 'directory', operation: 'read', stage: 'task', expected: 'denied' },
      { key: 'source', target: '@workspace/src', target_kind: 'directory', operation: 'write', stage: 'task', expected: 'denied' }],
    assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }, { type: 'file_contains', path: '@workspace/dist/out', text: 'fresh' }] }] });
  const configPath = path.join(root, 'tasks.json'), limitsPath = path.join(root, 'limits.json');
  await fs.writeFile(configPath, JSON.stringify(config)); await fs.writeFile(limitsPath, JSON.stringify({ schema_version: 1, allowed_write_roots: ['@workspace'], allowed_read_roots: ['@workspace'], repetitions: 2, budget_seconds: 120, max_candidates: 8 }));
  const initial = await runExperiment({ mode: 'run', configPath, limitsPath, output: path.join(root, 'initial') }); assert.equal(initial.status, 'verified', initial.error);
  const adopted = await adopt({ source: initial.output, configPath, limitsPath, reason: 'Initial verified rule' });
  config.scenarios[0].initial_write_grants = ['@workspace']; config.scenarios[0].initial_read_grants = ['@workspace']; await fs.writeFile(configPath, JSON.stringify(config));
  return { root, project, config, configPath, limitsPath, initial, adopted };
}
test('retained adoption survives source cleanup; repair is a suggestion until an explicit new selection', macOnly, async t => {
  const f = await fixture(t), pointer = path.join(defaultStore(f.configPath), 'current.json'), before = await fs.readFile(pointer, 'utf8');
  await fs.rm(f.initial.output, { recursive: true }); await fs.writeFile(path.join(f.project, 'added.json'), '42');
  await fs.writeFile(path.join(f.project, 'task.cjs'), "if(require('node:fs').readFileSync('added.json','utf8')!=='42')process.exit(9);" + writer);
  const repair = await runRegression({ ...f, output: path.join(f.root, 'repair') });
  assert.equal(repair.status, 'regressed', repair.error); assert.equal(repair.tasks[0].repair_stop, 'verified');
  assert.deepEqual(repair.tasks[0].suggestion?.added_read, ['@workspace/added.json']); assert.equal(await fs.readFile(pointer, 'utf8'), before);
  const second = await adopt({ ...f, source: repair.output, reason: 'Read the new task input' });
  assert.equal(second.manifest.previous?.id, f.adopted.manifest.id); assert.ok(second.baseline.read_policies.build.includes('@workspace/added.json'));
  await fs.rm(repair.output, { recursive: true });
  const compatible = await runRegression({ ...f, output: path.join(f.root, 'compatible') });
  assert.equal(compatible.status, 'compatible', compatible.error); assert.equal(compatible.trials, 2); assert.equal(compatible.candidate_count, 0);
  assert.equal(compatible.adoption?.id, second.manifest.id);
  const summary = explainResult(await readResult(second.file)); assert.equal(summary.analysis.status, 'complete');
  assert.equal(summary.tasks[0].claims.find(c => c.dimension === 'protections')?.status, 'pass');
  const limits = JSON.parse(await fs.readFile(f.limitsPath, 'utf8')); limits.allowed_read_roots = ['@workspace/task.cjs']; await fs.writeFile(f.limitsPath, JSON.stringify(limits));
  await assert.rejects(runRegression({ ...f, output: path.join(f.root, 'untrusted') }), /trusted limits/);
});
test('weakened success checks and a removed goal require review while preserving per-goal historical facts', macOnly, async t => {
  const f = await fixture(t); f.config.scenarios[0].assertions.pop(); f.config.scenarios[0].protection_goals!.pop(); await fs.writeFile(f.configPath, JSON.stringify(f.config));
  const report = await runRegression({ ...f, output: path.join(f.root, 'changed') });
  assert.equal(report.status, 'review_required', report.error); assert.equal(report.tasks[0].status, 'compatible'); assert.equal(report.tasks[0].current_verification, 'pass');
  assert.equal(report.trials, 2); assert.ok(report.tasks[0].terms?.changes.some(c => c.dimension === 'success_conditions'));
  const summary = explainResult(await readResult(report.output)); const claims = summary.tasks[0].claims;
  assert.equal(summary.analysis.status, 'complete', JSON.stringify(summary.analysis.gaps));
  assert.equal(claims.find(c => c.dimension === 'history_protection_goal:source')?.status, 'pass');
  assert.equal(claims.find(c => c.dimension === 'continuity_protection_goal:source')?.status, 'removed');
  assert.equal(claims.find(c => c.dimension === 'protection_goal:private')?.status, 'pass');
  assert.equal(claims.find(c => c.dimension === 'protection_goal:source'), undefined);
  const adopted = await adopt({ ...f, source: report.output, reason: 'Reviewed the new success and protection terms' });
  assert.equal(adopted.config.scenarios[0].protection_goals?.length, 1);
  assert.equal((await runRegression({ ...f, output: path.join(f.root, 'reviewed') })).status, 'compatible');
});
test('new, removed and unavailable tasks are reported individually without discarding other current results', macOnly, async t => {
  const f = await fixture(t); f.config.scenarios.push({ ...structuredClone(f.config.scenarios[0]), id: 'second' }); await fs.writeFile(f.configPath, JSON.stringify(f.config));
  const added = await runRegression({ ...f, output: path.join(f.root, 'added') });
  assert.equal(added.status, 'review_required'); assert.deepEqual(added.tasks.map(r => r.status), ['compatible', 'new_task_verified']); assert.equal(added.trials, 4);
  const both = await adopt({ ...f, source: added.output });
  f.config.scenarios[0].initial_read_grants = undefined; await fs.writeFile(f.configPath, JSON.stringify(f.config));
  const blocked = await runRegression({ ...f, output: path.join(f.root, 'blocked') });
  assert.equal(blocked.status, 'inconclusive'); assert.deepEqual(blocked.tasks.map(r => r.status), ['inconclusive', 'compatible']); assert.equal(blocked.trials, 2);
  assert.match(blocked.tasks[0].reason!, /Read mode changed/); await assert.rejects(adopt({ ...f, source: blocked.output }), /Inconclusive/);
  assert.equal((await readAdoption(defaultStore(f.configPath))).manifest.id, both.manifest.id);
  f.config.scenarios.shift(); await fs.writeFile(f.configPath, JSON.stringify(f.config));
  const removed = await runRegression({ ...f, output: path.join(f.root, 'removed') });
  assert.equal(removed.status, 'review_required'); assert.deepEqual(removed.tasks.map(r => r.status), ['removed_task', 'compatible']); assert.equal(removed.trials, 2);
  assert.equal(removed.tasks[0].current_verification, 'not_run'); assert.equal(removed.tasks[0].history?.task, 'pass');
  const last = await adopt({ ...f, source: removed.output }); assert.deepEqual(last.config.scenarios.map(s => s.id), ['second']);
});
