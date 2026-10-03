import type { Scenario } from '../config.js';
import type { TaskDefinition, ProtectionAgreement } from './types.js';
import { recorded, missing, objectId, grantSet, canonical } from './identity.js';

/** Logical identity excludes permission/search/collector settings and task execution conditions. */
export function taskDefinition(key: string, scenario?: Scenario, opaqueHash?: string): TaskDefinition {
  const definition: TaskDefinition['definition'] = scenario ? recorded({ command: scenario.command, success_conditions: scenario.assertions.map(a =>
    'expected_tests' in a ? { ...a, expected_tests: grantSet(a.expected_tests) } : a).sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0) }) : missing('not_saved', 'Task command and success conditions was not retained in this artifact');
  return { id: objectId('task', { key, definition, ...scenario ? {} : { opaque_hash: opaqueHash ?? null } }), key, definition };
}

/** Both native and imported v1 configurations have the same undeclared agreement identity. */
export function undeclaredAgreement(key: string): ProtectionAgreement {
  const declaration = missing<never[]>('not_declared', 'Legacy producer has no user protection-goal declaration');
  return { id: objectId('agreement', { key, declaration }), task_key: key, declaration };
}

export function protectionAgreement(key: string, scenario?: Pick<Scenario, 'protection_goals'>): ProtectionAgreement {
  if (!scenario?.protection_goals) return undeclaredAgreement(key);
  const declaration = recorded([...scenario.protection_goals].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { id: objectId('agreement', { key, declaration }), task_key: key, declaration };
}
