import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import { compilationSchema } from './typescript-observation.js';
import { bundlingSchema, validateBundling } from './esbuild-observation.js';
import { contextSchema, validateContext } from './package-context.js';
import { traceDiagnosticSchema } from './observation.js';
import { workerLifecycleSchema, workerEnd, workerMissingReasons, WORKER_MISSING_REASONS, validateWorkerStates } from './worker-lifecycle.js';
import { validateChannels, DETAIL_REASONS, LOAD_REASONS, WORKER_REASONS, traceSourceIncomplete } from './trace-budget.js';

const text = z.string().max(4096), digest = z.string().regex(/^[a-f0-9]{64}$/);
const location = text.refine(s => s.startsWith('@workspace/') && !/[\u0000-\u001f\u007f]/.test(s) && !s.split('/').some(p => p === '.' || p === '..' || !p), 'Expected a normalized workspace location');
const pkg = z.object({ path: location, name: text.min(1), version: text.min(1) });
const strings = z.array(text).max(128);
const inventory = z.object({ packages: z.array(pkg).max(2048), complete: z.boolean(), issues: strings,
  ignored_entries: z.array(location).max(8192).optional(), context: contextSchema.optional() });
const taskSchema = z.union([
  z.object({ task: text, capture_status: z.literal('not_run'), reason: text }),
  z.object({ task: text, capture_status: z.enum(['captured', 'incomplete', 'unavailable']), task_definition_hash: digest,
    verdict: z.enum(['pass', 'fail', 'unknown']), loaded_packages: z.array(pkg.extend({ modules: z.array(text).max(640000).optional() })).max(2048),
    inventory: inventory.optional(), issues: strings.optional(), coverage_gaps: z.array(text).max(640000).optional(),
    module_capture_status: z.enum(['captured', 'incomplete', 'unavailable']).optional(), attribution_issues: strings.optional(),
    load_capture_status: z.enum(['captured', 'incomplete', 'unavailable']).optional(), resolution_capture_status: z.enum(['captured', 'incomplete', 'unavailable']).optional(),
    load_issues: strings.optional(), resolution_issues: strings.optional(),
    trace_diagnostics: z.array(traceDiagnosticSchema).max(64).optional(),
    worker_lifecycle: z.array(workerLifecycleSchema).max(640000).optional(),
    edges: z.array(z.object({ parent: text, target: text, request: text, package: location.optional() })).max(640000).optional(),
    compilation: compilationSchema.optional(), bundling: bundlingSchema.optional() }),
]);
const usageSchema = z.object({ schema_version: z.literal(1), kind: z.literal('dependency_usage'), observer_version: text, version: text.optional(),
  status: z.enum(['observed', 'failed', 'incomplete']), environment: z.record(text),
  inputs: z.object({ snapshot_hash: digest.optional(), config_hash: digest, limits_hash: digest }), tasks: z.array(taskSchema).max(16),
});
export type Comparable = z.infer<typeof usageSchema>;
export const MAX_USAGE_BYTES = 32_000_000;
export async function loadUsage(file: string): Promise<Comparable> {
  // Bound the actual read, including a file that grows after its initial stat.
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let source: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_USAGE_BYTES) throw new Error('Usage report must be a regular JSON file at most 32 MB');
    const chunks: Buffer[] = []; let total = 0;
    while (total <= MAX_USAGE_BYTES) {
      const chunk = Buffer.alloc(Math.min(65536, MAX_USAGE_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead; chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total > MAX_USAGE_BYTES) throw new Error('Usage report exceeds 32 MB');
    source = Buffer.concat(chunks, total).toString('utf8');
  } finally { await handle.close(); }
  return parseUsage(JSON.parse(source));
}

/** Same validation for saved files and internal legacy adapters. */
export function parseUsage(value: unknown): Comparable {
  const parsed = usageSchema.parse(value);
  if (new Set(parsed.tasks.map(t => t.task)).size !== parsed.tasks.length) throw new Error('Duplicate task IDs in usage baseline');
  for (const task of parsed.tasks) if (task.capture_status !== 'not_run' && new Set(task.loaded_packages.map(p => p.path)).size !== task.loaded_packages.length) throw new Error('Duplicate package instances in usage baseline');
  for (const task of parsed.tasks) if (task.capture_status !== 'not_run') {
    if ((task.load_capture_status !== undefined) !== (task.resolution_capture_status !== undefined)) throw new Error('Split capture statuses must be retained together');
    if (task.load_capture_status && (task.module_capture_status === 'captured' || task.capture_status === 'captured') &&
      (task.load_capture_status !== 'captured' || task.resolution_capture_status !== 'captured')) throw new Error('Complete aggregate capture contradicts trace source statuses');
    if (task.load_issues?.length && task.load_capture_status === 'captured' || task.resolution_issues?.length && task.resolution_capture_status === 'captured') throw new Error('Complete capture contradicts source issues');
    const packages = new Map<string, { name: string; version: string }>();
    if (task.inventory && new Set(task.inventory.packages.map(p => p.path)).size !== task.inventory.packages.length) throw new Error('Duplicate installed package instances');
    if (task.inventory?.context) validateContext(task.inventory.context, task.inventory.packages);
    if (task.worker_lifecycle) {
      const created = new Map<string, number>();
      for (const e of task.worker_lifecycle) {
        const key = `${e.pid}-${e.thread}`;
        if (e.action === 'created') { if (created.has(key)) throw new Error('Duplicate worker lifecycle identity'); created.set(key, e.parent_thread); }
        else if (created.get(key) !== e.parent_thread) throw new Error('Worker lifecycle has no consistent creation evidence');
        if (task.trace_diagnostics && !task.trace_diagnostics.some(d => d.file === `${e.pid}-${e.parent_thread}.jsonl`)) throw new Error('Worker lifecycle references an absent parent trace');
      }
    }
    if (task.trace_diagnostics) {
      if (new Set(task.trace_diagnostics.map(d => d.file)).size !== task.trace_diagnostics.length) throw new Error('Duplicate trace diagnostics');
      for (const d of task.trace_diagnostics) {
        if ((d.footer === 'present') !== (d.reported_events !== null) || d.records < (d.footer === 'present' ? 2 : 1)) throw new Error('Trace footer diagnostics are inconsistent');
        if (d.footer === 'present' && (d.reported_events !== d.records - 2) !== d.reasons.includes('count_mismatch')) throw new Error('Trace count diagnostics are inconsistent');
        if (d.footer === 'missing' && !d.reasons.includes('missing_footer')) throw new Error('Missing trace footer cause was not retained');
        if (task.module_capture_status === 'captured' && (d.footer === 'missing' || d.reasons.length)) throw new Error('Complete module capture contradicts trace diagnostics');
        if (task.load_capture_status === 'captured' && traceSourceIncomplete(d, 'loads') || task.resolution_capture_status === 'captured' && traceSourceIncomplete(d, 'resolutions')) throw new Error('Complete split capture contradicts trace diagnostics');
        if (d.budget?.loads && (!task.load_capture_status || !task.resolution_capture_status)) throw new Error('Split trace budget requires split capture statuses');
        if ((d.encoding !== undefined) !== (d.dictionary_entries !== undefined)) throw new Error('Trace encoding metadata is incomplete');
        if (d.budget) {
          if ((d.budget.loads?.events ?? 0) + d.budget.details.events + d.budget.workers.events !== d.limits.events || (d.budget.loads?.bytes ?? 0) + d.budget.details.bytes + d.budget.workers.bytes + d.budget.footer_bytes !== d.limits.bytes || d.bytes > d.limits.bytes) throw new Error('Trace budget differs from total ceilings');
          if (d.footer === 'present') {
            if (!d.channels || !d.worker_states) throw new Error('Trace channel facts not retained with a new footer');
            validateChannels(d.budget, d.channels, d.reported_events!, d.reasons.includes('io_error'));
            if ((d.channels.loads?.bytes ?? 0) + d.channels.details.bytes + d.channels.workers.bytes > d.bytes) throw new Error('Channel bytes exceed retained trace size');
            const causes = [...d.channels.loads?.reasons ?? [], ...d.channels.details.reasons, ...d.channels.workers.reasons];
            if (causes.some(r => !d.reasons.includes(r)) || d.reasons.some(r => ([...LOAD_REASONS, ...DETAIL_REASONS, ...WORKER_REASONS] as readonly string[]).includes(r) && !causes.includes(r as typeof causes[number]))) throw new Error('Trace channel reasons disagree');
            validateWorkerStates(task.worker_lifecycle ?? [], d.file, d.worker_states, d.budget.workers.max_workers,
              !d.reasons.includes('io_error') && !d.channels.workers.reasons.some(r => r === 'worker_history_event_limit' || r === 'worker_history_byte_limit'));
            const [pid, parent] = d.file.replace('.jsonl', '').split('-').map(Number);
            const rows = (task.worker_lifecycle ?? []).filter(e => e.pid === pid && e.parent_thread === parent);
            if (rows.length !== d.channels.workers.events || rows.filter(e => e.action !== 'created').length !== d.channels.workers.history_events) throw new Error('Worker history counts disagree');
          } else if (d.channels || d.worker_states) throw new Error('Missing footer cannot supply final channel/state facts');
        } else if (d.channels || d.worker_states) throw new Error('Channel facts lack a declared budget');
        if (d.worker_end) {
          const expected = workerEnd(task.worker_lifecycle ?? [], d.file, task.trace_diagnostics);
          if (!expected || JSON.stringify(expected) !== JSON.stringify(d.worker_end)) throw new Error('Worker footer explanation contradicts parent lifecycle facts');
          const reasons = d.footer === 'missing' ? workerMissingReasons(expected) : [];
          if (reasons.some(r => !d.reasons.includes(r)) || d.reasons.some(r => (WORKER_MISSING_REASONS as readonly string[]).includes(r) && !reasons.includes(r))) throw new Error('Worker missing-footer reason disagrees with parent evidence');
        }
        else if (d.reasons.some(r => (WORKER_MISSING_REASONS as readonly string[]).includes(r))) throw new Error('Worker missing-footer reason lacks parent evidence');
      }
    }
    for (const p of [...task.inventory?.packages ?? [], ...task.loaded_packages, ...task.compilation?.packages ?? [], ...task.bundling?.packages ?? []]) {
      pkg.parse(p);
      const old = packages.get(p.path);
      if (old && (old.name !== p.name || old.version !== p.version)) throw new Error('Conflicting package identity at one installed location');
      packages.set(p.path, p);
    }
    if (task.edges?.some(e => e.package && (!packages.has(e.package) || !e.target.startsWith(e.package + '/')))) throw new Error('Observed resolution edge does not match an identified package instance');
    for (const p of task.loaded_packages) if (p.modules) {
      if (new Set(p.modules).size !== p.modules.length || p.modules.some(m => !m.startsWith(p.path + '/'))) throw new Error('Loaded module does not belong to its package instance');
      for (const module of p.modules) location.parse(module);
    }
  }
  for (const task of parsed.tasks) if (task.capture_status !== 'not_run' && task.compilation) {
    const c = task.compilation;
    if (new Set(c.files.map(f => f.path)).size !== c.files.length || new Set(c.packages.map(p => p.path)).size !== c.packages.length) throw new Error('Duplicate compiler inputs in usage baseline');
    if (c.capture_status === 'captured' && (!c.compiler || !c.files.length || c.issues.length)) throw new Error('Complete compiler capture requires an identified compiler and explained files without issues');
    const packages = new Map(c.packages.map(p => [p.path, p]));
    for (const file of c.files) if (file.package && !packages.has(file.package)) throw new Error('Compiler input references a missing package');
    for (const pkg of c.packages) {
      const expected = c.files.filter(f => f.package === pkg.path).map(f => f.path).sort();
      if (!pkg.path.startsWith('@workspace/') || !expected.length || JSON.stringify([...pkg.files].sort()) !== JSON.stringify(expected)) throw new Error('Compiler package files do not match attributed inputs');
    }
  }
  for (const task of parsed.tasks) if (task.capture_status !== 'not_run' && task.bundling) validateBundling(task.bundling);
  return parsed;
}
