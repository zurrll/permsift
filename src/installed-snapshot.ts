import * as fs from 'node:fs/promises';
import path from 'node:path';
import { forkSnapshot, hash, snapshotHash, type Roots } from './filesystem.js';
import type { Timings } from './timing.js';
import { performance } from 'node:perf_hooks';

type SnapshotOptions = { timeoutMs: number; signal?: AbortSignal; timings?: Timings };
const measure = <T>(options: SnapshotOptions, phase: 'hash' | 'clone', operation: () => Promise<T>) => options.timings ? options.timings.measure(phase, operation) : operation();

export type InstalledSnapshot = { key: string; roots: Roots; hashes: Record<keyof Roots, string>; source_trial: string };
export function installationKey(input: { snapshot: unknown; environment: unknown; installation: unknown; policy: unknown; preparation: unknown; limits: unknown }) {
  return hash(input);
}
export async function rootHashes(roots: Roots, maxBytes: number, options?: SnapshotOptions) {
  const hashes = {} as Record<keyof Roots, string>;
  const started = performance.now();
  for (const name of ['workspace', 'cache', 'tmp'] as const) hashes[name] = await snapshotHash(roots[name], maxBytes, true, {
    signal: options?.signal, timeoutMs: options ? Math.max(0, options.timeoutMs - (performance.now() - started)) : undefined,
    onProfile: options?.timings ? profile => options.timings!.recordHashScan(profile) : undefined,
  });
  return hashes;
}
/** Private to one experiment. A snapshot is published only after its full source trial passes. */
export class InstalledSnapshots {
  private entries = new Map<string, InstalledSnapshot>();
  constructor(private directory: string, private maxBytes: number) {}
  get(key: string) {
    const snapshot = this.entries.get(key);
    if (!snapshot) throw new Error('No verified installation snapshot for this input and policy');
    return snapshot;
  }
  async capture(key: string, roots: Roots, sourceTrial: string, options: SnapshotOptions) {
    return captureInstalledSnapshot(this.directory, this.maxBytes, key, roots, sourceTrial, options);
  }
  publish(snapshot: InstalledSnapshot) { this.entries.set(snapshot.key, snapshot); }
  async fork(key: string, roots: Roots, options: SnapshotOptions) {
    return forkInstalledSnapshot(this.get(key), this.maxBytes, roots, options);
  }
}

export async function captureInstalledSnapshot(directory: string, maxBytes: number, key: string, roots: Roots, sourceTrial: string, options: SnapshotOptions) {
  const destination = path.join(directory, key);
  await fs.mkdir(destination, { recursive: true });
  const copied = {} as Roots;
  try {
    const before = await measure(options, 'hash', () => rootHashes(roots, maxBytes, options));
    for (const name of ['workspace', 'cache', 'tmp'] as const) {
      copied[name] = path.join(destination, name);
      await measure(options, 'clone', () => forkSnapshot(roots[name], copied[name], options));
    }
    const hashes = await measure(options, 'hash', () => rootHashes(copied, maxBytes, options));
    if (hash(before) !== hash(hashes)) throw new Error('Installation state changed while freezing it: ' + Object.keys(before).filter(name => before[name as keyof Roots] !== hashes[name as keyof Roots]).join(', '));
    return { key, roots: copied, hashes, source_trial: sourceTrial };
  } catch (error) { await fs.rm(destination, { recursive: true, force: true }); throw error; }
}

export async function forkInstalledSnapshot(snapshot: InstalledSnapshot, maxBytes: number, roots: Roots, options: SnapshotOptions) {
  if (hash(await measure(options, 'hash', () => rootHashes(snapshot.roots, maxBytes, options))) !== hash(snapshot.hashes)) throw new Error('Frozen installation snapshot was changed');
  const forks = {} as Record<keyof Roots, Awaited<ReturnType<typeof forkSnapshot>>>;
  for (const name of ['workspace', 'cache', 'tmp'] as const) forks[name] = await measure(options, 'clone', () => forkSnapshot(snapshot.roots[name], roots[name], options));
  if (hash(await measure(options, 'hash', () => rootHashes(roots, maxBytes, options))) !== hash(snapshot.hashes)) throw new Error('Cloned installation state does not match the frozen snapshot');
  return { key: snapshot.key, source_trial: snapshot.source_trial, hashes: snapshot.hashes, forks };
}
