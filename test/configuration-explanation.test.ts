import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { explainConfiguration, configurationExplanationText } from '../src/configuration-explanation.js';
import { loadConfiguration, initialPreparation } from '../src/config.js';

const task = () => ({ id: 'build', command: ['node', 'task.cjs'], initial_write_grants: ['@workspace/dist'],
  assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }] });
async function fixture(t: TestContext, scenarios: unknown[] = [task()], extra = {}, limitExtra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-explain-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'tasks.json'), limitsPath = path.join(root, 'limits.json');
  await fs.writeFile(configPath, JSON.stringify({ schema_version: 1, scenarios, ...extra }));
  await fs.writeFile(limitsPath, JSON.stringify({ schema_version: 1, allowed_write_roots: ['@workspace', '@cache', '@tmp'], ...limitExtra }));
  // Any accidental task execution would leave a visible marker.
  await fs.writeFile(path.join(root, 'task.cjs'), "require('node:fs').writeFileSync('TASK_RAN', 'bad');process.exit(99);");
  return { root, configPath, limitsPath };
}

test('omitted and explicit defaults retain different provenance; normalized inputs match the executor', async t => {
  const f = await fixture(t, [task(), { ...task(), id: 'declared', auto_discover: true, timeout_seconds: 120 }]);
  const before = await fs.readFile(f.configPath), result = await explainConfiguration(f), input = await loadConfiguration(f.configPath, f.limitsPath);
  assert.equal(result.status, 'valid'); assert.deepEqual(result.normalized, { config: input.config, limits: input.limits });
  assert.equal(result.project?.resolved, f.root); assert.deepEqual(await fs.readFile(f.configPath), before);
  assert.ok(result.defaults_applied.some(d => d.path === 'scenarios.0.auto_discover' && d.value === true));
  assert.ok(!result.defaults_applied.some(d => d.path === 'scenarios.1.auto_discover' || d.path === 'scenarios.1.timeout_seconds'));
  assert.equal(result.tasks[0].task.read.mode, 'legacy'); assert.equal(result.tasks[0].task.read.origin.kind, 'default');
  assert.deepEqual(result.tasks[0].task.read.grants, ['@workspace']);
  assert.equal(result.task_executions, 0); assert.equal(result.installations, 0);
  await assert.rejects(fs.access(path.join(f.root, 'TASK_RAN')));
});

test('explicit empty reads stay empty; trusted ceilings never become task grants', async t => {
  const f = await fixture(t, [{ ...task(), initial_read_grants: [] }], {}, { allowed_read_roots: ['@workspace'] });
  const r = await explainConfiguration(f);
  assert.equal(r.status, 'valid'); assert.deepEqual(r.tasks[0].task.read.grants, []);
  assert.equal(r.tasks[0].task.read.mode, 'explicit'); assert.equal(r.tasks[0].task.read.origin.kind, 'declared');
  assert.deepEqual(r.tasks[0].task.write.grants, ['@workspace/dist']); assert.deepEqual(r.tasks[0].task.network, []);
  assert.match(configurationExplanationText(r), /空数组不等于零读取权限/);
});

test('shared install inherits task writes; separate empty install writes and fixed reads are explained', async t => {
  const base = { ...task(), initial_network_grants: ['registry.npmjs.org'] };
  const f = await fixture(t, [
    { ...base, install: { manager: 'npm' } },
    { ...base, id: 'separate', initial_read_grants: [], install: { manager: 'npm', initial_write_grants: [] },
      protection_goals: [{ key: 'private', target: '@workspace/private', target_kind: 'file', operation: 'read', stage: 'task', expected: 'denied' }] },
    { ...base, id: 'warm', install: { manager: 'npm', cache: 'warm', cache_seed: '@workspace/seed', initial_write_grants: ['@workspace/node_modules'] } },
  ], { exclude: ['node_modules'] }, { allowed_network_domains: ['registry.npmjs.org'], allowed_read_roots: [] });
  const r = await explainConfiguration(f); assert.equal(r.status, 'valid');
  assert.equal(r.tasks[0].installation!.mode, 'shared'); assert.equal(r.tasks[0].installation!.write.origin.kind, 'inherited');
  assert.deepEqual(r.tasks[0].installation!.write.grants, ['@workspace/dist']);
  assert.equal(r.tasks[1].installation!.mode, 'separate'); assert.deepEqual(r.tasks[1].installation!.write.grants, []);
  assert.deepEqual(r.tasks[1].installation!.read, ['@workspace']); assert.equal(r.tasks[1].task.protection_goals!.length, 1);
  assert.equal(r.tasks[2].installation!.offline, true); assert.equal(r.tasks[2].installation!.scripts, 'disabled');
  assert.deepEqual(r.tasks[2].installation!.network.grants, ['registry.npmjs.org']);
  assert.match(configurationExplanationText(r), /不使用任务读取规则或任务保护目标/);
});

test('mode schedules distinguish repeats, once-only observation, additional searches and unknown history', async t => {
  const f = await fixture(t, [task(), { ...task(), id: 'installed', install: { manager: 'npm' } }],
    { exclude: ['node_modules'] }, { allowed_network_domains: [], repetitions: 3, max_candidates: 0 });
  const run = await explainConfiguration(f), observe = await explainConfiguration({ ...f, forMode: 'observe' });
  const tighten = await explainConfiguration({ ...f, forMode: 'tighten' }), check = await explainConfiguration({ ...f, forMode: 'check' });
  assert.deepEqual([run.schedule!.nominal_task_executions, run.schedule!.nominal_installations], [6, 3]);
  assert.deepEqual([observe.schedule!.nominal_task_executions, observe.schedule!.nominal_installations], [2, 1]);
  assert.deepEqual([tighten.schedule!.nominal_task_executions, tighten.schedule!.nominal_installations], [12, 6]);
  assert.equal(tighten.schedule!.candidate_limit, 0); assert.match(tighten.schedule!.additional_work.join(' '), /0 也会执行验证/);
  assert.equal(check.schedule!.nominal_task_executions, null); assert.equal(check.schedule!.nominal_installations, null);
  assert.equal(check.tasks[0].policy_role, 'control_and_repair_input'); assert.match(check.schedule!.basis, /历史实际策略|实际策略/);
  assert.equal(observe.tasks[0].search.active, false); assert.equal(run.tasks[0].observation.active, false);
});

test('TypeScript command changes only for observe; esbuild authorization check is mode-specific', async t => {
  const f = await fixture(t, [{ ...task(), command: ['node', 'node_modules/typescript/bin/tsc'],
    observation: { typescript: { compiler: '@workspace/node_modules/typescript' }, esbuild: {
      bundler: '@workspace/node_modules/esbuild', metafile: '@workspace/bundle/meta.json', output_root: '@workspace/bundle' } } }]);
  const run = await explainConfiguration(f), observe = await explainConfiguration({ ...f, forMode: 'observe' });
  assert.equal(run.status, 'valid'); assert.equal(observe.status, 'invalid');
  assert.deepEqual(run.tasks[0].executed_command, ['node', 'node_modules/typescript/bin/tsc']);
  assert.deepEqual(observe.tasks[0].executed_command.slice(-5), ['--explainFiles', '--locale', 'en', '--pretty', 'false']);
  assert.equal(run.tasks[0].observation_output_root_removed, undefined);
  assert.equal(observe.tasks[0].observation_output_root_removed, '@workspace/bundle');
  assert.match(observe.issues[0].message, /output_root requires/);
});

test('artifact grouping preserves all checks, JSON values and the strength of nonexpected report cases', async t => {
  const f = await fixture(t, [{ ...task(), assertions: [
    { type: 'file_exists', path: '@workspace/report.json' },
    { type: 'json_equals', path: '@workspace/report.json', pointer: '/ok', value: false },
    { type: 'test_results', path: '@workspace/report.json', expected_tests: ['one'] },
    { type: 'junit', path: '@workspace/report.xml', expected_tests: ['one'] },
  ] }]);
  const r = await explainConfiguration(f);
  assert.equal(r.tasks[0].artifacts.length, 2); assert.deepEqual(r.tasks[0].artifacts[0].checks.map(c => c.index), [0, 1, 2]);
  assert.deepEqual(r.tasks[0].assertion_outputs_removed, ['@workspace/report.json', '@workspace/report.xml']);
  const text = configurationExplanationText(r); assert.match(text, /空文件也可通过/); assert.match(text, /未列为预期/);
  assert.match(text, /报告真实性/); assert.match(text, /"value":false/); assert.match(text, /不检查其他字段/);
});

test('preparation includes candidates even without search, uses installer defaults and records exclusions', async t => {
  const f = await fixture(t, [{ ...task(), prepare_directories: ['@workspace/extra'], narrower_candidates: [{ from: '@workspace/dist', to: ['@workspace/dist/sub'] }],
    install: { manager: 'npm', initial_write_grants: ['@workspace/node_modules'], narrower_candidates: [{ from: '@workspace/node_modules', to: ['@workspace/node_modules/cache'] }] } }],
    { exclude: ['node_modules', 'dist'] }, { allowed_network_domains: [] });
  const r = await explainConfiguration(f), s = r.normalized!.config.scenarios[0];
  assert.deepEqual(r.tasks[0].initial_preparation, ['@workspace/dist', '@workspace/dist/sub', '@workspace/extra', '@workspace/node_modules', '@workspace/node_modules/cache']);
  assert.deepEqual(r.tasks[0].initial_preparation, initialPreparation(s)); assert.equal(r.tasks[0].search.active, false);
  assert.deepEqual(r.exclude, ['node_modules', 'dist']);
  const tight = await explainConfiguration({ ...f, forMode: 'tighten' }); assert.equal(tight.tasks[0].search.install_write_auto, true);
});

test('schema, YAML, trusted ceiling and duplicate task errors identify their source and preserve zero execution', async t => {
  const f = await fixture(t, [task(), task()], {}, { allowed_write_roots: ['@workspace/other'] });
  const r = await explainConfiguration(f); assert.equal(r.status, 'invalid');
  assert.ok(r.issues.some(i => i.path === 'scenarios.1.id')); assert.ok(r.issues.some(i => /exceeds/.test(i.message) && i.path === 'scenarios.0'));
  await fs.writeFile(f.limitsPath, JSON.stringify({ schema_version: 1, allowed_write_roots: ['@workspace'], repetitions: 0 }));
  const schema = await explainConfiguration(f); assert.ok(schema.issues.some(i => i.file === f.limitsPath && i.path === 'repetitions'));
  await fs.writeFile(f.configPath, 'schema_version: 1\nschema_version: 1\n');
  const yaml = await explainConfiguration(f); assert.ok(yaml.issues.some(i => i.file === f.configPath && /unique|Duplicate/i.test(i.message)));
  await fs.writeFile(f.configPath, 'schema_version: 1\nscenarios: &x []\nexclude: *x\n');
  assert.equal((await explainConfiguration(f)).status, 'invalid');
  assert.equal(yaml.task_executions, 0); assert.equal(yaml.installations, 0);
});

test('project resolution follows config location, not cwd; missing project is reported without scanning input', async t => {
  const f = await fixture(t, [task()], { project: 'missing' });
  const r = await explainConfiguration(f); assert.equal(r.status, 'invalid'); assert.equal(r.issues[0].path, 'project');
  const dir = path.join(f.root, 'missing'); await fs.mkdir(dir); await fs.symlink('/permsift-do-not-follow', path.join(dir, 'link'));
  const valid = await explainConfiguration(f); assert.equal(valid.status, 'valid'); assert.equal(valid.project!.resolved, dir);
  assert.match(valid.limitations.join(' '), /未检查/); // Nested input links are deliberately an execution-time check.
});

test('public explain works with child launches and network APIs blocked, and leaves inputs untouched', async t => {
  const f = await fixture(t), guard = path.join(f.root, 'guard.mjs');
  await fs.writeFile(guard, `import cp from 'node:child_process';import net from 'node:net';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';
for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[key]=()=>{throw Error('child launch forbidden')};
for(const api of [net,http,https])for(const key of ['connect','createConnection','request','get'])if(key in api)api[key]=()=>{throw Error('network forbidden')};
net.Socket.prototype.connect=()=>{throw Error('socket connection forbidden')};
syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('network forbidden')};`);
  const before = await Promise.all([fs.readFile(f.configPath), fs.readFile(f.limitsPath), fs.readdir(f.root)]);
  const result = spawnSync(process.execPath, ['--import', guard, 'dist/cli.js', 'explain', '--config', f.configPath, '--limits', f.limitsPath, '--json'],
    { encoding: 'utf8', env: { ...process.env, PATH: '/permsift-no-tools' } });
  assert.equal(result.status, 0, result.stderr); const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.kind, 'configuration_explanation'); assert.equal(parsed.status, 'valid');
  assert.deepEqual(await Promise.all([fs.readFile(f.configPath), fs.readFile(f.limitsPath), fs.readdir(f.root)]), before);
});
