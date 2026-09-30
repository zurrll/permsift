import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runExperiment } from '../dist/src/engine.js';
import { runRegression } from '../dist/src/regression.js';

const root = fileURLToPath(new URL('../', import.meta.url));
await fs.mkdir(path.join(root, '.permsift'), { recursive: true });
const output = await fs.mkdtemp(path.join(root, '.permsift', 'regression-upgrades-'));
const project = path.join(output, 'project');
await fs.cp(path.join(root, 'examples/regression/base'), project, { recursive: true });
const original = await fs.readFile(path.join(project, 'build.cjs'), 'utf8');
const configPath = path.join(output, 'tasks.json'), limitsPath = path.join(output, 'limits.json');
await fs.writeFile(configPath, JSON.stringify({ schema_version: 1, project: './project', scenarios: [{ id: 'build', command: ['node','build.cjs'],
  initial_write_grants: ['@workspace'], initial_read_grants: ['@workspace'], auto_discover: false,
  narrower_candidates: [{ from: '@workspace', to: ['@workspace/dist'] }],
  assertions: [{ type: 'json_equals', path: '@workspace/dist/result.json', pointer: '/classes', value: 'alpha beta' }] }] }));
await fs.writeFile(limitsPath, JSON.stringify({ schema_version: 1, allowed_write_roots: ['@workspace'], allowed_read_roots: ['@workspace'], repetitions: 3, max_candidates: 40, budget_seconds: 120 }));
const baseline = await runExperiment({ mode: 'tighten', configPath, limitsPath, output: path.join(output, 'baseline') });
assert.equal(baseline.status, 'verified'); assert.equal(baseline.search_complete, true);
assert.deepEqual(baseline.policies.build, ['@workspace/dist']);
const summary = { baseline_trials: baseline.trials.length, checks: [] };
const check = async (name, status, repair) => {
  const started = Date.now();
  const report = await runRegression({ configPath, limitsPath, baselinePath: path.join(baseline.output, 'report.json'), output: path.join(output, name),
    onProgress: message => console.error(`${name} · ${message}`) });
  assert.equal(report.tasks[0].status, status, JSON.stringify(report));
  if (repair) assert.equal(report.tasks[0].repair_stop, 'verified');
  const row = { name, status: report.status, task_status: report.tasks[0].status, input_changed: report.inputs.input_changed,
    trials: report.trials, candidates: report.candidate_count, duration_ms: Date.now() - started, added_read: report.tasks[0].suggestion?.added_read ?? [], added_write: report.tasks[0].suggestion?.added_write ?? [], report: path.join(report.output, 'report.md') };
  if (repair) {
    const replay = await runExperiment({ mode: 'run', configPath: path.join(report.output, 'suggested.yaml'), limitsPath, output: path.join(output, name + '-replay') });
    assert.equal(replay.status, 'verified'); assert.equal(replay.inputs.snapshot_hash, report.inputs.snapshot_hash);
    row.replay_trials = replay.trials.length;
  }
  summary.checks.push(row); await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return report;
};
await check('unchanged', 'compatible', false);
await fs.writeFile(path.join(project, 'build.cjs'), original + '\n// Refactor with unchanged permissions.\n');
await check('compatible-code-change', 'compatible', false);
await fs.writeFile(path.join(project, 'src/format.json'), '{"joiner":" "}');
await fs.writeFile(path.join(project, 'build.cjs'), original.replace("input.classes.join(' ')", "input.classes.join(JSON.parse(fs.readFileSync('src/format.json','utf8')).joiner)"));
const changed = await check('new-source-input', 'permission_change', true);
assert.deepEqual(changed.tasks[0].suggestion.added_read, ['@workspace/src/format.json']);
await fs.rm(path.join(project, 'src/format.json'));
await fs.copyFile(path.join(root, 'examples/regression/dependency/package.json'), path.join(project, 'package.json'));
await fs.copyFile(path.join(root, 'examples/regression/dependency/package-lock.json'), path.join(project, 'package-lock.json'));
await fs.cp(path.join(root, 'examples/regression/dependency/node_modules'), path.join(project, 'node_modules'), { recursive: true });
await fs.writeFile(path.join(project, 'build.cjs'), original.replace("input.classes.join(' ')", "require('clsx')(...input.classes)"));
const dependency = await check('added-clsx-dependency', 'permission_change', true);
assert.ok(dependency.tasks[0].suggestion.added_read.every(p => p === '@workspace/package.json' || p === '@workspace/node_modules/clsx' || p.startsWith('@workspace/node_modules/clsx/')));
assert.ok(dependency.tasks[0].suggestion.added_read.some(p => p === '@workspace/node_modules/clsx' || p.startsWith('@workspace/node_modules/clsx/')));
await fs.writeFile(path.join(project, 'build.cjs'), "throw new Error('deliberate code regression');\n");
const bug = await check('ordinary-code-bug', 'unresolved_failure', false);
assert.equal(bug.candidate_count, 0); await assert.rejects(fs.access(path.join(bug.output, 'suggested.yaml')));
console.log(JSON.stringify(summary, null, 2)); console.log(`Summary: ${path.join(output, 'summary.json')}`);
