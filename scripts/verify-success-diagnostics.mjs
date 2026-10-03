import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { manifest } from '../dist/src/filesystem.js';

const repository = fileURLToPath(new URL('../', import.meta.url)); process.chdir(repository);
if (process.platform !== 'darwin') throw new Error('Requires real macOS sandbox execution. Offline diagnostics and unit tests do not.');
const { values } = parseArgs({ options: { 'with-clsx': { type: 'boolean' } } });
await fs.mkdir('.permsift', { recursive: true }); const root = await fs.mkdtemp(path.join(repository, '.permsift/success-validation-'));
console.error('Evidence directory: ' + root);
const summary = { root, status: 'running', cases: [], task_executions: 0, installations: 0, candidates: 0,
  limitations: 'One macOS host; engineering validation of specific artifact checks, not independent user benefit or overall test quality.' };
const children = new Set(), interrupt = () => { for (const child of children) child.kill('SIGINT'); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const write = () => fs.writeFile(path.join(root, 'verification.json'), JSON.stringify(summary, null, 2) + '\n');
async function cli(name, args, offline = false, expected = 0) {
  const started = performance.now(), stdout = await fs.open(path.join(root, name + '.stdout.json'), 'w'), stderr = await fs.open(path.join(root, name + '.stderr.log'), 'w');
  try {
    const child = spawn(process.execPath, [path.join(repository, 'dist/cli.js'), ...args, '--json'], { cwd: root,
      env: { ...process.env, ...offline ? { PATH: '/permsift-no-external-tools' } : {} }, stdio: ['ignore', stdout.fd, stderr.fd] });
    children.add(child); const timer = setTimeout(() => child.kill('SIGINT'), 120_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
    finally { clearTimeout(timer); children.delete(child); }
    assert.equal(code, expected, `CLI ${name} failed; see ${root}/${name}.stderr.log`);
    return { result: JSON.parse(await fs.readFile(path.join(root, name + '.stdout.json'), 'utf8')), duration_ms: performance.now() - started };
  } finally { await stdout.close(); await stderr.close(); }
}
const limits = path.join(root, 'limits.json'); await fs.writeFile(limits, JSON.stringify({ schema_version: 1, allowed_write_roots: ['@workspace', '@cache', '@tmp'], allowed_read_roots: ['@workspace'], repetitions: 1, max_candidates: 0, budget_seconds: 120 }));
async function run(name, config) {
  const configPath = path.join(root, name + '.yaml'), output = path.join(root, name + '-result'); await fs.writeFile(configPath, stringify(config));
  const executed = await cli(name + '-run', ['run', '--config', configPath, '--limits', limits, '--output', output, '--save-artifacts']);
  summary.task_executions += executed.result.trials.length;
  summary.installations += Object.values(executed.result.installation_stats).reduce((n, v) => n + v.executed, 0);
  assert.equal(executed.result.status, 'verified');
  const reportBytes = await fs.readFile(path.join(output, 'report.json'));
  const diagnosed = await cli(name + '-diagnose', ['diagnose', output, '--output', path.join(root, name + '-diagnostic')], true);
  assert.equal(diagnosed.result.status, 'diagnosed'); assert.deepEqual(await fs.readFile(path.join(output, 'report.json')), reportBytes);
  const notices = await Promise.all(executed.result.trials.map(async trial => JSON.parse(await fs.readFile(path.join(output, trial.evidence), 'utf8')).success_artifacts));
  const capture = { ...executed.result.timings.phases.artifact_capture, bytes: notices.reduce((sum, notice) => sum + (notice?.state === 'saved' ? notice.bytes : 0), 0) };
  return { output, executed, diagnosed, capture };
}
try {
  const project = path.join(root, 'demo-project'); await fs.cp(path.join(repository, 'examples/demo'), project, { recursive: true });
  const original = await manifest(project), demoConfig = parse(await fs.readFile(path.join(repository, 'examples/demo/permsift.yaml'), 'utf8'));
  const demo = await run('demo', { ...demoConfig, project });
  assert.equal(demo.diagnosed.result.tasks.length, 2);
  for (const row of demo.diagnosed.result.tasks) for (const artifact of row.artifacts) {
    assert.equal(artifact.mutations.find(m => m.kind === 'empty_file').artifact_checks_reject, true);
    assert.ok(!artifact.findings.some(s => s.includes('accept an empty readable file')));
  }
  const tests = demo.diagnosed.result.tasks.find(t => t.task === 'test').artifacts[0];
  for (const kind of ['test_failed', 'remove_expected', 'rename_expected', 'duplicate_test']) assert.equal(tests.mutations.find(m => m.kind === kind).checks[0].cause, 'content_mismatch');
  assert.equal(tests.skipped_perturbations.length, 2, 'No non-expected test is available in the original demo report');
  assert.deepEqual(await manifest(project), original); await fs.rm(project, { recursive: true });
  const moved = path.join(root, 'demo-moved'); await fs.rename(demo.output, moved);
  const movedDiagnostic = await cli('demo-moved', ['diagnose', moved], true);
  assert.equal(movedDiagnostic.result.status, 'diagnosed');
  summary.cases.push({ name: 'demo', task_executions: 2, installations: 0, original_project_unchanged: true, offline_after_project_cleanup_and_move: true,
    capture: demo.capture, diagnosis_ms: demo.diagnosed.duration_ms, source_report: moved });
  const structuredProject = path.join(root, 'structured-project'); await fs.mkdir(structuredProject);
  await fs.writeFile(path.join(structuredProject, 'task.cjs'), `const fs=require('node:fs');fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/tests.json',${JSON.stringify(JSON.stringify({ tests: [{ name: 'required', status: 'passed' }, { name: 'extra', status: 'passed' }] }))});fs.writeFileSync('reports/tests.xml','<testsuite tests="2" failures="0"><testcase classname="unit" name="required"/><testcase classname="unit" name="extra"/></testsuite>');`);
  const structured = await run('structured', { schema_version: 1, project: structuredProject, scenarios: [{ id: 'test', command: [process.execPath, 'task.cjs'], initial_write_grants: ['@workspace/reports'],
    assertions: ['test_results', 'junit'].map((type, i) => ({ type, path: '@workspace/reports/tests.' + (i ? 'xml' : 'json'), expected_tests: ['required'] })) }] });
  for (const artifact of structured.diagnosed.result.tasks[0].artifacts) {
    assert.equal(artifact.mutations.find(m => m.kind === 'unexpected_failed').checks[0].cause, 'content_mismatch');
    assert.equal(artifact.mutations.find(m => m.kind === 'remove_unexpected').artifact_checks_reject, false);
  }
  summary.cases.push({ name: 'structured-report-fixture', task_executions: 1, unexpected_test_failure_detected: true, non_expected_test_deletion_accepted: true, report_honesty_not_tested: true });
  if (values['with-clsx']) {
    const source = path.join(repository, '.permsift/third-party/clsx');
    const commit = (await promisify(execFile)('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(commit, '925494cf31bcd97d3337aacd34e659e80cae7fe2', 'Use npm run third-party:prepare first');
    assert.equal((await promisify(execFile)('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'])).stdout.trim(), '', 'Pinned source has tracked changes');
    const before = await manifest(source, ['.git']);
    const clsxConfig = parse(await fs.readFile(path.join(repository, 'examples/third-party/clsx/permsift.yaml'), 'utf8'));
    const clsx = await run('clsx', { ...clsxConfig, project: source });
    const artifacts = clsx.diagnosed.result.tasks[0].artifacts;
    const existenceOnly = artifacts.filter(a => a.assertions.every(c => c.definition.type === 'file_exists'));
    assert.equal(existenceOnly.length, 5);
    for (const artifact of existenceOnly) {
      assert.equal(artifact.mutations.find(m => m.kind === 'empty_file').artifact_checks_reject, false);
      assert.ok(artifact.findings.some(s => s.includes('accept an empty readable file')));
    }
    assert.equal(artifacts.find(a => a.path.endsWith('permsift-smoke.json')).assertions.length, 2);
    assert.deepEqual(await manifest(source, ['.git']), before);
    summary.cases.push({ name: 'pinned-clsx', commit, task_executions: 1, installations: 0, existing_prepared_dependencies: true, existence_only_empty_files_accepted: 5,
      original_build_and_eight_internal_behavior_checks_passed: true, original_project_unchanged: true, capture: clsx.capture, diagnosis_ms: clsx.diagnosed.duration_ms });
  }
  summary.status = 'verified'; await write(); console.log(JSON.stringify(summary, null, 2));
} catch (e) { summary.status = 'failed'; summary.error = String(e); await write(); throw e; }
finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
