// Independent v0.7 oracle for digest compatibility and local benchmarks.
// Never used by the experiment executor.
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { HashProfiler, type HashScanOptions } from '../../src/hash-scan.js';

export async function referenceHash(source: string, maxBytes: number, modes = false, options: HashScanOptions = {}) {
  const profile = new HashProfiler('sequential-v0.7', 1);
  const base = await profile.measure('realpath', () => fs.realpath(source));
  let bytes = 0, completed = false;
  const digest = createHash('sha256');
  const update = (value: string | Buffer) => profile.digest(() => { digest.update(value); });
  async function visit(from: string, relative: string, ancestors: Set<string>) {
    const resolved = await profile.measure('realpath', () => fs.realpath(from));
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error(`External symlink in input: ${relative}`);
    if ((await profile.measure('lstat', () => fs.lstat(from))).isSymbolicLink()) {
      if (ancestors.has(resolved)) throw new Error(`Symlink cycle in input: ${relative}`);
      profile.profile.symlinks++;
      update(JSON.stringify([relative, 'symlink', path.relative(path.dirname(path.join(base, relative)), resolved)])); return;
    }
    const stat = await profile.measure('stat', () => fs.stat(resolved));
    if (stat.isDirectory()) {
      if (ancestors.has(resolved)) throw new Error(`Symlink cycle in input: ${relative}`);
      profile.profile.directories++;
      const next = new Set(ancestors).add(resolved);
      update(JSON.stringify(modes ? [relative, 'directory', stat.mode & 0o777] : [relative, 'directory']));
      for (const entry of (await profile.measure('readdir', () => fs.readdir(resolved))).sort()) await visit(path.join(resolved, entry), path.join(relative, entry), next);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > maxBytes) throw new Error('Snapshot exceeds max_snapshot_bytes');
      profile.profile.files++; profile.profile.content_bytes += stat.size;
      const content = await profile.measure('read', () => fs.readFile(resolved));
      update(JSON.stringify([relative, stat.mode & 0o777, content.length])); update(content);
    } else throw new Error(`Unsupported input file type: ${relative}`);
  }
  try { await visit(base, '', new Set()); completed = true; return digest.digest('hex'); }
  finally { options.onProfile?.(profile.finish(completed)); }
}
