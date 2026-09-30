import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { snapshot, noSymlinks, manifest, diffFiles } from '../src/filesystem.js';

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-fs-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src')); return root;
}
test('snapshot copies bytes independently and excludes only top-level output directories', async t => {
  const root = await fixture(t); const source = path.join(root, 'src');
  await fs.mkdir(path.join(source, 'dist')); await fs.writeFile(path.join(source, 'dist', 'old'), 'stale');
  await fs.mkdir(path.join(source, 'node_modules', 'dep', 'dist'), { recursive: true });
  await fs.writeFile(path.join(source, 'node_modules', 'dep', 'dist', 'index.js'), 'dependency');
  await fs.writeFile(path.join(source, 'file'), 'original');
  await snapshot(source, path.join(root, 'copy'), ['dist'], 10000);
  await assert.rejects(fs.access(path.join(root, 'copy', 'dist')));
  assert.equal(await fs.readFile(path.join(root, 'copy', 'node_modules/dep/dist/index.js'), 'utf8'), 'dependency');
  await fs.writeFile(path.join(root, 'copy', 'file'), 'changed');
  assert.equal(await fs.readFile(path.join(source, 'file'), 'utf8'), 'original');
});
test('external input symlinks and symlink cycles are rejected', async t => {
  const root = await fixture(t); const source = path.join(root, 'src');
  await fs.writeFile(path.join(root, 'outside'), 'fake'); await fs.symlink('../outside', path.join(source, 'link'));
  await assert.rejects(snapshot(source, path.join(root, 'copy'), [], 10000), /External symlink/);
  await fs.unlink(path.join(source, 'link')); await fs.symlink('.', path.join(source, 'loop'));
  await assert.rejects(snapshot(source, path.join(root, 'copy2'), [], 10000), /cycle/);
});
test('internal links point into the copy, while grant paths cannot traverse links', async t => {
  const root = await fixture(t); const source = path.join(root, 'src');
  await fs.mkdir(path.join(source, 'real')); await fs.writeFile(path.join(source, 'real', 'file'), 'ok');
  await fs.symlink(path.join(source, 'real'), path.join(source, 'alias'));
  await snapshot(source, path.join(root, 'copy'), [], 10000);
  assert.equal(await fs.realpath(path.join(root, 'copy/alias')), path.join(root, 'copy/real'));
  await assert.rejects(noSymlinks(path.join(root, 'copy'), path.join(root, 'copy/alias/file')), /Symlink/);
});
test('snapshot digest changes with contents and empty directories; size limit is enforced', async t => {
  const root = await fixture(t); const source = path.join(root, 'src');
  await fs.writeFile(path.join(source, 'file'), 'a');
  const a = await snapshot(source, path.join(root, 'a'), [], 100);
  await fs.mkdir(path.join(source, 'empty'));
  const b = await snapshot(source, path.join(root, 'b'), [], 100);
  assert.notEqual(a, b);
  await fs.writeFile(path.join(source, 'file'), 'b');
  const c = await snapshot(source, path.join(root, 'c'), [], 100);
  assert.notEqual(b, c);
  await assert.rejects(snapshot(source, path.join(root, 'tiny'), [], 0), /exceeds/);
});
test('file diff records additions, removals, changes and links without following them', async t => {
  const root = await fixture(t); const source = path.join(root, 'src');
  await fs.writeFile(path.join(source, 'old'), 'a'); const before = await manifest(source);
  await fs.unlink(path.join(source, 'old')); await fs.symlink('/nonexistent', path.join(source, 'link'));
  const after = await manifest(source);
  assert.deepEqual(diffFiles(before, after), { added: ['link'], removed: ['old'], changed: [] });
});
