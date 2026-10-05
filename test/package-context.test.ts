import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { dependencyInventory } from '../src/dependency-inventory.js';
import { manifest, hash } from '../src/filesystem.js';
import { contextSchema, validateContext, packagePaths } from '../src/package-context.js';
import { parseUsage } from '../src/usage-report.js';
import { inspectPackage, packageContextLines } from '../src/usage-inspection.js';
import { observationFixture } from './support/observation-fixture.js';

test('installed declarations target nested instances and keep optional/peer absence distinct from loaded relationships', async t => {
  const f = await observationFixture(t);
  await fs.writeFile(path.join(f.roots.workspace, 'node_modules/alpha/package.json'), JSON.stringify({ name: 'alpha', version: '1.0.0', dependencies: { shared: '^2' }, optionalDependencies: { absent: '*' }, peerDependencies: { missingPeer: '*' }, devDependencies: { notInstalledDev: '*' } }));
  await fs.writeFile(path.join(f.roots.workspace, 'node_modules/alpha/node_modules/shared/package.json'), JSON.stringify({ name: 'shared', version: '2.0.0', dependencies: { alpha: '^1' } }));
  const inventory = await dependencyInventory(f.roots.workspace, 2048, undefined, await manifest(f.roots.workspace));
  const c = inventory.context!; validateContext(c, inventory.packages);
  assert.equal(c.edges.find(e => e.from.endsWith('/alpha') && e.name === 'shared')?.target, '@workspace/node_modules/alpha/node_modules/shared');
  assert.equal(c.edges.find(e => e.name === 'absent')?.resolution, 'unresolved');
  assert.equal(c.edges.find(e => e.name === 'missingPeer')?.kind, 'peerDependencies');
  assert.ok(!c.edges.some(e => e.name === 'notInstalledDev'));
  const trails = packagePaths(c, '@workspace/node_modules/alpha/node_modules/shared');
  assert.deepEqual(trails.paths[0], ['@workspace', '@workspace/node_modules/alpha', '@workspace/node_modules/alpha/node_modules/shared']);
  assert.ok(trails.paths.every(a => new Set(a).size === a.length));
});

test('structure distinguishes declarations, mjs/cjs, TypeScript code, native, Wasm and extensionless contents', async t => {
  const f = await observationFixture(t), base = path.join(f.roots.workspace, 'node_modules/unused');
  await fs.rm(path.join(base, 'index.js'));
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'unused', version: '1.0.0', types: 'index.d.ts', bin: 'tool', exports: { '.': { types: './index.d.ts', import: './entry.mjs' }, './outside': '../other' } }));
  for (const file of ['index.d.ts', 'entry.mjs', 'other.cjs', 'code.ts', 'addon.node', 'module.wasm', 'tool']) await fs.writeFile(path.join(base, file), 'fixture');
  const inventory = await dependencyInventory(f.roots.workspace, 2048, undefined, await manifest(f.roots.workspace));
  const s = inventory.context!.structures.find(s => s.path.endsWith('/unused'))!;
  assert.deepEqual(s.files, { total: 8, declarations: 1, javascript: 2, typescript: 1, native: 1, wasm: 1, other: 2, symlinks: 0 });
  assert.ok(s.entries.some(e => e.field === 'exports/./import' && e.evidence === 'file_present'));
  assert.ok(s.entries.some(e => e.target === '../other' && e.evidence === 'outside_package'));
  const report = parseUsage({ schema_version: 1, kind: 'dependency_usage', observer_version: 'fixture', status: 'observed', environment: {},
    inputs: { config_hash: hash('config'), limits_hash: hash('limits') }, tasks: [{ task: 'type', task_definition_hash: hash('type'), verdict: 'pass', capture_status: 'captured', loaded_packages: [], inventory }] });
  const inspected = inspectPackage(report, 'unused', 'saved.json');
  assert.ok(!packageContextLines(inspected.tasks[0].instances[0]).join(' ').includes('未发现已识别'));
  const changed = structuredClone(report); if (changed.tasks[0].capture_status === 'not_run') throw Error();
  changed.tasks[0].inventory!.context!.structures[0].files!.total++;
  assert.throws(() => parseUsage(changed), /count mismatch/);
  changed.tasks[0].inventory!.context!.structures[0].files!.total--;
  changed.tasks[0].inventory!.context!.edges[0].target = '@workspace/node_modules/absent';
  assert.throws(() => parseUsage(changed), /missing or inconsistent/);
});

test('normal cache directories are ignored, but symlinks and unidentified packages remain genuine gaps', async t => {
  const f = await observationFixture(t);
  await fs.mkdir(path.join(f.roots.workspace, 'node_modules/.cache/xo'), { recursive: true });
  await fs.writeFile(path.join(f.roots.workspace, 'node_modules/.cache/xo/state'), 'cache');
  const nested = path.join(f.roots.workspace, 'node_modules/alpha/node_modules');
  await fs.mkdir(path.join(nested, '.bin'), { recursive: true });
  await fs.symlink('../shared/index.js', path.join(nested, '.bin/tool'));
  await fs.mkdir(path.join(nested, '.cache'), { recursive: true });
  await fs.writeFile(path.join(nested, '.cache/state'), 'cache');
  await fs.writeFile(path.join(nested, '.package-lock.json'), '{}');
  await fs.writeFile(path.join(f.roots.workspace, 'node_modules/alpha/.permsift-read-fixture'), 'probe');
  let inventory = await dependencyInventory(f.roots.workspace, 2048, undefined, await manifest(f.roots.workspace));
  assert.equal(inventory.complete, true); assert.deepEqual(inventory.ignored_entries, ['@workspace/node_modules/.cache', '@workspace/node_modules/alpha/node_modules/.cache']);
  assert.ok(inventory.context!.complete); assert.ok(inventory.context!.structures.every(s => s.complete));
  assert.ok(inventory.context!.structures.every(s => s.files!.total < 5));
  await fs.rm(path.join(f.roots.workspace, 'node_modules/.cache'), { recursive: true });
  await fs.symlink('alpha', path.join(f.roots.workspace, 'node_modules/.cache'));
  inventory = await dependencyInventory(f.roots.workspace);
  assert.equal(inventory.complete, false); assert.match(inventory.issues.join(' '), /\.cache/);
  assert.ok(!inventory.context!.complete);
});

test('declaration-only structure provides facts, while missing manifests and old reports retain unknowns', async t => {
  const f = await observationFixture(t), base = path.join(f.roots.workspace, 'node_modules/unused');
  await fs.rm(path.join(base, 'index.js')); await fs.writeFile(path.join(base, 'index.d.ts'), 'export type Value = string;');
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'unused', version: '1.0.0', types: 'index.d.ts' }));
  const inventory = await dependencyInventory(f.roots.workspace, 2048, undefined, await manifest(f.roots.workspace));
  const raw = { schema_version: 1, kind: 'dependency_usage', observer_version: 'fixture', status: 'observed', environment: {},
    inputs: { config_hash: hash('config'), limits_hash: hash('limits') }, tasks: [{ task: 'type', task_definition_hash: hash('type'), verdict: 'pass', capture_status: 'captured', loaded_packages: [], inventory }] };
  let parsed = parseUsage(raw), row = inspectPackage(parsed, 'unused', 'saved.json').tasks[0].instances[0];
  assert.match(packageContextLines(row).join(' '), /有类型声明/);
  assert.equal(row.node.record, 'absent'); assert.equal(row.context?.observed_parents.length, 0);
  // A different package's entry bound must not claim this instance's structure is missing.
  const other = inventory.context!.structures.find(s => !s.path.endsWith('/unused'))!;
  other.complete = false; other.issues.push('Entry declaration bounds reached'); inventory.context!.complete = false;
  parsed = parseUsage(raw); row = inspectPackage(parsed, 'unused', 'saved.json').tasks[0].instances[0];
  assert.equal(row.context?.state, 'saved');
  const missing = await dependencyInventory(f.roots.workspace); assert.equal(missing.context!.structures[0].files, undefined);
  assert.equal(missing.context!.structures[0].complete, false);
  delete raw.tasks[0].inventory.context; parsed = parseUsage(raw); row = inspectPackage(parsed, 'unused', 'old.json').tasks[0].instances[0];
  assert.equal(row.context?.state, 'not_saved'); assert.match(packageContextLines(row).join(' '), /不读取当前项目/);
  assert.throws(() => contextSchema.parse({ ...inventory.context, edges: [] , version: 99 }));
});
