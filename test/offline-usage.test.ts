import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadUsage, MAX_USAGE_BYTES, type Comparable } from '../src/usage-report.js';
import { compareUsage, comparisonMarkdown } from '../src/usage-comparison.js';
import { compareSavedUsage, offlineComparisonMarkdown, saveComparison } from '../src/offline-usage.js';
import { inspectPackage, inspectionMarkdown } from '../src/usage-inspection.js';
import { hash } from '../src/filesystem.js';
import { ESBUILD_LIMITS, type BundlingObservation } from '../src/esbuild-observation.js';
import { TYPESCRIPT_LIMITS, type CompilationObservation } from '../src/typescript-observation.js';

const pkg = { path: '@workspace/node_modules/@scope/pkg', name: '@scope/pkg', version: '1.0.0' };
const input = '@workspace/src/index.ts', output = '@workspace/dist/index.js', file = pkg.path + '/index.js';
function usage(): Comparable {
  return { schema_version: 1, kind: 'dependency_usage', version: '0.9.0', observer_version: 'node-module-load-v2', status: 'observed', environment: { node: 'v24', permsift: '0.9.0' },
    inputs: { snapshot_hash: hash('input'), config_hash: hash('config'), limits_hash: hash('limits') },
    tasks: [{ task: 'compile', capture_status: 'captured', verdict: 'pass', task_definition_hash: hash('task'),
      inventory: { complete: true, issues: [], packages: [pkg] }, loaded_packages: [{ ...pkg, modules: [file] }], issues: [], coverage_gaps: [] }] };
}
function compilation(): CompilationObservation {
  const file = pkg.path + '/index.d.ts';
  return { source: 'typescript_explain_files', collector_version: 'typescript-explain-files-v1', capture_status: 'captured',
    compiler: { path: '@workspace/node_modules/typescript', name: 'typescript', version: '4.9.5' }, executed_command: ['node', 'tsc'],
    raw_output_hash: hash('compiler'), raw_output_bytes: 10, limits: TYPESCRIPT_LIMITS,
    files: [{ path: file, kind: 'declaration', package: pkg.path, reasons: ['Imported via pkg from source'] }], packages: [{ ...pkg, files: [file] }], issues: [], limitations: [] };
}
function bundling(bytes = 0): BundlingObservation {
  return { source: 'esbuild_metafile', collector_version: 'esbuild-metafile-v1', capture_status: 'captured', bundler: { path: '@workspace/node_modules/esbuild', name: 'esbuild', version: '0.28.2' },
    metafile: '@workspace/dist/meta.json', output_root: '@workspace/dist', raw_metadata_hash: hash('meta'), raw_metadata_bytes: 10, executed_command: ['node', 'build'], limits: ESBUILD_LIMITS,
    inputs: [{ path: input, bytes: 10, imports: [{ path: file, kind: 'import-statement', external: false }], entry_chain: [input] },
      { path: file, bytes: 10, package: pkg.path, imports: [], entry_chain: [input, file] }],
    outputs: [{ path: output, bytes: 100, entry_point: input, inputs: [{ path: input, bytes_in_output: 10 }, { path: file, bytes_in_output: bytes }], imports: [], exports: [] }],
    packages: [{ ...pkg, files: [file], contributions: [{ output, bytes_in_output: bytes }] }], issues: [], limitations: [] };
}
function task(r: Comparable) { const t = r.tasks[0]; if (t.capture_status === 'not_run') throw new Error(); return t; }
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-offline-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name: string, r: unknown) => { const file = path.join(root, name); await fs.writeFile(file, JSON.stringify(r)); return file; };
  return { root, write };
}
const cli = (...args: string[]) => spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });

test('offline comparisons share source comparisons and formatting with observe, without changing inputs', async t => {
  const f = await fixture(t), before = usage(), after = usage();
  task(before).compilation = compilation(); task(after).compilation = compilation();
  task(before).bundling = bundling(0); task(after).bundling = bundling(17);
  task(after).compilation!.files[0].reasons = ['Referenced via changed source'];
  after.inputs.snapshot_hash = hash('changed'); after.environment.node = 'v25';
  const a = await f.write('before.json', before), b = await f.write('after.json', after), original = await fs.readFile(a);
  const report = await compareSavedUsage(a, b), expected = compareUsage(await loadUsage(a), await loadUsage(b), a);
  assert.equal(report.status, 'compared'); assert.deepEqual(report.comparison, expected);
  assert.equal(report.comparison.tasks[0].bundling!.contribution_changes[0].before_bytes, 0);
  assert.equal(report.comparison.tasks[0].compilation!.explanation_changes.length, 1);
  assert.ok(offlineComparisonMarkdown(report).includes(comparisonMarkdown(expected).join('\n')));
  const directory = path.join(f.root, 'comparison'); await saveComparison(directory, report);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'comparison.json'), 'utf8')), report);
  await assert.rejects(saveComparison(directory, report), /EEXIST/);
  await assert.rejects(saveComparison(f.root, report), /EEXIST/);
  assert.deepEqual(await fs.readFile(a), original); assert.deepEqual((await fs.readdir(f.root)).sort(), ['after.json', 'before.json', 'comparison']);
});

test('offline old sources, failed tasks and not-run tasks remain partial rather than fabricated removals', async t => {
  const f = await fixture(t), before = usage(), after = usage(); task(after).bundling = bundling();
  const a = await f.write('before.json', before), b = await f.write('after.json', after);
  let report = await compareSavedUsage(a, b); assert.equal(report.status, 'partial');
  assert.equal(report.comparison.tasks[0].bundling!.state, 'unavailable'); assert.equal(report.comparison.tasks[0].bundling!.added.length, 0);
  after.status = 'failed'; task(after).verdict = 'fail'; task(after).capture_status = 'incomplete'; await f.write('after.json', after);
  report = await compareSavedUsage(a, b); assert.equal(report.status, 'partial'); assert.match(report.comparison.tasks[0].warnings.join(' '), /partial/);
  after.tasks = [{ task: 'compile', capture_status: 'not_run', reason: 'budget exhausted' }]; await f.write('after.json', after);
  report = await compareSavedUsage(a, b); assert.equal(report.comparison.tasks[0].state, 'unavailable'); assert.equal(report.after.tasks[0].module_capture, 'not_run');
});

test('cross-task inspection retains scoped and nested instances, equal versions and installed-only packages', () => {
  const r = usage(), nested = { ...pkg, path: '@workspace/node_modules/other/node_modules/@scope/pkg' };
  task(r).inventory!.packages.push(nested); task(r).loaded_packages = [];
  r.tasks.push({ ...structuredClone(task(r)), task: 'test', loaded_packages: [{ ...nested, modules: [nested.path + '/index.js'] }] });
  const result = inspectPackage(r, pkg.name, 'saved.json'); assert.equal(result.status, 'complete'); assert.equal(result.found, true);
  assert.equal(result.tasks.length, 2); assert.ok(result.tasks.every(t => t.instances.length === 2));
  assert.equal(result.tasks[0].instances[0].node.record, 'absent');
  assert.equal(result.tasks[1].instances.find(p => p.path === nested.path)!.node.files, 1);
  const md = inspectionMarkdown(result); assert.match(md, /no record \[captured\]/); assert.match(md, /not collected/); assert.ok(md.includes(nested.path));
});

test('inspection preserves positive records in incomplete captures and zero bytes independently from missing sources', () => {
  const r = usage(); task(r).bundling = bundling(0); task(r).compilation = compilation();
  task(r).capture_status = 'incomplete'; task(r).issues = ['missing footer']; task(r).loaded_packages = [];
  const result = inspectPackage(r, pkg.name, 'saved.json'), instance = result.tasks[0].instances[0];
  assert.equal(result.status, 'partial'); assert.equal(instance.node.record, 'absent'); assert.equal(instance.node.capture_status, 'incomplete');
  assert.equal(instance.typescript.files, 1); assert.equal(instance.esbuild.contributions[0].bytes_in_output, 0);
  assert.match(inspectionMarkdown(result), /no record \[incomplete\]/); assert.match(inspectionMarkdown(result), /index.js: 0 \[captured\]/);
  task(r).bundling!.capture_status = 'unavailable'; task(r).bundling!.issues = ['no metadata']; task(r).bundling!.packages = [];
  const missing = inspectionMarkdown(inspectPackage(r, pkg.name, 'saved.json'));
  assert.match(missing, /no reported contribution \[unavailable\]/); assert.match(missing, /no metadata/);
});

test('inspection distinguishes unknown inventory, absent instances and tasks that never ran', () => {
  const r = usage(); let result = inspectPackage(r, 'absent', 'saved.json'); assert.equal(result.found, false); assert.equal(result.status, 'complete');
  assert.match(inspectionMarkdown(result), /No matching installed instance/);
  delete task(r).inventory; delete task(r).loaded_packages[0].modules;
  result = inspectPackage(r, pkg.name, 'saved.json'); assert.equal(result.status, 'partial'); assert.equal(result.tasks[0].instances[0].node.record, 'present');
  assert.match(inspectionMarkdown(result), /file list not saved/);
  r.tasks.push({ task: 'skipped', capture_status: 'not_run', reason: 'not started' });
  assert.match(inspectionMarkdown(inspectPackage(r, 'absent', 'saved.json')), /not started/);
  assert.throws(() => inspectPackage(r, '', 'saved.json'), /exact package name/);
});

test('saved report reader rejects malformed structure, duplicate instances, conflicting identities and foreign module paths', async t => {
  const f = await fixture(t);
  for (const change of [
    (r: any) => { r.kind = 'experiment'; }, (r: any) => { r.schema_version = 2; },
    (r: any) => { r.tasks.push(r.tasks[0]); }, (r: any) => { r.tasks[0].inventory.packages.push(pkg); },
    (r: any) => { r.tasks[0].inventory.packages[0] = { ...pkg, version: '2' }; },
    (r: any) => { r.tasks[0].loaded_packages[0].path = '@workspace/../host'; },
    (r: any) => { r.tasks[0].loaded_packages[0].modules = ['@workspace/node_modules/other/index.js']; },
    (r: any) => { r.tasks[0].loaded_packages[0].modules = [pkg.path + '/../other/index.js']; },
    (r: any) => { r.tasks[0].loaded_packages[0].modules = [file, file]; },
  ]) { const r = usage(); change(r); await assert.rejects(loadUsage(await f.write('bad.json', r))); }
  await fs.writeFile(path.join(f.root, 'bad.json'), '{'); await assert.rejects(loadUsage(path.join(f.root, 'bad.json')));
  const minimal = usage(); delete task(minimal).inventory; delete task(minimal).loaded_packages[0].modules;
  assert.equal((await loadUsage(await f.write('old.json', minimal))).version, '0.9.0');
  const manyLaunches = usage(); task(manyLaunches).coverage_gaps = Array.from({ length: 129 }, (_, i) => `Native child ${i} outside module coverage`);
  assert.equal((await loadUsage(await f.write('launches.json', manyLaunches))).tasks.length, 1);
});

test('saved report reads are bounded and refuse links, directories and nonblocking FIFOs', async t => {
  const f = await fixture(t), file = await f.write('source.json', usage());
  const large = path.join(f.root, 'large.json'); const handle = await fs.open(large, 'w'); await handle.truncate(MAX_USAGE_BYTES + 1); await handle.close();
  await assert.rejects(loadUsage(large), /32 MB/); await assert.rejects(loadUsage(f.root), /regular JSON/);
  if (process.platform !== 'win32') {
    const link = path.join(f.root, 'linked.json'); await fs.symlink(file, link); await assert.rejects(loadUsage(link));
    const fifo = path.join(f.root, 'fifo'); assert.equal(spawnSync('mkfifo', [fifo]).status, 0); await assert.rejects(loadUsage(fifo), /regular JSON/);
  }
});

test('offline CLI provides valid JSON, permits differences and rejects execution options without running tasks', async t => {
  const f = await fixture(t), before = usage(), after = usage(); task(after).loaded_packages[0].version = '2.0.0'; task(after).inventory!.packages[0] = { ...pkg, version: '2.0.0' };
  const a = await f.write('a.json', before), b = await f.write('b.json', after), original = await fs.readFile(a);
  let result = cli('compare', a, b, '--json'); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).comparison.tasks[0].version_changes.length, 1);
  result = cli('inspect', a, '--package', pkg.name, '--json'); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).found, true);
  assert.equal(cli('inspect', a, '--package', 'absent').status, 1);
  for (const args of [['compare', a], ['compare', a, b, '--config', 'missing'], ['compare', a, b, '--limits', 'missing'],
    ['compare', a, b, '--baseline', a], ['compare', a, b, '--package', pkg.name], ['inspect', a], ['inspect', a, '--package', pkg.name, '--output', path.join(f.root, 'ignored')]]) assert.equal(cli(...args).status, 2);
  assert.deepEqual(await fs.readFile(a), original); assert.deepEqual((await fs.readdir(f.root)).sort(), ['a.json', 'b.json']);
});

test('offline CLI emits partial evidence with exit 2 and never presents unavailable sources as a clean comparison', async t => {
  const f = await fixture(t), r = usage(); r.status = 'incomplete'; task(r).capture_status = 'unavailable'; task(r).loaded_packages = [];
  const file = await f.write('partial.json', r);
  for (const args of [['compare', file, file, '--json'], ['inspect', file, '--package', pkg.name, '--json']]) {
    const result = cli(...args); assert.equal(result.status, 2, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'partial');
  }
  const failed = cli('compare', file, path.join(f.root, 'missing'), '--json'); assert.equal(failed.status, 2); assert.equal(failed.stdout, '');
});

test('focused Markdown escapes source text and preserves no-record semantics without package role guesses', () => {
  const r = usage(); task(r).task = 'test|[link]'; task(r).issues = ['<script>fake</script>'];
  const result = inspectionMarkdown(inspectPackage(r, pkg.name, 'report|[link].json'));
  assert.match(result, /test\\\|\\\[link\\\]/); assert.ok(!result.includes('<script>')); assert.match(result, /&lt;script&gt;/);
  assert.match(result, /Missing records do not justify deletion/);
});
