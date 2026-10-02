import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { runObservation } from '../../src/observe-command.js';
import { runExperiment } from '../../src/engine.js';
import { loadConfiguration } from '../../src/config.js';
import { hash } from '../../src/filesystem.js';
import { compilationFixture } from '../support/compilation-fixture.js';

const macOnly = { skip: process.platform !== 'darwin' ? 'Requires real macOS sandbox-exec' : false };
const expectedStatus = (version: string) => Number(version.split('.')[0]) >= 7 && typeof process.execve === 'function' ? 'incomplete' : 'observed';
test('real sandbox collects type-only inputs from one compiler execution with existing output and boundary checks', macOnly, async t => {
  const f = await compilationFixture(t), input = await loadConfiguration(f.configPath, f.limitsPath);
  const normal = await runExperiment({ mode: 'run', input: { ...input, limits: { ...input.limits, repetitions: 1 } }, output: path.join(f.root, 'normal') });
  assert.equal(normal.status, 'verified', normal.error); assert.equal(normal.dependency_observations, undefined);
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') }); assert.equal(report.status, expectedStatus(f.version));
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  assert.equal(task.verdict, 'pass'); assert.equal(task.compilation!.capture_status, 'captured');
  assert.equal(task.compilation!.compiler!.version, f.version);
  assert.ok(task.compilation!.packages.some(p => p.name === 'type-a')); assert.ok(task.compilation!.packages.some(p => p.name === '@types/ambient-a'));
  assert.ok(!task.loaded_packages.some(p => ['type-a', '@types/ambient-a'].includes(p.name)));
  assert.equal(report.inputs.snapshot_hash, normal.inputs.snapshot_hash);
  const evidence = JSON.parse(await fs.readFile(path.join(report.output, 'evidence', task.trial + '.json'), 'utf8'));
  assert.equal(task.compilation!.raw_output_hash, hash(evidence.task.process.stdout));
  assert.deepEqual(evidence.observer.compilation.executed_command, task.compilation!.executed_command);
  assert.ok(evidence.before.checks.every((c: any) => c.status === 'pass')); assert.ok(evidence.after.checks.every((c: any) => c.status === 'pass'));
  assert.deepEqual(evidence.task.policy.network.allowedDomains, []);
  assert.deepEqual(evidence.task.policy.filesystem.allowWrite, [path.join(evidence.roots.workspace, 'dist'), evidence.observer.collector]);
  const execution = JSON.parse(await fs.readFile(path.join(report.output, 'report.json'), 'utf8'));
  assert.equal(execution.trials.length, 1); assert.deepEqual(execution.searches, {}); assert.deepEqual(execution.read_searches, {});
  await assert.rejects(fs.access(path.join(f.roots.workspace, 'dist')));
});

test('real compiler comparison explains a switched type-only import and changed ambient package version', macOnly, async t => {
  const f = await compilationFixture(t);
  const before = await runObservation({ ...f, output: path.join(f.root, 'before') }); assert.equal(before.status, expectedStatus(f.version));
  const source = path.join(f.roots.workspace, 'src/index.ts'); await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace("'type-a'", "'type-b'"));
  await f.pkg('@types/ambient-a', '2.0.0', 'declare const AmbientFixture: number;');
  const after = await runObservation({ ...f, output: path.join(f.root, 'after'), baselinePath: path.join(before.output, 'usage.json') });
  assert.equal(after.status, expectedStatus(f.version)); assert.equal(after.comparison!.conditions.input_changed, true);
  const diff = after.comparison!.tasks[0]; assert.equal(diff.added.length, 0); assert.equal(diff.removed.length, 0);
  assert.deepEqual(diff.compilation!.added.map(p => p.name), ['type-b']); assert.deepEqual(diff.compilation!.removed.map(p => p.name), ['type-a']);
  assert.deepEqual(diff.compilation!.version_changes.map(p => [p.name, p.before, p.after]), [['@types/ambient-a', '1.0.0', '2.0.0']]);
  const task = after.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  assert.match(task.compilation!.files.find(f => f.path.endsWith('/type-b/index.d.ts'))!.reasons.join(' '), /Imported via 'type-b' from file '@workspace\/src\/index.ts'/);
});

test('a passing task without compiler explanations is incomplete and cannot reuse a stale explain file', macOnly, async t => {
  const f = await compilationFixture(t);
  await fs.writeFile(path.join(f.roots.workspace, 'old-explain.txt'), "node_modules/type-a/index.d.ts\n  Root file specified for compilation\n");
  await fs.writeFile(path.join(f.roots.workspace, 'node_modules/typescript/bin/tsc'), "import fs from 'node:fs';fs.writeFileSync('dist/index.js','answer');fs.writeFileSync('dist/index.d.ts','Shape');\n");
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') }); assert.equal(report.status, 'incomplete');
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  assert.equal(task.verdict, 'pass'); assert.equal(task.capture_status, 'captured');
  assert.equal(task.compilation!.capture_status, 'unavailable'); assert.equal(task.compilation!.files.length, 0);
});

test('trusted output ceiling stops an oversized compiler and preserves partial source status', macOnly, async t => {
  const f = await compilationFixture(t);
  const limits = JSON.parse(await fs.readFile(f.limitsPath, 'utf8')); limits.max_output_bytes = 1024; await fs.writeFile(f.limitsPath, JSON.stringify(limits));
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') }); assert.equal(report.status, 'incomplete');
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  assert.equal(task.verdict, 'unknown'); assert.notEqual(task.compilation!.capture_status, 'captured');
  const evidence = JSON.parse(await fs.readFile(path.join(report.output, 'evidence', task.trial + '.json'), 'utf8'));
  assert.equal(evidence.task.process.status, 'output_limit'); assert.ok(Buffer.byteLength(evidence.task.process.stdout) <= 1024);
});
