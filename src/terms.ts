import type { Config, Scenario } from './config.js';
import { isStaged } from './config.js';
import { taskDefinition, protectionAgreement } from './model/definitions.js';
import { canonical } from './model/identity.js';
import { z } from 'zod';

export type TermsChange = { dimension: string; before?: unknown; after?: unknown };
export type TermsComparison = {
  presence: 'retained' | 'added' | 'removed'; changed: boolean; changes: TermsChange[];
  dimensions: { dimension: string; relation: 'same' | 'changed' | 'added' | 'removed' }[];
};
const dimension = z.string().regex(/^(command|success_conditions|execution_requirements|boundaries|protection_goal:[a-z][a-z0-9-]{0,63})$/);
export const termsComparisonSchema = z.object({ presence: z.enum(['retained', 'added', 'removed']), changed: z.boolean(),
  changes: z.array(z.object({ dimension, before: z.unknown().optional(), after: z.unknown().optional() }).strict()).max(36),
  dimensions: z.array(z.object({ dimension, relation: z.enum(['same', 'changed', 'added', 'removed']) }).strict()).max(36),
}).strict();
export const historicalVerificationSchema = z.object({ reference: z.string().min(1).max(16384), execution_ids: z.array(z.string()).min(1).max(10),
  task: z.literal('pass'), boundaries: z.literal('pass'), protection_goals: z.array(z.object({ key: z.string(), status: z.literal('pass') })).max(16),
}).strict();
export type HistoricalVerification = z.infer<typeof historicalVerificationSchema>;
export const executionRequirements = (s: Scenario) => ({ timeout_seconds: s.timeout_seconds,
  prepare_directories: [...s.prepare_directories].sort(),
  read_mode: s.initial_read_grants === undefined ? 'legacy' : 'explicit',
  install: s.install ? { manager: s.install.manager, cache: s.install.cache, cache_seed: s.install.cache_seed ?? null,
    registry: s.install.registry, mode: isStaged(s) ? 'separate' : 'shared' } : null });
const equal = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/** Exact definition changes, without guessing whether arbitrary assertions became stronger or weaker. */
export function compareTerms(before?: Scenario, after?: Scenario, options: { ignorePreparation?: boolean } = {}): TermsComparison {
  const key = (after ?? before)!.id, changes: TermsChange[] = [], dimensions: TermsComparison['dimensions'] = [];
  const add = (dimension: string, a: unknown, b: unknown) => {
    const relation = a === undefined ? 'added' : b === undefined ? 'removed' : equal(a, b) ? 'same' : 'changed';
    dimensions.push({ dimension, relation });
    if (relation !== 'same') changes.push({ dimension, ...a === undefined ? {} : { before: a }, ...b === undefined ? {} : { after: b } });
  };
  const definition = (s?: Scenario) => s ? taskDefinition(key, s).definition : undefined;
  const a = definition(before), b = definition(after);
  add('command', a?.state === 'recorded' ? a.value.command : undefined, b?.state === 'recorded' ? b.value.command : undefined);
  add('success_conditions', a?.state === 'recorded' ? a.value.success_conditions : undefined, b?.state === 'recorded' ? b.value.success_conditions : undefined);
  const requirements = (s?: Scenario) => s ? executionRequirements(options.ignorePreparation ? { ...s, prepare_directories: [] } : s) : undefined;
  add('execution_requirements', requirements(before), requirements(after));
  // The fixed probe method has not changed here. Fresh execution/environment results remain separate facts.
  add('boundaries', before ? 'fixed_execution_probes' : undefined, after ? 'fixed_execution_probes' : undefined);
  const goals = (s?: Scenario) => { const d = protectionAgreement(key, s).declaration; return d.state === 'recorded' ? d.value : []; };
  const old = goals(before), current = goals(after);
  for (const goal of [...new Set([...old, ...current].map(g => g.key))].sort())
    add('protection_goal:' + goal, old.find(g => g.key === goal), current.find(g => g.key === goal));
  return { presence: !before ? 'added' : !after ? 'removed' : 'retained', changed: changes.length > 0, changes, dimensions };
}
export function compareConfigurationTerms(before: Config, after: Config) {
  return Object.fromEntries([...new Set([...before.scenarios, ...after.scenarios].map(s => s.id))].map(key =>
    [key, compareTerms(before.scenarios.find(s => s.id === key), after.scenarios.find(s => s.id === key))]));
}
