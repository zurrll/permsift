import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runExperiment } from '../../src/engine.js';

const macOnly = { skip: process.platform !== 'darwin' ? 'Requires real macOS sandbox-exec; no mock substitute' : false };
async function fixture(t: TestContext, script: string, writes = ['@workspace', '@cache'], timeout = 10) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-integration-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'task.cjs'), script);
  await fs.writeFile(path.join(root, 'tasks.json'), JSON.stringify({ schema_version: 1, project: './project', scenarios: [{ id: 'build', command: [process.execPath, 'task.cjs'], timeout_seconds: timeout, auto_discover: false, initial_write_grants: writes, narrower_candidates: [{ from: '@workspace', to: ['@workspace/dist'] }], assertions: [{ type: 'file_contains', path: '@workspace/dist/out', text: 'fresh' }] }] }));
  await fs.writeFile(path.join(root, 'limits.json'), JSON.stringify({ schema_version: 1, allowed_write_roots: ['@workspace', '@cache'], repetitions: 1, budget_seconds: 120 }));
  return { root, project, configPath: path.join(root, 'tasks.json'), limitsPath: path.join(root, 'limits.json') };
}
const writer = "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out','fresh');";

test('real backend tightens writes, refuses necessary deletion and replays exported policy', macOnly, async t => {
  const f = await fixture(t, writer);
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified', report.error);
  assert.deepEqual(report.policies.build, ['@workspace/dist']);
  assert.ok(report.searches.build.steps.some(s => s.decision === 'rejected' && s.recovery_id));
  const evidence = JSON.parse(await fs.readFile(path.join(report.output, report.trials[0].evidence), 'utf8'));
  assert.ok(evidence.after.checks.every((c: {status:string}) => c.status === 'pass'));
  assert.ok(evidence.task.effective.write);
  await assert.rejects(fs.access(path.join(f.project, 'dist')), 'Original project must stay untouched');
  const replay = await runExperiment({ mode: 'run', configPath: path.join(report.output, 'recommended.yaml'), limitsPath: f.limitsPath, output: path.join(f.root, 'replay') });
  assert.equal(replay.status, 'verified', replay.error);
});
test('stale artifact and zero exit code cannot make a task pass', macOnly, async t => {
  const f = await fixture(t, 'process.exit(0)', []);
  await fs.mkdir(path.join(f.project, 'dist')); await fs.writeFile(path.join(f.project, 'dist/out'), 'fresh');
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'failed'); assert.equal(report.baseline_verified, false);
  assert.equal(Object.keys(report.searches).length, 0);
  await assert.rejects(fs.access(path.join(report.output, 'recommended.yaml')));
});
test('input symlink outside the project aborts before running any task', macOnly, async t => {
  const f = await fixture(t, writer);
  await fs.writeFile(path.join(f.root, 'fake-secret'), 'fake');
  await fs.symlink('../fake-secret', path.join(f.project, 'escape'));
  const report = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'incomplete'); assert.equal(report.trials.length, 0); assert.match(report.error!, /External symlink/);
});
test('real sandbox denies a child process writing outside its scope', macOnly, async t => {
  const f = await fixture(t, writer);
  const target = path.join(f.root, 'outside'); await fs.writeFile(target, 'original');
  await fs.writeFile(path.join(f.project, 'task.cjs'), `const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(target)},'tampered')`)}]);if(r.status===0)process.exit(9);${writer}`);
  const report = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified'); assert.equal(await fs.readFile(target, 'utf8'), 'original');
});
test('task timeout produces unknown evidence rather than a successful policy', macOnly, async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000)', ['@workspace'], 1);
  const report = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'incomplete'); assert.equal(report.trials[0].verdict, 'unknown');
  const evidence = JSON.parse(await fs.readFile(path.join(report.output, report.trials[0].evidence), 'utf8'));
  assert.equal(evidence.task.process.status, 'timed_out');
});
test('candidate budget can stop search while final validation still verifies the unchanged policy', macOnly, async t => {
  const f = await fixture(t, writer);
  const limits = JSON.parse(await fs.readFile(f.limitsPath, 'utf8')); limits.max_candidates = 0;
  await fs.writeFile(f.limitsPath, JSON.stringify(limits));
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified'); assert.equal(report.final_verified, true);
  assert.equal(report.search_complete, false); assert.equal(report.searches.build.stop, 'budget');
  assert.ok(report.trials.every(t => t.phase !== 'candidate'));
});
test('overall time budget cannot produce a verified candidate after an unfinished task', macOnly, async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000)');
  const limits = JSON.parse(await fs.readFile(f.limitsPath, 'utf8')); limits.budget_seconds = 1;
  await fs.writeFile(f.limitsPath, JSON.stringify(limits));
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'incomplete'); assert.equal(report.final_verified, false);
  await assert.rejects(fs.access(path.join(report.output, 'recommended.yaml')));
});
test('CLI interruption preserves an incomplete report and exits 130', macOnly, async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000)');
  const output = path.join(f.root, 'result');
  const child = spawn(process.execPath, ['dist/cli.js', 'run', '--config', f.configPath, '--limits', f.limitsPath, '--output', output], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let timer: NodeJS.Timeout | undefined;
  child.stderr.once('data', () => { timer = setTimeout(() => child.kill('SIGINT'), 300); });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 15000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer); clearTimeout(watchdog);
  assert.equal(code, 130);
  const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  assert.equal(report.status, 'incomplete'); assert.match(report.error, /interrupted/);
});
test('automatic search discovers workspace/cache/temporary scopes without manual hints and explains recovery', macOnly, async t => {
  const script = `${writer}const p=require('node:path');const cache=p.join(process.env.XDG_CACHE_HOME,'compiler');const tmp=p.join(require('node:os').tmpdir(),'jobs');for(const d of [cache,tmp])fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(cache,'state'),'compiled');fs.writeFileSync(p.join(tmp,'transient'),'work');fs.unlinkSync(p.join(tmp,'transient'));`;
  const f = await fixture(t, script, ['@workspace', '@cache', '@tmp']);
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8')); config.scenarios[0].auto_discover = true; delete config.scenarios[0].narrower_candidates;
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const limits = JSON.parse(await fs.readFile(f.limitsPath, 'utf8')); limits.allowed_write_roots.push('@tmp');
  await fs.writeFile(f.limitsPath, JSON.stringify(limits));
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified', JSON.stringify(report.trials.at(-1)?.diagnosis)); assert.equal(report.search_complete, true);
  assert.deepEqual(report.policies.build, ['@cache/compiler', '@tmp/jobs', '@workspace/dist']);
  assert.ok(report.trials.some(t => t.phase === 'discovery_baseline'));
  assert.ok(report.searches.build.steps.some(s => s.source === 'directory_structure' && s.decision === 'accepted'));
  const rejected = report.searches.build.steps.find(s => s.operation === 'remove @tmp/jobs')!;
  const trial = report.trials.find(t => t.id === rejected.trial_id)!;
  assert.equal(trial.diagnosis?.kind, 'permission_denial_observed');
  assert.ok(trial.diagnosis?.denials.some(d => d.path === '@tmp/jobs/transient'));
  assert.equal(report.trials.find(t => t.id === rejected.recovery_id)?.verdict, 'pass');
  const markdown = await fs.readFile(path.join(report.output, 'report.md'), 'utf8');
  assert.match(markdown, /Restored-policy recovery: \*\*pass\*\*/); assert.match(markdown, /@tmp\/jobs\/transient/);
  const baseline = JSON.parse(await fs.readFile(path.join(report.output, report.trials[0].evidence), 'utf8'));
  assert.deepEqual(baseline.file_changes_by_root.tmp.added, []);
  assert.ok(baseline.discovery_observation.directories.includes('@tmp/jobs'));
  const replay = await runExperiment({ mode: 'run', configPath: path.join(report.output, 'recommended.yaml'), limitsPath: f.limitsPath, output: path.join(f.root, 'replay') });
  assert.equal(replay.status, 'verified');
});
test('real Node JUnit reporter is validated, stale XML is removed, and skipped tests fail', macOnly, async t => {
  const f = await fixture(t, writer);
  await fs.writeFile(path.join(f.project, 'checks.test.cjs'), "const test=require('node:test');const assert=require('node:assert/strict');test('real case',()=>assert.equal(2+2,4));");
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  config.scenarios[0] = { id: 'test', command: [process.execPath, '--test', '--test-reporter=junit', '--test-reporter-destination=reports/junit.xml', 'checks.test.cjs'], initial_write_grants: ['@workspace'], assertions: [{ type: 'junit', path: '@workspace/reports/junit.xml', expected_tests: ['real case'] }] };
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified', report.error); assert.deepEqual(report.policies.test, ['@workspace/reports']);
  await fs.writeFile(path.join(f.project, 'checks.test.cjs'), "require('node:test')('real case',{skip:true},()=>{});");
  const skipped = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'skipped') });
  assert.equal(skipped.status, 'failed'); assert.equal(skipped.trials[0].diagnosis?.kind, 'assertion_failure');
  await fs.mkdir(path.join(f.project, 'reports')); await fs.writeFile(path.join(f.project, 'reports/junit.xml'), '<testsuite><testcase name="real case"/></testsuite>');
  config.exclude = ['.git', '.permsift']; config.scenarios[0].command = [process.execPath, '-e', 'process.exit(0)'];
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const stale = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'stale') });
  assert.equal(stale.status, 'failed'); assert.ok(stale.trials[0].diagnosis?.failed_assertions.length);
});
test('changed automatic preparation must pass a new baseline before policy search', macOnly, async t => {
  const f = await fixture(t, `${writer}if(fs.existsSync('scratch'))process.exit(7);fs.mkdirSync('scratch');`);
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8')); config.scenarios[0].auto_discover = true; config.scenarios[0].narrower_candidates = [];
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'failed'); assert.equal(report.baseline_verified, false);
  assert.ok(report.trials.some(t => t.phase === 'discovery_baseline' && t.verdict === 'fail'));
  assert.equal(Object.keys(report.searches).length, 0);
});
test('export preserves automatic preparation even when its directory no longer needs a write grant', macOnly, async t => {
  const script = `${writer}const p=require('node:path');const cache=p.join(process.env.XDG_CACHE_HOME,'optional');if(!fs.existsSync(cache))fs.mkdirSync(cache);`;
  const f = await fixture(t, script);
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8')); config.scenarios[0].auto_discover = true; config.scenarios[0].narrower_candidates = [];
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified'); assert.deepEqual(report.policies.build, ['@workspace/dist']);
  const exported = await fs.readFile(path.join(report.output, 'recommended.yaml'), 'utf8');
  assert.match(exported, /@cache\/optional/);
  const replay = await runExperiment({ mode: 'run', configPath: path.join(report.output, 'recommended.yaml'), limitsPath: f.limitsPath, output: path.join(f.root, 'replay') });
  assert.equal(replay.status, 'verified', JSON.stringify(replay.trials.at(-1)?.diagnosis));
});
