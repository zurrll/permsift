import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { configSchema } from '../dist/src/config.js';
const repository = fileURLToPath(new URL('../', import.meta.url)); process.chdir(repository);
const { values } = parseArgs({ options: { 'large-baseline': { type: 'string' }, 'large-limits': { type: 'string' } } });
await fs.mkdir('.permsift', { recursive: true });
const root = await fs.mkdtemp(path.join(repository, '.permsift/maintenance-validation-')), runs = [];
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function cli(name, args, expected, offline = false) {
  const start = performance.now(), child = spawn(process.execPath, [path.join(repository, 'dist/cli.js'), ...args], {
    env: { ...process.env, ...offline ? { PATH: path.join(root, 'no-executables') } : {} }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; if (!offline) process.stderr.write(chunk); });
  const timer = setTimeout(() => child.kill('SIGINT'), 240_000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }).finally(() => clearTimeout(timer));
  await fs.writeFile(path.join(root, name + '.stdout'), stdout); await fs.writeFile(path.join(root, name + '.stderr'), stderr);
  runs.push({ command: args, exit_code: code, wall_ms: performance.now() - start, offline });
  assert.equal(code, expected, stderr); return JSON.parse(stdout);
}
try {
  if (values['large-baseline']) {
    if (!values['large-limits']) throw new Error('--large-limits must explicitly select trusted limits');
    const reportFile = path.resolve(values['large-baseline']), source = await json(reportFile), inputs = await json(path.join(path.dirname(reportFile), 'inputs.json'));
    const configPath = path.join(root, 'tasks.json'), limits = path.resolve(values['large-limits']);
    await fs.writeFile(configPath, JSON.stringify(inputs.config));
    const adopted = await cli('adopt', ['adopt', reportFile, '--config', configPath, '--limits', limits, '--reason', 'Reuse historical large-project verification', '--json'], 0, true);
    const checked = await cli('check', ['check', '--config', configPath, '--limits', limits, '--output', path.join(root, 'check'), '--json'], 0);
    const installationCount = (await Promise.all(checked.tasks.flatMap(t => t.stages.map(s => json(path.join(checked.output, path.dirname(s.report), 'report.json')))))).reduce((n, r) => n + Object.values(r.installation_stats).reduce((n, s) => n + s.executed, 0), 0);
    const manifest = await json(adopted.file), copiedBytes = (await Promise.all(manifest.artifacts.map(a => fs.stat(path.join(path.dirname(adopted.file), a.path))))).reduce((n, s) => n + s.size, 0);
    await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify({ status: 'passed', mode: 'large_saved_baseline', runs,
      source_report: reportFile, historical_search: { measured_ms: source.timings?.total_ms, trials: source.trials.length },
      adoption: { task_executions: 0, installations: 0, retained_files: manifest.artifacts.length, retained_bytes: copiedBytes },
      current_check: { task_executions: checked.trials, installations: installationCount, candidates: checked.candidate_count, status: checked.status, input_changed: checked.inputs.input_changed },
      limitations: ['Historical search and current check were not a controlled performance comparison.', 'This check uses the available historical project; independent users and months of maintenance remain unverified.'] }, null, 2) + '\n');
  } else {
    if (process.platform !== 'darwin') throw new Error('Maintenance story requires real macOS isolation');
    const project = path.join(root, 'project'); await fs.cp('examples/protection/project', project, { recursive: true });
    const config = configSchema.parse({ schema_version: 1, project, scenarios: [{ id: 'build', command: [process.execPath, 'build.cjs'],
      initial_write_grants: ['@workspace/dist'], initial_read_grants: ['@workspace/build.cjs', '@workspace/src'], auto_discover: false, auto_read_discover: false,
      protection_goals: [{ key: 'private', target: '@workspace/private', target_kind: 'directory', operation: 'read', stage: 'task', expected: 'denied' },
        { key: 'source', target: '@workspace/src', target_kind: 'directory', operation: 'write', stage: 'task', expected: 'denied' }],
      assertions: [{ type: 'file_exists', path: '@workspace/dist/result.json' }, { type: 'json_equals', path: '@workspace/dist/result.json', pointer: '/total', value: 36 }] }] });
    const configPath = path.join(root, 'tasks.json'), limits = path.join(repository, 'examples/protection/limits.json');
    const save = () => fs.writeFile(configPath, JSON.stringify(config)); await save();
    const initialDir = path.join(root, 'initial');
    const initial = await cli('initial', ['run', '--config', configPath, '--limits', limits, '--output', initialDir, '--json'], 0);
    const first = await cli('adopt-initial', ['adopt', initialDir, '--config', configPath, '--limits', limits, '--reason', 'Initial output-only writes', '--json'], 0, true);
    const pointer = path.join(root, '.permsift-baselines/current.json'), originalPointer = await fs.readFile(pointer, 'utf8');
    await fs.rm(initialDir, { recursive: true });
    const buildFile = path.join(project, 'build.cjs'), original = await fs.readFile(buildFile, 'utf8');
    await fs.writeFile(buildFile, original + '\n// ordinary code change\n');
    const ordinary = await cli('ordinary', ['check', '--config', configPath, '--limits', limits, '--output', path.join(root, 'ordinary'), '--json'], 0);
    await fs.writeFile(path.join(project, 'added.json'), '42'); await fs.writeFile(buildFile, "require('node:fs').readFileSync('added.json');\n" + original);
    config.scenarios[0].initial_write_grants = ['@workspace']; config.scenarios[0].initial_read_grants = ['@workspace']; await save();
    const repair = await cli('repair', ['check', '--config', configPath, '--limits', limits, '--output', path.join(root, 'repair'), '--json'], 1);
    assert.equal(repair.tasks[0].repair_stop, 'verified'); assert.equal(await fs.readFile(pointer, 'utf8'), originalPointer);
    const second = await cli('adopt-repair', ['adopt', repair.output, '--config', configPath, '--limits', limits, '--reason', 'Read added.json for the changed build', '--json'], 0, true);
    await fs.rm(repair.output, { recursive: true });
    config.scenarios[0].assertions.pop(); config.scenarios[0].protection_goals.pop(); await save();
    const changed = await cli('changed-terms', ['check', '--config', configPath, '--limits', limits, '--output', path.join(root, 'changed'), '--json'], 1);
    assert.equal(changed.status, 'review_required'); assert.equal(changed.tasks[0].current_verification, 'pass');
    const third = await cli('adopt-terms', ['adopt', changed.output, '--config', configPath, '--limits', limits, '--reason', 'Explicitly review the reduced success/protection agreement', '--json'], 0, true);
    const moved = path.join(root, 'moved-baselines'); await fs.rename(path.dirname(pointer), moved); await fs.rm(project, { recursive: true });
    const overview = await cli('inspect-moved', ['inspect', moved, '--json'], 0, true);
    assert.equal(overview.workflow.reported_status, 'adopted'); assert.equal(overview.tasks[0].claims.find(c => c.dimension === 'current_validation').status, 'not_run');
    await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify({ status: 'passed', mode: 'public_cli_story', environment: { platform: process.platform, release: os.release(), node: process.version },
      runs, task_executions: initial.trials.length + ordinary.trials + repair.trials + changed.trials, installations: 0,
      adopted_ids: [first.id, second.id, third.id], limitations: ['One local story; long-term benefit and independent user understanding remain unverified.'] }, null, 2) + '\n');
  }
  console.log('Maintenance evidence: ' + path.join(root, 'verification.json'));
} catch (error) { await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify({ status: 'failed', error: String(error), runs }, null, 2) + '\n'); throw error; }
