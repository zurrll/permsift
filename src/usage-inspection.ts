import type { Comparable } from './usage-report.js';
import { escape } from './usage-comparison.js';

type Capture = 'captured' | 'incomplete' | 'unavailable' | 'not_collected' | 'not_run';
type Source = { capture_status: Capture; record: 'present' | 'absent'; files: number | null };
type Instance = { path: string; name: string; version: string; node: Source; typescript: Source;
  esbuild: Source & { contributions: { output: string; bytes_in_output: number }[] } };
export type PackageInspection = { schema_version: 1; kind: 'dependency_package_inspection'; report: string; package: string;
  status: 'complete' | 'partial'; found: boolean; tasks: { task: string; verdict?: 'pass' | 'fail' | 'unknown';
    inventory: 'complete' | 'incomplete' | 'not_saved' | 'not_run'; module_capture: Capture; compiler_capture: Capture; build_capture: Capture;
    instances: Instance[]; issues: string[] }[]; limitations: string[] };

/** A focused projection of saved facts. It neither executes tasks nor infers package roles. */
export function inspectPackage(report: Comparable, name: string, file: string): PackageInspection {
  if (!name || name.length > 256 || /[\u0000-\u0020\u007f]/.test(name)) throw new Error('--package requires an exact package name');
  const tasks: PackageInspection['tasks'] = report.tasks.map(task => {
    if (task.capture_status === 'not_run') return { task: task.task, inventory: 'not_run', module_capture: 'not_run',
      compiler_capture: 'not_run', build_capture: 'not_run', instances: [], issues: [task.reason] };
    const packages = [...new Map([...task.inventory?.packages ?? [], ...task.loaded_packages,
      ...task.compilation?.packages ?? [], ...task.bundling?.packages ?? []].filter(p => p.name === name).map(p => [p.path, p])).values()]
      .sort((a, b) => a.path.localeCompare(b.path));
    const source = (capture: Capture, files?: readonly string[]): Source => ({ capture_status: capture, record: files ? 'present' : 'absent', files: files?.length ?? null });
    return { task: task.task, verdict: task.verdict, inventory: task.inventory ? task.inventory.complete ? 'complete' : 'incomplete' : 'not_saved',
      module_capture: task.capture_status, compiler_capture: task.compilation?.capture_status ?? 'not_collected', build_capture: task.bundling?.capture_status ?? 'not_collected',
      instances: packages.map(p => {
        const n = task.loaded_packages.find(x => x.path === p.path), c = task.compilation?.packages.find(x => x.path === p.path), b = task.bundling?.packages.find(x => x.path === p.path);
        return { path: p.path, name: p.name, version: p.version,
          node: { ...source(task.capture_status, n?.modules), record: n ? 'present' : 'absent' },
          typescript: source(task.compilation?.capture_status ?? 'not_collected', c?.files),
          esbuild: { ...source(task.bundling?.capture_status ?? 'not_collected', b?.files), contributions: b?.contributions ?? [] } };
      }), issues: [...task.issues ?? [], ...task.inventory?.issues ?? [], ...task.coverage_gaps ?? [], ...task.compilation?.issues ?? [], ...task.bundling?.issues ?? []] };
  });
  const partial = report.status !== 'observed' || tasks.some(t => t.inventory !== 'complete' || t.module_capture !== 'captured' ||
    [t.compiler_capture, t.build_capture].some(c => c !== 'captured' && c !== 'not_collected') || t.instances.some(p => p.node.record === 'present' && p.node.files === null));
  return { schema_version: 1, kind: 'dependency_package_inspection', report: file, package: name, status: partial ? 'partial' : 'complete',
    found: tasks.some(t => t.instances.length > 0), tasks,
    limitations: ['Counts describe separate sources from saved task records, not unused packages, all reads or necessary permissions.',
      'No record, a source not collected, incomplete capture and a recorded zero-byte contribution are distinct. Missing records do not justify deletion or permission removal.',
      'Each installation location is a separate instance, including equal names/versions at nested locations. Tasks are separate executions.',
      'This view does not collect new evidence. Detailed files, reasons and import chains remain in the original usage report.'] };
}

export function inspectionMarkdown(report: PackageInspection): string {
  const cell = (source: Source) => source.capture_status === 'not_collected' || source.capture_status === 'not_run' ? source.capture_status.replaceAll('_', ' ') :
    `${source.record === 'absent' ? 'no record' : source.files === null ? 'package recorded; file list not saved' : source.files + (source.files === 1 ? ' file' : ' files')} [${source.capture_status}]`;
  return ['# Package across tasks: ' + escape(report.package), '', `Analysis: **${report.status}**; saved report: ${escape(report.report)}. No tasks executed.`, '',
    '| Task | Outcome | Version | Installed location | Node module records | TypeScript inputs | esbuild inputs | Per-output bytes |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.tasks.flatMap(t => t.instances.map(p => `| ${escape(t.task)} | ${t.verdict ?? 'not run'} | ${escape(p.version)} | ${escape(p.path)} | ${cell(p.node)} | ${cell(p.typescript)} | ${cell(p.esbuild)} | ${p.esbuild.capture_status === 'not_collected' ? 'not collected' : (p.esbuild.contributions.map(c => escape(c.output) + ': ' + c.bytes_in_output).join('<br>') || 'no reported contribution') + ` [${p.esbuild.capture_status}]`} |`)), '',
    ...report.tasks.flatMap(t => [
      `- ${escape(t.task)}: inventory ${t.inventory}; module capture ${t.module_capture}; compiler capture ${t.compiler_capture}; build capture ${t.build_capture}.`,
      ...!t.instances.length ? [`  ${t.inventory === 'complete' ? 'No matching installed instance in this recorded task inventory.' : 'No matching instance in retained records; inventory was not saved, was incomplete or the task did not run.'}`] : [],
      ...[...new Set(t.issues)].map(s => '  ' + escape(s)),
    ]), '', ...report.limitations.map(s => '- ' + escape(s)), ''].join('\n');
}
