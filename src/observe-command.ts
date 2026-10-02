import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { runExperiment, VERSION } from './engine.js';
import { saveJson } from './filesystem.js';
import { OBSERVATION_LIMITS, OBSERVATION_SCOPE, type TaskObservation } from './observation.js';
import { OBSERVER_VERSION } from './observation-runtime.js';
import { compilationSchema, type CompilationObservation } from './typescript-observation.js';
import { bundlingSchema, validateBundling } from './esbuild-observation.js';
import { compareBundling, bundlingMarkdown, bundlingComparisonMarkdown, type BundlingComparison } from './esbuild-comparison.js';

type NotRun = { task: string; capture_status: 'not_run'; reason: string };
export type UsageReport = { schema_version: 1; kind: 'dependency_usage'; version: string; observer_version: string;
  status: 'observed' | 'failed' | 'incomplete'; output: string; execution_report: string; started_at: string; finished_at?: string;
  environment: Record<string, string>; inputs: Record<string, unknown>; limits: typeof OBSERVATION_LIMITS;
  tasks: (TaskObservation | NotRun)[]; limitations: string[]; comparison?: UsageComparison };
type PackageRef = { path: string; name: string; version: string };
export type UsageComparison = { baseline: string; conditions: { input_changed: boolean; config_changed: boolean; limits_changed: boolean; environment_changed: string[]; observer_changed: boolean };
  tasks: { task: string; state: 'compared' | 'added_task' | 'removed_task' | 'unavailable'; warnings: string[];
    added: PackageRef[]; removed: PackageRef[]; version_changes: { path: string; name: string; before: string; after: string }[];
    compilation?: CompilationComparison; bundling?: BundlingComparison }[];
  limitations: string[] };
export type CompilationComparison = { state: 'compared' | 'unavailable'; warnings: string[]; added: PackageRef[]; removed: PackageRef[];
  version_changes: { path: string; name: string; before: string; after: string }[];
  added_files: string[]; removed_files: string[]; explanation_changes: { path: string; before: string[]; after: string[] }[] };

const text = z.string().max(4096), digest = z.string().regex(/^[a-f0-9]{64}$/);
const pkg = z.object({ path: text.regex(/^@workspace\//), name: text, version: text });
const taskSchema = z.union([
  z.object({ task: text, capture_status: z.literal('not_run'), reason: text }),
  z.object({ task: text, capture_status: z.enum(['captured', 'incomplete', 'unavailable']), task_definition_hash: digest,
    verdict: z.enum(['pass', 'fail', 'unknown']), loaded_packages: z.array(pkg).max(2048), compilation: compilationSchema.optional(), bundling: bundlingSchema.optional() }),
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
  for (const task of parsed.tasks) if (task.capture_status !== 'not_run' && task.compilation) {
    const c = task.compilation;
    if (new Set(c.files.map(f => f.path)).size !== c.files.length || new Set(c.packages.map(p => p.path)).size !== c.packages.length) throw new Error('Duplicate compiler inputs in usage baseline');
    if (c.capture_status === 'captured' && (!c.compiler || !c.files.length || c.issues.length)) throw new Error('Complete compiler capture requires an identified compiler and explained files without issues');
    const packages = new Map(c.packages.map(p => [p.path, p]));
    for (const file of c.files) if (file.package && !packages.has(file.package)) throw new Error('Compiler input references a missing package');
    for (const pkg of c.packages) {
      const expected = c.files.filter(f => f.package === pkg.path).map(f => f.path).sort();
      if (!pkg.path.startsWith('@workspace/') || !expected.length || JSON.stringify([...pkg.files].sort()) !== JSON.stringify(expected)) throw new Error('Compiler package files do not match attributed inputs');
    }
  }
  for (const task of parsed.tasks) if (task.capture_status !== 'not_run' && task.bundling) validateBundling(task.bundling);
  return parsed;
}
function compareCompilation(a: CompilationObservation | undefined, b: CompilationObservation | undefined): CompilationComparison {
  const result: CompilationComparison = { state: a && b ? 'compared' : 'unavailable', warnings: [], added: [], removed: [], version_changes: [], added_files: [], removed_files: [], explanation_changes: [] };
  if (!a || !b) { result.warnings.push('Compiler inputs were not collected in both runs; no absence conclusions are available'); return result; }
  if (a.capture_status !== 'captured' || b.capture_status !== 'captured') result.warnings.push('Compiler capture was partial/unavailable; differences are partial observations, not proven removals');
  if (a.collector_version !== b.collector_version) result.warnings.push('Compiler collector changed');
  if (JSON.stringify(a.limits) !== JSON.stringify(b.limits)) result.warnings.push('Compiler collector limits changed');
  if (a.compiler?.path !== b.compiler?.path || a.compiler?.version !== b.compiler?.version) result.warnings.push('TypeScript compiler location/version changed');
  if (JSON.stringify(a.executed_command) !== JSON.stringify(b.executed_command)) result.warnings.push('Observed compiler command changed');
  const before = new Map(a.packages.map(p => [p.path, p])), after = new Map(b.packages.map(p => [p.path, p]));
  const ref = (p: PackageRef): PackageRef => ({ path: p.path, name: p.name, version: p.version });
  for (const [path, p] of after) {
    const old = before.get(path);
    if (!old || old.name !== p.name) result.added.push(ref(p));
    else if (old.version !== p.version) result.version_changes.push({ path, name: p.name, before: old.version, after: p.version });
  }
  for (const [path, p] of before) if (!after.has(path) || after.get(path)!.name !== p.name) result.removed.push(ref(p));
  const oldFiles = new Map(a.files.map(f => [f.path, f])), newFiles = new Map(b.files.map(f => [f.path, f]));
  for (const [path, f] of newFiles) {
    const old = oldFiles.get(path);
    if (!old) result.added_files.push(path);
    else if (JSON.stringify([...old.reasons].sort()) !== JSON.stringify([...f.reasons].sort())) result.explanation_changes.push({ path, before: old.reasons, after: f.reasons });
  }
  result.removed_files = [...oldFiles.keys()].filter(p => !newFiles.has(p));
  return result;
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
    if (a.compilation || b.compilation) row.compilation = compareCompilation(a.compilation, b.compilation);
    if (a.bundling || b.bundling) row.bundling = compareBundling(a.bundling, b.bundling);
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
  return { baseline, conditions, tasks, limitations: ['Differences describe module loads, compiler inputs and build metadata as separate sources. They do not establish unused dependencies, necessity, causality or safe permission removals.', 'A package absent from a partial/failed observation may still be used. Entry paths and versions can change with installation layout.'] };
}
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\u0000-\u001f]/g, ' ').replace(/[|`\[\]]/g, '\\$&');
export function usageMarkdown(report: UsageReport) {
  return ['# Permsift dependency usage', '', `Status: **${report.status}**. Observer: ${report.observer_version}.`, '',
    'Each configured task runs once, with no permission search. Task outcome and each source\'s capture health are separate. Node module loads, optional TypeScript inputs and esbuild metadata are independent observations with different coverage.', '',
    '## Coverage', '', ...report.limitations.map(s => '- ' + escape(s)), '',
    ...report.tasks.flatMap(task => {
      if (task.capture_status === 'not_run') return [`## ${escape(task.task)}`, '', `Not observed: ${escape(task.reason)}`, ''];
      const uniqueNames = new Set(task.inventory.packages.map(p => p.name)).size;
      const uniqueVersions = new Set(task.inventory.packages.map(p => `${p.name}@${p.version}`)).size;
      const compilation = task.compilation;
      const bundling = task.bundling;
      const facts = [...new Map([...task.loaded_packages, ...compilation?.packages ?? [], ...bundling?.packages ?? []].map(p => [p.path, p])).values()].sort((a, b) => a.path.localeCompare(b.path));
      return [`## ${escape(task.task)}`, '', `Task: **${task.verdict}**; module-hook capture: **${task.capture_status}**; ${task.processes.length} instrumented processes/threads; ${task.events} events.`,
        `Installed: **${task.inventory.packages.length} instances**, ${uniqueNames} names, ${uniqueVersions} name/version pairs. Observed module loads: **${task.loaded_packages.length} package instances**.`,
        compilation ? `TypeScript compilation inputs: **${compilation.files.length} files**, **${compilation.packages.length} package instances**; compiler capture: **${compilation.capture_status}**.` : 'TypeScript compilation inputs: **not collected**.',
        bundling ? `esbuild metadata: **${bundling.inputs.length} input files**, **${bundling.outputs.length} outputs**, **${bundling.packages.length} input package instances**; build capture: **${bundling.capture_status}**.` : 'esbuild metadata: **not collected**.',
        '**Module hooks do not cover declaration files, arbitrary resource reads or native tool internals. Packages without a module-load record may still participate in this task; the counts do not measure unused dependencies.**',
        `Inventory complete within limits: ${task.inventory.complete}; lock records: ${task.inventory.locked_instances ?? 'unavailable'}; locked locations not installed: ${task.inventory.locked_not_installed?.length ?? 'unavailable'}.`, '',
        ...task.issues.map(s => '- Capture issue: ' + escape(s)), '',
        ...task.coverage_gaps.map(s => '- Coverage gap: ' + escape(s)), '',
        '### Package evidence by source', '', 'The same package can appear in several columns. Missing records do not classify a package as tool-only or unused; counts cannot be added as used-package totals.', '',
        '| Package | Version | Installed location | Node module-load records | TypeScript input files | esbuild input files | Per-output byte contribution |', '| --- | --- | --- | --- | --- | --- | --- |',
        ...facts.map(p => { const b = bundling?.packages.find(x => x.path === p.path);
          return `| ${escape(p.name)} | ${escape(p.version)} | ${escape(p.path)} | ${task.loaded_packages.find(x => x.path === p.path)?.modules.length ?? 'no record'} | ${compilation ? compilation.packages.find(x => x.path === p.path)?.files.length ?? 'no record' : 'not collected'} | ${bundling ? b?.files.length ?? 'no record' : 'not collected'} | ${bundling ? b?.contributions.map(c => `${escape(c.output)}: ${c.bytes_in_output}`).join('<br>') || 'no reported contribution' : 'not collected'} |`; }), '',
        ...bundling ? bundlingMarkdown(bundling) : [],
        ...compilation ? ['### TypeScript compilation inputs', '', `Source: ${compilation.source}; collector: ${compilation.collector_version}; compiler: ${compilation.compiler ? escape(compilation.compiler.name + ' ' + compilation.compiler.version) : 'unidentified'}.`,
          'Collected from this task execution\'s stdout, with --explainFiles --locale en --pretty false. Raw output and executed command are in trial evidence; no second compilation was run.', '',
          ...compilation.issues.map(s => '- Compiler capture issue: ' + escape(s)), ...compilation.limitations.map(s => '- ' + escape(s)), '',
          '| Compilation file | Kind | Package location | Explanation |', '| --- | --- | --- | --- |',
          ...compilation.files.map(f => `| ${escape(f.path)} | ${f.kind} | ${escape(f.package ?? '(project/unmapped)')} | ${f.reasons.map(escape).join('<br>')} |`), ''] : [],
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
        '### No Node module-load record', '', `**${task.not_observed.length} package instances have no module-hook record. This is not an unused-package count.** This list is specific to module hooks; entries may have compiler/build evidence above or supply native tools, assets or other behavior. No deletion or permission recommendation follows.`, '',
        ...task.not_observed.map(p => `- ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`), '',
        `Execution evidence: [trial](evidence/${task.trial}.json).`, ''];
    }),
    ...report.comparison ? ['## Comparison', '', `Input changed: ${report.comparison.conditions.input_changed}; configuration changed: ${report.comparison.conditions.config_changed}; observer changed: ${report.comparison.conditions.observer_changed}.`,
      `Environment changes: ${report.comparison.conditions.environment_changed.join(', ') || '(none)'}.`, '',
      ...report.comparison.tasks.flatMap(t => [`### ${escape(t.task)} — ${t.state}`, '', ...t.warnings.map(w => '- ' + escape(w)),
        ...t.added.map(p => `- Newly observed: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
        ...t.removed.map(p => `- No longer observed: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
        ...t.version_changes.map(p => `- Observed version changed: ${escape(p.name)} ${escape(p.before)} → ${escape(p.after)} — ${escape(p.path)}`), '']),
      ...report.comparison.tasks.flatMap(t => t.compilation ? [`### ${escape(t.task)} — compiler-input comparison (${t.compilation.state})`, '',
        ...t.compilation.warnings.map(w => '- ' + escape(w)),
        ...t.compilation.added.map(p => `- Newly recorded compiler-input package: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
        ...t.compilation.removed.map(p => `- No longer recorded as compiler input: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
        ...t.compilation.version_changes.map(p => `- Compiler-input package version changed: ${escape(p.name)} ${escape(p.before)} → ${escape(p.after)}`),
        ...t.compilation.added_files.map(p => '- Newly recorded compilation file: ' + escape(p)),
        ...t.compilation.removed_files.map(p => '- No longer recorded compilation file: ' + escape(p)),
        ...t.compilation.explanation_changes.map(f => `- Compilation explanation changed: ${escape(f.path)} — ${f.before.map(escape).join('; ')} → ${f.after.map(escape).join('; ')}`), ''] : []),
      ...report.comparison.tasks.flatMap(t => t.bundling ? bundlingComparisonMarkdown(t.task, t.bundling) : []),
      ...report.comparison.limitations.map(s => '- ' + escape(s)), ''] : [],
    '## Cost', '', 'Execution timings, installation counts, boundary checks and file changes are in report.json/report.md. Task duration includes instrumentation; collection/inventory are measured separately. An overhead comparison requires a matching ordinary run.', '',
  ].join('\n');
}

export async function runObservation(options: { configPath: string; limitsPath: string; output?: string; baselinePath?: string; keepWorkspaces?: boolean; signal?: AbortSignal; onProgress?: (message: string) => void }): Promise<UsageReport> {
  const baseline = options.baselinePath ? await loadUsage(options.baselinePath) : undefined;
  const execution = await runExperiment({ ...options, mode: 'observe' });
  const tasks: UsageReport['tasks'] = Object.keys(execution.policies).map(task => execution.dependency_observations?.[task] ?? { task, capture_status: 'not_run', reason: 'Task did not reach instrumented execution; inspect execution report' });
  const report: UsageReport = { schema_version: 1, kind: 'dependency_usage', version: VERSION, observer_version: OBSERVER_VERSION,
    status: execution.status === 'failed' ? 'failed' : execution.status === 'verified' && tasks.every(t => t.capture_status === 'captured' && (!t.compilation || t.compilation.capture_status === 'captured') && (!t.bundling || t.bundling.capture_status === 'captured')) ? 'observed' : 'incomplete',
    output: execution.output, execution_report: 'report.json', started_at: execution.started_at, finished_at: execution.finished_at,
    environment: execution.environment, inputs: execution.inputs, limits: OBSERVATION_LIMITS, tasks, limitations: [...OBSERVATION_SCOPE,
      'The task gains one private collector-directory write exception under @tmp. The preload is write-denied; install and boundary probes are not instrumented. Instrumentation can affect execution and timing.'],
  };
  if (baseline) report.comparison = compareUsage(baseline, report, path.resolve(options.baselinePath!));
  await saveJson(path.join(report.output, 'usage.json'), report);
  await fs.writeFile(path.join(report.output, 'usage.md'), usageMarkdown(report), { mode: 0o600 });
  return report;
}
