import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
import { compilationSchema } from './typescript-observation.js';
import { bundlingSchema, validateBundling } from './esbuild-observation.js';

const text = z.string().max(4096), digest = z.string().regex(/^[a-f0-9]{64}$/);
const location = text.refine(s => s.startsWith('@workspace/') && !/[\u0000-\u001f\u007f]/.test(s) && !s.split('/').some(p => p === '.' || p === '..' || !p), 'Expected a normalized workspace location');
const pkg = z.object({ path: location, name: text.min(1), version: text.min(1) });
const strings = z.array(text).max(128);
const inventory = z.object({ packages: z.array(pkg).max(2048), complete: z.boolean(), issues: strings });
const taskSchema = z.union([
  z.object({ task: text, capture_status: z.literal('not_run'), reason: text }),
  z.object({ task: text, capture_status: z.enum(['captured', 'incomplete', 'unavailable']), task_definition_hash: digest,
    verdict: z.enum(['pass', 'fail', 'unknown']), loaded_packages: z.array(pkg.extend({ modules: z.array(text).max(640000).optional() })).max(2048),
    inventory: inventory.optional(), issues: strings.optional(), coverage_gaps: z.array(text).max(640000).optional(),
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
    const packages = new Map<string, { name: string; version: string }>();
    if (task.inventory && new Set(task.inventory.packages.map(p => p.path)).size !== task.inventory.packages.length) throw new Error('Duplicate installed package instances');
    for (const p of [...task.inventory?.packages ?? [], ...task.loaded_packages, ...task.compilation?.packages ?? [], ...task.bundling?.packages ?? []]) {
      pkg.parse(p);
      const old = packages.get(p.path);
      if (old && (old.name !== p.name || old.version !== p.version)) throw new Error('Conflicting package identity at one installed location');
      packages.set(p.path, p);
    }
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
