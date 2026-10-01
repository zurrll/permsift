import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { runExperiment } from '../dist/src/engine.js';
import { runRegression } from '../dist/src/regression.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
process.chdir(repository);
const { values } = parseArgs({ options: { baseline: { type: 'string' } } });
const baseline = values.baseline ? JSON.parse(await fs.readFile(values.baseline, 'utf8')) : undefined;
const root = await fs.mkdtemp(path.join(repository, '.permsift/fast-glob-profile-'));
const limitsPath = path.join(repository, 'examples/third-party/fast-glob/limits.json');
const source = path.join(repository, '.permsift/third-party/fast-glob');
const progress = message => console.error(message);
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt);
const evidence = async (r, t) => JSON.parse(await fs.readFile(path.join(r.output, t.evidence), 'utf8'));
const metrics = r => ({ status: r.status, search_complete: r.search_complete, trials: r.trials.length,
  candidates: r.trials.filter(t => t.phase.startsWith('candidate')).length,
  recoveries: r.trials.filter(t => t.phase.startsWith('recovery')).length,
  task_only_trials: r.trials.filter(t => t.installation_reused).length,
  task_only_timings: r.trials.filter(t => t.installation_reused).map(t => t.timings),
  timings: r.timings, installation_stats: r.installation_stats,
  policies: { write: r.policies, read: r.read_policies, install_write: r.install_policies, network: r.network_policies },
  inputs: r.inputs, environment: r.environment, report: path.join(r.output, 'report.json') });
let cold, warmConfig, retained;
try {
  if (baseline) warmConfig = baseline.warm_config;
  else {
    const config = parse(await fs.readFile('examples/third-party/fast-glob/permsift.yaml', 'utf8'));
    cold = await runExperiment({ mode: 'run', configPath: 'examples/third-party/fast-glob/permsift.yaml', limitsPath, output: path.join(root, 'cold'), keepWorkspaces: true, onProgress: progress, signal: controller.signal });
    retained = cold.workspaces;
    assert.equal(cold.status, 'verified', `Cold validation failed; inspect ${cold.output}/report.md`);
    const last = cold.trials.at(-1), e = await evidence(cold, last);
    const project = path.join(root, 'warm-project');
    await fs.cp(source, project, { recursive: true, filter: entry => !['.git', 'node_modules', 'out', 'reports'].includes(path.relative(source, entry).split(path.sep)[0]) });
    await fs.cp(path.join(e.roots.cache, 'npm'), path.join(project, 'seed'), { recursive: true });
    warmConfig = path.join(root, 'warm.yaml');
    await fs.writeFile(warmConfig, stringify({ ...config, project, scenarios: config.scenarios.map(s => ({ ...s, install: { ...s.install, cache: 'warm', cache_seed: '@workspace/seed' } })) }));
  }
  const warm = await runExperiment({ mode: 'tighten', configPath: warmConfig, limitsPath, output: path.join(root, 'warm'), onProgress: progress, signal: controller.signal });
  assert.equal(warm.status, 'verified', `Warm search failed; inspect ${warm.output}/report.md`);
  assert.deepEqual(warm.policies['compile-test'], ['@workspace/out', '@workspace/reports']);
  assert.deepEqual(warm.network_policies['compile-test'], []);
  assert.ok(warm.installation_stats['compile-test'].reused > 0);
  const final = warm.trials.filter(t => t.phase === 'final');
  assert.equal(final.length, 3);
  for (const t of final) { const e = await evidence(warm, t); assert.equal(t.installation_reused, false); assert.ok(e.installation.command.includes('--offline')); }
  const replay = await runExperiment({ mode: 'run', configPath: path.join(warm.output, 'recommended.yaml'), limitsPath, output: path.join(root, 'replay'), onProgress: progress, signal: controller.signal });
  assert.equal(replay.status, 'verified'); assert.equal(replay.inputs.snapshot_hash, warm.inputs.snapshot_hash);
  const check = baseline ? await runRegression({ configPath: warmConfig, limitsPath, baselinePath: path.join(warm.output, 'report.json'), output: path.join(root, 'check'), onProgress: progress, signal: controller.signal }) : undefined;
  if (check) { assert.equal(check.status, 'compatible'); assert.equal(check.trials, 3); }
  const full = await evidence(warm, final.at(-1));
  const locked = JSON.parse(await fs.readFile(path.join(source, 'package-lock.json'), 'utf8'));
  const summary = { project: 'mrmlnc/fast-glob', commit: '48687898dd26d4e935a0e5ecf6720e7c5aeac15d', locked_packages: Object.keys(locked.packages).length - 1,
    expected_upstream_unit_tests: 246, assertions: full.assertions, warm_config: warmConfig, root, cold: cold ? metrics(cold) : undefined, warm: metrics(warm), replay: metrics(replay), check: check ? { status: check.status, trials: check.trials } : undefined };
  await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  if (baseline) {
    const previous = JSON.parse(await fs.readFile(baseline.warm.report, 'utf8'));
    const matches = {
      inputs: ['snapshot_hash', 'config_hash', 'limits_hash'].every(k => warm.inputs[k] === previous.inputs[k]),
      environment: ['platform', 'release', 'arch', 'node', 'sandbox_runtime', 'npm'].every(k => warm.environment[k] === previous.environment[k]),
      policies: JSON.stringify(metrics(warm).policies) === JSON.stringify(baseline.warm.policies),
      comparisons: JSON.stringify(previous.trials.map(t => [t.phase, t.grants, t.read_grants, t.install_grants, t.network_grants, t.verdict])) === JSON.stringify(warm.trials.map(t => [t.phase, t.grants, t.read_grants, t.install_grants, t.network_grants, t.verdict])),
      search_completion: previous.search_complete === warm.search_complete,
    };
    const sum = (items, phase) => items.reduce((n, t) => n + (t?.phases[phase]?.duration_ms ?? 0), 0);
    const comparison = { matches, baseline: baseline.warm, optimized: summary.warm,
      task_manifest_ms: { baseline: sum(baseline.warm.task_only_timings, 'manifest'), optimized: sum(summary.warm.task_only_timings, 'manifest') },
      wall_reduction_percent: 100 * (1 - warm.timings.total_ms / baseline.warm.timings.total_ms),
      limitations: 'Sequential single-host observations, not a controlled CPU or filesystem-cache benchmark. Same frozen inputs, cache seed, limits and candidate comparisons are required. Timings include final fresh installs and experiment cleanup; replay/check are separate.' };
    await fs.writeFile(path.join(root, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
    for (const [name, matched] of Object.entries(matches)) assert.equal(matched, true, `Comparison mismatch: ${name}; inspect comparison.json`);
  }
  await assert.rejects(fs.access(path.join(source, 'node_modules')));
  console.log(`Evidence: ${root}/summary.json`);
  console.log(JSON.stringify({ cold: cold && metrics(cold).timings, warm: warm.timings, trials: warm.trials.length, search_complete: warm.search_complete, check: summary.check }, null, 2));
} finally { process.removeListener('SIGINT', interrupt); if (retained) await fs.rm(retained, { recursive: true, force: true }); }
