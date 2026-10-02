import type { CompilationObservation } from './typescript-observation.js';
import type { Comparable } from './usage-report.js';
import { compareBundling, bundlingComparisonMarkdown, type BundlingComparison } from './esbuild-comparison.js';

type PackageRef = { path: string; name: string; version: string };
export type UsageComparison = { baseline: string; conditions: { input_changed: boolean; config_changed: boolean; limits_changed: boolean; environment_changed: string[]; observer_changed: boolean };
  tasks: { task: string; state: 'compared' | 'added_task' | 'removed_task' | 'unavailable'; warnings: string[];
    added: PackageRef[]; removed: PackageRef[]; version_changes: { path: string; name: string; before: string; after: string }[];
    compilation?: CompilationComparison; bundling?: BundlingComparison }[];
  limitations: string[] };
export type CompilationComparison = { state: 'compared' | 'unavailable'; warnings: string[]; added: PackageRef[]; removed: PackageRef[];
  version_changes: { path: string; name: string; before: string; after: string }[];
  added_files: string[]; removed_files: string[]; explanation_changes: { path: string; before: string[]; after: string[] }[] };

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
export function compareUsage(previous: Comparable, current: Pick<Comparable, 'tasks' | 'environment' | 'observer_version'> & { inputs: Record<string, unknown> }, baseline: string): UsageComparison {
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

export const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[|`\[\]]/g, '\\$&');
export function comparisonMarkdown(comparison: UsageComparison): string[] {
  return ['## Comparison', '', `Input changed: ${comparison.conditions.input_changed}; configuration changed: ${comparison.conditions.config_changed}; observer changed: ${comparison.conditions.observer_changed}.`,
      `Environment changes: ${comparison.conditions.environment_changed.map(escape).join(', ') || '(none)'}; trusted limits changed: ${comparison.conditions.limits_changed}.`, '',
      ...comparison.tasks.flatMap(t => [`### ${escape(t.task)} — ${t.state}`, '', ...t.warnings.map(w => '- ' + escape(w)),
        ...t.added.map(p => `- Newly observed: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
        ...t.removed.map(p => `- No longer observed: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
        ...t.version_changes.map(p => `- Observed version changed: ${escape(p.name)} ${escape(p.before)} → ${escape(p.after)} — ${escape(p.path)}`), '']),
      ...comparison.tasks.flatMap(t => t.compilation ? [`### ${escape(t.task)} — compiler-input comparison (${t.compilation.state})`, '',
        ...t.compilation.warnings.map(w => '- ' + escape(w)),
        ...t.compilation.added.map(p => `- Newly recorded compiler-input package: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
        ...t.compilation.removed.map(p => `- No longer recorded as compiler input: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
        ...t.compilation.version_changes.map(p => `- Compiler-input package version changed: ${escape(p.name)} ${escape(p.before)} → ${escape(p.after)}`),
        ...t.compilation.added_files.map(p => '- Newly recorded compilation file: ' + escape(p)),
        ...t.compilation.removed_files.map(p => '- No longer recorded compilation file: ' + escape(p)),
        ...t.compilation.explanation_changes.map(f => `- Compilation explanation changed: ${escape(f.path)} — ${f.before.map(escape).join('; ')} → ${f.after.map(escape).join('; ')}`), ''] : []),
      ...comparison.tasks.flatMap(t => t.bundling ? bundlingComparisonMarkdown(t.task, t.bundling) : []),
      ...comparison.limitations.map(s => '- ' + escape(s)), ''];
}
