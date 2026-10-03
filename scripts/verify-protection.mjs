// Small public-CLI story. Creates a separate tiny example, never modifies the checked-in project.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
const repository = fileURLToPath(new URL('../', import.meta.url)); process.chdir(repository);
if (process.platform !== 'darwin') throw new Error('protection:verify requires real macOS isolation');
await fs.mkdir('.permsift', { recursive: true });
const root = await fs.mkdtemp(path.join(repository, '.permsift/protection-validation-')), project = path.join(root, 'project'), runs = [];
await fs.cp('examples/protection/project', project, { recursive: true });
const config = parse(await fs.readFile('examples/protection/permsift.yaml', 'utf8')); config.project = project;
const configPath = path.join(root, 'tasks.json'), limitsPath = path.join(repository, 'examples/protection/limits.json');
await fs.writeFile(configPath, JSON.stringify(config));
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const baseline = path.join(root, 'baseline'), ordinary = path.join(root, 'without-goals'), conflict = path.join(root, 'conflict');
async function run(name, args, expected, offline = false) {
  const started = performance.now(); const result = spawnSync(process.execPath, ['dist/cli.js', ...args], {
    encoding: 'utf8', maxBuffer: 8_000_000, timeout: 120_000,
    env: { ...process.env, ...offline ? { PATH: path.join(root, 'no-executables') } : {} },
  });
  await fs.writeFile(path.join(root, name + '.stdout'), result.stdout ?? ''); await fs.writeFile(path.join(root, name + '.stderr'), result.stderr ?? '');
  runs.push({ command: args, exit_code: result.status, wall_ms: performance.now() - started, offline });
  assert.equal(result.status, expected, result.stderr); return JSON.parse(result.stdout);
}
try {
  const initial = await run('baseline', ['run', '--config', configPath, '--limits', limitsPath, '--output', baseline, '--json'], 0);
  assert.equal(initial.status, 'verified');
  const summary = await json(path.join(baseline, 'summary.json'));
  assert.equal(summary.tasks[0].claims.find(c => c.dimension === 'protections').status, 'pass');
  assert.deepEqual(await run('offline-baseline', ['inspect', baseline, '--json'], 0, true), summary);
  const noGoals = structuredClone(config); delete noGoals.scenarios[0].protection_goals;
  const noGoalsPath = path.join(root, 'tasks-without-goals.json'); await fs.writeFile(noGoalsPath, JSON.stringify(noGoals));
  const plain = await run('without-goals', ['run', '--config', noGoalsPath, '--limits', limitsPath, '--output', ordinary, '--json'], 0);
  assert.equal(plain.trials.length, initial.trials.length);
  // Change only this working example to create a conflict with the fixed agreement.
  const taskFile = path.join(project, 'build.cjs'); const original = await fs.readFile(taskFile, 'utf8');
  await fs.writeFile(taskFile, "require('node:fs').readFileSync('private/config.json');\n" + original);
  const checked = await run('conflict', ['check', '--config', configPath, '--limits', limitsPath, '--baseline', path.join(baseline, 'report.json'), '--output', conflict, '--json'], 1);
  assert.equal(checked.tasks[0].status, 'unresolved_failure'); assert.equal(checked.tasks[0].suggestion, undefined);
  const conflictSummary = await json(path.join(conflict, 'summary.json'));
  assert.ok(conflictSummary.tasks[0].stages.every(s => s.task === 'fail' && s.protections === 'pass'));
  assert.deepEqual(await run('offline-conflict', ['inspect', conflict, '--json'], 0, true), conflictSummary);
  const details = await json(path.join(baseline, initial.trials[0].evidence));
  await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify({ status: 'passed', verified_at: new Date().toISOString(), environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version },
    task_executions: initial.trials.length + plain.trials.length + checked.trials, installations: 0,
    protection_checks: details.protections.map(p => ({ moment: p.moment, fixture_files: p.fixture_files, sandbox_executed: !!p.execution })),
    costs: { with_goals_ms: initial.timings.total_ms, without_goals_ms: plain.timings.total_ms, protection_phase: initial.timings.phases.protections },
    runs, limitations: ['One local sample, not a performance benchmark or independent user study.', 'Direct task-stage checks only; installation and other access channels are not verified.'] }, null, 2) + '\n');
  console.log('Protection evidence: ' + path.join(root, 'verification.json'));
} catch (error) {
  await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), runs }, null, 2) + '\n'); throw error;
}
