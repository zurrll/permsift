import * as fs from 'node:fs/promises';
import path from 'node:path';
import { forkSnapshot, hash, snapshotHash, type Roots } from './filesystem.js';

export type InstalledSnapshot = { key: string; roots: Roots; hashes: Record<keyof Roots, string>; source_trial: string };
export function installationKey(input: { snapshot: unknown; environment: unknown; installation: unknown; policy: unknown; preparation: unknown; limits: unknown }) {
  return hash(input);
}
export async function rootHashes(roots: Roots, maxBytes: number) {
  const hashes = {} as Record<keyof Roots, string>;
  for (const name of ['workspace', 'cache', 'tmp'] as const) hashes[name] = await snapshotHash(roots[name], maxBytes, true);
  return hashes;
}
/** Private to one experiment. A snapshot is published only after its full source trial passes. */
export class InstalledSnapshots {
  private entries = new Map<string, InstalledSnapshot>();
  constructor(private directory: string, private maxBytes: number) {}
  async capture(key: string, roots: Roots, sourceTrial: string, options: { timeoutMs: number; signal?: AbortSignal }) {
    const destination = path.join(this.directory, key);
    await fs.mkdir(destination, { recursive: true });
    const copied = {} as Roots;
    try {
      const before = await rootHashes(roots, this.maxBytes);
      for (const name of ['workspace', 'cache', 'tmp'] as const) {
        copied[name] = path.join(destination, name);
        await forkSnapshot(roots[name], copied[name], options);
      }
      const hashes = await rootHashes(copied, this.maxBytes);
      if (hash(before) !== hash(hashes)) throw new Error('Installation state changed while freezing it: ' + Object.keys(before).filter(name => before[name as keyof Roots] !== hashes[name as keyof Roots]).join(', '));
      return { key, roots: copied, hashes, source_trial: sourceTrial };
    } catch (error) { await fs.rm(destination, { recursive: true, force: true }); throw error; }
  }
  publish(snapshot: InstalledSnapshot) { this.entries.set(snapshot.key, snapshot); }
  async fork(key: string, roots: Roots, options: { timeoutMs: number; signal?: AbortSignal }) {
    const snapshot = this.entries.get(key);
    if (!snapshot) throw new Error('No verified installation snapshot for this input and policy');
    if (hash(await rootHashes(snapshot.roots, this.maxBytes)) !== hash(snapshot.hashes)) throw new Error('Frozen installation snapshot was changed');
    const forks = {} as Record<keyof Roots, Awaited<ReturnType<typeof forkSnapshot>>>;
    for (const name of ['workspace', 'cache', 'tmp'] as const) forks[name] = await forkSnapshot(snapshot.roots[name], roots[name], options);
    if (hash(await rootHashes(roots, this.maxBytes)) !== hash(snapshot.hashes)) throw new Error('Cloned installation state does not match the frozen snapshot');
    return { key, source_trial: snapshot.source_trial, hashes: snapshot.hashes, forks };
  }
}
