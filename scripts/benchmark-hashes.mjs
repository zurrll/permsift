import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { runExperiment } from '../dist/src/engine.js';
import { snapshotHash } from '../dist/src/filesystem.js';
import { referenceHash } from '../dist/test/support/reference-hash.js';

const repository = fileURLToPath(new URL('../', import.meta.url)); process.chdir(repository);
const { values } = parseArgs({ options: { baseline: { type: 'string' } } });
const baseline = values.baseline ? JSON.parse(await fs.readFile(values.baseline, 'utf8')) : undefined;
await fs.mkdir('.permsift', { recursive: true });
const output = await fs.mkdtemp(path.join(repository, '.permsift/hash-benchmark-'));
const controller = new AbortController(), interrupt = () => controller.abort(); process.once('SIGINT', interrupt);
const retained = [], scans = [];
let warmConfig, installations, restrictedInstallations;
const save = status => fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ status, warm_config: warmConfig, scans, installations, restricted_installations: restrictedInstallations,
  limitations: 'Sequential single-host diagnostic observations; operation service durations overlap and are not CPU time. Reinstall equality covers content, relative internal links and POSIX modes, not timestamps, ACLs or all possible future installs. Diagnostic pre-task scans add work and are excluded from production search performance comparisons.' }, null, 2) + '\n');
try {
  if (baseline) warmConfig = path.resolve(baseline.warm_config);
  else {
    const original = parse(await fs.readFile('examples/third-party/fast-glob/permsift.yaml', 'utf8'));
    const limits = JSON.parse(await fs.readFile('examples/third-party/fast-glob/limits.json', 'utf8'));
    const coldLimits = path.join(output, 'cold-limits.json'); await fs.writeFile(coldLimits, JSON.stringify({ ...limits, repetitions: 1 }));
    const cold = await runExperiment({ mode: 'run', configPath: 'examples/third-party/fast-glob/permsift.yaml', limitsPath: coldLimits, output: path.join(output, 'cold'), keepWorkspaces: true, onProgress: console.error, signal: controller.signal });
    if (cold.workspaces) retained.push(cold.workspaces);
    assert.equal(cold.status, 'verified');
    const evidence = JSON.parse(await fs.readFile(path.join(cold.output, cold.trials.at(-1).evidence), 'utf8'));
    const source = path.join(repository, '.permsift/third-party/fast-glob'), project = path.join(output, 'warm-project');
    await fs.cp(source, project, { recursive: true, filter: p => !['.git', 'node_modules', 'out', 'reports'].includes(path.relative(source, p).split(path.sep)[0]) });
    await fs.cp(path.join(evidence.roots.cache, 'npm'), path.join(project, 'seed'), { recursive: true });
    warmConfig = path.join(output, 'warm.yaml');
    await fs.writeFile(warmConfig, stringify({ ...original, project, scenarios: original.scenarios.map(s => ({ ...s, install: { ...s.install, cache: 'warm', cache_seed: '@workspace/seed' } })) }));
  }
  const warm = await runExperiment({ mode: 'run', configPath: warmConfig, limitsPath: 'examples/third-party/fast-glob/limits.json', output: path.join(output, 'warm'), keepWorkspaces: true, measureInstalledState: true, onProgress: console.error, signal: controller.signal });
  if (warm.workspaces) retained.push(warm.workspaces);
  assert.equal(warm.status, 'verified'); assert.equal(warm.trials.length, 3);
  const evidence = await Promise.all(warm.trials.map(t => fs.readFile(path.join(warm.output, t.evidence), 'utf8').then(JSON.parse)));
  const states = evidence.map(e => e.installation_state);
  const differences = states.slice(1).map((s, index) => ({ trial: warm.trials[index + 1].id, roots: Object.fromEntries(['workspace', 'cache', 'tmp'].map(root => {
    const a = states[0].files[root], b = s.files[root];
    return [root, { hash_equal: s.hashes[root] === states[0].hashes[root], added: Object.keys(b).filter(p => !(p in a)), removed: Object.keys(a).filter(p => !(p in b)), changed: Object.keys(a).filter(p => p in b && a[p] !== b[p]) }];
  })) }));
  installations = { policy_condition: 'initial', install_write_policy: warm.install_policies, trials: warm.trials.map(t => t.id), hashes: states.map(s => s.hashes), differences, report: path.join(warm.output, 'report.json'),
    observation_point: 'Successful install, stage directory preparation and output refresh, before task read fixtures, offline task probes and command.' };
  // A medium:verify baseline also supplies reviewed, fully validated final rules.
  // Observe those separately: permissions themselves can suppress variable logs/caches.
  if (baseline?.warm?.report) {
    const recommended = path.join(path.dirname(baseline.warm.report), 'recommended.yaml');
    const restricted = await runExperiment({ mode: 'run', configPath: recommended, limitsPath: 'examples/third-party/fast-glob/limits.json', output: path.join(output, 'restricted'), measureInstalledState: true, onProgress: console.error, signal: controller.signal });
    assert.equal(restricted.status, 'verified'); assert.equal(restricted.trials.length, 3);
    assert.equal(restricted.inputs.snapshot_hash, warm.inputs.snapshot_hash, 'Both policy conditions must use the same frozen project');
    const observed = await Promise.all(restricted.trials.map(t => fs.readFile(path.join(restricted.output, t.evidence), 'utf8').then(JSON.parse)));
    const hashes = observed.map(e => e.installation_state.hashes);
    restrictedInstallations = { policy_condition: 'verified-recommended', install_write_policy: restricted.install_policies, hashes,
      equal_by_root: Object.fromEntries(['workspace', 'cache', 'tmp'].map(name => [name, hashes.every(h => h[name] === hashes[0][name])])),
      report: path.join(restricted.output, 'report.json'), observation_point: installations.observation_point };
  }
  await save('running');
  const small = path.join(output, 'small'); await fs.mkdir(small);
  for (let d = 0; d < 8; d++) { const dir = path.join(small, `dir-${d}`); await fs.mkdir(dir); for (let f = 0; f < 32; f++) await fs.writeFile(path.join(dir, `file-${f}`), Buffer.alloc(4096, f)); }
  await fs.writeFile(path.join(small, 'large'), Buffer.alloc(2 * 1024 * 1024, 51)); await fs.symlink('dir-0/file-0', path.join(small, 'link'));
  const fixtures = { small: { workspace: small }, installed: evidence.at(-1).roots };
  for (const [fixture, roots] of Object.entries(fixtures)) {
    let expected;
    const orders = [['reference', 'bounded-4', 'bounded-8'], ['bounded-8', 'bounded-4', 'reference'], ['bounded-4', 'reference', 'bounded-8']];
    for (let repetition = 0; repetition < orders.length; repetition++) for (const algorithm of orders[repetition]) {
      const started = performance.now(), hashes = {}, profiles = {};
      for (const [name, directory] of Object.entries(roots)) {
        const options = { signal: controller.signal, onProfile: p => { profiles[name] = p; } };
        if (controller.signal.aborted) throw new Error('Benchmark interrupted');
        hashes[name] = algorithm === 'reference' ? await referenceHash(directory, 1_000_000_000, true, options) : await snapshotHash(directory, 1_000_000_000, true, { ...options, concurrency: algorithm === 'bounded-4' ? 4 : 8 });
      }
      expected ??= hashes; assert.deepEqual(hashes, expected, `${fixture}/${algorithm} digest mismatch`);
      scans.push({ fixture, repetition, algorithm, duration_ms: performance.now() - started, hashes, profiles });
      await save('running'); console.error(`${fixture} ${algorithm}: ${Math.round(scans.at(-1).duration_ms)} ms`);
    }
  }
  await save('verified'); console.log(`Evidence: ${output}/summary.json`);
} catch (error) { await save('failed'); throw error; }
finally {
  process.removeListener('SIGINT', interrupt);
  for (const directory of retained) await fs.rm(directory, { recursive: true, force: true });
  await fs.rm(path.join(output, 'small'), { recursive: true, force: true });
}
