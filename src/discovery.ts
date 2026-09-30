import * as fs from 'node:fs/promises';
import path from 'node:path';
import { aliasSchema, contains, type Limits, type Scenario } from './config.js';
import { resolveAlias, type Roots } from './filesystem.js';
import type { Rule } from './search.js';

export type Observation = { id: string; directories: string[]; writes: string[]; denial_paths: string[]; truncated: boolean };
export type Discovery = { enabled: boolean; rules: Rule[]; prepared_directories: string[]; observation_ids: string[]; truncated: boolean; limitations: string[] };

/** Breadth-first, bounded inventory. Never follow directory symlinks. */
export async function directoryInventory(roots: Roots, limits: Limits) {
  const directories: string[] = [];
  const queue = Object.keys(roots).map(key => `@${key}`);
  let truncated = false;
  while (queue.length) {
    const alias = queue.shift()!;
    if (directories.length >= limits.max_discovery_dirs) { truncated = true; break; }
    const file = resolveAlias(alias, roots);
    const stat = await fs.lstat(file);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    directories.push(alias);
    const entries = (await fs.readdir(file, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = `${alias}/${entry.name}`;
      if (!aliasSchema.safeParse(child).success) { truncated = true; continue; }
      if (child.split('/').length - 1 > limits.max_discovery_depth) { truncated = true; continue; }
      // Bound both enumeration and the pending queue, not just the returned array.
      if (directories.length + queue.length >= limits.max_discovery_dirs) { truncated = true; continue; }
      queue.push(child);
    }
  }
  return { directories, truncated };
}

const parent = (alias: string) => path.posix.dirname(alias);
const compact = (items: string[]) => [...new Set(items)].sort().filter((p, _, all) => !all.some(other => other !== p && contains(other, p)));

export function discover(scenario: Scenario, observations: Observation[], limits: Limits): Discovery {
  const result: Discovery = {
    enabled: scenario.auto_discover, rules: [], prepared_directories: [], observation_ids: observations.map(o => o.id), truncated: false,
    limitations: ['File differences omit deleted temporary files and unchanged rewrites; directory and denial hints are incomplete.', 'Candidate policies are capped at 32 directory grants; wider generated replacements are not attempted.', 'Every candidate requires execution and assertions. This bounded directory search does not prove a global minimum.'],
  };
  if (!scenario.auto_discover) return result;
  result.truncated = observations.some(o => o.truncated);
  const directories = [...new Set(observations.flatMap(o => o.directories))].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const allowed = (alias: string) => aliasSchema.safeParse(alias).success && limits.allowed_write_roots.some(root => contains(root, alias)) && scenario.initial_write_grants.some(root => contains(root, alias));
  const selected = directories.filter(allowed).slice(0, limits.max_discovery_dirs);
  if (directories.filter(allowed).length > selected.length) result.truncated = true;
  const known = new Set(selected);
  const nearest = (file: string) => {
    if (!aliasSchema.safeParse(file).success) return undefined;
    let dir = parent(file);
    while (dir.startsWith('@')) {
      if (known.has(dir)) return dir;
      const next = parent(dir); if (next === dir) break; dir = next;
    }
    return undefined;
  };
  const append = (from: string, to: string[], source: Rule['source'], ids: string[]) => {
    const targets = compact(to);
    if (!targets.length || targets.some(p => p === from || !contains(from, p) || !allowed(p))) return;
    if (targets.length > 32) { result.truncated = true; return; }
    if (result.rules.some(r => r.from === from && JSON.stringify(r.to) === JSON.stringify(targets))) return;
    result.rules.push({ from, to: targets, source, evidence_ids: [...new Set(ids)] });
  };
  // Union across successful baseline repetitions, so one observed branch cannot erase another.
  for (const from of selected) {
    const writes = observations.flatMap(o => o.writes.map(nearest).filter((p): p is string => !!p && contains(from, p)));
    // A direct write in from prevents a misleading observed-child replacement.
    if (!writes.includes(from)) append(from, writes, 'file_changes', observations.filter(o => o.writes.some(p => contains(from, p))).map(o => o.id));
    const denied = observations.flatMap(o => o.denial_paths.map(nearest).filter((p): p is string => !!p && contains(from, p)));
    if (!denied.includes(from)) append(from, denied, 'denial_hint', observations.filter(o => o.denial_paths.some(p => contains(from, p))).map(o => o.id));
  }
  for (const from of selected) append(from, selected.filter(p => parent(p) === from), 'directory_structure', result.observation_ids);
  result.prepared_directories = [...new Set(result.rules.flatMap(r => r.to))].sort();
  return result;
}
