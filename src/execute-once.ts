import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { contains } from './config.js';
import { executeSandbox, type BackendContext } from './backend.js';
import { forkSnapshot, hash, noSymlinks, resolveAlias, manifest, diffFiles, type Roots } from './filesystem.js';
import { checkAssertions, type Check } from './assertions.js';
import { boundaryChecks, type Fixtures } from './probes.js';
import type { TrialVerdict } from './search.js';
import { directoryInventory, type Observation } from './discovery.js';
import { diagnose, type Diagnosis } from './diagnostics.js';
import { readInventory, type ReadObservation } from './read-discovery.js';
import { captureInstalledSnapshot, forkInstalledSnapshot, rootHashes, type InstalledSnapshot } from './installed-snapshot.js';
import { Timings, type TimingSummary } from './timing.js';
import { executeInstall, prepareInstallCache } from './install.js';
import { prepareObservation, collectObservation, type ObservationSetup, type TaskObservation } from './observation.js';
import { compilationCommand, collectCompilation } from './typescript-observation.js';
import { prepareBundling, collectBundling } from './esbuild-observation.js';
import { classifyTrial } from './execution-verdict.js';
import type { ExecutionRequest } from './execution-request.js';

type SandboxExecution = Awaited<ReturnType<typeof executeSandbox>>;
type Inventory = Awaited<ReturnType<typeof directoryInventory>>;
type Changes = ReturnType<typeof diffFiles>;
type RootManifests = Record<string, Record<string, string>>;
export type ExecutionDetails = {
  workspace_fork?: Awaited<ReturnType<typeof forkSnapshot>>;
  installed_snapshot?: Awaited<ReturnType<typeof forkInstalledSnapshot>>;
  install_cache?: Awaited<ReturnType<typeof prepareInstallCache>>;
  prepared_directories?: string[]; read_grant_kinds?: Record<string, 'file' | 'directory'>;
  task_policy_hash?: string; policy_hash?: string; install_policy_hash?: string;
  roots?: Roots; stage_policy_mode?: 'shared' | 'separate';
  before?: Awaited<ReturnType<typeof boundaryChecks>>; after_installation?: Awaited<ReturnType<typeof boundaryChecks>>;
  before_offline_task?: Awaited<ReturnType<typeof boundaryChecks>>; after?: Awaited<ReturnType<typeof boundaryChecks>>;
  installation?: Awaited<ReturnType<typeof executeInstall>>;
  install_file_changes?: Record<string, Changes>; installation_state?: { hashes: Record<keyof Roots, string>; files: RootManifests };
  task_input_changes_base?: RootManifests; task_inventory?: Inventory; input_inventory?: Inventory;
  observer?: { source: string; bootstrap: string; collector: string; bootstrap_hash: string; internal_write_exception: string; instrumentation_applies_to: string; compilation?: Record<string, unknown>; bundling?: Record<string, unknown> };
  task?: SandboxExecution; task_skipped?: string; assertions?: Check[];
  file_changes?: Changes; file_changes_by_root?: Record<string, Changes>;
  read_discovery_observation?: ReadObservation; discovery_observation?: Observation;
  dependency_observation?: TaskObservation; error?: string; diagnosis?: Diagnosis;
};
export type ExecutionResult = {
  id: string; verdict: TrialVerdict; duration_ms: number; reason?: string;
  execution_stage?: 'install' | 'task'; diagnosis?: Diagnosis; timings?: TimingSummary;
  actualCommand?: string[]; details: ExecutionDetails;
  installationAttempted: boolean; installationReused: boolean; pendingSnapshot?: InstalledSnapshot;
  observation?: TaskObservation;
};

/** One controlled trial. No candidates, repetitions, report paths, or snapshot publication. */
export async function executeOnce(request: ExecutionRequest): Promise<ExecutionResult> {
  const { task: scenario, limits, sources } = request;
  const { scratch, fixtures, readProbeDirectories } = request.resources;
  const marker = fixtures.marker, inputRoot = request.conditions.input.path, deadline = request.budget.deadline;
  const taskOnly = request.workspace.kind === 'installed';
  const hasTime = () => Date.now() < deadline && !request.budget.signal?.aborted;
  const timings = new Timings();
  const trialId = randomUUID(), started = Date.now(), staged = request.staged;
  const { write: grants, read: readGrants, readMode, network: networkGrants, installWrite: installGrants } = request.policy;
  const trial: ExecutionResult = { id: trialId, verdict: 'unknown', duration_ms: 0, details: {}, installationAttempted: false, installationReused: false };
  const evidence = trial.details;
  let roots: Roots | undefined, task: Awaited<ReturnType<typeof executeSandbox>> | undefined;
  let observer: ObservationSetup | undefined;
  let assertions: Check[] = [], boundaries: Check[] = [], pendingSnapshot: InstalledSnapshot | undefined;
  const scanRoots = () => timings.measure('manifest', async () => Object.fromEntries(
    await Promise.all(Object.entries(roots!).map(async ([name, root]) => [name, await manifest(root)] as const)),
  ));
  try {
    if (!hasTime()) throw new Error(request.budget.signal?.aborted ? 'Experiment interrupted' : 'Experiment budget exhausted');
    const runRoot = path.join(scratch, 'runs', trialId);
    roots = { workspace: path.join(runRoot, 'workspace'), cache: path.join(runRoot, 'cache'), tmp: path.join(runRoot, 'tmp') };
    await fs.mkdir(runRoot, { recursive: true });
    const allPaths = request.conditions.preparation;

    const forkOptions = () => ({ timeoutMs: Math.max(1, deadline - Date.now()), signal: request.budget.signal, timings });
    if (taskOnly) {
      evidence.installed_snapshot = await forkInstalledSnapshot((request.workspace as Extract<ExecutionRequest['workspace'], { kind: 'installed' }>).snapshot, limits.max_snapshot_bytes, roots, forkOptions());
      trial.installationReused = true;
      evidence.workspace_fork = evidence.installed_snapshot.forks.workspace;
    } else {
      evidence.workspace_fork = await timings.measure('clone', () => forkSnapshot(inputRoot, roots!.workspace, forkOptions()));
      for (const directory of [roots.cache, roots.tmp]) await fs.mkdir(directory);
      if (scenario.install) evidence.install_cache = await timings.measure('preparation', () => prepareInstallCache(scenario, inputRoot, roots!, forkOptions()));
    }
    evidence.prepared_directories = allPaths;
    const prepareDirectories = async () => timings.measure('preparation', async () => { for (const alias of allPaths) {
      const directory = resolveAlias(alias, roots!), root = roots![alias.slice(1).split('/')[0] as keyof Roots];
      await noSymlinks(root, directory); await fs.mkdir(directory, { recursive: true });
    } });
    await prepareDirectories();
    const refreshOutputs = async () => timings.measure('preparation', async () => {
      for (const assertion of scenario.assertions) {
        const target = resolveAlias(assertion.path, roots!);
        await noSymlinks(roots!.workspace, target); await fs.rm(target, { force: true }); await fs.mkdir(path.dirname(target), { recursive: true });
      }
    });
    await refreshOutputs();
    const trialFixtures: Fixtures = { ...fixtures };
    const context: BackendContext = { roots, experimentRoot: scratch, protectedPaths: request.resources.protectedPaths, grants, invocationId: trialId, timeoutMs: Math.max(1, Math.min(scenario.timeout_seconds * 1000, deadline - Date.now())), maxOutputBytes: limits.max_output_bytes, signal: request.budget.signal, networkGrants: taskOnly ? [] : networkGrants };
    const prepareReads = async () => timings.measure('preparation', async () => {
      if (readMode !== 'explicit') return;
      trialFixtures.reads = [];
      const dependencyDirectory = staged && (await fs.lstat(path.join(roots!.workspace, 'node_modules')).catch(() => undefined))?.isDirectory();
      for (const directory of [...readProbeDirectories, ...dependencyDirectory ? ['node_modules'] : []]) {
        const alias = '@workspace/' + (directory ? directory + '/' : '') + '.permsift-read-checks/fake-secret';
        const target = path.join(roots!.workspace, directory, '.permsift-read-checks', 'fake-secret');
        await noSymlinks(roots!.workspace, path.dirname(target)); await fs.mkdir(path.dirname(target)); await fs.writeFile(target, marker, { flag: 'wx', mode: 0o600 });
        trialFixtures.reads.push({ path: target, alias, expected: readGrants.some(grant => contains(grant, alias)) ? 'allowed' : 'denied' });
      }
      context.readGrants = readGrants; context.readKinds = {}; context.protectedWritePaths = trialFixtures.reads.map(f => path.dirname(f.path));
      const expected = request.conditions.expectedReadKinds;
      for (const alias of readGrants) {
        const target = resolveAlias(alias, roots!); await noSymlinks(roots!.workspace, target); const stat = await fs.lstat(target);
        if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Read grants must target regular files or directories: ${alias}`);
        const kind = stat.isFile() ? 'file' : 'directory';
        if (expected?.[alias] && expected[alias] !== kind) throw new Error(`Historical or frozen read target changed kind: ${alias}`);
        context.readKinds[alias] = kind;
      }
      evidence.read_grant_kinds = context.readKinds;
      evidence.task_policy_hash = hash({ write: grants, read: readGrants, readMode, readKinds: context.readKinds, network: [], prepared: allPaths });
    });
    if (!staged || taskOnly) await prepareReads();
    evidence.policy_hash = hash({ write: grants, read: readGrants, readMode, readKinds: context.readKinds, network: networkGrants, install: scenario.install, installGrants: staged ? installGrants : undefined, prepared: allPaths });
    evidence.roots = roots; evidence.stage_policy_mode = staged ? 'separate' : 'shared';
    // A task-only clone has no installation delta to report. Its content,
    // modes and links were checked by InstalledSnapshots.fork; the task
    // still gets a fresh before/after file manifest below.
    const before = taskOnly ? undefined : await scanRoots();
    const inventoryBefore = sources.inputDirectories ? await timings.measure('discovery', () => directoryInventory(roots!, limits)) : undefined;
    let readInventoryBefore = sources.readInventory && readMode === 'explicit' && !staged ? await timings.measure('discovery', () => readInventory(roots!, limits)) : undefined;
    evidence.install_policy_hash = staged ? hash({ write: installGrants, readMode: 'legacy', network: networkGrants, prepared: allPaths }) : undefined;
    const installContext = staged ? { ...context, grants: installGrants, readGrants: undefined, readKinds: undefined } : context;
    const pre = await timings.measure('probes', () => boundaryChecks(trialFixtures, { ...(staged && !taskOnly ? installContext : context), invocationId: trialId + '-before' }));
    evidence.before = pre; boundaries = pre.checks;
    if (pre.checks.some(c => c.status !== 'pass')) {
      trial.verdict = pre.checks.some(c => c.status === 'unknown') ? 'unknown' : 'fail'; trial.reason = 'Pre-execution boundary check did not pass';
    } else {
      if (!hasTime()) throw new Error('Budget exhausted before task execution');
      const taskDeadline = Math.min(deadline, Date.now() + scenario.timeout_seconds * 1000);
      let installVerdict: TrialVerdict = 'pass';
      if (scenario.install && !taskOnly) {
        trial.execution_stage = 'install'; trial.installationAttempted = true;
        const install = await timings.measure('install', () => executeInstall(scenario, { ...installContext, invocationId: trialId + '-install', timeoutMs: Math.max(1, taskDeadline - Date.now()) }, request.resources.installInput!));
        evidence.installation = install; installVerdict = install.verdict; task = install.execution;
        if (install.verdict === 'unknown') trial.reason = install.inputs_unchanged ? 'Installation did not complete reliably (timeout, transport, DNS, TLS or registry failure)' : 'Installation changed its package manifest or lockfile';
        const afterInstall = await timings.measure('probes', () => boundaryChecks(trialFixtures, { ...installContext, invocationId: trialId + '-install-after', timeoutMs: Math.max(1, taskDeadline - Date.now()) }));
        evidence.after_installation = afterInstall; boundaries = [...boundaries, ...afterInstall.checks];
        if (boundaries.some(c => c.status !== 'pass')) installVerdict = 'unknown';
      }
      if (staged && installVerdict === 'pass') {
        if (!taskOnly) { await prepareDirectories(); await refreshOutputs(); }
        const inventory = sources.installedDirectories ? await timings.measure('discovery', () => directoryInventory(roots!, limits)) : undefined;
        if (!taskOnly) {
          const after = await scanRoots();
          evidence.install_file_changes = Object.fromEntries(Object.entries(roots).map(([name]) => [name, diffFiles(before![name], after[name])]));
        }
        evidence.input_inventory = inventoryBefore;
        // Preserve state BEFORE task execution and probes, publish only if this complete trial passes.
        if (sources.installedState && !taskOnly) evidence.installation_state = {
          hashes: await timings.measure('hash', () => rootHashes(roots!, limits.max_snapshot_bytes, forkOptions())),
          files: await scanRoots(),
        };
        if (request.capture) pendingSnapshot = await captureInstalledSnapshot(request.capture.directory, limits.max_snapshot_bytes, request.capture.key, roots, trialId, forkOptions());
        if (!taskOnly) await prepareReads();
        if (sources.readInventory && readMode === 'explicit') readInventoryBefore = await timings.measure('discovery', () => readInventory(roots!, limits, true));
        evidence.task_input_changes_base = await scanRoots();
        evidence.task_inventory = inventory;
      }
      const offlineContext = { ...context, networkGrants: [] };
      if (installVerdict === 'pass') {
        if (scenario.install) {
          const offline = await timings.measure('probes', () => boundaryChecks(trialFixtures, { ...offlineContext, invocationId: trialId + '-offline-before', timeoutMs: Math.max(1, taskDeadline - Date.now()) }));
          evidence.before_offline_task = offline; boundaries = [...boundaries, ...offline.checks];
          if (offline.checks.some(c => c.status !== 'pass')) throw new Error('Offline task boundary checks did not pass');
        }
        trial.execution_stage = 'task';
        if (sources.dependencies) {
          await timings.measure('preparation', () => prepareBundling(scenario, roots!));
          observer = await timings.measure('discovery', () => prepareObservation(roots!, request.budget.signal));
          evidence.observer = { source: 'node_module_hooks', bootstrap: observer.bootstrap, collector: observer.directory, bootstrap_hash: observer.bootstrap_hash,
            internal_write_exception: '@tmp/.permsift-observer/logs', instrumentation_applies_to: 'offline task only; not install or boundary probes',
            ...(scenario.observation?.typescript ? { compilation: { source: 'typescript_explain_files', output: 'same execution stdout', executed_command: compilationCommand(scenario) } } : {}),
            ...(scenario.observation?.esbuild ? { bundling: { source: 'esbuild_metafile', ...scenario.observation.esbuild, output_directory_cleared: true, executed_command: compilationCommand(scenario) } } : {}) };
        }
        trial.actualCommand = sources.dependencies ? compilationCommand(scenario) : [...scenario.command];
        task = await timings.measure('task', () => executeSandbox(trial.actualCommand!, { ...offlineContext,
          ...observer ? { observer: { bootstrap: observer.bootstrap, directory: observer.directory } } : {},
          timeoutMs: Math.max(1, taskDeadline - Date.now()) })); evidence.task = task;
      } else evidence.task_skipped = 'Install did not pass; offline command was not executed';
      assertions = await timings.measure('assertions', () => checkAssertions(scenario.assertions, roots!)); evidence.assertions = assertions;
      const post = await timings.measure('probes', () => boundaryChecks(trialFixtures, { ...(scenario.install && installVerdict !== 'pass' ? installContext : offlineContext), invocationId: trialId + '-after', timeoutMs: Math.max(1, Math.min(context.timeoutMs, deadline - Date.now())) }));
      evidence.after = post; boundaries = [...boundaries, ...post.checks];
      const changeBase = staged && evidence.task_input_changes_base ? evidence.task_input_changes_base : before;
      const afterTask = await scanRoots();
      const changes = Object.fromEntries(Object.keys(roots).map(name => [name, diffFiles(changeBase![name], afterTask[name])]));
      evidence.file_changes = changes.workspace; evidence.file_changes_by_root = changes;
      trial.verdict = installVerdict === 'unknown' ? 'unknown' : classifyTrial(task!.process.status, task!.process.exit_code, assertions, boundaries);
      if (!hasTime()) { trial.verdict = 'unknown'; trial.reason = 'Budget exhausted or interrupted before trial completion'; }
      if (readInventoryBefore && trial.verdict === 'pass') {
        const observation: ReadObservation = { ...readInventoryBefore, id: trialId }; evidence.read_discovery_observation = observation;
      }
      if (sources.afterTaskDirectories && trial.verdict === 'pass') {
        const inventoryAfter = await timings.measure('discovery', () => directoryInventory(roots!, limits));
        const observation: Observation = { id: trialId, directories: [...new Set([...(staged ? evidence.task_inventory?.directories ?? [] : inventoryBefore?.directories ?? []), ...inventoryAfter.directories])], writes: Object.entries(changes).flatMap(([name, c]) => [...c.added, ...c.changed, ...c.removed].map(p => `@${name}/${p.split(path.sep).join('/')}`)), denial_paths: diagnose({ task, roots, assertions, boundaries, verdict: trial.verdict }).denials.flatMap(d => d.path?.startsWith('@') ? [d.path] : []), truncated: !!inventoryBefore?.truncated || inventoryAfter.truncated };
        evidence.discovery_observation = observation;
      }
    }
  } catch (error) { trial.verdict = 'unknown'; trial.reason = String(error); evidence.error = String(error); }
  if (!hasTime()) { trial.verdict = 'unknown'; trial.reason = request.budget.signal?.aborted ? 'Experiment interrupted' : 'Experiment budget exhausted before evidence completion'; }
  if (observer && roots) {
    const observation = await timings.measure('reporting', () => collectObservation(observer!, roots!));
    const compilation = await timings.measure('reporting', async () => collectCompilation(scenario, observer!.inventory, roots!, task?.process));
    const bundling = await timings.measure('reporting', () => collectBundling(scenario, observer!.inventory, roots!, task?.process));
    trial.observation = { ...observation, task: scenario.id, trial: trialId, command: scenario.command,
      task_definition_hash: request.conditions.scenarioHash, verdict: trial.verdict, duration_ms: task?.process.duration_ms, ...(compilation ? { compilation } : {}), ...(bundling ? { bundling } : {}) };
    evidence.dependency_observation = trial.observation;
  }
  trial.duration_ms = Date.now() - started;
  trial.diagnosis = { ...diagnose({ task, roots, assertions, boundaries, verdict: trial.verdict, reason: trial.reason }), ...(staged ? { stage: trial.execution_stage } : {}) };
  trial.timings = timings.snapshot();
  evidence.diagnosis = trial.diagnosis;
  trial.pendingSnapshot = pendingSnapshot;
  return trial;
}
