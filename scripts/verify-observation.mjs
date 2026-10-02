// Cost/value verification, without tighten: normal once, observe twice.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { runExperiment } from '../dist/src/engine.js';
import { runObservation } from '../dist/src/observe-command.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
process.chdir(repository);
const { values } = parseArgs({ options: { 'medium-baseline': { type: 'string' } } });
await fs.mkdir('.permsift', { recursive: true });
const root = await fs.mkdtemp(path.join(repository, '.permsift/dependency-usage-'));
console.error(`Evidence directory: ${root}`);
const controller = new AbortController(), interrupt = () => controller.abort();
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const summary = { root, samples: [], limitations: 'One ordinary run followed by two observed runs per project, sequential on one host. Not a statistical performance guarantee. Only module hooks are compared; types/assets/native reads remain outside coverage.' };
const write = () => fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const configs = [{ name: 'bundle-kit', configPath: path.join(repository, 'examples/projects/bundle-kit/permsift.yaml'), limitsPath: path.join(repository, 'examples/limits.json') }];
try {
  if (values['medium-baseline']) {
    const baseline = JSON.parse(await fs.readFile(values['medium-baseline'], 'utf8'));
    const config = parse(await fs.readFile(baseline.warm_config, 'utf8'));
    const original = config.scenarios[0];
    const common = { ...original, initial_network_grants: [], initial_write_grants: ['@workspace/out', '@workspace/reports'],
      install: { ...original.install, initial_write_grants: ['@workspace/node_modules'], narrower_candidates: [], auto_discover: false } };
    config.scenarios = [{ ...common, id: 'compile', command: ['node', 'node_modules/typescript/bin/tsc', '--pretty', 'false', '--skipLibCheck'],
      assertions: [{ type: 'file_contains', path: '@workspace/out/index.d.ts', text: 'declare' }] }, { ...common, id: 'compile-test' }];
    const configPath = path.join(root, 'fast-glob.yaml');
    await fs.writeFile(configPath, stringify(config, { aliasDuplicateObjects: false }));
    configs.push({ name: 'fast-glob', configPath, limitsPath: path.join(repository, 'examples/third-party/fast-glob/limits.json') });
  }
  for (const item of configs) {
    const limits = parse(await fs.readFile(item.limitsPath, 'utf8')); limits.repetitions = 1;
    const limitsPath = path.join(root, item.name + '-limits.json'); await fs.writeFile(limitsPath, JSON.stringify(limits));
    const options = { configPath: item.configPath, limitsPath, signal: controller.signal, onProgress: message => console.error(`${item.name}: ${message}`) };
    const normal = await runExperiment({ ...options, mode: 'run', output: path.join(root, item.name + '-normal') });
    assert.equal(normal.status, 'verified', normal.error);
    const first = await runObservation({ ...options, output: path.join(root, item.name + '-observe') });
    const second = await runObservation({ ...options, output: path.join(root, item.name + '-repeat'), baselinePath: path.join(first.output, 'usage.json') });
    assert.equal(first.status, 'observed', JSON.stringify(first.tasks)); assert.equal(second.status, 'observed');
    assert.equal(first.inputs.snapshot_hash, normal.inputs.snapshot_hash); assert.equal(second.inputs.snapshot_hash, first.inputs.snapshot_hash);
    const execution = JSON.parse(await fs.readFile(path.join(first.output, 'report.json'), 'utf8'));
    const repeatExecution = JSON.parse(await fs.readFile(path.join(second.output, 'report.json'), 'utf8'));
    assert.equal(execution.trials.length, first.tasks.length); assert.ok(execution.trials.every(t => t.phase === 'observe'));
    for (const task of first.tasks) {
      const repeat = second.tasks.find(t => t.task === task.task);
      assert.deepEqual(task.loaded_packages, repeat.loaded_packages); assert.deepEqual(task.edges, repeat.edges);
      assert.ok(!second.comparison.tasks.find(t => t.task === task.task).added.length);
      assert.ok(!second.comparison.tasks.find(t => t.task === task.task).removed.length);
    }
    const tasks = first.tasks.map(t => { const trial = execution.trials.find(x => x.scenario === t.task), ordinary = normal.trials.find(x => x.scenario === t.task);
      return { task: t.task, installed_instances: t.inventory.packages.length, names: new Set(t.inventory.packages.map(p => p.name)).size,
        loaded_instances: t.loaded_packages.length, loaded_names: t.loaded_packages.map(p => p.name), not_observed: t.not_observed.length,
        instrumented_processes_threads: t.processes.length, coverage_gaps: t.coverage_gaps,
        normal_task_ms: ordinary.timings.phases.task.duration_ms, observed_task_ms: trial.timings.phases.task.duration_ms,
        repeat_task_ms: repeatExecution.trials.find(x => x.scenario === t.task).timings.phases.task.duration_ms };
    });
    if (item.name === 'bundle-kit') {
      assert.ok(tasks[0].loaded_names.includes('esbuild'));
      assert.ok(first.tasks[0].not_observed.some(p => p.name.startsWith('@esbuild/')));
      assert.ok(tasks[0].coverage_gaps.some(s => /esbuild/.test(s)));
    } else {
      assert.ok(tasks.find(t => t.task === 'compile').loaded_names.includes('typescript'));
      assert.ok(!tasks.find(t => t.task === 'compile').loaded_names.includes('mocha'));
      assert.ok(tasks.find(t => t.task === 'compile-test').loaded_names.includes('mocha'));
    }
    summary.samples.push({ project: item.name, normal_total_ms: normal.timings.total_ms, observed_total_ms: execution.timings.total_ms,
      repeat_total_ms: repeatExecution.timings.total_ms, input_hash: first.inputs.snapshot_hash, stable_loaded_packages_and_edges: true,
      tasks, usage_report: path.join(first.output, 'usage.json'), repeat_report: path.join(second.output, 'usage.json') });
    await write();
  }
  console.log(`Evidence: ${path.join(root, 'summary.json')}`);
  console.log(JSON.stringify(summary.samples, null, 2));
} finally { await write(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
