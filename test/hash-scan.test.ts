import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { snapshotHash, snapshot } from '../src/filesystem.js';
import { HashProfiler, type HashOperation, type HashScanProfile } from '../src/hash-scan.js';
import { referenceHash } from './support/reference-hash.js';

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-hash-')));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
test('bounded scans preserve v0.7 digests across order, Unicode, empty directories, modes, links and large files', async t => {
  const root = await fixture(t);
  for (const name of ['z', 'a', 'a/nested', '空目录']) await fs.mkdir(path.join(root, name), { recursive: true });
  for (let i = 0; i < 19; i++) await fs.writeFile(path.join(root, 'a', `file-${i}`), Buffer.alloc(i * 317, i), { mode: i % 2 ? 0o755 : 0o600 });
  await fs.writeFile(path.join(root, 'a!'), 'before slash');
  await fs.writeFile(path.join(root, 'z', 'large'), Buffer.alloc(1024 * 1024 + 123, 27));
  await fs.writeFile(path.join(root, '._data'), 'ordinary dot underscore');
  await fs.symlink('a/file-3', path.join(root, 'relative-link'));
  await fs.symlink(path.join(root, 'a'), path.join(root, 'absolute-link'));
  await fs.chmod(path.join(root, 'a'), 0o750);
  for (const modes of [false, true]) {
    const expected = await referenceHash(root, 10_000_000, modes);
    for (const concurrency of [1, 2, 8]) {
      let profile: HashScanProfile | undefined;
      assert.equal(await snapshotHash(root, 10_000_000, modes, { concurrency, onProfile: p => { profile = p; } }), expected);
      assert.equal(profile!.completed, true); assert.equal(profile!.files, 22); assert.equal(profile!.symlinks, 2);
      assert.ok(profile!.peak_buffered_files <= concurrency);
      assert.equal(profile!.operations.stat!.calls, profile!.files, 'Open-file stat validates identity; directory stat is not repeated');
    }
  }
});
test('normalized source copies remain compatible with the original snapshot digest', async t => {
  const root = await fixture(t), source = path.join(root, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'readme'), 'content'); await fs.symlink(path.join(source, 'readme'), path.join(source, 'link'));
  const copy = path.join(root, 'copy');
  assert.equal(await snapshot(source, copy, [], 10_000), await snapshotHash(copy, 10_000));
});
test('same-size edits with restored timestamps, file modes, directory modes and missing entries change the full digest', async t => {
  const root = await fixture(t), file = path.join(root, 'file');
  await fs.writeFile(file, 'original'); const stat = await fs.stat(file);
  const original = await snapshotHash(root, 1000, true);
  await fs.writeFile(file, 'modified'); await fs.utimes(file, stat.atime, stat.mtime);
  assert.notEqual(await snapshotHash(root, 1000, true), original);
  await fs.writeFile(file, 'original'); assert.equal(await snapshotHash(root, 1000, true), original);
  await fs.chmod(file, 0o700); assert.notEqual(await snapshotHash(root, 1000, true), original);
  await fs.chmod(file, stat.mode & 0o777); assert.equal(await snapshotHash(root, 1000, true), original);
  await fs.mkdir(path.join(root, 'empty')); const before = await snapshotHash(root, 1000, true), withoutModes = await snapshotHash(root, 1000);
  await fs.chmod(path.join(root, 'empty'), 0o750);
  assert.notEqual(await snapshotHash(root, 1000, true), before); assert.equal(await snapshotHash(root, 1000), withoutModes);
  await fs.rm(file); assert.notEqual(await snapshotHash(root, 1000, true), original);
});
test('scans reject external, ancestor, cyclic and dangling links rather than returning partial hashes', async t => {
  const root = await fixture(t), source = path.join(root, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(root, 'outside'), 'outside');
  for (const [target, error] of [['../outside', /External/], ['.', /cycle/], ['missing', /ENOENT/]] as const) {
    await fs.symlink(target, path.join(source, 'link')); await assert.rejects(snapshotHash(source, 1000), error); await fs.unlink(path.join(source, 'link'));
  }
  await fs.symlink('other', path.join(source, 'link')); await fs.symlink('link', path.join(source, 'other'));
  await assert.rejects(snapshotHash(source, 1000), /ELOOP/);
});
test('byte budgets, invalid concurrency, deadlines and canceled pending scans cannot produce a digest', async t => {
  const root = await fixture(t);
  for (let i = 0; i < 100; i++) await fs.writeFile(path.join(root, `${i}`), Buffer.alloc(4096, i));
  await assert.rejects(snapshotHash(root, 0), /exceeds/);
  for (const concurrency of [0, 9, 1.5]) await assert.rejects(snapshotHash(root, 1_000_000, false, { concurrency }), /concurrency/);
  await assert.rejects(snapshotHash(root, 1_000_000, false, { timeoutMs: 0 }), /timed out/);
  const controller = new AbortController(); let checks = 0, profile: HashScanProfile | undefined;
  const signal = new Proxy(controller.signal, { get(target, property) { if (property === 'aborted' && ++checks === 300) controller.abort(); return Reflect.get(target, property, target); } });
  await assert.rejects(snapshotHash(root, 1_000_000, false, { signal, onProfile: p => { profile = p; } }), /interrupted/);
  assert.equal(profile!.completed, false); assert.ok(profile!.peak_buffered_files > 0); assert.ok(profile!.peak_buffered_files <= 8);
  // A fresh full scan still succeeds after all canceled file handles have settled.
  assert.equal(await snapshotHash(root, 1_000_000), await referenceHash(root, 1_000_000));
});
test('unsupported socket entries fail before any content read', async t => {
  const root = await fixture(t), socket = path.join(root, 'socket'); const server = net.createServer();
  server.listen(socket); await once(server, 'listening');
  try { await assert.rejects(snapshotHash(root, 1000), /Unsupported/); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('a file growing after its initial read is rejected, counted and closed before returning', async t => {
  const root = await fixture(t), file = path.join(root, 'file'); await fs.writeFile(file, 'original');
  const measure = HashProfiler.prototype.measure; let grew = false, profile: HashScanProfile | undefined;
  t.mock.method(HashProfiler.prototype, 'measure', async function<T>(this: HashProfiler, operation: HashOperation, fn: () => Promise<T>): Promise<T> {
    const result = await measure.call(this, operation, fn) as T;
    if (!grew && operation === 'read' && typeof result === 'object' && result !== null && 'bytesRead' in result && typeof result.bytesRead === 'number' && result.bytesRead > 1) {
      grew = true; await fs.appendFile(file, '!');
    }
    return result;
  });
  await assert.rejects(snapshotHash(root, 1000, false, { onProfile: p => { profile = p; } }), /size changed/);
  assert.equal(grew, true); assert.equal(profile!.completed, false); assert.equal(profile!.content_bytes, 9);
  assert.equal(await snapshotHash(root, 1000), await referenceHash(root, 1000));
});
