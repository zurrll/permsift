import path from 'node:path';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { noSymlinks } from './filesystem.js';
import type { Check } from './assertions.js';

type Entry = Record<string, unknown>;
export type BundledPlan = {
  owners: { path: string; name: string; version: string; dependencies: string[] }[];
  packages: { path: string; name: string; version: string; owner: string }[];
};
const packageName = (name: string) => /^(?:@[A-Za-z0-9_.~-]+\/)?[A-Za-z0-9_.~-]+$/.test(name) &&
  name.split('/').every(part => !['.', '..', 'node_modules'].includes(part));
/** Exact npm locations, including nested and scoped packages; no arbitrary subpaths. */
export function packageLocation(location: string): string[] {
  if (!location.startsWith('node_modules/')) throw new Error(`Unsupported package location: ${location}`);
  const names = location.slice('node_modules/'.length).split('/node_modules/');
  if (!names.every(packageName)) throw new Error(`Unsupported package location: ${location}`);
  return names;
}
function dependencies(entry: Entry): string[] {
  const names = new Set<string>();
  for (const key of ['dependencies', 'optionalDependencies']) {
    const map = entry[key];
    if (map === undefined) continue;
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(`Invalid ${key} in bundled dependency graph`);
    for (const [name, range] of Object.entries(map)) {
      if (!packageName(name) || typeof range !== 'string') throw new Error('Invalid dependency in bundled dependency graph');
      names.add(name);
    }
  }
  return [...names].sort();
}
function bundleNames(entry: Entry): string[] {
  const parse = (value: unknown): string[] => {
    if (value === undefined || value === false) return [];
    if (value === true) return dependencies(entry);
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string' && packageName(v)) || new Set(value).size !== value.length) throw new Error('Invalid bundleDependencies declaration');
    return [...value].sort();
  };
  const names = parse(entry.bundleDependencies !== undefined ? entry.bundleDependencies : entry.bundledDependencies);
  if (entry.bundleDependencies !== undefined && entry.bundledDependencies !== undefined &&
    !isDeepStrictEqual(parse(entry.bundleDependencies), parse(entry.bundledDependencies))) throw new Error('Conflicting bundleDependencies declarations');
  return names;
}
function identity(location: string, entry: Entry) {
  const name = entry.name ?? packageLocation(location).at(-1)!;
  if (typeof name !== 'string' || !packageName(name) || typeof entry.version !== 'string' || !entry.version.length || entry.version.length > 128) throw new Error(`Missing bundled package identity: ${location}`);
  return { path: location, name, version: entry.version };
}

/** Call only after every independently downloaded entry has passed URL/SRI checks. */
export function bundledPlan(entries: Map<string, Entry>): BundledPlan | undefined {
  const bundled = [...entries].filter(([, e]) => e.inBundle === true);
  if (!bundled.length) return undefined;
  const owners: BundledPlan['owners'] = [], assigned = new Map<string, string>();
  for (const [owner, entry] of entries) {
    if (entry.inBundle === true) continue;
    const names = bundleNames(entry);
    if (!names.length) continue;
    const todo = names.map(name => owner + '/node_modules/' + name), visited = new Set<string>();
    while (todo.length) {
      const location = todo.pop()!;
      if (visited.has(location)) continue;
      visited.add(location);
      const child = entries.get(location);
      if (!child || child.inBundle !== true) throw new Error(`Declared bundled package is missing or not inBundle: ${location}`);
      if (assigned.has(location) && assigned.get(location) !== owner) throw new Error(`Ambiguous bundled package owner: ${location}`);
      assigned.set(location, owner);
      // Bundled transitives may be hoisted to their tarball owner's node_modules.
      // Resolution stops there; an external/independent package cannot vouch for them.
      for (const name of dependencies(child)) {
        let from = location;
        while (true) {
          const resolved = from + '/node_modules/' + name, target = entries.get(resolved);
          if (target) { if (target.inBundle === true) todo.push(resolved); break; }
          if (from === owner) break;
          from = from.slice(0, from.lastIndexOf('/node_modules/'));
        }
      }
      for (const name of bundleNames(child)) todo.push(location + '/node_modules/' + name);
    }
    owners.push({ ...identity(owner, entry), dependencies: names });
  }
  const packages = bundled.map(([location, entry]) => {
    const owner = assigned.get(location);
    if (!owner) throw new Error(`Bundled package has no verified declaring owner: ${location}`);
    return { ...identity(location, entry), owner };
  });
  return { owners: owners.sort((a, b) => a.path.localeCompare(b.path)), packages: packages.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function metadata(workspace: string, location: string) {
  packageLocation(location);
  const file = path.join(workspace, location, 'package.json');
  await noSymlinks(workspace, file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error('Installed package metadata must be a regular file <= 1 MiB');
    return JSON.parse(await handle.readFile('utf8')) as Entry;
  } finally { await handle.close(); }
}
/** Check the actual extracted layout before any project command or snapshot reuse. */
export async function checkBundledInstall(workspace: string, plan: BundledPlan, signal?: AbortSignal, deadline = Infinity): Promise<Check[]> {
  const checks: Check[] = [];
  for (const item of [...plan.owners, ...plan.packages]) {
    const name = `bundled_package:@workspace/${item.path}`;
    if (signal?.aborted || Date.now() >= deadline) { checks.push({ name, status: 'unknown', detail: 'Bundled installation verification interrupted or timed out' }); break; }
    try {
      const actual = await metadata(workspace, item.path);
      const same = actual && actual.name === item.name && actual.version === item.version;
      const declared = !('dependencies' in item) || isDeepStrictEqual(bundleNames(actual), item.dependencies);
      checks.push({ name, status: same && declared ? 'pass' : 'fail', detail: same && declared ?
        'Extracted name/version and declaring owner metadata match the lock; parent tarball integrity is checked by npm ci' :
        'Extracted name/version or parent bundle declaration differs from the lock' });
    } catch (error) {
      checks.push({ name, status: (error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError ? 'fail' : 'unknown', detail: `Bundled installation metadata could not be verified: ${String(error)}` });
    }
  }
  return checks;
}

/** Saved proof is optional for old inputs; a declared bundle cannot lose its checks. */
export function assertBundledEvidence(rawPlan: unknown, rawInstallation: unknown, requirePass = false): void {
  if (rawPlan === undefined) return;
  const location = z.string().min(1).max(16384).refine(v => { try { packageLocation(v); return true; } catch { return false; } });
  const identity = { path: location, name: z.string().min(1).max(214), version: z.string().min(1).max(128) };
  const plan = z.object({ owners: z.array(z.object({ ...identity, dependencies: z.array(z.string().refine(packageName)).min(1).max(50000) }).strict()).min(1).max(50000),
    packages: z.array(z.object({ ...identity, owner: location }).strict()).min(1).max(50000) }).strict().parse(rawPlan);
  const paths = [...plan.owners, ...plan.packages].map(v => v.path), owners = new Set(plan.owners.map(v => v.path));
  if (new Set(paths).size !== paths.length || plan.packages.some(v => !owners.has(v.owner) || !v.path.startsWith(v.owner + '/node_modules/'))) throw new Error('Invalid saved bundled ownership');
  if (rawInstallation === undefined && !requirePass) return; // No installer ran for a snapshot-only trial.
  const install = z.object({ verdict: z.enum(['pass', 'fail', 'unknown']), bundled_checks: z.array(z.object({ name: z.string(), status: z.enum(['pass', 'fail', 'unknown']), detail: z.string() })).max(100000).optional() }).parse(rawInstallation);
  if (requirePass && install.verdict !== 'pass') throw new Error('Baseline lacks passing bundled installation verification');
  if (install.verdict === 'pass') {
    const expected = paths.map(p => 'bundled_package:@workspace/' + p).sort();
    if (!install.bundled_checks || install.bundled_checks.some(c => c.status !== 'pass') ||
      !isDeepStrictEqual(install.bundled_checks.map(c => c.name).sort(), expected)) throw new Error('Passing bundled installation lacks complete matching checks');
  }
}
