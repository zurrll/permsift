import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sourceManifest, verifySource, sha256, command, cli, totals, writeJson } from '../scripts/lib/trial-support.mjs';

test('trial manifest detects edited bytes and rejects dependencies, links, and escaping paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-trial-source-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'source.js'), 'export const value = 1;\n');
  const files = await sourceManifest(root, ['source.js']);
  const manifest = { files, source_sha256: sha256(JSON.stringify(files)) };
  await verifySource(root, manifest);
  await fs.writeFile(path.join(root, 'source.js'), 'export const value = 2;\n');
  await assert.rejects(verifySource(root, manifest), /differs/);
  await fs.symlink(path.join(root, 'source.js'), path.join(root, 'linked.js'));
  await assert.rejects(sourceManifest(root, ['linked.js']), /ordinary file/);
  await fs.symlink(root, path.join(root, 'linked-parent'));
  await assert.rejects(sourceManifest(root, ['linked-parent/source.js']), /linked path component/);
  for (const file of ['../source.js', '/tmp/source.js', 'node_modules/pkg/index.js', '.permsift/report.json', 'dist/cli.js']) await assert.rejects(sourceManifest(root, [file]), /unsafe source path/);
});

test('failed trial command preserves its exit code and both logs', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-trial-command-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receipt = { steps: [] };
  const r = await command(receipt, root, 'failure', process.execPath, ['-e', "process.stdout.write('partial'); process.stderr.write('why'); process.exit(2)"], { quiet: true });
  assert.equal(r.code, 2); assert.equal(receipt.steps[0].exit_code, 2);
  assert.equal(await fs.readFile(path.join(root, 'failure.stdout'), 'utf8'), 'partial');
  assert.equal(await fs.readFile(path.join(root, 'failure.stderr'), 'utf8'), 'why');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'verification.json'), 'utf8')), receipt);
});

test('failed install and nested check attempts are counted without pretending a task ran', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-trial-counts-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'), output = path.join(root, 'output'), child = path.join(output, 'stages/old');
  await fs.mkdir(path.join(repository, 'dist'), { recursive: true }); await fs.mkdir(child, { recursive: true });
  await fs.writeFile(path.join(repository, 'dist/cli.js'), "process.stdout.write('{}'); process.exit(2);");
  const evidence = 'evidence.json';
  await writeJson(path.join(child, evidence), { task_skipped: 'Installation threw before returning complete execution evidence' });
  await writeJson(path.join(child, 'report.json'), { output: child, trials: [{ evidence, timings: { phases: { install: { duration_ms: 100, calls: 1 } } } }] });
  await writeJson(path.join(output, 'report.json'), { kind: 'regression', tasks: [{ stages: [{ report: 'stages/old/report.md' }] }] });
  const receipt = { steps: [] };
  await assert.rejects(cli(receipt, root, repository, 'check', ['check', '--output', output], { quiet: true }));
  assert.deepEqual(totals(receipt.steps), { trials: 1, task_executions: 0, installations: 1, install_ms: 100, task_ms: 0, protection_ms: 0, incomplete_counts: [] });
});

test('an extracted trial can be exported without Git and never includes local dependencies or build output', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-trial-export-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await fs.mkdir(path.join(repo, 'scripts/lib'), { recursive: true });
  for (const file of ['scripts/create-trial-bundle.mjs', 'scripts/lib/trial-support.mjs']) await fs.copyFile(new URL('../' + file, import.meta.url), path.join(repo, file));
  await writeJson(path.join(repo, 'package.json'), { version: '0.12.0', type: 'module' });
  const files = await sourceManifest(repo, ['package.json', 'scripts/create-trial-bundle.mjs', 'scripts/lib/trial-support.mjs']);
  await writeJson(path.join(repo, 'TRIAL-MANIFEST.json'), { files, source_sha256: sha256(JSON.stringify(files)), git_revision: 'pinned', git_status: '' });
  for (const dir of ['node_modules', 'dist', '.permsift']) { await fs.mkdir(path.join(repo, dir)); await fs.writeFile(path.join(repo, dir, 'local'), 'must not ship'); }
  const output = path.join(root, 'bundle'), receipt = { steps: [] };
  const r = await command(receipt, root, 'export', process.execPath, [path.join(repo, 'scripts/create-trial-bundle.mjs'), '--output', output], { quiet: true });
  assert.equal(r.code, 0, r.stderr);
  for (const dir of ['node_modules', 'dist', '.permsift', '.git']) await assert.rejects(fs.access(path.join(output, 'permsift', dir)), { code: 'ENOENT' });
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'permsift/TRIAL-MANIFEST.json'), 'utf8'));
  await verifySource(path.join(output, 'permsift'), manifest); assert.equal(manifest.git_revision, 'pinned');
  const duplicate = await command(receipt, root, 'duplicate', process.execPath, [path.join(repo, 'scripts/create-trial-bundle.mjs'), '--output', output], { quiet: true });
  assert.notEqual(duplicate.code, 0); assert.match(duplicate.stderr, /EEXIST/);
});
