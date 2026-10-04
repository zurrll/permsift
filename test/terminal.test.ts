import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { readResult, comparisonRecord, type ResultRecord } from '../src/result-reader.js';
import { explainResult } from '../src/result-explanation.js';
import { publishSummary } from '../src/result-output.js';
import { terminalView, terminalText, packageText, configurationText, diagnosticText } from '../src/terminal.js';
import { progressWriter, progressText } from '../src/progress.js';
import { explainConfiguration } from '../src/configuration-explanation.js';
import { compareSavedUsage } from '../src/offline-usage.js';
import type { PackageInspection } from '../src/usage-inspection.js';
import type { SuccessDiagnostic } from '../src/success-diagnostics.js';

const cli = (...args: string[]) => spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
/** Labelled synthetic complete bundle built from saved final proofs; no task is executed. */
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-terminal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const p = JSON.parse(await fs.readFile('examples/model-cases/current-demo.json', 'utf8'));
  const trials = p.report.trials.filter((x: any) => x.phase === 'final');
  const proofs = new Map<string, any>(trials.filter((x: any) => p.evidence[x.evidence]).map((x: any) => [x.scenario, p.evidence[x.evidence]]));
  const evidence: Record<string, any> = {};
  for (const trial of trials) {
    trial.phase = 'baseline';
    evidence[trial.evidence] = { ...structuredClone(proofs.get(trial.scenario)), ...trial, summary: trial };
  }
  Object.assign(p.report, { mode: 'run', trials, search_complete: false, searches: {}, read_searches: {} });
  const write = async () => {
    await fs.writeFile(path.join(root, 'inputs.json'), JSON.stringify(p.inputs));
    await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
    for (const [file, value] of Object.entries(evidence)) await fs.writeFile(path.join(root, file), JSON.stringify(value));
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(p.report));
    return readResult(root);
  };
  return { root, p, evidence, write };
}

test('default terminal renders independently verified facts without Markdown or inactive search noise', async t => {
  const f = await fixture(t), record = await f.write(), summary = explainResult(record);
  assert.equal(summary.analysis.status, 'complete');
  const text = terminalText(terminalView(record, summary));
  assert.match(text, /^验证通过/); assert.match(text, /固定边界检查通过/);
  assert.match(text, /6 次实验；任务进程记录 6 次/);
  assert.ok(!/Next:|Evidence:|candidate_generation|search complete|\| ---|## /.test(text));
  assert.ok(text.split('\n').length <= 24); assert.match(text, /查看依据（只读）/);
  assert.match(terminalText(terminalView(record, summary), { details: true }), /依据：evidence\/.*\.json/);
});

test('missing companions do not turn a reported success into a verified terminal result', async t => {
  const f = await fixture(t); await f.write();
  await fs.unlink(path.join(f.root, f.p.report.trials[0].evidence));
  const record = await readResult(f.root), summary = explainResult(record);
  const result = cli('inspect', f.root);
  assert.equal(result.status, 2); assert.match(result.stdout, /依据不完整/);
  assert.match(result.stdout, /未重新执行项目/); assert.ok(!result.stdout.includes('验证通过 ·'));
  assert.deepEqual(JSON.parse(cli('inspect', f.root, '--json').stdout), summary);
});

test('passing task with a failed boundary is prominent even when the producer claims verified', async t => {
  const f = await fixture(t), e = f.evidence[f.p.report.trials[0].evidence];
  e.after.checks[0].status = 'fail'; e.after.checks[0].detail = 'Synthetic boundary failure';
  const record = await f.write(), text = terminalText(terminalView(record, explainResult(record)));
  assert.match(text, /^结论存在冲突/); assert.match(text, /边界检查.*失败/); assert.match(text, /Synthetic boundary failure/);
  assert.match(text, /test  通过/);
});

test('budget stop remains visible beside the verified policy rather than implying minimum permissions', async t => {
  const f = await fixture(t); f.p.report.mode = 'tighten'; f.p.report.search_complete = false;
  for (const trial of f.p.report.trials) { trial.phase = 'final'; f.evidence[trial.evidence].phase = 'final'; }
  f.p.report.searches = { test: { stop: 'budget', steps: [], rounds: 1, reuses: [] } };
  const record = await f.write(), text = terminalText(terminalView(record, explainResult(record)));
  assert.match(text, /预算耗尽/); assert.match(text, /已验证规则与未完成搜索/); assert.match(text, /未证明全局最小权限/);
});

test('install failure does not count a skipped task as an execution', async t => {
  const f = await fixture(t), record = structuredClone(await f.write());
  record.model!.workflow.reported_status = 'failed'; record.cost!.trials = 1;
  record.executions = record.executions.slice(0, 1);
  const facts = record.executions[0].facts;
  facts.process = { state: 'not_run', reason: 'Synthetic installer failed before task' };
  facts.outcomes.task = { status: 'not_run', basis: 'Synthetic task skipped' };
  facts.installation = { state: 'recorded', value: { command: ['npm', 'ci'], process: { status: 'timeout', exit_code: null },
    reported_verdict: 'unknown', reused: { state: 'recorded', value: false } } };
  const text = terminalText(terminalView(record, explainResult(record)));
  assert.match(text, /任务进程记录 0 次，安装进程记录 1 次/);
  assert.match(text, /依赖安装无法确定；任务 未执行/);
});

test('unknown installer reuse remains unknown instead of being counted as a fresh install', async t => {
  const f = await fixture(t), record = structuredClone(await f.write());
  record.executions[0].facts.installation = { state: 'recorded', value: { command: ['npm', 'ci'], process: { status: 'completed', exit_code: 0 },
    reported_verdict: 'pass', reused: { state: 'not_saved', reason: 'Synthetic legacy gap' } } };
  assert.match(terminalText(terminalView(record, explainResult(record))), /另有安装\/复用状态未保存/);
});

test('display cache cannot override offline inspection and existing machine output remains unchanged', async t => {
  const f = await fixture(t), record = await f.write(), source = path.join(f.root, 'report.json'), before = await fs.readFile(source);
  await fs.writeFile(path.join(f.root, 'report.md'), '# Original details\n');
  const summary = await publishSummary(source, path.join(f.root, 'report.md'));
  await fs.writeFile(path.join(f.root, 'terminal.json'), JSON.stringify({ title: 'Synthetic forged display' }));
  const r = cli('inspect', f.root);
  assert.equal(r.status, 0); assert.ok(!r.stdout.includes('Synthetic forged display'));
  assert.deepEqual(JSON.parse(cli('inspect', f.root, '--json').stdout), summary);
  assert.deepEqual(await fs.readFile(source), before);
  assert.deepEqual(summary, explainResult(record));
});

test('offline package display separates absent, uncollected, incomplete and zero contribution', () => {
  const s = (capture_status: any, record: any, files: number | null) => ({ capture_status, record, files });
  const report: PackageInspection = { schema_version: 1, kind: 'dependency_package_inspection', report: '/tmp/usage.json', package: 'synthetic', found: true,
    status: 'partial', limitations: [], tasks: [{ task: 'build', verdict: 'pass', inventory: 'complete', module_capture: 'captured', compiler_capture: 'not_collected', build_capture: 'incomplete', issues: [],
      instances: [{ name: 'synthetic', version: '1', path: '@workspace/node_modules/synthetic', node: s('captured', 'absent', null), typescript: s('not_collected', 'absent', null),
        esbuild: { ...s('incomplete', 'present', 1), contributions: [{ output: '@workspace/dist/a.js', bytes_in_output: 0 }] } }] }] };
  const text = packageText(report);
  assert.match(text, /无记录（采集完成）/); assert.match(text, /TypeScript 输入：未采集/);
  assert.match(text, /1 个文件（采集不完整）/); assert.match(text, /0 字节贡献/);
  assert.ok(!text.includes('|')); assert.ok(!text.includes('unused'));
});

test('static preview keeps broad default reads, cleanup, test checks and no-execution scope visible', async () => {
  const report = await explainConfiguration({ configPath: 'examples/demo/permsift.yaml', limitsPath: 'examples/limits.json' });
  const text = configurationText(report);
  assert.match(text, /项目副本整体（默认）/); assert.match(text, /预期 4 项名称，报告全部测试须通过/);
  assert.match(text, /副本预先清理/); assert.match(text, /静态检查未验证任务/);
  assert.ok(!text.includes('schema 默认值'));
  const r = cli('explain', '--config', 'examples/demo/permsift.yaml', '--limits', 'examples/limits.json', '--details');
  assert.equal(r.status, 0); assert.match(r.stdout, /采用的 schema 默认值/);
  assert.deepEqual(JSON.parse(cli('explain', '--config', 'examples/demo/permsift.yaml', '--limits', 'examples/limits.json', '--json').stdout), report);
});

test('comparison gives changes without claiming a nonexistent output or rerunning tasks', async () => {
  const files = ['examples/reports/fast-glob-bundle-before.json', 'examples/reports/fast-glob-bundle-after.json'];
  const expected = await compareSavedUsage(...files as [string, string]), r = cli('compare', ...files);
  assert.equal(r.status, 0); assert.match(r.stdout, /glob-parent：5\.1\.2 → 6\.0\.2/);
  assert.match(r.stdout, /任务 0 次、安装 0 次/); assert.ok(!r.stdout.includes('结果：'));
  assert.deepEqual(JSON.parse(cli('compare', ...files, '--json').stdout), expected);
});

test('large change lists are bounded by default and fully available with details', async () => {
  const c = await compareSavedUsage('examples/reports/fast-glob-bundle-before.json', 'examples/reports/fast-glob-bundle-after.json');
  // Synthetic extra rows test layout only; they are not observations of these projects.
  c.comparison.tasks[0].added = Array.from({ length: 80 }, (_, i) => ({ path: `@workspace/node_modules/synthetic-${i}`, name: `synthetic-${i}`, version: '1' }));
  const record = comparisonRecord('/tmp/synthetic-comparison.json', c), view = terminalView(record, explainResult(record));
  const text = terminalText(view); assert.match(text, /另有 \d+ 行结果/); assert.ok(!text.includes('synthetic-79'));
  assert.match(text, /记录差异不代表可删除依赖/);
  assert.match(text, /任务 0 次、安装 0 次/);
  assert.match(terminalText(view, { details: true }), /synthetic-79/);
});

test('diagnostics keep the existence-only finding and format/content distinction visible', () => {
  const report: SuccessDiagnostic = { schema_version: 1, kind: 'permsift_success_diagnostic', status: 'diagnosed', source: '/tmp/report.json', duration_ms: 1,
    limits: { mutations: 256, milliseconds: 5000, task_executions: 0, installations: 0 }, limitations: [], tasks: [{ task: 'build', state: 'diagnosed', artifacts: [{ path: '@workspace/dist/a.js', state: 'diagnosed', assertions: [], skipped_perturbations: [], mutations: [],
      findings: ['The artifact checks accept an empty readable file. They check existence, not useful content; task-internal behavior tests were not re-run.', 'An empty file is rejected for invalid structured format. Semantic value/test changes are reported separately.'] }] }] };
  const text = diagnosticText(report); assert.match(text, /接受空文件，只验证存在/); assert.match(text, /因结构格式无效被拒绝/);
  assert.match(text, /不判断报告诚实性/);
});

test('TTY progress updates one bounded line; redirected progress has no control characters', () => {
  const chunks: string[] = [], tty = progressWriter({ isTTY: true, columns: 30, write: s => chunks.push(s) });
  const e = { task: 'build', phase: 'baseline', attempt: 2, repetitions: 3, stage: 'task' as const };
  tty.event(e); tty.event({ ...e, stage: 'install' }); tty.finish();
  assert.equal(chunks.filter(s => s.startsWith('\r\u001b[2K')).length, 2); assert.equal(chunks.at(-1), '\n');
  const ordinary: string[] = [], redirected = progressWriter({ write: s => ordinary.push(s) });
  redirected.event(e); redirected.finish();
  assert.match(ordinary.join(''), /2\/3.*执行任务/); assert.ok(!ordinary.join('').includes('\u001b'));
  assert.match(progressText({ ...e, comparison: 'old' }), /旧规则复验/);
  assert.match(progressText({ ...e, phase: 'recovery_install' }), /恢复安装写入规则/);
  assert.match(progressText({ ...e, comparison: 'control-recovery-2' }), /恢复宽规则对照/);
});

test('terminal neutralizes control and bidi text across default and detailed output', async t => {
  const f = await fixture(t), record = await f.write(), view = terminalView(record, explainResult(record));
  view.title += '\u001b[31m\u202e'; view.notices.push('synthetic\n\u009b\u2066'); view.details.push('synthetic\u001b[2J');
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(terminalText(view, { details: true }).replaceAll('\n', '')));
});

test('detail and JSON modes cannot accidentally mix human output into machine output', () => {
  const r = cli('inspect', 'missing', '--details', '--json');
  assert.equal(r.status, 2); assert.equal(r.stdout, ''); assert.match(r.stderr, /不能同时使用/);
});
