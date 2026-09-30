import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { runExperiment } from '../dist/src/engine.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { baseline: { type: 'string' } }, allowPositionals: false });
const baseline = values.baseline ? JSON.parse(await readFile(values.baseline, 'utf8')) : undefined;
const previous = baseline ? JSON.parse(await readFile(path.join(path.dirname(baseline.report), 'report.json'), 'utf8')) : undefined;
const commit = execFileSync('git', ['-C', path.join(root, '.permsift/third-party/clsx'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(commit, '925494cf31bcd97d3337aacd34e659e80cae7fe2', 'Prepare the pinned fixture first');
await mkdir(path.join(root, '.permsift'), { recursive: true });
const output = await mkdtemp(path.join(root, '.permsift/clsx-read-'));
const limitsPath = path.join(root, 'examples/third-party/clsx/limits.json');
const started = Date.now();
const report = await runExperiment({ mode: 'tighten', configPath: path.join(root, 'examples/third-party/clsx/permsift.yaml'), limitsPath, output: path.join(output, 'search'), onProgress: message => console.error(message) });
assert.equal(report.status, 'verified', report.error);
assert.equal(report.search_complete, true, 'Raise the budget if search cannot finish');
assert.deepEqual(report.policies['build-smoke'], ['@workspace/dist']);
assert.ok(!report.read_policies['build-smoke'].includes('@workspace'));
assert.ok(!report.read_policies['build-smoke'].some(p => p.startsWith('@workspace/test') || p.startsWith('@workspace/readme')));
assert.ok(report.read_searches['build-smoke'].steps.some(s => s.decision === 'rejected' && s.recovery_id));
const replay = await runExperiment({ mode: 'run', configPath: path.join(report.output, 'recommended.yaml'), limitsPath, output: path.join(output, 'replay') });
assert.equal(replay.status, 'verified'); assert.equal(replay.inputs.snapshot_hash, report.inputs.snapshot_hash);
const summary = { project: 'lukeed/clsx', commit, status: report.status, search_complete: report.search_complete, trials: report.trials.length, replay_trials: replay.trials.length,
  duration_ms: Date.now() - started, final_write: report.policies['build-smoke'], final_read: report.read_policies['build-smoke'],
  permsift: report.environment.permsift, candidate_trials: report.trials.filter(t => t.phase.startsWith('candidate')).length,
  recovery_trials: report.trials.filter(t => t.phase.startsWith('recovery')).length,
  group_steps: report.read_searches['build-smoke'].steps.filter(s => s.source === 'group_removal').length,
  read_rounds: report.read_searches['build-smoke'].rounds,
  reused_failure_hints: report.read_searches['build-smoke'].reuses.length,
  read_inventory_truncated: report.read_discovery['build-smoke'].truncated, snapshot_hash: report.inputs.snapshot_hash, replay_hash_equal: true, report: path.join(report.output, 'report.md') };
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
if (baseline) {
  const normalized = policies => Object.fromEntries(Object.keys(policies).sort().map(id => [id, [...policies[id]].sort()]));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const matches = {
    input_snapshot: typeof previous.inputs.snapshot_hash === 'string' && previous.inputs.snapshot_hash === report.inputs.snapshot_hash,
    config: typeof previous.inputs.config_hash === 'string' && previous.inputs.config_hash === report.inputs.config_hash,
    limits: typeof previous.inputs.limits_hash === 'string' && previous.inputs.limits_hash === report.inputs.limits_hash,
    environment: ['platform', 'release', 'arch', 'node', 'sandbox_runtime'].every(key => previous.environment[key] === report.environment[key]),
    final_write: equal(normalized(previous.policies), normalized(report.policies)),
    final_read: equal(normalized(previous.read_policies), normalized(report.read_policies)),
    both_verified: previous.status === 'verified' && report.status === 'verified',
    both_search_complete: previous.search_complete && report.search_complete,
  };
  const metrics = (r, duration) => ({ version: r.environment.permsift, trials: r.trials.length,
    candidates: r.trials.filter(t => t.phase.startsWith('candidate')).length,
    recoveries: r.trials.filter(t => t.phase.startsWith('recovery')).length, duration_ms: duration });
  const comparison = { matches, baseline: metrics(previous, baseline.duration_ms), optimized: metrics(report, summary.duration_ms),
    saved_trials: previous.trials.length - report.trials.length,
    trial_reduction_percent: 100 * (1 - report.trials.length / previous.trials.length),
    duration_reduction_percent: 100 * (1 - summary.duration_ms / baseline.duration_ms),
    baseline_report: baseline.report, optimized_report: summary.report,
    timing_limitations: 'Single local observations including replay; timing depends on host load, filesystem cache and environment. Not a performance benchmark.' };
  await writeFile(path.join(output, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
  for (const [name, matchesBaseline] of Object.entries(matches)) assert.equal(matchesBaseline, true, `Baseline mismatch: ${name}; see comparison.json`);
  assert.ok(report.trials.length < previous.trials.length, 'The optimized clsx experiment did not reduce trials');
  console.log(`Baseline comparison: ${path.join(output, 'comparison.json')}`);
}
console.log(JSON.stringify(summary, null, 2)); console.log(`Comparison: ${path.join(output, 'summary.json')}`);
