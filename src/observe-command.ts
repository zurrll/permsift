import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { runExperiment, VERSION } from './engine.js';
import { saveJson } from './filesystem.js';
import { OBSERVATION_LIMITS, OBSERVATION_SCOPE, type TaskObservation } from './observation.js';
import { OBSERVER_VERSION } from './observation-runtime.js';

type NotRun = { task: string; capture_status: 'not_run'; reason: string };
export type UsageReport = { schema_version: 1; kind: 'dependency_usage'; version: string; observer_version: string;
  status: 'observed' | 'failed' | 'incomplete'; output: string; execution_report: string; started_at: string; finished_at?: string;
  environment: Record<string, string>; inputs: Record<string, unknown>; limits: typeof OBSERVATION_LIMITS;
  tasks: (TaskObservation | NotRun)[]; limitations: string[]; comparison?: UsageComparison };
type PackageRef = { path: string; name: string; version: string };
export type UsageComparison = { baseline: string; conditions: { input_changed: boolean; config_changed: boolean; limits_changed: boolean; environment_changed: string[]; observer_changed: boolean };
  tasks: { task: string; state: 'compared' | 'added_task' | 'removed_task' | 'unavailable'; warnings: string[];
    added: PackageRef[]; removed: PackageRef[]; version_changes: { path: string; name: string; before: string; after: string }[] }[];
  limitations: string[] };

const text = z.string().max(4096), digest = z.string().regex(/^[a-f0-9]{64}$/);
const pkg = z.object({ path: text.regex(/^@workspace\//), name: text, version: text });
const taskSchema = z.union([
  z.object({ task: text, capture_status: z.literal('not_run'), reason: text }),
  z.object({ task: text, capture_status: z.enum(['captured', 'incomplete', 'unavailable']), task_definition_hash: digest,
    verdict: z.enum(['pass', 'fail', 'unknown']), loaded_packages: z.array(pkg).max(2048) }),
]);
const usageSchema = z.object({ schema_version: z.literal(1), kind: z.literal('dependency_usage'), observer_version: text,
  status: z.enum(['observed', 'failed', 'incomplete']), environment: z.record(text),
  inputs: z.object({ snapshot_hash: digest.optional(), config_hash: digest, limits_hash: digest }), tasks: z.array(taskSchema).max(16),
});
type Comparable = z.infer<typeof usageSchema>;
export async function loadUsage(file: string): Promise<Comparable> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 32_000_000) throw new Error('Usage baseline must be a JSON file below 32 MB');
  const parsed = usageSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
  if (new Set(parsed.tasks.map(t => t.task)).size !== parsed.tasks.length) throw new Error('Duplicate task IDs in usage baseline');
  for (const task of parsed.tasks) if (task.capture_status !== 'not_run' && new Set(task.loaded_packages.map(p => p.path)).size !== task.loaded_packages.length) throw new Error('Duplicate package instances in usage baseline');
  return parsed;
}
export function compareUsage(previous: Comparable, current: UsageReport, baseline: string): UsageComparison {
  const before = new Map(previous.tasks.map(t => [t.task, t]));
  const after = new Map(current.tasks.map(t => [t.task, t]));
  const environment_changed = [...new Set([...Object.keys(previous.environment), ...Object.keys(current.environment)])]
    .filter(k => k !== 'permsift' && previous.environment[k] !== current.environment[k]).sort();
  const conditions = { input_changed: previous.inputs.snapshot_hash !== current.inputs.snapshot_hash,
    config_changed: previous.inputs.config_hash !== current.inputs.config_hash, limits_changed: previous.inputs.limits_hash !== current.inputs.limits_hash,
    environment_changed, observer_changed: previous.observer_version !== current.observer_version };
  const tasks: UsageComparison['tasks'] = [...new Set([...before.keys(), ...after.keys()])].sort().map(task => {
    const a = before.get(task), b = after.get(task), warnings: string[] = [];
    const row: UsageComparison['tasks'][number] = { task, state: !a ? 'added_task' : !b ? 'removed_task' : 'compared', warnings, added: [], removed: [], version_changes: [] };
    if (!a || !b) return row;
    if (a.capture_status === 'not_run' || b.capture_status === 'not_run') { row.state = 'unavailable'; warnings.push('One task was not observed; no absence conclusions are available'); return row; }
    if (a.capture_status !== 'captured' || b.capture_status !== 'captured' || a.verdict !== 'pass' || b.verdict !== 'pass') warnings.push('One execution or capture was incomplete/failed; differences are partial observations');
    if (a.task_definition_hash !== b.task_definition_hash) warnings.push('Task command, assertions, preparation or policy changed');
    if (conditions.environment_changed.length) warnings.push('Execution environment changed');
    if (conditions.limits_changed) warnings.push('Trusted execution limits changed');
    if (conditions.observer_changed) warnings.push('Observer version changed');
    const oldPackages = new Map(a.loaded_packages.map(p => [p.path, p]));
    const newPackages = new Map(b.loaded_packages.map(p => [p.path, p]));
    const ref = (p: PackageRef): PackageRef => ({ path: p.path, name: p.name, version: p.version });
    for (const [p, v] of newPackages) {
      const old = oldPackages.get(p);
      if (!old || old.name !== v.name) row.added.push(ref(v));
      else if (old.version !== v.version) row.version_changes.push({ path: p, name: v.name, before: old.version, after: v.version });
    }
    for (const [p, v] of oldPackages) if (!newPackages.has(p) || newPackages.get(p)!.name !== v.name) row.removed.push(ref(v));
    return row;
  });
  return { baseline, conditions, tasks, limitations: ['Differences describe observed loads at installed locations. They do not establish unused dependencies, necessity, causality or safe permission removals.', 'A package absent from a partial/failed observation may still be used. Entry paths and versions can change with installation layout.'] };
}
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\u0000-\u001f]/g, ' ').replace(/[|`\[\]]/g, '\\$&');
export function usageMarkdown(report: UsageReport) {
  return ['# Permsift dependency usage', '', `Status: **${report.status}**. Observer: ${report.observer_version}.`, '',
    'Each configured task runs once, with no permission search. Task outcome and capture health are separate. These are Node module-load observations, not a list of all build inputs or final bundle dependencies.', '',
    '## Coverage', '', ...report.limitations.map(s => '- ' + escape(s)), '',
    ...report.tasks.flatMap(task => {
      if (task.capture_status === 'not_run') return [`## ${escape(task.task)}`, '', `Not observed: ${escape(task.reason)}`, ''];
      const uniqueNames = new Set(task.inventory.packages.map(p => p.name)).size;
      const uniqueVersions = new Set(task.inventory.packages.map(p => `${p.name}@${p.version}`)).size;
      return [`## ${escape(task.task)}`, '', `Task: **${task.verdict}**; capture: **${task.capture_status}**; ${task.processes.length} instrumented processes/threads; ${task.events} events.`,
        `Installed: **${task.inventory.packages.length} instances**, ${uniqueNames} names, ${uniqueVersions} name/version pairs. Observed module loads: **${task.loaded_packages.length} package instances**.`,
        `Inventory complete within limits: ${task.inventory.complete}; lock records: ${task.inventory.locked_instances ?? 'unavailable'}; locked locations not installed: ${task.inventory.locked_not_installed?.length ?? 'unavailable'}.`, '',
        ...task.issues.map(s => '- Capture issue: ' + escape(s)), '',
        ...task.coverage_gaps.map(s => '- Coverage gap: ' + escape(s)), '',
        '### Instrumented processes / threads', '', '| Entry | Node | Trace ended |', '| --- | --- | --- |',
        ...task.processes.map(p => `| ${escape(p.entry)} | ${escape(p.node)} | ${p.finished} |`), '',
        '### Observed packages', '', '| Package | Version | Installed location | Loaded modules | Root declarations |', '| --- | --- | --- | --- | --- |',
        ...task.loaded_packages.map(p => `| ${escape(p.name)} | ${escape(p.version)} | ${escape(p.path)} | ${p.modules.length} | ${p.declarations.join(', ') || '(transitive/undeclared)'} |`), '',
        '### Observed resolution relationships', '', 'Edges are this execution\'s resolution attempts that succeeded, including cached targets; loading a module does not establish that all of its code executed. Full file/module lists are in usage.json.', '',
        '| Requester | Requested | Resolved target |', '| --- | --- | --- |',
        ...task.edges.filter(e => e.package).map(e => `| ${escape(e.parent)} | ${escape(e.request)} | ${escape(e.target)} |`), '',
        '### Child launch attempts', '', '| Method | Executable | Preload environment retained |', '| --- | --- | --- |',
        ...task.child_launches.map(c => `| ${escape(c.method)} | ${escape(c.executable)} | ${c.preload_inherited} |`), '',
        'Native executable internals are outside module-hook coverage, even when the preload environment is retained. A launch attempt does not establish successful process creation.', '',
        '### Not observed by module hooks', '', 'These packages may supply types, assets or code for other branches/tasks. No deletion or permission recommendation follows.', '',
        ...task.not_observed.map(p => `- ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`), '',
        `Execution evidence: [trial](evidence/${task.trial}.json).`, ''];
    }),
    ...report.comparison ? ['## Comparison', '', `Input changed: ${report.comparison.conditions.input_changed}; configuration changed: ${report.comparison.conditions.config_changed}; observer changed: ${report.comparison.conditions.observer_changed}.`,
      `Environment changes: ${report.comparison.conditions.environment_changed.join(', ') || '(none)'}.`, '',
      ...report.comparison.tasks.flatMap(t => [`### ${escape(t.task)} — ${t.state}`, '', ...t.warnings.map(w => '- ' + escape(w)),
        ...t.added.map(p => `- Newly observed: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
        ...t.removed.map(p => `- No longer observed: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
        ...t.version_changes.map(p => `- Observed version changed: ${escape(p.name)} ${escape(p.before)} → ${escape(p.after)} — ${escape(p.path)}`), '']),
      ...report.comparison.limitations.map(s => '- ' + escape(s)), ''] : [],
    '## Cost', '', 'Execution timings, installation counts, boundary checks and file changes are in report.json/report.md. Task duration includes instrumentation; collection/inventory are measured separately. An overhead comparison requires a matching ordinary run.', '',
  ].join('\n');
}

export async function runObservation(options: { configPath: string; limitsPath: string; output?: string; baselinePath?: string; keepWorkspaces?: boolean; signal?: AbortSignal; onProgress?: (message: string) => void }): Promise<UsageReport> {
  const baseline = options.baselinePath ? await loadUsage(options.baselinePath) : undefined;
  const execution = await runExperiment({ ...options, mode: 'observe' });
  const tasks: UsageReport['tasks'] = Object.keys(execution.policies).map(task => execution.dependency_observations?.[task] ?? { task, capture_status: 'not_run', reason: 'Task did not reach instrumented execution; inspect execution report' });
  const report: UsageReport = { schema_version: 1, kind: 'dependency_usage', version: VERSION, observer_version: OBSERVER_VERSION,
    status: execution.status === 'failed' ? 'failed' : execution.status === 'verified' && tasks.every(t => t.capture_status === 'captured') ? 'observed' : 'incomplete',
    output: execution.output, execution_report: 'report.json', started_at: execution.started_at, finished_at: execution.finished_at,
    environment: execution.environment, inputs: execution.inputs, limits: OBSERVATION_LIMITS, tasks, limitations: [...OBSERVATION_SCOPE,
      'The task gains one private collector-directory write exception under @tmp. The preload is write-denied; install and boundary probes are not instrumented. Instrumentation can affect execution and timing.'],
  };
  if (baseline) report.comparison = compareUsage(baseline, report, path.resolve(options.baselinePath!));
  await saveJson(path.join(report.output, 'usage.json'), report);
  await fs.writeFile(path.join(report.output, 'usage.md'), usageMarkdown(report), { mode: 0o600 });
  return report;
}
