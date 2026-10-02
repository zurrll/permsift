import { BACKEND_VERSION } from './backend.js';
import type { SearchReuse, SearchStep, TrialVerdict } from './search.js';
import type { Discovery } from './discovery.js';
import type { ReadDiscovery } from './read-discovery.js';
import type { Diagnosis } from './diagnostics.js';
import type { TimingSummary } from './timing.js';
import type { InstallInput } from './install.js';
import type { TaskObservation } from './observation.js';
import type { ExecutionDetails, ExecutionResult } from './execute-once.js';
import type { ExecutablePolicy } from './execution-request.js';
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
  dependency_observations?: Record<string, TaskObservation>;
  search_complete: boolean; output: string; workspaces?: string; error?: string;
};
export function trialReport(result: ExecutionResult, context: { scenario: string; phase: string; policy: ExecutablePolicy; staged: boolean; requestedReuse: boolean }): Trial {
  const p = context.policy;
  return { id: result.id, scenario: context.scenario, phase: context.phase, grants: [...p.write], read_grants: [...p.read], read_mode: p.readMode, network_grants: [...p.network],
    verdict: result.verdict, duration_ms: result.duration_ms, evidence: `evidence/${result.id}.json`, diagnosis: result.diagnosis, timings: result.timings,
    ...result.reason !== undefined ? { reason: result.reason } : {}, ...result.execution_stage ? { execution_stage: result.execution_stage } : {},
    ...context.staged ? { install_grants: [...p.installWrite], installation_reused: context.requestedReuse } : {} };
}
export function evidenceReport(trial: Trial, details: ExecutionDetails, snapshot?: { key: string; hashes: Record<string, string>; source_trial: string }) {
  // Preserve the v1 pre-execution copy; summary is the finalized trial.
  return { id: trial.id, scenario: trial.scenario, phase: trial.phase, grants: trial.grants, read_grants: trial.read_grants, read_mode: trial.read_mode,
    network_grants: trial.network_grants, verdict: 'unknown', duration_ms: 0, evidence: trial.evidence,
    ...trial.install_grants ? { install_grants: trial.install_grants, installation_reused: trial.installation_reused } : {},
    ...details, ...snapshot ? { snapshot_created: snapshot } : {}, summary: trial };
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
