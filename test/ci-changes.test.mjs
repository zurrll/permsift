import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyChangedPaths, classifyEvent } from '../scripts/ci-changes.mjs';
import { parse } from 'yaml';

test('only the explicit documentation allowlist skips sandbox execution', () => {
  assert.equal(classifyChangedPaths(['README.md', 'CHANGELOG.md', 'docs/nested/说明.md']).sandbox, false);
  for (const paths of [[], ['docs/example.json'], ['src/a.ts', 'docs/a.md'], ['test/a.md'], ['scripts/a.mjs'], ['.github/workflows/ci.yml'], ['package-lock.json'], ['unknown.md'], ['docs/../src/a.md'], ['docs/a\nb.md']])
    assert.equal(classifyChangedPaths(paths).sandbox, true, JSON.stringify(paths));
  assert.equal(classifyEvent('push', { before: '0'.repeat(40), after: 'a'.repeat(40) }).sandbox, true);
  assert.equal(classifyEvent('unknown', {}).sandbox, true);
  assert.equal(classifyEvent('push', { before: 'a'.repeat(40), after: 'b'.repeat(40) }, '/missing-repository').sandbox, true);
});

test('the whole push diff retains earlier code changes, deletions and renames', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-ci-diff-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  await fs.mkdir(path.join(cwd, 'docs')); await fs.writeFile(path.join(cwd, 'README.md'), 'initial');
  const initial = commit();
  await fs.writeFile(path.join(cwd, 'docs/a.md'), 'docs'); const docs = commit();
  assert.equal(classifyEvent('push', { before: initial, after: docs }, cwd).sandbox, false);
  await fs.writeFile(path.join(cwd, 'code.ts'), 'code'); const code = commit();
  await fs.writeFile(path.join(cwd, 'docs/a.md'), 'new docs'); const mixed = commit();
  assert.equal(classifyEvent('push', { before: docs, after: mixed }, cwd).sandbox, true);
  await fs.rename(path.join(cwd, 'code.ts'), path.join(cwd, 'docs/moved.md')); const moved = commit();
  assert.equal(classifyEvent('push', { before: mixed, after: moved }, cwd).sandbox, true);
  assert.equal(classifyEvent('push', { before: code, after: code }, cwd).sandbox, true, 'Empty diff falls back to full coverage');
  assert.equal(classifyEvent('push', { before: 'f'.repeat(40), after: moved }, cwd).sandbox, true);
});

test('PR selection compares the complete branch change against its merge base', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-ci-pr-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  await fs.writeFile(path.join(cwd, 'README.md'), 'base'); const root = commit();
  git('checkout', '-qb', 'main-fixture'); await fs.writeFile(path.join(cwd, 'main.ts'), 'main only'); const base = commit();
  git('checkout', '-qb', 'pr-fixture', root); await fs.writeFile(path.join(cwd, 'README.md'), 'PR docs'); const docs = commit();
  const event = head => ({ pull_request: { base: { sha: base }, head: { sha: head } } });
  assert.equal(classifyEvent('pull_request', event(docs), cwd).sandbox, false);
  await fs.writeFile(path.join(cwd, 'pr.ts'), 'PR code'); const code = commit();
  await fs.writeFile(path.join(cwd, 'README.md'), 'more PR docs'); const head = commit();
  assert.equal(classifyEvent('pull_request', event(head), cwd).sandbox, true);
  assert.equal(classifyEvent('pull_request', { pull_request: { base: { sha: base } } }, cwd).sandbox, true);
});

test('the actual workflow distinguishes docs skips from failed, cancelled or missing sandbox execution', async () => {
  const workflow = parse(await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
  assert.ok(workflow.concurrency.group.includes('github.workflow') && workflow.concurrency.group.includes('github.ref'));
  assert.equal(workflow.jobs.changes.steps[0].with['fetch-depth'], 0);
  for (const name of ['sandbox-core', 'sandbox-install']) {
    assert.equal(workflow.jobs[name].needs, 'changes');
    assert.equal(workflow.jobs[name].if, "needs.changes.outputs.sandbox == 'true'");
  }
  assert.equal(workflow.jobs.unit.needs, undefined, 'Linux checks remain independent and always selected');
  const guard = workflow.jobs.sandbox.steps[0].run;
  for (const [classification, selection, core, install, expected] of [
    ['success', 'true', 'success', 'success', 0], ['success', 'false', 'skipped', 'skipped', 0],
    ['failure', 'false', 'skipped', 'skipped', 1], ['cancelled', 'true', 'success', 'success', 1],
    ['success', 'true', 'failure', 'success', 1], ['success', 'true', 'cancelled', 'success', 1],
    ['success', 'true', 'skipped', 'success', 1], ['success', 'false', 'success', 'skipped', 1],
    ['success', '', 'skipped', 'skipped', 1],
  ]) {
    try { execFileSync('bash', ['-c', guard], { env: { ...process.env, CHANGES_RESULT: classification, RUN_SANDBOX: selection, CORE_RESULT: core, INSTALL_RESULT: install }, stdio: 'pipe' }); assert.equal(expected, 0); }
    catch (error) { assert.equal(expected, 1); assert.equal(error.status, 1); }
  }
});
