// Verify the distributed bytes in a new directory with a new npm cache.
// No runtime dependency imports before the fresh npm ci has completed.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { command, cli, json, writeJson, digest, verifySource, totals } from './lib/trial-support.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { bundle: { type: 'string' }, 'with-maintenance': { type: 'boolean', default: false }, upstream: { type: 'string' } } });
if (process.platform !== 'darwin') throw new Error('Live trial verification requires macOS');
if (values.upstream && !values['with-maintenance']) throw new Error('--upstream requires --with-maintenance');
await fs.mkdir(path.join(repository, '.permsift'), { recursive: true });
const root = await fs.mkdtemp(path.join(repository, '.permsift/clean-trial-'));
const receipt = { status: 'running', started_at: new Date().toISOString(), root, steps: [],
  environment: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
  preparation: { tool_installations_attempted: 0, example_installations_attempted: 0, fresh_npm_cache: path.join(root, 'npm-cache') },
  doctor_calls: 0, limitations: ['Clean-directory reproduction on the same host and Node installation; not a second environment',
    'Engineering acceptance does not measure independent user understanding, human time saving, or long-term maintenance benefit'] };
const host = async (name, executable, argv, options = {}) => {
  const r = await command(receipt, root, name, executable, argv, options); assert.equal(r.code, 0, r.stderr || r.stdout); return r;
};
try {
  let archive = values.bundle && path.resolve(values.bundle);
  if (!archive) {
    const r = await host('export-bundle', process.execPath, [path.join(repository, 'scripts/create-trial-bundle.mjs'), '--output', path.join(root, 'bundle')]);
    archive = r.stdout.trim();
  }
  receipt.archive = archive; receipt.archive_sha256 = await digest(archive);
  const source = path.join(root, 'source'); await fs.mkdir(source);
  await host('extract-bundle', 'tar', ['-xzf', archive, '-C', source]);
  const clean = path.join(source, 'permsift'), manifest = await json(path.join(clean, 'TRIAL-MANIFEST.json'));
  await verifySource(clean, manifest);
  receipt.source = { source_sha256: manifest.source_sha256, git_revision: manifest.git_revision, git_status: manifest.git_status, files: manifest.files.length };
  for (const excluded of ['node_modules', 'dist', '.permsift', '.git']) await assert.rejects(fs.access(path.join(clean, excluded)), { code: 'ENOENT' });
  const npm = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const prepEnv = { npm_config_cache: receipt.preparation.fresh_npm_cache, npm_config_userconfig: '/dev/null', npm_config_globalconfig: path.join(root, 'empty-global-npmrc') };
  receipt.preparation.tool_installations_attempted++;
  await host('npm-ci-tool', npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: clean, env: prepEnv });
  await host('build-tool', npm, ['run', 'build'], { cwd: clean });
  const call = (name, args, options) => cli(receipt, root, clean, name, args, options);
  await call('explain-before-doctor', ['explain', '--config', 'examples/demo/permsift.yaml', '--limits', 'examples/limits.json'], { offline: true });
  receipt.doctor_calls++;
  await call('doctor', ['doctor']);
  const permission = ['--config', 'examples/demo/permsift.yaml', '--limits', 'examples/limits.json'];
  const run = await call('permission-run', ['run', ...permission, '--output', path.join(root, 'permission')]);
  assert.equal(run.status, 'verified'); assert.equal(run.trials.length, 6);
  await call('permission-inspect', ['inspect', run.output], { offline: true });
  const store = path.join(root, 'baselines');
  await call('permission-adopt', ['adopt', run.output, ...permission, '--output', store, '--reason', 'Review demo task results and retain initial policy; no search requested'], { offline: true });
  // A small real source change in the fresh demo, without changing task terms.
  const demoBuild = path.join(clean, 'examples/demo/scripts/build.mjs');
  await fs.appendFile(demoBuild, '\n// Clean trial maintenance input change.\n');
  const check = await call('permission-check', ['check', ...permission, '--baseline', store, '--output', path.join(root, 'check')]);
  assert.equal(check.status, 'compatible'); assert.equal(check.trials, 6);
  await call('permission-check-inspect', ['inspect', check.output], { offline: true });
  const observation = ['--config', 'examples/projects/bundle-kit/observe.yaml', '--limits', 'examples/limits.json'];
  const preview = await call('observation-explain', ['explain', ...observation, '--for', 'observe'], { offline: true }); assert.equal(preview.schedule.nominal_task_executions, 1);
  // The preparation script announces each installation immediately before spawn.
  // If the first fails, the second must not be counted as attempted.
  const prepared = await command(receipt, root, 'prepare-examples', npm, ['run', 'examples:prepare'], { cwd: clean, env: prepEnv });
  receipt.preparation.example_installations_attempted = (prepared.stdout.match(/^Preparing (bundle-kit|cached-build) /gm) ?? []).length;
  await writeJson(path.join(root, 'verification.json'), receipt);
  assert.equal(prepared.code, 0, prepared.stderr || prepared.stdout);
  const first = await call('observation-before', ['observe', ...observation, '--output', path.join(root, 'observe-before')]); assert.equal(first.status, 'observed');
  await call('observation-inspect', ['inspect', first.output], { offline: true });
  await call('observation-package', ['inspect', path.join(first.output, 'usage.json'), '--package', 'esbuild'], { offline: true });
  const bundleSource = path.join(clean, 'examples/projects/bundle-kit/src/index.ts');
  await fs.writeFile(path.join(path.dirname(bundleSource), 'trial-input.ts'), 'globalThis.__permsiftTrialInput = true;\n');
  await fs.writeFile(bundleSource, "import './trial-input';\n" + await fs.readFile(bundleSource, 'utf8'));
  const second = await call('observation-after', ['observe', ...observation, '--output', path.join(root, 'observe-after')]); assert.equal(second.status, 'observed');
  const compared = await call('observation-compare', ['compare', path.join(first.output, 'usage.json'), path.join(second.output, 'usage.json')], { offline: true });
  assert.deepEqual(compared.comparison.tasks[0].bundling.added_inputs, ['@workspace/src/trial-input.ts']);
  receipt.onboarding = totals(receipt.steps);
  assert.equal(receipt.onboarding.task_executions, 14); assert.equal(receipt.onboarding.installations, 0); assert.deepEqual(receipt.onboarding.incomplete_counts, []);
  if (values['with-maintenance']) {
    const args = [path.join(clean, 'scripts/verify-external-maintenance.mjs'), '--output', path.join(root, 'external-maintenance'),
      ...values.upstream ? ['--upstream', path.resolve(values.upstream)] : []];
    const r = await command(receipt, root, 'external-maintenance', process.execPath, args, { cwd: clean, timeout: 900_000 });
    // Read failure receipts too; never silently retry the installation budget.
    receipt.external_maintenance = await json(path.join(root, 'external-maintenance/verification.json'));
    assert.equal(r.code, 0, receipt.external_maintenance.error || r.stderr);
    assert.equal(receipt.external_maintenance.status, 'passed');
  }
  receipt.status = 'passed';
} catch (e) { receipt.status = 'failed'; receipt.error = String(e); process.exitCode = 1; }
receipt.execution = totals(receipt.steps); receipt.finished_at = new Date().toISOString();
await writeJson(path.join(root, 'verification.json'), receipt);
console.log('Clean trial evidence: ' + path.join(root, 'verification.json'));
