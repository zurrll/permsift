// Replay saved third-party facts through the public CLI. Never invokes observe or a task.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const repository = fileURLToPath(new URL('../', import.meta.url));
process.chdir(repository);
await fs.mkdir('.permsift', { recursive: true });
const root = await fs.mkdtemp(path.join(repository, '.permsift/offline-usage-'));
const files = ['fast-glob-tasks.json', 'fast-glob-bundle-before.json', 'fast-glob-bundle-after.json'].map(name => path.join(repository, 'examples/reports', name));
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const hashes = await Promise.all(files.map(digest)), samples = [];
const run = (name, args) => {
  const start = performance.now();
  const stdout = execFileSync(process.execPath, ['dist/cli.js', ...args], {
    cwd: repository, encoding: 'utf8', maxBuffer: 8_000_000,
    // Node is launched by absolute path. No sandbox/npm/build executable is available.
    env: { ...process.env, PATH: path.join(root, 'no-executables') },
  });
  samples.push({ command: args, wall_ms_including_node_startup: performance.now() - start });
  return fs.writeFile(path.join(root, name), stdout).then(() => stdout);
};

const tasks = JSON.parse(await run('tasks.json', ['inspect', files[0], '--package', 'glob-parent', '--json']));
assert.equal(tasks.status, 'complete'); assert.equal(tasks.tasks.length, 2);
assert.equal(tasks.tasks[0].instances[0].node.record, 'absent');
assert.equal(tasks.tasks[1].instances[0].node.files, 1);
assert.ok(tasks.tasks.every(t => t.instances[0].typescript.capture_status === 'not_collected'));
await run('tasks.md', ['inspect', files[0], '--package', 'glob-parent']);
const compared = JSON.parse(await run('comparison.stdout.json', ['compare', files[1], files[2], '--json', '--output', path.join(root, 'comparison')]));
assert.equal(compared.status, 'compared');
assert.deepEqual(compared.comparison.tasks[0].bundling.version_changes.map(p => [p.name, p.before, p.after]), [['glob-parent', '5.1.2', '6.0.2']]);
assert.deepEqual(compared.comparison.tasks[0].bundling.contribution_changes.map(p => [p.name, p.before_bytes, p.after_bytes]), [['glob-parent', 934, 1560]]);
const current = JSON.parse(await run('bundle-package.json', ['inspect', files[2], '--package', 'glob-parent', '--json']));
assert.equal(current.tasks[0].instances[0].node.record, 'absent');
assert.equal(current.tasks[0].instances[0].esbuild.contributions[0].bytes_in_output, 1560);
const unchanged = JSON.parse(await run('unchanged.json', ['compare', files[2], files[2], '--json']));
assert.equal(unchanged.status, 'compared'); assert.equal(unchanged.comparison.tasks[0].bundling.contribution_changes.length, 0);
assert.deepEqual(await Promise.all(files.map(digest)), hashes);
await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify({ root, samples, input_hashes_unchanged: true, task_executions: 0, installations: 0,
  questions: { across_tasks: 'glob-parent has no Node load record in compile and one in compile-test; neither task collected compiler/build metadata.',
    upgrade: 'The adapted bundle task records glob-parent 5.1.2 -> 6.0.2 and 934 -> 1560 JS bytes; Node tool loads do not change.' },
  limitations: 'Replay of saved facts, including an adapted bundle task. Engineering verification, not new project adoption or a human-time benchmark.' }, null, 2) + '\n');
console.log(`Offline evidence: ${path.join(root, 'summary.json')}`);
