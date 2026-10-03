import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema, limitsSchema } from '../src/config.js';
import { hash } from '../src/filesystem.js';
import { adopt, readAdoption } from '../src/adoption.js';
import { loadBaseline } from '../src/baseline.js';
import { readResult } from '../src/result-reader.js';
import { explainResult } from '../src/result-explanation.js';
import { compareTerms } from '../src/terms.js';

/** Controlled legacy JSON fixtures test acceptance/retention; real sandbox verification has separate integration tests. */
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-adoption-unit-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'project')); const source = path.join(root, 'source'); await fs.mkdir(path.join(source, 'evidence'), { recursive: true });
  const config = configSchema.parse({ project: './project', schema_version: 1, scenarios: [{ id: 'build', command: ['node', 'task.cjs'],
    initial_write_grants: ['@workspace/dist'], initial_read_grants: ['@workspace/task.cjs'], assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }] }] });
  const limits = limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace'], allowed_read_roots: ['@workspace'], repetitions: 2 });
  const trials = ['first', 'second'].map(id => ({ id, scenario: 'build', phase: 'baseline', grants: ['@workspace/dist'], read_grants: ['@workspace/task.cjs'],
    read_mode: 'explicit', network_grants: [], verdict: 'pass', duration_ms: 1, evidence: `evidence/${id}.json` }));
  const report = { schema_version: 1, id: 'unit-source', mode: 'run', status: 'verified', environment: { node: process.version },
    inputs: { config_hash: hash(config), limits_hash: hash(limits), snapshot_hash: 'a'.repeat(64) }, policies: { build: trials[0].grants }, read_policies: { build: trials[0].read_grants },
    read_modes: { build: 'explicit' }, network_policies: { build: [] }, trials, baseline_verified: true, final_verified: true, search_complete: false, searches: {}, read_searches: {} };
  const checks = [{ name: 'file_exists:@workspace/dist/out', status: 'pass', detail: 'Unit fixture, not an actual sandbox test' }];
  const boundaries = ['control:network_endpoint', 'secret_unreadable', 'outside_unwritable', 'report_unwritable', 'network_blocked'].map(name => ({ ...checks[0], name }));
  const evidence = trials.map(trial => ({ ...trial, summary: trial, prepared_directories: ['@workspace/dist'], read_grant_kinds: { '@workspace/task.cjs': 'file' },
    before: { checks: boundaries }, after: { checks: boundaries }, task: { process: { status: 'completed', exit_code: 0 } }, assertions: checks }));
  for (let i = 0; i < trials.length; i++) await fs.writeFile(path.join(source, trials[i].evidence), JSON.stringify(evidence[i]));
  await fs.writeFile(path.join(source, 'report.json'), JSON.stringify(report)); await fs.writeFile(path.join(source, 'inputs.json'), JSON.stringify({ config, limits }));
  const configPath = path.join(root, 'tasks.json'), limitsPath = path.join(root, 'limits.json');
  await fs.writeFile(configPath, JSON.stringify(config)); await fs.writeFile(limitsPath, JSON.stringify(limits));
  return { root, source, config, limits, report, evidence, configPath, limitsPath, output: path.join(root, 'store') };
}
test('explicit adoption preserves repeated evidence after source cleanup and relocation, with no current validation claim', async t => {
  const f = await fixture(t), adopted = await adopt({ ...f, reason: 'Use this verified output scope' });
  assert.equal(adopted.manifest.baseline.selections[0].execution_ids.length, 2); assert.equal(adopted.manifest.artifacts.length, 4);
  await fs.rm(f.source, { recursive: true }); await fs.rename(f.output, path.join(f.root, 'moved'));
  const selection = path.join(f.root, 'moved/current.json'), loaded = await loadBaseline(selection);
  assert.equal((await loadBaseline(path.join(f.root, 'moved'))).adoption?.id, adopted.manifest.id);
  assert.deepEqual(loaded.policies.build, ['@workspace/dist']); assert.equal(loaded.history?.build.task, 'pass');
  const summary = explainResult(await readResult(selection)); assert.equal(summary.workflow?.kind, 'adopt');
  assert.equal(summary.analysis.status, 'complete'); assert.equal(summary.tasks[0].claims.find(c => c.dimension === 'current_validation')?.status, 'not_run');
});
test('adoption retains predecessors and reasons; choosing another result does not alter prior records', async t => {
  const f = await fixture(t), first = await adopt({ ...f, reason: 'Initial choice' }); const before = await fs.readFile(first.file, 'utf8');
  const second = await adopt({ ...f, reason: 'Reviewed again' }); assert.equal(second.manifest.previous?.id, first.manifest.id); assert.equal(second.parent_available, true);
  assert.equal(await fs.readFile(first.file, 'utf8'), before); assert.equal((await readAdoption(f.output)).manifest.id, second.manifest.id);
  const rollback = await adopt({ ...f, source: first.file, reason: 'Return to earlier evidence' });
  assert.equal(rollback.manifest.previous?.id, second.manifest.id); assert.equal(rollback.manifest.source.artifact_hash, first.manifest.source.artifact_hash);
});
test('missing or modified retained evidence cannot be loaded or silently replaced as the current baseline', async t => {
  const f = await fixture(t), a = await adopt(f); const current = await fs.readFile(path.join(f.output, 'current.json'), 'utf8');
  const artifact = path.join(path.dirname(a.file), 'source/evidence/first.json'); await fs.writeFile(artifact, '{}');
  await assert.rejects(loadBaseline(a.file), /hash mismatch/); await assert.rejects(adopt(f), /hash mismatch/);
  assert.equal(await fs.readFile(path.join(f.output, 'current.json'), 'utf8'), current);
  await fs.unlink(artifact); await assert.rejects(adopt(f), /ENOENT/);
  assert.equal(await fs.readFile(path.join(f.output, 'current.json'), 'utf8'), current);
});
test('claimed workflow success cannot adopt failed checks or missing repetitions', async t => {
  const f = await fixture(t); f.evidence[0].assertions[0].status = 'fail';
  await fs.writeFile(path.join(f.source, 'evidence/first.json'), JSON.stringify(f.evidence[0])); await assert.rejects(adopt(f), /passing repeated/);
  f.evidence[0].assertions[0].status = 'pass'; await fs.writeFile(path.join(f.source, 'evidence/first.json'), JSON.stringify(f.evidence[0]));
  f.report.trials.pop(); await fs.writeFile(path.join(f.source, 'report.json'), JSON.stringify(f.report)); await assert.rejects(adopt(f), /passing repeated/);
});
test('a passing check with the wrong name cannot stand in for the configured success condition', async t => {
  const f = await fixture(t); f.evidence[0].assertions[0].name = 'unrelated-success';
  await fs.writeFile(path.join(f.source, 'evidence/first.json'), JSON.stringify(f.evidence[0]));
  await assert.rejects(adopt(f), /configured assertions/);
});
test('adoption reads only final verification sidecars and does not depend on candidate history', async t => {
  const f = await fixture(t); f.report.mode = 'tighten';
  const finals = f.report.trials.map(trial => ({ ...trial, id: 'final-' + trial.id, phase: 'final', evidence: 'evidence/final-' + trial.id + '.json' }));
  for (let i = 0; i < finals.length; i++) {
    await fs.writeFile(path.join(f.source, finals[i].evidence), JSON.stringify({ ...f.evidence[i], ...finals[i], summary: finals[i] }));
    await fs.writeFile(path.join(f.source, f.report.trials[i].evidence), 'deliberately unavailable historical sidecar');
  }
  f.report.trials.push(...finals); await fs.writeFile(path.join(f.source, 'report.json'), JSON.stringify(f.report));
  await assert.rejects(readResult(path.join(f.source, 'report.json')));
  const a = await adopt(f); assert.equal(a.manifest.artifacts.length, 4); assert.equal(a.tasks[0].proofs.length, 2);
});
test('current trusted ceilings and matching task terms are required for adoption', async t => {
  const f = await fixture(t); await fs.writeFile(f.limitsPath, JSON.stringify({ ...f.limits, allowed_write_roots: ['@cache'] }));
  await assert.rejects(adopt(f), /trusted limits/);
  await fs.writeFile(f.limitsPath, JSON.stringify(f.limits)); f.config.scenarios[0].assertions = [{ type: 'file_exists', path: '@workspace/another' }];
  await fs.writeFile(f.configPath, JSON.stringify(f.config)); await assert.rejects(adopt(f), /task terms/);
});
test('links, outside-store pointer paths and concurrent selection writes are refused', async t => {
  const f = await fixture(t); await fs.mkdir(f.output); await fs.writeFile(path.join(f.output, '.adopt.lock'), 'held');
  await assert.rejects(adopt(f), /EEXIST/); await fs.unlink(path.join(f.output, '.adopt.lock'));
  await fs.symlink(path.join(f.source, 'evidence/second.json'), path.join(f.source, 'linked.json'));
  await fs.unlink(path.join(f.source, 'evidence/first.json')); await fs.symlink('../linked.json', path.join(f.source, 'evidence/first.json'));
  await assert.rejects(adopt(f), /regular JSON|ELOOP/);
  await fs.writeFile(path.join(f.output, 'current.json'), JSON.stringify({ schema_version: 1, kind: 'permsift_baseline_selection', baseline_id: 'x', file: '../source/report.json' }));
  await assert.rejects(readAdoption(f.output));
});
test('a missing predecessor is visible without invalidating independently retained current proof', async t => {
  const f = await fixture(t), first = await adopt(f), second = await adopt({ ...f, reason: 'Second choice' });
  await fs.rm(path.dirname(first.file), { recursive: true });
  const loaded = await readAdoption(second.file); assert.equal(loaded.parent_available, false);
  assert.equal(explainResult(await readResult(second.file)).claims.find(c => c.dimension === 'history')?.status, 'unavailable');
});
test('success checks and keyed goals have independent continuity; order-only edits are unchanged', () => {
  const s = configSchema.parse({ schema_version: 1, scenarios: [{ id: 'build', command: ['node', 'x'], initial_write_grants: [], assertions: [
    { type: 'file_exists', path: '@workspace/a' }, { type: 'file_exists', path: '@workspace/b' }], protection_goals: [
      { key: 'private', target: '@workspace/private', target_kind: 'directory', operation: 'read', stage: 'task', expected: 'denied' },
      { key: 'source', target: '@workspace/src', target_kind: 'directory', operation: 'write', stage: 'task', expected: 'denied' }] }] }).scenarios[0];
  const reordered = structuredClone(s); reordered.assertions.reverse(); reordered.protection_goals!.reverse(); assert.equal(compareTerms(s, reordered).changed, false);
  const current = structuredClone(s); current.assertions.pop(); current.protection_goals!.pop(); const changes = compareTerms(s, current);
  assert.equal(changes.dimensions.find(d => d.dimension === 'protection_goal:private')?.relation, 'same');
  assert.equal(changes.dimensions.find(d => d.dimension === 'protection_goal:source')?.relation, 'removed');
  assert.equal(changes.dimensions.find(d => d.dimension === 'success_conditions')?.relation, 'changed');
  assert.equal(compareTerms(undefined, s).presence, 'added'); assert.equal(compareTerms(s, undefined).presence, 'removed');
  assert.equal(compareTerms(s, { ...s, prepare_directories: ['@workspace/out'] }).changed, true);
});
