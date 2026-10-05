import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Scenario } from './config.js';
import { contains } from './config.js';
import { packageForModule, type DependencyInventory } from './dependency-inventory.js';
import { hash, noSymlinks, resolveAlias, within, type Roots } from './filesystem.js';
import type { ProcessResult } from './process.js';
import { compilationCommand } from './typescript-observation.js';

export const ESBUILD_OBSERVER_VERSION = 'esbuild-metafile-v1';
export const ESBUILD_LIMITS = { max_bytes: 4_000_000, max_inputs: 4096, max_outputs: 256, max_edges: 16384, max_chain: 64 };
const text = z.string().max(4096), bytes = z.number().int().nonnegative().safe();
const edge = z.object({ path: text, kind: text, external: z.boolean() });
export const bundlingSchema = z.object({
  source: z.literal('esbuild_metafile'), collector_version: text, capture_status: z.enum(['captured', 'incomplete', 'unavailable']),
  bundler: z.object({ path: text, name: z.literal('esbuild'), version: text }).optional(),
  metafile: text, output_root: text, raw_metadata_hash: text.optional(), raw_metadata_bytes: bytes,
  executed_command: z.array(text).max(1024), limits: z.object({ max_bytes: bytes, max_inputs: bytes, max_outputs: bytes, max_edges: bytes, max_chain: bytes }),
  inputs: z.array(z.object({ path: text, bytes, package: text.optional(), imports: z.array(edge).max(16384), entry_chain: z.array(text).max(64) })).max(4096),
  outputs: z.array(z.object({ path: text, bytes, entry_point: text.optional(), css_bundle: text.optional(),
    inputs: z.array(z.object({ path: text, bytes_in_output: bytes })).max(4096), imports: z.array(edge).max(16384), exports: z.array(text).max(4096) })).max(256),
  packages: z.array(z.object({ path: text, name: text, version: text, files: z.array(text).max(4096),
    contributions: z.array(z.object({ output: text, bytes_in_output: bytes })).max(256) })).max(2048),
  issues: z.array(text).max(128), limitations: z.array(text).max(32),
});
export type BundlingObservation = z.infer<typeof bundlingSchema>;
export const ESBUILD_SCOPE = [
  'esbuild-reported inputs and per-output byte contributions for this task, not all filesystem reads, executed code or necessary permissions.',
  'All reported outputs are included, including lazy chunks and assets. Byte contribution is not importance, necessity or sensitive-content detection.',
  'External references are retained import requests, not identified installed packages or proof that a runtime path will execute.',
  'One bounded entry-to-input chain is a graph witness, not every import path. Missing records never justify deletion or permission removal.',
  'The declared output directory is cleared only in the isolated observe copy before execution. The task must write its own full metafile; no second build or implicit project grants.',
  'Cooperative metadata from trusted tasks; fresh files and hashes do not authenticate the producer or prevent forged/replayed content. Plugin virtual inputs are outside first-version attribution.',
];

/** Freshness applies to the whole declared output set, not only one asserted entry. */
export async function prepareBundling(scenario: Pick<Scenario, 'observation' | 'prepare_directories' | 'assertions'>, roots: Roots) {
  const config = scenario.observation?.esbuild;
  if (!config) return;
  const directory = resolveAlias(config.output_root, roots);
  await noSymlinks(roots.workspace, directory);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
  for (const alias of scenario.prepare_directories.filter(p => contains(config.output_root, p))) await fs.mkdir(resolveAlias(alias, roots), { recursive: true });
  for (const assertion of scenario.assertions) if ('path' in assertion && contains(config.output_root, assertion.path)) await fs.mkdir(path.dirname(resolveAlias(assertion.path, roots)), { recursive: true });
}

// Keep a bounded output's sum of <=4096 contributions inside safe integers.
const rawBytes = bytes.max(Math.floor(Number.MAX_SAFE_INTEGER / ESBUILD_LIMITS.max_inputs));
const rawImport = z.object({ path: text, kind: text, external: z.boolean().optional() });
const rawInput = z.object({ bytes: rawBytes, imports: z.array(rawImport).max(16384) });
const rawOutput = z.object({ bytes: rawBytes, inputs: z.record(z.object({ bytesInOutput: rawBytes })), imports: z.array(rawImport).max(16384),
  exports: z.array(text).max(4096), entryPoint: text.optional(), cssBundle: text.optional() });

export async function collectBundling(scenario: Pick<Scenario, 'observation' | 'command'>, inventory: DependencyInventory, roots: Roots, process?: ProcessResult): Promise<BundlingObservation | undefined> {
  const config = scenario.observation?.esbuild;
  if (!config) return;
  const issues: string[] = [], issue = (s: string) => { if (issues.length < 128 && !issues.includes(s)) issues.push(s); };
  const installed = inventory.packages.find(p => p.path === config.bundler && p.name === 'esbuild');
  const result: BundlingObservation = { source: 'esbuild_metafile', collector_version: ESBUILD_OBSERVER_VERSION, capture_status: 'unavailable',
    ...installed ? { bundler: { path: installed.path, name: 'esbuild', version: installed.version } } : {},
    metafile: config.metafile, output_root: config.output_root, raw_metadata_bytes: 0, executed_command: compilationCommand(scenario),
    limits: { ...ESBUILD_LIMITS }, inputs: [], outputs: [], packages: [], issues, limitations: ESBUILD_SCOPE };
  if (!installed) issue('Configured bundler is not an identified installed esbuild package');
  if (!inventory.complete) issue('Installed inventory is partial; package attribution may be incomplete');
  if (!process || process.status !== 'completed' || process.exit_code !== 0) issue('Task did not complete successfully; metadata is a partial observation');
  const inputPath = (value: string): string | undefined => {
    if (!value || value === '<stdin>' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || /^[^/]+:/.test(value)) { issue('Unsupported virtual or oversized metadata path'); return; }
    const absolute = path.resolve(roots.workspace, value);
    if (!within(roots.workspace, absolute)) { issue('Metadata path outside the workspace was not attributed'); return; }
    const alias = '@workspace/' + path.relative(roots.workspace, absolute).split(path.sep).join('/');
    if (alias.length > 4096) { issue('Normalized metadata path exceeds the text limit'); return; }
    return alias;
  };
  let edgeCount = 0;
  const imports = (records: z.infer<typeof rawImport>[]) => {
    const rows: BundlingObservation['inputs'][number]['imports'] = [];
    for (const e of records) {
      if (++edgeCount > ESBUILD_LIMITS.max_edges) { issue('Metadata edge/contribution limit reached'); break; }
      const target = e.external ? (/^[.\/]/.test(e.path) ? inputPath(e.path) : e.path.replace(/[\u0000-\u001f\u007f]/g, ' ')) : inputPath(e.path);
      if (target) rows.push({ path: target, kind: e.kind, external: e.external ?? false });
    }
    return rows.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  };
  try {
    const file = resolveAlias(config.metafile, roots); await noSymlinks(roots.workspace, file);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ESBUILD_LIMITS.max_bytes) throw new Error('Metafile must be a regular file within the 4 MB limit');
    // Bound the read even if a cooperative background writer grows the file.
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: Buffer;
    try {
      if (!(await handle.stat()).isFile()) throw new Error('Metafile changed file kind');
      const buffer = Buffer.alloc(ESBUILD_LIMITS.max_bytes + 1); const read = await handle.read(buffer, 0, buffer.length, 0); raw = buffer.subarray(0, read.bytesRead);
    }
    finally { await handle.close(); }
    result.raw_metadata_bytes = raw.length;
    if (raw.length > ESBUILD_LIMITS.max_bytes) throw new Error('Metafile grew beyond its byte limit');
    const source = raw.toString('utf8'); result.raw_metadata_hash = hash(source);
    const document = z.object({ inputs: z.record(z.unknown()), outputs: z.record(z.unknown()) }).parse(JSON.parse(source));
    const inputEntries = Object.entries(document.inputs).sort(([a], [b]) => a.localeCompare(b));
    const outputEntries = Object.entries(document.outputs).sort(([a], [b]) => a.localeCompare(b));
    if (inputEntries.length > ESBUILD_LIMITS.max_inputs) issue('Metadata input-file limit reached');
    if (outputEntries.length > ESBUILD_LIMITS.max_outputs) issue('Metadata output-file limit reached');
    for (const [name, data] of inputEntries.slice(0, ESBUILD_LIMITS.max_inputs)) {
      const parsed = rawInput.safeParse(data), alias = inputPath(name);
      if (!parsed.success) { issue('Unsupported metadata input record'); continue; }
      if (!alias) continue;
      const pkg = packageForModule(alias, inventory.packages);
      if (alias.includes('/node_modules/') && !pkg) issue('Metadata input has no identified installed package');
      if (result.inputs.some(i => i.path === alias)) { issue('Duplicate normalized metadata input'); continue; }
      result.inputs.push({ path: alias, bytes: parsed.data.bytes, ...pkg ? { package: pkg.path } : {}, imports: imports(parsed.data.imports), entry_chain: [] });
    }
    const byPath = new Map(result.inputs.map(i => [i.path, i]));
    for (const [name, data] of outputEntries.slice(0, ESBUILD_LIMITS.max_outputs)) {
      const parsed = rawOutput.safeParse(data), alias = inputPath(name);
      if (!parsed.success) { issue('Unsupported metadata output record'); continue; }
      if (!alias || !contains(config.output_root, alias) || alias === config.metafile) { issue('Reported output is outside the declared output set or is the metafile itself'); continue; }
      if (result.outputs.some(o => o.path === alias)) { issue('Duplicate normalized metadata output'); continue; }
      const contributions: BundlingObservation['outputs'][number]['inputs'] = [];
      const entries = Object.entries(parsed.data.inputs).sort(([a], [b]) => a.localeCompare(b));
      if (entries.length > ESBUILD_LIMITS.max_inputs) issue('Per-output input limit reached');
      for (const [file, contribution] of entries.slice(0, ESBUILD_LIMITS.max_inputs)) {
        if (++edgeCount > ESBUILD_LIMITS.max_edges) { issue('Metadata edge/contribution limit reached'); break; }
        const target = inputPath(file);
        if (!target || !byPath.has(target)) { issue('Output contribution references an uncollected input'); continue; }
        if (contributions.some(c => c.path === target)) { issue('Duplicate normalized output contribution'); continue; }
        contributions.push({ path: target, bytes_in_output: contribution.bytesInOutput });
      }
      const entry_point = parsed.data.entryPoint ? inputPath(parsed.data.entryPoint) : undefined;
      const css_bundle = parsed.data.cssBundle ? inputPath(parsed.data.cssBundle) : undefined;
      if (entry_point && !byPath.has(entry_point)) issue('Output entry point is not a collected input');
      const row = { path: alias, bytes: parsed.data.bytes, ...entry_point ? { entry_point } : {}, ...css_bundle ? { css_bundle } : {},
        inputs: contributions, imports: imports(parsed.data.imports), exports: parsed.data.exports };
      result.outputs.push(row);
      try {
        const target = path.join(roots.workspace, alias.slice('@workspace/'.length)); await noSymlinks(roots.workspace, target); const output = await fs.lstat(target);
        if (!output.isFile() || output.size !== row.bytes) issue('Reported output is missing, unsupported or differs from the reported byte size');
      } catch { issue('Reported output file could not be verified in the fresh output directory'); }
    }
    const outputPaths = new Set(result.outputs.map(o => o.path));
    for (const input of result.inputs) for (const e of input.imports) if (!e.external && !byPath.has(e.path)) issue('Input import references an uncollected input');
    for (const output of result.outputs) {
      for (const e of output.imports) if (!e.external && !outputPaths.has(e.path)) issue('Output import references an uncollected output');
      if (output.css_bundle && !outputPaths.has(output.css_bundle)) issue('CSS bundle references an uncollected output');
    }
    const entries = [...new Set(result.outputs.flatMap(o => o.entry_point ? [o.entry_point] : []))].sort();
    const referenced = new Set(result.inputs.flatMap(i => i.imports.filter(e => !e.external).map(e => e.path)));
    const rootsOfGraph = entries.filter(e => !referenced.has(e));
    const queue = (rootsOfGraph.length ? rootsOfGraph : entries).filter(e => byPath.has(e));
    for (const entry of queue) byPath.get(entry)!.entry_chain = [entry];
    for (let i = 0; i < queue.length; i++) {
      const input = byPath.get(queue[i])!;
      for (const e of input.imports) if (!e.external && byPath.has(e.path)) {
        const target = byPath.get(e.path)!;
        if (target.entry_chain.length) continue;
        if (input.entry_chain.length >= ESBUILD_LIMITS.max_chain) { issue('Entry-chain depth limit reached'); continue; }
        target.entry_chain = [...input.entry_chain, e.path]; queue.push(e.path);
      }
    }
    for (const p of inventory.packages) {
      const files = result.inputs.filter(i => i.package === p.path).map(i => i.path);
      if (!files.length) continue;
      const fileSet = new Set(files);
      const contributions = result.outputs.flatMap(o => {
        const matches = o.inputs.filter(i => fileSet.has(i.path));
        return matches.length ? [{ output: o.path, bytes_in_output: matches.reduce((n, i) => n + i.bytes_in_output, 0) }] : [];
      });
      result.packages.push({ path: p.path, name: p.name, version: p.version, files, contributions });
    }
    if (!result.inputs.length || !result.outputs.length) issue('No usable input/output set received; this is not an empty-build conclusion');
    result.capture_status = result.inputs.length && result.outputs.length ? issues.length ? 'incomplete' : 'captured' : 'unavailable';
  } catch { issue('Metafile is missing, unreadable, malformed or beyond supported bounds; no empty-build conclusion is available'); }
  return result;
}

/** Enforce referential integrity when importing saved usage reports. */
export function validateBundling(b: BundlingObservation) {
  const inputs = new Map(b.inputs.map(i => [i.path, i])), outputs = new Map(b.outputs.map(o => [o.path, o])), packages = new Map(b.packages.map(p => [p.path, p]));
  const projectPath = (p: string) => p.startsWith('@workspace/') && path.posix.normalize(p) === p && !/[\u0000-\u001f\u007f]/.test(p);
  if (![b.output_root, b.metafile, ...inputs.keys(), ...outputs.keys(), ...packages.keys()].every(projectPath) || !contains(b.output_root, b.metafile) || b.metafile === b.output_root) throw new Error('Invalid normalized bundling paths');
  if (inputs.size !== b.inputs.length || outputs.size !== b.outputs.length || packages.size !== b.packages.length) throw new Error('Duplicate bundling records');
  const edgeCount = b.inputs.reduce((n, i) => n + i.imports.length, 0) + b.outputs.reduce((n, o) => n + o.inputs.length + o.imports.length, 0);
  if (edgeCount > ESBUILD_LIMITS.max_edges) throw new Error('Bundling graph exceeds aggregate bounds');
  if (b.capture_status === 'captured' && (!b.bundler || !b.raw_metadata_hash || !b.inputs.length || !b.outputs.length || b.issues.length)) throw new Error('Complete bundling capture requires identified tool and input/output records without issues');
  for (const i of b.inputs) {
    if (i.package && (!packages.has(i.package) || !contains(i.package, i.path))) throw new Error('Bundling input references a missing or unrelated package');
    if (i.entry_chain.length && (i.entry_chain.at(-1) !== i.path || !b.outputs.some(o => o.entry_point === i.entry_chain[0]) || i.entry_chain.some(p => !inputs.has(p)) || i.entry_chain.some((p, n) => n && !inputs.get(i.entry_chain[n - 1])!.imports.some(e => !e.external && e.path === p)))) throw new Error('Invalid entry-to-input chain');
  }
  for (const o of b.outputs) {
    if (new Set(o.inputs.map(i => i.path)).size !== o.inputs.length || o.inputs.some(i => !inputs.has(i.path))) throw new Error('Invalid output contribution references');
    if (!contains(b.output_root, o.path) || o.path === b.metafile) throw new Error('Output is outside the declared output set');
    if (b.capture_status === 'captured' && (o.entry_point && !inputs.has(o.entry_point) || o.css_bundle && !outputs.has(o.css_bundle) || o.imports.some(e => !e.external && !outputs.has(e.path)))) throw new Error('Complete build metadata has unresolved output references');
  }
  if (b.capture_status === 'captured' && b.inputs.some(i => i.imports.some(e => !e.external && !inputs.has(e.path)))) throw new Error('Complete build metadata has unresolved input references');
  for (const p of b.packages) {
    const expected = b.inputs.filter(i => i.package === p.path).map(i => i.path).sort();
    const contributions = b.outputs.flatMap(o => {
      const matches = o.inputs.filter(i => expected.includes(i.path));
      return matches.length ? [{ output: o.path, bytes_in_output: matches.reduce((n, i) => n + i.bytes_in_output, 0) }] : [];
    }).sort((a, b) => a.output.localeCompare(b.output));
    if (!p.path.startsWith('@workspace/') || !expected.length || JSON.stringify([...p.files].sort()) !== JSON.stringify(expected) || JSON.stringify([...p.contributions].sort((a, b) => a.output.localeCompare(b.output))) !== JSON.stringify(contributions)) throw new Error('Bundling package records do not match attributed inputs/contributions');
  }
}
