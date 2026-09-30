import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { contains, loadConfiguration, validatePolicy, type Config, type Limits, type Scenario } from './config.js';
import { BACKEND_VERSION, executeSandbox, requirePlatform, type BackendContext } from './backend.js';
import { snapshot, forkSnapshot, hash, within, noSymlinks, resolveAlias, manifest, diffFiles, saveJson, type Roots } from './filesystem.js';
import { checkAssertions, type Check } from './assertions.js';
import { startEndpoint, closeEndpoint, boundaryChecks, type Fixtures } from './probes.js';
import { searchPolicy, type SearchReuse, type SearchStep, type TrialVerdict } from './search.js';
import { directoryInventory, discover, type Discovery, type Observation } from './discovery.js';
import { diagnose, type Diagnosis } from './diagnostics.js';
import { readInventory, discoverReads, type ReadDiscovery, type ReadObservation } from './read-discovery.js';

export const VERSION = '0.4.0';
export type Trial = { id: string; scenario: string; phase: string; grants: string[]; read_grants: string[]; read_mode: 'explicit' | 'legacy'; verdict: TrialVerdict; duration_ms: number; evidence: string; reason?: string; diagnosis?: Diagnosis };
type SearchSummary = { stop: string; steps: SearchStep[]; rounds: number; reuses: SearchReuse[] };
export type Report = {
  schema_version: 1; id: string; mode: string; started_at: string; finished_at?: string;
  status: 'running' | 'verified' | 'failed' | 'incomplete';
  environment: Record<string, string>; inputs: Record<string, unknown>; scope: string[];
  trials: Trial[]; searches: Record<string, SearchSummary>;
  discovery: Record<string, Discovery>;
  read_discovery: Record<string, ReadDiscovery>; read_searches: Record<string, SearchSummary>;
  read_policies: Record<string, string[]>; read_modes: Record<string, 'explicit' | 'legacy'>;
  policies: Record<string, string[]>; baseline_verified: boolean; final_verified: boolean;
  search_complete: boolean; output: string; workspaces?: string; error?: string;
};
export function classifyTrial(taskStatus: string, exitCode: number | null, assertions: Check[], boundaries: Check[]): TrialVerdict {
  if (!assertions.length || !boundaries.length) return 'unknown';
  if (taskStatus !== 'completed' || boundaries.some(c => c.status === 'unknown') || assertions.some(c => c.status === 'unknown')) return 'unknown';
  return exitCode === 0 && assertions.every(c => c.status === 'pass') && boundaries.every(c => c.status === 'pass') ? 'pass' : 'fail';
}
const markdownEscape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\u0000-\u001f]/g, ' ').replace(/[|`\[\]]/g, '\\$&');
export function markdownReport(report: Report) {
  return [
    '# Permsift experiment', '',
    `- Status: **${report.status}**`, `- Experiment: ${report.id}`, `- Mode: ${report.mode}`,
    `- Baseline verified: ${report.baseline_verified}`, `- Final verified: ${report.final_verified}`, `- Search completed: ${report.search_complete}`,
    `- Platform: ${report.environment.platform} ${report.environment.release} ${report.environment.arch}`,
    `- Node: ${report.environment.node}; SRT: ${BACKEND_VERSION}`, '',
    ...(report.error ? [`Error: ${markdownEscape(report.error)}`, ''] : []),
    '## Scope and limitations', '', ...report.scope.map(s => `- ${s}`), '',
    '## Current candidate policies', '',
    ...Object.entries(report.policies).flatMap(([id, grants]) => [
      `- **${id} write**: ${grants.length ? grants.join(', ') : '(no variable write grants)'}`,
      `- **${id} read** (${report.read_modes[id]}): ${report.read_policies[id].join(', ') || '(no project file/data read grants)'}`,
    ]), '',
    '## Candidate discovery', '',
    ...Object.entries(report.discovery).flatMap(([id, d]) => [
      `- **${id}**: ${d.enabled ? `${d.rules.length} automatic rules; inventory truncated: ${d.truncated}` : 'disabled (manual rules only)'}`,
      `  - Prepared directories: ${d.prepared_directories.join(', ') || '(none added)'}`,
      ...d.limitations.map(s => `  - ${s}`),
    ]), '',
    '## Read candidate discovery', '',
    ...Object.entries(report.read_discovery).flatMap(([id, d]) => [
      `- **${id}**: ${d.enabled ? `${d.rules.length} input-structure rules; inventory truncated: ${d.truncated}` : 'automatic read discovery disabled'}`,
      ...d.limitations.map(s => `  - ${s}`),
    ]), '',
    '## Policy changes', '',
    '| Task | Permission | Round | Operation | Source | Decision | Actual scope change | Evidence |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...[report.searches, report.read_searches].flatMap(searches => Object.entries(searches).flatMap(([id, search]) => search.steps.map(s => `| ${id} | ${s.permission} | ${s.round} | ${markdownEscape(s.operation)} | ${s.source} | ${s.decision} | ${s.semantic_change ? 'yes' : 'no (overlapping grants)'} | [trial](evidence/${s.trial_id}.json)${s.recovery_id ? ` / [recovery](evidence/${s.recovery_id}.json)` : ''} |`))), '',
    '## Reused failure hints', '',
    'Identical failed candidate policies may guide splitting within one search round. These entries are not new trials or permanent necessity claims; the next round discards these hints.', '',
    '| Task | Permission | Round | Deferred comparison | Earlier failure |', '| --- | --- | --- | --- | --- |',
    ...[report.searches, report.read_searches].flatMap(searches => Object.entries(searches).flatMap(([id, search]) => search.reuses.map(r => `| ${id} | ${r.permission} | ${r.round} | ${markdownEscape(r.operation)} | [trial](evidence/${r.failed_trial_id}.json) |`))), '',
    '## Failure explanations', '',
    ...report.trials.filter(t => t.verdict !== 'pass').flatMap(t => {
      const step = [report.searches, report.read_searches].flatMap(searches => Object.values(searches).flatMap(s => s.steps)).find(s => s.trial_id === t.id);
      const recovery = step?.recovery_id ? report.trials.find(r => r.id === step.recovery_id) : undefined;
      const d = t.diagnosis;
      return [
        `### ${t.scenario} / ${t.phase} / ${t.id}`, '',
        `- Verdict: **${t.verdict}**; diagnosis: ${d?.kind ?? 'unavailable'}`,
        ...(step ? [`- ${step.permission} rule change: ${step.before.join(', ') || '(none)'} → ${step.after.join(', ') || '(none)'}`] : []),
        `- ${markdownEscape(d?.summary ?? t.reason ?? 'No explanation available')}`,
        ...d?.denials.map(e => `- Denial (${e.source}): ${markdownEscape(e.operation)} ${markdownEscape(e.path ?? '(path not captured)')}; ${markdownEscape(e.detail)}`) ?? [],
        ...d?.failed_assertions.map(c => `- Assertion ${markdownEscape(c.name)}: ${c.status}; ${markdownEscape(c.detail)}`) ?? [],
        ...d?.boundary_issues.map(c => `- Boundary ${markdownEscape(c.name)}: ${c.status}; ${markdownEscape(c.detail)}`) ?? [],
        ...(d?.stderr_excerpt ? [`- Task stderr excerpt: ${markdownEscape(d.stderr_excerpt)}`] : []),
        ...(recovery ? [`- Restored-policy recovery: **${recovery.verdict}** ([evidence](${recovery.evidence})). ${recovery.verdict === 'pass' ? 'The restored policy worked in this comparison; this is scenario-specific evidence.' : 'Recovery did not pass, so the policy comparison is inconclusive.'}`] : []),
        `- [Full trial evidence](${t.evidence})`, `- ${d?.log_limitations ?? 'Denial logs are incomplete.'}`, '',
      ];
    }),
    '## Executions', '', '| Task | Phase | Verdict | Duration (ms) | Evidence |', '| --- | --- | --- | --- | --- |',
    ...report.trials.map(t => `| ${t.scenario} | ${t.phase} | ${t.verdict} | ${t.duration_ms} | [${t.id}](${t.evidence}) |`), '',
    'A rejected removal with a passing recovery is evidence for this configuration and scenario, not proof of universal necessity.', '',
    'The JSON evidence contains assertions, controls, sandbox probes, bounded logs, effective backend configuration, violation events when available, and file changes.', '',
  ].join('\n');
}

type ExperimentInput = { config: Config; limits: Limits; project: string; configFile: string; limitsFile: string };
export async function runExperiment(options: {
  mode: 'run' | 'tighten' | 'doctor'; configPath?: string; limitsPath?: string; input?: ExperimentInput;
  output?: string; keepWorkspaces?: boolean; signal?: AbortSignal; onProgress?: (message: string) => void;
  frozenInput?: { path: string; hash: string; protectedPaths?: string[] };
}): Promise<Report> {
  requirePlatform();
  const input = options.input ?? await loadConfiguration(options.configPath!, options.limitsPath!);
  const { config, limits, project } = input;
  validatePolicy(config, limits);
  const id = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const output = path.resolve(options.output ?? path.join('.permsift', id));
  await fs.mkdir(path.dirname(output), { recursive: true });
  const canonicalOutput = path.join(await fs.realpath(path.dirname(output)), path.basename(output));
  if (within(project, canonicalOutput)) {
    const first = path.relative(project, canonicalOutput).split(path.sep)[0];
    if (!config.exclude.includes(first)) throw new Error('Output inside the project must be under an excluded top-level directory (e.g. .permsift)');
  }
  // No overwrite of previous evidence.
  await fs.mkdir(output, { mode: 0o700 });
  await fs.mkdir(path.join(output, 'evidence'), { mode: 0o700 });
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-')));
  const report: Report = {
    schema_version: 1, id, mode: options.mode, started_at: new Date().toISOString(), status: 'running',
    environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, permsift: VERSION, sandbox_runtime: BACKEND_VERSION },
    inputs: { project, config_file: input.configFile, limits_file: input.limitsFile, config_hash: hash(config), limits_hash: hash(limits) },
    scope: [
      'Directory write grants and opt-in project file/directory read grants are searched jointly; network policy remains fixed. Legacy tasks without initial_read_grants retain full workspace reads.',
      'Explicit read mode retains workspace-root directory listing/access, system/runtime, cache and temp reads. It does not hide project names or minimize those fixed grants.',
      'Fake project read fixtures test both allowed and denied expectations against the actual policy; they are write-protected, not explicitly read-denied.',
      'Home directories, the original project and experiment evidence are denied, except explicit run directories and a home-installed Node runtime tree; system/runtime read access remains broad.',
      'SRT device/stdio grants are fixed; its /tmp/claude write exceptions are explicitly denied. Inspect effective policy in evidence.',
      'Network tests cover a controlled loopback TCP endpoint, not every possible network channel.',
      'Trusted/reviewed project scripts only. Task-produced test reports are not proof against a malicious project.',
      'No global minimum or sandbox escape-resistance claim. Results apply to recorded inputs, assertions and environment.',
      'Process-group cleanup handles normal descendants; deliberately detached/daemonized processes are outside the supported workload contract.',
    ],
    trials: [], searches: {}, discovery: {}, read_discovery: {}, read_searches: {},
    policies: Object.fromEntries(config.scenarios.map(s => [s.id, s.initial_write_grants])),
    read_policies: Object.fromEntries(config.scenarios.map(s => [s.id, s.initial_read_grants ?? ['@workspace']])),
    read_modes: Object.fromEntries(config.scenarios.map(s => [s.id, s.initial_read_grants === undefined ? 'legacy' : 'explicit'])),
    baseline_verified: false, final_verified: false, search_complete: false, output: canonicalOutput,
    ...(options.keepWorkspaces ? { workspaces: scratch } : {}),
  };
  const checkpoint = async () => {
    await saveJson(path.join(output, 'report.json'), report);
    await fs.writeFile(path.join(output, 'report.md'), markdownReport(report), { mode: 0o600 });
  };
  let endpoint: Awaited<ReturnType<typeof startEndpoint>> | undefined;
  const deadline = Date.now() + limits.budget_seconds * 1000;
  let candidateCount = 0;
  const observations = new Map<string, Observation[]>();
  const readObservations = new Map<string, ReadObservation[]>();
  const prepared = new Map(config.scenarios.map(s => [s.id, [...new Set([...s.initial_write_grants, ...s.prepare_directories, ...s.narrower_candidates.flatMap(r => [r.from, ...r.to])])].sort()]));
  const hasTime = () => Date.now() < deadline && !options.signal?.aborted;
  try {
    await checkpoint();
    const inputRoot = path.join(scratch, 'input');
    report.inputs.snapshot_hash = await snapshot(options.frozenInput?.path ?? project, inputRoot, options.frozenInput ? [] : config.exclude, limits.max_snapshot_bytes);
    if (options.frozenInput && report.inputs.snapshot_hash !== options.frozenInput.hash) throw new Error('Frozen regression input changed between comparisons');
    // Stable locations based only on frozen input, never on candidate grants or outputs.
    const readProbeDirectories = [''];
    for (const name of ['src', 'bin', 'test']) {
      const stat = await fs.lstat(path.join(inputRoot, name)).catch(() => undefined);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) readProbeDirectories.push(name);
    }
    report.inputs.read_probe_directories = readProbeDirectories;
    await saveJson(path.join(output, 'inputs.json'), { config, limits, environment: report.environment, inputs: report.inputs });
    endpoint = await startEndpoint();
    const marker = randomUUID();
    const fixtureRoot = path.join(scratch, 'fixtures');
    await fs.mkdir(fixtureRoot);
    const fixtures: Fixtures = { secret: path.join(fixtureRoot, 'fake-secret'), outside: path.join(fixtureRoot, 'outside-marker'), report: path.join(canonicalOutput, 'report-guard'), marker, port: endpoint.port };
    for (const file of [fixtures.secret, fixtures.outside, fixtures.report]) await fs.writeFile(file, marker, { mode: 0o600 });

    const evaluate = async (scenario: Scenario, grants: string[], phase: string, readGrants = report.read_policies[scenario.id]) => {
      const trialId = randomUUID();
      const started = Date.now();
      const readMode = report.read_modes[scenario.id];
      const trial: Trial = { id: trialId, scenario: scenario.id, phase, grants, read_grants: readGrants, read_mode: readMode, verdict: 'unknown', duration_ms: 0, evidence: `evidence/${trialId}.json` };
      const evidence: Record<string, unknown> = { id: trialId, scenario: scenario.id, phase, grants, read_grants: readGrants, read_mode: readMode, policy_hash: hash({ write: grants, read: readGrants, readMode }) };
      if (phase.startsWith('candidate')) candidateCount++;
      options.onProgress?.(`${scenario.id} · ${phase} · write: ${grants.join(', ') || '(none)'}${readMode === 'explicit' ? ` · read: ${readGrants.join(', ') || '(none)'}` : ''}`);
      let roots: Roots | undefined;
      let task: Awaited<ReturnType<typeof executeSandbox>> | undefined;
      let assertions: Check[] = [];
      let boundaries: Check[] = [];
      try {
        if (!hasTime()) throw new Error(options.signal?.aborted ? 'Experiment interrupted' : 'Experiment budget exhausted');
        const runRoot = path.join(scratch, 'runs', trialId);
        roots = { workspace: path.join(runRoot, 'workspace'), cache: path.join(runRoot, 'cache'), tmp: path.join(runRoot, 'tmp') };
        await fs.mkdir(runRoot, { recursive: true });
        evidence.workspace_fork = await forkSnapshot(inputRoot, roots.workspace, { timeoutMs: Math.max(1, deadline - Date.now()), signal: options.signal });
        for (const directory of [roots.cache, roots.tmp]) await fs.mkdir(directory);
        const allPaths = prepared.get(scenario.id)!;
        evidence.prepared_directories = allPaths;
        for (const alias of new Set(allPaths)) {
          const directory = resolveAlias(alias, roots);
          const root = roots[alias.slice(1).split('/')[0] as keyof Roots];
          await noSymlinks(root, directory);
          await fs.mkdir(directory, { recursive: true });
        }
        // All file assertions are fresh outputs; stale artifacts never satisfy a run.
        for (const assertion of scenario.assertions) {
          const target = resolveAlias(assertion.path, roots);
          await noSymlinks(roots.workspace, target);
          await fs.rm(target, { force: true });
          await fs.mkdir(path.dirname(target), { recursive: true });
        }
        const trialFixtures: Fixtures = { ...fixtures };
        if (readMode === 'explicit') {
          trialFixtures.reads = [];
          for (const directory of readProbeDirectories) {
            const alias = '@workspace/' + (directory ? directory + '/' : '') + '.permsift-read-checks/fake-secret';
            // Reserved aliases cannot be configured, so map the fixture directly.
            const target = path.join(roots.workspace, directory, '.permsift-read-checks', 'fake-secret');
            await noSymlinks(roots.workspace, path.dirname(target));
            await fs.mkdir(path.dirname(target)); // Collision aborts instead of replacing input.
            await fs.writeFile(target, marker, { flag: 'wx', mode: 0o600 });
            trialFixtures.reads.push({ path: target, alias, expected: readGrants.some(grant => contains(grant, alias)) ? 'allowed' : 'denied' });
          }
        }
        const context: BackendContext = { roots, experimentRoot: scratch, protectedPaths: [project, input.configFile, input.limitsFile, canonicalOutput, options.frozenInput?.path ?? '', ...options.frozenInput?.protectedPaths ?? []].filter(Boolean), protectedWritePaths: trialFixtures.reads?.map(f => path.dirname(f.path)), grants, readGrants: readMode === 'explicit' ? readGrants : undefined, invocationId: trialId, timeoutMs: Math.max(1, Math.min(scenario.timeout_seconds * 1000, deadline - Date.now())), maxOutputBytes: limits.max_output_bytes, signal: options.signal };
        if (readMode === 'explicit') {
          context.readKinds = {};
          for (const alias of readGrants) {
            const target = resolveAlias(alias, roots);
            await noSymlinks(roots.workspace, target);
            const stat = await fs.lstat(target);
            if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Read grants must target regular files or directories: ${alias}`);
            context.readKinds[alias] = stat.isFile() ? 'file' : 'directory';
          }
          evidence.read_grant_kinds = context.readKinds;
        }
        evidence.policy_hash = hash({ write: grants, read: readGrants, readMode, readKinds: context.readKinds, prepared: allPaths });
        evidence.roots = roots;
        const before = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([name, root]) => [name, await manifest(root)] as const)));
        const inventoryBefore = phase === 'baseline' && scenario.auto_discover ? await directoryInventory(roots, limits) : undefined;
        const readInventoryBefore = ['baseline', 'discovery_baseline'].includes(phase) && readMode === 'explicit' && scenario.auto_read_discover ? await readInventory(roots, limits) : undefined;
        const pre = await boundaryChecks(trialFixtures, { ...context, invocationId: trialId + '-before' });
        evidence.before = pre;
        boundaries = pre.checks;
        if (pre.checks.some(c => c.status !== 'pass')) {
          trial.verdict = pre.checks.some(c => c.status === 'unknown') ? 'unknown' : 'fail';
          trial.reason = 'Pre-execution boundary check did not pass';
        } else {
          if (!hasTime()) throw new Error('Budget exhausted before task execution');
          task = await executeSandbox(scenario.command, { ...context, timeoutMs: Math.max(1, Math.min(context.timeoutMs, deadline - Date.now())) });
          evidence.task = task;
          assertions = await checkAssertions(scenario.assertions, roots);
          evidence.assertions = assertions;
          const post = await boundaryChecks(trialFixtures, { ...context, invocationId: trialId + '-after', timeoutMs: Math.max(1, Math.min(context.timeoutMs, deadline - Date.now())) });
          evidence.after = post;
          boundaries = [...pre.checks, ...post.checks];
          const changes = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([name, root]) => [name, diffFiles(before[name], await manifest(root))] as const)));
          evidence.file_changes = changes.workspace; // Preserve the v0.1 evidence field.
          evidence.file_changes_by_root = changes;
          trial.verdict = classifyTrial(task.process.status, task.process.exit_code, assertions, post.checks);
          if (!hasTime()) { trial.verdict = 'unknown'; trial.reason = 'Budget exhausted or interrupted before trial completion'; }
          if (readInventoryBefore && trial.verdict === 'pass') {
            const observation: ReadObservation = { ...readInventoryBefore, id: trialId };
            evidence.read_discovery_observation = observation;
            readObservations.set(scenario.id, [...readObservations.get(scenario.id) ?? [], observation]);
          }
          if (phase === 'baseline' && scenario.auto_discover && trial.verdict === 'pass') {
            const inventoryAfter = await directoryInventory(roots, limits);
            const observation: Observation = {
              id: trialId, directories: [...new Set([...(inventoryBefore?.directories ?? []), ...inventoryAfter.directories])],
              writes: Object.entries(changes).flatMap(([name, change]) => [...change.added, ...change.changed, ...change.removed].map(p => `@${name}/${p.split(path.sep).join('/')}`)),
              denial_paths: diagnose({ task, roots, assertions, boundaries, verdict: trial.verdict }).denials.flatMap(d => d.path?.startsWith('@') ? [d.path] : []),
              truncated: !!inventoryBefore?.truncated || inventoryAfter.truncated,
            };
            evidence.discovery_observation = observation;
            observations.set(scenario.id, [...observations.get(scenario.id) ?? [], observation]);
          }
        }
      } catch (error) {
        trial.verdict = 'unknown'; trial.reason = String(error); evidence.error = String(error);
      }
      if (!hasTime()) { trial.verdict = 'unknown'; trial.reason = options.signal?.aborted ? 'Experiment interrupted' : 'Experiment budget exhausted before evidence completion'; }
      trial.duration_ms = Date.now() - started;
      trial.diagnosis = diagnose({ task, roots, assertions, boundaries, verdict: trial.verdict, reason: trial.reason });
      evidence.diagnosis = trial.diagnosis;
      evidence.summary = trial;
      await saveJson(path.join(output, trial.evidence), evidence);
      report.trials.push(trial);
      await checkpoint();
      return { verdict: trial.verdict, id: trial.id };
    };

    let baselinePass = true;
    baseline: for (const scenario of config.scenarios) for (let i = 0; i < limits.repetitions; i++) {
      const result = await evaluate(scenario, scenario.initial_write_grants, 'baseline');
      if (result.verdict !== 'pass') { baselinePass = false; break baseline; }
    }
    if (baselinePass && options.mode === 'tighten') {
      for (const scenario of config.scenarios) {
        const plan = discover(scenario, observations.get(scenario.id) ?? [], limits);
        report.discovery[scenario.id] = plan;
        prepared.set(scenario.id, [...new Set([...prepared.get(scenario.id)!, ...plan.prepared_directories])].sort());
      }
      await checkpoint();
      // Automatic targets may require new directories. Confirm the baseline under
      // the same frozen preparation used by every candidate, recovery and final run.
      confirmation: for (const scenario of config.scenarios) {
        if (!report.discovery[scenario.id].prepared_directories.length) continue;
        for (let i = 0; i < limits.repetitions; i++) {
          const result = await evaluate(scenario, scenario.initial_write_grants, 'discovery_baseline');
          if (result.verdict !== 'pass') { baselinePass = false; break confirmation; }
        }
      }
    }
    if (baselinePass) for (const scenario of config.scenarios) {
      report.read_discovery[scenario.id] = discoverReads(scenario, readObservations.get(scenario.id) ?? [], limits);
    }
    report.baseline_verified = baselinePass;
    if (!baselinePass) {
      report.status = report.trials.at(-1)?.verdict === 'fail' ? 'failed' : 'incomplete';
      report.error = 'Baseline did not pass. No policy search was performed.';
    } else if (options.mode !== 'tighten') {
      report.final_verified = true;
      report.status = 'verified';
      report.search_complete = false;
    } else {
      const baselineMs = report.trials.reduce((sum, trial) => sum + trial.duration_ms, 0);
      const finalReserve = Math.max(5000, baselineMs * 2);
      for (const scenario of config.scenarios) {
        const runSearch = async (permission: 'write' | 'read') => {
          const searches = permission === 'write' ? report.searches : report.read_searches;
          const policies = permission === 'write' ? report.policies : report.read_policies;
          const roundOffset = searches[scenario.id]?.rounds ?? 0;
          const search = await searchPolicy(scenario, {
            permission, initialGrants: policies[scenario.id],
            automatic: permission === 'write' ? report.discovery[scenario.id]?.rules : report.read_discovery[scenario.id]?.rules,
            evaluate: (grants, phase) => permission === 'write' ? evaluate(scenario, grants, phase) : evaluate(scenario, report.policies[scenario.id], phase, grants),
            canContinue: () => hasTime() && candidateCount < limits.max_candidates && Date.now() + finalReserve < deadline,
            onStep: async step => {
              const summary = searches[scenario.id] ??= { stop: 'running', steps: [], rounds: 0, reuses: [] };
              summary.steps.push({ ...step, round: roundOffset + step.round });
              summary.rounds = roundOffset + step.round;
              if (step.decision === 'accepted') policies[scenario.id] = step.after;
              await checkpoint();
            },
            onReuse: async reuse => {
              const summary = searches[scenario.id] ??= { stop: 'running', steps: [], rounds: 0, reuses: [] };
              summary.reuses.push({ ...reuse, round: roundOffset + reuse.round });
              summary.rounds = roundOffset + reuse.round;
              await checkpoint();
            },
          });
          const summary = searches[scenario.id] ??= { stop: 'running', steps: [], rounds: 0, reuses: [] };
          summary.stop = search.stop;
          summary.rounds = roundOffset + search.rounds;
          policies[scenario.id] = search.grants;
          return search;
        };
        // Reads can change task behavior and write requirements. Revisit writes
        // after a read change; stop only at a joint fixed point or a search limit.
        let readSearched = false;
        while (true) {
          const write = await runSearch('write');
          if (write.stop === 'unstable') break;
          if (report.read_modes[scenario.id] === 'legacy') break;
          // The preceding read search exhausted its operators under these writes.
          // If writes did not change, rerunning that same search adds no new comparison.
          if (readSearched && !write.steps.some(s => s.decision === 'accepted')) break;
          const read = await runSearch('read');
          readSearched = true;
          if (read.stop !== 'exhausted' || write.stop !== 'exhausted' || !read.steps.some(s => s.decision === 'accepted')) break;
        }
        if ([report.searches[scenario.id], report.read_searches[scenario.id]].some(s => s?.stop === 'unstable')) break;
      }
      const allSearches = [...Object.values(report.searches), ...Object.values(report.read_searches)];
      report.search_complete = Object.keys(report.searches).length === config.scenarios.length && Object.keys(report.read_searches).length === config.scenarios.filter(s => s.initial_read_grants !== undefined).length && allSearches.every(s => s.stop === 'exhausted' && s.steps.every(step => step.decision !== 'unknown'));
      let finalPass = true;
      final: for (const scenario of config.scenarios) for (let i = 0; i < limits.repetitions; i++) {
        const result = await evaluate(scenario, report.policies[scenario.id], 'final');
        if (result.verdict !== 'pass') { finalPass = false; break final; }
      }
      report.final_verified = finalPass;
      report.status = finalPass && allSearches.every(s => s.stop !== 'unstable') ? 'verified' : 'incomplete';
    }
  } catch (error) { report.status = 'incomplete'; report.error = String(error); }
  finally {
    if (endpoint) await closeEndpoint(endpoint.server);
    if (!options.keepWorkspaces) {
      try { await fs.rm(scratch, { recursive: true, force: true }); }
      catch (error) { report.status = 'incomplete'; report.error = `Workspace cleanup failed: ${String(error)}`; report.workspaces = scratch; }
    }
    if (options.signal?.aborted) { report.status = 'incomplete'; report.error = 'Experiment interrupted'; }
    report.finished_at = new Date().toISOString();
    const name = report.status === 'verified' ? 'recommended.yaml' : 'unverified-candidate.yaml';
    if (options.mode !== 'doctor') await fs.writeFile(path.join(output, name), stringify({ ...config, project, scenarios: config.scenarios.map(s => ({ ...s, initial_write_grants: report.policies[s.id], ...(s.initial_read_grants === undefined ? {} : { initial_read_grants: report.read_policies[s.id] }), prepare_directories: prepared.get(s.id) })) }), { mode: 0o600 });
    await checkpoint();
  }
  return report;
}
