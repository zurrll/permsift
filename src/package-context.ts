import path from 'node:path';
import { z } from 'zod';
import type { PackageInstance } from './dependency-inventory.js';
import { hash } from './filesystem.js';

export const CONTEXT_LIMITS = { edges: 20_000, entries: 64, entry_depth: 8, files: 100_000, path_steps: 512, path_depth: 24, paths: 3 };
const text = z.string().max(4096), location = text.refine(s => s === '@workspace' || s.startsWith('@workspace/') && !s.split('/').some(p => !p || p === '.' || p === '..') && !/[\u0000-\u001f\u007f]/.test(s));
const count = z.number().int().nonnegative().max(CONTEXT_LIMITS.files);
export const contextSchema = z.object({ version: z.literal(1), phase: z.literal('prepared_task_inputs'),
  manifest_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), complete: z.boolean(), issues: z.array(text).max(128),
  edges: z.array(z.object({ from: location, name: text.min(1), range: text, kind: z.enum(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']),
    resolution: z.enum(['resolved', 'unresolved', 'unsupported']), target: location.optional() }).strict()).max(CONTEXT_LIMITS.edges),
  structures: z.array(z.object({ path: location, complete: z.boolean(), issues: z.array(text).max(64),
    entries: z.array(z.object({ field: text, target: text, evidence: z.enum(['file_present', 'not_in_manifest', 'outside_package', 'manifest_not_saved']) }).strict()).max(CONTEXT_LIMITS.entries),
    files: z.object({ total: count, declarations: count, javascript: count, typescript: count, native: count, wasm: count, other: count, symlinks: count }).strict().optional(),
  }).strict()).max(2048),
}).strict();
export type PackageContext = z.infer<typeof contextSchema>;
type Metadata = Map<string, Record<string, any>>;
const dependencyName = /^(?:@[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/** Declaration + installed ancestry, not Node exports evaluation or observed loading. */
export function buildPackageContext(packages: PackageInstance[], metadata: Metadata, manifest?: Record<string, string>, ignoredEntries: readonly string[] = []): PackageContext {
  const result: PackageContext = { version: 1, phase: 'prepared_task_inputs', ...manifest ? { manifest_hash: hash(manifest) } : {}, complete: true, issues: [], edges: [], structures: [] };
  const issue = (s: string) => { result.complete = false; if (result.issues.length < 128 && !result.issues.includes(s)) result.issues.push(s); };
  const installed = new Set(packages.map(p => p.path));
  for (const [from, data] of metadata) {
    for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      if (kind === 'devDependencies' && from !== '@workspace') continue;
      const declarations = data[kind];
      if (declarations === undefined) continue;
      if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations)) { issue(`Invalid dependency declarations: ${from} ${kind}`); continue; }
      for (const [name, rawRange] of Object.entries(declarations).sort(([a], [b]) => a.localeCompare(b))) {
        if (result.edges.length >= CONTEXT_LIMITS.edges) { issue('Dependency relation edge limit reached'); break; }
        if (name.length > 4096 || typeof rawRange !== 'string' || rawRange.length > 4096) { issue(`Unsupported dependency declaration: ${from}`); continue; }
        let target: string | undefined;
        const supported = dependencyName.test(name);
        if (supported) {
          let directory = from;
          while (directory.startsWith('@workspace')) {
            const candidate = directory + '/node_modules/' + name;
            if (installed.has(candidate)) { target = candidate; break; }
            if (directory === '@workspace') break;
            directory = path.posix.dirname(directory);
          }
        }
        result.edges.push({ from, kind, name, range: rawRange, resolution: !supported ? 'unsupported' : target ? 'resolved' : 'unresolved', ...target ? { target } : {} });
      }
    }
  }
  if (!metadata.has('@workspace')) issue('Root project dependency metadata was not identified');
  if (!manifest) issue('Prepared-input file manifest was not saved for package structure');
  if (manifest && Object.keys(manifest).length > CONTEXT_LIMITS.files) issue('Package structure file limit reached');
  const structures = new Map<string, PackageContext['structures'][number]>();
  for (const p of packages) {
    const s: PackageContext['structures'][number] = { path: p.path, complete: !!manifest, issues: [], entries: [],
      ...manifest ? { files: { total: 0, declarations: 0, javascript: 0, typescript: 0, native: 0, wasm: 0, other: 0, symlinks: 0 } } : {} };
    const incomplete = (why: string) => { s.complete = false; if (s.issues.length < 64 && !s.issues.includes(why)) s.issues.push(why); };
    if (!manifest) incomplete('File structure not saved');
    const data = metadata.get(p.path);
    if (!data) incomplete('Package metadata not saved');
    const entry = (field: string, value: unknown, depth = 0) => {
      if (depth > CONTEXT_LIMITS.entry_depth || s.entries.length >= CONTEXT_LIMITS.entries || field.length > 4096) { incomplete('Entry declaration bounds reached'); return; }
      if (typeof value === 'string') {
        if (value.length > 4096) { incomplete('Entry declaration text limit reached'); return; }
        const alias = path.posix.normalize(p.path + '/' + value);
        const inside = !path.posix.isAbsolute(value) && alias.startsWith(p.path + '/') && !value.includes('\0');
        s.entries.push({ field, target: value, evidence: !inside ? 'outside_package' : !manifest ? 'manifest_not_saved' :
          Object.hasOwn(manifest, alias.slice('@workspace/'.length)) && !manifest[alias.slice('@workspace/'.length)].startsWith('symlink:') ? 'file_present' : 'not_in_manifest' });
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) { if (s.entries.length >= CONTEXT_LIMITS.entries) { incomplete('Entry declaration bounds reached'); break; } entry(field + '/' + key, child, depth + 1); }
      } else if (value !== undefined && value !== null) incomplete('Unsupported entry declaration value');
    };
    if (data) for (const field of ['types', 'typings', 'main', 'module', 'bin', 'exports']) entry(field, data[field]);
    structures.set(p.path, s);
  }
  if (manifest) for (const [relative, digest] of Object.entries(manifest).slice(0, CONTEXT_LIMITS.files)) {
    const alias = '@workspace/' + relative.split(path.sep).join('/');
    // Known installation auxiliaries and synthetic read probes are not package contents.
    if (alias.split('/').some(p => p.startsWith('.permsift-read-')) || /\/node_modules\/(?:\.bin(?:\/|$)|\.package-lock\.json$)/.test(alias) ||
        ignoredEntries.some(p => alias === p || alias.startsWith(p + '/'))) continue;
    let parent = path.posix.dirname(alias);
    while (parent !== '@workspace' && parent !== '.' && !structures.has(parent)) parent = path.posix.dirname(parent);
    const s = structures.get(parent);
    if (!s?.files) continue;
    // A package's nested node_modules belongs to its own instances, including unknown ones.
    if (alias.slice(parent.length + 1).startsWith('node_modules/')) { s.complete = false; if (!s.issues.includes('Nested dependency contents not attributed')) s.issues.push('Nested dependency contents not attributed'); continue; }
    const f = s.files; f.total++;
    if (digest.startsWith('symlink:')) { f.symlinks++; s.complete = false; if (!s.issues.includes('Symlink content not followed')) s.issues.push('Symlink content not followed'); }
    else if (/\.d\.[cm]?ts$/i.test(alias)) f.declarations++;
    else if (/\.[cm]?jsx?$/i.test(alias)) f.javascript++;
    else if (/\.[cm]?tsx?$/i.test(alias)) f.typescript++;
    else if (/\.node$/i.test(alias)) f.native++;
    else if (/\.wasm$/i.test(alias)) f.wasm++;
    else f.other++;
  }
  result.structures = [...structures.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (manifest && Object.keys(manifest).length > CONTEXT_LIMITS.files) for (const s of result.structures) { s.complete = false; s.issues.push('Global file structure limit reached'); }
  if (result.structures.some(s => !s.complete)) result.complete = false;
  return contextSchema.parse(result);
}

/** Integrity of retained relationships; no claim of authenticated producer or semver satisfaction. */
export function validateContext(context: PackageContext, packages: { path: string }[]): void {
  const paths = new Set(packages.map(p => p.path));
  if (context.structures.length !== paths.size || new Set(context.structures.map(s => s.path)).size !== paths.size) throw new Error('Package structure coverage does not match inventory');
  for (const s of context.structures) {
    if (!paths.has(s.path)) throw new Error('Unknown package structure instance');
    if (s.files && s.files.total !== s.files.declarations + s.files.javascript + s.files.typescript + s.files.native + s.files.wasm + s.files.other + s.files.symlinks) throw new Error('Package file count mismatch');
    if (s.complete && (!s.files || s.issues.length || !context.manifest_hash)) throw new Error('Complete package structure lacks complete file evidence');
  }
  const keys = new Set<string>();
  for (const e of context.edges) {
    if (e.from !== '@workspace' && !paths.has(e.from) || e.target && !paths.has(e.target) || (e.resolution === 'resolved') !== !!e.target) throw new Error('Dependency relation references missing or inconsistent instance');
    const key = JSON.stringify([e.from, e.kind, e.name]); if (keys.has(key)) throw new Error('Duplicate dependency declaration'); keys.add(key);
  }
  if (context.complete && (context.issues.length || context.structures.some(s => !s.complete))) throw new Error('Complete package context has incomplete evidence');
}

export function packagePaths(context: PackageContext, target: string): { paths: string[][]; bounded: boolean } {
  const parents = new Map<string, string[]>();
  for (const e of context.edges) if (e.target) { const a = parents.get(e.target) ?? []; if (!a.includes(e.from)) a.push(e.from); parents.set(e.target, a); }
  const queue = [[target]], paths: string[][] = []; let steps = 0, bounded = false;
  while (queue.length && paths.length < CONTEXT_LIMITS.paths && steps++ < CONTEXT_LIMITS.path_steps) {
    const trail = queue.shift()!;
    if (trail[0] === '@workspace') { paths.push(trail); continue; }
    if (trail.length >= CONTEXT_LIMITS.path_depth) { bounded = true; continue; }
    for (const p of parents.get(trail[0]) ?? []) if (!trail.includes(p)) queue.push([p, ...trail]);
    if (queue.length > CONTEXT_LIMITS.path_steps) { bounded = true; queue.splice(CONTEXT_LIMITS.path_steps); }
  }
  return { paths, bounded: bounded || queue.length > 0 || steps >= CONTEXT_LIMITS.path_steps };
}
