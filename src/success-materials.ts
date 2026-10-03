import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { noSymlinks, resolveAlias, saveJson, type Roots } from './filesystem.js';
import type { Assertion } from './config.js';

export const MATERIAL_LIMITS = Object.freeze({ files: 16, file_bytes: 1_048_576, total_bytes: 2_097_152, milliseconds: 2000 });
export const bytesHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/), id = (role: string) => z.string().regex(new RegExp('^' + role + ':v1:[a-f0-9]{64}$'));
export const materialSourceSchema = z.object({ trial: z.string().regex(/^[a-zA-Z0-9_-]+$/), task: z.string().min(1).max(64),
  execution_id: id('execution'), task_id: id('task'), policy_id: id('policy'), phase: z.enum(['final', 'baseline', 'observe']) }).strict();
export type MaterialSource = z.infer<typeof materialSourceSchema>;
export const materialSchema = z.object({ schema_version: z.literal(1), kind: z.literal('permsift_success_materials'), source: materialSourceSchema,
  limits: z.object({ files: z.number().int().min(1).max(MATERIAL_LIMITS.files), file_bytes: z.number().int().min(1).max(MATERIAL_LIMITS.file_bytes),
    total_bytes: z.number().int().min(1).max(MATERIAL_LIMITS.total_bytes), milliseconds: z.number().int().min(1).max(MATERIAL_LIMITS.milliseconds) }).strict(),
  files: z.array(z.union([
    z.object({ path: z.string().min(1).max(4096), state: z.literal('saved'), file: z.string().regex(/^\d{2}\.bin$/), bytes: z.number().int().nonnegative().max(MATERIAL_LIMITS.file_bytes), hash: digest }).strict(),
    z.object({ path: z.string().min(1).max(4096), state: z.literal('not_saved'), reason: z.string().min(1).max(2048) }).strict(),
  ])).max(64), duration_ms: z.number().finite().nonnegative(), total_bytes: z.number().int().nonnegative().max(MATERIAL_LIMITS.total_bytes),
}).strict();
export type Materials = z.infer<typeof materialSchema>;
export type CaptureNotice = { state: 'saved'; manifest: string; hash: string; duration_ms: number; bytes: number } | { state: 'not_saved'; reason: string; duration_ms: number };
const reason = (error: unknown) => String(error).slice(0, 1800);

/** Bounded regular-file bytes; no symlinks, FIFOs, directory reads or growth past the limit. */
export async function readMaterial(root: string, file: string, max: number, deadline = Infinity, signal?: AbortSignal): Promise<Buffer> {
  const available = () => { if (signal?.aborted || Date.now() >= deadline) throw new Error('Material budget exhausted or interrupted'); };
  available(); await noSymlinks(root, file);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > max) throw new Error('Material must be a regular file within the byte budget');
    const chunks: Buffer[] = []; let bytes = 0;
    while (bytes <= max) {
      available(); const chunk = Buffer.alloc(Math.min(65536, max + 1 - bytes));
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead; chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const after = await handle.stat(); available();
    if (bytes > max || bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Material changed while being read or exceeded budget');
    return Buffer.concat(chunks, bytes);
  } finally { await handle.close(); }
}

/** Optional host-side retention after completed verification. Never changes its verdict. */
export async function captureSuccessMaterials(options: { output: string; roots: Roots; assertions: Assertion[]; source: MaterialSource;
  signal?: AbortSignal; limits?: Materials['limits'] }): Promise<CaptureNotice> {
  const started = Date.now(), relative = `artifacts/${options.source.trial}/manifest.json`;
  try {
    const source = materialSourceSchema.parse(options.source), limits = materialSchema.shape.limits.parse(options.limits ?? MATERIAL_LIMITS);
    const directory = path.join(options.output, 'artifacts', source.trial);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const files: Materials['files'] = []; let total = 0, saved = 0;
    for (const alias of [...new Set(options.assertions.map(a => a.path))]) {
      try {
        if (saved >= limits.files) throw new Error('Material file count limit reached');
        const data = await readMaterial(options.roots.workspace, resolveAlias(alias, options.roots), Math.min(limits.file_bytes, limits.total_bytes - total), started + limits.milliseconds, options.signal);
        const file = String(saved).padStart(2, '0') + '.bin';
        await fs.writeFile(path.join(directory, file), data, { flag: 'wx', mode: 0o600, signal: options.signal });
        files.push({ path: alias, state: 'saved', file, bytes: data.length, hash: bytesHash(data) }); total += data.length; saved++;
      } catch (e) { files.push({ path: alias, state: 'not_saved', reason: reason(e) }); }
    }
    const manifest = materialSchema.parse({ schema_version: 1, kind: 'permsift_success_materials', source, limits, files, duration_ms: Date.now() - started, total_bytes: total });
    await saveJson(path.join(options.output, relative), manifest);
    return { state: 'saved', manifest: relative, hash: bytesHash(Buffer.from(JSON.stringify(manifest))), duration_ms: Date.now() - started, bytes: total };
  } catch (e) { return { state: 'not_saved', reason: reason(e), duration_ms: Date.now() - started }; }
}
