import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { integrationSuites, scenarioCommands } from '../scripts/ci-suites.mjs';

test('default macOS partitions execute every integration file once and new files join core', async () => {
  const files = (await fs.readdir(new URL('../dist/test/integration/', import.meta.url))).filter(f => f.endsWith('.test.js'));
  const suites = integrationSuites([...files, 'new-coverage.test.js']);
  assert.deepEqual([...suites.core, ...suites.install].sort(), suites.all);
  assert.equal(new Set([...suites.core, ...suites.install]).size, suites.all.length);
  assert.ok(suites.core.includes('new-coverage.test.js'));
  assert.throws(() => integrationSuites(files.filter(f => f !== 'install.test.js')), /missing/);
  assert.throws(() => integrationSuites([...files, files[0]]), /Invalid/);
});

test('manual scenarios keep preparation before consumers and reject unknown selections', () => {
  const projects = scenarioCommands('projects');
  assert.ok(projects.findIndex(c => c[2] === 'examples:prepare') < projects.findIndex(c => c[2] === 'onboarding:verify'));
  assert.deepEqual(projects.find(c => c[2] === 'onboarding:verify'), ['npm', 'run', 'onboarding:verify', '--', '--live']);
  const upstream = scenarioCommands('upstream');
  assert.ok(upstream.findIndex(c => c[2] === 'third-party:prepare') < upstream.findIndex(c => c[2] === 'third-party:verify'));
  assert.ok(upstream.findIndex(c => c[2] === 'regression:prepare') < upstream.findIndex(c => c[2] === 'regression:verify'));
  assert.throws(() => scenarioCommands('__proto__'), /Unknown/);
  assert.throws(() => scenarioCommands('typo'), /Unknown/);
});

test('CI runner preserves failures/signals, stops later commands and records its selected scope', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-ci-runner-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'npm'), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.CI_TEST_LOG,process.argv[3]+'\\n');if(process.argv[3]==='maintenance:verify'){if(process.env.CI_TEST_MODE==='signal')process.kill(process.pid,'SIGTERM');else if(process.env.CI_TEST_MODE==='fail')process.exit(7);else if(process.env.CI_TEST_MODE==='parent-signal'){process.on('SIGTERM',()=>process.exit(0));process.kill(process.ppid,'SIGTERM');setInterval(()=>{},1000);}}\n`, { mode: 0o700 });
  const runner = fileURLToPath(new URL('../scripts/run-ci-scenarios.mjs', import.meta.url));
  for (const mode of ['fail', 'signal', 'parent-signal', 'complete']) {
    const cwd = path.join(root, mode); await fs.mkdir(cwd); const journal = path.join(cwd, 'commands');
    const result = spawnSync(process.execPath, [runner, 'local'], { cwd, env: { ...process.env, PATH: bin, CI_TEST_LOG: journal, CI_TEST_MODE: mode }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, mode === 'fail' ? 7 : mode === 'complete' ? 0 : 143, result.stderr);
    const dirs = await fs.readdir(path.join(cwd, '.permsift'));
    const receipt = JSON.parse(await fs.readFile(path.join(cwd, '.permsift', dirs[0], 'verification.json'), 'utf8'));
    assert.equal(receipt.status, mode === 'complete' ? 'completed' : mode === 'fail' ? 'failed' : 'interrupted');
    assert.equal(receipt.selection.scope, 'extended_scenarios_not_default_regression');
    if (mode !== 'complete') {
      assert.deepEqual((await fs.readFile(journal, 'utf8')).trim().split('\n'), ['environment:verify', 'maintenance:verify']);
      assert.equal(receipt.commands.at(-1).exit_code, mode === 'fail' ? 7 : mode === 'parent-signal' ? 0 : null);
      if (mode === 'parent-signal') assert.equal(receipt.commands.at(-1).interruption_requested, 'SIGTERM');
    }
  }
  const invalid = spawnSync(process.execPath, [runner, 'unknown'], { cwd: root, env: { ...process.env, PATH: bin }, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0); await assert.rejects(fs.access(path.join(root, '.permsift')));
});
