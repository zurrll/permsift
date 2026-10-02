import type { Check } from '../assertions.js';
import type { Saved, ProcessFact, BoundaryStage, Evaluation } from './types.js';

export function evaluateTask(process: Saved<ProcessFact>, assertions: Saved<Check[]>): Evaluation {
  if (process.state !== 'recorded') return { status: process.state === 'not_run' ? 'not_run' : 'not_saved', basis: process.reason };
  if (process.value.status !== 'completed' || process.value.exit_code === null) return { status: 'unknown', basis: 'Task process did not complete with an exit code' };
  if (process.value.exit_code !== 0) return { status: 'fail', basis: 'Task process exited nonzero' };
  if (assertions.state !== 'recorded') return { status: 'not_saved', basis: assertions.reason };
  if (!assertions.value.length || assertions.value.some(c => c.status === 'unknown')) return { status: 'unknown', basis: 'Task success checks were empty or inconclusive' };
  return { status: assertions.value.every(c => c.status === 'pass') ? 'pass' : 'fail', basis: 'Completed task process and retained success checks only; boundary results are separate' };
}

export function evaluateBoundaries(boundaries: Saved<BoundaryStage[]>, requiredStages: BoundaryStage['stage'][] = ['before', 'after']): Evaluation {
  if (boundaries.state !== 'recorded') return { status: boundaries.state === 'not_run' ? 'not_run' : 'not_saved', basis: boundaries.reason };
  const checks = boundaries.value.flatMap(b => b.checks);
  // Explicit unknown beats failure, matching the producer's conservative treatment.
  if (!checks.length || checks.some(c => c.status === 'unknown')) return { status: 'unknown', basis: 'Recorded boundary checks were empty or inconclusive' };
  if (checks.some(c => c.status === 'fail')) return { status: 'fail', basis: 'A recorded boundary/control expectation failed' };
  if (requiredStages.some(stage => !boundaries.value.some(b => b.stage === stage)) ||
      boundaries.value.some(b => !b.checks.length)) return { status: 'unknown', basis: 'Passing recorded checks do not include a complete before/after pair' };
  const core = ['secret_unreadable', 'outside_unwritable', 'report_unwritable', 'network_blocked'];
  if (boundaries.value.some(b => !b.checks.some(c => c.name.startsWith('control:')) ||
      !b.checks.some(c => c.name === 'control:network_endpoint') || core.some(name => !b.checks.some(c => c.name === name)))) {
    return { status: 'unknown', basis: 'Retained checks omit producer core expectations or host controls' };
  }
  return { status: 'pass', basis: 'Recorded before/after checks passed in their tested scope; no new user protection goal is inferred' };
}
