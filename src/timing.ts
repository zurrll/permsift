import { performance } from 'node:perf_hooks';
import { hashOperations, type HashScanProfile } from './hash-scan.js';

export const timingPhases = ['freeze', 'clone', 'hash', 'manifest', 'preparation', 'probes', 'protections', 'install', 'task', 'assertions', 'artifact_capture', 'discovery', 'reporting', 'cleanup'] as const;
export type TimingPhase = typeof timingPhases[number];
export type HashScanSummary = Omit<HashScanProfile, 'algorithm' | 'completed'> & { algorithms: string[]; scans: number; incomplete_scans: number };
export type TimingSummary = { total_ms: number; measured_ms: number; other_ms: number; phases: Partial<Record<TimingPhase, { duration_ms: number; calls: number }>>; hash_scan?: HashScanSummary };

/** Sequential operation spans. Nested spans charge their time only to the child.
 * Parallel work must be enclosed in a single span, not separate overlapping spans. */
export class Timings {
  private started: number;
  private phases: TimingSummary['phases'] = {};
  private stack: { started: number; children: number }[] = [];
  private hashScans: HashScanProfile[] = [];
  constructor(private now: () => number = () => performance.now()) { this.started = now(); }
  async measure<T>(phase: TimingPhase, operation: () => Promise<T>): Promise<T> {
    const span = { started: this.now(), children: 0 };
    this.stack.push(span);
    try { return await operation(); }
    finally {
      const elapsed = Math.max(0, this.now() - span.started);
      this.stack.pop();
      if (this.stack.length) this.stack[this.stack.length - 1].children += elapsed;
      const entry = this.phases[phase] ??= { duration_ms: 0, calls: 0 };
      entry.duration_ms += Math.max(0, elapsed - span.children); entry.calls++;
    }
  }
  recordHashScan(profile: HashScanProfile) { this.hashScans.push(structuredClone(profile)); }
  snapshot(): TimingSummary {
    const summary = summarizeTimings(this.now() - this.started, [{ phases: this.phases }]);
    if (this.hashScans.length) summary.hash_scan = mergeHashScans(this.hashScans.map(p => ({ ...p, algorithms: [p.algorithm], scans: 1, incomplete_scans: Number(!p.completed) })));
    return summary;
  }
}

function mergeHashScans(records: HashScanSummary[]): HashScanSummary {
  const result: HashScanSummary = { algorithms: [], scans: 0, incomplete_scans: 0, duration_ms: 0, files: 0, directories: 0, symlinks: 0, content_bytes: 0, concurrency: 0, peak_buffered_files: 0, operations: {} };
  for (const record of records) {
    for (const key of ['scans', 'incomplete_scans', 'duration_ms', 'files', 'directories', 'symlinks', 'content_bytes'] as const) result[key] += record[key];
    result.concurrency = Math.max(result.concurrency, record.concurrency); result.peak_buffered_files = Math.max(result.peak_buffered_files, record.peak_buffered_files);
    result.algorithms = [...new Set([...result.algorithms, ...record.algorithms])];
    for (const operation of hashOperations) {
      const value = record.operations[operation]; if (!value) continue;
      const entry = result.operations[operation] ??= { calls: 0, service_ms: 0 };
      entry.calls += value.calls; entry.service_ms += value.service_ms;
    }
  }
  return result;
}
export function summarizeTimings(totalMs: number, records: Pick<TimingSummary, 'phases' | 'hash_scan'>[]): TimingSummary {
  const phases: TimingSummary['phases'] = {};
  for (const record of records) for (const phase of timingPhases) {
    const value = record.phases[phase]; if (!value) continue;
    const entry = phases[phase] ??= { duration_ms: 0, calls: 0 };
    entry.duration_ms += value.duration_ms; entry.calls += value.calls;
  }
  const measured = Object.values(phases).reduce((sum, p) => sum + p.duration_ms, 0);
  const scans = records.flatMap(r => r.hash_scan ? [r.hash_scan] : []);
  return { total_ms: Math.max(0, totalMs), measured_ms: measured, other_ms: Math.max(0, totalMs - measured), phases, ...(scans.length ? { hash_scan: mergeHashScans(scans) } : {}) };
}
