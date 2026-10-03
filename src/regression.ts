import { phaseVerdict } from './execution-phase.js';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { z } from 'zod';
import { aliasSchema, readAliasSchema, domainSchema, configSchema, contains, isStaged, installationScenario, loadConfiguration, validatePolicy, type Config, type Limits, type Scenario } from './config.js';
import { runExperimentWithFacts, VERSION, type Report } from './engine.js';
import { BACKEND_VERSION, requirePlatform } from './backend.js';
import { hash, noSymlinks, resolveAlias, saveJson, snapshot, within } from './filesystem.js';
import type { Diagnosis } from './diagnostics.js';
import { npmVersion } from './install.js';
import { publishSummary } from './result-output.js';

const grants = z.array(aliasSchema).max(32).refine(a => new Set(a).size === a.length, 'Duplicate baseline grant');
const reads = z.array(readAliasSchema).max(32).refine(a => new Set(a).size === a.length, 'Duplicate baseline read grant');
const domains = z.array(domainSchema).max(32).refine(a => new Set(a).size === a.length, 'Duplicate baseline network grant');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const baselineSchema = z.object({
  schema_version: z.literal(1), mode: z.enum(['run', 'tighten']), status: z.literal('verified'),
  baseline_verified: z.literal(true), final_verified: z.literal(true),
  environment: z.record(z.string()), inputs: z.object({ snapshot_hash: digest, config_hash: digest, limits_hash: digest }),
  policies: z.record(grants), read_policies: z.record(reads), read_modes: z.record(z.enum(['explicit', 'legacy'])),
  network_policies: z.record(domains).optional(), install_policies: z.record(grants).optional(),
  trials: z.array(z.object({ scenario: z.string(), verdict: z.enum(['pass', 'fail', 'unknown']), grants, read_grants: reads,
    network_grants: domains.optional(), install_grants: grants.optional(), installation_reused: z.boolean().optional(), evidence: z.string().regex(/^evidence\/[a-f0-9-]+\.json$/) })).min(1),
});
export type Baseline = {
  file: string; config: Config; environment: Record<string, string>; snapshot_hash: string; limits_hash: string;
  policies: Record<string, string[]>; read_policies: Record<string, string[]>; read_modes: Record<string, 'explicit' | 'legacy'>;
  prepared: Record<string, string[]>; read_kinds: Record<string, Record<string, 'file' | 'directory'>>;
  network_policies: Record<string, string[]>; install_policies: Record<string, string[]>;
};
async function jsonFile(file: string) {
  if ((await fs.stat(file)).size > 25_000_000) throw new Error('Baseline JSON exceeds 25 MB');
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}
const same = (a: string[], b: string[]) => hash([...a].sort()) === hash([...b].sort());
export async function loadBaseline(file: string): Promise<Baseline> {
  const canonical = await fs.realpath(file);
  const directory = path.dirname(canonical);
  const report = baselineSchema.parse(await jsonFile(canonical));
  const input = z.object({ config: configSchema }).parse(await jsonFile(path.join(directory, 'inputs.json')));
  if (hash(input.config) !== report.inputs.config_hash) throw new Error('Baseline config does not match its recorded hash');
  const ids = input.config.scenarios.map(s => s.id).sort();
  for (const record of [report.policies, report.read_policies, report.read_modes, ...report.network_policies ? [report.network_policies] : []]) {
    if (!same(Object.keys(record), ids)) throw new Error('Baseline scenario records do not match inputs.json');
  }
  const prepared: Baseline['prepared'] = {}, read_kinds: Baseline['read_kinds'] = {};
  const network_policies = report.network_policies ?? Object.fromEntries(ids.map(id => [id, []]));
  const install_policies = report.install_policies ?? {};
  if (!same(Object.keys(install_policies), input.config.scenarios.filter(isStaged).map(s => s.id))) throw new Error('Baseline install stage records do not match inputs.json');
  for (const scenario of input.config.scenarios) {
    const id = scenario.id;
    if (scenario.install && !report.network_policies) throw new Error('Install baseline is missing network policies');
    if (report.read_modes[id] !== (scenario.initial_read_grants === undefined ? 'legacy' : 'explicit')) throw new Error('Baseline read mode does not match its config');
    if (report.read_modes[id] === 'legacy' && !same(report.read_policies[id], ['@workspace'])) throw new Error('Invalid legacy read policy');
    const trial = [...report.trials].reverse().find(t => t.scenario === id && t.verdict === 'pass' && same(t.grants, report.policies[id]) && same(t.read_grants, report.read_policies[id]) && same(t.network_grants ?? [], network_policies[id]) && (!isStaged(scenario) || t.installation_reused === false && same(t.install_grants ?? [], install_policies[id])));
    if (!trial) throw new Error(`Baseline has no passing evidence for ${id}`);
    const evidenceFile = await fs.realpath(path.join(directory, trial.evidence));
    if (!within(directory, evidenceFile)) throw new Error('Baseline evidence escapes its report directory');
    const evidence = z.object({ scenario: z.literal(id), grants, read_grants: reads, prepared_directories: z.array(aliasSchema).max(2048),
      network_grants: domains.optional(), install_grants: grants.optional(), summary: z.object({ installation_reused: z.boolean().optional() }).optional(), stage_policy_mode: z.enum(['separate', 'shared']).optional(), read_grant_kinds: z.record(z.enum(['file', 'directory'])).optional() }).parse(await jsonFile(evidenceFile));
    if (!same(evidence.grants, report.policies[id]) || !same(evidence.read_grants, report.read_policies[id])) throw new Error('Baseline evidence policy mismatch');
    if (!same(evidence.network_grants ?? [], network_policies[id])) throw new Error('Baseline evidence network policy mismatch');
    if (isStaged(scenario) && (evidence.stage_policy_mode !== 'separate' || evidence.summary?.installation_reused !== false || !same(evidence.install_grants ?? [], install_policies[id]))) throw new Error('Baseline lacks fresh full-flow installation policy evidence');
    prepared[id] = evidence.prepared_directories;
    read_kinds[id] = evidence.read_grant_kinds ?? {};
    if (report.read_modes[id] === 'explicit' && !same(Object.keys(read_kinds[id]), report.read_policies[id])) throw new Error('Baseline is missing exact read target kinds');
  }
  return { file: canonical, config: input.config, environment: report.environment, snapshot_hash: report.inputs.snapshot_hash, limits_hash: report.inputs.limits_hash,
    policies: report.policies, read_policies: report.read_policies, read_modes: report.read_modes, prepared, read_kinds, network_policies, install_policies };
}

export function regressionConfigs(config: Config, baseline: Baseline, limits: Limits) {
  if (!same(config.scenarios.map(s => s.id), baseline.config.scenarios.map(s => s.id))) throw new Error('Task IDs changed; create a new verified baseline for added or removed tasks');
  const old: Config = { ...config, scenarios: config.scenarios.map(s => {
    if (baseline.read_modes[s.id] !== (s.initial_read_grants === undefined ? 'legacy' : 'explicit')) throw new Error('Read mode changed; create a new verified baseline');
    const previous = baseline.config.scenarios.find(p => p.id === s.id)!;
    if (isStaged(s) !== isStaged(previous)) throw new Error('Install stage mode changed; create a new verified baseline');
    if (isStaged(s) && baseline.install_policies[s.id].some(p => !installationScenario(s).initial_write_grants.some(root => contains(root, p)))) throw new Error(`Control install writes must cover the old policy: ${s.id}`);
    if (!!s.install !== !!previous.install || s.install?.cache !== previous.install?.cache) throw new Error('Install/cache mode changed; create a new verified baseline');
    if (baseline.network_policies[s.id].some(d => !s.initial_network_grants?.includes(d))) throw new Error(`Control domains must cover the old policy: ${s.id}`);
    if (baseline.policies[s.id].some(p => !s.initial_write_grants.some(root => contains(root, p)))) throw new Error(`Control writes must cover the old policy: ${s.id}`);
    if (s.initial_read_grants && baseline.read_policies[s.id].some(p => !s.initial_read_grants!.some(root => contains(root, p)))) throw new Error(`Control reads must cover the old policy: ${s.id}`);
    return { ...s, initial_write_grants: baseline.policies[s.id], ...(s.install ? { initial_network_grants: baseline.network_policies[s.id], ...(isStaged(s) ? { install: { ...s.install, initial_write_grants: baseline.install_policies[s.id], narrower_candidates: [], auto_discover: false } } : {}) } : {}), ...(s.initial_read_grants === undefined ? {} : { initial_read_grants: baseline.read_policies[s.id] }),
      auto_discover: false, auto_read_discover: false, narrower_candidates: [], narrower_read_candidates: [],
      prepare_directories: [...new Set([...baseline.prepared[s.id], ...s.prepare_directories, ...s.initial_write_grants, ...s.narrower_candidates.flatMap(r => [r.from, ...r.to]), ...isStaged(s) ? [...installationScenario(s).initial_write_grants, ...installationScenario(s).narrower_candidates.flatMap(r => [r.from, ...r.to])] : []])].sort() };
  }) };
  const control: Config = { ...old, scenarios: old.scenarios.map((s, i) => ({ ...s, initial_write_grants: config.scenarios[i].initial_write_grants, ...(s.install ? { initial_network_grants: config.scenarios[i].initial_network_grants ?? [], ...(isStaged(s) ? { install: { ...s.install, initial_write_grants: config.scenarios[i].install!.initial_write_grants } } : {}) } : {}),
    ...(s.initial_read_grants === undefined ? {} : { initial_read_grants: config.scenarios[i].initial_read_grants }) })) };
  validatePolicy(old, limits); validatePolicy(control, limits);
  return { old, control };
}
export function regressionVerdict(report: Report): 'pass' | 'fail' | 'unknown' {
  if (!report.trials.length || report.trials.some(t => t.verdict === 'unknown' || t.diagnosis?.boundary_issues.length)) return 'unknown';
  if (report.status === 'verified' && report.baseline_verified && report.final_verified && report.trials.every(t => t.verdict === 'pass')) return 'pass';
  return report.status === 'failed' && report.trials.at(-1)?.verdict === 'fail' ? 'fail' : 'unknown';
}
function compact(paths: string[]) { return [...new Set(paths)].filter(p => !paths.some(other => other !== p && contains(other, p))).sort(); }
export async function repairCandidates(old: Scenario, control: Scenario, diagnoses: Diagnosis[], inputRoot: string) {
  const readHints: string[] = [], writeHints: string[] = [];
  const hints: { alias: string; operation: string; stage?: 'install' | 'task' }[] = diagnoses.flatMap(d => d.denials.flatMap(v => v.path ? [{ alias: v.path, operation: v.operation, stage: d.stage }] : []));
  const installWriteHints: string[] = [];
  // Module-resolution errors are untrusted task output, just like stderr denials.
  // They generate bounded hypotheses, which still have to pass real trials.
  for (const diagnosis of diagnoses) for (const match of diagnosis.stderr_excerpt.matchAll(/Cannot find module ['"]([^'"\n]+)['"]/g)) {
    const name = match[1];
    if (name.startsWith('./') && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name.slice(2)) && !name.slice(2).split('/').some(p => p === '.' || p === '..')) {
      for (const suffix of ['', '.js', '.json', '.node']) hints.push({ alias: '@workspace/' + name.slice(2) + suffix, operation: 'module-read' });
    } else if (/^(@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name) && !name.split('/').some(p => p === '.' || p === '..')) {
      const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
      hints.push({ alias: '@workspace/node_modules/' + packageName, operation: 'module-read' });
    }
  }
  const mkdirTargets = new Set(hints.filter(h => /mkdir/.test(h.operation)).map(h => h.alias));
  for (const hint of hints) {
    if (!aliasSchema.safeParse(hint.alias).success) continue;
    const roots = { workspace: inputRoot, cache: path.join(inputRoot, '..', 'cache'), tmp: path.join(inputRoot, '..', 'tmp') };
    const target = resolveAlias(hint.alias, roots);
    let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try { await noSymlinks(roots[hint.alias.slice(1).split('/')[0] as keyof typeof roots], target); stat = await fs.lstat(target); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue; }
    const readOperation = /read|open|unspecified/.test(hint.operation);
    const writeOperation = /write|create|mkdir|unlink|rename|open|unspecified/.test(hint.operation);
    if (readOperation && (!isStaged(old) || hint.stage !== 'install') && old.initial_read_grants && (stat?.isFile() || stat?.isDirectory() || isStaged(old) && hint.alias.startsWith('@workspace/node_modules/') && hint.stage !== 'install') && readAliasSchema.safeParse(hint.alias).success &&
      control.initial_read_grants!.some(p => contains(p, hint.alias)) && !old.initial_read_grants.some(p => contains(p, hint.alias))) readHints.push(hint.alias);
    const write = stat?.isDirectory() || mkdirTargets.has(hint.alias) ? hint.alias : hint.alias.slice(0, hint.alias.lastIndexOf('/'));
    if (writeOperation && aliasSchema.safeParse(write).success) {
      if (isStaged(old) && hint.stage === 'install') {
        if (installationScenario(control).initial_write_grants.some(p => contains(p, write)) && !installationScenario(old).initial_write_grants.some(p => contains(p, write))) installWriteHints.push(write);
      } else if (control.initial_write_grants.some(p => contains(p, write)) && !old.initial_write_grants.some(p => contains(p, write))) writeHints.push(write);
    }
  }
  const candidates: Scenario[] = [];
  const networkHints = [...new Set(diagnoses.flatMap(d => d.denials.filter(v => v.source === 'sandbox_log' && v.operation === 'network-outbound').flatMap(v => {
    const host = v.path?.split(':')[0];
    return host && domainSchema.safeParse(host).success && control.initial_network_grants?.includes(host) && !old.initial_network_grants?.includes(host) ? [host] : [];
  })))];
  if (old.install && networkHints.length) candidates.push({ ...old, initial_network_grants: [...new Set([...old.initial_network_grants ?? [], ...networkHints])].sort() });
  for (const write of [...new Set(installWriteHints)]) candidates.push({ ...old, install: { ...old.install!, initial_write_grants: compact([...old.install!.initial_write_grants!, write]) } });
  if (readHints.length) candidates.push({ ...old, initial_read_grants: compact([...old.initial_read_grants!, ...readHints]) });
  for (const write of [...new Set(writeHints)].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))) {
    candidates.push({ ...old, initial_write_grants: compact([...old.initial_write_grants, write]) });
  }
  if (readHints.length && writeHints.length) candidates.push({ ...old, initial_read_grants: compact([...old.initial_read_grants!, ...readHints]), initial_write_grants: compact([...old.initial_write_grants, ...writeHints]) });
  return candidates.filter(s => s.initial_write_grants.length <= 32 && (s.initial_read_grants?.length ?? 0) <= 32 && (s.initial_network_grants?.length ?? 0) <= 32 && (s.install?.initial_write_grants?.length ?? 0) <= 32);
}

type Stage = { phase: string; verdict: 'pass' | 'fail' | 'unknown'; report: string; trials: number; prepared_directories: string[] };
export type RegressionTask = {
  id: string; status: 'pending' | 'compatible' | 'permission_change' | 'unresolved_failure' | 'inconclusive'; reason?: string;
  task_definition_changed: boolean; stages: Stage[]; repair_stop?: 'verified' | 'no_hints' | 'budget' | 'unstable' | 'inconclusive';
  suggestion?: { install_write?: string[]; added_install_write?: string[]; write: string[]; read?: string[]; network?: string[]; added_network?: string[]; added_write: string[]; added_read: string[]; verified: true };
};
export type RegressionReport = {
  schema_version: 1; kind: 'regression'; id: string; status: 'running' | 'compatible' | 'regressed' | 'inconclusive';
  started_at: string; finished_at?: string; output: string; baseline: string; project: string;
  environment: Record<string, string>; environment_changes: Record<string, { before?: string; after?: string }>;
  inputs: { previous_snapshot_hash: string; snapshot_hash?: string; input_changed?: boolean; config_hash: string; limits_hash: string; limits_changed: boolean; exclude_changed: boolean };
  tasks: RegressionTask[]; candidate_count: number; trials: number; error?: string;
};
const escape = (s: string) => s.replace(/[\u0000-\u001f|`<>\[\]]/g, ' ');
export function markdownRegression(report: RegressionReport) {
  return ['# Permsift regression check', '', `- Status: **${report.status}**`, `- Baseline: ${escape(report.baseline)}`,
    `- Input changed: ${report.inputs.input_changed ?? 'unknown'}`, `- Limits changed: ${report.inputs.limits_changed}`,
    `- Exclusions changed: ${report.inputs.exclude_changed}`, `- Actual trials: ${report.trials}; repair candidates: ${report.candidate_count}`, '',
    ...(report.error ? [`Error: ${escape(report.error)}`, ''] : []),
    '## Environment changes', '', ...Object.entries(report.environment_changes).map(([key, v]) => `- ${key}: ${escape(v.before ?? '(missing)')} → ${escape(v.after ?? '(missing)')}`), '',
    ...report.tasks.flatMap(t => [`## ${t.id}`, '', `- Result: **${t.status}**`, `- Task definition changed: ${t.task_definition_changed}`,
      ...(t.reason ? [`- ${escape(t.reason)}`] : []), ...(t.repair_stop ? [`- Repair: ${t.repair_stop}`] : []), '',
      '| Stage | Verdict | Trials | Evidence |', '| --- | --- | --- | --- |',
      ...t.stages.map(s => `| ${s.phase} | ${s.verdict} | ${s.trials} | [report](${s.report}) |`), '',
      ...(t.suggestion ? [`- Suggested writes: ${t.suggestion.write.join(', ') || '(none)'}`, `- Suggested reads: ${t.suggestion.read?.join(', ') || '(legacy or no project file grants)'}`,
        ...(t.suggestion.install_write ? [`- Suggested install writes: ${t.suggestion.install_write.join(', ') || '(none)'}`, `- Added install writes: ${t.suggestion.added_install_write?.join(', ') || '(none)'}`] : []),
        ...(t.suggestion.network ? [`- Suggested install domains: ${t.suggestion.network.join(', ') || '(offline)'}`, `- Added domains: ${t.suggestion.added_network?.join(', ') || '(none)'}`] : []),
        `- Added write scope: ${t.suggestion.added_write.join(', ') || '(none)'}`, `- Added read scope: ${t.suggestion.added_read.join(', ') || '(none)'}`, ''] : [])]),
    '## Interpretation', '',
    'A compatible result verifies the recorded policy against current frozen inputs and current task assertions; it does not repeat permission minimization.',
    'Permission changes are supported by an old-policy failure, passing wider control and a fresh old-policy failure. Review tested suggestions; this is not a general causality or minimum-permission proof.',
    'Failure under both policies remains unresolved. Timeouts, boundary issues, changed read target kinds and unstable comparisons are inconclusive.',
    'All stages share frozen inputs. Each comparison uses the same preparation; adding a write directory requires a fresh old-policy/control comparison under the revised preparation. Each actual trial retains fresh outputs, before/after boundary probes and normal process cleanup.',
    'Suggestions require a passing candidate plus configured repeated verification. They never modify the original config or replace the historical baseline.', '',
  ].join('\n');
}

export async function runRegression(options: {
  configPath: string; limitsPath: string; baselinePath: string; output?: string; keepWorkspaces?: boolean;
  signal?: AbortSignal; onProgress?: (message: string) => void;
}): Promise<RegressionReport> {
  requirePlatform();
  const input = await loadConfiguration(options.configPath, options.limitsPath);
  const baseline = await loadBaseline(options.baselinePath);
  const configs = regressionConfigs(input.config, baseline, input.limits);
  const id = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const requested = path.resolve(options.output ?? path.join('.permsift', 'check-' + id));
  await fs.mkdir(path.dirname(requested), { recursive: true });
  const output = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  if (within(input.project, output) && !input.config.exclude.includes(path.relative(input.project, output).split(path.sep)[0])) throw new Error('Check output inside the project must be under an excluded top-level directory');
  await fs.mkdir(output, { mode: 0o700 });
  const environment = { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, permsift: VERSION, sandbox_runtime: BACKEND_VERSION,
    ...(input.config.scenarios.some(s => s.install) ? { npm: await npmVersion() } : {}) };
  const report: RegressionReport = { schema_version: 1, kind: 'regression', id, status: 'running', started_at: new Date().toISOString(), output, baseline: baseline.file, project: input.project,
    environment, environment_changes: Object.fromEntries(Object.entries(environment).filter(([key, value]) => baseline.environment[key] !== value).map(([key, value]) => [key, { before: baseline.environment[key], after: value }])),
    inputs: { previous_snapshot_hash: baseline.snapshot_hash, config_hash: hash(input.config), limits_hash: hash(input.limits), limits_changed: hash(input.limits) !== baseline.limits_hash,
      exclude_changed: hash(input.config.exclude) !== hash(baseline.config.exclude) },
    tasks: input.config.scenarios.map(s => ({ id: s.id, status: 'pending', stages: [], task_definition_changed: taskHash(s) !== taskHash(baseline.config.scenarios.find(b => b.id === s.id)!) })),
    candidate_count: 0, trials: 0 };
  const checkpoint = async () => { await saveJson(path.join(output, 'report.json'), report); await fs.writeFile(path.join(output, 'report.md'), markdownRegression(report), { mode: 0o600 }); };
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-check-')));
  const frozen = { path: path.join(scratch, 'input'), hash: '', protectedPaths: [output, path.dirname(baseline.file)] };
  const deadline = Date.now() + input.limits.budget_seconds * 1000;
  const available = () => Date.now() < deadline && !options.signal?.aborted;
  const suggested = new Map<string, Scenario>();
  try {
    await checkpoint();
    frozen.hash = await snapshot(input.project, frozen.path, input.config.exclude, input.limits.max_snapshot_bytes);
    report.inputs.snapshot_hash = frozen.hash; report.inputs.input_changed = frozen.hash !== baseline.snapshot_hash;
    await saveJson(path.join(output, 'inputs.json'), { config: input.config, limits: input.limits, environment, inputs: report.inputs, baseline: baseline.file });
    const execute = async (row: RegressionTask, scenario: Scenario, phase: string, repetitions = input.limits.repetitions) => {
      if (!available()) throw new Error(options.signal?.aborted ? 'Regression check interrupted' : 'Regression budget exhausted');
      const { report: run, execution } = await runExperimentWithFacts({ mode: 'run', input: { ...input, config: { ...input.config, scenarios: [scenario] }, limits: { ...input.limits, repetitions, budget_seconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) } },
        frozenInput: frozen, expectedReadKinds: { [row.id]: baseline.read_kinds[row.id] }, output: path.join(output, 'tasks', row.id, phase), signal: options.signal, keepWorkspaces: options.keepWorkspaces,
        onProgress: message => options.onProgress?.(`${row.id} · ${phase} · ${message}`) });
      if (execution.inputHash !== frozen.hash || !available()) row.reason = 'Comparison input changed, was interrupted or exceeded the overall budget';
      const verdict = row.reason ? 'unknown' as const : phaseVerdict(execution);
      row.stages.push({ phase, verdict, report: path.relative(output, path.join(run.output, 'report.md')).split(path.sep).join('/'), trials: execution.trials.length, prepared_directories: scenario.prepare_directories });
      report.trials += execution.trials.length; await checkpoint();
      return { execution, verdict };
    };
    for (const [index, row] of report.tasks.entries()) {
      let old = configs.old.scenarios[index], control = configs.control.scenarios[index];
      if (!available()) break;
      try {
        for (const [alias, kind] of Object.entries(baseline.read_kinds[row.id])) {
          if (isStaged(old) && alias.startsWith('@workspace/node_modules/')) continue; // Validate generated targets after a fresh install in runExperiment.
          const target = resolveAlias(alias, { workspace: frozen.path, cache: scratch, tmp: scratch });
          await noSymlinks(frozen.path, target);
          const stat = await fs.lstat(target).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          });
          // Build output directories can be absent from the source snapshot but
          // present in the recorded, shared preparation before every real trial.
          if (!stat && kind === 'directory' && old.prepare_directories.some(p => contains(alias, p))) continue;
          if (!stat) throw new Error(`Historical read input is missing: ${alias}; review a new baseline`);
          if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())) throw new Error(`Historical read target changed kind: ${alias}; review a new baseline`);
        }
        const previous = await execute(row, old, 'old');
        if (previous.verdict === 'pass') { row.status = 'compatible'; suggested.set(row.id, old); continue; }
        if (previous.verdict === 'unknown') { row.status = 'inconclusive'; continue; }
        const wider = await execute(row, control, 'control');
        if (wider.verdict === 'unknown') { row.status = 'inconclusive'; continue; }
        if (wider.verdict === 'fail') { row.status = 'unresolved_failure'; row.reason = 'Both old and wider policies failed; permissions are not established as the cause'; continue; }
        const confirmation = await execute(row, old, 'old-confirm', 1);
        if (confirmation.verdict !== 'fail' || (same(old.initial_write_grants, control.initial_write_grants) && same(old.initial_read_grants ?? ['@workspace'], control.initial_read_grants ?? ['@workspace']) && same(old.initial_network_grants ?? [], control.initial_network_grants ?? []) && same(old.install?.initial_write_grants ?? [], control.install?.initial_write_grants ?? []))) {
          row.status = 'inconclusive'; row.reason = 'The old-policy failure was not stable under a distinct passing control'; continue;
        }
        const restored = await execute(row, control, 'control-confirm', 1);
        if (restored.verdict !== 'pass') { row.status = 'inconclusive'; row.reason = 'The wider control stopped passing after the fresh old-policy failure'; continue; }
        row.status = 'permission_change';
        let current = old;
        let diagnoses = confirmation.execution.trials.flatMap(t => t.diagnosis ? [t.diagnosis] : []);
        const attempted = new Set<string>();
        while (available()) {
          if (report.candidate_count >= input.limits.max_candidates) { row.repair_stop = 'budget'; break; }
          const candidates = await repairCandidates(current, control, diagnoses, frozen.path);
          let candidate = candidates.find(s => !attempted.has(hash([s.initial_write_grants, s.initial_read_grants, s.initial_network_grants, s.install?.initial_write_grants])));
          if (!candidate) { row.repair_stop = 'no_hints'; break; }
          const requiredWrites = [...candidate.initial_write_grants, ...candidate.install?.initial_write_grants ?? []];
          if (requiredWrites.some(p => !old.prepare_directories.includes(p))) {
            const prepared = [...new Set([...old.prepare_directories, ...requiredWrites])].sort();
            if (prepared.length > 2048) { row.repair_stop = 'no_hints'; row.reason = 'Write hypothesis exceeds the preparation limit'; break; }
            old = { ...old, prepare_directories: prepared }; control = { ...control, prepare_directories: prepared };
            current = { ...current, prepare_directories: prepared }; candidate = { ...candidate, prepare_directories: prepared };
            const number = report.candidate_count + 1;
            const before = await execute(row, old, `prepare-old-${number}`, 1);
            const after = await execute(row, control, `prepare-control-${number}`);
            if (before.verdict !== 'fail' || after.verdict !== 'pass') {
              row.status = 'inconclusive'; row.repair_stop = 'inconclusive'; row.reason = 'Revised preparation did not preserve the old failure and passing control'; break;
            }
          }
          const key = hash([candidate.initial_write_grants, candidate.initial_read_grants, candidate.initial_network_grants, candidate.install?.initial_write_grants]); attempted.add(key);
          const number = ++report.candidate_count;
          const result = await execute(row, candidate, `repair-${number}`, 1);
          if (result.verdict === 'pass') {
            const verified = await execute(row, candidate, `repair-verify-${number}`);
            if (verified.verdict === 'pass') {
              row.repair_stop = 'verified';
              row.suggestion = { ...(isStaged(candidate) ? { install_write: candidate.install!.initial_write_grants, added_install_write: candidate.install!.initial_write_grants!.filter(p => !old.install!.initial_write_grants!.some(root => contains(root, p))) } : {}), write: candidate.initial_write_grants, read: candidate.initial_read_grants, verified: true,
                ...(candidate.install ? { network: candidate.initial_network_grants ?? [], added_network: (candidate.initial_network_grants ?? []).filter(d => !old.initial_network_grants?.includes(d)) } : {}),
                added_write: candidate.initial_write_grants.filter(p => !old.initial_write_grants.some(root => contains(root, p))),
                added_read: (candidate.initial_read_grants ?? []).filter(p => !(old.initial_read_grants ?? []).some(root => contains(root, p))) };
              suggested.set(row.id, candidate); break;
            }
            await execute(row, control, `control-recovery-${number}`, 1);
            row.status = 'inconclusive'; row.repair_stop = 'inconclusive'; row.reason = 'A passing repair did not pass repeated verification'; break;
          }
          const recovery = await execute(row, control, `control-recovery-${number}`, 1);
          if (result.verdict === 'unknown' || recovery.verdict !== 'pass') { row.status = 'inconclusive'; row.repair_stop = recovery.verdict !== 'pass' ? 'unstable' : 'inconclusive'; break; }
          const next = result.execution.trials.flatMap(t => t.diagnosis ? [t.diagnosis] : []);
          // Follow a new denial only when it leads beyond this failed hypothesis.
          const additions = await repairCandidates(candidate, control, next, frozen.path);
          if (additions.length) current = candidate;
          diagnoses = [...diagnoses, ...next];
        }
        if (!available()) { row.status = 'inconclusive'; row.repair_stop = 'budget'; }
      } catch (error) { row.status = 'inconclusive'; row.reason = String(error); }
      finally { await checkpoint(); }
    }
  } catch (error) { report.error = String(error); }
  finally {
    try { await fs.rm(scratch, { recursive: true, force: true }); } catch (error) { report.error = `Regression snapshot cleanup failed: ${String(error)}`; }
    if (!available()) report.error = options.signal?.aborted ? 'Regression check interrupted' : 'Regression budget exhausted';
    for (const row of report.tasks) if (row.status === 'pending') { row.status = 'inconclusive'; row.reason = report.error ?? 'Task was not checked'; }
    report.status = report.error || report.tasks.some(t => t.status === 'inconclusive') ? 'inconclusive' : report.tasks.every(t => t.status === 'compatible') ? 'compatible' : 'regressed';
    // A reviewable complete configuration is exported only when every task has
    // a verified old policy or verified repair. CI still fails for permission changes.
    if (report.status !== 'inconclusive' && suggested.size === report.tasks.length) {
      await fs.writeFile(path.join(output, report.status === 'compatible' ? 'compatible.yaml' : 'suggested.yaml'), stringify({ ...input.config, project: input.project, scenarios: input.config.scenarios.map(s => suggested.get(s.id)!) }), { mode: 0o600 });
    }
    report.finished_at = new Date().toISOString(); await checkpoint();
  }
  await publishSummary(path.join(output, 'report.json'), path.join(output, 'report.md'));
  return report;
}
function taskHash(s: Scenario) { return hash({ command: s.command, timeout_seconds: s.timeout_seconds, assertions: s.assertions, install: s.install ? { manager: s.install.manager, cache: s.install.cache, cache_seed: s.install.cache_seed, registry: s.install.registry } : undefined }); }
