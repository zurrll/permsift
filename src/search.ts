import { contains, type Scenario } from './config.js';

export type Candidate = { grants: string[]; operation: string; semantic_change: boolean };
export function candidates(scenario: Scenario, current: string[]): Candidate[] {
  const result: Candidate[] = [];
  for (const rule of scenario.narrower_candidates) {
    if (current.includes(rule.from)) result.push({
      grants: [...new Set([...current.filter(p => p !== rule.from), ...rule.to])].sort(),
      operation: `narrow ${rule.from} -> ${rule.to.join(', ')}`,
      semantic_change: !current.some(p => p !== rule.from && contains(p, rule.from)),
    });
  }
  for (const grant of current) result.push({ grants: current.filter(p => p !== grant), operation: `remove ${grant}`, semantic_change: !current.some(p => p !== grant && contains(p, grant)) });
  return result;
}
export type TrialVerdict = 'pass' | 'fail' | 'unknown';
export type SearchStep = { operation: string; before: string[]; after: string[]; semantic_change: boolean; decision: 'accepted' | 'rejected' | 'unknown'; trial_id: string; recovery_id?: string };
export async function searchPolicy(scenario: Scenario, options: {
  evaluate: (grants: string[], phase: string) => Promise<{ verdict: TrialVerdict; id: string }>;
  canContinue: () => boolean;
  onStep?: (step: SearchStep) => Promise<void>;
}) {
  let current = [...scenario.initial_write_grants].sort();
  const steps: SearchStep[] = [];
  let stop: 'exhausted' | 'budget' | 'unstable' = 'exhausted';
  search: while (true) {
    let changed = false;
    for (const candidate of candidates(scenario, current)) {
      if (!options.canContinue()) { stop = 'budget'; break search; }
      const result = await options.evaluate(candidate.grants, 'candidate');
      const step: SearchStep = { operation: candidate.operation, before: current, after: candidate.grants, semantic_change: candidate.semantic_change, decision: result.verdict === 'pass' ? 'accepted' : result.verdict === 'fail' ? 'rejected' : 'unknown', trial_id: result.id };
      if (result.verdict !== 'pass') {
        const recovery = await options.evaluate(current, 'recovery');
        step.recovery_id = recovery.id;
        if (recovery.verdict !== 'pass') { step.decision = 'unknown'; stop = 'unstable'; }
      }
      steps.push(step);
      if (result.verdict === 'pass') { current = candidate.grants; changed = true; }
      await options.onStep?.(step);
      if (stop === 'unstable') break search;
      if (changed) break; // Re-evaluate all operators against the new current policy.
    }
    if (!changed) break;
  }
  return { grants: current, steps, stop };
}
