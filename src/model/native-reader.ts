import { z } from 'zod';
import { aliasSchema, readAliasSchema, domainSchema, scenarioSchema } from '../config.js';
import { parseUsage } from '../usage-report.js';
import { canonical, freeze, objectId } from './identity.js';
import { evaluateTask, evaluateBoundaries } from './conclusions.js';
import type { NativeExecution } from './native.js';
import { protectionGoalSchema } from '../config.js';
import { protectionStageSchema, evaluateProtections, goalVerdict } from '../protection-facts.js';

const text = z.string().min(1).max(16384), digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = (role: string) => z.string().regex(new RegExp('^' + role + ':v1:[a-f0-9]{64}$'));
const saved = <T extends z.ZodTypeAny>(value: T) => z.union([
  z.object({ state: z.literal('recorded'), value }).strict(),
  z.object({ state: z.enum(['not_saved', 'not_declared', 'not_run']), reason: text }).strict(),
]);
const set = <T extends z.ZodTypeAny>(item: T, max = 2048) => z.array(item).max(max).refine(v => new Set(v).size === v.length, 'Duplicate set member');
// Match the producer's command contract; the file reader bounds total bytes.
const command = z.array(z.string().min(1).refine(s => !s.includes('\0'))).min(1), verdict = z.enum(['pass', 'fail', 'unknown']);
const checks = z.array(z.object({ name: text, status: verdict, detail: z.string().max(16384) }).strict()).max(4096);
const process = z.object({ status: text, exit_code: z.number().int().nullable() }).strict();
const capture = z.object({ status: z.enum(['captured', 'incomplete', 'unavailable', 'not_collected', 'not_saved', 'not_run']),
  issues: z.array(text).max(4096), scope: text }).strict();
const evaluation = z.object({ status: z.enum(['pass', 'fail', 'unknown', 'not_saved', 'not_run']), basis: text }).strict();
const schema = z.object({ schema_version: z.union([z.literal(1), z.literal(2)]), kind: z.literal('permsift_execution'), model_version: z.literal(1), identity_version: z.literal(1),
  task: z.object({ id: id('task'), key: text, definition: saved(z.object({ command, success_conditions: scenarioSchema.shape.assertions }).strict()) }).strict(),
  agreement: z.object({ id: id('agreement'), task_key: text, declaration: saved(z.array(z.object({ key: text, target: text,
    target_kind: z.enum(['file', 'directory']), operation: z.enum(['read', 'create', 'write']), stage: z.enum(['install', 'task']), expected: z.literal('denied') }).strict()).max(2048)) }).strict(),
  policy: z.object({ id: id('policy'), task_key: text, scope: z.literal('producer_variable_grants'),
    protection_denials: z.array(protectionGoalSchema).min(1).max(16).optional(),
    task: z.object({ write: saved(set(aliasSchema)), read: saved(z.object({ mode: z.enum(['legacy', 'explicit']), grants: set(readAliasSchema),
      target_kinds: saved(z.record(z.enum(['file', 'directory']))) }).strict()), network: saved(set(domainSchema, 64)) }).strict(),
    installation: saved(z.object({ mode: z.enum(['shared', 'separate']), write: set(aliasSchema), network: saved(set(domainSchema, 64)), reads: z.literal('producer_fixed_workspace_reads') }).strict()) }).strict(),
  execution: z.object({ id: id('execution'), task_id: id('task'), agreement_id: id('agreement'), policy_id: saved(id('policy')),
    origin: z.object({ producer_id: text, record: text, phase: text }).strict(), reported_verdict: saved(verdict),
    process: saved(process), assertions: saved(checks),
    installation: saved(z.object({ command, process, reported_verdict: verdict, reused: saved(z.boolean()) }).strict()),
    boundaries: saved(z.array(z.object({ stage: z.enum(['before', 'after_installation', 'before_offline_task', 'after']), checks }).strict()).max(4)),
    protections: saved(z.array(protectionStageSchema).max(2)).optional(),
    observations: z.object({ inventory: capture, modules: capture, compiler: capture, build: capture,
      records: saved(z.unknown().refine(v => v !== undefined, 'Observation records required')) }).strict(),
    conditions: z.object({ input_hash: saved(digest), config_hash: saved(digest), limits_hash: saved(digest), environment: saved(z.record(z.string())),
      preparation: saved(set(aliasSchema)), requirements: saved(z.object({ timeout_seconds: z.number().int().min(1).max(600), install: z.record(z.unknown()).nullable() }).strict()),
      producer_scenario_hash: saved(digest), actual_command: saved(command), instrumentation: saved(z.record(z.unknown())),
      installation_state: saved(z.object({ reused: z.boolean(), snapshot: saved(z.record(z.unknown())) }).strict()), producer_policy_hash: saved(digest) }).strict(),
    outcomes: z.object({ task: evaluation, boundaries: evaluation, protections: evaluation.optional() }).strict() }).strict(),
}).strict();

/** v1 remains readable; v2 explicitly adds executable negative goals and proof coverage. */
export function parseNativeExecution(raw: unknown): NativeExecution {
  const value = schema.parse(raw) as NativeExecution, { task, agreement, policy, execution: e } = value;
  if (task.definition.state !== 'recorded' || task.id !== objectId('task', { key: task.key, definition: task.definition })) throw new Error('Native task identity mismatch');
  if (agreement.task_key !== task.key || agreement.id !== objectId('agreement', { key: agreement.task_key, declaration: agreement.declaration })) throw new Error('Native agreement identity mismatch');
  const { id: policyId, ...policyContent } = policy, { id: executionId, ...executionContent } = e;
  if (policy.task_key !== task.key || policyId !== objectId('policy', policyContent)) throw new Error('Native policy identity mismatch');
  if (e.task_id !== task.id || e.agreement_id !== agreement.id || e.policy_id.state !== 'recorded' || e.policy_id.value !== policy.id || executionId !== objectId('execution', executionContent)) throw new Error('Native execution identity/reference mismatch');
  const read = policy.task.read;
  if (read.state === 'recorded') {
    if (read.value.mode === 'legacy' && canonical(read.value.grants) !== canonical(['@workspace'])) throw new Error('Native legacy read policy mismatch');
    if (read.value.target_kinds.state === 'recorded' && canonical(Object.keys(read.value.target_kinds.value).sort()) !== canonical([...read.value.grants].sort())) throw new Error('Native read target kinds mismatch');
  }
  if (policy.task.network.state === 'recorded' && policy.task.network.value.length) throw new Error('Native task must be offline');
  if (value.schema_version === 2 && agreement.declaration.state === 'recorded') {
    const goals = agreement.declaration.value;
    if (!goals.length || new Set(goals.map(g => g.key)).size !== goals.length || canonical(goals) !== canonical(policy.protection_denials) || !e.protections || !e.outcomes.protections) throw new Error('Native protection agreement/policy/evidence mismatch');
    if (e.protections.state === 'recorded' && (new Set(e.protections.value.map(s => s.moment)).size !== e.protections.value.length || e.protections.value.some(s => s.results.some(r => r.status !== goalVerdict(r))))) throw new Error('Native protection stage/result mismatch');
    if (canonical(e.outcomes.protections) !== canonical(evaluateProtections(agreement, e.protections))) throw new Error('Native derived protection outcome disagrees with facts');
  } else if (value.schema_version === 2 || policy.protection_denials || e.protections || e.outcomes.protections) throw new Error('Native protection version/declaration mismatch');
  if (e.boundaries.state === 'recorded' && new Set(e.boundaries.value.map(s => s.stage)).size !== e.boundaries.value.length) throw new Error('Duplicate native boundary stage');
  const install = e.conditions.requirements.state === 'recorded' && e.conditions.requirements.value.install;
  const reused = e.conditions.installation_state.state === 'recorded' && e.conditions.installation_state.value.reused;
  const required = install ? reused ? ['before', 'before_offline_task', 'after'] as const : ['before', 'after_installation', 'before_offline_task', 'after'] as const : ['before', 'after'] as const;
  if (canonical(e.outcomes.task) !== canonical(evaluateTask(e.process, e.assertions)) || canonical(e.outcomes.boundaries) !== canonical(evaluateBoundaries(e.boundaries, [...required]))) throw new Error('Native derived outcomes disagree with facts');
  if (e.observations.records.state === 'recorded') {
    const facts = parseUsage({ schema_version: 1, kind: 'dependency_usage', observer_version: 'native-reader-v1', status: 'incomplete', environment: {},
      inputs: { config_hash: '0'.repeat(64), limits_hash: '0'.repeat(64) }, tasks: [e.observations.records.value] }).tasks[0];
    if (facts.task !== task.key) throw new Error('Native observation references a different task');
    const statuses = facts.capture_status === 'not_run' ? { inventory: 'not_run', modules: 'not_run', compiler: 'not_run', build: 'not_run' } : {
      inventory: facts.inventory ? facts.inventory.complete ? 'captured' : 'incomplete' : 'not_saved', modules: facts.module_capture_status ?? facts.capture_status,
      compiler: facts.compilation?.capture_status ?? 'not_collected', build: facts.bundling?.capture_status ?? 'not_collected' };
    for (const source of ['inventory', 'modules', 'compiler', 'build'] as const) if (e.observations[source].status !== statuses[source]) throw new Error('Native observation capture mismatch: ' + source);
  }
  return freeze(value);
}
