import type { BundlingObservation } from './esbuild-observation.js';

type PackageRef = { path: string; name: string; version: string };
export type BundlingComparison = {
  state: 'compared' | 'unavailable'; warnings: string[]; added: PackageRef[]; removed: PackageRef[];
  version_changes: { path: string; name: string; before: string; after: string }[];
  added_inputs: string[]; removed_inputs: string[]; added_outputs: string[]; removed_outputs: string[];
  changed_outputs: { path: string; before_bytes: number; after_bytes: number; imports_changed: boolean; entry_changed: boolean }[];
  contribution_changes: { path: string; name: string; output: string; before_bytes: number | null; after_bytes: number | null }[];
  chain_changes: { path: string; before: string[]; after: string[] }[];
  external_changes: { output: string; path: string; kind: string; state: 'added' | 'removed' }[];
};

export function compareBundling(a: BundlingObservation | undefined, b: BundlingObservation | undefined): BundlingComparison {
  const r: BundlingComparison = { state: a && b ? 'compared' : 'unavailable', warnings: [], added: [], removed: [], version_changes: [],
    added_inputs: [], removed_inputs: [], added_outputs: [], removed_outputs: [], changed_outputs: [], contribution_changes: [], chain_changes: [], external_changes: [] };
  if (!a || !b) { r.warnings.push('Build metadata was not collected in both runs; no absence conclusions are available'); return r; }
  if (a.capture_status !== 'captured' || b.capture_status !== 'captured') r.warnings.push('Build metadata capture was partial/unavailable; differences are partial observations, not proven removals');
  if (a.collector_version !== b.collector_version) r.warnings.push('Build metadata collector changed');
  if (JSON.stringify(a.limits) !== JSON.stringify(b.limits)) r.warnings.push('Build metadata collector limits changed');
  if (a.bundler?.path !== b.bundler?.path || a.bundler?.version !== b.bundler?.version) r.warnings.push('esbuild location/version changed');
  if (a.output_root !== b.output_root || a.metafile !== b.metafile) r.warnings.push('Declared metadata/output scope changed');
  if (JSON.stringify(a.executed_command) !== JSON.stringify(b.executed_command)) r.warnings.push('Observed build command changed');
  const oldPackages = new Map(a.packages.map(p => [p.path, p])), newPackages = new Map(b.packages.map(p => [p.path, p]));
  const ref = (p: PackageRef) => ({ path: p.path, name: p.name, version: p.version });
  for (const [path, p] of newPackages) {
    const old = oldPackages.get(path);
    if (!old || old.name !== p.name) r.added.push(ref(p));
    else if (old.version !== p.version) r.version_changes.push({ path, name: p.name, before: old.version, after: p.version });
  }
  for (const [path, p] of oldPackages) if (!newPackages.has(path) || newPackages.get(path)!.name !== p.name) r.removed.push(ref(p));
  const oldInputs = new Map(a.inputs.map(i => [i.path, i])), newInputs = new Map(b.inputs.map(i => [i.path, i]));
  r.added_inputs = [...newInputs.keys()].filter(p => !oldInputs.has(p)); r.removed_inputs = [...oldInputs.keys()].filter(p => !newInputs.has(p));
  for (const [path, i] of newInputs) {
    const old = oldInputs.get(path);
    if (old && JSON.stringify(old.entry_chain) !== JSON.stringify(i.entry_chain)) r.chain_changes.push({ path, before: old.entry_chain, after: i.entry_chain });
  }
  const oldOutputs = new Map(a.outputs.map(o => [o.path, o])), newOutputs = new Map(b.outputs.map(o => [o.path, o]));
  r.added_outputs = [...newOutputs.keys()].filter(p => !oldOutputs.has(p)); r.removed_outputs = [...oldOutputs.keys()].filter(p => !newOutputs.has(p));
  for (const [path, o] of newOutputs) {
    const old = oldOutputs.get(path);
    if (!old) continue;
    const imports_changed = JSON.stringify(old.imports) !== JSON.stringify(o.imports), entry_changed = old.entry_point !== o.entry_point;
    if (old.bytes !== o.bytes || imports_changed || entry_changed) r.changed_outputs.push({ path, before_bytes: old.bytes, after_bytes: o.bytes, imports_changed, entry_changed });
  }
  for (const path of [...new Set([...oldPackages.keys(), ...newPackages.keys()])].sort()) {
    const before = oldPackages.get(path), after = newPackages.get(path);
    const old = new Map(before?.contributions.map(c => [c.output, c.bytes_in_output])), now = new Map(after?.contributions.map(c => [c.output, c.bytes_in_output]));
    for (const output of [...new Set([...old.keys(), ...now.keys()])].sort()) {
      const before_bytes = old.get(output) ?? null, after_bytes = now.get(output) ?? null;
      if (before_bytes !== after_bytes) r.contribution_changes.push({ path, name: after?.name ?? before!.name, output, before_bytes, after_bytes });
    }
  }
  const external = (c: BundlingObservation) => new Map(c.outputs.flatMap(o => o.imports.filter(i => i.external).map(i => [JSON.stringify([o.path, i.path, i.kind]), { output: o.path, path: i.path, kind: i.kind }] as const)));
  const before = external(a), after = external(b);
  for (const [key, e] of after) if (!before.has(key)) r.external_changes.push({ ...e, state: 'added' });
  for (const [key, e] of before) if (!after.has(key)) r.external_changes.push({ ...e, state: 'removed' });
  return r;
}

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\u0000-\u001f]/g, ' ').replace(/[|`\[\]]/g, '\\$&');
export function bundlingMarkdown(b: BundlingObservation): string[] {
  const packages = new Map(b.packages.map(p => [p.path, p]));
  return ['### esbuild build metadata', '', `Source: ${b.source}; collector: ${b.collector_version}; capture: **${b.capture_status}**; bundler: ${b.bundler ? escape('esbuild ' + b.bundler.version) : 'unidentified'}.`,
    `Metadata: ${escape(b.metafile)}; output scope: ${escape(b.output_root)}. Read from this task's fresh isolated output directory; no second build.`, '',
    ...b.issues.map(s => '- Build metadata issue: ' + escape(s)), ...b.limitations.map(s => '- ' + escape(s)), '',
    '| Reported output | Bytes | Entry input | Output references |', '| --- | --- | --- | --- |',
    ...b.outputs.map(o => `| ${escape(o.path)} | ${o.bytes} | ${escape(o.entry_point ?? '(chunk/asset)')} | ${o.imports.map(i => `${escape(i.path)} (${escape(i.kind)}, ${i.external ? 'external' : 'output'})`).join('<br>')} |`), '',
    '| Build input | Package | Output contribution in bytes | One entry-to-input chain |', '| --- | --- | --- | --- |',
    ...b.inputs.map(i => {
      const matches = b.outputs.flatMap(o => o.inputs.filter(c => c.path === i.path).map(c => `${escape(o.path)}: ${c.bytes_in_output}`));
      return `| ${escape(i.path)} | ${escape(i.package ? packages.get(i.package)?.name ?? '(unmapped)' : '(project)')} | ${matches.join('<br>') || 'no reported contribution'} | ${i.entry_chain.map(escape).join(' → ') || 'no bounded chain'} |`;
    }), '', 'Zero/no reported contribution describes this build metadata only. It does not establish that an input was never read or its package can be removed.', ''];
}
export function bundlingComparisonMarkdown(task: string, b: BundlingComparison): string[] {
  return [`### ${escape(task)} — build-metadata comparison (${b.state})`, '', ...b.warnings.map(s => '- ' + escape(s)),
    ...b.added.map(p => `- Newly recorded build-input package: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
    ...b.removed.map(p => `- No longer recorded build-input package: ${escape(p.name)} ${escape(p.version)} — ${escape(p.path)}`),
    ...b.version_changes.map(p => `- Build-input package version changed: ${escape(p.name)} ${escape(p.before)} → ${escape(p.after)} — ${escape(p.path)}`),
    ...b.added_inputs.map(p => '- Newly recorded build input: ' + escape(p)), ...b.removed_inputs.map(p => '- No longer recorded build input: ' + escape(p)),
    ...b.added_outputs.map(p => '- Newly recorded output: ' + escape(p)), ...b.removed_outputs.map(p => '- No longer recorded output: ' + escape(p)),
    ...b.changed_outputs.map(o => `- Output changed: ${escape(o.path)} — ${o.before_bytes} → ${o.after_bytes} bytes; references changed: ${o.imports_changed}; entry changed: ${o.entry_changed}`),
    ...b.contribution_changes.map(c => `- Package output contribution changed: ${escape(c.name)} in ${escape(c.output)} — ${c.before_bytes ?? 'no record'} → ${c.after_bytes ?? 'no record'} bytes`),
    ...b.chain_changes.map(i => `- Entry chain changed: ${escape(i.path)} — ${i.before.map(escape).join(' → ')} → ${i.after.map(escape).join(' → ')}`),
    ...b.external_changes.map(e => `- External reference ${e.state}: ${escape(e.path)} (${escape(e.kind)}) in ${escape(e.output)}`), ''];
}
