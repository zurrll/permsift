import { performance } from 'node:perf_hooks';

export const timingPhases = ['freeze', 'clone', 'hash', 'manifest', 'preparation', 'probes', 'install', 'task', 'assertions', 'discovery', 'reporting', 'cleanup'] as const;
export type TimingPhase = typeof timingPhases[number];
export type TimingSummary = { total_ms: number; measured_ms: number; other_ms: number; phases: Partial<Record<TimingPhase, { duration_ms: number; calls: number }>> };

/** Sequential operation spans. Nested spans charge their time only to the child.
 * Parallel work must be enclosed in a single span, not separate overlapping spans. */
export class Timings {
  private started: number;
  private phases: TimingSummary['phases'] = {};
  private stack: { started: number; children: number }[] = [];
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
  snapshot(): TimingSummary { return summarizeTimings(this.now() - this.started, [{ phases: this.phases }]); }
}

export function summarizeTimings(totalMs: number, records: Pick<TimingSummary, 'phases'>[]): TimingSummary {
  const phases: TimingSummary['phases'] = {};
  for (const record of records) for (const phase of timingPhases) {
    const value = record.phases[phase]; if (!value) continue;
    const entry = phases[phase] ??= { duration_ms: 0, calls: 0 };
    entry.duration_ms += value.duration_ms; entry.calls += value.calls;
  }
  const measured = Object.values(phases).reduce((sum, p) => sum + p.duration_ms, 0);
  return { total_ms: Math.max(0, totalMs), measured_ms: measured, other_ms: Math.max(0, totalMs - measured), phases };
}
