import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema, limitsSchema, scenarioSchema, validatePolicy, aliasSchema } from '../src/config.js';
import { discoverReads, readInventory } from '../src/read-discovery.js';
import { searchPolicy } from '../src/search.js';
import { exactReadPattern, policyFor } from '../src/backend.js';
import { controlChecks, startEndpoint, closeEndpoint } from '../src/probes.js';

const scenario = () => scenarioSchema.parse({ id: 'build', command: ['node'], initial_write_grants: ['@workspace'], initial_read_grants: ['@workspace'], assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }] });
const limits = () => limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace'], allowed_read_roots: ['@workspace'] });

test('read rules are opt-in, project-only and require an independent trusted ceiling', () => {
  const config = configSchema.parse({ schema_version: 1, scenarios: [scenario()] });
  const l = limits(); validatePolicy(config, l);
  delete l.allowed_read_roots;
  assert.throws(() => validatePolicy(config, l), /explicit allowed_read_roots/);
  l.allowed_read_roots = ['@workspace/src'];
  assert.throws(() => validatePolicy(config, l), /Read grant exceeds/);
  config.scenarios[0].initial_read_grants = ['@workspace/src-other'];
  assert.throws(() => validatePolicy(config, l), /exceeds/);
  assert.throws(() => scenarioSchema.parse({ ...scenario(), initial_read_grants: ['@cache'] }));
  assert.equal(aliasSchema.safeParse('@workspace/.permsift-read-checks/fake-secret').success, false);
  assert.equal(aliasSchema.safeParse('@workspace/node_modules/@scope/package').success, true);
  config.scenarios[0].initial_read_grants = ['@workspace/src', '@workspace/src'];
  assert.throws(() => validatePolicy(config, l), /Duplicate read/);
  config.scenarios[0].initial_read_grants = [];
  config.scenarios[0].narrower_read_candidates = [{ from: '@workspace/src', to: ['@workspace'] }];
  assert.throws(() => validatePolicy(config, l), /strict descendants/);
  delete config.scenarios[0].initial_read_grants;
  assert.throws(() => validatePolicy(config, l), /require initial_read/);
});

test('read search uses read candidates, restores reads and resumes from the current policy', async () => {
  const s = scenario(); s.narrower_read_candidates = [{ from: '@workspace', to: ['@workspace/task.cjs', '@workspace/unused'] }];
  const phases: string[] = [];
  const result = await searchPolicy(s, { permission: 'read', canContinue: () => true, evaluate: async (grants, phase) => {
    phases.push(phase); return { id: String(phases.length), verdict: grants.includes('@workspace') || grants.includes('@workspace/task.cjs') ? 'pass' : 'fail' };
  } });
  assert.deepEqual(result.grants, ['@workspace/task.cjs']);
  assert.ok(result.steps.every(s => s.permission === 'read'));
  assert.ok(phases.includes('recovery_read'));
  const resumed = await searchPolicy(s, { permission: 'read', initialGrants: result.grants, canContinue: () => false, evaluate: async () => { throw new Error('must not run'); } });
  assert.deepEqual(resumed.grants, result.grants);
});

test('read discovery inventories existing files and never proposes partial or symlink child lists', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-read-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = { workspace: root, cache: root, tmp: root };
  await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src', 'main.cjs'), 'code');
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  await fs.mkdir(path.join(root, '.permsift-read-checks')); await fs.writeFile(path.join(root, '.permsift-read-checks', 'fake-secret'), 'fake');
  const inventory = await readInventory(roots, limits());
  assert.deepEqual(inventory.groups.find(g => g.from === '@workspace')?.to, ['@workspace/package.json', '@workspace/src']);
  assert.deepEqual(inventory.groups.find(g => g.from === '@workspace/src')?.to, ['@workspace/src/main.cjs']);
  const plan = discoverReads(scenario(), [{ ...inventory, id: 'baseline' }], limits());
  assert.ok(plan.rules.every(r => r.source === 'input_structure' && r.evidence_ids[0] === 'baseline'));
  const capped = await readInventory(roots, { ...limits(), max_read_discovery_entries: 1 });
  assert.equal(capped.truncated, true); assert.equal(capped.groups.length, 0);
  await fs.symlink('src/main.cjs', path.join(root, 'linked'));
  const linked = await readInventory(roots, limits());
  assert.equal(linked.truncated, true); assert.ok(!linked.groups.some(g => g.from === '@workspace'));
  const ceiling = discoverReads({ ...scenario(), initial_read_grants: ['@workspace/src'] }, [{ ...inventory, id: 'b' }], { ...limits(), allowed_read_roots: ['@workspace/src'] });
  assert.deepEqual(ceiling.rules.map(r => r.from), ['@workspace/src']);
});

test('backend encodes exact file grants and workspace cwd access without recursive read widening', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-read-policy-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = { workspace: path.join(root, 'workspace'), cache: path.join(root, 'cache'), tmp: path.join(root, 'tmp') };
  for (const directory of Object.values(roots)) await fs.mkdir(directory);
  await fs.writeFile(path.join(roots.workspace, 'task.cjs'), 'code');
  const context = { roots, experimentRoot: root, protectedPaths: [], grants: ['@workspace'], readGrants: ['@workspace/task.cjs'], invocationId: 'unit', timeoutMs: 1000, maxOutputBytes: 4096 };
  const policy = await policyFor(context);
  assert.ok(policy.filesystem.allowRead?.includes(exactReadPattern(roots.workspace)));
  assert.ok(policy.filesystem.allowRead?.includes(exactReadPattern(path.join(roots.workspace, 'task.cjs'))));
  assert.ok(!policy.filesystem.allowRead?.includes(roots.workspace));
  assert.throws(() => exactReadPattern('/tmp/unsafe[1]/file.cjs'), /metacharacters/);
  await fs.symlink('task.cjs', path.join(roots.workspace, 'linked'));
  await assert.rejects(policyFor({ ...context, readGrants: ['@workspace/linked'] }), /symlink/i);
  await assert.rejects(policyFor({ ...context, readGrants: ['@workspace/missing'] }), /ENOENT/);
});

test('missing or changed fake read fixtures are unknown and are never silently recreated', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-read-control-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const endpoint = await startEndpoint(); t.after(() => closeEndpoint(endpoint.server));
  const fixtures = { secret: path.join(root, 'secret'), outside: path.join(root, 'outside'), report: path.join(root, 'report'), marker: 'fake', port: endpoint.port,
    reads: [{ path: path.join(root, 'read'), alias: '@workspace/fake', expected: 'denied' as const }] };
  for (const file of [fixtures.secret, fixtures.outside, fixtures.report, fixtures.reads[0].path]) await fs.writeFile(file, 'fake');
  assert.ok((await controlChecks(fixtures)).every(c => c.status === 'pass'));
  await fs.writeFile(fixtures.reads[0].path, 'changed');
  assert.equal((await controlChecks(fixtures)).find(c => c.name === 'control:@workspace/fake')?.status, 'unknown');
  assert.equal(await fs.readFile(fixtures.reads[0].path, 'utf8'), 'changed');
  await fs.unlink(fixtures.reads[0].path);
  assert.equal((await controlChecks(fixtures)).find(c => c.name === 'control:@workspace/fake')?.status, 'unknown');
});
