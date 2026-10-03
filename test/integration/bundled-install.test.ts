import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { bundledRegistry } from '../support/bundled-registry.js';
import { runExperiment, type Report } from '../../src/engine.js';
import { runObservation } from '../../src/observe-command.js';
import { loadUsage } from '../../src/usage-report.js';
import { manifest } from '../../src/filesystem.js';

const macOnly = { skip: process.platform !== 'darwin' ? 'Requires the real macOS sandbox and npm proxy' : false };
async function fixture(t: TestContext, material?: NonNullable<Parameters<typeof bundledRegistry>[0]>['material']) {
  const f = await bundledRegistry({ material });
  t.after(async () => { await f.close(); await fs.rm(f.root, { recursive: true, force: true }); });
  return f;
}
const evidence = async (report: Report) => JSON.parse(await fs.readFile(path.join(report.output, report.trials[0].evidence), 'utf8'));

test('a single checked tarball installs scoped/hoisted bundles, keeps scripts disabled and observes actual nested loads', macOnly, async t => {
  const f = await fixture(t), before = await manifest(f.project);
  const usage = await runObservation({ configPath: f.configPath, limitsPath: f.limitsPath, output: path.join(f.root, 'observe') });
  assert.equal(usage.status, 'observed', JSON.stringify(usage.tasks));
  const report = JSON.parse(await fs.readFile(path.join(usage.output, 'report.json'), 'utf8')) as Report, e = await evidence(report);
  assert.equal(report.trials.length, 1); assert.equal(report.trials[0].phase, 'observe');
  assert.equal(e.installation.bundled_checks.length, 3); assert.ok(e.installation.bundled_checks.every((c: any) => c.status === 'pass'));
  assert.deepEqual(e.task.policy.network.allowedDomains, []);
  assert.deepEqual(f.requests, ['/parent.tgz']);
  const task = usage.tasks[0]; assert.notEqual(task.capture_status, 'not_run');
  if (task.capture_status === 'not_run') throw new Error();
  assert.equal(task.inventory.complete, true); assert.equal(task.inventory.packages.length, 3);
  assert.deepEqual(task.inventory.locked_not_installed, []); assert.deepEqual(task.inventory.lock_version_mismatches, []);
  assert.deepEqual(task.loaded_packages.map(p => p.path), ['@workspace/node_modules/parent', '@workspace/node_modules/parent/node_modules/@scope/child', '@workspace/node_modules/parent/node_modules/shared']);
  const restored = (await loadUsage(path.join(usage.output, 'usage.json'))).tasks[0];
  assert.notEqual(restored.capture_status, 'not_run');
  if (restored.capture_status === 'not_run') throw new Error();
  assert.equal(restored.inventory?.complete, true);
  assert.deepEqual(restored.inventory?.packages.map(p => p.path), task.inventory.packages.map(p => p.path));
  assert.deepEqual(restored.loaded_packages.map(p => ({ path: p.path, version: p.version, modules: p.modules })),
    task.loaded_packages.map(p => ({ path: p.path, version: p.version, modules: p.modules })));
  assert.deepEqual(await manifest(f.project), before);
});
test('missing extracted bundle fails after npm exits zero, even if the configured output assertion passes', macOnly, async t => {
  const f = await fixture(t, 'missing');
  // npm itself can finish despite the lock claiming a bundled package absent from its tarball.
  // This assertion's parent file exists; the independent install result must still gate the task.
  f.config.scenarios[0].assertions = [{ type: 'file_exists', path: '@workspace/node_modules/parent/package.json' }] as any;
  await f.save();
  const report = await runExperiment({ configPath: f.configPath, limitsPath: f.limitsPath, mode: 'run', output: path.join(f.root, 'missing') }), e = await evidence(report);
  assert.equal(e.installation.execution.process.exit_code, 0);
  assert.equal(e.installation.verdict, 'fail'); assert.ok(e.installation.bundled_checks.some((c: any) => c.status === 'fail'));
  assert.ok(e.assertions.every((c: any) => c.status === 'pass'));
  assert.equal(e.task, undefined); assert.match(e.task_skipped, /Install did not pass/);
  assert.equal(report.status, 'failed'); assert.equal(report.trials[0].verdict, 'fail');
  assert.equal(report.trials[0].diagnosis!.kind, 'installation_verification_failure');
  await assert.rejects(fs.access(path.join(report.output, 'recommended.yaml')));
});
test('wrong extracted version or bundle declaration blocks the offline task', macOnly, async t => {
  for (const material of ['wrong-version', 'wrong-declaration'] as const) {
    const f = await fixture(t, material);
    const report = await runExperiment({ configPath: f.configPath, limitsPath: f.limitsPath, mode: 'run', output: path.join(f.root, 'mismatch') }), e = await evidence(report);
    assert.equal(e.installation.execution.process.exit_code, 0);
    assert.equal(e.installation.verdict, 'fail'); assert.ok(e.installation.bundled_checks.some((c: any) => c.status === 'fail'));
    assert.equal(e.task, undefined); assert.equal(report.status, 'failed');
  }
});
test('parent integrity failure and denied registry still prevent bundled installation and task execution', macOnly, async t => {
  const f = await fixture(t);
  f.lock.packages['node_modules/parent'].integrity = 'sha512-' + Buffer.alloc(64).toString('base64'); await f.save();
  const broken = await runExperiment({ configPath: f.configPath, limitsPath: f.limitsPath, mode: 'run', output: path.join(f.root, 'integrity') }), e = await evidence(broken);
  assert.equal(broken.status, 'failed'); assert.match(e.installation.execution.process.stderr, /EINTEGRITY/);
  assert.equal(e.installation.bundled_checks, undefined); assert.equal(e.task, undefined);
  f.config.scenarios[0].initial_network_grants = []; await f.save(); const before = f.requests.length;
  const denied = await runExperiment({ configPath: f.configPath, limitsPath: f.limitsPath, mode: 'run', output: path.join(f.root, 'denied') });
  assert.equal(denied.status, 'failed'); assert.equal(f.requests.length, before); assert.equal((await evidence(denied)).task, undefined);
});
