import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { adaptLegacy } from './model/legacy.js';
import { readLegacyJson } from './model/io.js';
import { parseNativeExecution } from './model/native-reader.js';
import type { NativeExecution } from './model/native.js';
import type { ExecutionEvidence, Model, PolicyPlan, ProtectionAgreement, Saved } from './model/types.js';
import { canonical, freeze, semanticHash } from './model/identity.js';
import { parseUsage, type Comparable } from './usage-report.js';
import { readAliasSchema } from './config.js';
import type { AdoptionRecord } from './adoption.js';

const text = z.string().min(1).max(16384), count = z.number().int().nonnegative();
const ref = z.object({ path: readAliasSchema, name: text, version: text });
const versionChange = z.object({ path: readAliasSchema, name: text, before: text, after: text });
const list = <T extends z.ZodTypeAny>(schema: T) => z.array(schema).max(10000);
const changes = { added: list(ref), removed: list(ref), version_changes: list(versionChange) };
const comparisonSchema = z.object({ baseline: text, conditions: z.object({ input_changed: z.boolean(), config_changed: z.boolean(), limits_changed: z.boolean(), environment_changed: list(text), observer_changed: z.boolean() }),
  tasks: z.array(z.object({ task: text, state: z.enum(['compared', 'added_task', 'removed_task', 'unavailable']), warnings: list(text), ...changes,
    compilation: z.object({ state: z.enum(['compared', 'unavailable']), warnings: list(text), ...changes,
      added_files: list(readAliasSchema), removed_files: list(readAliasSchema), explanation_changes: list(z.object({ path: readAliasSchema, before: list(text), after: list(text) })) }).optional(),
    bundling: z.object({ state: z.enum(['compared', 'unavailable']), warnings: list(text), ...changes,
      contribution_changes: list(z.object({ path: readAliasSchema, name: text, output: readAliasSchema, before_bytes: count.nullable(), after_bytes: count.nullable() })),
      external_changes: list(z.object({ output: readAliasSchema, path: text, kind: text, state: z.enum(['added', 'removed']) })),
      added_inputs: list(readAliasSchema), removed_inputs: list(readAliasSchema), added_outputs: list(readAliasSchema), removed_outputs: list(readAliasSchema),
      changed_outputs: list(z.object({ path: readAliasSchema, before_bytes: count, after_bytes: count, imports_changed: z.boolean(), entry_changed: z.boolean() })),
      chain_changes: list(z.object({ path: readAliasSchema, before: list(readAliasSchema), after: list(readAliasSchema) })) }).optional(),
  })).max(32) });
export type SavedComparison = z.infer<typeof comparisonSchema>;
const comparisonInput = z.object({ file: text, status: z.enum(['observed', 'failed', 'incomplete']), tasks: z.array(z.object({ task: text, verdict: z.enum(['pass', 'fail', 'unknown']).optional(),
  module_capture: text, compiler_capture: text, build_capture: text })).max(16) });
const offlineComparisonSchema = z.object({ schema_version: z.literal(1), kind: z.literal('dependency_usage_comparison'), status: z.enum(['compared', 'partial']),
  before: comparisonInput, after: comparisonInput, comparison: comparisonSchema });
export type ExecutionView = { task: string; reference: string; facts: ExecutionEvidence; native: boolean; policy?: PolicyPlan; agreement?: ProtectionAgreement };
export type ResultRecord = { file: string; artifact_hash: string; model?: Model; native?: NativeExecution; usage?: Comparable; comparison?: SavedComparison;
  context?: { project?: string; input_changed?: boolean; terms_changed?: boolean; error?: string; limits_changed?: boolean; environment_changed?: string[] };
  adoption?: AdoptionRecord;
  comparisonOnly?: { status: 'compared' | 'partial'; before: z.infer<typeof comparisonInput>; after: z.infer<typeof comparisonInput> };
  discovery?: { task: string; dimension: string; enabled?: boolean; truncated?: boolean; rules?: number; limitations: string[] }[];
  cost?: { trials: number; installations?: Record<string, { executed: number; reused: number; snapshots: number }>; duration_ms?: number; protections?: { duration_ms: number; calls: number } };
  executions: ExecutionView[]; children: { task: string; phase: string; reference: string; result?: ResultRecord }[];
  executionReport?: ResultRecord; gaps: string[] };

const indexSchema = z.object({ schema_version: z.literal(1), kind: z.literal('permsift_execution_index'), entries: z.array(z.object({
  trial: text, facts: text, evidence: text, execution_id: z.string().regex(/^execution:v1:[a-f0-9]{64}$/),
})).max(50000) });
const header = z.object({ kind: z.string().optional() });
/** The freshly computed compare command and saved comparison reader use the same validated projection. */
export function comparisonRecord(file: string, raw: unknown): ResultRecord {
  const c = offlineComparisonSchema.parse(raw);
  for (const keys of [c.comparison.tasks.map(t => t.task), c.before.tasks.map(t => t.task), c.after.tasks.map(t => t.task)]) if (new Set(keys).size !== keys.length) throw new Error('Duplicate comparison task');
  return { file, artifact_hash: semanticHash(raw), comparison: c.comparison, comparisonOnly: { status: c.status, before: c.before, after: c.after }, executions: [], children: [], gaps: [] };
}
const sameKnown = (a: Saved<unknown>, b: Saved<unknown>, label: string) => {
  if (a.state === 'recorded' && b.state === 'recorded' && canonical(a.value) !== canonical(b.value)) throw new Error('Native/report mismatch: ' + label);
};

/** Only conventional companions inside the selected result directory are read. No project/baseline paths are followed. */
export async function readResult(selected: string, options: { verificationOnly?: boolean } = {}): Promise<ResultRecord> {
  let file = path.resolve(selected);
  const stat = await lstat(file);
  if (stat.isSymbolicLink()) throw new Error('Result selection must not be a symbolic link');
  if (stat.isDirectory()) {
    const directory = file; let found = false;
    for (const name of ['baseline.json', 'current.json', 'usage.json', 'report.json', 'comparison.json']) {
      try { await lstat(path.join(directory, name)); file = path.join(directory, name); found = true; break; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    if (!found) throw new Error('Result directory has no usage.json, report.json or comparison.json');
  }
  const root = path.dirname(file), verifiedDirectories = new Set<string>();
  let files = 0, bytes = 0;
  const budgetGaps = new Set<string>();
  async function read(target: string, optional = false): Promise<unknown | undefined> {
    if (files >= 4096 || bytes >= 128_000_000) { budgetGaps.add('Companion read budget reached (4096 files / 128 MB); remaining facts are not loaded.'); return undefined; }
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Result companion escapes selected directory');
    try {
      const parts = relative.split(path.sep); let directory = root;
      for (const part of parts.slice(0, -1)) {
        directory = path.join(directory, part);
        if (!verifiedDirectories.has(directory)) {
          const s = await lstat(directory);
          if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Result companion directory must not be a link');
          verifiedDirectories.add(directory);
        }
      }
      const s = await lstat(target);
      if (s.size > 32_000_000) throw new Error('Result artifact exceeds 32 MB');
      if (bytes + s.size > 128_000_000) { budgetGaps.add('Companion read budget reached (4096 files / 128 MB); remaining facts are not loaded.'); return undefined; }
      const raw = await readLegacyJson(target); files++; bytes += s.size;
      return raw;
    } catch (e) { if (optional && (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  }
  async function load(target: string, raw: unknown, depth = 0): Promise<ResultRecord> {
    if (depth > 2) throw new Error('Result nesting exceeds supported workflow depth');
    const result: ResultRecord = { file: target, artifact_hash: semanticHash(raw), executions: [], children: [], gaps: [] }, directory = path.dirname(target);
    if (header.parse(raw).kind === 'dependency_usage_comparison') {
      return comparisonRecord(target, raw);
    }
    if (header.parse(raw).kind === 'permsift_execution') {
      result.native = parseNativeExecution(raw);
      result.executions.push({ task: result.native.task.key, reference: path.basename(target), facts: result.native.execution, native: true, policy: result.native.policy, agreement: result.native.agreement });
      return result;
    }
    const initial = adaptLegacy(raw), inputs = await read(path.join(directory, 'inputs.json'), true);
    const context = z.object({ project: z.string().optional(), error: z.string().optional(), terms_changed: z.boolean().optional(),
      inputs: z.object({ project: z.string().optional(), input_changed: z.boolean().optional(), limits_changed: z.boolean().optional() }).optional(),
      environment_changes: z.record(z.unknown()).optional() }).parse(raw);
    result.context = { project: context.project ?? context.inputs?.project, error: context.error, terms_changed: context.terms_changed,
      input_changed: context.inputs?.input_changed, limits_changed: context.inputs?.limits_changed,
      environment_changed: context.environment_changes ? Object.keys(context.environment_changes) : undefined };
    const evidence: Record<string, unknown> = {};
    if (initial.source.format === 'experiment-v1') {
      for (const e of initial.executions) {
        if (options.verificationOnly && e.origin.phase !== (initial.workflow.kind === 'tighten' ? 'final' : initial.workflow.kind === 'observe' ? 'observe' : 'baseline')) continue;
        if (!/^evidence\/[a-zA-Z0-9_-]+\.json$/.test(e.origin.record)) throw new Error('Invalid evidence companion reference');
        const value = await read(path.join(directory, e.origin.record), true);
        if (value !== undefined) evidence[e.origin.record] = value;
      }
    }
    const model = adaptLegacy(raw, { inputs, evidence }); result.model = model;
    if (model.source.format !== 'usage-v1') {
      const cost = z.object({ installation_stats: z.record(z.object({ executed: count, reused: count, snapshots: count })).optional(),
        trials: z.union([count, z.array(z.unknown())]), timings: z.object({ total_ms: z.number().finite().nonnegative(), phases: z.object({ protections: z.object({ duration_ms: z.number().finite().nonnegative(), calls: count }).optional() }).optional() }).optional() }).parse(raw);
      result.cost = { trials: typeof cost.trials === 'number' ? cost.trials : cost.trials.length, installations: cost.installation_stats, duration_ms: cost.timings?.total_ms, protections: cost.timings?.phases?.protections };
    }
    if (model.source.format === 'experiment-v1') {
      const discovery = z.object({ enabled: z.boolean().optional(), truncated: z.boolean().optional(), rules: z.array(z.unknown()).max(10000).optional(), limitations: z.array(text).max(4096).optional() });
      const discoveries = z.object({ discovery: z.record(discovery).optional(), read_discovery: z.record(discovery).optional(), install_discovery: z.record(discovery).optional() }).parse(raw);
      result.discovery = Object.entries(discoveries).flatMap(([dimension, tasks]) => Object.entries(tasks ?? {}).map(([task, d]) => {
        if (!model.tasks.some(t => t.key === task)) throw new Error('Discovery references a missing task');
        return { task, dimension, enabled: d.enabled, truncated: d.truncated, rules: d.rules?.length, limitations: d.limitations ?? [] };
      }));
      const indexRaw = await read(path.join(directory, 'executions/index.json'), true);
      const native = new Map<string, { reference: string; facts: NativeExecution }>();
      if (indexRaw !== undefined) {
        const index = indexSchema.parse(indexRaw);
        if (new Set(index.entries.map(e => e.trial)).size !== index.entries.length || new Set(index.entries.map(e => e.execution_id)).size !== index.entries.length) throw new Error('Duplicate execution index entry');
        for (const entry of index.entries) {
          if (!/^[a-zA-Z0-9_-]+$/.test(entry.trial) || entry.facts !== `executions/${entry.trial}.json` || entry.evidence !== `evidence/${entry.trial}.json`) throw new Error('Invalid execution index reference');
          const old = model.executions.find(e => e.origin.record === entry.evidence);
          if (!old) { result.gaps.push('Index contains an execution absent from the workflow checkpoint; it does not establish workflow completion.'); continue; }
          if (options.verificationOnly && old.origin.phase !== (model.workflow.kind === 'tighten' ? 'final' : model.workflow.kind === 'observe' ? 'observe' : 'baseline')) continue;
          const value = await read(path.join(directory, entry.facts), true);
          if (value === undefined) { result.gaps.push('Indexed native facts not available: ' + entry.facts); continue; }
          const facts = parseNativeExecution(value), e = facts.execution, task = model.tasks.find(t => t.id === old.task_id)!;
          if (facts.task.key !== task.key || (task.definition.state === 'recorded' && task.id !== facts.task.id) || e.origin.record !== entry.facts || e.origin.producer_id !== old.origin.producer_id || e.origin.phase !== old.origin.phase || e.id !== entry.execution_id) throw new Error('Native execution/index/workflow mismatch');
          const oldPolicyId = old.policy_id.state === 'recorded' ? old.policy_id.value : undefined;
          const oldPolicy = model.policies.find(p => p.id === oldPolicyId);
          const oldAgreement = model.agreements.find(a => a.id === old.agreement_id);
          if ((oldAgreement?.declaration.state === 'recorded' && canonical(oldAgreement.declaration) !== canonical(facts.agreement.declaration)) || (model.source.inputs_status === 'matched' && oldAgreement?.id !== facts.agreement.id)) throw new Error('Native/report protection declaration mismatch');
          if (oldPolicy) {
            sameKnown(oldPolicy.task.write, facts.policy.task.write, 'task writes'); sameKnown(oldPolicy.task.network, facts.policy.task.network, 'task network');
            if (oldPolicy.task.read.state === 'recorded' && facts.policy.task.read.state === 'recorded') {
              const a = oldPolicy.task.read.value, b = facts.policy.task.read.value;
              if (a.mode !== b.mode || canonical(a.grants) !== canonical(b.grants)) throw new Error('Native/report mismatch: task reads');
              sameKnown(a.target_kinds, b.target_kinds, 'read target kinds');
            }
            sameKnown(oldPolicy.installation, facts.policy.installation, 'installation policy');
            if (oldPolicy.protection_denials && canonical(oldPolicy.protection_denials) !== canonical(facts.policy.protection_denials)) throw new Error('Native/report protection policy mismatch');
          }
          sameKnown(old.reported_verdict, e.reported_verdict, 'reported verdict'); sameKnown(old.process, e.process, 'task process');
          sameKnown(old.assertions, e.assertions, 'success checks'); sameKnown(old.boundaries, e.boundaries, 'boundary checks');
          if (old.protections && e.protections) sameKnown(old.protections, e.protections, 'protection checks');
          for (const key of ['input_hash', 'config_hash', 'limits_hash', 'environment', 'actual_command'] as const) sameKnown(old.conditions[key], e.conditions[key], key);
          native.set(entry.evidence, { reference: entry.facts, facts });
        }
        for (const old of model.executions) if ((!options.verificationOnly || old.origin.phase === (model.workflow.kind === 'tighten' ? 'final' : model.workflow.kind === 'observe' ? 'observe' : 'baseline')) && !index.entries.some(e => e.evidence === old.origin.record)) result.gaps.push('Workflow trial lacks an index entry: ' + old.origin.record);
      }
      result.executions = model.executions.filter(e => !options.verificationOnly || e.origin.phase === (model.workflow.kind === 'tighten' ? 'final' : model.workflow.kind === 'observe' ? 'observe' : 'baseline')).map(e => { const n = native.get(e.origin.record); return { task: model.tasks.find(t => t.id === e.task_id)!.key,
        reference: n?.reference ?? e.origin.record, facts: n?.facts.execution ?? e, native: !!n, agreement: n?.facts.agreement ?? model.agreements.find(a => a.id === e.agreement_id), policy: n?.facts.policy ?? model.policies.find(p => p.id === (e.policy_id.state === 'recorded' ? e.policy_id.value : undefined)) }; });
    } else if (model.source.format === 'regression-v1') {
      for (const task of model.workflow.comparisons) for (const stage of task.stages) {
        if (options.verificationOnly) {
          const phase = task.reported_status === 'compatible' ? 'old' : task.reported_status === 'new_task_verified' ? 'new' :
            task.suggestion_verified.state === 'recorded' && task.suggestion_verified.value ? [...task.stages].reverse().find(s => /^repair-verify-/.test(s.phase))?.phase : undefined;
          if (stage.phase !== phase) continue;
        }
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(task.task_key) || !/^[a-z0-9-]+$/.test(stage.phase) || stage.report !== `tasks/${task.task_key}/${stage.phase}/report.md`) throw new Error('Invalid regression stage reference');
        const child = path.join(directory, stage.report.replace(/\.md$/, '.json')), value = await read(child, true);
        const loaded = value === undefined ? undefined : await load(child, value, depth + 1);
        if (loaded) {
          if (!loaded.model || loaded.model.source.format !== 'experiment-v1' || loaded.model.workflow.kind !== 'run' || loaded.model.tasks.length !== 1 || loaded.model.tasks[0].key !== task.task_key || loaded.model.executions.length !== stage.trials) throw new Error('Regression stage report mismatch');
          sameKnown(model.source.recorded_hashes.input, loaded.model.source.recorded_hashes.input, 'regression input');
        }
        result.children.push({ task: task.task_key, phase: stage.phase, reference: stage.report.replace(/\.md$/, '.json'), result: loaded });
      }
    } else {
      result.usage = parseUsage(raw);
      const info = z.object({ execution_report: z.string().optional(), comparison: comparisonSchema.optional() }).parse(raw);
      result.comparison = info.comparison;
      if (info.comparison && new Set(info.comparison.tasks.map(t => t.task)).size !== info.comparison.tasks.length) throw new Error('Duplicate comparison task');
      if (info.execution_report !== undefined) {
        if (info.execution_report !== 'report.json') throw new Error('Invalid observation execution report reference');
        const value = await read(path.join(directory, 'report.json'), true);
        if (value !== undefined) {
          const child = await load(path.join(directory, 'report.json'), value, depth + 1);
          if (!child.model || child.model.workflow.kind !== 'observe') throw new Error('Observation linked execution workflow mismatch');
          for (const key of ['config', 'limits', 'input'] as const) sameKnown(model.source.recorded_hashes[key], child.model.source.recorded_hashes[key], 'observation ' + key);
          if (canonical(model.tasks.map(t => t.key).sort()) !== canonical(child.model.tasks.map(t => t.key).sort())) throw new Error('Observation linked task keys mismatch');
          for (const e of child.executions) if (e.facts.observations.records.state === 'recorded') {
            const t = result.usage.tasks.find(t => t.task === e.task);
            if (!t || canonical(t) !== canonical(e.facts.observations.records.value)) throw new Error('Observation linked source records mismatch');
          }
          result.executionReport = child;
        } else result.gaps.push('Linked execution report not available; usage records alone cannot establish assertion or boundary results.');
      }
    }
    return result;
  }
  const raw = await read(file);
  if (raw === undefined) throw new Error('Selected result exceeds read budget');
  if (['permsift_adopted_baseline', 'permsift_baseline_selection'].includes(header.parse(raw).kind ?? '')) {
    const { readAdoption } = await import('./adoption.js');
    const adoption = await readAdoption(file);
    return freeze({ file: adoption.file, artifact_hash: semanticHash(adoption.manifest), adoption, executions: [], children: [], gaps: [] });
  }
  const result = await load(file, raw); result.gaps.push(...budgetGaps);
  return freeze(result);
}
