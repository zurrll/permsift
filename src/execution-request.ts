import path from 'node:path';
import { z } from 'zod';
import { aliasSchema, readAliasSchema, domainSchema, contains, scenarioSchema, limitsSchema, isStaged, type Scenario, type Limits } from './config.js';
import type { Fixtures } from './probes.js';
import type { InstallInput } from './install.js';
import { installationKey, type InstalledSnapshot } from './installed-snapshot.js';
import { taskDefinition, undeclaredAgreement } from './model/definitions.js';
import { freeze, recorded, missing, objectId, grantSet } from './model/identity.js';
import type { TaskDefinition, ProtectionAgreement, PolicyPlan } from './model/types.js';

export type ExecutableTask = Pick<Scenario, 'id' | 'command' | 'assertions' | 'timeout_seconds' | 'install' | 'observation' | 'prepare_directories'>;
const policySchema = z.object({
  write: z.array(aliasSchema).max(32), read: z.array(readAliasSchema).max(32), readMode: z.enum(['explicit', 'legacy']),
  network: z.array(domainSchema).max(32), installWrite: z.array(aliasSchema).max(32),
}).strict();
export type ExecutablePolicy = z.infer<typeof policySchema>;
export type Sources = {
  inputDirectories: boolean; installedDirectories: boolean; afterTaskDirectories: boolean;
  readInventory: boolean; dependencies: boolean; installedState: boolean;
};
export type ExecutionConditionsInput = {
  input: { path: string; hash: string }; configHash: string; limitsHash: string;
  scenarioHash: string;
  environment: Record<string, string>; preparation: string[];
  expectedReadKinds?: Record<string, 'file' | 'directory'>;
};
export type ExecutionRequest = {
  task: ExecutableTask; definition: TaskDefinition; agreement: ProtectionAgreement;
  policy: ExecutablePolicy; plan: PolicyPlan; staged: boolean;
  conditions: ExecutionConditionsInput; sources: Sources; limits: Limits;
  workspace: { kind: 'input' } | { kind: 'installed'; snapshot: InstalledSnapshot };
  capture?: { directory: string; key: string };
  budget: { deadline: number; signal?: AbortSignal };
  resources: { scratch: string; protectedPaths: string[]; fixtures: Fixtures; readProbeDirectories: string[]; installInput?: InstallInput };
};

export function executablePlan(key: string, task: ExecutableTask, staged: boolean, policy: ExecutablePolicy, kinds?: Record<string, 'file' | 'directory'>): PolicyPlan {
  const content: Omit<PolicyPlan, 'id'> = { task_key: key, scope: 'producer_variable_grants',
    task: { write: recorded(grantSet(policy.write)), read: recorded({ mode: policy.readMode, grants: grantSet(policy.read),
      target_kinds: policy.read.length === 0 ? recorded({}) : kinds ? recorded(kinds) : missing('not_saved', 'Read target kinds was not retained in this artifact') }), network: recorded([]) },
    installation: task.install ? recorded({ mode: staged ? 'separate' : 'shared', write: grantSet(policy.installWrite), network: recorded(grantSet(policy.network)), reads: 'producer_fixed_workspace_reads' }) : missing('not_declared', 'No installation stage in retained config') };
  return freeze({ id: objectId('policy', content), ...content });
}

/** Only complete, validated values are executable. Historical missing fields cannot be requests. */
export function executionRequest(input: {
  scenario: Scenario; policy: ExecutablePolicy; conditions: ExecutionConditionsInput;
  sources: Sources; limits: Limits; workspace: ExecutionRequest['workspace']; capture?: ExecutionRequest['capture'];
  budget: ExecutionRequest['budget']; resources: ExecutionRequest['resources'];
}): ExecutionRequest {
  const scenario = scenarioSchema.parse(input.scenario), limits = limitsSchema.parse(input.limits), policy = policySchema.parse(input.policy);
  const staged = isStaged(scenario);
  for (const grants of [policy.write, policy.installWrite]) {
    if (new Set(grants).size !== grants.length || grants.some(p => !limits.allowed_write_roots.some(root => contains(root, p)))) throw new Error('Execution write grants exceed trusted limits or contain duplicates');
  }
  if (new Set(policy.read).size !== policy.read.length || policy.readMode === 'explicit' && policy.read.some(p => !limits.allowed_read_roots?.some(root => contains(root, p)))) throw new Error('Execution read grants exceed trusted limits or contain duplicates');
  if (policy.readMode === 'legacy' && (policy.read.length !== 1 || policy.read[0] !== '@workspace')) throw new Error('Legacy execution reads must retain @workspace');
  if (new Set(policy.network).size !== policy.network.length || policy.network.some(p => !limits.allowed_network_domains?.includes(p))) throw new Error('Execution network grants exceed trusted limits or contain duplicates');
  if (!scenario.install && policy.network.length || !staged && input.workspace.kind === 'installed' || input.capture && (!staged || input.workspace.kind === 'installed')) throw new Error('Invalid execution stage request');
  if (scenario.install && !input.resources.installInput) throw new Error('Installation requires inspected frozen inputs');
  if (!staged && policy.readMode === 'explicit' && scenario.install) throw new Error('Shared installation requires legacy reads');
  if (!staged && JSON.stringify(grantSet(policy.write)) !== JSON.stringify(grantSet(policy.installWrite))) throw new Error('Shared installation must use the task write policy');
  z.number().finite().parse(input.budget.deadline);
  const digest = z.string().regex(/^[a-f0-9]{64}$/);
  for (const value of [input.conditions.input.hash, input.conditions.configHash, input.conditions.limitsHash, input.conditions.scenarioHash]) digest.parse(value);
  const conditions = structuredClone(input.conditions);
  conditions.preparation = z.array(aliasSchema).max(2048).parse(conditions.preparation);
  if (conditions.preparation.some(p => !limits.allowed_write_roots.some(root => contains(root, p)))) throw new Error('Execution preparation exceeds trusted write limits');
  if (conditions.expectedReadKinds) z.record(readAliasSchema, z.enum(['file', 'directory'])).parse(conditions.expectedReadKinds);
  if (input.capture || input.workspace.kind === 'installed') {
    const key = installationKey({ snapshot: conditions.input.hash, environment: conditions.environment,
      installation: { id: scenario.id, ...input.resources.installInput, config: scenario.install },
      policy: { write: policy.installWrite, network: policy.network }, preparation: conditions.preparation, limits });
    if (input.capture && input.capture.key !== key || input.workspace.kind === 'installed' && input.workspace.snapshot.key !== key) throw new Error('Installed snapshot does not match execution input, policy, preparation and limits');
  }
  for (const location of [conditions.input.path, input.resources.scratch, ...input.resources.protectedPaths, ...input.capture ? [input.capture.directory] : []]) if (!path.isAbsolute(location)) throw new Error('Execution resources require absolute paths');
  const task: ExecutableTask = { id: scenario.id, command: scenario.command, assertions: scenario.assertions, timeout_seconds: scenario.timeout_seconds, prepare_directories: scenario.prepare_directories,
    ...scenario.install ? { install: scenario.install } : {}, ...scenario.observation ? { observation: scenario.observation } : {} };
  const definition = freeze(taskDefinition(scenario.id, scenario));
  const agreement = freeze(undeclaredAgreement(scenario.id));
  const sources = z.object({ inputDirectories: z.boolean(), installedDirectories: z.boolean(), afterTaskDirectories: z.boolean(), readInventory: z.boolean(), dependencies: z.boolean(), installedState: z.boolean() }).strict().parse(input.sources);
  return { task: freeze(task), definition, agreement, policy: freeze(policy), plan: executablePlan(task.id, task, staged, policy),
    staged, conditions: freeze(conditions), limits: freeze(limits), sources: freeze(sources),
    workspace: freeze(structuredClone(input.workspace)), capture: input.capture && freeze({ ...input.capture }), budget: { ...input.budget },
    resources: freeze(structuredClone(input.resources)) };
}
