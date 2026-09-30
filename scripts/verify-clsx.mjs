import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { runExperiment } from '../dist/src/engine.js';

const root = fileURLToPath(new URL('../', import.meta.url));
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
  read_inventory_truncated: report.read_discovery['build-smoke'].truncated, snapshot_hash: report.inputs.snapshot_hash, replay_hash_equal: true, report: path.join(report.output, 'report.md') };
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2)); console.log(`Comparison: ${path.join(output, 'summary.json')}`);
