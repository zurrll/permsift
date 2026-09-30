import { contains, type Scenario } from './config.js';

export type Rule = { from: string; to: string[]; source: 'manual' | 'file_changes' | 'directory_structure' | 'denial_hint' | 'input_structure'; evidence_ids: string[] };
export type Candidate = { grants: string[]; operation: string; semantic_change: boolean; source: Rule['source'] | 'removal' | 'group_removal'; evidence_ids: string[]; removed_grants?: string[] };
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
export type SearchStep = { permission: 'read' | 'write'; round: number; operation: string; before: string[]; after: string[]; semantic_change: boolean; source: Candidate['source']; evidence_ids: string[]; decision: 'accepted' | 'rejected' | 'unknown'; trial_id: string; recovery_id?: string; removed_grants?: string[] };
export type SearchReuse = { permission: 'read' | 'write'; round: number; operation: string; before: string[]; after: string[]; failed_trial_id: string };

function removal(current: string[], removed: string[]): Candidate {
  const grants = current.filter(p => !removed.includes(p));
  return {
    grants, removed_grants: removed,
    operation: removed.length === 1 ? `remove ${removed[0]}` : `remove group ${removed.join(', ')}`,
    semantic_change: removed.some(p => !grants.some(other => contains(other, p))),
    source: removed.length === 1 ? 'removal' : 'group_removal', evidence_ids: [],
  };
}

/** Batch siblings once per round. New children from a narrowing can form new batches. */
function removalGroups(current: string[], attempted: Set<string>, scheduled: Set<string>): string[][] {
  const siblings = new Map<string, string[]>();
  for (const grant of current) {
    if (scheduled.has(grant) || attempted.has(`remove ${grant}`)) continue;
    const parent = grant.includes('/') ? grant.slice(0, grant.lastIndexOf('/')) : '';
    const group = siblings.get(parent) ?? [];
    group.push(grant); siblings.set(parent, group);
  }
  const groups = [...siblings.values()].filter(group => group.length >= 3);
  for (const group of groups) for (const grant of group) scheduled.add(grant);
  return groups;
}
export async function searchPolicy(scenario: Scenario, options: {
  evaluate: (grants: string[], phase: string) => Promise<{ verdict: TrialVerdict; id: string }>;
  canContinue: () => boolean;
  onStep?: (step: SearchStep) => Promise<void>;
  onReuse?: (reuse: SearchReuse) => Promise<void>;
  automatic?: Rule[];
  permission?: 'read' | 'write';
  initialGrants?: string[];
}) {
  const permission = options.permission ?? 'write';
  const initial = options.initialGrants ?? (permission === 'read' ? scenario.initial_read_grants : scenario.initial_write_grants);
  if (initial === undefined) throw new Error('Read search requires initial_read_grants');
  let current = [...initial].sort();
  const steps: SearchStep[] = [];
  const reuses: SearchReuse[] = [];
  let stop: 'exhausted' | 'budget' | 'unstable' = 'exhausted';
  let round = 0;
  search: while (true) {
    round++;
    let changed = false;
    let revision = 0;
    const compared = new Map<string, number>();
    const attempted = new Set<string>();
    const scheduled = new Set<string>();
    const groups: string[][] = [];
    // Only recovered, conclusive failures from this round are scheduling hints.
    // Unknown/pass results are not reused; the next round starts with no cache.
    const failedPolicies = new Map<string, string>();
    while (true) {
      const fresh = candidates(scenario, current, options.automatic, permission).filter(c => !attempted.has(c.operation));
      // Write narrowing uses observed output scopes first. Read narrowing follows
      // removal, so unused input trees are not expanded into individual files.
      const writeNarrowing = permission === 'write' ? fresh.find(c => c.source !== 'removal') : undefined;
      let candidate = writeNarrowing;
      if (!candidate) {
        if (!groups.length) groups.push(...removalGroups(current, attempted, scheduled));
        if (groups.length) {
          const members = groups.shift()!.filter(p => current.includes(p));
          if (!members.length) continue;
          candidate = removal(current, members);
          if (attempted.has(candidate.operation)) continue;
        } else candidate = fresh[0];
      }
      if (!candidate) break;
      if (!options.canContinue()) { stop = 'budget'; break search; }
      attempted.add(candidate.operation);
      const candidateRevision = revision;
      const policyKey = JSON.stringify([...candidate.grants].sort());
      const failedTrial = failedPolicies.get(policyKey);
      if (failedTrial) {
        const reuse: SearchReuse = { permission, round, operation: candidate.operation, before: current, after: candidate.grants, failed_trial_id: failedTrial };
        reuses.push(reuse); await options.onReuse?.(reuse);
        if (candidate.removed_grants && candidate.removed_grants.length > 1) {
          const middle = Math.floor(candidate.removed_grants.length / 2);
          groups.unshift(candidate.removed_grants.slice(0, middle), candidate.removed_grants.slice(middle));
        }
        continue;
      }
      const result = await options.evaluate(candidate.grants, permission === 'read' ? 'candidate_read' : 'candidate');
      const step: SearchStep = { permission, round, operation: candidate.operation, before: current, after: candidate.grants, semantic_change: candidate.semantic_change, source: candidate.source, evidence_ids: candidate.evidence_ids, removed_grants: candidate.removed_grants, decision: result.verdict === 'pass' ? 'accepted' : result.verdict === 'fail' ? 'rejected' : 'unknown', trial_id: result.id };
      if (result.verdict !== 'pass') {
        const recovery = await options.evaluate(current, permission === 'read' ? 'recovery_read' : 'recovery');
        step.recovery_id = recovery.id;
        if (recovery.verdict !== 'pass') { step.decision = 'unknown'; stop = 'unstable'; }
      }
      steps.push(step);
      if (result.verdict === 'pass') { current = candidate.grants; changed = true; revision++; }
      await options.onStep?.(step);
      if (stop === 'unstable') break search;
      if (step.decision !== 'unknown') compared.set(policyKey, candidateRevision);
      if (step.decision === 'rejected') failedPolicies.set(policyKey, result.id);
      if (result.verdict !== 'pass' && candidate.removed_grants && candidate.removed_grants.length > 1) {
        const middle = Math.floor(candidate.removed_grants.length / 2);
        groups.unshift(candidate.removed_grants.slice(0, middle), candidate.removed_grants.slice(middle));
      }
    }
    // Revisit older failures only after this round. If every remaining generated
    // comparison ran after the last change, a duplicate closing round adds nothing.
    const remaining = [...candidates(scenario, current, options.automatic, permission),
      ...removalGroups(current, new Set(), new Set()).map(members => removal(current, members))];
    if (!changed || remaining.every(c => compared.get(JSON.stringify([...c.grants].sort())) === revision)) break;
  }
  return { grants: current, steps, reuses, stop, rounds: round };
}
