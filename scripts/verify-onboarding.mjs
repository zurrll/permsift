// Public CLI checks. Default: no tasks/installations. --live: four builds, no search/install.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

const repository = fileURLToPath(new URL('../', import.meta.url)); process.chdir(repository);
if (process.argv.slice(2).some(arg => arg !== '--live')) throw new Error('Only --live is supported');
const live = process.argv.includes('--live');
if (live && process.platform !== 'darwin') throw new Error('--live requires a real macOS sandbox');
await fs.mkdir('.permsift', { recursive: true });
const root = await fs.mkdtemp(path.join(repository, '.permsift/onboarding-validation-'));
const receipt = { root, started_at: new Date().toISOString(), status: 'running', live,
  environment: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
  steps: [], task_executions: 0, installations: 0, search_candidates: 0,
  limitations: ['Local engineering reproduction, not an independent user trial or measured human time saving',
    'Existing bundle-kit dependencies are prepared separately; this script performs no new installation',
    'Live change is a local source input; dependency upgrade and another host are not verified here'] };
const save = () => fs.writeFile(path.join(root, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n');
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function cli(name, args, offline = true, expected = 0) {
  const started = performance.now(); let stdout = '', stderr = '', code = 0;
  try { ({ stdout, stderr } = await promisify(execFile)(process.execPath, ['dist/cli.js', ...args, '--json'], {
    cwd: repository, encoding: 'utf8', timeout: 240000, maxBuffer: 16_000_000,
    env: { ...process.env, ...offline ? { PATH: '/permsift-no-external-tools' } : {} },
  })); } catch (e) { stdout = e.stdout ?? ''; stderr = e.stderr ?? String(e); code = e.code; }
  await fs.writeFile(path.join(root, name + '.stdout.json'), stdout);
  await fs.writeFile(path.join(root, name + '.stderr.txt'), stderr);
  receipt.steps.push({ name, argv: args, offline, exit_code: code, wall_ms: performance.now() - started }); await save();
  const result = JSON.parse(stdout);
  assert.equal(code, expected, stderr || result.error || result.status); return result;
}

try {
  const cases = [
    ['demo-run', 'examples/demo/permsift.yaml', 'examples/limits.json', 'run'],
    ['demo-tighten', 'examples/demo/permsift.yaml', 'examples/limits.json', 'tighten'],
    ['demo-observe', 'examples/demo/permsift.yaml', 'examples/limits.json', 'observe'],
    ['demo-check', 'examples/demo/permsift.yaml', 'examples/limits.json', 'check'],
    ['explicit-read', 'examples/demo/read-permsift.yaml', 'examples/read-limits.json', 'tighten'],
    ['shared-install', 'examples/install/permsift.yaml', 'examples/install/limits.json', 'run'],
    ['separate-install', 'examples/staged-install/permsift.yaml', 'examples/staged-install/limits.json', 'tighten'],
    ['bundle-observe', 'examples/projects/bundle-kit/observe.yaml', 'examples/limits.json', 'observe'],
  ];
  const originals = [...new Set(cases.flatMap(c => [c[1], c[2]]))];
  const before = await Promise.all(originals.map(digest));
  for (const [name, config, limits, mode] of cases) {
    const r = await cli(name, ['explain', '--config', config, '--limits', limits, '--for', mode]);
    assert.equal(r.status, 'valid'); assert.equal(r.scope, 'static_configuration_only');
    assert.equal(r.task_executions, 0); assert.equal(r.installations, 0);
    if (name === 'demo-run') assert.deepEqual(r.tasks[0].task.read.grants, ['@workspace']);
    if (name === 'demo-check') assert.equal(r.schedule.nominal_task_executions, null);
    if (name === 'bundle-observe') assert.equal(r.tasks[0].observation_output_root_removed, '@workspace/dist');
    if (name === 'shared-install') assert.equal(r.tasks[0].installation.write.origin.kind, 'inherited');
    if (name === 'separate-install') assert.equal(r.tasks[0].installation.mode, 'separate');
  }
  const bad = parse(await fs.readFile(cases[0][1], 'utf8'));
  bad.project = path.resolve('examples/demo'); bad.scenarios[0].initial_write_grants = ['@workspace/unapproved'];
  const badConfig = path.join(root, 'invalid.json'), badLimits = path.join(root, 'invalid-limits.json');
  await fs.writeFile(badConfig, JSON.stringify(bad));
  await fs.writeFile(badLimits, JSON.stringify({ schema_version: 1, allowed_write_roots: ['@workspace/dist', '@workspace/reports'] }));
  const rejected = await cli('invalid-ceiling', ['explain', '--config', badConfig, '--limits', badLimits], true, 2);
  assert.equal(rejected.status, 'invalid'); assert.ok(rejected.issues.some(i => /exceeds trusted limits/.test(i.message)));
  assert.deepEqual(await Promise.all(originals.map(digest)), before);
  receipt.static_cases = cases.length + 1; receipt.original_configurations_unchanged = true;

  if (live) {
    const originalSource = path.resolve('examples/projects/bundle-kit/src/index.ts'), originalHash = await digest(originalSource);
    await fs.access('examples/projects/bundle-kit/node_modules/esbuild/package.json').catch(() => { throw new Error('Prepare bundle-kit first with npm run examples:prepare'); });
    const project = path.join(root, 'project');
    await fs.cp(path.resolve('examples/projects/bundle-kit'), project, { recursive: true, verbatimSymlinks: true,
      filter: source => !['dist', '.permsift', '.git'].includes(path.basename(source)) });
    const config = parse(await fs.readFile('examples/projects/bundle-kit/observe.yaml', 'utf8')); config.project = project;
    const limits = { ...JSON.parse(await fs.readFile('examples/limits.json', 'utf8')), repetitions: 1, max_candidates: 0, budget_seconds: 120 };
    const configPath = path.join(root, 'tasks.json'), limitsPath = path.join(root, 'limits.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2)); await fs.writeFile(limitsPath, JSON.stringify(limits, null, 2));
    const executionArgs = ['--config', configPath, '--limits', limitsPath];
    const preview = await cli('live-explain', ['explain', ...executionArgs, '--for', 'observe']);
    assert.equal(preview.schedule.nominal_task_executions, 1); assert.equal(preview.schedule.nominal_installations, 0);
    const run = await cli('establish', ['run', ...executionArgs, '--output', path.join(root, 'permission')], false);
    receipt.task_executions += run.trials.length; assert.equal(run.status, 'verified', run.error);
    const evidence = JSON.parse(await fs.readFile(path.join(run.output, run.trials[0].evidence), 'utf8'));
    assert.deepEqual(evidence.prepared_directories, preview.tasks[0].initial_preparation);
    assert.deepEqual(run.policies.build, preview.tasks[0].task.write.grants);
    const store = path.join(root, 'baselines');
    await cli('adopt', ['adopt', run.output, ...executionArgs, '--output', store, '--reason', 'Review explicit dist-only task write scope']);
    const first = await cli('observe-before', ['observe', ...executionArgs, '--output', path.join(root, 'observe-before')], false);
    const countObserve = async r => { const e = JSON.parse(await fs.readFile(path.join(r.output, 'report.json'), 'utf8')); receipt.task_executions += e.trials.length; assert.equal(e.trials.length, 1); };
    await countObserve(first); assert.equal(first.status, 'observed');
    await fs.writeFile(path.join(project, 'src/onboarding-input.ts'), 'globalThis.__permsiftOnboardingInput = true;\n');
    await fs.writeFile(path.join(project, 'src/index.ts'), "import './onboarding-input';\n" + await fs.readFile(originalSource, 'utf8'));
    const maintained = await cli('check-after-change', ['check', ...executionArgs, '--baseline', store, '--output', path.join(root, 'check')], false);
    receipt.task_executions += maintained.trials; assert.equal(maintained.status, 'compatible');
    const second = await cli('observe-after', ['observe', ...executionArgs, '--output', path.join(root, 'observe-after')], false);
    await countObserve(second); assert.equal(second.status, 'observed');
    const saved = [path.join(first.output, 'usage.json'), path.join(second.output, 'usage.json')], hashes = await Promise.all(saved.map(digest));
    await fs.rm(project, { recursive: true, force: true });
    await cli('inspect-adopted', ['inspect', store]);
    const inspected = await cli('inspect-esbuild', ['inspect', saved[1], '--package', 'esbuild']); assert.equal(inspected.found, true);
    const comparison = await cli('compare-after-project-removal', ['compare', ...saved]);
    assert.equal(comparison.status, 'compared');
    assert.deepEqual(comparison.comparison.tasks[0].bundling.added_inputs, ['@workspace/src/onboarding-input.ts']);
    assert.deepEqual(await Promise.all(saved.map(digest)), hashes); assert.equal(await digest(originalSource), originalHash);
    assert.equal(receipt.task_executions, 4);
    receipt.live_result = { task: 'bundle-kit original build command and smoke conditions', policy_compatible_after_source_change: true,
      new_bundle_input: '@workspace/src/onboarding-input.ts', offline_after_project_removal: true, original_source_unchanged: true,
      adaptation: { task_configs: 1, trusted_limits: 1, project_copies: 1, command_wrappers: 0, original_task_command_changes: 0,
        changes: ['Project path points to the disposable copy', 'Verification limits use repetitions=1, max_candidates=0, budget_seconds=120'],
        source_change: 'One local side-effect source import/file in the disposable copy; original project untouched' } };
  }
  receipt.status = 'passed';
} catch (error) { receipt.status = 'failed'; receipt.error = String(error); process.exitCode = 1; }
receipt.finished_at = new Date().toISOString(); await save();
console.log('Onboarding evidence: ' + path.join(root, 'verification.json'));
