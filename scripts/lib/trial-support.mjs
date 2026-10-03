import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

export const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const digest = async file => sha256(await fs.readFile(file));
export const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');

// Keep failed calls and their logs. Counts come from retained execution evidence,
// not from whether the parent command exited successfully.
export async function command(receipt, root, name, executable, argv, options = {}) {
  const started = performance.now();
  const env = { ...process.env, ...options.env };
  delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const child = spawn(executable, argv, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', launchError;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; if (!options.quiet) process.stderr.write(chunk); });
  child.on('error', e => { launchError = String(e); });
  let timedOut = false, hardTimer;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGINT'); hardTimer = setTimeout(() => child.kill('SIGKILL'), 5000); }, options.timeout ?? 240_000);
  const code = await new Promise(resolve => child.on('close', resolve));
  clearTimeout(timer); clearTimeout(hardTimer);
  await fs.writeFile(path.join(root, name + '.stdout'), stdout);
  await fs.writeFile(path.join(root, name + '.stderr'), stderr);
  const step = { name, executable, argv, exit_code: code, wall_ms: performance.now() - started,
    ...(options.cwd ? { cwd: options.cwd } : {}), ...(timedOut ? { timed_out: true } : {}), ...(launchError ? { launch_error: launchError } : {}) };
  receipt.steps.push(step); await writeJson(path.join(root, 'verification.json'), receipt);
  return { code, stdout, stderr, step };
}

export async function cli(receipt, root, repository, name, argv, options = {}) {
  const r = await command(receipt, root, name, process.execPath, [path.join(repository, 'dist/cli.js'), ...argv, '--json'],
    { cwd: repository, ...options, env: { ...options.env, ...options.offline ? { PATH: '/permsift-no-external-tools' } : {} } });
  // Count completed/failed attempts, including child reports inside check.
  const output = argv.includes('--output') ? argv[argv.indexOf('--output') + 1] : undefined;
  if (output && ['run', 'observe', 'check'].includes(argv[0])) {
    try {
      const report = await json(path.join(output, 'report.json'));
      const reports = report.kind === 'regression' ? await Promise.all(report.tasks.flatMap(t => t.stages.map(s => json(path.resolve(output, path.dirname(s.report), 'report.json'))))) : [report];
      const counts = { trials: 0, task_executions: 0, installations: 0, install_ms: 0, task_ms: 0, protection_ms: 0 };
      for (const report of reports) for (const trial of report.trials) {
        const evidence = await json(path.join(report.output, trial.evidence));
        counts.trials++;
        counts.installations += Number(!!evidence.installation || !!trial.timings?.phases.install?.calls);
        counts.task_executions += Number(!!evidence.task || !!trial.timings?.phases.task?.calls);
        counts.install_ms += trial.timings?.phases.install?.duration_ms ?? 0;
        counts.task_ms += trial.timings?.phases.task?.duration_ms ?? 0;
        counts.protection_ms += trial.timings?.phases.protections?.duration_ms ?? 0;
      }
      r.step.execution = counts;
    } catch (e) { r.step.execution_counts_unavailable = String(e); }
    await writeJson(path.join(root, 'verification.json'), receipt);
  }
  assert.equal(r.code, options.expected ?? 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

export function totals(steps) {
  const counts = { trials: 0, task_executions: 0, installations: 0, install_ms: 0, task_ms: 0, protection_ms: 0 };
  for (const step of steps) if (step.execution) for (const key of Object.keys(counts)) counts[key] += step.execution[key];
  return { ...counts, incomplete_counts: steps.filter(s => s.execution_counts_unavailable).map(s => s.name) };
}

// Only ordinary files from an explicit source list may enter the trial bundle.
export async function sourceManifest(repository, files) {
  const result = [], realRoot = await fs.realpath(repository);
  for (const file of [...new Set(files)].sort()) {
    assert.ok(file && !path.isAbsolute(file) && !file.split('/').some(p => ['..', '.', '.git', '.permsift', 'node_modules', 'dist', 'coverage'].includes(p)), 'Excluded or unsafe source path: ' + file);
    assert.notEqual(file, 'TRIAL-MANIFEST.json');
    const absolute = path.join(repository, file), stat = await fs.lstat(absolute);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Trial source must be an ordinary file: ' + file);
    assert.equal(await fs.realpath(absolute), path.join(realRoot, file), 'Trial source has a linked path component: ' + file);
    result.push({ path: file, sha256: await digest(absolute), bytes: stat.size, mode: stat.mode & 0o777 });
  }
  return result;
}

export async function verifySource(repository, manifest) {
  assert.deepEqual(await sourceManifest(repository, manifest.files.map(f => f.path)), manifest.files, 'Trial source differs from its manifest');
  assert.equal(sha256(JSON.stringify(manifest.files)), manifest.source_sha256);
}
