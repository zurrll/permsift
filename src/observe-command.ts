import * as fs from 'node:fs/promises';
import path from 'node:path';
import { runExperimentWithFacts, VERSION } from './engine.js';
import { saveJson } from './filesystem.js';
import { OBSERVATION_LIMITS, OBSERVATION_SCOPE, type TaskObservation } from './observation.js';
import { OBSERVER_VERSION } from './observation-runtime.js';
import { bundlingMarkdown } from './esbuild-comparison.js';
import { loadUsage } from './usage-report.js';
import { compareUsage, comparisonMarkdown, escape, type UsageComparison } from './usage-comparison.js';
import { publishSummary } from './result-output.js';
export { loadUsage } from './usage-report.js';
export { compareUsage, type UsageComparison, type CompilationComparison } from './usage-comparison.js';

type NotRun = { task: string; capture_status: 'not_run'; reason: string };
export type UsageReport = { schema_version: 1; kind: 'dependency_usage'; version: string; observer_version: string;
  status: 'observed' | 'failed' | 'incomplete'; output: string; execution_report: string; started_at: string; finished_at?: string;
  environment: Record<string, string>; inputs: Record<string, unknown>; limits: typeof OBSERVATION_LIMITS;
  tasks: (TaskObservation | NotRun)[]; limitations: string[]; comparison?: UsageComparison };
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
    ...report.comparison ? comparisonMarkdown(report.comparison) : [],
    '## Cost', '', 'Execution timings, installation counts, boundary checks and file changes are in report.json/report.md. Task duration includes instrumentation; collection/inventory are measured separately. An overhead comparison requires a matching ordinary run.', '',
  ].join('\n');
}

export async function runObservation(options: { configPath: string; limitsPath: string; output?: string; baselinePath?: string; keepWorkspaces?: boolean; saveArtifacts?: boolean; signal?: AbortSignal; onProgress?: (message: string) => void }): Promise<UsageReport> {
  const baseline = options.baselinePath ? await loadUsage(options.baselinePath) : undefined;
  const { report: execution, execution: phase } = await runExperimentWithFacts({ ...options, mode: 'observe' });
  const tasks: UsageReport['tasks'] = phase.taskKeys.map(task => phase.observations[task] ?? { task, capture_status: 'not_run', reason: 'Task did not reach instrumented execution; inspect execution report' });
  const report: UsageReport = { schema_version: 1, kind: 'dependency_usage', version: VERSION, observer_version: OBSERVER_VERSION,
    status: phase.status === 'failed' ? 'failed' : phase.status === 'verified' && tasks.every(t => t.capture_status === 'captured' && (!t.compilation || t.compilation.capture_status === 'captured') && (!t.bundling || t.bundling.capture_status === 'captured')) ? 'observed' : 'incomplete',
    output: execution.output, execution_report: 'report.json', started_at: execution.started_at, finished_at: execution.finished_at,
    environment: execution.environment, inputs: execution.inputs, limits: OBSERVATION_LIMITS, tasks, limitations: [...OBSERVATION_SCOPE,
      'The task gains one private collector-directory write exception under @tmp. The preload is write-denied; install and boundary probes are not instrumented. Instrumentation can affect execution and timing.'],
  };
  if (baseline) report.comparison = compareUsage(baseline, report, path.resolve(options.baselinePath!));
  await saveJson(path.join(report.output, 'usage.json'), report);
  await fs.writeFile(path.join(report.output, 'usage.md'), usageMarkdown(report), { mode: 0o600 });
  await publishSummary(path.join(report.output, 'usage.json'), path.join(report.output, 'usage.md'));
  return report;
}
