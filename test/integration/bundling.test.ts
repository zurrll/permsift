import { assertNativeEvidence } from '../support/native-evidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { bundlingFixture } from '../support/bundling-fixture.js';
import { runObservation, loadUsage } from '../../src/observe-command.js';
import { runExperiment } from '../../src/engine.js';
import { loadConfiguration } from '../../src/config.js';

const macOnly = { skip: process.platform !== 'darwin' ? 'Requires real macOS sandbox-exec' : false };
test('one real sandbox build collects the fresh full output set without expanding project grants or running a search', macOnly, async t => {
  const f = await bundlingFixture(t), input = await loadConfiguration(f.configPath, f.limitsPath);
  const normal = await runExperiment({ mode: 'run', input: { ...input, limits: { ...input.limits, repetitions: 1 } }, output: path.join(f.root, 'normal') });
  assert.equal(normal.status, 'verified', normal.error);
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') }); assert.equal(report.status, 'observed');
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  const b = task.bundling!; assert.equal(b.capture_status, 'captured'); assert.equal(task.verdict, 'pass');
  assert.equal(report.inputs.snapshot_hash, normal.inputs.snapshot_hash);
  assert.ok(b.outputs.some(o => o.entry_point?.includes('lazy-pkg'))); assert.ok(b.outputs.some(o => o.path.endsWith('.map')));
  assert.ok(b.packages.some(p => p.name === 'shared')); assert.ok(!task.loaded_packages.some(p => p.name === 'shared'));
  assert.ok(task.loaded_packages.some(p => p.name === 'external-pkg')); assert.ok(b.outputs.some(o => o.imports.some(i => i.external && i.path === 'external-pkg')));
  const evidence = JSON.parse(await fs.readFile(path.join(report.output, 'evidence', task.trial + '.json'), 'utf8'));
  assert.equal(evidence.observer.bundling.output_directory_cleared, true);
  assert.deepEqual(evidence.task.policy.network.allowedDomains, []);
  assert.deepEqual(evidence.task.policy.filesystem.allowWrite, [path.join(evidence.roots.workspace, 'dist'), evidence.observer.collector]);
  assert.ok(evidence.before.checks.every((c: any) => c.status === 'pass')); assert.ok(evidence.after.checks.every((c: any) => c.status === 'pass'));
  assert.deepEqual(b.executed_command, f.scenario.command); assert.equal(task.compilation, undefined);
  const execution = JSON.parse(await fs.readFile(path.join(report.output, 'report.json'), 'utf8'));
  const facts = (await assertNativeEvidence(execution))[0];
  assert.equal(facts.execution.outcomes.task.status, 'pass');
  assert.equal(facts.execution.observations.modules.status, task.capture_status);
  assert.equal(facts.execution.observations.build.status, 'captured');
  assert.equal(execution.trials.length, 1); assert.deepEqual(execution.searches, {}); assert.deepEqual(execution.read_searches, {});
  await loadUsage(path.join(report.output, 'usage.json')); await assert.rejects(fs.access(path.join(f.roots.workspace, 'dist')));
});

test('a real import/version change is visible in bundle inputs, contribution and graph comparison with stable tool loads', macOnly, async t => {
  const f = await bundlingFixture(t), first = await runObservation({ ...f, output: path.join(f.root, 'first') }); assert.equal(first.status, 'observed');
  const source = path.join(f.roots.workspace, 'src/index.ts'); await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace("'app-a'", "'app-b'"));
  await f.pkg('shared', 'export const answer = 42;', '2.0.0');
  const next = await runObservation({ ...f, baselinePath: path.join(first.output, 'usage.json'), output: path.join(f.root, 'next') }); assert.equal(next.status, 'observed');
  const diff = next.comparison!.tasks[0]; assert.deepEqual(diff.added, []); assert.deepEqual(diff.removed, []); assert.deepEqual(diff.version_changes, []);
  assert.deepEqual(diff.bundling!.added.map(p => p.name), ['app-b']); assert.deepEqual(diff.bundling!.removed.map(p => p.name), ['app-a']);
  assert.deepEqual(diff.bundling!.version_changes.map(p => [p.name, p.before, p.after]), [['shared', '1.0.0', '2.0.0']]);
  assert.ok(diff.bundling!.contribution_changes.some(c => c.name === 'app-b' && c.after_bytes === 0));
  assert.ok(diff.bundling!.chain_changes.some(c => c.path.endsWith('/shared/index.js') && c.after.some(p => p.includes('app-b'))));
  assert.equal(next.comparison!.conditions.input_changed, true);
});

test('successful task cannot reuse a stale metafile or a stale lazy output from the input snapshot', macOnly, async t => {
  const f = await bundlingFixture(t), config = JSON.parse(await fs.readFile(f.configPath, 'utf8')); config.exclude = ['.git'];
  await fs.mkdir(path.join(f.roots.workspace, 'dist')); await fs.writeFile(path.join(f.roots.workspace, 'dist/meta.json'), JSON.stringify({ inputs: {}, outputs: {} }));
  await fs.writeFile(path.join(f.roots.workspace, 'dist/old-lazy.mjs'), 'stale');
  await fs.writeFile(path.join(f.roots.workspace, 'build.mjs'), "import {writeFile,access} from 'node:fs/promises';\ntry {await access('dist/old-lazy.mjs');throw Error('stale lazy output survived')}catch(e){if(e.code!=='ENOENT')throw e}\nawait writeFile('dist/smoke.json',JSON.stringify({passed:true}));");
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') }); assert.equal(report.status, 'incomplete');
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  assert.equal(task.verdict, 'pass'); assert.equal(task.bundling!.capture_status, 'unavailable'); assert.deepEqual(task.bundling!.packages, []);
  assert.equal(await fs.readFile(path.join(f.roots.workspace, 'dist/old-lazy.mjs'), 'utf8'), 'stale');
});

test('partial task execution keeps received metadata without claiming complete build evidence', macOnly, async t => {
  const f = await bundlingFixture(t); await fs.appendFile(path.join(f.roots.workspace, 'build.mjs'), '\nprocess.exitCode=1;\n');
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') }); assert.equal(report.status, 'failed');
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  assert.equal(task.verdict, 'fail'); assert.equal(task.bundling!.capture_status, 'incomplete'); assert.ok(task.bundling!.outputs.length); await loadUsage(path.join(report.output, 'usage.json'));
});

test('a forged reported output outside the declared set is a coverage issue and receives no implicit write grant', macOnly, async t => {
  const f = await bundlingFixture(t); await fs.appendFile(path.join(f.roots.workspace, 'build.mjs'), `
result.metafile.outputs['src/unrelated.js']={bytes:0,inputs:{},imports:[],exports:[]};
await writeFile('dist/meta.json',JSON.stringify(result.metafile));
`);
  const report = await runObservation({ ...f, output: path.join(f.root, 'observed') }); assert.equal(report.status, 'incomplete');
  const task = report.tasks[0]; if (task.capture_status === 'not_run') throw new Error();
  assert.equal(task.verdict, 'pass'); assert.equal(task.bundling!.capture_status, 'incomplete');
  assert.ok(!task.bundling!.outputs.some(o => o.path.includes('unrelated'))); assert.match(task.bundling!.issues.join(' '), /outside the declared/);
  const evidence = JSON.parse(await fs.readFile(path.join(report.output, 'evidence', task.trial + '.json'), 'utf8'));
  assert.deepEqual(evidence.task.policy.filesystem.allowWrite, [path.join(evidence.roots.workspace, 'dist'), evidence.observer.collector]);
  assert.match(task.bundling!.raw_metadata_hash!, /^[a-f0-9]{64}$/);
});

test('observation settings do not invalidate ordinary narrower policies or their exported configuration', macOnly, async t => {
  const f = await bundlingFixture(t), config = JSON.parse(await fs.readFile(f.configPath, 'utf8')), limits = JSON.parse(await fs.readFile(f.limitsPath, 'utf8'));
  const scenario = config.scenarios[0]; scenario.initial_write_grants = ['@workspace/artifacts/dist'];
  scenario.observation.esbuild.output_root = '@workspace/artifacts'; scenario.observation.esbuild.metafile = '@workspace/artifacts/dist/meta.json';
  scenario.assertions[0].path = '@workspace/artifacts/dist/smoke.json';
  limits.allowed_write_roots = ['@workspace/artifacts']; limits.repetitions = 1;
  await fs.writeFile(f.configPath, JSON.stringify(config)); await fs.writeFile(f.limitsPath, JSON.stringify(limits));
  const script = path.join(f.roots.workspace, 'build.mjs'); await fs.writeFile(script, (await fs.readFile(script, 'utf8')).replaceAll('dist', 'artifacts/dist'));
  const normal = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'normal') }); assert.equal(normal.status, 'verified', normal.error);
  const replay = await loadConfiguration(path.join(normal.output, 'recommended.yaml'), f.limitsPath);
  assert.deepEqual(replay.config.scenarios[0].initial_write_grants, ['@workspace/artifacts/dist']);
  await assert.rejects(runObservation({ ...f, output: path.join(f.root, 'observed') }), /existing task write grant/);
  await assert.rejects(fs.access(path.join(f.root, 'observed')));
});
