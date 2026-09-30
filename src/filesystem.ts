import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { aliasSchema } from './config.js';

export type Roots = { workspace: string; cache: string; tmp: string };
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function resolveAlias(alias: string, roots: Roots): string {
  aliasSchema.parse(alias);
  const [name, ...parts] = alias.slice(1).split('/');
  return path.join(roots[name as keyof Roots], ...parts);
}
export const within = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);

export async function noSymlinks(root: string, target: string): Promise<void> {
  if (!within(root, target)) throw new Error('Path escapes root');
  let current = root;
  for (const part of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink is forbidden: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/** Copies bytes, preserves internal links as relative links, rejects external links. */
export async function snapshot(source: string, destination: string, excludes: string[], maxBytes: number): Promise<string> {
  const base = await fs.realpath(source);
  let bytes = 0;
  const digest = createHash('sha256');
  async function visit(from: string, to: string, relative: string, ancestors: Set<string>) {
    const resolved = await fs.realpath(from);
    if (!within(base, resolved)) throw new Error(`External symlink in input: ${relative}`);
    if ((await fs.lstat(from)).isSymbolicLink()) {
      if (ancestors.has(resolved)) throw new Error(`Symlink cycle in input: ${relative}`);
      const target = path.relative(path.dirname(to), path.join(destination, path.relative(base, resolved)));
      digest.update(JSON.stringify([relative, 'symlink', target]));
      await fs.symlink(target, to);
      return;
    }
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      if (ancestors.has(resolved)) throw new Error(`Symlink cycle in input: ${relative}`);
      const next = new Set(ancestors).add(resolved);
      digest.update(JSON.stringify([relative, 'directory']));
      await fs.mkdir(to, { recursive: true, mode: 0o700 });
      const entries = (await fs.readdir(resolved)).sort();
      for (const entry of entries) {
        if (!relative && excludes.includes(entry)) continue;
        await visit(path.join(resolved, entry), path.join(to, entry), path.join(relative, entry), next);
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > maxBytes) throw new Error('Snapshot exceeds max_snapshot_bytes');
      const content = await fs.readFile(resolved);
      digest.update(JSON.stringify([relative, stat.mode & 0o777, content.length])).update(content);
      await fs.writeFile(to, content, { mode: stat.mode & 0o777 });
    } else throw new Error(`Unsupported input file type: ${relative}`);
  }
  await visit(base, destination, '', new Set());
  return digest.digest('hex');
}

export async function manifest(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let bytes = 0;
  let entries = 0;
  async function visit(dir: string) {
    for (const name of (await fs.readdir(dir)).sort()) {
      if (++entries > 100_000) throw new Error('Output manifest exceeds 100,000 entries');
      const file = path.join(dir, name);
      const stat = await fs.lstat(file);
      const relative = path.relative(root, file);
      if (stat.isSymbolicLink()) result[relative] = `symlink:${await fs.readlink(file)}`;
      else if (stat.isDirectory()) await visit(file);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 1_000_000_000) throw new Error('Output manifest exceeds 1 GB');
        result[relative] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      } else throw new Error(`Unsupported output file type: ${relative}`);
    }
  }
  await visit(root);
  return result;
}

export function diffFiles(before: Record<string, string>, after: Record<string, string>) {
  return {
    added: Object.keys(after).filter(p => !(p in before)),
    removed: Object.keys(before).filter(p => !(p in after)),
    changed: Object.keys(after).filter(p => p in before && before[p] !== after[p]),
  };
}
export async function saveJson(file: string, value: unknown) {
  const temporary = file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temporary, file);
}
