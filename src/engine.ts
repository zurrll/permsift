import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { contains, configSchema, limitsSchema, isStaged, installationScenario, loadConfiguration, validatePolicy, type Config, type Limits, type Scenario } from './config.js';
import { BACKEND_VERSION, executeSandbox, requirePlatform, type BackendContext } from './backend.js';
import { snapshot, snapshotHash, forkSnapshot, hash, within, noSymlinks, resolveAlias, manifest, diffFiles, saveJson, type Roots } from './filesystem.js';
import { checkAssertions, type Check } from './assertions.js';
import { startEndpoint, closeEndpoint, boundaryChecks, type Fixtures } from './probes.js';
import { searchPolicy, type SearchReuse, type SearchStep, type TrialVerdict, type Permission } from './search.js';
import { directoryInventory, discover, type Discovery, type Observation } from './discovery.js';
import { diagnose, type Diagnosis } from './diagnostics.js';
import { readInventory, discoverReads, type ReadDiscovery, type ReadObservation } from './read-discovery.js';
import { InstalledSnapshots, installationKey, rootHashes, type InstalledSnapshot } from './installed-snapshot.js';
import { Timings, summarizeTimings, type TimingSummary } from './timing.js';
import { inspectInstall, executeInstall, prepareInstallCache, npmVersion, type InstallInput } from './install.js';

export const VERSION = '0.8.0';
export type Trial = { id: string; scenario: string; phase: string; grants: string[]; read_grants: string[]; read_mode: 'explicit' | 'legacy'; network_grants: string[]; verdict: TrialVerdict; duration_ms: number; evidence: string; reason?: string; diagnosis?: Diagnosis; install_grants?: string[]; execution_stage?: 'install' | 'task'; installation_reused?: boolean; timings?: TimingSummary };
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
  network_policies: Record<string, string[]>; network_searches: Record<string, SearchSummary>;
  install_policies: Record<string, string[]>; install_searches: Record<string, SearchSummary>; install_discovery: Record<string, Discovery>;
  installation_stats: Record<string, { executed: number; reused: number; snapshots: number; snapshot_key?: string; hashes?: Record<string, string> }>;
  timings?: TimingSummary;
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
    `- Node: ${report.environment.node}; SRT: ${BACKEND_VERSION}${report.environment.npm ? `; npm: ${report.environment.npm}` : ''}`, '',
    ...(report.error ? [`Error: ${markdownEscape(report.error)}`, ''] : []),
    ...report.timings ? [
      '## Time spent', '',
      `Measured wall time: ${(report.timings.total_ms / 1000).toFixed(2)} s; uninstrumented work: ${(report.timings.other_ms / 1000).toFixed(2)} s.`, '',
      '| Operation | Seconds | Calls |', '| --- | --- | --- |',
      ...Object.entries(report.timings.phases).sort((a, b) => b[1].duration_ms - a[1].duration_ms).map(([name, value]) => `| ${name} | ${(value.duration_ms / 1000).toFixed(2)} | ${value.calls} |`), '',
      'Durations are exclusive wall time, not CPU time. Hash checks and file-change manifests are separate. Sandbox startup/cleanup inside a command is included in install, task or probes. Owned trial/input/snapshot cleanup is reported separately. The final report write is outside this snapshot.', '',
      ...report.timings.hash_scan ? [
        '### Content hash scans', '',
        `${report.timings.hash_scan.scans} root scans (${report.timings.hash_scan.incomplete_scans} incomplete); ${report.timings.hash_scan.files} file visits; ${report.timings.hash_scan.content_bytes} content bytes. Maximum I/O concurrency: ${report.timings.hash_scan.concurrency}; peak pending small-file buffers: ${report.timings.hash_scan.peak_buffered_files}.`, '',
        '| Hash operation | Service seconds | Calls |', '| --- | --- | --- |',
        ...Object.entries(report.timings.hash_scan.operations).map(([name, value]) => `| ${name} | ${(value.service_ms / 1000).toFixed(2)} | ${value.calls} |`), '',
        'Service durations overlap during concurrent I/O. They describe calls, not an exclusive breakdown, and must not be added to wall time or compared as CPU time. Counts include repeated visits across root scans. The read category includes opens, reads and closes.', '',
      ] : [],
    ] : [],
    '## Scope and limitations', '', ...report.scope.map(s => `- ${s}`), '',
    '## Current candidate policies', '',
    ...Object.entries(report.policies).flatMap(([id, grants]) => [
      `- **${id} task write**: ${grants.length ? grants.join(', ') : '(no variable write grants)'}`,
      `- **${id} task read** (${report.read_modes[id]}): ${report.read_policies[id].join(', ') || '(no project file/data read grants)'}`,
      `- **${id} install network**: ${report.network_policies[id].join(', ') || '(offline)'}`,
      ...(report.install_policies[id] ? [`- **${id} install write**: ${report.install_policies[id].join(', ') || '(none)'}`] : []),
    ]), '',
    ...report.inputs.installations ? [
      '## Installation inputs', '',
      ...Object.entries(report.inputs.installations as Record<string, InstallInput>).flatMap(([id, data]) => [
        `- **${id}**: npm ci --ignore-scripts; cache: ${data.cache}; subsequent task command: offline`,
        `  - Lock SHA-256: ${data.lock_hash}; package SHA-256: ${data.package_hash}`,
        `  - Locked download hosts: ${data.resolved_domains.join(', ') || '(none)'} (observations do not add grants)`,
        ...(data.cache_seed_hash ? [`  - Fixed warm seed manifest SHA-256: ${data.cache_seed_hash}; npm uses --offline`] : ['  - Every actual installation starts with an empty npm cache; task-only trials clone the recorded installed state.']),
      ]), '',
    ] : [],
    '## Installation reuse', '',
    ...Object.entries(report.installation_stats).flatMap(([id, stats]) => [
      `- **${id}**: actual npm executions: ${stats.executed}; task-only snapshot clones: ${stats.reused}; verified snapshots: ${stats.snapshots}`,
      ...(stats.snapshot_key ? [`  - Snapshot key: ${stats.snapshot_key}; root hashes: ${JSON.stringify(stats.hashes)}`] : []),
    ]), '',
    'Installation search runs full trials with initial task policies. Task search is conditional on the recorded installed snapshot. Final repetitions always reinstall from original inputs with the final stage policies. Stage candidate exhaustion does not establish a joint optimum across stage combinations.', '',
    '## Search coverage', '',
    '| Task | Permission stage | Stop | Comparisons |', '| --- | --- | --- | --- |',
    ...([
      ['install network', report.network_searches], ['install write', report.install_searches],
      ['task write', report.searches], ['task read', report.read_searches],
    ] as const).flatMap(([stage, searches]) => Object.entries(searches).map(([id, search]) => `| ${id} | ${stage} | ${search.stop} | ${search.steps.length} |`)), '',
    'A verified result may still have budget-limited or truncated search coverage. An exhausted search covers only the generated and configured operations; inspect discovery limitations below.', '',
    '## Install write discovery', '', ...Object.entries(report.install_discovery).map(([id, d]) => `- **${id}**: ${d.rules.length} rules; truncated: ${d.truncated}`), '',
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
    ...[report.searches, report.install_searches, report.read_searches, report.network_searches].flatMap(searches => Object.entries(searches).flatMap(([id, search]) => search.steps.map(s => `| ${id} | ${searches === report.install_searches ? 'install ' : ''}${s.permission} | ${s.round} | ${markdownEscape(s.operation)} | ${s.source} | ${s.decision} | ${s.semantic_change ? 'yes' : 'no (overlapping grants)'} | [trial](evidence/${s.trial_id}.json)${s.recovery_id ? ` / [recovery](evidence/${s.recovery_id}.json)` : ''} |`))), '',
    '## Reused failure hints', '',
    'Identical failed candidate policies may guide splitting within one search round. These entries are not new trials or permanent necessity claims; the next round discards these hints.', '',
    '| Task | Permission | Round | Deferred comparison | Earlier failure |', '| --- | --- | --- | --- | --- |',
    ...[report.searches, report.install_searches, report.read_searches, report.network_searches].flatMap(searches => Object.entries(searches).flatMap(([id, search]) => search.reuses.map(r => `| ${id} | ${searches === report.install_searches ? 'install ' : ''}${r.permission} | ${r.round} | ${markdownEscape(r.operation)} | [trial](evidence/${r.failed_trial_id}.json) |`))), '',
    '## Failure explanations', '',
    ...report.trials.filter(t => t.verdict !== 'pass').flatMap(t => {
      const step = [report.searches, report.install_searches, report.read_searches, report.network_searches].flatMap(searches => Object.values(searches).flatMap(s => s.steps)).find(s => s.trial_id === t.id);
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
  expectedReadKinds?: Record<string, Record<string, 'file' | 'directory'>>;
  frozenInput?: { path: string; hash: string; protectedPaths?: string[] };
  /** Diagnostic harness only: observe post-install/pre-task state, adding full scans. */
  measureInstalledState?: boolean;
}): Promise<Report> {
  const experimentTimings = new Timings();
  requirePlatform();
  const input = options.input ? { ...options.input, config: configSchema.parse(options.input.config), limits: limitsSchema.parse(options.input.limits) } : await loadConfiguration(options.configPath!, options.limitsPath!);
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
    ...(options.keepWorkspaces ? { workspaces: scratch } : {}),
  };
  const updateTimings = () => {
    const setup = experimentTimings.snapshot();
    report.timings = summarizeTimings(setup.total_ms, [setup, ...report.trials.flatMap(t => t.timings ? [t.timings] : [])]);
  };
  const checkpoint = async () => experimentTimings.measure('reporting', async () => {
    updateTimings();
    await saveJson(path.join(output, 'report.json'), report);
    await fs.writeFile(path.join(output, 'report.md'), markdownReport(report), { mode: 0o600 });
  });
  let endpoint: Awaited<ReturnType<typeof startEndpoint>> | undefined;
  const deadline = Date.now() + limits.budget_seconds * 1000;
  let candidateCount = 0;
  const observations = new Map<string, Observation[]>();
  const readObservations = new Map<string, ReadObservation[]>();
  const installObservations = new Map<string, Observation[]>();
  const installed = new InstalledSnapshots(path.join(scratch, 'installed'), limits.max_snapshot_bytes);
  const installedKinds = new Map<string, Record<string, 'file' | 'directory'>>();
  const prepared = new Map(config.scenarios.map(s => [s.id, [...new Set([...s.initial_write_grants, ...s.prepare_directories, ...s.narrower_candidates.flatMap(r => [r.from, ...r.to]), ...isStaged(s) ? [...installationScenario(s).initial_write_grants, ...installationScenario(s).narrower_candidates.flatMap(r => [r.from, ...r.to])] : []])].sort()]));
  const hasTime = () => Date.now() < deadline && !options.signal?.aborted;
  try {
    await checkpoint();
    const inputRoot = path.join(scratch, 'input');
    if (options.frozenInput) {
      report.inputs.snapshot_fork = await experimentTimings.measure('clone', () => forkSnapshot(options.frozenInput!.path, inputRoot, { timeoutMs: Math.max(1, deadline - Date.now()), signal: options.signal }));
      report.inputs.snapshot_hash = await experimentTimings.measure('hash', () => snapshotHash(inputRoot, limits.max_snapshot_bytes, false, { signal: options.signal, timeoutMs: Math.max(0, deadline - Date.now()), onProfile: p => experimentTimings.recordHashScan(p) }));
    } else report.inputs.snapshot_hash = await experimentTimings.measure('freeze', () => snapshot(project, inputRoot, config.exclude, limits.max_snapshot_bytes));
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

    const evaluate = async (scenario: Scenario, grants: string[], phase: string, readGrants = report.read_policies[scenario.id], networkGrants = report.network_policies[scenario.id], stage: { taskOnly?: boolean; capture?: boolean; installGrants?: string[] } = {}) => {
      const timings = new Timings();
      const trialId = randomUUID(), started = Date.now(), staged = isStaged(scenario);
      const readMode = report.read_modes[scenario.id];
      const installGrants = stage.installGrants ?? report.install_policies[scenario.id] ?? grants;
      const trial: Trial = { id: trialId, scenario: scenario.id, phase, grants, read_grants: readGrants, read_mode: readMode, network_grants: networkGrants, verdict: 'unknown', duration_ms: 0, evidence: `evidence/${trialId}.json`, ...(staged ? { install_grants: installGrants, installation_reused: !!stage.taskOnly } : {}) };
      const evidence: Record<string, any> = { ...trial };
      if (phase.startsWith('candidate')) candidateCount++;
      options.onProgress?.(`${scenario.id} · ${phase} · write: ${grants.join(', ') || '(none)'}${readMode === 'explicit' ? ` · read: ${readGrants.join(', ') || '(none)'}` : ''}${scenario.install ? ` · network: ${networkGrants.join(', ') || '(offline)'}` : ''}${staged ? ` · install write: ${installGrants.join(', ') || '(none)'} · ${stage.taskOnly ? 'snapshot' : 'fresh install'}` : ''}`);
      let roots: Roots | undefined, task: Awaited<ReturnType<typeof executeSandbox>> | undefined;
      let assertions: Check[] = [], boundaries: Check[] = [], pendingSnapshot: InstalledSnapshot | undefined;
      const stats = staged ? report.installation_stats[scenario.id] ??= { executed: 0, reused: 0, snapshots: 0 } : undefined;
      const scanRoots = () => timings.measure('manifest', async () => Object.fromEntries(
        await Promise.all(Object.entries(roots!).map(async ([name, root]) => [name, await manifest(root)] as const)),
      ));
      try {
        if (!hasTime()) throw new Error(options.signal?.aborted ? 'Experiment interrupted' : 'Experiment budget exhausted');
        const runRoot = path.join(scratch, 'runs', trialId);
        roots = { workspace: path.join(runRoot, 'workspace'), cache: path.join(runRoot, 'cache'), tmp: path.join(runRoot, 'tmp') };
        await fs.mkdir(runRoot, { recursive: true });
        const allPaths = prepared.get(scenario.id)!;
        const key = installationKey({ snapshot: report.inputs.snapshot_hash, environment: report.environment, installation: { id: scenario.id, ...installations.get(scenario.id), config: scenario.install }, policy: { write: installGrants, network: networkGrants }, preparation: allPaths, limits });
        const forkOptions = () => ({ timeoutMs: Math.max(1, deadline - Date.now()), signal: options.signal, timings });
        if (stage.taskOnly) {
          evidence.installed_snapshot = await installed.fork(key, roots, forkOptions());
          stats!.reused++;
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
        const context: BackendContext = { roots, experimentRoot: scratch, protectedPaths: [project, input.configFile, input.limitsFile, canonicalOutput, options.frozenInput?.path ?? '', ...options.frozenInput?.protectedPaths ?? []].filter(Boolean), grants, invocationId: trialId, timeoutMs: Math.max(1, Math.min(scenario.timeout_seconds * 1000, deadline - Date.now())), maxOutputBytes: limits.max_output_bytes, signal: options.signal, networkGrants: stage.taskOnly ? [] : networkGrants };
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
          const expected = options.expectedReadKinds?.[scenario.id] ?? (staged && !stage.capture && !['baseline', 'discovery_baseline'].includes(phase) ? installedKinds.get(scenario.id) : undefined);
          for (const alias of readGrants) {
            const target = resolveAlias(alias, roots!); await noSymlinks(roots!.workspace, target); const stat = await fs.lstat(target);
            if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Read grants must target regular files or directories: ${alias}`);
            const kind = stat.isFile() ? 'file' : 'directory';
            if (expected?.[alias] && expected[alias] !== kind) throw new Error(`Historical or frozen read target changed kind: ${alias}`);
            context.readKinds[alias] = kind;
          }
          evidence.read_grant_kinds = context.readKinds;
          evidence.task_policy_hash = hash({ write: grants, read: readGrants, readMode, readKinds: context.readKinds, network: [], prepared: allPaths });
          if (staged && (stage.capture || stage.taskOnly)) installedKinds.set(scenario.id, { ...installedKinds.get(scenario.id), ...context.readKinds });
        });
        if (!staged || stage.taskOnly) await prepareReads();
        evidence.policy_hash = hash({ write: grants, read: readGrants, readMode, readKinds: context.readKinds, network: networkGrants, install: scenario.install, installGrants: staged ? installGrants : undefined, prepared: allPaths });
        evidence.roots = roots; evidence.stage_policy_mode = staged ? 'separate' : 'shared';
        // A task-only clone has no installation delta to report. Its content,
        // modes and links were checked by InstalledSnapshots.fork; the task
        // still gets a fresh before/after file manifest below.
        const before = stage.taskOnly ? undefined : await scanRoots();
        const inventoryBefore = phase === 'baseline' && (scenario.auto_discover || staged && installationScenario(scenario).auto_discover) ? await timings.measure('discovery', () => directoryInventory(roots!, limits)) : undefined;
        let readInventoryBefore = ['baseline', 'discovery_baseline', 'installation_snapshot'].includes(phase) && readMode === 'explicit' && scenario.auto_read_discover && !staged ? await timings.measure('discovery', () => readInventory(roots!, limits)) : undefined;
        evidence.install_policy_hash = staged ? hash({ write: installGrants, readMode: 'legacy', network: networkGrants, prepared: allPaths }) : undefined;
        const installContext = staged ? { ...context, grants: installGrants, readGrants: undefined, readKinds: undefined } : context;
        const pre = await timings.measure('probes', () => boundaryChecks(trialFixtures, { ...(staged && !stage.taskOnly ? installContext : context), invocationId: trialId + '-before' }));
        evidence.before = pre; boundaries = pre.checks;
        if (pre.checks.some(c => c.status !== 'pass')) {
          trial.verdict = pre.checks.some(c => c.status === 'unknown') ? 'unknown' : 'fail'; trial.reason = 'Pre-execution boundary check did not pass';
        } else {
          if (!hasTime()) throw new Error('Budget exhausted before task execution');
          const taskDeadline = Math.min(deadline, Date.now() + scenario.timeout_seconds * 1000);
          let installVerdict: TrialVerdict = 'pass';
          if (scenario.install && !stage.taskOnly) {
            trial.execution_stage = 'install'; if (stats) stats.executed++;
            const install = await timings.measure('install', () => executeInstall(scenario, { ...installContext, invocationId: trialId + '-install', timeoutMs: Math.max(1, taskDeadline - Date.now()) }, installations.get(scenario.id)!));
            evidence.installation = install; installVerdict = install.verdict; task = install.execution;
            if (install.verdict === 'unknown') trial.reason = install.inputs_unchanged ? 'Installation did not complete reliably (timeout, transport, DNS, TLS or registry failure)' : 'Installation changed its package manifest or lockfile';
            const afterInstall = await timings.measure('probes', () => boundaryChecks(trialFixtures, { ...installContext, invocationId: trialId + '-install-after', timeoutMs: Math.max(1, taskDeadline - Date.now()) }));
            evidence.after_installation = afterInstall; boundaries = [...boundaries, ...afterInstall.checks];
            if (boundaries.some(c => c.status !== 'pass')) installVerdict = 'unknown';
          }
          if (staged && installVerdict === 'pass') {
            if (!stage.taskOnly) { await prepareDirectories(); await refreshOutputs(); }
            const inventory = phase === 'baseline' ? await timings.measure('discovery', () => directoryInventory(roots!, limits)) : undefined;
            if (!stage.taskOnly) {
              const after = await scanRoots();
              evidence.install_file_changes = Object.fromEntries(Object.entries(roots).map(([name]) => [name, diffFiles(before![name], after[name])]));
            }
            if (phase === 'baseline' && !stage.taskOnly) {
              installObservations.set(scenario.id, [...installObservations.get(scenario.id) ?? [], { id: trialId, directories: [...new Set([...(inventoryBefore?.directories ?? []), ...inventory!.directories])], writes: Object.entries(evidence.install_file_changes).flatMap(([name, c]) => { const change = c as ReturnType<typeof diffFiles>; return [...change.added, ...change.changed, ...change.removed].map(p => `@${name}/${p.split(path.sep).join('/')}`); }), denial_paths: [], truncated: !!inventoryBefore?.truncated || !!inventory?.truncated }]);
            }
            // Preserve state BEFORE task execution and probes, publish only if this complete trial passes.
            if (options.measureInstalledState && !stage.taskOnly) evidence.installation_state = {
              hashes: await timings.measure('hash', () => rootHashes(roots!, limits.max_snapshot_bytes, forkOptions())),
              files: await scanRoots(),
            };
            if (stage.capture) pendingSnapshot = await installed.capture(key, roots, trialId, forkOptions());
            if (!stage.taskOnly) await prepareReads();
            if (['baseline', 'discovery_baseline', 'installation_snapshot'].includes(phase) && readMode === 'explicit' && scenario.auto_read_discover) readInventoryBefore = await timings.measure('discovery', () => readInventory(roots!, limits, true));
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
            task = await timings.measure('task', () => executeSandbox(scenario.command, { ...offlineContext, timeoutMs: Math.max(1, taskDeadline - Date.now()) })); evidence.task = task;
          } else evidence.task_skipped = 'Install did not pass; offline command was not executed';
          assertions = await timings.measure('assertions', () => checkAssertions(scenario.assertions, roots!)); evidence.assertions = assertions;
          const post = await timings.measure('probes', () => boundaryChecks(trialFixtures, { ...(scenario.install && installVerdict !== 'pass' ? installContext : offlineContext), invocationId: trialId + '-after', timeoutMs: Math.max(1, Math.min(context.timeoutMs, deadline - Date.now())) }));
          evidence.after = post; boundaries = [...boundaries, ...post.checks];
          const changeBase = staged && evidence.task_input_changes_base ? evidence.task_input_changes_base : before;
          const afterTask = await scanRoots();
          const changes = Object.fromEntries(Object.keys(roots).map(name => [name, diffFiles(changeBase![name], afterTask[name])]));
          evidence.file_changes = changes.workspace; evidence.file_changes_by_root = changes;
          trial.verdict = installVerdict === 'unknown' ? 'unknown' : classifyTrial(task!.process.status, task!.process.exit_code, assertions, boundaries);
          if (phase === 'candidate_network' && installVerdict === 'fail' && !task!.violations.some(v => /deny network-outbound /.test(v.line))) { trial.verdict = 'unknown'; trial.reason = 'Install failed without independently captured domain denial; network removal is inconclusive'; }
          if (!hasTime()) { trial.verdict = 'unknown'; trial.reason = 'Budget exhausted or interrupted before trial completion'; }
          if (pendingSnapshot && trial.verdict === 'pass') { installed.publish(pendingSnapshot); stats!.snapshots++; stats!.snapshot_key = key; stats!.hashes = pendingSnapshot.hashes; evidence.snapshot_created = { key, hashes: pendingSnapshot.hashes, source_trial: trialId }; }
          if (readInventoryBefore && trial.verdict === 'pass') {
            const observation: ReadObservation = { ...readInventoryBefore, id: trialId }; evidence.read_discovery_observation = observation;
            readObservations.set(scenario.id, [...readObservations.get(scenario.id) ?? [], observation]);
          }
          if (phase === 'baseline' && scenario.auto_discover && trial.verdict === 'pass') {
            const inventoryAfter = await timings.measure('discovery', () => directoryInventory(roots!, limits));
            const observation: Observation = { id: trialId, directories: [...new Set([...(staged ? evidence.task_inventory?.directories ?? [] : inventoryBefore?.directories ?? []), ...inventoryAfter.directories])], writes: Object.entries(changes).flatMap(([name, c]) => [...c.added, ...c.changed, ...c.removed].map(p => `@${name}/${p.split(path.sep).join('/')}`)), denial_paths: diagnose({ task, roots, assertions, boundaries, verdict: trial.verdict }).denials.flatMap(d => d.path?.startsWith('@') ? [d.path] : []), truncated: !!inventoryBefore?.truncated || inventoryAfter.truncated };
            evidence.discovery_observation = observation; observations.set(scenario.id, [...observations.get(scenario.id) ?? [], observation]);
          }
        }
      } catch (error) { trial.verdict = 'unknown'; trial.reason = String(error); evidence.error = String(error); }
      if (!hasTime()) { trial.verdict = 'unknown'; trial.reason = options.signal?.aborted ? 'Experiment interrupted' : 'Experiment budget exhausted before evidence completion'; }
      trial.duration_ms = Date.now() - started;
      trial.diagnosis = { ...diagnose({ task, roots, assertions, boundaries, verdict: trial.verdict, reason: trial.reason }), ...(staged ? { stage: trial.execution_stage } : {}) };
      trial.timings = timings.snapshot();
      evidence.diagnosis = trial.diagnosis; evidence.summary = trial;
      await experimentTimings.measure('reporting', () => saveJson(path.join(output, trial.evidence), evidence)); report.trials.push(trial);
      // Evidence and any independently captured installation state are now safe.
      // Bound live trial trees instead of retaining millions of entries until exit.
      if (!options.keepWorkspaces) await experimentTimings.measure('cleanup', () => fs.rm(path.join(scratch, 'runs', trialId), { recursive: true, force: true }));
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
      report.final_verified = finalPass;
      report.status = finalPass && !report.error && allSearches.every(s => s.stop !== 'unstable') ? 'verified' : 'incomplete';
    }
  } catch (error) { report.status = 'incomplete'; report.error = String(error); }
  finally {
    if (endpoint) await closeEndpoint(endpoint.server);
    if (!options.keepWorkspaces) {
      try { await experimentTimings.measure('cleanup', () => fs.rm(scratch, { recursive: true, force: true })); }
      catch (error) { report.status = 'incomplete'; report.error = `Workspace cleanup failed: ${String(error)}`; report.workspaces = scratch; }
    }
    if (options.signal?.aborted) { report.status = 'incomplete'; report.error = 'Experiment interrupted'; }
    report.finished_at = new Date().toISOString();
    const name = report.status === 'verified' ? 'recommended.yaml' : 'unverified-candidate.yaml';
    if (options.mode !== 'doctor') await fs.writeFile(path.join(output, name), stringify({ ...config, project, scenarios: config.scenarios.map(s => ({ ...s, initial_write_grants: report.policies[s.id], ...(s.initial_read_grants === undefined ? {} : { initial_read_grants: report.read_policies[s.id] }), ...(s.install ? { initial_network_grants: report.network_policies[s.id], ...(isStaged(s) ? { install: { ...s.install, initial_write_grants: report.install_policies[s.id] } } : {}) } : {}), prepare_directories: prepared.get(s.id) })) }), { mode: 0o600 });
    await checkpoint();
  }
  return report;
}
