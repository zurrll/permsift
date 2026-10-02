import * as fs from 'node:fs/promises';
import path from 'node:path';
import { noSymlinks, within } from './filesystem.js';

export type PackageInstance = { path: string; name: string; version: string; declarations: string[] };
export type DependencyInventory = { packages: PackageInstance[]; complete: boolean; issues: string[];
  locked_instances?: number; locked_not_installed?: string[]; lock_version_mismatches?: string[] };

async function smallJson(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error('Not a regular JSON file below 1 MB');
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, any>;
}

/** npm directory layout only: scoped, hoisted and nested copies. No link traversal. */
export async function dependencyInventory(workspace: string, maximum = 2048, signal?: AbortSignal): Promise<DependencyInventory> {
  const result: DependencyInventory = { packages: [], complete: true, issues: [] };
  const issue = (message: string) => { result.complete = false; if (result.issues.length < 64) result.issues.push(message); };
  const alias = (file: string) => '@workspace/' + path.relative(workspace, file).split(path.sep).join('/');
  const root: Record<string, any> = await smallJson(path.join(workspace, 'package.json')).catch(() => ({}));
  const declarations = (name: string) => ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].filter(k => Object.hasOwn(root[k] ?? {}, name));
  const queue = [path.join(workspace, 'node_modules')];
  let visited = 0;
  while (queue.length) {
    if (signal?.aborted) throw new Error('Dependency inventory interrupted');
    const directory = queue.shift()!;
    try {
      const stat = await fs.lstat(directory).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
      if (!stat) continue;
      await noSymlinks(workspace, directory);
      if (!stat.isDirectory()) { issue(`Unsupported dependency directory: ${alias(directory)}`); continue; }
      const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (++visited > maximum * 4 || result.packages.length >= maximum) { issue('Installed package inventory limit reached'); queue.length = 0; break; }
        if (entry.name === '.bin' || entry.name === '.package-lock.json' || entry.name.startsWith('.permsift-read-')) continue;
        const target = path.join(directory, entry.name);
        if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name.startsWith('.')) { issue(`Unsupported dependency entry: ${alias(target)}`); continue; }
        if (entry.name.startsWith('@')) { queue.push(target); continue; }
        try {
          await noSymlinks(workspace, target);
          const data = await smallJson(path.join(target, 'package.json'));
          if (typeof data.name !== 'string' || !data.name.length || data.name.length > 256 || typeof data.version !== 'string' || !data.version.length || data.version.length > 128) throw new Error('Missing or invalid name/version');
          result.packages.push({ path: alias(target), name: data.name, version: data.version, declarations: declarations(data.name) });
          queue.push(path.join(target, 'node_modules'));
        } catch { issue(`Unreadable package metadata: ${alias(target)}`); }
      }
    } catch { issue(`Unreadable dependency directory: ${alias(directory)}`); }
  }
  result.packages.sort((a, b) => a.path.localeCompare(b.path));
  const lockPath = path.join(workspace, 'package-lock.json');
  // Lock records are a separate population: optional/platform entries may not be
  // installed. Missing lock entries are observations, not installation failures.
  const lockStat = await fs.lstat(lockPath).catch(() => undefined);
  if (lockStat) try {
    if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.size > 10_000_000) throw new Error('Unsupported lock file');
    const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object') throw new Error('Unsupported lock format');
    const records = Object.entries(lock.packages).filter(([p]) => p.includes('node_modules/'));
    result.locked_instances = records.length;
    const installed = new Map(result.packages.map(p => [p.path.slice('@workspace/'.length), p]));
    result.locked_not_installed = records.filter(([p]) => !installed.has(p)).map(([p]) => '@workspace/' + p).sort();
    result.lock_version_mismatches = records.filter(([p, data]) => installed.has(p) && installed.get(p)!.version !== (data as any)?.version).map(([p]) => '@workspace/' + p).sort();
  } catch { issue('Installed inventory available, but lock-file comparison unavailable'); }
  return result;
}

export function packageForModule(alias: string, packages: PackageInstance[]): PackageInstance | undefined {
  return packages.filter(p => within(p.path, alias)).sort((a, b) => b.path.length - a.path.length)[0];
}
