import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scenarioSchema, limitsSchema, validatePolicy, configSchema } from '../src/config.js';
import { directoryInventory, discover, type Observation } from '../src/discovery.js';
import { searchPolicy } from '../src/search.js';

const scenario = () => scenarioSchema.parse({ id: 'build', command: ['node'], initial_write_grants: ['@workspace', '@cache', '@tmp'], assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }] });
const limits = () => limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace', '@cache', '@tmp'] });
const observation = (writes: string[]): Observation => ({ id: 'baseline-1', directories: ['@workspace', '@workspace/src', '@workspace/dist', '@workspace/dist/assets', '@cache', '@cache/compiler', '@tmp'], writes, denial_paths: [], truncated: false });

test('automatic discovery combines baseline branches, identifies cache writes and never widens scope', () => {
  const a = observation(['@workspace/dist/index.js', '@cache/compiler/state']);
  const b = { ...observation(['@workspace/dist/assets/style.css']), id: 'baseline-2' };
  const plan = discover(scenario(), [a, b], limits());
  assert.deepEqual(plan.rules.find(r => r.from === '@workspace' && r.source === 'file_changes')?.to, ['@workspace/dist']);
  assert.deepEqual(plan.rules.find(r => r.from === '@cache' && r.source === 'file_changes')?.to, ['@cache/compiler']);
  assert.ok(plan.rules.some(r => r.source === 'directory_structure'));
  const config = configSchema.parse({ schema_version: 1, scenarios: [{ ...scenario(), narrower_candidates: plan.rules.map(({ from, to }) => ({ from, to })) }] });
  validatePolicy(config, limits());
});
test('direct root writes cannot be represented as observed child-only permissions', () => {
  const plan = discover(scenario(), [observation(['@workspace/top.txt', '@workspace/dist/out'])], limits());
  assert.ok(!plan.rules.some(r => r.from === '@workspace' && r.source === 'file_changes'));
});
test('hints outside the ceiling, malformed aliases and opt-out cannot generate grants', () => {
  const s = scenario(); s.initial_write_grants = ['@workspace/dist'];
  const o = observation(['@cache/compiler/state', '@workspace/../bad', '/outside']);
  o.directories.push('@workspace/../bad', '@cache/escape');
  const plan = discover(s, [o], limits());
  assert.ok(plan.rules.every(r => r.from.startsWith('@workspace/dist') && r.to.every(p => p.startsWith('@workspace/dist/'))));
  s.auto_discover = false; assert.equal(discover(s, [o], limits()).rules.length, 0);
});
test('inventory skips symlinks, respects depth and size, and discloses truncation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-discovery-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const roots = { workspace: path.join(dir, 'workspace'), cache: path.join(dir, 'cache'), tmp: path.join(dir, 'tmp') };
  for (const root of Object.values(roots)) await fs.mkdir(root);
  await fs.mkdir(path.join(roots.workspace, 'a', 'deep'), { recursive: true });
  await fs.symlink('/tmp', path.join(roots.workspace, 'escape'));
  const l = limits(); l.max_discovery_depth = 1;
  const inventory = await directoryInventory(roots, l);
  assert.ok(inventory.directories.includes('@workspace/a'));
  assert.ok(!inventory.directories.some(p => /escape|deep/.test(p))); assert.equal(inventory.truncated, true);
  l.max_discovery_dirs = 2;
  assert.equal((await directoryInventory(roots, l)).directories.length, 2);
});
test('automatic candidates still require trials and necessary grants are rejected with recovery', async () => {
  const s = scenario(); const plan = discover(s, [observation(['@workspace/dist/out'])], limits());
  let n = 0;
  const result = await searchPolicy(s, { automatic: plan.rules, canContinue: () => true, evaluate: async grants => ({ id: String(n++), verdict: grants.includes('@workspace') || grants.includes('@workspace/dist') ? 'pass' : 'fail' }) });
  assert.deepEqual(result.grants, ['@workspace/dist']);
  assert.ok(result.steps.some(s => s.source === 'file_changes' && s.evidence_ids.includes('baseline-1')));
  assert.ok(result.steps.some(s => s.decision === 'rejected' && s.recovery_id));
});
