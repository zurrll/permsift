import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { runObservation } from '../../src/observe-command.js';
import { runExperiment } from '../../src/engine.js';
import { loadConfiguration } from '../../src/config.js';
import { loadBaseline } from '../../src/regression.js';
import { observationFixture } from '../support/observation-fixture.js';

const macOnly = { skip: process.platform !== 'darwin' ? 'Requires real macOS sandbox-exec' : false };

test('real observation runs once, preserves task assertions and boundaries with only a private collector exception', macOnly, async t => {
  const f = await observationFixture(t);
  const input = await loadConfiguration(f.configPath, f.limitsPath);
  const normal = await runExperiment({ mode: 'run', input: { ...input, limits: { ...input.limits, repetitions: 1 } }, output: path.join(f.root, 'normal') });
  assert.equal(normal.status, 'verified', normal.error);
  assert.equal(normal.dependency_observations, undefined);
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') });
  assert.equal(report.status, 'observed', JSON.stringify(report.tasks));
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error('Not run');
  assert.equal(task.verdict, 'pass'); assert.equal(task.capture_status, 'captured'); assert.equal(task.processes.length, 2);
  assert.equal(task.loaded_packages.length, 4); assert.deepEqual(task.not_observed.map(p => p.name), ['unused']);
  assert.equal(report.inputs.snapshot_hash, normal.inputs.snapshot_hash);
  const execution = JSON.parse(await fs.readFile(path.join(report.output, 'report.json'), 'utf8'));
  assert.equal(execution.trials.length, 1); assert.deepEqual(execution.searches, {}); assert.deepEqual(execution.read_searches, {});
  await assert.rejects(fs.access(path.join(report.output, 'recommended.yaml')));
  await assert.rejects(loadBaseline(path.join(report.output, 'report.json')), 'An observation cannot become a policy regression baseline');
  await assert.rejects(fs.access(path.join(f.roots.workspace, 'dist')));
  const evidence = JSON.parse(await fs.readFile(path.join(report.output, 'evidence', task.trial + '.json'), 'utf8'));
  assert.ok(evidence.before.checks.every((c: any) => c.status === 'pass'));
  assert.ok(evidence.after.checks.every((c: any) => c.status === 'pass'));
  assert.ok(evidence.task.policy.filesystem.denyWrite.includes(evidence.observer.bootstrap));
  assert.deepEqual(evidence.task.policy.network.allowedDomains, []);
  assert.deepEqual(evidence.task.policy.filesystem.allowWrite, [path.join(evidence.roots.workspace, 'dist'), evidence.observer.collector]);
  assert.ok(!evidence.before.execution.policy.filesystem.allowWrite.includes(evidence.observer.collector));
});
test('a failed observed task keeps its records and does not suppress other configured tasks', macOnly, async t => {
  const f = await observationFixture(t);
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  config.scenarios.unshift({ ...config.scenarios[0], id: 'broken', command: [process.execPath, '-e', "require('alpha');require('node:fs').writeFileSync('dist/result','fresh');process.exit(7);"] });
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') });
  assert.equal(report.status, 'failed'); assert.equal(report.tasks.length, 2);
  const [broken, build] = report.tasks;
  if (broken.capture_status === 'not_run' || build.capture_status === 'not_run') throw new Error();
  assert.equal(broken.verdict, 'fail'); assert.equal(broken.capture_status, 'captured'); assert.equal(build.verdict, 'pass');
  assert.ok(broken.loaded_packages.some(p => p.name === 'alpha'));
});

test('real usage comparison explains a newly loaded instance and a changed observed version', macOnly, async t => {
  const f = await observationFixture(t);
  const before = await runObservation({ ...f, output: path.join(f.root, 'before') }); assert.equal(before.status, 'observed');
  const file = path.join(f.roots.workspace, 'task.cjs'); await fs.appendFile(file, "\nrequire('unused');\n");
  await f.pkg('alpha', 'alpha', '2.0.0', "module.exports=require('shared');");
  const after = await runObservation({ ...f, output: path.join(f.root, 'after'), baselinePath: path.join(before.output, 'usage.json') });
  assert.equal(after.status, 'observed'); assert.equal(after.comparison!.conditions.input_changed, true);
  assert.deepEqual(after.comparison!.tasks[0].added.map(p => p.name), ['unused']);
  assert.deepEqual(after.comparison!.tasks[0].version_changes, [{ path: '@workspace/node_modules/alpha', name: 'alpha', before: '1.0.0', after: '2.0.0' }]);
});

test('observer preload is write-denied even with broad temp writes; cleared child environments are visible gaps', macOnly, async t => {
  const f = await observationFixture(t);
  await fs.writeFile(path.join(f.roots.workspace, 'task.cjs'), `
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');
try{fs.writeFileSync(p.join(process.env.TMPDIR,'.permsift-observer/preload.cjs'),'tampered');process.exit(9);}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}
const child=cp.spawnSync(process.execPath,['-e',"require('unused')"],{env:{...process.env,NODE_OPTIONS:''}});if(child.status!==0)throw Error(child.stderr.toString());
fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/result','fresh');
`);
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8')); config.scenarios[0].initial_write_grants.push('@tmp');
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const limits = JSON.parse(await fs.readFile(f.limitsPath, 'utf8')); limits.allowed_write_roots.push('@tmp'); await fs.writeFile(f.limitsPath, JSON.stringify(limits));
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') });
  assert.equal(report.status, 'observed', JSON.stringify(report.tasks));
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  assert.equal(task.processes.length, 1); assert.ok(task.not_observed.some(p => p.name === 'unused'));
  assert.match(task.coverage_gaps.join(' '), /did not retain/);
});

test('non-Node task passes independently of unavailable module observations', macOnly, async t => {
  const f = await observationFixture(t);
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8')); config.scenarios[0].command = ['/bin/sh', '-c', 'echo fresh > dist/result'];
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') });
  assert.equal(report.status, 'incomplete');
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  assert.equal(task.verdict, 'pass'); assert.equal(task.capture_status, 'unavailable');
});

test('timed out observation preserves partial records and cannot become an observed success', macOnly, async t => {
  const f = await observationFixture(t);
  await fs.writeFile(path.join(f.roots.workspace, 'task.cjs'), "require('alpha');setInterval(()=>{},1000);");
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8')); config.scenarios[0].timeout_seconds = 1; await fs.writeFile(f.configPath, JSON.stringify(config));
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') });
  assert.equal(report.status, 'incomplete');
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  assert.equal(task.verdict, 'unknown'); assert.equal(task.capture_status, 'incomplete'); assert.ok(task.loaded_packages.some(p => p.name === 'alpha'));
  assert.match(task.issues.join(' '), /did not finish/);
});
