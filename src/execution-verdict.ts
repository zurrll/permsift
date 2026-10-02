import type { Check } from './assertions.js';
import type { TrialVerdict } from './search.js';

export function classifyTrial(taskStatus: string, exitCode: number | null, assertions: Check[], boundaries: Check[]): TrialVerdict {
  if (!assertions.length || !boundaries.length) return 'unknown';
  if (taskStatus !== 'completed' || boundaries.some(c => c.status === 'unknown') || assertions.some(c => c.status === 'unknown')) return 'unknown';
  return exitCode === 0 && assertions.every(c => c.status === 'pass') && boundaries.every(c => c.status === 'pass') ? 'pass' : 'fail';
}
