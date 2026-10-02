import { createHash } from 'node:crypto';
import type { Saved, MissingState, Model } from './types.js';

export const recorded = <T>(value: T): Saved<T> => ({ state: 'recorded', value: structuredClone(value) });
export const missing = <T = never>(state: MissingState, reason: string): Saved<T> => ({ state, reason });

/** Sorted object keys; arrays remain ordered. Only explicitly set-like fields are sorted by factories. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  throw new Error('Model identity requires finite JSON values');
}
export const semanticHash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Historical producer hashes used JSON.stringify, not the new canonical identity. */
export const legacyHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const objectId = (kind: string, content: unknown) => kind + ':v1:' + semanticHash(content);
export const grantSet = (value: string[]) => [...new Set(value)].sort();

export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** The adapter owns its result. Source objects and old digests remain untouched. */
export function finishModel(model: Model): Model {
  const indexes = new Set<string>();
  for (const collection of [model.tasks, model.agreements, model.policies, model.executions, model.baselines]) {
    for (const item of collection) {
      if (indexes.has(item.id)) throw new Error('Duplicate model object identity');
      indexes.add(item.id);
    }
  }
  const tasks = new Map(model.tasks.map(t => [t.id, t.key]));
  const agreements = new Map(model.agreements.map(a => [a.id, a.task_key]));
  const policies = new Map(model.policies.map(p => [p.id, p.task_key]));
  const taskKeys = new Set(model.tasks.map(t => t.key));
  if (taskKeys.size !== model.tasks.length) throw new Error('Duplicate logical task key');
  for (const item of [...model.agreements, ...model.policies]) {
    if (!taskKeys.has(item.task_key)) throw new Error('Agreement/policy references a missing task');
  }
  for (const current of model.workflow.current_policies) {
    if (policies.get(current.policy_id) !== current.task_key) throw new Error('Current policy references a different or missing task');
  }
  for (const execution of model.executions) {
    const key = tasks.get(execution.task_id);
    if (!key || agreements.get(execution.agreement_id) !== key) throw new Error('Execution references a different or missing task/agreement');
    if (execution.policy_id.state === 'recorded' && policies.get(execution.policy_id.value) !== key) throw new Error('Execution references a different or missing policy');
  }
  for (const baseline of model.baselines) if (baseline.task_ids.some(id => !tasks.has(id))) throw new Error('Baseline references a missing task');
  for (const comparison of model.workflow.comparisons) {
    if (!taskKeys.has(comparison.task_key)) throw new Error('Comparison references a missing task');
    if (comparison.suggestion_policy.state === 'recorded' && policies.get(comparison.suggestion_policy.value) !== comparison.task_key) throw new Error('Suggestion references a different or missing policy');
  }
  if (model.workflow.searches.some(s => !taskKeys.has(s.task_key))) throw new Error('Search references a missing task');
  if (new Set(model.workflow.current_policies.map(p => p.task_key)).size !== model.workflow.current_policies.length) throw new Error('Duplicate current policy role');
  return freeze(model);
}
