import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { dependencyInventory, packageForModule, type DependencyInventory, type PackageInstance } from './dependency-inventory.js';
import { observationPreload, OBSERVER_VERSION } from './observation-runtime.js';
import { hash, within, type Roots } from './filesystem.js';
import type { CompilationObservation } from './typescript-observation.js';
import type { BundlingObservation } from './esbuild-observation.js';
import { traceDecoder, TRACE_ENCODING } from './observation-codec.js';
import { workerEventBase, workerEventSchema, workerLifecycleSchema, workerEnd, workerEndSchema, workerMissingReasons, type WorkerLifecycle } from './worker-lifecycle.js';

export const OBSERVATION_LIMITS = { max_events_per_process: 10_000, max_bytes_per_process: 2_000_000, max_process_logs: 64, max_total_bytes: 32_000_000, max_packages: 2048 };
export type ObserverContext = { bootstrap: string; directory: string };
export type ObservationSetup = ObserverContext & { inventory: DependencyInventory; bootstrap_hash: string };
export type LoadedPackage = PackageInstance & { modules: string[] };
export type LoadEdge = { parent: string; target: string; request: string; package?: string };
export type TaskObservation = {
  task: string; trial: string; task_definition_hash: string; command: string[]; verdict: 'pass' | 'fail' | 'unknown';
  capture_status: 'captured' | 'incomplete' | 'unavailable'; source: 'node_module_hooks'; observer_version: string;
  module_capture_status?: 'captured' | 'incomplete' | 'unavailable';
  attribution_issues?: string[];
  inventory: DependencyInventory; loaded_packages: LoadedPackage[]; not_observed: PackageInstance[];
  loaded_modules: string[]; edges: LoadEdge[]; events: number;
  processes: { pid: number; thread: number; node: string; entry: string; finished: boolean }[];
  child_launches: { method: string; executable: string; preload_inherited: boolean }[];
  coverage_gaps: string[];
  issues: string[]; limitations: string[]; duration_ms?: number;
  trace_diagnostics?: TraceDiagnostic[];
  worker_lifecycle?: WorkerLifecycle[];
  compilation?: CompilationObservation;
  bundling?: BundlingObservation;
};
export const traceDiagnosticSchema = z.object({ file: z.string().regex(/^\d+-\d+\.jsonl$/), bytes: z.number().int().nonnegative().max(2_000_000),
  records: z.number().int().nonnegative().max(10_002), reported_events: z.number().int().nonnegative().max(10_000).nullable(),
  footer: z.enum(['present', 'missing']), reasons: z.array(z.string().max(128)).max(16),
  encoding: z.literal(TRACE_ENCODING).optional(), dictionary_entries: z.number().int().nonnegative().max(30_000).optional(), worker_end: workerEndSchema.optional(),
  limits: z.object({ events: z.number().int().positive().max(10_000), bytes: z.number().int().positive().max(2_000_000) }).strict() }).strict();
export type TraceDiagnostic = z.infer<typeof traceDiagnosticSchema>;
export const OBSERVATION_SCOPE = [
  'Records successful Node module resolution/load hooks, not function execution, every file read, necessity or bundle contents.',
  'Import relationships are edges observed in this execution; declared package dependencies are a different graph.',
  'Only Node processes/workers that retain the preload are observed. Native children, cleared environments, custom loaders and deliberately bypassed instrumentation are outside coverage.',
  'Types, templates, assets, filesystem reads, native addons and bundler internals need separate collectors. Unobserved packages are not deletion or permission-revocation recommendations.',
  'Cooperative instrumentation for trusted tasks; writable trace logs are not tamper-proof security evidence.',
];

export async function prepareObservation(roots: Roots, signal?: AbortSignal, manifest?: Record<string, string>): Promise<ObservationSetup> {
  const base = path.join(roots.tmp, '.permsift-observer');
  const directory = path.join(base, 'logs');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const bootstrap = path.join(base, 'preload.cjs');
  const text = observationPreload(directory, OBSERVATION_LIMITS.max_events_per_process, OBSERVATION_LIMITS.max_bytes_per_process);
  await fs.writeFile(bootstrap, text, { mode: 0o400, flag: 'wx' });
  return { bootstrap, directory, bootstrap_hash: hash(text), inventory: await dependencyInventory(roots.workspace, OBSERVATION_LIMITS.max_packages, signal, manifest) };
}

const string = z.string().max(4096);
const eventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start'), pid: z.number().int().positive(), thread: z.number().int().nonnegative(), node: string, hooks: z.boolean(), entry: string, encoding: z.literal(TRACE_ENCODING).optional() }).strict(),
  z.object({ kind: z.literal('end'), count: z.number().int().nonnegative().max(10_000), truncated: z.boolean(), io_error: z.boolean(),
    reasons: z.array(z.enum(['event_limit', 'byte_limit', 'text_limit', 'io_error'])).max(4).optional(), bytes_before_footer: z.number().int().nonnegative().max(2_000_000).optional() }).strict(),
  z.object({ kind: z.literal('resolve'), url: string, parent: string, request: string }).strict(),
  z.object({ kind: z.literal('load'), url: string }).strict(),
  z.object({ kind: z.literal('child'), method: string, executable: string, preload_inherited: z.boolean() }).strict(),
  workerEventBase,
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
  const trace_diagnostics: TraceDiagnostic[] = [];
  const worker_lifecycle: WorkerLifecycle[] = [];
  let totalBytes = 0, bad = false;
  const attribution_issues: string[] = [];
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
      let decoder = traceDecoder();
      for (const line of lines) {
        try {
          const record = eventSchema.parse(decoder.decode(JSON.parse(line)));
          if (record.kind === 'worker') workerEventSchema.parse(record);
          if (!records.length && record.kind === 'start') decoder = traceDecoder(record.encoding);
          records.push(record);
        }
        catch { issue(`Malformed trace record (${name}); retaining the valid prefix only`); break; }
      }
      const start = records[0], end = records.at(-1);
      if (start?.kind !== 'start' || `${start.pid}-${start.thread}.jsonl` !== name) throw new Error('Missing or inconsistent process header');
      const finished = end?.kind === 'end';
      const reasons: string[] = finished ? [...end.reasons ?? [], ...end.io_error && !end.reasons?.includes('io_error') ? ['io_error'] : [],
        ...end.count !== records.length - 2 ? ['count_mismatch'] : [], ...end.truncated && !end.reasons?.length ? ['truncation_reason_not_saved'] : []] : ['missing_footer'];
      trace_diagnostics.push({ file: name, bytes: Buffer.byteLength(text), records: records.length, reported_events: finished ? end.count : null,
        footer: finished ? 'present' : 'missing', reasons, ...start.encoding ? { encoding: start.encoding, dictionary_entries: decoder.size } : {},
        limits: { events: OBSERVATION_LIMITS.max_events_per_process, bytes: OBSERVATION_LIMITS.max_bytes_per_process } });
      processes.push({ pid: start.pid, thread: start.thread, node: start.node, entry: normalize(start.entry, roots, false), finished });
      if (!start.hooks) issue(`Module hooks unsupported in ${start.node}`);
      if (!finished) issue(`A Node process/thread did not finish its trace (${name})`);
      else if (reasons.length) issue(`Trace incomplete or bounded (${name}): ${reasons.join(', ')}; ${records.length - 2}/${OBSERVATION_LIMITS.max_events_per_process} events, ${Buffer.byteLength(text)}/${OBSERVATION_LIMITS.max_bytes_per_process} bytes`);
      if (records.slice(1, finished ? -1 : undefined).some(e => e.kind === 'start' || e.kind === 'end')) throw new Error('Unexpected control record inside trace');
      for (const row of records) if (row.kind === 'worker') {
        const { kind, ...fact } = row;
        worker_lifecycle.push(workerLifecycleSchema.parse({ ...fact, ...fact.entry !== undefined ? { entry: normalize(fact.entry, roots, fact.entry.startsWith('file:')) } : {}, pid: start.pid, parent_thread: start.thread }));
      }
      events.push(...records.filter(e => e.kind !== 'start' && e.kind !== 'end'));
    } catch (e) { issue(`Cannot consume trace ${name}: ${String(e).slice(0, 300)}`); }
  }
  for (const trace of trace_diagnostics) {
    const end = workerEnd(worker_lifecycle, trace.file);
    if (!end) continue;
    trace.worker_end = end;
    if (trace.footer === 'missing') {
      const reasons = workerMissingReasons(end); trace.reasons.push(...reasons);
      if (reasons.length) issue(`Missing worker footer (${trace.file}): ${reasons.join(', ')}; parent evidence ${end.parent_trace}, entry ${end.entry}. Parent facts do not verify the worker trace.`);
    }
  }
  if (!processes.length) issue('No instrumented Node process reported; the command or its environment may not support the observer');
  const modules = [...new Set(events.flatMap(e => e.kind === 'load' ? [normalize(e.url, roots)] : []))].filter(s => !s.startsWith('@tmp/.permsift-observer')).sort();
  const packages = new Map<string, LoadedPackage>();
  for (const module of modules) {
    const p = packageForModule(module, setup.inventory.packages);
    if (p) { const row = packages.get(p.path) ?? { ...p, modules: [] }; row.modules.push(module); packages.set(p.path, row); }
    else if (module.startsWith('@workspace/') && module.includes('/node_modules/')) { const s = `Loaded module is outside the identified package inventory: ${module}`; if (attribution_issues.length < 128) attribution_issues.push(s); if (issues.length < 128) issues.push(s); }
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
  for (const worker of worker_lifecycle) if (worker.action === 'created' && !processes.some(p => p.pid === worker.pid && p.thread === worker.thread))
    coverage_gaps.push(`Constructed worker ${worker.pid}-${worker.thread} has no readable instrumented trace; it may have ended before preload or changed its execution environment. Declared entry: ${worker.entry}`);
  return { capture_status: !processes.length ? 'unavailable' : bad || !setup.inventory.complete || attribution_issues.length ? 'incomplete' : 'captured',
    module_capture_status: !processes.length ? 'unavailable' : bad ? 'incomplete' : 'captured', attribution_issues, source: 'node_module_hooks', observer_version: OBSERVER_VERSION,
    inventory: setup.inventory, loaded_packages: [...packages.values()].sort((a, b) => a.path.localeCompare(b.path)),
    not_observed: setup.inventory.packages.filter(p => !packages.has(p.path)), loaded_modules: modules, edges, events: events.length, processes,
    child_launches: launches, coverage_gaps, issues, trace_diagnostics, worker_lifecycle,
    limitations: [...OBSERVATION_SCOPE, 'Worker lifecycle facts describe wrapped Node Worker APIs and parent callbacks within the same trace budget. They do not replace a missing worker footer or prove that all worker events were captured.', 'The package denominator counts installed npm directory instances; unique names and name/version pairs are reported separately. Lock entries are not assumed installed.'] };
}
