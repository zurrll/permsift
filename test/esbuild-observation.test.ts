import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundlingFixture } from './support/bundling-fixture.js';
import { collectBundling, prepareBundling, bundlingSchema, validateBundling, ESBUILD_LIMITS } from '../src/esbuild-observation.js';
import { compareBundling, bundlingComparisonMarkdown } from '../src/esbuild-comparison.js';
import { configSchema, loadConfiguration, limitsSchema, validatePolicy } from '../src/config.js';
import { dependencyInventory } from '../src/dependency-inventory.js';
import { collectObservation, prepareObservation } from '../src/observation.js';
import { compilationCommand } from '../src/typescript-observation.js';
import { loadUsage, compareUsage, usageMarkdown, type UsageReport } from '../src/observe-command.js';
import { hash } from '../src/filesystem.js';
import type { ProcessResult } from '../src/process.js';

const processResult = (status: ProcessResult['status'] = 'completed', exit_code = 0): ProcessResult => ({ status, exit_code, stdout: '', stderr: '', signal: null, duration_ms: 1 });
async function capture(t: Parameters<typeof bundlingFixture>[0]) {
  const f = await bundlingFixture(t), { config } = await loadConfiguration(f.configPath, f.limitsPath), scenario = config.scenarios[0];
  await prepareBundling(scenario, f.roots); const setup = await prepareObservation(f.roots);
  const task = spawnSync(process.execPath, ['build.mjs'], { cwd: f.roots.workspace, env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(setup.bootstrap)}` }, encoding: 'utf8' });
  assert.equal(task.status, 0, task.stderr); const b = (await collectBundling(scenario, setup.inventory, f.roots, processResult()))!;
  assert.equal(b.capture_status, 'captured', b.issues.join('\n')); bundlingSchema.parse(b); validateBundling(b);
  assert.equal(b.raw_metadata_hash, hash(await fs.readFile(path.join(f.roots.workspace, 'dist/meta.json'), 'utf8')));
  return { ...f, scenario, setup, b, modules: await collectObservation(setup, f.roots) };
}

test('esbuild config declares a writable isolated output directory without changing the command', () => {
  const s = { id: 'bundle', command: ['node', 'build.mjs'], initial_write_grants: ['@workspace/dist'], assertions: [{ type: 'file_exists', path: '@workspace/dist/index.js' }],
    observation: { esbuild: { bundler: '@workspace/node_modules/esbuild', metafile: '@workspace/dist/meta.json', output_root: '@workspace/dist' } } };
  const config = (scenario = s) => configSchema.parse({ schema_version: 1, scenarios: [scenario] }), limits = limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace/dist'] });
  validatePolicy(config(), limits); assert.deepEqual(compilationCommand(config().scenarios[0]), s.command);
  for (const observation of [{}, { esbuild: { ...s.observation.esbuild, metafile: '@tmp/meta.json' } }]) assert.throws(() => configSchema.parse({ schema_version: 1, scenarios: [{ ...s, observation }] }));
  for (const esbuild of [{ ...s.observation.esbuild, metafile: '@workspace/meta.json' }, { ...s.observation.esbuild, output_root: '@workspace/node_modules', metafile: '@workspace/node_modules/meta.json' }, { ...s.observation.esbuild, output_root: '@workspace/other', metafile: '@workspace/other/meta.json' }]) assert.throws(() => validatePolicy(config({ ...s, observation: { esbuild } }), limits, true), /esbuild/);
  const narrow = config({ ...s, observation: { esbuild: { ...s.observation.esbuild, output_root: '@workspace/artifacts', metafile: '@workspace/artifacts/dist/meta.json' } }, initial_write_grants: ['@workspace/artifacts/dist'] });
  validatePolicy(narrow, limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace/artifacts'] }));
  assert.throws(() => validatePolicy(narrow, limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace/artifacts'] }), true), /existing task write grant/);
});

test('same real build explains packaged, indirect, external, type-only and lazy inputs separately from Node loads', async t => {
  const f = await capture(t);
  assert.equal(f.modules.capture_status, 'captured'); assert.ok(f.modules.loaded_packages.some(p => p.name === 'esbuild'));
  assert.ok(!f.modules.loaded_packages.some(p => p.name === 'app-a'));
  assert.ok(f.modules.loaded_packages.some(p => p.name === 'external-pkg'));
  assert.ok(!f.b.packages.some(p => ['type-only', 'external-pkg', 'esbuild'].includes(p.name)));
  assert.ok(f.b.packages.some(p => p.name === 'app-a')); assert.ok(f.b.packages.some(p => p.name === 'shared'));
  assert.ok(f.b.outputs.some(o => o.entry_point?.includes('lazy-pkg')));
  assert.ok(f.b.outputs.some(o => o.path.endsWith('.map')));
  const shared = f.b.inputs.find(i => i.package?.endsWith('/shared'))!;
  assert.deepEqual(shared.entry_chain, ['@workspace/src/index.ts', '@workspace/node_modules/app-a/index.js', '@workspace/node_modules/shared/index.js']);
  assert.ok(f.b.packages.find(p => p.name === 'lazy-pkg')!.contributions.some(c => c.bytes_in_output > 0));
  assert.ok(f.b.outputs.some(o => o.imports.some(i => i.external && i.path === 'external-pkg')));
  assert.ok(!f.b.packages.find(p => p.name === 'dropped')?.contributions.some(c => c.bytes_in_output > 0));
  // Reported artifact filenames need not fit the more restrictive config aliases.
  const file = path.join(f.roots.workspace, 'dist/meta.json'), metadata = JSON.parse(await fs.readFile(file, 'utf8'));
  const old = 'dist/index.mjs.map', renamed = 'dist/source map-中文.map';
  await fs.rename(path.join(f.roots.workspace, old), path.join(f.roots.workspace, renamed));
  metadata.outputs[renamed] = metadata.outputs[old]; delete metadata.outputs[old]; await fs.writeFile(file, JSON.stringify(metadata));
  const updated = (await collectBundling(f.scenario, f.setup.inventory, f.roots, processResult()))!;
  assert.equal(updated.capture_status, 'captured'); validateBundling(updated); assert.ok(updated.outputs.some(o => o.path.endsWith('source map-中文.map')));
});

test('metadata freshness clears the entire declared output copy and rejects stale, malformed and oversized records', async t => {
  const f = await capture(t);
  const file = path.join(f.roots.workspace, 'dist/meta.json');
  await prepareBundling(f.scenario, f.roots);
  assert.deepEqual(await fs.readdir(path.dirname(file)), []);
  assert.equal((await collectBundling(f.scenario, f.setup.inventory, f.roots, processResult()))!.capture_status, 'unavailable');
  for (const value of ['{', '{}', JSON.stringify({ inputs: {}, outputs: {} }), 'x'.repeat(ESBUILD_LIMITS.max_bytes + 1)]) {
    await fs.writeFile(file, value); const b = (await collectBundling(f.scenario, f.setup.inventory, f.roots, processResult()))!;
    assert.notEqual(b.capture_status, 'captured'); assert.ok(b.issues.length); bundlingSchema.parse(b);
  }
});

test('unsupported metadata paths, dangling references, missing outputs and failed execution retain honest partial observations', async t => {
  const f = await capture(t), file = path.join(f.roots.workspace, 'dist/meta.json'), original = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const transform of [
    (m: any) => { m.inputs['/host/private/hidden.ts'] = { bytes: 1, imports: [] }; },
    (m: any) => { m.inputs['plugin:virtual'] = { bytes: 1, imports: [] }; },
    (m: any) => { m.inputs['<stdin>'] = { bytes: 1, imports: [] }; },
    (m: any) => { m.inputs['src/index.ts'].imports.push({ path: 'missing.js', kind: 'import-statement' }); },
    (m: any) => { m.outputs['dist/index.mjs'].inputs['missing.js'] = { bytesInOutput: 3 }; },
    (m: any) => { m.outputs['dist/index.mjs'].bytes++; },
    (m: any) => { m.outputs['elsewhere.js'] = m.outputs['dist/index.mjs']; },
    (m: any) => { m.inputs['src/index.ts'].bytes = -1; },
  ]) {
    const metadata = structuredClone(original); transform(metadata); await fs.writeFile(file, JSON.stringify(metadata));
    const b = (await collectBundling(f.scenario, f.setup.inventory, f.roots, processResult()))!;
    assert.notEqual(b.capture_status, 'captured'); assert.ok(b.issues.length); assert.ok(!JSON.stringify(b.inputs).includes('/host/private')); bundlingSchema.parse(b); validateBundling(b);
  }
  await fs.writeFile(file, JSON.stringify(original));
  for (const execution of [processResult('timed_out'), processResult('completed', 1), undefined]) assert.equal((await collectBundling(f.scenario, f.setup.inventory, f.roots, execution))!.capture_status, 'incomplete');
  const unknown = (await collectBundling(f.scenario, { ...f.setup.inventory, packages: [] }, f.roots, processResult()))!;
  assert.equal(unknown.capture_status, 'incomplete'); assert.equal(unknown.bundler, undefined);
  assert.equal(await collectBundling({ ...f.scenario, observation: undefined }, f.setup.inventory, f.roots), undefined);
});

test('collector refuses linked metadata, linked output parents and FIFOs without following or blocking', async t => {
  const f = await capture(t), file = path.join(f.roots.workspace, 'dist/meta.json'), saved = path.join(f.root, 'saved.json');
  await fs.copyFile(file, saved); await fs.unlink(file); await fs.symlink(saved, file);
  assert.equal((await collectBundling(f.scenario, f.setup.inventory, f.roots, processResult()))!.capture_status, 'unavailable');
  await fs.unlink(file); const created = spawnSync('mkfifo', [file]); assert.equal(created.status, 0);
  assert.equal((await collectBundling(f.scenario, f.setup.inventory, f.roots, processResult()))!.capture_status, 'unavailable');
  await fs.rename(path.dirname(file), path.join(f.root, 'moved-dist')); await fs.symlink(path.join(f.root, 'moved-dist'), path.dirname(file));
  await assert.rejects(prepareBundling(f.scenario, f.roots), /Symlink/);
});

test('input, output and graph limits bound stored records and mark truncated captures', async t => {
  const f = await capture(t), file = path.join(f.roots.workspace, 'dist/meta.json'), original = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const which of ['inputs', 'outputs', 'edges', 'chain']) {
    const m = structuredClone(original);
    if (which === 'inputs') for (let i = 0; i < ESBUILD_LIMITS.max_inputs + 1; i++) m.inputs[`src/file${i}.ts`] = { bytes: 1, imports: [] };
    if (which === 'outputs') for (let i = 0; i < ESBUILD_LIMITS.max_outputs + 1; i++) m.outputs[`dist/file${i}.js`] = { bytes: 0, inputs: {}, imports: [], exports: [] };
    if (which === 'edges') for (let i = 0; i < 3; i++) m.inputs[`src/file${i}.ts`] = { bytes: 1, imports: Array.from({ length: 6000 }, () => ({ path: 'node:fs', kind: 'import-statement', external: true })) };
    if (which === 'chain') {
      m.inputs['src/index.ts'].imports.push({ path: 'src/deep0.ts', kind: 'import-statement' });
      for (let i = 0; i < ESBUILD_LIMITS.max_chain + 2; i++) m.inputs[`src/deep${i}.ts`] = { bytes: 1, imports: [{ path: `src/deep${i + 1}.ts`, kind: 'import-statement' }] };
    }
    await fs.writeFile(file, JSON.stringify(m)); const b = (await collectBundling(f.scenario, f.setup.inventory, f.roots, processResult()))!;
    assert.equal(b.capture_status, 'incomplete'); assert.ok(b.inputs.length <= ESBUILD_LIMITS.max_inputs); assert.ok(b.outputs.length <= ESBUILD_LIMITS.max_outputs);
    assert.ok(b.inputs.reduce((n, i) => n + i.imports.length, 0) + b.outputs.reduce((n, o) => n + o.imports.length + o.inputs.length, 0) <= ESBUILD_LIMITS.max_edges); bundlingSchema.parse(b);
  }
});

test('bundle comparison explains package versions, output contributions, chunks, import chains and externals without inventing old data', async t => {
  const f = await capture(t), b = structuredClone(f.b), p = b.packages.find(p => p.name === 'shared')!;
  p.version = '2.0.0'; p.contributions[0].bytes_in_output++;
  b.outputs.find(o => o.path === p.contributions[0].output)!.inputs.find(i => i.path.endsWith('/shared/index.js'))!.bytes_in_output++;
  b.outputs[0].bytes++; b.outputs[0].imports.push({ path: 'node:crypto', kind: 'import-statement', external: true });
  b.inputs.find(i => i.package === p.path)!.entry_chain = ['@workspace/src/other.ts'];
  b.outputs.push({ path: '@workspace/dist/new.js', bytes: 0, inputs: [], imports: [], exports: [] });
  const diff = compareBundling(f.b, b); assert.equal(diff.version_changes.length, 1); assert.equal(diff.contribution_changes.length, 1);
  assert.equal(diff.added_outputs.length, 1); assert.equal(diff.external_changes.length, 1); assert.equal(diff.chain_changes.length, 1); assert.equal(diff.changed_outputs.length, 1);
  assert.match(bundlingComparisonMarkdown('bundle', diff).join('\n'), /shared.*1.0.0.*2.0.0/);
  assert.equal(compareBundling(undefined, b).state, 'unavailable'); assert.equal(compareBundling(undefined, b).added.length, 0);
  b.capture_status = 'incomplete'; assert.match(compareBundling(f.b, b).warnings.join(' '), /partial/);
});

test('saved reports validate bundling integrity and preserve v0.9/v0.10 source absence in comparison', async t => {
  const f = await capture(t);
  const report: UsageReport = { schema_version: 1, kind: 'dependency_usage', version: '0.11.0', observer_version: f.modules.observer_version, status: 'observed', output: '', execution_report: 'report.json', started_at: '', environment: {},
    inputs: { snapshot_hash: hash('i'), config_hash: hash('c'), limits_hash: hash('l') }, limits: { max_events_per_process: 10000, max_bytes_per_process: 2000000, max_process_logs: 64, max_total_bytes: 32000000, max_packages: 2048 },
    tasks: [{ ...f.modules, task: 'bundle', command: f.scenario.command, task_definition_hash: hash(f.scenario), trial: 'id', verdict: 'pass', bundling: f.b }], limitations: [] };
  const file = path.join(f.root, 'usage.json'); await fs.writeFile(file, JSON.stringify(report)); const baseline = await loadUsage(file);
  assert.equal(compareUsage(baseline, report, file).tasks[0].bundling!.version_changes.length, 0);
  const markdown = usageMarkdown(report); assert.match(markdown, /esbuild input files/); assert.match(markdown, /external-pkg.*external/); assert.match(markdown, /entry-to-input chain/);
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  delete task.bundling; await fs.writeFile(file, JSON.stringify(report)); const old = await loadUsage(file); task.bundling = f.b;
  assert.equal(compareUsage(old, report, file).tasks[0].bundling!.state, 'unavailable');
  for (const transform of [(b: any) => { b.packages[0].files = []; }, (b: any) => { b.outputs[0].inputs.push({ path: 'absent', bytes_in_output: 3 }); }, (b: any) => { b.packages[0].contributions.push({ output: 'fake', bytes_in_output: 3 }); }, (b: any) => { b.bundler = undefined; }, (b: any) => { b.inputs[0].entry_chain = ['@workspace/not-an-entry.ts']; }, (b: any) => { b.output_root = '@workspace/dist/../'; }]) {
    task.bundling = structuredClone(f.b); transform(task.bundling); await fs.writeFile(file, JSON.stringify(report)); await assert.rejects(loadUsage(file));
  }
});
