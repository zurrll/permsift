import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scenarioSchema } from '../src/config.js';
import { protectionAgreement, taskDefinition } from '../src/model/definitions.js';
import { goalOperations, goalVerdict, evaluateProtections, type ProtectionStage } from '../src/protection-facts.js';
import { targetCheck, protectionScript, fixtureControl } from '../src/protection.js';
import { recorded } from '../src/model/identity.js';
import { runProcess } from '../src/process.js';
import type { ProtectionGoal } from '../src/model/types.js';
import { candidates, searchPolicy } from '../src/search.js';
import { repairCandidates } from '../src/regression.js';
import type { Diagnosis } from '../src/diagnostics.js';

const goal = { key: 'private-config', target: '@workspace/private', target_kind: 'directory', operation: 'read', stage: 'task', expected: 'denied' } as const satisfies ProtectionGoal;
const scenario = () => scenarioSchema.parse({ id: 'build', command: ['node', 'task.cjs'], initial_write_grants: ['@workspace'], assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }], protection_goals: [goal] });
const pass = (name: string) => ({ name, status: 'pass' as const, detail: 'Checked' });
function stage(moment: 'before' | 'after'): ProtectionStage {
  return { stage: 'task', moment, method: 'isolated_fake_workspace_v1', results: [{ key: goal.key, target: pass('target:' + goal.key), controls_before: [pass('fixture')], controls_after: [pass('fixture')], checks: goalOperations(goal).map(pass), status: 'pass' }] };
}

test('protection declaration identity is independent of task and positive permissions', () => {
  const a = scenario(), b = { ...a, initial_write_grants: [], initial_read_grants: [] };
  assert.equal(protectionAgreement(a.id, a).id, protectionAgreement(b.id, b).id);
  assert.equal(taskDefinition(a.id, a).id, taskDefinition(a.id, { ...a, protection_goals: undefined }).id);
  assert.notEqual(protectionAgreement(a.id, a).id, protectionAgreement(a.id, { protection_goals: undefined }).id);
  assert.notEqual(protectionAgreement(a.id, a).id, protectionAgreement(a.id, { protection_goals: [{ ...goal, operation: 'write' }] }).id);
});

test('config rejects unsupported stages, arbitrary host/cache paths, reserved namespaces and ambiguous create targets', () => {
  for (const change of [{ stage: 'install' }, { target: '/Users/person/secrets' }, { target: '@cache/x' }, { target: '@workspace/.permsift-protection-fake' }, { target: '@workspace' }, { operation: 'create', target_kind: 'file' }]) {
    assert.equal(scenarioSchema.safeParse({ ...scenario(), protection_goals: [{ ...goal, ...change }] }).success, false);
  }
  assert.equal(scenarioSchema.safeParse({ ...scenario(), protection_goals: [goal, goal] }).success, false);
  assert.equal(scenarioSchema.safeParse({ ...scenario(), protection_goals: [] }).success, false);
});

test('removing a grant already denied by the agreement is not counted as a scope reduction, including grouped removals', async () => {
  const s = scenario(), initial = ['@workspace/private/a', '@workspace/private/b', '@workspace/private/c'];
  assert.ok(candidates(s, initial, [], 'read').every(c => c.semantic_change === false));
  let n = 0;
  const search = await searchPolicy(s, { permission: 'read', initialGrants: initial, canContinue: () => true, evaluate: async () => ({ verdict: 'pass', id: 'trial-' + ++n }) });
  assert.deepEqual(search.grants, []); assert.ok(search.steps.every(s => !s.semantic_change));
});

test('protections need the declared operation set, host controls and both stages', () => {
  const agreement = protectionAgreement('build', scenario());
  assert.equal(evaluateProtections(agreement, recorded([stage('before'), stage('after')])).status, 'pass');
  assert.equal(evaluateProtections(agreement, recorded([stage('before')])).status, 'unknown');
  const missingOperation = stage('after'); missingOperation.results[0].checks.pop();
  assert.equal(evaluateProtections(agreement, recorded([stage('before'), missingOperation])).status, 'unknown');
  const missingControl = stage('after'); missingControl.results[0].controls_after = [];
  assert.equal(goalVerdict(missingControl.results[0]), 'unknown');
  assert.equal(evaluateProtections(agreement, recorded([stage('before'), missingControl])).status, 'unknown');
  assert.equal(evaluateProtections(agreement).status, 'not_saved');
});

test('allowed access remains a failed protection even if another probe or subsequent fixture control is unknown', () => {
  const after = stage('after'), r = after.results[0];
  r.checks[0].status = 'fail'; r.checks[1].status = 'unknown'; r.controls_after[0].status = 'unknown';
  r.status = goalVerdict(r);
  assert.equal(r.status, 'fail');
  assert.equal(evaluateProtections(protectionAgreement('build', scenario()), recorded([stage('before'), after])).status, 'fail');
  r.target.status = 'unknown'; r.status = goalVerdict(r);
  assert.equal(r.status, 'unknown', 'A probe against the wrong/absent actual target cannot verify its agreement');
});

test('target validation distinguishes missing resources, internal links and file/directory changes without touching contents', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-targets-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = { workspace: root, cache: root, tmp: root };
  assert.equal((await targetCheck(goal, roots)).status, 'unknown');
  await fs.writeFile(path.join(root, 'private'), 'real-input');
  assert.equal((await targetCheck(goal, roots)).status, 'unknown');
  assert.equal((await targetCheck({ ...goal, target_kind: 'file' }, roots)).status, 'pass');
  await fs.symlink('private', path.join(root, 'linked'));
  assert.equal((await targetCheck({ ...goal, target: '@workspace/linked', target_kind: 'file' }, roots)).status, 'unknown');
  assert.equal(await fs.readFile(path.join(root, 'private'), 'utf8'), 'real-input');
});

test('the probe records actual allowed operations as failures and ENOENT as unknown', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-protection-script-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'fake'); await fs.writeFile(file, 'fake-only');
  const result = await runProcess([process.execPath, '-e', protectionScript([{ key: 'fake', target: file, files: [file], actions: [{ name: 'read_file', file }, { name: 'read_file', file: file + '-absent' }] }])], { cwd: root, env: process.env, timeoutMs: 2000, maxOutputBytes: 8192 });
  const checks = JSON.parse(result.stdout)[0].checks;
  assert.equal(checks[0].status, 'fail'); assert.equal(checks[1].status, 'unknown'); assert.equal(checks[1].detail, 'ENOENT');
});

test('fake fixture controls refuse content tampering and links instead of silently restoring them', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-fake-controls-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'fake'), fixture = { key: 'fake', target: file, root, files: [file], actions: [{ name: 'read_file', file }] };
  await fs.writeFile(file, 'marker'); assert.equal((await fixtureControl(fixture, 'marker')).status, 'pass');
  await fs.writeFile(file, 'tampered'); assert.equal((await fixtureControl(fixture, 'marker')).status, 'unknown');
  assert.equal(await fs.readFile(file, 'utf8'), 'tampered');
  await fs.rename(file, file + '-other'); await fs.symlink('fake-other', file);
  assert.equal((await fixtureControl(fixture, 'tampered')).status, 'unknown');
});

test('ambiguous denial and module-resolution hints cannot generate a repair through a declared goal', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-protected-repair-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'private')); await fs.writeFile(path.join(root, 'private/config.json'), 'fake');
  const old = { ...scenario(), initial_read_grants: [] }, control = { ...old, initial_read_grants: ['@workspace'] };
  const diagnosis: Diagnosis = { kind: 'permission_denial_observed', summary: 'hint', denials: [{ source: 'stderr', operation: 'unspecified', path: '@workspace/private/config.json', detail: 'untrusted' }], failed_assertions: [], boundary_issues: [], stderr_excerpt: "Cannot find module './private/config'", log_limitations: 'untrusted' };
  assert.deepEqual(await repairCandidates(old, control, [diagnosis], root), []);
  const write = { ...old, initial_write_grants: [], protection_goals: [{ ...goal, operation: 'write' as const }] };
  assert.deepEqual(await repairCandidates(write, { ...write, initial_write_grants: ['@workspace'] }, [diagnosis], root), []);
});
