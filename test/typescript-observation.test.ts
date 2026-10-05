import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compilationCommand, collectCompilation, compilationSchema, TYPESCRIPT_LIMITS } from '../src/typescript-observation.js';
import { loadConfiguration, configSchema, validatePolicy, limitsSchema } from '../src/config.js';
import { dependencyInventory } from '../src/dependency-inventory.js';
import { compilationFixture } from './support/compilation-fixture.js';
import { collectObservation, prepareObservation } from '../src/observation.js';
import { compareUsage, loadUsage, usageMarkdown, type UsageReport } from '../src/observe-command.js';
import { hash } from '../src/filesystem.js';
import type { ProcessResult } from '../src/process.js';

const processResult = (stdout: string, status: ProcessResult['status'] = 'completed', code = 0): ProcessResult => ({ stdout, stderr: '', status, exit_code: code, signal: null, duration_ms: 1 });
test('collector config is opt-in and rejects shell/npm wrappers, response files and non-compilation modes', () => {
  const scenario = { id: 'compile', command: ['node', 'node_modules/typescript/bin/tsc'], observation: { typescript: { compiler: '@workspace/node_modules/typescript' } }, initial_write_grants: ['@workspace'], assertions: [{ type: 'file_exists', path: '@workspace/dist/index.js' }] };
  const limits = limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace'] });
  const config = (command: string[]) => configSchema.parse({ schema_version: 1, scenarios: [{ ...scenario, command }] });
  validatePolicy(config(scenario.command), limits);
  for (const command of [['npm', 'run', 'build'], ['node', 'task.cjs'], ['node', '/node_modules/typescript/bin/tsc'], ...['--build', '-w', '--listFilesOnly', '--showConfig', '@args.txt'].map(a => [...scenario.command, a])]) assert.throws(() => validatePolicy(config(command), limits), /TypeScript observation/);
  const plain = configSchema.parse({ schema_version: 1, scenarios: [{ ...scenario, observation: undefined }] }).scenarios[0];
  assert.deepEqual(compilationCommand(plain), scenario.command);
  assert.deepEqual(compilationCommand(config(scenario.command).scenarios[0]).slice(-5), ['--explainFiles', '--locale', 'en', '--pretty', 'false']);
});

test('real compiler supplies type-only and ambient inputs with normalized explanations in the same module-observed execution', async t => {
  const f = await compilationFixture(t), { config } = await loadConfiguration(f.configPath, f.limitsPath), scenario = config.scenarios[0];
  const setup = await prepareObservation(f.roots);
  const execution = spawnSync(process.execPath, compilationCommand(scenario).slice(1), { cwd: f.roots.workspace, env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(setup.bootstrap)}` }, encoding: 'utf8', maxBuffer: 2_000_000 });
  assert.equal(execution.status, 0, execution.stderr + execution.stdout);
  const compilation = collectCompilation(scenario, setup.inventory, f.roots, processResult(execution.stdout))!;
  assert.equal(compilation.capture_status, 'captured', compilation.issues.join('\n') + '\n' + execution.stdout.slice(-3000));
  compilationSchema.parse(compilation);
  assert.ok(compilation.packages.some(p => p.name === 'type-a')); assert.ok(compilation.packages.some(p => p.name === '@types/ambient-a'));
  assert.ok(!compilation.packages.some(p => p.name === 'type-b'));
  const input = compilation.files.find(f => f.path.endsWith('/type-a/index.d.ts'))!;
  assert.equal(input.kind, 'declaration'); assert.match(input.reasons.join(' '), /Imported via.*from file '@workspace\/src\/index.ts'/);
  assert.match(compilation.files.find(f => f.path.includes('@types/ambient-a/index.d.ts'))!.reasons.join(' '), /type library/);
  const modules = await collectObservation(setup, f.roots);
  const nativeReplacement = Number(f.version.split('.')[0]) >= 7 && typeof process.execve === 'function';
  assert.equal(modules.capture_status, nativeReplacement ? 'incomplete' : 'captured', modules.issues.join('\n'));
  if (nativeReplacement) { assert.ok(modules.child_launches.some(c => c.method === 'execve')); assert.match(modules.coverage_gaps.join(' '), /native/); }
  assert.ok(!modules.loaded_packages.some(p => ['type-a', '@types/ambient-a'].includes(p.name)));
  const emitted = await fs.readFile(path.join(f.roots.workspace, 'dist/index.js'), 'utf8'); assert.ok(!emitted.includes('type-a'));
  const smoke = spawnSync(process.execPath, ['--input-type=module', '-e', "import {answer} from './dist/index.js';if(answer({value:42})!==42)process.exit(1);"], { cwd: f.roots.workspace, encoding: 'utf8' }); assert.equal(smoke.status, 0, smoke.stderr);
});

test('classic English explanations retain nested package attribution, multiple reasons and CRLF', async t => {
  const f = await compilationFixture(t), { config } = await loadConfiguration(f.configPath, f.limitsPath);
  await f.pkg('type-a/node_modules/type-b', '2.0.0', 'export interface Shape { value: number }');
  const inventory = await dependencyInventory(f.roots.workspace);
  const stdout = "node_modules/type-a/node_modules/type-b/index.d.ts\r\n  Imported via 'type-b' from file 'node_modules/type-a/index.d.ts'\r\n  Type library referenced via 'type-b' from file 'src/index.ts'\r\nsrc/index.ts\r\n  Matched by include pattern 'src/**/*.ts' in 'tsconfig.json'\r\n";
  const result = collectCompilation(config.scenarios[0], inventory, f.roots, processResult(stdout))!;
  assert.equal(result.capture_status, 'captured'); assert.equal(result.files[0].reasons.length, 2);
  assert.equal(result.packages[0].path, '@workspace/node_modules/type-a/node_modules/type-b'); assert.equal(result.packages[0].version, '2.0.0');
});

test('missing, malformed, unsupported, oversized and partial compiler output never implies no inputs', async t => {
  const f = await compilationFixture(t), { config } = await loadConfiguration(f.configPath, f.limitsPath), inventory = await dependencyInventory(f.roots.workspace), scenario = config.scenarios[0];
  assert.equal(collectCompilation(scenario, inventory, f.roots)?.capture_status, 'unavailable');
  assert.equal(collectCompilation(scenario, inventory, f.roots, processResult(''))?.capture_status, 'unavailable');
  const prefix = "node_modules/type-a/index.d.ts\n  Imported via 'type-a' from file 'src/index.ts'\n";
  for (const stdout of [prefix + 'unknown future format\n', prefix + "src/index.ts\n  文件被包括\n", prefix + 'src/index.ts', prefix + 'x'.repeat(TYPESCRIPT_LIMITS.max_bytes), prefix + '\u001b[31mred\n']) {
    const result = collectCompilation(scenario, inventory, f.roots, processResult(stdout))!;
    assert.equal(result.capture_status, 'incomplete'); assert.ok(result.packages.some(p => p.name === 'type-a')); assert.ok(result.issues.length);
  }
  assert.equal(collectCompilation(scenario, inventory, f.roots, processResult(prefix, 'timed_out'))!.capture_status, 'incomplete');
  assert.equal(collectCompilation(scenario, inventory, f.roots, processResult(prefix, 'completed', 1))!.capture_status, 'incomplete');
  const unidentified = collectCompilation(scenario, { ...inventory, packages: [] }, f.roots, processResult(prefix))!;
  assert.equal(unidentified.capture_status, 'incomplete'); assert.equal(unidentified.compiler, undefined);
  assert.equal(collectCompilation({ ...scenario, observation: undefined }, inventory, f.roots), undefined);
});

test('bounds and outside-project inputs remain explicit coverage gaps with bounded records', async t => {
  const f = await compilationFixture(t), { config } = await loadConfiguration(f.configPath, f.limitsPath), inventory = await dependencyInventory(f.roots.workspace);
  const stdout = '/host/private/secret.d.ts\n  Root file specified for compilation\n' + Array.from({ length: TYPESCRIPT_LIMITS.max_files + 1 }, (_, i) => `src/file${i}.ts\n  Root file specified for compilation\n`).join('');
  const result = collectCompilation(config.scenarios[0], inventory, f.roots, processResult(stdout))!;
  assert.equal(result.capture_status, 'incomplete'); assert.equal(result.files.length, TYPESCRIPT_LIMITS.max_files);
  assert.ok(!JSON.stringify(result.files).includes('/host/private')); assert.match(result.issues.join(' '), /outside the project/);
  compilationSchema.parse(result);
});

test('compiler comparison keeps source-specific package/file/reason changes and supports v0.9 baselines', async t => {
  const f = await compilationFixture(t), { config } = await loadConfiguration(f.configPath, f.limitsPath), setup = await prepareObservation(f.roots);
  const capture = await collectObservation(setup, f.roots), scenario = config.scenarios[0];
  const compilation = collectCompilation(scenario, setup.inventory, f.roots, processResult("node_modules/type-a/index.d.ts\n  Imported via 'type-a' from file 'src/index.ts'\n"))!;
  const task = { ...capture, capture_status: 'captured' as const, module_capture_status: 'captured' as const, issues: [], task: 'compile', trial: 'abc', task_definition_hash: hash(scenario), command: scenario.command, verdict: 'pass' as const, compilation };
  // Synthetic older-format comparison input, without v6 split health fields.
  delete task.load_capture_status; delete task.resolution_capture_status; delete task.load_issues; delete task.resolution_issues;
  const report: UsageReport = { schema_version: 1, kind: 'dependency_usage', version: '0.10.0', observer_version: capture.observer_version, status: 'observed', output: '', execution_report: 'report.json', started_at: '', environment: {},
    inputs: { snapshot_hash: hash('input'), config_hash: hash('config'), limits_hash: hash('limits') }, limits: { max_events_per_process: 10000, max_bytes_per_process: 2000000, max_process_logs: 64, max_total_bytes: 32000000, max_packages: 2048 }, tasks: [task], limitations: [] };
  const baseline = path.join(f.root, 'usage.json'); await fs.writeFile(baseline, JSON.stringify(report)); const old = await loadUsage(baseline);
  const current = structuredClone(report), now = current.tasks[0]; if (now.capture_status === 'not_run') throw new Error();
  now.compilation!.packages[0].version = '2.0.0';
  now.compilation!.files[0].reasons = ["Imported via 'type-a' from file '@workspace/src/other.ts'"];
  now.compilation!.files.push({ path: '@workspace/src/other.ts', kind: 'source', reasons: ['Root file specified for compilation'] });
  current.comparison = compareUsage(old, current, baseline);
  const diff = current.comparison.tasks[0].compilation!;
  assert.equal(diff.version_changes.length, 1); assert.equal(diff.added_files.length, 1); assert.equal(diff.explanation_changes.length, 1);
  assert.equal(current.comparison.tasks[0].added.length, 0);
  assert.match(usageMarkdown(current), /Compiler-input package version changed/); assert.match(usageMarkdown(current), /not an unused-package count/);
  delete (task as { compilation?: unknown }).compilation; await fs.writeFile(baseline, JSON.stringify(report));
  const missing = compareUsage(await loadUsage(baseline), current, baseline).tasks[0].compilation!;
  assert.equal(missing.state, 'unavailable'); assert.equal(missing.added.length, 0); assert.match(missing.warnings.join(' '), /not collected in both/);
  now.compilation!.capture_status = 'incomplete';
  assert.match(compareUsage(old, current, baseline).tasks[0].compilation!.warnings.join(' '), /partial/);
  const invalid = structuredClone(report), invalidTask = invalid.tasks[0]; if (invalidTask.capture_status === 'not_run') throw new Error();
  invalidTask.compilation = structuredClone(compilation); invalidTask.compilation.packages[0].files = [];
  await fs.writeFile(baseline, JSON.stringify(invalid)); await assert.rejects(loadUsage(baseline), /do not match/);
  invalidTask.compilation.packages = []; invalidTask.compilation.files = [];
  await fs.writeFile(baseline, JSON.stringify(invalid)); await assert.rejects(loadUsage(baseline), /Complete compiler capture/);
});
