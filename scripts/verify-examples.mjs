import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runExperiment } from '../dist/src/engine.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(projectRoot, '.permsift'), { recursive: true });
const output = await mkdtemp(path.join(projectRoot, '.permsift', 'representative-projects-'));
const expected = {
  'slug-kit': ['@workspace/reports'],
  'bundle-kit': ['@workspace/dist'],
  'cached-build': ['@cache/typescript', '@tmp/compiler', '@workspace/dist'],
};
const summary = [];
for (const [name, policy] of Object.entries(expected)) {
  const started = Date.now();
  const report = await runExperiment({ mode: 'tighten', configPath: path.join(projectRoot, 'examples', 'projects', name, 'permsift.yaml'), limitsPath: path.join(projectRoot, 'examples/limits.json'), output: path.join(output, name), onProgress: message => console.error(`${name} · ${message}`) });
  const scenario = Object.keys(report.policies)[0];
  const row = { project: name, status: report.status, search_complete: report.search_complete, trials: report.trials.length, duration_ms: Date.now() - started, final_policy: report.policies[scenario], rejected: Object.values(report.searches).flatMap(s => s.steps).filter(s => s.decision === 'rejected').length, report: path.join(report.output, 'report.md') };
  summary.push(row);
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  assert.equal(report.status, 'verified', `${name}: ${report.error}`);
  assert.equal(report.search_complete, true, `${name}: incomplete search`);
  assert.deepEqual(report.policies[scenario], policy, `${name}: unexpected policy`);
  assert.ok(Object.values(report.searches).some(s => s.steps.some(step => step.decision === 'rejected' && step.recovery_id)), `${name}: necessary permission was never tested`);
  const replay = await runExperiment({ mode: 'run', configPath: path.join(report.output, 'recommended.yaml'), limitsPath: path.join(projectRoot, 'examples/limits.json'), output: path.join(output, `${name}-replay`) });
  row.replay_verified = replay.status === 'verified';
  row.replay_trials = replay.trials.length;
  await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  assert.equal(replay.status, 'verified', `${name}: exported policy did not replay`);
  assert.equal(replay.inputs.snapshot_hash, report.inputs.snapshot_hash, `${name}: project input changed`);
}
console.log(JSON.stringify(summary, null, 2));
console.log(`Comparison: ${path.join(output, 'summary.json')}`);
