import { assertNativeEvidence } from '../support/native-evidence.js';
import { assertSummary } from '../support/result-summary.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
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
  await assertNativeEvidence(report);
  const overview = await assertSummary(report.output);
  assert.equal(overview.analysis.status, 'complete');
  assert.ok(overview.tasks[0].decisions.some(d => d.reported_decision === 'rejected' && d.support === 'corroborated' && d.recovery === 'pass'));
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
test('a real index write failure stops the workflow with recoverable trial artifacts and no next execution', macOnly, async t => {
  const f = await fixture(t, writer), output = path.join(f.root, 'result');
  let attempts = 0;
  const report = await runExperiment({ ...f, mode: 'tighten', output, onProgress: () => {
    attempts++; mkdirSync(path.join(output, 'executions/index.json'));
  } });
  assert.equal(report.status, 'incomplete'); assert.match(report.error!, /EISDIR/);
  assert.equal(attempts, 1); assert.equal(report.trials.length, 0); assert.equal(report.final_verified, false);
  const files = await fs.readdir(path.join(output, 'evidence')); assert.equal(files.filter(f => f.endsWith('.json')).length, 1);
  const evidence = JSON.parse(await fs.readFile(path.join(output, 'evidence', files[0]), 'utf8'));
  const facts = JSON.parse(await fs.readFile(path.join(output, 'executions', evidence.id + '.json'), 'utf8'));
  assert.equal(evidence.summary.verdict, 'pass'); assert.equal(facts.execution.outcomes.task.status, 'pass');
  await assert.rejects(fs.access(path.join(output, 'recommended.yaml')));
  await assert.rejects(fs.access(path.join(f.project, 'dist')));
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
  const facts = (await assertNativeEvidence(report))[0];
  assert.equal(facts.execution.outcomes.task.status, 'unknown');
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

async function enableReads(f: Awaited<ReturnType<typeof fixture>>, grants = ['@workspace']) {
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  config.scenarios[0].initial_read_grants = grants;
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const limits = JSON.parse(await fs.readFile(f.limitsPath, 'utf8'));
  limits.allowed_read_roots = ['@workspace']; limits.max_candidates = 100;
  await fs.writeFile(f.limitsPath, JSON.stringify(limits));
}

test('real read search keeps exact necessary files, denies fake neighboring secrets and replays combined policy', macOnly, async t => {
  const f = await fixture(t, `const input=JSON.parse(require('node:fs').readFileSync('src/input.json','utf8'));if(input.value!==42)process.exit(5);${writer}`);
  await fs.mkdir(path.join(f.project, 'src'));
  await fs.writeFile(path.join(f.project, 'src/input.json'), '{"value":42}');
  await fs.writeFile(path.join(f.project, 'src/unused.json'), '{"fake":true}');
  await fs.writeFile(path.join(f.project, 'unused.txt'), 'not needed');
  await enableReads(f);
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified', JSON.stringify(report.trials.at(-1)?.diagnosis));
  assert.equal(report.search_complete, true);
  assert.deepEqual(report.read_policies.build, ['@workspace/src/input.json', '@workspace/task.cjs']);
  assert.deepEqual(report.policies.build, ['@workspace/dist']);
  assert.ok(report.read_searches.build.steps.some(s => s.decision === 'rejected' && s.recovery_id && s.operation.includes('src/input.json')));
  for (const phase of ['baseline', 'final']) {
    const trial = report.trials.find(t => t.phase === phase)!;
    const evidence = JSON.parse(await fs.readFile(path.join(report.output, trial.evidence), 'utf8'));
    const checks = evidence.after.checks.filter((c: {name:string}) => c.name.startsWith('read_scope:'));
    assert.equal(checks.length, 2); assert.ok(checks.every((c: {status:string}) => c.status === 'pass'));
    assert.ok(checks.every((c: {detail:string}) => c.detail.includes(phase === 'baseline' ? 'expected allowed' : 'expected denied')));
    assert.ok(evidence.task.policy.filesystem.denyRead.every((p: string) => !p.includes('.permsift-read-')));
  }
  await assert.rejects(fs.access(path.join(f.project, '.permsift-read-checks')));
  const replay = await runExperiment({ mode: 'run', configPath: path.join(report.output, 'recommended.yaml'), limitsPath: f.limitsPath, output: path.join(f.root, 'replay') });
  assert.equal(replay.status, 'verified'); assert.deepEqual(replay.read_policies.build, report.read_policies.build);
  assert.equal(replay.inputs.snapshot_hash, report.inputs.snapshot_hash);
});

test('real write permission does not imply read access; empty project read grants work for inline commands', macOnly, async t => {
  const f = await fixture(t, `const fs=require('node:fs');try{fs.readFileSync('hidden.txt');process.exit(9);}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out','fresh');`);
  await fs.writeFile(path.join(f.project, 'hidden.txt'), 'fake-secret');
  await enableReads(f, ['@workspace/task.cjs']);
  const report = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified', JSON.stringify(report.trials[0].diagnosis));
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  config.scenarios[0].command = [process.execPath, '-e', writer]; config.scenarios[0].initial_read_grants = [];
  await fs.writeFile(f.configPath, JSON.stringify(config));
  const empty = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'empty') });
  assert.equal(empty.status, 'verified', JSON.stringify(empty.trials[0].diagnosis));
  assert.deepEqual(empty.read_policies.build, []);
  const overview = await assertSummary(empty.output);
  assert.match(overview.tasks[0].claims.find(c => c.dimension === 'policy')!.statement, /reads \(explicit\): \(none\)/);
});

test('joint search revisits writes after removing optional read access changes task behavior', macOnly, async t => {
  const f = await fixture(t, `${writer}let optional=false;try{optional=fs.readFileSync('feature.txt','utf8')==='enabled'}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}if(optional)fs.writeFileSync(require('node:path').join(process.env.XDG_CACHE_HOME,'optional-state'),'used');`);
  await fs.writeFile(path.join(f.project, 'feature.txt'), 'enabled');
  await enableReads(f);
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified', JSON.stringify(report.trials.at(-1)?.diagnosis));
  assert.equal(report.search_complete, true);
  assert.deepEqual(report.read_policies.build, ['@workspace/task.cjs']);
  assert.deepEqual(report.policies.build, ['@workspace/dist']);
  const cacheSteps = report.searches.build.steps.filter(s => s.operation === 'remove @cache');
  assert.ok(cacheSteps.some(s => s.decision === 'rejected'));
  assert.equal(cacheSteps.at(-1)?.decision, 'accepted');
});

test('nonexistent or symlink read targets are setup errors and never widen into permissive defaults', macOnly, async t => {
  const f = await fixture(t, writer);
  await enableReads(f, ['@workspace/missing.cjs']);
  const missing = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'missing') });
  assert.equal(missing.status, 'incomplete'); assert.equal(missing.trials[0].verdict, 'unknown');
  await assert.rejects(fs.access(path.join(missing.output, 'recommended.yaml')));
  await fs.symlink('task.cjs', path.join(f.project, 'linked.cjs'));
  await enableReads(f, ['@workspace/linked.cjs']);
  const linked = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'linked') });
  assert.equal(linked.status, 'incomplete'); assert.match(linked.trials[0].reason!, /symlink/i);
});

test('a granted file replaced by a directory never becomes recursive read permission in task or post probes', macOnly, async t => {
  const f = await fixture(t, writer);
  await fs.writeFile(path.join(f.project, 'input'), 'fake');
  const config = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  config.scenarios[0].command = [process.execPath, '-e', `const fs=require('node:fs');fs.unlinkSync('input');fs.mkdirSync('input');fs.writeFileSync('input/child','fake');try{fs.readFileSync('input/child');process.exit(9)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out','fresh');`];
  await fs.writeFile(f.configPath, JSON.stringify(config));
  await enableReads(f, ['@workspace/input']);
  const report = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified', JSON.stringify(report.trials[0].diagnosis));
  const evidence = JSON.parse(await fs.readFile(path.join(report.output, report.trials[0].evidence), 'utf8'));
  assert.deepEqual(evidence.read_grant_kinds, { '@workspace/input': 'file' });
  assert.deepEqual(evidence.before.execution.policy.filesystem.allowRead, evidence.task.policy.filesystem.allowRead);
  assert.deepEqual(evidence.after.execution.policy.filesystem.allowRead, evidence.task.policy.filesystem.allowRead);
});

test('real sandbox batches unused inputs, restores rejected groups and checks the final exact file scope', macOnly, async t => {
  const f = await fixture(t, writer);
  for (let i = 0; i < 16; i++) await fs.writeFile(path.join(f.project, `unused-${String(i).padStart(2, '0')}.txt`), 'fake unused input');
  await enableReads(f);
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified', JSON.stringify(report.trials.at(-1)?.diagnosis));
  assert.equal(report.search_complete, true);
  assert.deepEqual(report.read_policies.build, ['@workspace/task.cjs']);
  const groups = report.read_searches.build.steps.filter(s => s.source === 'group_removal');
  assert.ok(groups.some(s => s.decision === 'accepted' && s.removed_grants!.length > 1));
  assert.ok(groups.some(s => s.decision === 'rejected' && report.trials.find(t => t.id === s.recovery_id)?.verdict === 'pass'));
  assert.ok(report.trials.filter(t => t.phase === 'candidate_read').length < 20);
  const search = report.read_searches.build;
  assert.ok(search.reuses.length);
  for (const reuse of search.reuses) {
    const previous = report.trials.find(t => t.id === reuse.failed_trial_id)!;
    assert.equal(previous.verdict, 'fail'); assert.deepEqual(previous.read_grants, reuse.after);
    const failure = search.steps.find(s => s.trial_id === previous.id)!;
    assert.equal(report.trials.find(t => t.id === failure.recovery_id)?.verdict, 'pass');
  }
  const necessary = search.steps.find(s => s.round === search.rounds && s.operation === 'remove @workspace/task.cjs')!;
  assert.equal(necessary.decision, 'rejected'); assert.deepEqual(necessary.before, report.read_policies.build);
  const final = report.trials.find(t => t.phase === 'final')!;
  const evidence = JSON.parse(await fs.readFile(path.join(report.output, final.evidence), 'utf8'));
  assert.ok(evidence.before.checks.every((c: {status:string}) => c.status === 'pass'));
  assert.ok(evidence.after.checks.every((c: {status:string}) => c.status === 'pass'));
  const replay = await runExperiment({ mode: 'run', configPath: path.join(report.output, 'recommended.yaml'), limitsPath: f.limitsPath, output: path.join(f.root, 'replay') });
  assert.equal(replay.status, 'verified');
});

test('joint search revisits reads when a subsequent write change makes another input optional', macOnly, async t => {
  const f = await fixture(t, `${writer}
const cache=require('node:path').join(process.env.XDG_CACHE_HOME,'state');
let feature=false;try{feature=fs.readFileSync('a-feature.txt','utf8')==='enabled'}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}
if(feature){fs.writeFileSync(cache,'required');}else{
  let writable=false;try{fs.writeFileSync(cache,'probe');writable=true}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;}
  if(writable && fs.readFileSync('z-cache-info.txt','utf8')!=='valid')process.exit(8);
}`);
  await fs.writeFile(path.join(f.project, 'a-feature.txt'), 'enabled');
  await fs.writeFile(path.join(f.project, 'z-cache-info.txt'), 'valid');
  await enableReads(f, ['@workspace/a-feature.txt', '@workspace/task.cjs', '@workspace/z-cache-info.txt']);
  const report = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'result') });
  assert.equal(report.status, 'verified', JSON.stringify(report.trials.at(-1)?.diagnosis));
  assert.equal(report.search_complete, true);
  assert.deepEqual(report.policies.build, ['@workspace/dist']);
  assert.deepEqual(report.read_policies.build, ['@workspace/task.cjs']);
  const input = report.read_searches.build.steps.filter(s => s.operation === 'remove @workspace/z-cache-info.txt');
  assert.ok(input.some(s => s.decision === 'rejected')); assert.equal(input.at(-1)?.decision, 'accepted');
  assert.ok(input[0].round < input.at(-1)!.round);
});
