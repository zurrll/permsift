import { z } from 'zod';
import type { ProtectionGoal, ProtectionAgreement, Saved, Evaluation } from './model/types.js';

const check = z.object({ name: z.string().min(1).max(512), status: z.enum(['pass', 'fail', 'unknown']), detail: z.string().max(16384) }).strict();
export const protectionStageSchema = z.object({
  stage: z.literal('task'), moment: z.enum(['before', 'after']), method: z.literal('isolated_fake_workspace_v1'),
  results: z.array(z.object({ key: z.string().min(1).max(64), target: check,
    controls_before: z.array(check).max(16), controls_after: z.array(check).max(16), checks: z.array(check).max(8),
    status: z.enum(['pass', 'fail', 'unknown']),
  }).strict()).min(1).max(16),
}).strict();
export type ProtectionStage = z.infer<typeof protectionStageSchema>;
export type GoalResult = ProtectionStage['results'][number];

export function goalOperations(goal: ProtectionGoal): string[] {
  if (goal.operation === 'read') return goal.target_kind === 'file' ? ['read_file'] : ['read_file', 'list_directory'];
  if (goal.operation === 'create') return ['create_file'];
  return ['write_existing_file', ...goal.target_kind === 'directory' ? ['create_file'] : [], 'remove_file', 'rename_file'];
}
export function goalVerdict(result: Omit<GoalResult, 'status'>): GoalResult['status'] {
  if (result.target.status !== 'pass') return 'unknown';
  if (result.checks.some(c => c.status === 'fail')) return 'fail';
  const controls = [...result.controls_before, ...result.controls_after];
  return result.checks.length && result.controls_before.length && result.controls_after.length && [...result.checks, ...controls].every(c => c.status === 'pass') ? 'pass' : 'unknown';
}
/** This evaluator never equates missing targets, ENOENT or missing stages with denial. */
export function evaluateProtections(agreement: ProtectionAgreement, evidence?: Saved<ProtectionStage[]>): Evaluation {
  if (agreement.declaration.state !== 'recorded') return { status: 'not_saved', basis: 'No user protection declaration is retained' };
  if (!evidence || evidence.state !== 'recorded') return { status: evidence?.state === 'not_run' ? 'not_run' : 'not_saved', basis: 'Declared protection checks are not retained' };
  const goals = agreement.declaration.value;
  if (!goals.length || goals.some(g => g.stage !== 'task')) return { status: 'unknown', basis: 'Unsupported or empty protection declaration' };
  const stages = evidence.value;
  let incomplete = !['before', 'after'].every(m => stages.some(s => s.moment === m)) || stages.length !== 2;
  let failed = false;
  for (const s of stages) {
    if (s.stage !== 'task' || s.method !== 'isolated_fake_workspace_v1' || s.results.length !== goals.length || new Set(s.results.map(r => r.key)).size !== goals.length) incomplete = true;
    for (const goal of goals) {
      const result = s.results.find(r => r.key === goal.key);
      if (!result) { incomplete = true; continue; }
      const actual = goalVerdict(result);
      if (actual !== result.status) incomplete = true;
      if (actual === 'fail') failed = true;
      if (actual !== 'pass' || result.target.name !== 'target:' + goal.key ||
        JSON.stringify(result.checks.map(c => c.name)) !== JSON.stringify(goalOperations(goal)) ||
        !result.controls_before.some(c => c.name === 'fixture') || !result.controls_after.some(c => c.name === 'fixture')) incomplete = true;
    }
  }
  return failed ? { status: 'fail', basis: 'A declared direct-access protection probe was allowed' } : incomplete ?
    { status: 'unknown', basis: 'Protection coverage, target/fixture controls or before/after checks are incomplete' } :
    { status: 'pass', basis: 'Fixed task protection goals passed direct-access probes in isolated fake workspaces before and after the task; installation and other access channels are outside this scope' };
}
