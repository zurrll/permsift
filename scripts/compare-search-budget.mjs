import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runExperiment } from '../dist/src/engine.js';

const repository = fileURLToPath(new URL('../', import.meta.url)); process.chdir(repository);
const { values } = parseArgs({ options: { baseline: { type: 'string' }, seconds: { type: 'string', default: '300' } } });
assert.ok(values.baseline, 'Pass --baseline with a medium:verify or hashes:benchmark summary.json');
const seconds = Number(values.seconds); assert.ok(Number.isInteger(seconds) && seconds >= 180 && seconds <= 1800, '--seconds must be an integer from 180 to 1800');
const input = JSON.parse(await fs.readFile(values.baseline, 'utf8'));
assert.ok(input.warm_config, 'Summary must identify its fixed warm_config');
const output = await fs.mkdtemp(path.join(repository, '.permsift/search-budget-'));
const legacy = path.join(output, 'v0.7'); await fs.mkdir(legacy);
const execute = promisify(execFile), archivePath = path.join(output, 'v0.7.tar');
const limits = JSON.parse(await fs.readFile('examples/third-party/fast-glob/limits.json', 'utf8'));
const limitsPath = path.join(output, 'limits.json'); await fs.writeFile(limitsPath, JSON.stringify({ ...limits, max_candidates: 200, budget_seconds: seconds }, null, 2));
const controller = new AbortController(), interrupt = () => controller.abort(); process.once('SIGINT', interrupt);
const reports = [];
const metrics = r => ({ version: r.environment.permsift, status: r.status, search_complete: r.search_complete, timings: r.timings,
  trials: r.trials.length, candidates: r.trials.filter(t => t.phase.startsWith('candidate')).length,
  recoveries: r.trials.filter(t => t.phase.startsWith('recovery')).length,
  policies: { write: r.policies, read: r.read_policies, install_write: r.install_policies, network: r.network_policies },
  stops: Object.fromEntries(['searches', 'read_searches', 'install_searches', 'network_searches'].map(k => [k, Object.fromEntries(Object.entries(r[k]).map(([id, s]) => [id, s.stop]))])),
  report: path.join(r.output, 'report.json') });
let referenceCommit, matches;
const save = status => fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ status, reference_commit: referenceCommit, warm_config: path.resolve(input.warm_config), limits: { ...limits, max_candidates: 200, budget_seconds: seconds }, runs: reports.map(metrics), matches,
  limitations: 'Sequential reference-then-optimized observations on one host. Equal configured time budgets, not equal candidate counts or identical actual elapsed time. Both versions reserve final fresh installations. Candidate cap is raised equally to 200; the 32-grant expression limit is unchanged. Shared-prefix comparisons are checked, not trials beyond the shorter run.' }, null, 2) + '\n');
try {
  referenceCommit = (await execute('git', ['rev-parse', '0b457b5^{commit}'], { cwd: repository })).stdout.trim();
  const archive = await execute('git', ['archive', referenceCommit], { cwd: repository, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  await fs.writeFile(archivePath, archive.stdout);
  await execute('tar', ['-xf', archivePath, '-C', legacy]); await fs.rm(archivePath);
  await fs.symlink(path.join(repository, 'node_modules'), path.join(legacy, 'node_modules'), 'dir');
  await execute(path.join(repository, 'node_modules/.bin/tsc'), [], { cwd: legacy });
  const previous = await import(pathToFileURL(path.join(legacy, 'dist/src/engine.js')).href);
  for (const [label, runner] of [['reference', previous.runExperiment], ['optimized', runExperiment]]) {
    if (controller.signal.aborted) throw new Error('Comparison interrupted');
    const report = await runner({ mode: 'tighten', configPath: path.resolve(input.warm_config), limitsPath, output: path.join(output, label), onProgress: message => console.error(`[${label}] ${message}`), signal: controller.signal });
    reports.push(report); await save('running'); assert.equal(report.status, 'verified', `Inspect ${report.output}/report.md`);
  }
  const [a, b] = reports;
  const comparable = r => r.trials.filter(t => t.phase !== 'final').map(t => [t.phase, t.grants, t.read_grants, t.install_grants, t.network_grants, t.verdict]);
  const x = comparable(a), y = comparable(b), common = Math.min(x.length, y.length);
  matches = {
    input: ['snapshot_hash', 'config_hash', 'limits_hash'].every(k => a.inputs[k] === b.inputs[k]),
    environment: ['platform', 'release', 'arch', 'node', 'npm', 'sandbox_runtime'].every(k => a.environment[k] === b.environment[k]),
    shared_prefix: JSON.stringify(x.slice(0, common)) === JSON.stringify(y.slice(0, common)), shared_prefix_trials: common,
    final_fresh: reports.every(r => r.trials.filter(t => t.phase === 'final').length === limits.repetitions && r.trials.filter(t => t.phase === 'final').every(t => t.verdict === 'pass' && t.installation_reused === false)),
  };
  await save('verified'); for (const key of ['input', 'environment', 'shared_prefix', 'final_fresh']) assert.equal(matches[key], true, key);
  console.log(`Evidence: ${output}/summary.json`); console.log(JSON.stringify(reports.map(metrics), null, 2));
} catch (error) { await save('failed'); throw error; }
finally { process.removeListener('SIGINT', interrupt); await fs.rm(legacy, { recursive: true, force: true }); await fs.rm(archivePath, { force: true }); }
