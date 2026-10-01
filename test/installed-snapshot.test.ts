import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { InstalledSnapshots, installationKey, rootHashes } from '../src/installed-snapshot.js';
import { configSchema, limitsSchema, validatePolicy } from '../src/config.js';
import { readInventory } from '../src/read-discovery.js';

test('installation keys bind the full input, environment, cache condition, install policy, preparation and ceiling', () => {
  const input = { snapshot: 'source-a', environment: { npm: '11', node: '24', arch: 'arm64', permsift: '0.6' }, installation: { lock: 'a', cache: 'cold' }, policy: { write: ['@workspace'], network: ['registry.npmjs.org'] }, preparation: ['@workspace/dist'], limits: { allowed_write_roots: ['@workspace'] } };
  const key = installationKey(input);
  for (const field of Object.keys(input) as (keyof typeof input)[]) assert.notEqual(installationKey({ ...input, [field]: { changed: true } }), key, field);
  assert.equal(installationKey(structuredClone(input)), key);
});

test('only published snapshots can be reused; clones isolate content, links, permissions and deletions across all roots', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-installed-unit-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const roots = { workspace: path.join(directory, 'workspace'), cache: path.join(directory, 'cache'), tmp: path.join(directory, 'tmp') };
  for (const root of Object.values(roots)) { await fs.mkdir(root); await fs.writeFile(path.join(root, 'data'), 'original'); }
  await fs.symlink('data', path.join(roots.workspace, 'link'));
  const store = new InstalledSnapshots(path.join(directory, 'snapshots'), 1_000_000), options = { timeoutMs: 10_000 };
  const snapshot = await store.capture('key', roots, 'full-trial', options);
  const first = { workspace: path.join(directory, 'first-w'), cache: path.join(directory, 'first-c'), tmp: path.join(directory, 'first-t') };
  await assert.rejects(store.fork('key', first, options), /No verified/);
  store.publish(snapshot);
  assert.equal((await store.fork('key', first, options)).source_trial, 'full-trial');
  await fs.writeFile(path.join(first.workspace, 'link'), 'changed'); await fs.chmod(path.join(first.cache, 'data'), 0o600); await fs.rm(first.tmp, { recursive: true });
  const second = { workspace: path.join(directory, 'second-w'), cache: path.join(directory, 'second-c'), tmp: path.join(directory, 'second-t') };
  await store.fork('key', second, options);
  assert.deepEqual(await rootHashes(second, 1_000_000), snapshot.hashes);
  await assert.rejects(store.fork('other-key', { ...second, workspace: path.join(directory, 'other') }, options), /No verified/);
  const mode = (await fs.stat(snapshot.roots.cache)).mode & 0o777; await fs.chmod(snapshot.roots.cache, 0o500);
  await assert.rejects(store.fork('key', roots, options), /was changed/); await fs.chmod(snapshot.roots.cache, mode);
  await fs.writeFile(path.join(snapshot.roots.cache, 'data'), 'tampered');
  await assert.rejects(store.fork('key', roots, options), /was changed/);
});

test('snapshot capture rejects escaping links and canceled work instead of publishing it', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-installed-links-'))); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const roots = { workspace: path.join(directory, 'w'), cache: path.join(directory, 'c'), tmp: path.join(directory, 't') }; for (const root of Object.values(roots)) await fs.mkdir(root);
  await fs.symlink(roots.cache, path.join(roots.workspace, 'outside'));
  const store = new InstalledSnapshots(path.join(directory, 'snapshots'), 1000);
  await assert.rejects(store.capture('bad', roots, 'source', { timeoutMs: 1000 }), /External symlink/);
  await fs.unlink(path.join(roots.workspace, 'outside'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(store.capture('canceled', roots, 'source', { timeoutMs: 1000, signal: controller.signal }), /interrupted/);
  await assert.rejects(fs.access(path.join(directory, 'snapshots', 'canceled')));
});

test('separate install writes have their own validation and permit opt-in task reads', () => {
  const config = configSchema.parse({ schema_version: 1, exclude: ['node_modules'], scenarios: [{ id: 'test', install: { manager: 'npm', initial_write_grants: ['@workspace/node_modules', '@cache'] }, command: ['node', 'test.cjs'], initial_write_grants: ['@workspace/reports'], initial_read_grants: ['@workspace'], assertions: [{ type: 'file_exists', path: '@workspace/reports/out' }] }] });
  const limits = limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace', '@cache'], allowed_read_roots: ['@workspace'], allowed_network_domains: [] });
  validatePolicy(config, limits);
  assert.throws(() => validatePolicy(config, { ...limits, allowed_write_roots: ['@workspace/reports'] }), /Install grant exceeds/);
  config.scenarios[0].install!.initial_write_grants = ['@cache', '@cache']; assert.throws(() => validatePolicy(config, limits), /Duplicate install/);
});

test('installed read inventory stops at package directories, handles scopes, and retains bounded incomplete coverage', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-package-reads-'))); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const pkg of ['used', 'unused', '@scope/needed']) { await fs.mkdir(path.join(directory, 'node_modules', pkg, 'deep'), { recursive: true }); await fs.writeFile(path.join(directory, 'node_modules', pkg, 'deep', 'index.js'), '42'); }
  const limits = limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace'], max_read_discovery_depth: 8 });
  const inventory = await readInventory({ workspace: directory, cache: directory, tmp: directory }, limits, true);
  assert.ok(inventory.groups.some(g => g.from === '@workspace/node_modules' && g.to.includes('@workspace/node_modules/unused')));
  assert.ok(inventory.groups.some(g => g.from === '@workspace/node_modules/@scope' && g.to.includes('@workspace/node_modules/@scope/needed')));
  assert.ok(!inventory.entries.some(e => e.alias.includes('/deep'))); assert.equal(inventory.truncated, true);
  const bounded = await readInventory({ workspace: directory, cache: directory, tmp: directory }, { ...limits, max_read_discovery_entries: 2 }, true);
  assert.ok(bounded.entries.length <= 2); assert.equal(bounded.truncated, true);
});
