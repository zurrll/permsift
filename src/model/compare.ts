import { semanticHash } from './identity.js';
import type { Model, Saved, ComparisonState, ModelComparison } from './types.js';

function compareSaved(a?: Saved<unknown>, b?: Saved<unknown>): ComparisonState {
  if (!a || !b || a.state === 'not_saved' || b.state === 'not_saved' || a.state === 'not_run' || b.state === 'not_run') return 'not_saved';
  if (a?.state === 'not_declared' || b?.state === 'not_declared') return a?.state === b?.state ? 'not_declared' : 'changed';
  if (a?.state !== 'recorded' || b?.state !== 'recorded') return 'not_saved';
  return semanticHash(a.value) === semanticHash(b.value) ? 'same' : 'changed';
}
function merge(states: ComparisonState[]): ComparisonState {
  return states.includes('changed') ? 'changed' : states.includes('not_saved') ? 'not_saved' : 'same';
}
function comparePolicies(a: Model['policies'][number] | undefined, b: Model['policies'][number] | undefined): ComparisonState {
  if (!a || !b) return 'not_saved';
  const states = [compareSaved(a.task.write, b.task.write), compareSaved(a.task.network, b.task.network)];
  if (a.task.read.state === 'recorded' && b.task.read.state === 'recorded') {
    states.push(a.task.read.value.mode !== b.task.read.value.mode || semanticHash(a.task.read.value.grants) !== semanticHash(b.task.read.value.grants) ? 'changed' : 'same',
      compareSaved(a.task.read.value.target_kinds, b.task.read.value.target_kinds));
  } else states.push(compareSaved(a.task.read, b.task.read));
  if (a.installation.state === 'recorded' && b.installation.state === 'recorded') {
    states.push(a.installation.value.mode !== b.installation.value.mode || semanticHash(a.installation.value.write) !== semanticHash(b.installation.value.write) ? 'changed' : 'same',
      compareSaved(a.installation.value.network, b.installation.value.network));
  } else states.push(compareSaved(a.installation, b.installation));
  return merge(states);
}
function conditionSet(model: Model, key: string) {
  const task = model.tasks.find(t => t.key === key);
  return model.executions.filter(e => e.task_id === task?.id).map(e => ({
    preparation: e.conditions.preparation, requirements: e.conditions.requirements,
    actual_command: e.conditions.actual_command, instrumentation: e.conditions.instrumentation,
    installation_state: e.conditions.installation_state,
  }));
}
/** Compares a known subset; missing execution conditions never imply equivalence. */
function compareConditions(a: ReturnType<typeof conditionSet>, b: ReturnType<typeof conditionSet>): ComparisonState {
  if (!a.length || !b.length) return 'not_saved';
  const fields = ['preparation', 'requirements', 'actual_command', 'instrumentation', 'installation_state'] as const;
  let missing = false;
  for (const field of fields) {
    const x = a.map(c => c[field]), y = b.map(c => c[field]);
    if (x.some(c => c.state !== 'recorded') || y.some(c => c.state !== 'recorded')) { missing = true; continue; }
    const values = (items: typeof x) => [...new Set(items.map(s => semanticHash(s.state === 'recorded' ? s.value : null)))].sort();
    if (semanticHash(values(x)) !== semanticHash(values(y))) return 'changed';
  }
  return missing ? 'not_saved' : 'same';
}
export function compareModels(before: Model, after: Model): ModelComparison {
  if (before.identity_version !== after.identity_version) throw new Error('Model identity versions require an explicit migration before comparison');
  const result: ModelComparison = { input: compareSaved(before.source.recorded_hashes.input, after.source.recorded_hashes.input),
    limits: compareSaved(before.source.recorded_hashes.limits, after.source.recorded_hashes.limits),
    environment: compareSaved(before.source.environment, after.source.environment), tasks: [] };
  for (const key of [...new Set([...before.tasks, ...after.tasks].map(t => t.key))].sort()) {
    const a = before.tasks.find(t => t.key === key), b = after.tasks.find(t => t.key === key);
    const agreement = (model: Model) => model.agreements.find(p => p.task_key === key)?.declaration;
    const current = (model: Model) => model.policies.find(p => p.id === model.workflow.current_policies.find(c => c.task_key === key)?.policy_id);
    const fingerprint = (model: Model) => model.executions.find(e => e.task_id === model.tasks.find(t => t.key === key)?.id)?.conditions.producer_scenario_hash;
    const x = current(before), y = current(after);
    const policies = comparePolicies(x, y);
    const definition = compareSaved(a?.definition, b?.definition);
    const row: ModelComparison['tasks'][number] = { key, presence: !a ? 'added' : !b ? 'removed' : 'both', definition,
      agreement: compareSaved(agreement(before), agreement(after)), policies,
      execution_conditions: compareConditions(conditionSet(before, key), conditionSet(after, key)),
      legacy_scenario_fingerprint: compareSaved(fingerprint(before), fingerprint(after)), review_reasons: [] };
    if (row.presence !== 'both') row.review_reasons.push('Task ' + row.presence);
    if (definition === 'changed') row.review_reasons.push('Command or success conditions changed; passing old rules does not prove the original agreement');
    if (row.agreement !== 'same') row.review_reasons.push('Protection goals changed or were not declared/retained');
    if (row.execution_conditions !== 'same') row.review_reasons.push('Execution conditions changed or were not fully retained');
    if (definition === 'not_saved' && row.legacy_scenario_fingerprint === 'changed') row.review_reasons.push('Opaque producer scenario hash changed; it also includes policy/search/collector settings');
    result.tasks.push(row);
  }
  return result;
}
