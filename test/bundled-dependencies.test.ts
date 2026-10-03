import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectInstall } from '../src/install.js';
import { assertBundledEvidence, checkBundledInstall, type BundledPlan } from '../src/bundled-dependencies.js';

type Entry = Record<string, any>;
const parent = () => ({ version: '1.0.0', resolved: 'https://registry.npmjs.org/parent/-/parent-1.0.0.tgz', integrity: 'sha512-YWJjZA==',
  bundleDependencies: ['@scope/child'], dependencies: { '@scope/child': '1.0.0' } });
const entries = (): Record<string, Entry> => ({
  '': {}, 'node_modules/parent': parent(),
  'node_modules/parent/node_modules/@scope/child': { version: '1.0.0', inBundle: true, dependencies: { shared: '2.0.0' } },
  'node_modules/parent/node_modules/shared': { version: '2.0.0', inBundle: true, dependencies: { '@scope/child': '1.0.0' } },
});
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-bundled-unit-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  const inspect = async (packages = entries(), version = 3) => {
    await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: version, packages }));
    return inspectInstall({ install: { manager: 'npm', cache: 'cold', registry: 'https://registry.npmjs.org/' } }, root);
  };
  const materialize = async (plan: BundledPlan) => {
    for (const pkg of [...plan.owners, ...plan.packages]) {
      await fs.mkdir(path.join(root, pkg.path), { recursive: true });
      await fs.writeFile(path.join(root, pkg.path, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version,
        ...'dependencies' in pkg ? { bundleDependencies: pkg.dependencies } : {} }));
    }
  };
  return { root, inspect, materialize };
}
test('v2/v3 bundled roots, scoped transitives, hoisting and cycles resolve to a checked tarball owner', async t => {
  const f = await fixture(t);
  for (const version of [2, 3]) {
    const input = await f.inspect(entries(), version);
    assert.deepEqual(input.resolved_domains, ['registry.npmjs.org']);
    assert.equal(input.bundled!.packages.length, 2);
    assert.ok(input.bundled!.packages.every(p => p.owner === 'node_modules/parent'));
    assert.equal(input.bundled!.owners.length, 1);
    await f.materialize(input.bundled!);
    assert.ok((await checkBundledInstall(f.root, input.bundled!)).every(c => c.status === 'pass'));
  }
});
test('nested bundled dependencies remain owned by the containing registry tarball', async t => {
  const f = await fixture(t), p = entries();
  p['node_modules/parent/node_modules/@scope/child'].bundleDependencies = ['inner'];
  p['node_modules/parent/node_modules/@scope/child/node_modules/inner'] = { version: '1', inBundle: true };
  const input = await f.inspect(p);
  assert.equal(input.bundled!.packages.length, 3);
  assert.ok(input.bundled!.packages.every(v => v.owner === 'node_modules/parent'));
});
test('boolean and alternate bundle declaration spelling normalize without contradictory aliases', async t => {
  const f = await fixture(t), p = entries();
  p['node_modules/parent'].bundledDependencies = true;
  delete p['node_modules/parent'].bundleDependencies;
  assert.equal((await f.inspect(p)).bundled!.packages.length, 2);
  p['node_modules/parent'].bundleDependencies = ['other'];
  await assert.rejects(f.inspect(p), /Conflicting/);
  p['node_modules/parent'].bundleDependencies = ['@scope/child', '@scope/child'];
  await assert.rejects(f.inspect(p), /Invalid bundleDependencies/);
  p['node_modules/parent'].bundleDependencies = null; delete p['node_modules/parent'].bundledDependencies;
  await assert.rejects(f.inspect(p), /Invalid bundleDependencies/);
});
test('inBundle cannot exempt orphan, unrelated, wrongly placed or unanchored packages from integrity checks', async t => {
  const f = await fixture(t);
  for (const extra of ['node_modules/orphan', 'node_modules/parent/node_modules/unrelated', 'node_modules/else/node_modules/@scope/child']) {
    const p = entries(); p[extra] = { version: '1.0.0', inBundle: true };
    await assert.rejects(f.inspect(p), /no verified declaring owner/);
  }
  const missing = entries(); delete missing['node_modules/parent'].integrity;
  await assert.rejects(f.inspect(missing), /integrity are required/);
  const absent = entries(); delete absent['node_modules/parent/node_modules/@scope/child'];
  await assert.rejects(f.inspect(absent), /missing or not inBundle/);
  const external = entries(); delete external['node_modules/parent/node_modules/shared'];
  external['node_modules/shared'] = { version: '2.0.0', inBundle: true };
  await assert.rejects(f.inspect(external), /no verified declaring owner/);
});
test('bundle flags cannot hide malformed paths, links, URLs or incomplete supplied download metadata', async t => {
  const f = await fixture(t), key = 'node_modules/parent/node_modules/shared';
  for (const fields of [{ link: true }, { inBundle: 'true' }, { resolved: 'https://registry.npmjs.org/shared.tgz' },
    { resolved: 'file:../outside', integrity: 'sha512-YWJjZA==' }]) {
    const p = entries(); Object.assign(p[key], fields); await assert.rejects(f.inspect(p));
  }
  for (const name of ['node_modules/parent/other', 'node_modules/../escape', 'node_modules/@scope', 'node_modules/parent\\escape']) {
    const p = entries(); p[name] = { version: '1.0.0', inBundle: true }; await assert.rejects(f.inspect(p), /package location/);
  }
  const p = entries(); Object.assign(p[key], { resolved: 'https://extra.example/shared.tgz', integrity: 'sha512-YWJjZA==' });
  assert.deepEqual((await f.inspect(p)).resolved_domains, ['extra.example', 'registry.npmjs.org']);
});
test('installed package absence, version/name mismatches and parent declarations never pass', async t => {
  const f = await fixture(t), plan = (await f.inspect()).bundled!;
  await f.materialize(plan);
  const child = path.join(f.root, plan.packages[0].path, 'package.json');
  for (const value of [{ name: plan.packages[0].name, version: 'wrong' }, { name: 'wrong', version: plan.packages[0].version }]) {
    await fs.writeFile(child, JSON.stringify(value));
    assert.ok((await checkBundledInstall(f.root, plan)).some(c => c.status === 'fail'));
  }
  await f.materialize(plan);
  await fs.writeFile(path.join(f.root, 'node_modules/parent/package.json'), JSON.stringify({ name: 'parent', version: '1.0.0', bundleDependencies: ['other'] }));
  assert.ok((await checkBundledInstall(f.root, plan)).some(c => c.status === 'fail'));
  await f.materialize(plan); await fs.rm(child);
  assert.ok((await checkBundledInstall(f.root, plan)).some(c => c.status === 'fail'));
});
test('linked, oversized and cancelled extracted metadata is explicitly unknown', async t => {
  const f = await fixture(t), plan = (await f.inspect()).bundled!; await f.materialize(plan);
  const child = path.join(f.root, plan.packages[0].path, 'package.json');
  await fs.rm(child); await fs.symlink(path.join(f.root, 'package.json'), child);
  assert.ok((await checkBundledInstall(f.root, plan)).some(c => c.status === 'unknown'));
  await fs.rm(child); await fs.writeFile(child, ' '.repeat(1_048_577));
  assert.ok((await checkBundledInstall(f.root, plan)).some(c => c.status === 'unknown'));
  const controller = new AbortController(); controller.abort();
  assert.equal((await checkBundledInstall(f.root, plan, controller.signal))[0].status, 'unknown');
  assert.equal((await checkBundledInstall(f.root, plan, undefined, 0))[0].status, 'unknown');
});
test('saved bundled proof cannot claim pass with absent, duplicate, unrelated or failed checks', async t => {
  const f = await fixture(t), plan = (await f.inspect()).bundled!; await f.materialize(plan);
  const checks = await checkBundledInstall(f.root, plan);
  assert.doesNotThrow(() => assertBundledEvidence(plan, { verdict: 'pass', bundled_checks: checks }, true));
  assert.doesNotThrow(() => assertBundledEvidence(undefined, undefined, true)); // Legacy input has no new claim.
  assert.doesNotThrow(() => assertBundledEvidence(plan, undefined)); // Snapshot-only trial.
  for (const broken of [undefined, { verdict: 'pass' }, { verdict: 'pass', bundled_checks: checks.slice(1) },
    { verdict: 'pass', bundled_checks: [...checks, checks[0]] }, { verdict: 'pass', bundled_checks: checks.map(c => ({ ...c, name: c.name + '-other' })) },
    { verdict: 'pass', bundled_checks: checks.map(c => ({ ...c, status: 'fail' })) }, { verdict: 'unknown', bundled_checks: checks }]) {
    assert.throws(() => assertBundledEvidence(plan, broken, true));
  }
});
