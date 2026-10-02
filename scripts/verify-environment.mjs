// Small public-CLI reproduction. Every run gets a new output directory.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { adaptExperiment, readLegacyJson } from '../dist/src/model/index.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
process.chdir(repository);
const args = process.argv.slice(2);
if (args.some(a => a !== '--offline-only')) throw new Error('Only --offline-only is accepted');
const offlineOnly = args.includes('--offline-only');
if (!offlineOnly && process.platform !== 'darwin') throw new Error('Sandbox reproduction requires macOS; use --offline-only for record replay');
await fs.mkdir('.permsift', { recursive: true });
const root = await fs.mkdtemp(path.join(repository, '.permsift/environment-round1-'));
const summary = { root, started_at: new Date().toISOString(), environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version },
  scope: offlineOnly ? 'offline_only' : 'local_macos_minimum', steps: [], installations: 0,
  unverified: ['Second supported macOS host / target CI run', 'Independent user onboarding'] };
const save = () => fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const run = async (name, commandArgs, offline = false) => {
  console.log('Checking ' + name + '…');
  const start = performance.now();
  try {
    const result = await promisify(execFile)(process.execPath, ['dist/cli.js', ...commandArgs], { cwd: repository, encoding: 'utf8',
      timeout: 180000, maxBuffer: 16_000_000, env: offline ? { ...process.env, PATH: path.join(root, 'no-executables') } : process.env });
    await fs.writeFile(path.join(root, name + '.stdout.json'), result.stdout);
    await fs.writeFile(path.join(root, name + '.stderr.txt'), result.stderr);
    summary.steps.push({ name, command: commandArgs, status: 'passed', wall_ms: performance.now() - start }); await save();
    return JSON.parse(result.stdout);
  } catch (error) {
    await fs.writeFile(path.join(root, name + '.stderr.txt'), error.stderr ?? String(error));
    summary.steps.push({ name, command: commandArgs, status: 'failed', wall_ms: performance.now() - start, exit_code: error.code ?? null });
    await save(); throw error;
  }
};
try {
  if (!offlineOnly) {
    const doctor = await run('doctor', ['doctor', '--json', '--output', path.join(root, 'doctor')]);
    assert.equal(doctor.status, 'verified'); summary.environment = doctor.environment;
    const demo = await run('demo', ['tighten', '--config', 'examples/demo/permsift.yaml', '--limits', 'examples/limits.json', '--json', '--output', path.join(root, 'demo')]);
    assert.equal(demo.status, 'verified'); assert.equal(demo.search_complete, true);
    assert.deepEqual(demo.policies.test, ['@workspace/reports']); assert.deepEqual(demo.policies.build, ['@workspace/dist']);
    const inputs = await readLegacyJson(path.join(root, 'demo/inputs.json'));
    const evidence = Object.fromEntries(await Promise.all(demo.trials.map(async t =>
      [t.evidence, await readLegacyJson(path.join(root, 'demo/evidence', t.id + '.json'))])));
    const model = adaptExperiment(demo, { inputs, evidence });
    assert.ok(model.executions.every(e => e.outcomes.boundaries.status === 'pass'));
    assert.ok(model.executions.some(e => e.outcomes.task.status === 'fail'));
    assert.ok(model.executions.filter(e => e.reported_verdict.value === 'pass').every(e => e.outcomes.task.status === 'pass'));
    await fs.writeFile(path.join(root, 'demo.model.json'), JSON.stringify(model, null, 2) + '\n');
    summary.model_live_report_validation = 'passed';
    summary.sandbox_executions = doctor.trials.length + demo.trials.length;
    summary.demo_environment = demo.environment;
  }
  const inspected = await run('inspect', ['inspect', 'examples/reports/fast-glob-tasks.json', '--package', 'glob-parent', '--json'], true);
  assert.equal(inspected.status, 'complete'); assert.equal(inspected.tasks[0].instances[0].node.record, 'absent');
  assert.equal(inspected.tasks[1].instances[0].node.files, 1);
  const comparison = await run('compare', ['compare', 'examples/reports/fast-glob-bundle-before.json', 'examples/reports/fast-glob-bundle-after.json', '--json'], true);
  assert.equal(comparison.status, 'compared');
  assert.deepEqual(comparison.comparison.tasks[0].bundling.contribution_changes.map(p => [p.before_bytes, p.after_bytes]), [[934, 1560]]);
  summary.status = 'passed';
} catch (error) { summary.status = 'failed'; summary.error = String(error); process.exitCode = 1; }
summary.finished_at = new Date().toISOString(); await save();
console.log('Environment evidence: ' + path.join(root, 'summary.json'));
