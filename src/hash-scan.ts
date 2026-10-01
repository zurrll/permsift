import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

export const hashOperations = ['realpath', 'lstat', 'stat', 'readdir', 'read', 'digest'] as const;
export type HashOperation = typeof hashOperations[number];
export type HashScanProfile = {
  algorithm: string; completed: boolean; duration_ms: number;
  files: number; directories: number; symlinks: number; content_bytes: number;
  concurrency: number; peak_buffered_files: number;
  operations: Partial<Record<HashOperation, { calls: number; service_ms: number }>>;
};
export type HashScanOptions = {
  concurrency?: number; signal?: AbortSignal; timeoutMs?: number;
  onProfile?: (profile: HashScanProfile) => void;
};

/** Operation service durations can overlap; they must not be added to wall time. */
export class HashProfiler {
  private started = performance.now();
  readonly profile: HashScanProfile;
  constructor(algorithm: string, concurrency: number) {
    this.profile = { algorithm, completed: false, duration_ms: 0, files: 0, directories: 0, symlinks: 0, content_bytes: 0, concurrency, peak_buffered_files: 0, operations: {} };
  }
  async measure<T>(operation: HashOperation, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await fn(); }
    finally { this.record(operation, performance.now() - started); }
  }
  digest(fn: () => void) { const started = performance.now(); try { fn(); } finally { this.record('digest', performance.now() - started); } }
  private record(operation: HashOperation, duration: number) {
    const entry = this.profile.operations[operation] ??= { calls: 0, service_ms: 0 };
    entry.calls++; entry.service_ms += duration;
  }
  finish(completed: boolean) { this.profile.completed = completed; this.profile.duration_ms = performance.now() - this.started; return this.profile; }
}

type Entry = { resolved: string; relative: string; mode: number; size: number; ino: number; dev: number; type: 'file' | 'directory' | 'symlink' };
const smallFileBytes = 1024 * 1024;
const streamChunkBytes = 64 * 1024;

/** Same ordered digest as the v0.7 walker. Only filesystem I/O is concurrent.
 * Small-file read buffers are bounded by 8 MiB; larger files stream one at a time.
 * A changed file size is an error, never a partial digest accepted as evidence. */
export async function scanHash(source: string, maxBytes: number, directoryModes: boolean, options: HashScanOptions = {}): Promise<string> {
  const concurrency = options.concurrency ?? 8;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Hash concurrency must be an integer between 1 and 8');
  const profiler = new HashProfiler('ordered-bounded-v0.8', concurrency);
  const deadline = performance.now() + (options.timeoutMs ?? Infinity);
  const check = () => { if (options.signal?.aborted || performance.now() >= deadline) throw new Error('Snapshot hash interrupted or timed out'); };
  const measure = async <T>(operation: HashOperation, fn: () => Promise<T>) => {
    check(); const value = await profiler.measure(operation, fn); check(); return value;
  };
  let active = 0;
  const waiting: (() => void)[] = [];
  const jobs = new Set<Promise<unknown>>();
  const io = <T>(fn: () => Promise<T>): Promise<T> => {
    const job = (async () => {
      if (active >= concurrency) await new Promise<void>(resolve => waiting.push(resolve));
      else active++;
      try { check(); return await fn(); }
      finally { const next = waiting.shift(); if (next) next(); else active--; }
    })();
    jobs.add(job); void job.then(() => jobs.delete(job), () => jobs.delete(job)); return job;
  };
  const digest = createHash('sha256');
  const update = (value: string | Buffer) => profiler.digest(() => { digest.update(value); });
  let bytes = 0;
  let completed = false;
  const pending: { entry: Entry; result: Promise<{ content: Buffer } | { error: unknown }> }[] = [];
  try {
    const base = await measure('realpath', () => fs.realpath(source));
    const metadata = (from: string, relative: string) => io(async (): Promise<Entry> => {
      const resolved = await measure('realpath', () => fs.realpath(from));
      if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error(`External symlink in input: ${relative}`);
      // lstat already supplies the mode, size and type for a non-link entry.
      const stat = await measure('lstat', () => fs.lstat(from));
      const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : undefined;
      if (!type) throw new Error(`Unsupported input file type: ${relative}`);
      return { resolved, relative, mode: stat.mode & 0o777, size: stat.size, ino: stat.ino, dev: stat.dev, type };
    });
    const readContent = async (entry: Entry, emit?: (chunk: Buffer) => void): Promise<Buffer> => {
      check();
      const handle = await profiler.measure('read', () => fs.open(entry.resolved, constants.O_RDONLY | constants.O_NOFOLLOW));
      try {
        check();
        const opened = await measure('stat', () => handle.stat());
        if (!opened.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev || opened.size !== entry.size || (opened.mode & 0o777) !== entry.mode) throw new Error(`Input file changed while hashing: ${entry.relative}`);
        const buffer = Buffer.allocUnsafe(emit ? streamChunkBytes : entry.size);
        let read = 0;
        while (read < entry.size) {
          const length = Math.min(emit ? buffer.length : buffer.length - read, entry.size - read);
          const chunk = await measure('read', () => handle.read(buffer, emit ? 0 : read, length, null));
          if (!chunk.bytesRead) throw new Error(`Input file size changed while hashing: ${entry.relative}`);
          profiler.profile.content_bytes += chunk.bytesRead;
          if (emit) emit(buffer.subarray(0, chunk.bytesRead));
          read += chunk.bytesRead;
        }
        const extra = await measure('read', () => handle.read(Buffer.allocUnsafe(1), 0, 1, null));
        profiler.profile.content_bytes += extra.bytesRead;
        if (extra.bytesRead) throw new Error(`Input file size changed while hashing: ${entry.relative}`);
        return buffer;
      } finally { await profiler.measure('read', () => handle.close()); }
    };
    async function* walk(entry: Entry, ancestors: Set<string>): AsyncGenerator<Entry> {
      if (entry.type !== 'file' && ancestors.has(entry.resolved)) throw new Error(`Symlink cycle in input: ${entry.relative}`);
      yield entry;
      if (entry.type !== 'directory') return;
      const next = new Set(ancestors).add(entry.resolved);
      const names = (await measure('readdir', () => fs.readdir(entry.resolved))).sort();
      for (let start = 0; start < names.length; start += concurrency) {
        const entries = await Promise.all(names.slice(start, start + concurrency).map(name => metadata(path.join(entry.resolved, name), path.join(entry.relative, name))));
        for (const child of entries) yield* walk(child, next);
      }
    }
    const consume = async () => {
      const item = pending.shift()!;
      const result = await item.result;
      if ('error' in result) throw result.error;
      check();
      update(JSON.stringify([item.entry.relative, item.entry.mode, result.content.length])); update(result.content);
    };
    for await (const entry of walk(await metadata(base, ''), new Set())) {
      check();
      if (entry.type === 'file') {
        bytes += entry.size;
        if (bytes > maxBytes) throw new Error('Snapshot exceeds max_snapshot_bytes');
        profiler.profile.files++;
        if (entry.size <= smallFileBytes) {
          const result = io(async () => {
            const content = await readContent(entry);
            return { content };
          }).catch(error => ({ error }));
          pending.push({ entry, result });
          profiler.profile.peak_buffered_files = Math.max(profiler.profile.peak_buffered_files, pending.length);
          if (pending.length >= concurrency) await consume();
          continue;
        }
      }
      while (pending.length) await consume();
      if (entry.type === 'directory') {
        profiler.profile.directories++;
        update(JSON.stringify(directoryModes ? [entry.relative, 'directory', entry.mode] : [entry.relative, 'directory']));
      } else if (entry.type === 'symlink') {
        profiler.profile.symlinks++;
        const target = path.relative(path.dirname(path.join(base, entry.relative)), entry.resolved);
        update(JSON.stringify([entry.relative, 'symlink', target]));
      } else {
        update(JSON.stringify([entry.relative, entry.mode, entry.size]));
        await readContent(entry, update);
      }
    }
    while (pending.length) await consume();
    check(); completed = true; return digest.digest('hex');
  } finally {
    // Failed/canceled scans settle every queued read before callers can clean up.
    await Promise.allSettled([...jobs]);
    options.onProfile?.(profiler.finish(completed));
  }
}
