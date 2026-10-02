import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { dependencyInventory, packageForModule, type DependencyInventory, type PackageInstance } from './dependency-inventory.js';
import { observationPreload, OBSERVER_VERSION } from './observation-runtime.js';
import { hash, within, type Roots } from './filesystem.js';

export const OBSERVATION_LIMITS = { max_events_per_process: 10_000, max_bytes_per_process: 2_000_000, max_process_logs: 64, max_total_bytes: 32_000_000, max_packages: 2048 };
export type ObserverContext = { bootstrap: string; directory: string };
export type ObservationSetup = ObserverContext & { inventory: DependencyInventory; bootstrap_hash: string };
export type LoadedPackage = PackageInstance & { modules: string[] };
export type LoadEdge = { parent: string; target: string; request: string; package?: string };
export type TaskObservation = {
  task: string; trial: string; task_definition_hash: string; command: string[]; verdict: 'pass' | 'fail' | 'unknown';
  capture_status: 'captured' | 'incomplete' | 'unavailable'; source: 'node_module_hooks'; observer_version: string;
  inventory: DependencyInventory; loaded_packages: LoadedPackage[]; not_observed: PackageInstance[];
  loaded_modules: string[]; edges: LoadEdge[]; events: number;
  processes: { pid: number; thread: number; node: string; entry: string; finished: boolean }[];
  child_launches: { method: string; executable: string; preload_inherited: boolean }[];
  coverage_gaps: string[];
  issues: string[]; limitations: string[]; duration_ms?: number;
};
export const OBSERVATION_SCOPE = [
  'Records successful Node module resolution/load hooks, not function execution, every file read, necessity or bundle contents.',
  'Import relationships are edges observed in this execution; declared package dependencies are a different graph.',
  'Only Node processes/workers that retain the preload are observed. Native children, cleared environments, custom loaders and deliberately bypassed instrumentation are outside coverage.',
  'Types, templates, assets, filesystem reads, native addons and bundler internals need separate collectors. Unobserved packages are not deletion or permission-revocation recommendations.',
  'Cooperative instrumentation for trusted tasks; writable trace logs are not tamper-proof security evidence.',
];

export async function prepareObservation(roots: Roots, signal?: AbortSignal): Promise<ObservationSetup> {
  const base = path.join(roots.tmp, '.permsift-observer');
  const directory = path.join(base, 'logs');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const bootstrap = path.join(base, 'preload.cjs');
  const text = observationPreload(directory, OBSERVATION_LIMITS.max_events_per_process, OBSERVATION_LIMITS.max_bytes_per_process);
  await fs.writeFile(bootstrap, text, { mode: 0o400, flag: 'wx' });
  return { bootstrap, directory, bootstrap_hash: hash(text), inventory: await dependencyInventory(roots.workspace, OBSERVATION_LIMITS.max_packages, signal) };
}

const string = z.string().max(4096);
const eventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start'), pid: z.number().int().positive(), thread: z.number().int().nonnegative(), node: string, hooks: z.boolean(), entry: string }).strict(),
  z.object({ kind: z.literal('end'), count: z.number().int().nonnegative().max(10_000), truncated: z.boolean(), io_error: z.boolean() }).strict(),
  z.object({ kind: z.literal('resolve'), url: string, parent: string, request: string }).strict(),
  z.object({ kind: z.literal('load'), url: string }).strict(),
  z.object({ kind: z.literal('child'), method: string, executable: string, preload_inherited: z.boolean() }).strict(),
]);
type Event = z.infer<typeof eventSchema>;

function normalize(value: string, roots: Roots, url = true): string {
  if (!value) return '(entry)';
  if (value.startsWith('node:')) return value;
  let file = value;
  if (url) {
    try { const u = new URL(value); if (u.protocol !== 'file:') return `(non-file:${u.protocol})`; file = fileURLToPath(u); }
    catch { return '(unmapped)'; }
  }
  if (!path.isAbsolute(file)) return file.slice(0, 256);
  for (const [name, root] of Object.entries(roots)) if (within(root, file)) return `@${name}` + (file === root ? '' : '/' + path.relative(root, file).split(path.sep).join('/'));
  return '@external/' + path.basename(file);
}

export async function collectObservation(setup: ObservationSetup, roots: Roots): Promise<Omit<TaskObservation, 'task' | 'trial' | 'task_definition_hash' | 'command' | 'verdict' | 'duration_ms'>> {
  const issues = [...setup.inventory.issues];
  const events: Event[] = [], processes: TaskObservation['processes'] = [];
  let totalBytes = 0, bad = !setup.inventory.complete;
  const issue = (s: string) => { bad = true; if (issues.length < 128) issues.push(s); };
  if (hash(await fs.readFile(setup.bootstrap, 'utf8').catch(() => '')) !== setup.bootstrap_hash) issue('Observer preload changed or disappeared');
  const entries = (await fs.readdir(setup.directory).catch(() => [])).sort();
  if (entries.length > OBSERVATION_LIMITS.max_process_logs) issue('Process-log limit reached; additional logs were not read');
  for (const name of entries.slice(0, OBSERVATION_LIMITS.max_process_logs)) {
    try {
      if (!/^\d+-\d+\.jsonl$/.test(name)) throw new Error('Unexpected log entry');
      const file = path.join(setup.directory, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > OBSERVATION_LIMITS.max_bytes_per_process) throw new Error('Unsupported or oversized trace file');
      totalBytes += stat.size;
      if (totalBytes > OBSERVATION_LIMITS.max_total_bytes) { issue('Total trace-byte limit reached'); break; }
      const text = await fs.readFile(file, 'utf8');
      if (Buffer.byteLength(text) > OBSERVATION_LIMITS.max_bytes_per_process) throw new Error('Trace grew beyond its byte limit');
      const lines = text.trimEnd().split('\n');
      if (lines.length > OBSERVATION_LIMITS.max_events_per_process + 2 || lines.some(l => l.length > 20_000)) throw new Error('Trace event limit reached');
      const records: Event[] = [];
      for (const line of lines) {
        try { records.push(eventSchema.parse(JSON.parse(line))); }
        catch { issue(`Malformed trace record (${name}); retaining the valid prefix only`); break; }
      }
      const start = records[0], end = records.at(-1);
      if (start?.kind !== 'start' || `${start.pid}-${start.thread}.jsonl` !== name) throw new Error('Missing or inconsistent process header');
      const finished = end?.kind === 'end';
      processes.push({ pid: start.pid, thread: start.thread, node: start.node, entry: normalize(start.entry, roots, false), finished });
      if (!start.hooks) issue(`Module hooks unsupported in ${start.node}`);
      if (!finished) issue(`A Node process/thread did not finish its trace (${name})`);
      else if (end.truncated || end.io_error || end.count !== records.length - 2) issue(`Trace incomplete or bounded (${name})`);
      if (records.slice(1, finished ? -1 : undefined).some(e => e.kind === 'start' || e.kind === 'end')) throw new Error('Unexpected control record inside trace');
      events.push(...records.filter(e => e.kind !== 'start' && e.kind !== 'end'));
    } catch (e) { issue(`Cannot consume trace ${name}: ${String(e).slice(0, 300)}`); }
  }
  if (!processes.length) issue('No instrumented Node process reported; the command or its environment may not support the observer');
  const modules = [...new Set(events.flatMap(e => e.kind === 'load' ? [normalize(e.url, roots)] : []))].filter(s => !s.startsWith('@tmp/.permsift-observer')).sort();
  const packages = new Map<string, LoadedPackage>();
  for (const module of modules) {
    const p = packageForModule(module, setup.inventory.packages);
    if (p) { const row = packages.get(p.path) ?? { ...p, modules: [] }; row.modules.push(module); packages.set(p.path, row); }
    else if (module.startsWith('@workspace/') && module.includes('/node_modules/')) issue(`Loaded module is outside the identified package inventory: ${module}`);
  }
  const edges = [...new Map(events.flatMap(e => {
    if (e.kind !== 'resolve') return [];
    const target = normalize(e.url, roots), parent = normalize(e.parent, roots);
    if (target.startsWith('@tmp/.permsift-observer')) return [];
    const row: LoadEdge = { parent, target, request: e.request.startsWith('/') || e.request.startsWith('file:') ? normalize(e.request, roots, e.request.startsWith('file:')) : e.request,
      ...packageForModule(target, setup.inventory.packages) ? { package: packageForModule(target, setup.inventory.packages)!.path } : {} };
    return [[JSON.stringify(row), row] as const];
  })).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const launches = [...new Map(events.flatMap(e => e.kind === 'child' ? [[JSON.stringify(e), { method: e.method, executable: normalize(e.executable, roots, false), preload_inherited: e.preload_inherited }] as const] : [])).values()];
  const coverage_gaps = launches.flatMap(c => !c.preload_inherited ? [`Child launch did not retain the preload environment: ${c.executable}`] :
    c.method === 'fork' || /(?:^|\/)node(?:\.exe)?$/.test(c.executable) ? [] : [`Child launch may execute native/shell code outside module-hook coverage: ${c.executable}`]);
  return { capture_status: !processes.length ? 'unavailable' : bad ? 'incomplete' : 'captured', source: 'node_module_hooks', observer_version: OBSERVER_VERSION,
    inventory: setup.inventory, loaded_packages: [...packages.values()].sort((a, b) => a.path.localeCompare(b.path)),
    not_observed: setup.inventory.packages.filter(p => !packages.has(p.path)), loaded_modules: modules, edges, events: events.length, processes,
    child_launches: launches, coverage_gaps, issues, limitations: [...OBSERVATION_SCOPE, 'The package denominator counts installed npm directory instances; unique names and name/version pairs are reported separately. Lock entries are not assumed installed.'] };
}
