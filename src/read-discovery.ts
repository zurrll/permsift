import * as fs from 'node:fs/promises';
import { contains, readAliasSchema, type Limits, type Scenario } from './config.js';
import { noSymlinks, resolveAlias, type Roots } from './filesystem.js';
import type { Rule } from './search.js';

export type ReadInventory = { groups: { from: string; to: string[] }[]; entries: { alias: string; type: 'file' | 'directory' }[]; truncated: boolean };
export type ReadObservation = ReadInventory & { id: string };
export type ReadDiscovery = { enabled: boolean; rules: Rule[]; observation_ids: string[]; truncated: boolean; limitations: string[] };

/** Inventory inputs before execution. Outputs not yet present cannot become file grants. */
export async function readInventory(roots: Roots, limits: Limits): Promise<ReadInventory> {
  const result: ReadInventory = { groups: [], entries: [], truncated: false };
  const queue = ['@workspace'];
  while (queue.length) {
    const from = queue.shift()!;
    const directory = resolveAlias(from, roots);
    await noSymlinks(roots.workspace, directory);
    const children = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    const to: string[] = [];
    let complete = true;
    for (const entry of children) {
      if (entry.name.startsWith('.permsift-read-')) continue;
      const alias = from + '/' + entry.name;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || !readAliasSchema.safeParse(alias).success) {
        result.truncated = true; complete = false; continue;
      }
      if (result.entries.length >= limits.max_read_discovery_entries) {
        result.truncated = true; complete = false; break;
      }
      result.entries.push({ alias, type: entry.isFile() ? 'file' : 'directory' });
      to.push(alias);
      if (entry.isDirectory()) {
        if (alias.split('/').length - 1 < limits.max_read_discovery_depth) queue.push(alias);
        else result.truncated = true;
      }
    }
    if (complete && to.length && to.length <= 32) result.groups.push({ from, to });
    else if (to.length > 32) result.truncated = true;
    if (result.entries.length >= limits.max_read_discovery_entries && queue.length) { result.truncated = true; break; }
  }
  return result;
}

export function discoverReads(scenario: Scenario, observations: ReadObservation[], limits: Limits): ReadDiscovery {
  const enabled = scenario.initial_read_grants !== undefined && scenario.auto_read_discover;
  const result: ReadDiscovery = { enabled, rules: [], observation_ids: observations.map(o => o.id), truncated: observations.some(o => o.truncated), limitations: [
    'Candidates come from bounded input structure, not a trace of every read; each change requires execution, assertions and recovery.',
    'Only project file/data read grants are searched. System/runtime, cache/temp reads and workspace-root directory access remain fixed.',
    'Symlinks, unsupported names, incomplete child inventories and replacements exceeding 32 grants are not expanded. No global minimum is proved.',
  ] };
  if (!enabled) return result;
  const allowed = (alias: string) => scenario.initial_read_grants!.some(root => contains(root, alias)) && limits.allowed_read_roots!.some(root => contains(root, alias));
  const groups = new Map<string, { to: Set<string>; ids: Set<string> }>();
  for (const observation of observations) for (const group of observation.groups) {
    if (!allowed(group.from) || group.to.some(p => !allowed(p))) continue;
    const merged = groups.get(group.from) ?? { to: new Set<string>(), ids: new Set<string>() };
    for (const alias of group.to) merged.to.add(alias);
    merged.ids.add(observation.id); groups.set(group.from, merged);
  }
  for (const [from, group] of groups) {
    if (group.to.size > 32) { result.truncated = true; continue; }
    result.rules.push({ from, to: [...group.to].sort(), source: 'input_structure', evidence_ids: [...group.ids] });
  }
  return result;
}
