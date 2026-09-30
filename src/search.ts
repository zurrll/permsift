import { contains, type Scenario } from './config.js';

export type Rule = { from: string; to: string[]; source: 'manual' | 'file_changes' | 'directory_structure' | 'denial_hint' | 'input_structure'; evidence_ids: string[] };
export type Candidate = { grants: string[]; operation: string; semantic_change: boolean; source: Rule['source'] | 'removal'; evidence_ids: string[] };
export function candidates(scenario: Scenario, current: string[], automatic: Rule[] = [], permission: 'read' | 'write' = 'write'): Candidate[] {
  const result: Candidate[] = [];
  const manual = permission === 'read' ? scenario.narrower_read_candidates : scenario.narrower_candidates;
  for (const rule of [...manual.map(r => ({ ...r, source: 'manual' as const, evidence_ids: [] as string[] })), ...automatic]) {
    if (current.includes(rule.from)) result.push({
      grants: [...new Set([...current.filter(p => p !== rule.from), ...rule.to])].sort(),
      operation: `narrow ${rule.from} -> ${rule.to.join(', ')}`,
      semantic_change: !current.some(p => p !== rule.from && contains(p, rule.from)),
      source: rule.source, evidence_ids: rule.evidence_ids,
    });
  }
  for (const grant of current) result.push({ grants: current.filter(p => p !== grant), operation: `remove ${grant}`, semantic_change: !current.some(p => p !== grant && contains(p, grant)), source: 'removal', evidence_ids: [] });
  const unique = result.filter((r, i) => r.grants.length <= 32 && result.findIndex(other => JSON.stringify([...other.grants].sort()) === JSON.stringify([...r.grants].sort())) === i);
  // Remove unused input trees before expanding their internals. This avoids
  // spending the read-search budget on documentation and unused dependencies.
  return permission === 'read' ? [...unique.filter(r => r.source === 'removal'), ...unique.filter(r => r.source !== 'removal')] : unique;
}
export type TrialVerdict = 'pass' | 'fail' | 'unknown';
export type SearchStep = { permission: 'read' | 'write'; operation: string; before: string[]; after: string[]; semantic_change: boolean; source: Candidate['source']; evidence_ids: string[]; decision: 'accepted' | 'rejected' | 'unknown'; trial_id: string; recovery_id?: string };
export async function searchPolicy(scenario: Scenario, options: {
  evaluate: (grants: string[], phase: string) => Promise<{ verdict: TrialVerdict; id: string }>;
  canContinue: () => boolean;
  onStep?: (step: SearchStep) => Promise<void>;
  automatic?: Rule[];
  permission?: 'read' | 'write';
  initialGrants?: string[];
}) {
  const permission = options.permission ?? 'write';
  const initial = options.initialGrants ?? (permission === 'read' ? scenario.initial_read_grants : scenario.initial_write_grants);
  if (initial === undefined) throw new Error('Read search requires initial_read_grants');
  let current = [...initial].sort();
  const steps: SearchStep[] = [];
  let stop: 'exhausted' | 'budget' | 'unstable' = 'exhausted';
  search: while (true) {
    let changed = false;
    for (const candidate of candidates(scenario, current, options.automatic, permission)) {
      if (!options.canContinue()) { stop = 'budget'; break search; }
      const result = await options.evaluate(candidate.grants, permission === 'read' ? 'candidate_read' : 'candidate');
      const step: SearchStep = { permission, operation: candidate.operation, before: current, after: candidate.grants, semantic_change: candidate.semantic_change, source: candidate.source, evidence_ids: candidate.evidence_ids, decision: result.verdict === 'pass' ? 'accepted' : result.verdict === 'fail' ? 'rejected' : 'unknown', trial_id: result.id };
      if (result.verdict !== 'pass') {
        const recovery = await options.evaluate(current, permission === 'read' ? 'recovery_read' : 'recovery');
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
