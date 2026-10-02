import { z } from 'zod';
import { configSchema, limitsSchema, aliasSchema, readAliasSchema, domainSchema, isStaged, type Config, type Scenario } from '../config.js';
import { parseUsage, type Comparable } from '../usage-report.js';
import { evaluateTask, evaluateBoundaries } from './conclusions.js';
import { recorded, missing, objectId, grantSet, semanticHash, legacyHash, canonical, finishModel } from './identity.js';
import type { Model, Saved, TaskDefinition, ProtectionAgreement, PolicyPlan, ExecutionEvidence, ExecutionConditions, ObservationFacts, BoundaryStage, Verdict } from './types.js';

const text = z.string().min(1).max(8192), digest = z.string().regex(/^[a-f0-9]{64}$/);
const verdict = z.enum(['pass', 'fail', 'unknown']);
const writes = z.array(aliasSchema).max(2048), reads = z.array(readAliasSchema).max(2048), domains = z.array(domainSchema).max(64);
const readMode = z.enum(['explicit', 'legacy']);
const check = z.object({ name: text, status: verdict, detail: z.string().max(16384) });
const checks = z.array(check).max(4096);
const processFact = z.object({ status: text, exit_code: z.number().int().nullable() });
const inputHashes = z.object({ snapshot_hash: digest.optional(), config_hash: digest, limits_hash: digest });
const trialSchema = z.object({ id: text, scenario: text, phase: text, grants: writes, read_grants: reads,
  read_mode: readMode, network_grants: domains.optional(), install_grants: writes.optional(),
  installation_reused: z.boolean().optional(), verdict, evidence: text });
const search = z.object({ stop: text, steps: z.array(z.object({ decision: text })).max(10000) });
const experimentSchema = z.object({ schema_version: z.literal(1), id: text, mode: z.enum(['run', 'tighten', 'doctor', 'observe']),
  status: z.enum(['running', 'verified', 'failed', 'incomplete']), environment: z.record(z.string()), inputs: inputHashes,
  trials: z.array(trialSchema).max(50000), policies: z.record(writes), read_policies: z.record(reads), read_modes: z.record(readMode),
  network_policies: z.record(domains).optional(), install_policies: z.record(writes).optional(),
  baseline_verified: z.boolean(), final_verified: z.boolean(), search_complete: z.boolean(),
  searches: z.record(search).optional(), read_searches: z.record(search).optional(),
  network_searches: z.record(search).optional(), install_searches: z.record(search).optional(),
  dependency_observations: z.record(z.unknown()).optional() });
const observerSchema = z.object({ source: text, bootstrap_hash: digest,
  internal_write_exception: text, instrumentation_applies_to: text,
  compilation: z.object({ source: text, output: text, executed_command: z.array(text).min(1) }).optional(),
  bundling: z.object({ source: text, bundler: text, metafile: text, output_root: text,
    output_directory_cleared: z.boolean(), executed_command: z.array(text).min(1) }).optional() });
// The top-level trial copy is created before execution; summary is the producer's finalized copy.
const evidenceSchema = trialSchema.omit({ verdict: true, evidence: true }).extend({ verdict: verdict.optional(), evidence: text.optional(),
  summary: trialSchema.optional(), prepared_directories: writes.optional(), policy_hash: digest.optional(),
  task_policy_hash: digest.optional(), stage_policy_mode: z.enum(['shared', 'separate']).optional(),
  read_grant_kinds: z.record(z.enum(['file', 'directory'])).optional(),
  installed_snapshot: z.object({ key: digest, hashes: z.record(digest), source_trial: text }).optional(),
  observer: observerSchema.optional(),
  before: z.object({ checks }).optional(), after_installation: z.object({ checks }).optional(),
  before_offline_task: z.object({ checks }).optional(), after: z.object({ checks }).optional(),
  task: z.object({ process: processFact, command: z.array(text).min(1).optional() }).optional(),
  task_skipped: text.optional(), assertions: checks.optional(),
  installation: z.object({ command: z.array(text).min(1), execution: z.object({ process: processFact }), verdict }).optional() });
const regressionSchema = z.object({ schema_version: z.literal(1), kind: z.literal('regression'), id: text,
  status: z.enum(['running', 'compatible', 'regressed', 'inconclusive']), baseline: text,
  environment: z.record(z.string()), inputs: inputHashes,
  tasks: z.array(z.object({ id: text, status: z.enum(['pending', 'compatible', 'permission_change', 'unresolved_failure', 'inconclusive']),
    task_definition_changed: z.boolean(), repair_stop: text.optional(),
    stages: z.array(z.object({ phase: text, verdict, report: text, trials: z.number().int().nonnegative(), prepared_directories: writes })).max(10000),
    suggestion: z.object({ write: writes, read: reads.optional(), network: domains.optional(), install_write: writes.optional(), verified: z.literal(true) }).optional(),
  })).max(16) });
const inputsSchema = z.object({ config: z.unknown(), limits: z.unknown().optional() });

/** Companion objects are supplied explicitly. No producer path triggers a filesystem read. */
export type LegacyCompanions = { inputs?: unknown; evidence?: Record<string, unknown> };
type Hashes = z.infer<typeof inputHashes>;
type Evidence = z.infer<typeof evidenceSchema>;
type Trial = z.infer<typeof trialSchema>;
const absent = <T>(name: string): Saved<T> => missing('not_saved', name + ' was not retained in this artifact');
const saved = <T>(value: T | undefined, name: string): Saved<T> => value === undefined ? absent(name) : recorded(value);
const equalSet = (a: string[], b: string[]) => canonical(grantSet(a)) === canonical(grantSet(b));

export { taskDefinition } from './definitions.js';
import { taskDefinition, undeclaredAgreement as agreement } from './definitions.js';
function context(raw: unknown, hashes: Hashes) {
  if (raw === undefined) return undefined;
  const input = inputsSchema.parse(raw);
  // Validate raw historical bytes-as-JSON semantics before current schemas add defaults.
  if (legacyHash(input.config) !== hashes.config_hash) throw new Error('Retained config does not match recorded config_hash');
  if (input.limits !== undefined && legacyHash(input.limits) !== hashes.limits_hash) throw new Error('Retained limits do not match recorded limits_hash');
  const config = configSchema.parse(input.config);
  if (input.limits !== undefined) limitsSchema.parse(input.limits);
  if (new Set(config.scenarios.map(s => s.id)).size !== config.scenarios.length) throw new Error('Duplicate retained task keys');
  return { config, rawConfig: input.config as { scenarios: unknown[] } };
}
function start(format: Model['source']['format'], raw: unknown, hashes: Hashes, environment: Record<string, string>, kind: Model['workflow']['kind'], status: string, companions: LegacyCompanions) {
  const ctx = context(companions.inputs, hashes);
  const model: Model = { model_version: 1, identity_version: 1,
    source: { format, artifact_hash: semanticHash(raw), producer_version: saved(environment.permsift, 'Producer version'), environment: recorded(environment),
      recorded_hashes: { config: recorded(hashes.config_hash), limits: recorded(hashes.limits_hash), input: saved(hashes.snapshot_hash, 'Input hash') },
      inputs_status: ctx ? 'matched' : 'not_saved', evidence_records: [] },
    tasks: [], agreements: [], policies: [], executions: [], baselines: [],
    workflow: { kind, reported_status: status, verification: absent('Verification flags'), search_complete: absent('Search completion'),
      current_policies: [], searches: [], comparisons: [], review_reasons: [] } };
  return { model, ctx };
}
function addTask(model: Model, key: string, config?: Config, fingerprint?: string) {
  const scenario = config?.scenarios.find(s => s.id === key);
  if (config && !scenario) throw new Error('Report task is absent from retained config: ' + key);
  const task = taskDefinition(key, scenario, fingerprint), protection = agreement(key);
  model.tasks.push(task); model.agreements.push(protection);
  return { task, protection, scenario };
}
function policy(model: Model, key: string, scenario: Scenario | undefined, write: string[], read: string[] | undefined,
    mode: 'explicit' | 'legacy' | undefined, network: string[] | undefined, installWrite?: string[], e?: Evidence) {
  if (mode === 'legacy' && read && !equalSet(read, ['@workspace'])) throw new Error('Legacy read policy must retain @workspace');
  if (e?.read_grant_kinds && read && !equalSet(Object.keys(e.read_grant_kinds), read)) throw new Error('Read target kinds do not match read grants');
  const content: Omit<PolicyPlan, 'id'> = { task_key: key, scope: 'producer_variable_grants',
    task: { write: recorded(grantSet(write)), read: mode && read ? recorded({ mode, grants: grantSet(read),
      target_kinds: read.length === 0 ? recorded({}) : saved(e?.read_grant_kinds, 'Read target kinds') }) : absent('Task read grants/mode'),
      network: recorded([]) },
    installation: scenario ? scenario.install ? recorded({ mode: isStaged(scenario) ? 'separate' : 'shared',
      write: grantSet(installWrite ?? write), network: saved(network?.slice().sort(), 'Installer network grants'), reads: 'producer_fixed_workspace_reads' }) :
      missing('not_declared', 'No installation stage in retained config') : e?.stage_policy_mode === 'separate' && installWrite ?
      recorded({ mode: 'separate', write: grantSet(installWrite), network: saved(network?.slice().sort(), 'Installer network grants'), reads: 'producer_fixed_workspace_reads' }) : absent('Installation stage configuration') };
  if (scenario && isStaged(scenario) && !installWrite) throw new Error('Separate installation policy lacks install grants');
  const result: PolicyPlan = { id: objectId('policy', content), ...content };
  if (!model.policies.some(p => p.id === result.id)) model.policies.push(result);
  return result.id;
}
function observation(task?: Comparable['tasks'][number], missingStatus: 'not_saved' | 'not_collected' = 'not_saved', scenario?: Scenario): ObservationFacts {
  const capture = (status: ObservationFacts['modules']['status'], scope: string, issues: string[] = []) => ({ status, scope, issues });
  if (!task || task.capture_status === 'not_run') {
    const status = task ? 'not_run' : missingStatus;
    return { inventory: capture(status, 'Installed package instances'), modules: capture(status, 'Node module hook'),
      compiler: capture(status, 'TypeScript inputs'), build: capture(status, 'esbuild metadata'), records: task ? recorded(task) :
        missingStatus === 'not_collected' ? missing('not_declared', 'Producer workflow did not select dependency observation') : absent('Observation records') };
  }
  return { inventory: task.inventory ? capture(task.inventory.complete ? 'captured' : 'incomplete', 'Installed package instances', task.inventory.issues) : capture('not_saved', 'Installed package instances'),
    modules: capture(task.capture_status, 'Producer Node module hook coverage only', [...task.issues ?? [], ...task.coverage_gaps ?? []]),
    compiler: task.compilation ? capture(task.compilation.capture_status, 'TypeScript inputs', task.compilation.issues) : capture(scenario?.observation?.typescript ? 'not_saved' : 'not_collected', 'TypeScript inputs'),
    build: task.bundling ? capture(task.bundling.capture_status, 'esbuild metadata', task.bundling.issues) : capture(scenario?.observation?.esbuild ? 'not_saved' : 'not_collected', 'esbuild metadata'), records: recorded(task) };
}
function conditions(hashes: Hashes, environment: Record<string, string>, scenario?: Scenario, fingerprint?: string, e?: Evidence): ExecutionConditions {
  return { input_hash: saved(hashes.snapshot_hash, 'Input hash'), config_hash: recorded(hashes.config_hash), limits_hash: recorded(hashes.limits_hash),
    environment: recorded(environment), preparation: saved(e?.prepared_directories?.slice().sort(), 'Preparation directories'),
    requirements: scenario ? recorded({ timeout_seconds: scenario.timeout_seconds, install: scenario.install ? {
      manager: scenario.install.manager, cache: scenario.install.cache, cache_seed: scenario.install.cache_seed ?? null, registry: scenario.install.registry,
    } : null }) : absent('Timeout and installation requirements'),
    producer_scenario_hash: saved(fingerprint, 'Producer scenario fingerprint'),
    actual_command: saved(e?.task?.command ?? e?.observer?.compilation?.executed_command ?? e?.observer?.bundling?.executed_command, 'Actual executed command'),
    instrumentation: e?.observer ? recorded({ producer_observer: e.observer }) : scenario ? recorded({ declared_sources: scenario.observation ?? null }) : absent('Collector configuration'),
    installation_state: e?.installation_reused !== undefined ? recorded({ reused: e.installation_reused,
      snapshot: saved(e.installed_snapshot, 'Installed snapshot reuse reference') }) : absent('Installation reuse conditions'),
    producer_policy_hash: saved(e?.task_policy_hash ?? e?.policy_hash, 'Producer policy fingerprint') };
}
function execution(model: Model, producerId: string, record: string, phase: string, task: TaskDefinition, protection: ProtectionAgreement,
    policyId: Saved<string>, hashes: Hashes, environment: Record<string, string>, scenario?: Scenario, reported?: Verdict, e?: Evidence, observed?: Comparable['tasks'][number], fingerprint?: string) {
  const skipped = e?.task_skipped ?? (observed?.capture_status === 'not_run' ? observed.reason : undefined);
  if (e?.task && skipped) throw new Error('Evidence contains both executed and skipped task');
  const process = skipped ? missing('not_run', skipped) : saved(e?.task?.process, 'Task process');
  const assertions = saved(e?.assertions, 'Task success checks');
  const stages = ['before', 'after_installation', 'before_offline_task', 'after'] as const;
  const boundaryRecords: BoundaryStage[] = stages.flatMap(stage => e?.[stage] ? [{ stage, checks: e[stage]!.checks }] : []);
  const boundaries = e ? recorded(boundaryRecords) : absent<BoundaryStage[]>('Boundary checks');
  const content: Omit<ExecutionEvidence, 'id'> = { task_id: task.id, agreement_id: protection.id, policy_id: policyId,
    origin: { producer_id: producerId, record, phase }, reported_verdict: saved(reported, 'Composite producer verdict'), process, assertions, boundaries,
    installation: e?.installation ? recorded({ command: e.installation.command, process: e.installation.execution.process,
      reported_verdict: e.installation.verdict, reused: saved(e.installation_reused, 'Installation reuse flag') }) :
      e?.installation_reused ? missing('not_run', 'Installation was reused from the producer snapshot; no installation process ran in this trial') :
      scenario && !scenario.install ? missing('not_declared', 'No installation stage') : absent('Installation execution'),
    observations: observation(observed, model.workflow.kind === 'observe' ? 'not_saved' : 'not_collected', scenario), conditions: conditions(hashes, environment, scenario, fingerprint, e),
    outcomes: { task: evaluateTask(process, assertions), boundaries: evaluateBoundaries(boundaries,
      scenario?.install ? e?.installation_reused ? ['before', 'before_offline_task', 'after'] : ['before', 'after_installation', 'before_offline_task', 'after'] : ['before', 'after']) } };
  model.executions.push({ id: objectId('execution', content), ...content });
}
function validateEvidence(trial: Trial, raw: unknown): Evidence {
  const e = evidenceSchema.parse(raw);
  for (const key of ['id', 'scenario', 'phase', 'read_mode', 'installation_reused'] as const) {
    if (trial[key] !== e[key]) throw new Error('Trial/evidence mismatch: ' + key);
  }
  for (const key of ['grants', 'read_grants', 'network_grants', 'install_grants'] as const) {
    if ((trial[key] === undefined) !== (e[key] === undefined) || !equalSet(trial[key] ?? [], e[key] ?? [])) throw new Error('Trial/evidence mismatch: ' + key);
  }
  if (e.evidence !== undefined && e.evidence !== trial.evidence) throw new Error('Trial/evidence mismatch: evidence');
  const final = e.summary ?? e;
  if (final.verdict !== undefined && final.verdict !== trial.verdict) throw new Error('Finalized trial/evidence mismatch: verdict');
  if (e.summary) {
    for (const key of ['id', 'scenario', 'phase', 'read_mode', 'evidence', 'installation_reused'] as const) {
      if (e.summary[key] !== trial[key]) throw new Error('Finalized trial/evidence mismatch: ' + key);
    }
    for (const key of ['grants', 'read_grants', 'network_grants', 'install_grants'] as const) {
      if ((trial[key] === undefined) !== (e.summary[key] === undefined) || !equalSet(trial[key] ?? [], e.summary[key] ?? [])) throw new Error('Finalized trial/evidence mismatch: ' + key);
    }
  }
  return e;
}

export function adaptExperiment(raw: unknown, companions: LegacyCompanions = {}): Model {
  const report = experimentSchema.parse(raw), { model, ctx } = start('experiment-v1', raw, report.inputs, report.environment, report.mode, report.status, companions);
  const keys = Object.keys(report.policies).sort();
  for (const map of [report.read_modes, report.read_policies, ...report.network_policies ? [report.network_policies] : []]) {
    if (!equalSet(Object.keys(map), keys)) throw new Error('Experiment policy task keys disagree');
  }
  if (ctx && !equalSet(ctx.config.scenarios.map(s => s.id), keys)) throw new Error('Experiment and retained config task keys disagree');
  if (new Set(report.trials.map(t => t.id)).size !== report.trials.length) throw new Error('Duplicate trial ID');
  const trials = new Map(report.trials.map(t => [t.evidence, t]));
  if (trials.size !== report.trials.length) throw new Error('Duplicate trial evidence reference');
  const evidence = new Map<string, Evidence>();
  for (const [file, value] of Object.entries(companions.evidence ?? {})) {
    const trial = trials.get(file);
    if (!trial) throw new Error('Evidence is not referenced by this experiment');
    const e = validateEvidence(trial, value); evidence.set(file, e);
    model.source.evidence_records.push({ path: file, artifact_hash: semanticHash(value) });
  }
  const observed = new Map<string, { facts: Comparable['tasks'][number]; fingerprint: string }>();
  if (report.dependency_observations) {
    if (report.mode !== 'observe') throw new Error('Dependency observations require an observe producer workflow');
    const values = Object.values(report.dependency_observations);
    const usage = parseUsage({ schema_version: 1, kind: 'dependency_usage', observer_version: 'legacy-experiment',
      status: 'incomplete', environment: report.environment, inputs: report.inputs, tasks: values });
    for (const [key, value] of Object.entries(report.dependency_observations)) {
      const link = z.object({ task: text, trial: text, task_definition_hash: digest }).parse(value);
      const facts = usage.tasks.find(t => t.task === key), trial = report.trials.find(t => t.id === link.trial);
      if (link.task !== key || !facts || facts.capture_status === 'not_run' || !trial || trial.scenario !== key || trial.verdict !== facts.verdict) throw new Error('Observation references a different or missing task/trial');
      if (ctx) {
        const original = ctx.rawConfig.scenarios.find(s => (s as { id?: string }).id === key);
        if (!original || legacyHash(original) !== link.task_definition_hash) throw new Error('Observation scenario fingerprint does not match retained config');
      }
      observed.set(link.trial, { facts, fingerprint: link.task_definition_hash });
    }
  }
  for (const key of keys) {
    const { task, protection, scenario } = addTask(model, key, ctx?.config);
    const matching = [...report.trials].reverse().find(t => t.scenario === key && equalSet(t.grants, report.policies[key]) &&
      equalSet(t.read_grants, report.read_policies[key]) && t.read_mode === report.read_modes[key] &&
      equalSet(t.network_grants ?? [], report.network_policies?.[key] ?? []) && equalSet(t.install_grants ?? [], report.install_policies?.[key] ?? []));
    const current = policy(model, key, scenario, report.policies[key], report.read_policies[key], report.read_modes[key],
      report.network_policies?.[key], report.install_policies?.[key], matching ? evidence.get(matching.evidence) : undefined);
    model.workflow.current_policies.push({ task_key: key, policy_id: current });
    for (const trial of report.trials.filter(t => t.scenario === key)) {
      const e = evidence.get(trial.evidence);
      if (scenario && e?.stage_policy_mode && e.stage_policy_mode !== (isStaged(scenario) ? 'separate' : 'shared')) throw new Error('Evidence installation mode disagrees with retained config');
      const id = policy(model, key, scenario, trial.grants, trial.read_grants, trial.read_mode, trial.network_grants, trial.install_grants, e);
      const capture = observed.get(trial.id);
      execution(model, report.id, trial.evidence, trial.phase, task, protection, recorded(id), report.inputs, report.environment, scenario, trial.verdict, e, capture?.facts, capture?.fingerprint);
    }
  }
  if (report.trials.some(t => !keys.includes(t.scenario))) throw new Error('Trial references a missing task');
  model.workflow.verification = recorded({ baseline_verified: report.baseline_verified, final_verified: report.final_verified });
  model.workflow.search_complete = recorded(report.search_complete);
  for (const [permission, searches] of Object.entries({ write: report.searches, read: report.read_searches, network: report.network_searches, install_write: report.install_searches })) {
    for (const [key, item] of Object.entries(searches ?? {})) {
      if (!keys.includes(key)) throw new Error('Search references a missing task');
      model.workflow.searches.push({ task_key: key, permission, stop: item.stop, decisions: item.steps.map(s => s.decision) });
      if (!['exhausted', 'fixed_point'].includes(item.stop)) model.workflow.review_reasons.push(key + ': ' + permission + ' search stopped: ' + item.stop);
    }
  }
  return finishModel(model);
}

export function adaptUsage(raw: unknown, companions: LegacyCompanions = {}): Model {
  if (Object.keys(companions.evidence ?? {}).length) throw new Error('Usage summaries do not link execution sidecars; adapt the experiment separately');
  const report = parseUsage(raw), { model, ctx } = start('usage-v1', raw, report.inputs, report.environment, 'observe', report.status, companions);
  for (const item of report.tasks) {
    const fingerprint = item.capture_status === 'not_run' ? undefined : item.task_definition_hash;
    const { task, protection, scenario } = addTask(model, item.task, ctx?.config, fingerprint);
    if (fingerprint && ctx) {
      const original = ctx.rawConfig.scenarios.find(s => (s as { id?: string }).id === item.task);
      if (legacyHash(original) !== fingerprint) throw new Error('Retained scenario does not match opaque producer task_definition_hash');
    }
    execution(model, 'usage:' + model.source.artifact_hash, 'task:' + item.task, 'observe', task, protection, absent('Policy grants in usage summary'),
      report.inputs, report.environment, scenario, item.capture_status === 'not_run' ? undefined : item.verdict, undefined, item, fingerprint);
  }
  return finishModel(model);
}

export function adaptRegression(raw: unknown, companions: LegacyCompanions = {}): Model {
  if (Object.keys(companions.evidence ?? {}).length) throw new Error('Regression stage references are aggregates; adapt child experiments separately');
  const report = regressionSchema.parse(raw), { model, ctx } = start('regression-v1', raw, report.inputs, report.environment, 'check', report.status, companions);
  if (new Set(report.tasks.map(t => t.id)).size !== report.tasks.length) throw new Error('Duplicate regression task key');
  for (const item of report.tasks) {
    const { scenario } = addTask(model, item.id, ctx?.config);
    const suggestion = item.suggestion ? policy(model, item.id, scenario, item.suggestion.write, item.suggestion.read,
      scenario ? scenario.initial_read_grants === undefined ? 'legacy' : 'explicit' : undefined, item.suggestion.network, item.suggestion.install_write) : undefined;
    model.workflow.comparisons.push({ task_key: item.id, reported_status: item.status,
      definition_changed: recorded(item.task_definition_changed), stages: item.stages.map(s => ({ phase: s.phase, reported_verdict: s.verdict,
        report: s.report, trials: s.trials, preparation: grantSet(s.prepared_directories) })), suggestion_policy: saved(suggestion, 'Suggested policy'),
      suggestion_verified: saved(item.suggestion?.verified, 'Suggestion verification') });
    // Stage.verdict summarizes an experiment, so it must never be rewritten as a single task execution.
    if (item.task_definition_changed) model.workflow.review_reasons.push(item.id + ': producer reports command, assertions, timeout or installation definition changed');
    if (item.status !== 'compatible') model.workflow.review_reasons.push(item.id + ': ' + item.status + (item.repair_stop ? ' (' + item.repair_stop + ')' : ''));
    if (suggestion) model.workflow.review_reasons.push(item.id + ': verified suggestion requires adoption review');
  }
  const baseline = { selection: 'comparison_reference' as const, producer_reference: report.baseline,
    adoption: 'not_recorded' as const, resolution: 'not_loaded' as const, task_ids: model.tasks.map(t => t.id) };
  model.baselines.push({ id: objectId('baseline', baseline), ...baseline });
  return finishModel(model);
}

export function adaptLegacy(raw: unknown, companions: LegacyCompanions = {}): Model {
  const kind = z.object({ kind: z.string().optional() }).parse(raw).kind;
  return kind === 'dependency_usage' ? adaptUsage(raw, companions) : kind === 'regression' ? adaptRegression(raw, companions) : adaptExperiment(raw, companions);
}
