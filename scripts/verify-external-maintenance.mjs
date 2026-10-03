// Explicitly prepare a fixed cache, then four fresh offline sandbox installations.
// --cold omits host preparation and uses registry access in every installation.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { cli, command, totals, json, digest, sourceManifest, writeJson } from './lib/trial-support.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const example = path.join(repository, 'examples/third-party/glob-parent-maintenance');
const upstream = { repository: 'https://github.com/gulpjs/glob-parent.git', commit: '26ce5ecec10c687cffb9891c108fb2d2800b9140' };
const { values } = parseArgs({ options: { output: { type: 'string' }, upstream: { type: 'string' }, cold: { type: 'boolean', default: false } } });
if (process.platform !== 'darwin') throw new Error('External maintenance requires a real macOS sandbox');
const root = values.output ? path.resolve(values.output) : (await fs.mkdir(path.join(repository, '.permsift'), { recursive: true }), await fs.mkdtemp(path.join(repository, '.permsift/external-maintenance-')));
if (values.output) await fs.mkdir(root);
const receipt = { status: 'running', started_at: new Date().toISOString(), root, upstream, steps: [],
  environment: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
  budget: { execution_commands: 4, sandbox_installations: 4, cache: values.cold ? 'cold' : 'fixed_warm_seed',
    host_seed_installations: values.cold ? 0 : 2, tasks_per_command: 1, repetitions: 1, candidates: 0, seconds_per_command: 180 },
  preparation: { host_installations_attempted: 0, cache: values.cold ? 'none' : path.join(root, 'seed-cache') },
  adaptation: { configurations: 1, limits: 1, command_wrappers: 0, upstream_source_edits: 0,
    command_change: 'Original npm test (including pretest lint and nyc); append only xunit output flags',
    goals: ['Deny task writes to index.js', 'Deny task writes to test/'], expected_test_names: 20 },
  limitations: ['Same local host/Node, not an independent user or cross-environment trial',
    'One fixed historical dependency upgrade; not a production security or latest-version recommendation',
    'Declared protections cover bounded task-stage direct operations; installation is outside their scope',
    'No compiler or bundle input capture for this test task; absence of module records does not establish unused dependencies'] };
const call = (name, args, options) => cli(receipt, root, repository, name, args, options);
try {
  let checkout = values.upstream && path.resolve(values.upstream);
  if (!checkout) {
    checkout = path.join(root, 'upstream'); await fs.mkdir(checkout);
    for (const [name, args] of [['git-init', ['init', checkout]], ['git-remote', ['-C', checkout, 'remote', 'add', 'origin', upstream.repository]],
      ['git-fetch', ['-C', checkout, 'fetch', '--depth=1', 'origin', upstream.commit]]]) {
      const r = await command(receipt, root, name, 'git', args); assert.equal(r.code, 0, r.stderr);
    }
  }
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' });
  assert.equal(git('rev-parse', upstream.commit).trim(), upstream.commit);
  // Export the pinned object, not arbitrary working-tree files or local dependencies.
  const tar = path.join(root, 'upstream.tar'); git('archive', '--format=tar', '--output=' + tar, upstream.commit);
  const project = path.join(root, 'project'); await fs.mkdir(project); execFileSync('tar', ['-xf', tar, '-C', project]);
  const upstreamFiles = git('ls-tree', '-r', '--name-only', upstream.commit).trim().split('\n');
  const sourceBefore = await sourceManifest(project, upstreamFiles);
  const beforeLock = path.join(example, 'package-lock.before.json'), afterLock = path.join(example, 'package-lock.after.json');
  const before = await json(beforeLock), after = await json(afterLock);
  assert.equal(await digest(beforeLock), 'f006f5181d185a8681794240e170c94101f68aae54aa7061e9b5c3bc9dcc3d24');
  assert.equal(await digest(afterLock), '801327e05cfe19f33b185503bf2c94e6eb92eb1d592eca0676f7317cb4f5401e');
  assert.deepEqual(Object.keys(before.packages), Object.keys(after.packages));
  const changedEntries = Object.keys(before.packages).filter(key => JSON.stringify(before.packages[key]) !== JSON.stringify(after.packages[key]));
  assert.deepEqual(changedEntries, ['node_modules/mocha']);
  receipt.change = { lock_before_sha256: await digest(beforeLock), lock_after_sha256: await digest(afterLock), changed_entries: changedEntries, mocha: { before: '7.1.2', after: '7.2.0' } };
  if (!values.cold) {
    const npm = path.join(path.dirname(process.execPath), 'npm');
    for (const [index, lock] of [beforeLock, afterLock].entries()) {
      await fs.copyFile(lock, path.join(project, 'package-lock.json'));
      receipt.preparation.host_installations_attempted++;
      const prepared = await command(receipt, root, 'prepare-cache-' + index, npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund',
        '--cache', receipt.preparation.cache, '--userconfig=/dev/null', '--globalconfig=' + path.join(root, 'empty-global-npmrc'), '--fetch-retries=0', '--fetch-timeout=15000'], { cwd: project });
      assert.equal(prepared.code, 0, prepared.stderr || prepared.stdout);
    }
    await fs.rm(path.join(project, 'node_modules'), { recursive: true });
    await fs.rm(path.join(receipt.preparation.cache, '_logs'), { recursive: true, force: true });
    await fs.cp(receipt.preparation.cache, path.join(project, 'seed'), { recursive: true, verbatimSymlinks: true });
    receipt.adaptation.cache_condition = 'Explicit fresh host npm ci for both locks, scripts disabled; fixed common seed copied into the project, then fresh sandbox npm ci --offline each time';
  }
  await fs.copyFile(beforeLock, path.join(project, 'package-lock.json'));
  const config = parse(await fs.readFile(path.join(example, 'permsift.yaml'), 'utf8')); config.project = project;
  if (values.cold) { config.scenarios[0].install.cache = 'cold'; delete config.scenarios[0].install.cache_seed; config.scenarios[0].initial_network_grants = ['registry.npmjs.org']; }
  const configPath = path.join(root, 'tasks.json'), limitsPath = path.join(root, 'limits.json');
  await writeJson(configPath, config); await fs.copyFile(path.join(example, 'limits.json'), limitsPath);
  const configHash = await digest(configPath), limitsHash = await digest(limitsPath);
  const args = ['--config', configPath, '--limits', limitsPath], store = path.join(root, 'baselines');
  const preview = await call('explain', ['explain', ...args, '--for', 'run'], { offline: true });
  assert.equal(preview.status, 'valid'); assert.equal(preview.schedule.nominal_installations, 1);
  assert.equal(preview.tasks[0].installation.offline, !values.cold);
  const initial = await call('establish', ['run', ...args, '--output', path.join(root, 'permission'), '--save-artifacts']);
  assert.equal(initial.status, 'verified'); assert.equal(initial.trials.length, 1);
  const initialEvidence = await json(path.join(initial.output, initial.trials[0].evidence));
  assert.equal(initialEvidence.installation.command.includes('--offline'), !values.cold);
  receipt.preparation.seed_sha256 = initial.inputs.installations['upstream-tests'].cache_seed_hash ?? null;
  receipt.upstream_test_result = initialEvidence.assertions.find(a => a.name === 'junit:@workspace/test.xunit')?.detail;
  const summary = await call('inspect-permission', ['inspect', initial.output], { offline: true });
  for (const key of ['source', 'tests']) assert.equal(summary.tasks[0].claims.find(c => c.dimension === 'protection_goal:' + key)?.status, 'pass');
  await call('adopt-before', ['adopt', initial.output, ...args, '--output', store, '--reason', 'Review upstream test results and fixed source/test write denials'], { offline: true });
  const pointer = path.join(store, 'current.json'), adoptedBefore = await fs.readFile(pointer, 'utf8');
  const first = await call('observe-before', ['observe', ...args, '--output', path.join(root, 'observe-before')]);
  assert.equal(first.status, 'observed');
  await fs.copyFile(afterLock, path.join(project, 'package-lock.json'));
  const maintained = await call('check-after-upgrade', ['check', ...args, '--baseline', store, '--output', path.join(root, 'check'), '--save-artifacts']);
  assert.equal(maintained.status, 'compatible'); assert.equal(maintained.trials, 1); assert.equal(maintained.candidate_count, 0);
  assert.equal(await fs.readFile(pointer, 'utf8'), adoptedBefore, 'check must not adopt automatically');
  const maintainedSummary = await call('inspect-check', ['inspect', maintained.output], { offline: true });
  for (const key of ['source', 'tests']) assert.equal(maintainedSummary.tasks[0].claims.find(c => c.dimension === 'protection_goal:' + key)?.status, 'pass');
  const second = await call('observe-after', ['observe', ...args, '--output', path.join(root, 'observe-after')]);
  assert.equal(second.status, 'observed');
  assert.deepEqual(await sourceManifest(project, upstreamFiles), sourceBefore);
  assert.equal(await digest(configPath), configHash); assert.equal(await digest(limitsPath), limitsHash);
  const usages = [path.join(first.output, 'usage.json'), path.join(second.output, 'usage.json')], usageHashes = await Promise.all(usages.map(digest));
  const observations = await Promise.all(usages.map(json));
  for (const [index, usage] of observations.entries()) {
    assert.equal(usage.tasks.length, 1); assert.equal(usage.tasks[0].capture_status, 'captured');
    assert.equal(usage.tasks[0].loaded_packages.find(p => p.name === 'mocha')?.version, index === 0 ? '7.1.2' : '7.2.0');
  }
  const checkedReport = await json(path.resolve(maintained.output, path.dirname(maintained.tasks[0].stages[0].report), 'report.json'));
  for (const report of [initial, await json(path.join(first.output, 'report.json')), checkedReport, await json(path.join(second.output, 'report.json'))]) {
    assert.equal(report.inputs.installations['upstream-tests'].cache_seed_hash ?? null, receipt.preparation.seed_sha256);
    const evidence = await json(path.join(report.output, report.trials[0].evidence));
    assert.equal(evidence.installation.command.includes('--offline'), !values.cold);
    assert.equal(evidence.install_cache.condition, values.cold ? 'cold' : 'warm');
  }
  await call('adopt-after-review', ['adopt', maintained.output, ...args, '--output', store, '--reason', 'After reviewing the Mocha version change, retain tested task permissions and protection goals'], { offline: true });
  // Actual disconnection from project inputs; queries must use saved records only.
  await fs.rm(project, { recursive: true });
  await call('inspect-adopted-offline', ['inspect', store], { offline: true });
  const queried = await call('inspect-mocha-offline', ['inspect', usages[1], '--package', 'mocha'], { offline: true }); assert.equal(queried.found, true);
  const compared = await call('compare-offline', ['compare', ...usages, '--output', path.join(root, 'comparison')], { offline: true });
  const changes = compared.comparison.tasks[0].version_changes;
  assert.deepEqual(changes, [{ path: '@workspace/node_modules/mocha', name: 'mocha', before: '7.1.2', after: '7.2.0' }]);
  assert.deepEqual(await Promise.all(usages.map(digest)), usageHashes);
  receipt.result = { policy_after_upgrade: maintained.status, task_config_changed: false, trusted_limits_changed: false,
    original_upstream_source_unchanged: true, baseline_unchanged_until_explicit_adoption: true, offline_after_project_removal: true,
    observed: observations.map(u => ({ installed_packages: u.tasks[0].inventory.packages.length, loaded_packages: u.tasks[0].loaded_packages.length, module_capture: u.tasks[0].capture_status })),
    version_changes: changes, user_decision: 'The reviewed task permissions and source protections can be retained for this upgrade; inspect the observed Mocha change in the test toolchain, not a universal upgrade safety claim' };
  assert.equal(totals(receipt.steps).installations, 4); assert.equal(totals(receipt.steps).task_executions, 4);
  assert.deepEqual(totals(receipt.steps).incomplete_counts, []);
  receipt.status = 'passed';
} catch (e) { receipt.status = 'failed'; receipt.error = String(e); process.exitCode = 1; }
receipt.execution = totals(receipt.steps); receipt.finished_at = new Date().toISOString(); await writeJson(path.join(root, 'verification.json'), receipt);
console.log('External maintenance evidence: ' + path.join(root, 'verification.json'));
