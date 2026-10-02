import type { ExecutionRequest } from '../execution-request.js';
import { executablePlan } from '../execution-request.js';
import type { ExecutionResult } from '../execute-once.js';
import { parseUsage } from '../usage-report.js';
import { evaluateTask, evaluateBoundaries } from './conclusions.js';
import { freeze, missing, recorded, objectId } from './identity.js';
import type { TaskDefinition, ProtectionAgreement, PolicyPlan, ExecutionEvidence, ObservationFacts, BoundaryStage } from './types.js';

/** Additive artifact; native facts are constructed at execution, never re-imported from a report. */
export type NativeExecution = {
  schema_version: 1; kind: 'permsift_execution'; model_version: 1; identity_version: 1;
  task: TaskDefinition; agreement: ProtectionAgreement; policy: PolicyPlan; execution: ExecutionEvidence;
};

export function nativeExecution(request: ExecutionRequest, result: ExecutionResult, origin: ExecutionEvidence['origin']): NativeExecution {
  const e = result.details, selected = request.sources.dependencies;
  const capture = (status: ObservationFacts['modules']['status'], scope: string, issues: string[] = []) => ({ status, scope, issues });
  let observations: ObservationFacts;
  if (result.observation) {
    const facts = parseUsage({ schema_version: 1, kind: 'dependency_usage', observer_version: 'native-execution-v1', status: 'incomplete',
      environment: request.conditions.environment, inputs: { snapshot_hash: request.conditions.input.hash, config_hash: request.conditions.configHash, limits_hash: request.conditions.limitsHash }, tasks: [result.observation] }).tasks[0];
    const task = result.observation;
    observations = { inventory: capture(task.inventory.complete ? 'captured' : 'incomplete', 'Installed package instances', task.inventory.issues),
      modules: capture(task.capture_status, 'Node module hook coverage', [...task.issues, ...task.coverage_gaps]),
      compiler: task.compilation ? capture(task.compilation.capture_status, 'TypeScript inputs', task.compilation.issues) : capture(request.task.observation?.typescript ? 'not_run' : 'not_collected', 'TypeScript inputs'),
      build: task.bundling ? capture(task.bundling.capture_status, 'esbuild metadata', task.bundling.issues) : capture(request.task.observation?.esbuild ? 'not_run' : 'not_collected', 'esbuild metadata'), records: recorded(facts) };
  } else {
    const status = selected ? 'not_run' : 'not_collected';
    observations = { inventory: capture(status, 'Installed package instances'), modules: capture(status, 'Node module hooks'), compiler: capture(status, 'TypeScript inputs'), build: capture(status, 'esbuild metadata'),
      records: selected ? missing('not_run', 'Instrumented task was not reached') : missing('not_declared', 'Dependency observation was not selected') };
  }
  const process = e.task ? recorded({ status: e.task.process.status, exit_code: e.task.process.exit_code }) : missing(result.actualCommand ? 'not_saved' : 'not_run', e.task_skipped ?? result.reason ?? 'Task process was not reached');
  const assertions = e.assertions ? recorded(e.assertions) : missing('not_run', 'Success checks were not reached');
  const stages = ['before', 'after_installation', 'before_offline_task', 'after'] as const;
  const boundaries = recorded<BoundaryStage[]>(stages.flatMap(stage => e[stage] ? [{ stage, checks: e[stage]!.checks }] : []));
  const policy = executablePlan(request.task.id, request.task, request.staged, request.policy, e.read_grant_kinds);
  const content: Omit<ExecutionEvidence, 'id'> = {
    task_id: request.definition.id, agreement_id: request.agreement.id, policy_id: recorded(policy.id), origin,
    reported_verdict: recorded(result.verdict), process, assertions, boundaries,
    installation: e.installation ? recorded({ command: e.installation.command, process: { status: e.installation.execution.process.status, exit_code: e.installation.execution.process.exit_code }, reported_verdict: e.installation.verdict, reused: recorded(false) }) :
      missing(result.installationReused || request.task.install ? 'not_run' : 'not_declared', result.installationReused ? 'Reused a verified installation snapshot; no installer process ran' : 'No installer process ran'),
    observations,
    conditions: { input_hash: recorded(request.conditions.input.hash), config_hash: recorded(request.conditions.configHash), limits_hash: recorded(request.conditions.limitsHash),
      environment: recorded(request.conditions.environment), preparation: recorded(request.conditions.preparation),
      requirements: recorded({ timeout_seconds: request.task.timeout_seconds, install: request.task.install ? { manager: request.task.install.manager, cache: request.task.install.cache, cache_seed: request.task.install.cache_seed ?? null, registry: request.task.install.registry } : null }),
      producer_scenario_hash: recorded(request.conditions.scenarioHash), actual_command: result.actualCommand ? recorded(result.actualCommand) : missing('not_run', 'Task command was not issued'),
      instrumentation: recorded({ selected_sources: request.sources, observer: e.observer ?? null }),
      installation_state: recorded({ reused: result.installationReused, snapshot: e.installed_snapshot ? recorded({ key: e.installed_snapshot.key, hashes: e.installed_snapshot.hashes, source_trial: e.installed_snapshot.source_trial }) : missing('not_declared', 'No installed snapshot reuse selected') }),
      producer_policy_hash: e.task_policy_hash ?? e.policy_hash ? recorded((e.task_policy_hash ?? e.policy_hash)!) : missing('not_run', 'Policy preparation was not reached') },
    outcomes: { task: evaluateTask(process, assertions), boundaries: evaluateBoundaries(boundaries, request.task.install ? result.installationReused ? ['before', 'before_offline_task', 'after'] : ['before', 'after_installation', 'before_offline_task', 'after'] : ['before', 'after']) },
  };
  return freeze({ schema_version: 1, kind: 'permsift_execution', model_version: 1, identity_version: 1,
    task: request.definition, agreement: request.agreement, policy, execution: { id: objectId('execution', content), ...content } });
}
