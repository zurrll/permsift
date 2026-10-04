import { captureSuccessMaterials } from './success-materials.js';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { configSchema, limitsSchema, isStaged, installationScenario, initialPreparation, loadConfiguration, validatePolicy, type Config, type Limits, type Scenario } from './config.js';
import { BACKEND_VERSION, requirePlatform } from './backend.js';
import { snapshot, snapshotHash, forkSnapshot, hash, within, saveJson } from './filesystem.js';
import { startEndpoint, closeEndpoint, type Fixtures } from './probes.js';
import { searchPolicy, type Permission } from './search.js';
import { discover, type Observation } from './discovery.js';
import { diagnose } from './diagnostics.js';
import { discoverReads, type ReadObservation } from './read-discovery.js';
import { InstalledSnapshots, installationKey } from './installed-snapshot.js';
import { Timings, summarizeTimings } from './timing.js';
import { inspectInstall, npmVersion, type InstallInput } from './install.js';
import { executionRequest } from './execution-request.js';
import { executeOnce } from './execute-once.js';
import { ExecutionJournal } from './execution-journal.js';
import { nativeExecution } from './model/native.js';
import type { ExecutionPhase } from './execution-phase.js';
import { publishSummary } from './result-output.js';
import type { ProgressEvent } from './progress.js';

import { VERSION } from './version.js';
export { VERSION } from './version.js';
import { markdownReport, trialReport, evidenceReport, type Report } from './experiment-report.js';
export { markdownReport, type Report, type Trial } from './experiment-report.js';
export { classifyTrial } from './execution-verdict.js';

type ExperimentInput = { config: Config; limits: Limits; project: string; configFile: string; limitsFile: string };
export type ExperimentOptions = {
  mode: 'run' | 'tighten' | 'doctor' | 'observe'; configPath?: string; limitsPath?: string; input?: ExperimentInput;
  output?: string; keepWorkspaces?: boolean; saveArtifacts?: boolean; signal?: AbortSignal; onProgress?: (message: string) => void;
  onProgressEvent?: (event: ProgressEvent) => void;
  expectedReadKinds?: Record<string, Record<string, 'file' | 'directory'>>;
  frozenInput?: { path: string; hash: string; protectedPaths?: string[] };
  /** Diagnostic harness only: observe post-install/pre-task state, adding full scans. */
  measureInstalledState?: boolean;
};

export async function runExperiment(options: ExperimentOptions): Promise<Report> {
  return (await runExperimentWithFacts(options)).report;
}

export async function runExperimentWithFacts(options: ExperimentOptions): Promise<{ report: Report; execution: ExecutionPhase }> {
  const experimentTimings = new Timings();
  requirePlatform();
  const input = options.input ? { ...options.input, config: configSchema.parse(options.input.config), limits: limitsSchema.parse(options.input.limits) } : await loadConfiguration(options.configPath!, options.limitsPath!);
  const { config, limits, project } = input;
  validatePolicy(config, limits, options.mode === 'observe');
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
  await fs.mkdir(path.join(output, 'executions'), { mode: 0o700 });
  const journal = new ExecutionJournal(output);
  const retainedTasks = new Set<string>();
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-')));
  const report: Report = {
    schema_version: 1, id, mode: options.mode, started_at: new Date().toISOString(), status: 'running',
    environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, permsift: VERSION, sandbox_runtime: BACKEND_VERSION },
    inputs: { project, config_file: input.configFile, limits_file: input.limitsFile, config_hash: hash(config), limits_hash: hash(limits) },
    scope: [
      'Separate install write policies opt into staged execution. Install retains broad reads; offline tasks search project reads and writes on a frozen installed state. Legacy install configs retain shared writes.',
      'Explicit read mode retains workspace-root directory listing/access, system/runtime, cache and temp reads. It does not hide project names or minimize those fixed grants.',
      'Fake project read fixtures test both allowed and denied expectations against the actual policy; they are write-protected, not explicitly read-denied.',
      'Home directories, the original project and experiment evidence are denied, except explicit run directories and a home-installed Node runtime tree; system/runtime read access remains broad.',
      'SRT device/stdio grants are fixed; its /tmp/claude write exceptions are explicitly denied. Inspect effective policy in evidence.',
      'Network probes cover direct loopback denial and an authenticated proxy request to a reserved denied domain; they do not test every network channel.',
      'Trusted/reviewed project scripts only. Task-produced test reports are not proof against a malicious project.',
      'No global minimum or sandbox escape-resistance claim. Results apply to recorded inputs, assertions and environment.',
      'Process-group cleanup handles normal descendants; deliberately detached/daemonized processes are outside the supported workload contract.',
    ],
    trials: [], searches: {}, discovery: {}, read_discovery: {}, read_searches: {},
    install_policies: Object.fromEntries(config.scenarios.filter(isStaged).map(s => [s.id, s.install!.initial_write_grants!])), install_searches: {}, install_discovery: {}, installation_stats: {},
    network_searches: {}, network_policies: Object.fromEntries(config.scenarios.map(s => [s.id, s.initial_network_grants ?? []])),
    policies: Object.fromEntries(config.scenarios.map(s => [s.id, s.initial_write_grants])),
    read_policies: Object.fromEntries(config.scenarios.map(s => [s.id, s.initial_read_grants ?? ['@workspace']])),
    read_modes: Object.fromEntries(config.scenarios.map(s => [s.id, s.initial_read_grants === undefined ? 'legacy' : 'explicit'])),
    baseline_verified: false, final_verified: false, search_complete: false, output: canonicalOutput,
    ...(options.mode === 'observe' ? { dependency_observations: {} } : {}),
    ...(options.keepWorkspaces ? { workspaces: scratch } : {}),
  };
  const execution: ExecutionPhase = { status: 'running', baselineVerified: false, finalVerified: false,
    taskKeys: config.scenarios.map(s => s.id), trials: [], observations: {} };
  if (options.mode === 'observe') report.scope.unshift('Observation executes each configured task once. A passing task is not a repeated policy baseline; no policy recommendation or search is produced. The task-only observer adds a write-protected builtin preload and one internal trace directory write exception.');
  const updateTimings = () => {
    const setup = experimentTimings.snapshot();
    report.timings = summarizeTimings(setup.total_ms, [setup, ...report.trials.flatMap(t => t.timings ? [t.timings] : [])]);
  };
  const checkpoint = async () => experimentTimings.measure('reporting', async () => {
    updateTimings();
    report.status = execution.status; report.baseline_verified = execution.baselineVerified; report.final_verified = execution.finalVerified;
    await saveJson(path.join(output, 'report.json'), report);
    await fs.writeFile(path.join(output, 'report.md'), markdownReport(report), { mode: 0o600 });
  });
  let endpoint: Awaited<ReturnType<typeof startEndpoint>> | undefined;
  const deadline = Date.now() + limits.budget_seconds * 1000;
  let candidateCount = 0;
  const observations = new Map<string, Observation[]>();
  const readObservations = new Map<string, ReadObservation[]>();
  const progressAttempts = new Map<string, number>();
  const installObservations = new Map<string, Observation[]>();
  const installed = new InstalledSnapshots(path.join(scratch, 'installed'), limits.max_snapshot_bytes);
  const installedKinds = new Map<string, Record<string, 'file' | 'directory'>>();
  const prepared = new Map(config.scenarios.map(s => [s.id, initialPreparation(s)]));
  const hasTime = () => Date.now() < deadline && !options.signal?.aborted;
  try {
    await checkpoint();
    const inputRoot = path.join(scratch, 'input');
    if (options.frozenInput) {
      report.inputs.snapshot_fork = await experimentTimings.measure('clone', () => forkSnapshot(options.frozenInput!.path, inputRoot, { timeoutMs: Math.max(1, deadline - Date.now()), signal: options.signal }));
      report.inputs.snapshot_hash = await experimentTimings.measure('hash', () => snapshotHash(inputRoot, limits.max_snapshot_bytes, false, { signal: options.signal, timeoutMs: Math.max(0, deadline - Date.now()), onProfile: p => experimentTimings.recordHashScan(p) }));
    } else report.inputs.snapshot_hash = await experimentTimings.measure('freeze', () => snapshot(project, inputRoot, config.exclude, limits.max_snapshot_bytes));
    execution.inputHash = report.inputs.snapshot_hash as string;
    if (options.frozenInput && report.inputs.snapshot_hash !== options.frozenInput.hash) throw new Error('Frozen regression input changed between comparisons');
    const installations = new Map<string, InstallInput>();
    for (const scenario of config.scenarios) if (scenario.install) installations.set(scenario.id, await experimentTimings.measure('preparation', () => inspectInstall(scenario, inputRoot, experimentTimings)));
    if (installations.size) { report.inputs.installations = Object.fromEntries(installations); report.environment.npm = await experimentTimings.measure('preparation', () => npmVersion()); }
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

    // Workflow intent is resolved here; the runner receives no phase/search/report state.
    const evaluate = async (scenario: Scenario, grants: string[], phase: string, readGrants = report.read_policies[scenario.id], networkGrants = report.network_policies[scenario.id], stage: { taskOnly?: boolean; capture?: boolean; installGrants?: string[] } = {}) => {
      const staged = isStaged(scenario), readMode = report.read_modes[scenario.id];
      const installGrants = stage.installGrants ?? report.install_policies[scenario.id] ?? grants;
      const allPaths = prepared.get(scenario.id)!;
      const key = installationKey({ snapshot: execution.inputHash, environment: report.environment, installation: { id: scenario.id, ...installations.get(scenario.id), config: scenario.install }, policy: { write: installGrants, network: networkGrants }, preparation: allPaths, limits });
      const collectReads = ['baseline', 'discovery_baseline', 'installation_snapshot'].includes(phase) && readMode === 'explicit' && scenario.auto_read_discover;
      const request = executionRequest({ scenario, policy: { write: grants, read: readGrants, readMode, network: networkGrants, installWrite: installGrants },
        conditions: { input: { path: inputRoot, hash: execution.inputHash! }, configHash: hash(config), limitsHash: hash(limits), scenarioHash: hash(scenario), environment: report.environment, preparation: allPaths,
          expectedReadKinds: options.expectedReadKinds?.[scenario.id] ?? (staged && !stage.capture && !['baseline', 'discovery_baseline'].includes(phase) ? installedKinds.get(scenario.id) : undefined) },
        sources: { inputDirectories: phase === 'baseline' && (scenario.auto_discover || staged && installationScenario(scenario).auto_discover), installedDirectories: staged && phase === 'baseline',
          afterTaskDirectories: phase === 'baseline' && scenario.auto_discover, readInventory: collectReads, dependencies: options.mode === 'observe', installedState: !!options.measureInstalledState },
        limits, workspace: stage.taskOnly ? { kind: 'installed', snapshot: installed.get(key) } : { kind: 'input' },
        capture: stage.capture ? { directory: path.join(scratch, 'installed'), key } : undefined,
        budget: { deadline, signal: options.signal }, resources: { scratch, fixtures, readProbeDirectories, installInput: installations.get(scenario.id),
          protectedPaths: [project, input.configFile, input.limitsFile, canonicalOutput, options.frozenInput?.path ?? '', ...options.frozenInput?.protectedPaths ?? []].filter(Boolean) } });
      if (phase.startsWith('candidate')) candidateCount++;
      options.onProgress?.(`${scenario.id} · ${phase} · write: ${grants.join(', ') || '(none)'}${readMode === 'explicit' ? ` · read: ${readGrants.join(', ') || '(none)'}` : ''}${scenario.install ? ` · network: ${networkGrants.join(', ') || '(offline)'}` : ''}${staged ? ` · install write: ${installGrants.join(', ') || '(none)'} · ${stage.taskOnly ? 'snapshot' : 'fresh install'}` : ''}`);
      const progressKey = scenario.id + ':' + phase, attempt = (progressAttempts.get(progressKey) ?? 0) + 1;
      progressAttempts.set(progressKey, attempt);
      const progress = { task: scenario.id, phase, attempt,
        ...['baseline', 'final', 'observe'].includes(phase) ? { repetitions: options.mode === 'observe' ? 1 : limits.repetitions } : {} };
      options.onProgressEvent?.({ ...progress, stage: 'prepare' });
      const result = await executeOnce(request, stage => options.onProgressEvent?.({ ...progress, stage })), details = result.details;
      if (!hasTime()) {
        result.verdict = 'unknown'; result.reason = options.signal?.aborted ? 'Experiment interrupted' : 'Experiment budget exhausted before evidence completion';
        if (result.observation) result.observation.verdict = 'unknown';
      }
      // A failed install is not evidence for domain removal without a captured denial.
      if (phase === 'candidate_network' && details.installation?.verdict === 'fail' && !details.installation.execution.violations.some(v => /deny network-outbound /.test(v.line))) {
        result.verdict = 'unknown'; result.reason = 'Install failed without independently captured domain denial; network removal is inconclusive';
      }
      result.diagnosis = { ...diagnose({ task: details.task ?? details.installation?.execution, roots: details.roots, assertions: details.assertions ?? [],
        boundaries: [details.before, details.after_installation, details.before_offline_task, details.after].flatMap(s => s?.checks ?? []), verdict: result.verdict, reason: result.reason, installationChecks: details.installation?.bundled_checks }),
        ...(staged ? { stage: result.execution_stage } : {}) };
      details.diagnosis = result.diagnosis;
      const trial = trialReport(result, { scenario: scenario.id, phase, policy: request.policy, staged, requestedReuse: !!stage.taskOnly });
      const stats = staged ? report.installation_stats[scenario.id] ??= { executed: 0, reused: 0, snapshots: 0 } : undefined;
      if (stats) { if (result.installationAttempted) stats.executed++; if (result.installationReused) stats.reused++; }
      const pending = result.pendingSnapshot && result.verdict === 'pass' ? result.pendingSnapshot : undefined;
      const facts = nativeExecution(request, result, { producer_id: id, record: `executions/${result.id}.json`, phase });
      const retainedPhase = options.mode === 'tighten' ? 'final' : options.mode === 'observe' ? 'observe' : 'baseline';
      const successArtifacts = options.saveArtifacts && phase === retainedPhase && result.verdict === 'pass' && !retainedTasks.has(scenario.id) && details.roots
        ? await experimentTimings.measure('artifact_capture', () => captureSuccessMaterials({ output, roots: details.roots!, assertions: scenario.assertions, signal: options.signal,
          source: { trial: result.id, task: scenario.id, execution_id: facts.execution.id, task_id: facts.task.id, policy_id: facts.policy.id, phase: retainedPhase } })) : undefined;
      if (successArtifacts) retainedTasks.add(scenario.id);
      const evidence = { ...evidenceReport(trial, details, pending ? { key, hashes: pending.hashes, source_trial: result.id } : undefined),
        ...successArtifacts ? { success_artifacts: successArtifacts } : {} };
      await experimentTimings.measure('reporting', () => journal.record(trial, evidence, facts, async () => {
        report.trials.push(trial);
        try { await checkpoint(); } catch (error) { report.trials.pop(); throw error; }
      }));
      // Only durable, complete evidence can become reusable workflow state.
      execution.trials.push({ id: result.id, verdict: result.verdict, diagnosis: result.diagnosis });
      if (pending && hasTime()) { installed.publish(pending); stats!.snapshots++; stats!.snapshot_key = key; stats!.hashes = pending.hashes; }
      if (staged && (stage.capture || stage.taskOnly) && details.read_grant_kinds) installedKinds.set(scenario.id, { ...installedKinds.get(scenario.id), ...details.read_grant_kinds });
      if (result.observation) { execution.observations[scenario.id] = result.observation; report.dependency_observations![scenario.id] = result.observation; }
      if (details.read_discovery_observation) readObservations.set(scenario.id, [...readObservations.get(scenario.id) ?? [], details.read_discovery_observation]);
      if (details.discovery_observation) observations.set(scenario.id, [...observations.get(scenario.id) ?? [], details.discovery_observation]);
      if (phase === 'baseline' && staged && details.install_file_changes && details.task_inventory) {
        installObservations.set(scenario.id, [...installObservations.get(scenario.id) ?? [], { id: result.id,
          directories: [...new Set([...(details.input_inventory?.directories ?? []), ...details.task_inventory.directories])],
          writes: Object.entries(details.install_file_changes).flatMap(([name, change]) => [...change.added, ...change.changed, ...change.removed].map(p => `@${name}/${p.split(path.sep).join('/')}`)),
          denial_paths: [], truncated: !!details.input_inventory?.truncated || details.task_inventory.truncated }]);
      }
      if (!options.keepWorkspaces) await experimentTimings.measure('cleanup', () => fs.rm(path.join(scratch, 'runs', result.id), { recursive: true, force: true }));
      await checkpoint();
      return { verdict: result.verdict, id: result.id };
    };

    let baselinePass = true;
    baseline: for (const scenario of config.scenarios) for (let i = 0; i < (options.mode === 'observe' ? 1 : limits.repetitions); i++) {
      const result = await evaluate(scenario, scenario.initial_write_grants, options.mode === 'observe' ? 'observe' : 'baseline');
      if (result.verdict !== 'pass') { baselinePass = false; if (options.mode !== 'observe') break baseline; }
    }
    if (baselinePass && options.mode === 'tighten') {
      for (const scenario of config.scenarios) {
        const plan = discover(scenario, observations.get(scenario.id) ?? [], limits);
        report.discovery[scenario.id] = plan;
        if (isStaged(scenario)) {
          const installPlan = discover(installationScenario(scenario), installObservations.get(scenario.id) ?? [], limits);
          report.install_discovery[scenario.id] = installPlan;
          prepared.set(scenario.id, [...new Set([...prepared.get(scenario.id)!, ...installPlan.prepared_directories])].sort());
        }
        prepared.set(scenario.id, [...new Set([...prepared.get(scenario.id)!, ...plan.prepared_directories])].sort());
      }
      await checkpoint();
      // Automatic targets may require new directories. Confirm the baseline under
      // the same frozen preparation used by every candidate, recovery and final run.
      confirmation: for (const scenario of config.scenarios) {
        if (!report.discovery[scenario.id].prepared_directories.length && !report.install_discovery[scenario.id]?.prepared_directories.length) continue;
        for (let i = 0; i < limits.repetitions; i++) {
          const result = await evaluate(scenario, scenario.initial_write_grants, 'discovery_baseline');
          if (result.verdict !== 'pass') { baselinePass = false; break confirmation; }
        }
      }
    }
    if (baselinePass && options.mode !== 'observe') for (const scenario of config.scenarios) {
      report.read_discovery[scenario.id] = discoverReads(scenario, readObservations.get(scenario.id) ?? [], limits);
    }
    execution.baselineVerified = baselinePass;
    if (!baselinePass) {
      execution.status = options.mode === 'observe' ? (report.trials.some(t => t.verdict === 'unknown') ? 'incomplete' : 'failed') : report.trials.at(-1)?.verdict === 'fail' ? 'failed' : 'incomplete';
      report.error = 'Baseline did not pass. No policy search was performed.';
    } else if (options.mode !== 'tighten') {
      execution.finalVerified = true;
      execution.status = 'verified';
      report.search_complete = false;
    } else {
      const baselineMs = report.trials.reduce((sum, trial) => sum + trial.duration_ms, 0);
      const finalReserve = Math.max(5000, baselineMs * 2);
      for (const scenario of config.scenarios) {
        const runSearch = async (permission: Permission, installStage = false) => {
          const searches = permission === 'network' ? report.network_searches : permission === 'write' ? installStage ? report.install_searches : report.searches : report.read_searches;
          const policies = permission === 'network' ? report.network_policies : permission === 'write' ? installStage ? report.install_policies : report.policies : report.read_policies;
          const roundOffset = searches[scenario.id]?.rounds ?? 0;
          const search = await searchPolicy(installStage ? installationScenario(scenario) : scenario, {
            permission, initialGrants: policies[scenario.id],
            automatic: permission === 'network' ? [] : permission === 'write' ? (installStage ? report.install_discovery : report.discovery)[scenario.id]?.rules : report.read_discovery[scenario.id]?.rules,
            evaluate: (grants, phase) => permission === 'network' ? evaluate(scenario, report.policies[scenario.id], phase, report.read_policies[scenario.id], grants) : installStage ? evaluate(scenario, report.policies[scenario.id], phase + '_install', report.read_policies[scenario.id], report.network_policies[scenario.id], { installGrants: grants }) : evaluate(scenario, permission === 'write' ? grants : report.policies[scenario.id], phase, permission === 'read' ? grants : report.read_policies[scenario.id], report.network_policies[scenario.id], { taskOnly: isStaged(scenario) }),
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
        if (isStaged(scenario)) {
          let installationWritesSearched = false;
          while (true) {
            const network = await runSearch('network');
            if (network.stop === 'unstable' || installationWritesSearched && !network.steps.some(s => s.decision === 'accepted')) break;
            const write = await runSearch('write', true); installationWritesSearched = true;
            if (network.stop !== 'exhausted' || write.stop !== 'exhausted' || !write.steps.some(s => s.decision === 'accepted')) break;
          }
          if ([report.install_searches[scenario.id], report.network_searches[scenario.id]].some(s => s?.stop === 'unstable')) break;
          const freeze = await evaluate(scenario, report.policies[scenario.id], 'installation_snapshot', report.read_policies[scenario.id], report.network_policies[scenario.id], { capture: true });
          if (freeze.verdict !== 'pass') { report.error = 'A complete trial could not establish a verified installed snapshot'; break; }
          // Only this frozen installed state contributes task-read candidates.
          report.read_discovery[scenario.id] = discoverReads(scenario, (readObservations.get(scenario.id) ?? []).filter(o => o.id === freeze.id), limits);
        }
        let readSearched = false;
        let installWritesSearched = false;
        while (true) {
          if (scenario.install && !isStaged(scenario)) {
            // Network first: slow cold installs must not spend the entire
            // candidate budget on filesystem changes before checking domains.
            const network = await runSearch('network');
            if (network.stop === 'unstable') break;
            if (installWritesSearched && !network.steps.some(s => s.decision === 'accepted')) break;
            const write = await runSearch('write');
            installWritesSearched = true;
            if (network.stop !== 'exhausted' || write.stop !== 'exhausted' || !write.steps.some(s => s.decision === 'accepted')) break;
            continue;
          }
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
        if ([report.searches[scenario.id], report.read_searches[scenario.id], report.network_searches[scenario.id]].some(s => s?.stop === 'unstable')) break;
      }
      const allSearches = [...Object.values(report.searches), ...Object.values(report.install_searches), ...Object.values(report.read_searches), ...Object.values(report.network_searches)];
      report.search_complete = Object.keys(report.install_searches).length === config.scenarios.filter(isStaged).length && Object.keys(report.searches).length === config.scenarios.length && Object.keys(report.read_searches).length === config.scenarios.filter(s => s.initial_read_grants !== undefined).length && Object.keys(report.network_searches).length === config.scenarios.filter(s => s.install).length && allSearches.every(s => s.stop === 'exhausted' && s.steps.every(step => step.decision !== 'unknown'));
      let finalPass = true;
      final: for (const scenario of config.scenarios) for (let i = 0; i < limits.repetitions; i++) {
        const result = await evaluate(scenario, report.policies[scenario.id], 'final');
        if (result.verdict !== 'pass') { finalPass = false; break final; }
      }
      execution.finalVerified = finalPass;
      execution.status = finalPass && !report.error && allSearches.every(s => s.stop !== 'unstable') ? 'verified' : 'incomplete';
    }
  } catch (error) { execution.status = 'incomplete'; report.error = String(error); }
  finally {
    if (endpoint) await closeEndpoint(endpoint.server);
    if (!options.keepWorkspaces) {
      try { await experimentTimings.measure('cleanup', () => fs.rm(scratch, { recursive: true, force: true })); }
      catch (error) { execution.status = 'incomplete'; report.error = `Workspace cleanup failed: ${String(error)}`; report.workspaces = scratch; }
    }
    if (options.signal?.aborted) { execution.status = 'incomplete'; report.error = 'Experiment interrupted'; }
    report.finished_at = new Date().toISOString();
    const name = execution.status === 'verified' ? 'recommended.yaml' : 'unverified-candidate.yaml';
    if (options.mode !== 'doctor' && options.mode !== 'observe') await fs.writeFile(path.join(output, name), stringify({ ...config, project, scenarios: config.scenarios.map(s => ({ ...s, initial_write_grants: report.policies[s.id], ...(s.initial_read_grants === undefined ? {} : { initial_read_grants: report.read_policies[s.id] }), ...(s.install ? { initial_network_grants: report.network_policies[s.id], ...(isStaged(s) ? { install: { ...s.install, initial_write_grants: report.install_policies[s.id] } } : {}) } : {}), prepare_directories: prepared.get(s.id) })) }), { mode: 0o600 });
    await checkpoint();
  }
  await publishSummary(path.join(output, 'report.json'), path.join(output, 'report.md'));
  return { report, execution };
}
