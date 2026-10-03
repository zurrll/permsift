import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { bundledRegistry } from '../dist/test/support/bundled-registry.js';
import { manifest } from '../dist/src/filesystem.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
process.chdir(repository);
if (process.platform !== 'darwin') throw new Error('Requires the real macOS sandbox; unit tests run without it.');
const { values } = parseArgs({ options: { 'upstream-source': { type: 'string' }, 'upstream-lock': { type: 'string' } } });
if (!!values['upstream-source'] !== !!values['upstream-lock']) throw new Error('Provide both --upstream-source and --upstream-lock.');
await fs.mkdir('.permsift', { recursive: true });
const root = await fs.mkdtemp(path.join(repository, '.permsift/bundled-validation-'));
console.error(`Evidence directory: ${root}`);
const summary = { root, status: 'running', cases: [], task_executions: 0, installations: 0, candidates: 0,
  limitations: 'Engineering verification on one macOS host, no permission search or user adoption study. Parent tarball SRI is checked by npm; bundled children have no separate SRI claim.' };
const write = () => fs.writeFile(path.join(root, 'verification.json'), JSON.stringify(summary, null, 2) + '\n');
const children = new Set(), interrupt = () => { for (const child of children) child.kill('SIGINT'); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
async function cli(args, name, offline = false) {
  const started = performance.now(), stdout = await fs.open(path.join(root, name + '.stdout.json'), 'w'), stderr = await fs.open(path.join(root, name + '.stderr.log'), 'w');
  try {
    const child = spawn(process.execPath, [path.join(repository, 'dist/cli.js'), ...args, '--json'], {
      cwd: repository, env: { ...process.env, ...offline ? { PATH: '/permsift-no-external-tools' } : {} }, stdio: ['ignore', stdout.fd, stderr.fd],
    });
    children.add(child);
    const timer = setTimeout(() => child.kill('SIGINT'), 240_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); }
    finally { clearTimeout(timer); children.delete(child); }
    const duration_ms = performance.now() - started;
    assert.equal(code, 0, `CLI ${name} failed; see ${root}/${name}.stderr.log`);
    const result = JSON.parse(await fs.readFile(path.join(root, name + '.stdout.json'), 'utf8'));
    return { result, duration_ms };
  } finally { await stdout.close(); await stderr.close(); }
}
async function countReport(directory) {
  const report = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
  summary.task_executions += report.trials.filter(t => t.verdict === 'pass').length;
  summary.installations += Object.values(report.installation_stats).reduce((n, v) => n + v.executed, 0);
  summary.candidates += report.trials.filter(t => t.phase.startsWith('candidate')).length;
  return report;
}
let fixture;
try {
  fixture = await bundledRegistry({ directory: path.join(root, 'local') });
  const before = await manifest(fixture.project), baseline = path.join(root, 'run'), store = path.join(root, 'baselines');
  await cli(['run', '--config', fixture.configPath, '--limits', fixture.limitsPath, '--output', baseline], 'run');
  const run = await countReport(baseline); assert.equal(run.status, 'verified');
  const adopted = await cli(['adopt', baseline, '--config', fixture.configPath, '--limits', fixture.limitsPath, '--output', store, '--reason', 'Bundled installation verification'], 'adopt', true);
  assert.equal(adopted.result.task_executions, 0); assert.equal(adopted.result.installations, 0);
  const checkOutput = path.join(root, 'check');
  const checked = await cli(['check', '--baseline', store, '--config', fixture.configPath, '--limits', fixture.limitsPath, '--output', checkOutput], 'check');
  assert.equal(checked.result.status, 'compatible');
  const comparison = JSON.parse(await fs.readFile(path.join(checkOutput, 'report.json'), 'utf8'));
  for (const task of comparison.tasks) for (const stage of task.stages) await countReport(path.join(checkOutput, stage.report, '..'));
  const observed = path.join(root, 'observe');
  await cli(['observe', '--config', fixture.configPath, '--limits', fixture.limitsPath, '--output', observed], 'observe');
  const report = await countReport(observed), usage = JSON.parse(await fs.readFile(path.join(observed, 'usage.json'), 'utf8'));
  assert.equal(usage.status, 'observed'); assert.equal(usage.tasks[0].inventory.packages.length, 3);
  assert.equal(usage.tasks[0].loaded_packages.length, 3); assert.ok(report.trials.every(t => t.phase === 'observe'));
  assert.deepEqual(fixture.requests, ['/parent.tgz', '/parent.tgz', '/parent.tgz']);
  assert.deepEqual(await manifest(fixture.project), before);
  await fixture.close(); fixture = undefined;
  await fs.rm(path.join(root, 'local/project'), { recursive: true });
  await cli(['inspect', path.join(observed, 'usage.json'), '--package', '@scope/child'], 'inspect', true);
  summary.cases.push({ name: 'local-public-cli', run: baseline, adopted_store: store, check: checkOutput, observe: observed,
    adoption_ms: adopted.duration_ms, check_ms: checked.duration_ms, tasks: 3, installations: 3, downloaded_artifacts: 3,
    parent_tarballs_per_install: 1, bundled_instances: 2, loaded_instances: 3, original_project_unchanged: true, offline_after_project_cleanup: true });
  await write();

  if (values['upstream-source']) {
    const commit = 'eb2c439de448c779b450472e591a2bc9e37e9668', source = path.resolve(values['upstream-source']);
    const pilot = path.join(root, 'glob-parent'), project = path.join(pilot, 'project'); await fs.mkdir(project, { recursive: true });
    const archive = await promisify(execFile)('git', ['-C', source, 'archive', '--format=tar', commit], { encoding: 'buffer', maxBuffer: 8_000_000 });
    const archivePath = path.join(pilot, 'source.tar'); await fs.writeFile(archivePath, archive.stdout);
    await promisify(execFile)('/usr/bin/tar', ['-xf', archivePath, '-C', project], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const original = await manifest(project);
    await fs.copyFile(path.resolve(values['upstream-lock']), path.join(project, 'package-lock.json'));
    const input = await manifest(project);
    // Reuse the original upstream azure-pipelines task and its own xunit reporter.
    const oldConfig = parse(await fs.readFile(new URL('../examples/third-party/glob-parent/permsift.yaml', import.meta.url), 'utf8'));
    const configPath = path.join(pilot, 'config.yaml'), limitsPath = path.join(pilot, 'limits.json');
    await fs.writeFile(configPath, stringify({ ...oldConfig, project }));
    await fs.copyFile(new URL('../examples/third-party/glob-parent/limits.json', import.meta.url), limitsPath);
    const output = path.join(pilot, 'observe');
    const executed = await cli(['observe', '--config', configPath, '--limits', limitsPath, '--output', output], 'upstream');
    const execution = await countReport(output), observedUsage = JSON.parse(await fs.readFile(path.join(output, 'usage.json'), 'utf8'));
    assert.equal(observedUsage.status, 'observed'); assert.equal(execution.trials.length, 1);
    const e = JSON.parse(await fs.readFile(path.join(output, execution.trials[0].evidence), 'utf8'));
    assert.ok(e.installation.command.includes('--ignore-scripts')); assert.deepEqual(e.task.policy.network.allowedDomains, []);
    const bundled = execution.inputs.installations['upstream-tests'].bundled;
    assert.equal(bundled.packages.length, 137); assert.equal(bundled.owners.length, 1);
    assert.equal(e.installation.bundled_checks.length, 138); assert.ok(e.installation.bundled_checks.every(c => c.status === 'pass'));
    const task = observedUsage.tasks[0];
    assert.ok(task.inventory.packages.some(p => p.path === '@workspace/node_modules/nyc/node_modules/ansi-regex'));
    assert.ok(task.loaded_packages.some(p => p.path.startsWith('@workspace/node_modules/nyc/node_modules/')));
    assert.deepEqual(await manifest(project), input);
    const withoutLock = { ...input }; delete withoutLock['package-lock.json']; assert.deepEqual(withoutLock, original);
    await cli(['inspect', path.join(output, 'usage.json'), '--package', 'ansi-regex'], 'upstream-inspect', true);
    summary.cases.push({ name: 'glob-parent-5.1.2', commit, source_changes: 0, package_json_changes: 0, test_command: oldConfig.scenarios[0].command,
      additional_reporter_flags: 0, task_executions: 1, fresh_installations: 1, candidates: 0, total_ms: executed.duration_ms,
      install_ms: execution.trials[0].timings.phases.install.duration_ms, task_ms: execution.trials[0].timings.phases.task.duration_ms,
      bundled_instances: bundled.packages.length, bundled_checks: e.installation.bundled_checks.length,
      installed_instances: task.inventory.packages.length, loaded_instances: task.loaded_packages.length, assertions: e.assertions,
      input_hash: execution.inputs.snapshot_hash, report: path.join(output, 'report.json'), lock_file: path.join(project, 'package-lock.json') });
  }
  assert.equal(summary.candidates, 0); summary.status = 'verified';
} catch (error) { summary.status = 'failed'; summary.error = String(error); throw error; }
finally { if (fixture) await fixture.close(); await write(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
console.log(JSON.stringify(summary, null, 2));
