import type { Comparable } from './usage-report.js';
import { escape } from './usage-comparison.js';
import { packagePaths, type PackageContext } from './package-context.js';

type Capture = 'captured' | 'incomplete' | 'unavailable' | 'not_collected' | 'not_run';
type Source = { capture_status: Capture; record: 'present' | 'absent'; files: number | null };
type Instance = { path: string; name: string; version: string; node: Source; typescript: Source;
  esbuild: Source & { contributions: { output: string; bytes_in_output: number }[] };
  context?: { state: 'saved' | 'partial' | 'not_saved'; parents: PackageContext['edges']; paths: string[][]; paths_bounded: boolean;
    structure?: PackageContext['structures'][number]; observed_parents: { parent: string; target: string; request: string }[]; issues: string[] } };
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
      module_capture: task.module_capture_status ?? task.capture_status, compiler_capture: task.compilation?.capture_status ?? 'not_collected', build_capture: task.bundling?.capture_status ?? 'not_collected',
      instances: packages.map(p => {
        const n = task.loaded_packages.find(x => x.path === p.path), c = task.compilation?.packages.find(x => x.path === p.path), b = task.bundling?.packages.find(x => x.path === p.path);
        const saved = task.inventory?.context, paths = saved ? packagePaths(saved, p.path) : { paths: [], bounded: false };
        const structure = saved?.structures.find(s => s.path === p.path);
        return { path: p.path, name: p.name, version: p.version,
          context: { state: saved ? !saved.issues.length && structure?.complete ? 'saved' : 'partial' : 'not_saved', parents: saved?.edges.filter(e => e.target === p.path) ?? [],
            paths: paths.paths, paths_bounded: paths.bounded, structure,
            observed_parents: [...new Map((task.edges ?? []).filter(e => e.package === p.path).map(e => [JSON.stringify(e), { parent: e.parent, target: e.target, request: e.request }])).values()],
            issues: saved?.issues ?? ['Installation relationships and package structure were not saved in this report'] },
          node: { ...source(task.module_capture_status ?? task.capture_status, n?.modules), record: n ? 'present' : 'absent' },
          typescript: source(task.compilation?.capture_status ?? 'not_collected', c?.files),
          esbuild: { ...source(task.bundling?.capture_status ?? 'not_collected', b?.files), contributions: b?.contributions ?? [] } };
      }), issues: [...task.issues ?? [], ...task.inventory?.issues ?? [], ...task.coverage_gaps ?? [], ...task.compilation?.issues ?? [], ...task.bundling?.issues ?? []] };
  });
  const partial = report.status !== 'observed' || tasks.some(t => t.inventory !== 'complete' || t.module_capture !== 'captured' ||
    [t.compiler_capture, t.build_capture].some(c => c !== 'captured' && c !== 'not_collected') || t.instances.some(p => p.node.record === 'present' && p.node.files === null));
  return { schema_version: 1, kind: 'dependency_package_inspection', report: file, package: name, status: partial ? 'partial' : 'complete',
    found: tasks.some(t => t.instances.length > 0), tasks,
    limitations: ['Counts describe separate sources from saved task records, not unused packages, all reads or necessary permissions.',
      'Installation relationships are declarations resolved within the recorded npm directory layout, not observed loads or a guarantee that version ranges are satisfied. Root paths are bounded examples.',
      'Package entries and file summaries describe prepared task inputs. Filename classification does not evaluate exports, custom loaders, resource reads or package necessity. Other/extensionless files remain visible.',
      'No record, a source not collected, incomplete capture and a recorded zero-byte contribution are distinct. Missing records do not justify deletion or permission removal.',
      'Each installation location is a separate instance, including equal names/versions at nested locations. Tasks are separate executions.',
      'This view does not collect new evidence. Detailed files, reasons and import chains remain in the original usage report.'] };
}

export function packageContextLines(p: Instance, details = false): string[] {
  const c = p.context;
  if (!c || c.state === 'not_saved') return ['安装关系与包结构：未保存；不读取当前项目补充历史资料。'];
  const limit = details ? 64 : 6, s = c.structure, f = s?.files;
  return [`安装关系（声明与目录布局）：${c.parents.length} 个父依赖${c.state === 'partial' ? '；资料有缺口' : ''}`,
    ...c.parents.slice(0, limit).map(e => `${e.from} → ${e.name}（${e.kind} ${e.range}）`),
    ...c.parents.length > limit ? [`另有 ${c.parents.length - limit} 个父依赖；加 --details 查看。`] : [],
    ...c.paths.map(trail => '根项目引入路径：' + trail.join(' → ')),
    ...!c.paths.length ? ['保存的安装关系中未找到根项目引入路径；不代表没有用途。'] : [],
    ...c.paths_bounded ? ['引入路径查询有数量/深度上限，不是全部路径。'] : [],
    ...s?.entries.slice(0, limit).map(e => `入口声明 ${e.field}：${e.target}（${({ file_present: '文件在清单中', not_in_manifest: '未找到对应文件', outside_package: '包范围之外', manifest_not_saved: '文件清单未保存' })[e.evidence]}）`) ?? [],
    ...s && s.entries.length > limit ? ['其他入口声明可用 --details 查看。'] : [],
    f ? `包文件结构：${f.total} 个文件；声明 ${f.declarations}；JavaScript ${f.javascript}；TypeScript 代码 ${f.typescript}；原生 ${f.native}；Wasm ${f.wasm}；其他 ${f.other}；符号链接 ${f.symlinks}（${s!.complete ? '完整' : '不完整'}）` : '包文件结构：未保存。',
    ...f && s?.complete && f.declarations > 0 && !f.javascript && !f.typescript && !f.native && !f.wasm ? ['结构中有类型声明，未发现已识别的常见运行时代码文件。普通模块加载记录不能代替类型输入观察；其他文件与实际用途仍需分别判断。'] : [],
    `实际解析记录：${c.observed_parents.length} 条${details ? '' : '（与上述安装关系不同）'}`,
    ...c.observed_parents.slice(0, limit).map(e => `${e.parent} → ${e.target}（${e.request}）`),
    ...c.observed_parents.length > limit ? [`还有 ${c.observed_parents.length - limit} 条解析记录，完整列表在 JSON 中。`] : [],
    ...[...c.issues, ...s?.issues ?? []].map(i => '解释资料提示：' + i)];
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
    ]), '', ...report.tasks.flatMap(t => t.instances.flatMap(p => [`### ${escape(t.task)} · ${escape(p.name)} ${escape(p.version)} · ${escape(p.path)}`, '', ...packageContextLines(p, true).map(s => '- ' + escape(s)), ''])),
    ...report.limitations.map(s => '- ' + escape(s)), ''].join('\n');
}
