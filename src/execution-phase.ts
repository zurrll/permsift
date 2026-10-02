import type { ExecutionResult } from './execute-once.js';
import type { TaskObservation } from './observation.js';
import type { TrialVerdict } from './search.js';

/** Workflow outcome, separate from its report projection. Also used by regression stages. */
export type ExecutionPhase = {
  status: 'running' | 'verified' | 'failed' | 'incomplete'; inputHash?: string;
  baselineVerified: boolean; finalVerified: boolean; taskKeys: string[];
  trials: Pick<ExecutionResult, 'id' | 'verdict' | 'diagnosis'>[]; observations: Record<string, TaskObservation>;
};
export function phaseVerdict(phase: ExecutionPhase): TrialVerdict {
  if (!phase.trials.length || phase.trials.some(t => t.verdict === 'unknown' || t.diagnosis?.boundary_issues.length)) return 'unknown';
  if (phase.status === 'verified' && phase.baselineVerified && phase.finalVerified && phase.trials.every(t => t.verdict === 'pass')) return 'pass';
  return phase.status === 'failed' && phase.trials.at(-1)?.verdict === 'fail' ? 'fail' : 'unknown';
}
