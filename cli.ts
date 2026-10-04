#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema, limitsSchema } from './src/config.js';
import { VERSION } from './src/version.js';
import { loadUsage } from './src/usage-report.js';
import { inspectPackage } from './src/usage-inspection.js';
import { compareSavedUsage, saveComparison } from './src/offline-usage.js';
import { readResult, comparisonRecord } from './src/result-reader.js';
import { explainResult } from './src/result-explanation.js';
import { readPublishedTerminal } from './src/result-output.js';
import { terminalView, terminalText, configurationText, packageText, diagnosticText, cleanText } from './src/terminal.js';
import { progressWriter } from './src/progress.js';

const help = `Permsift ${VERSION} — 验证任务、收缩权限、观察依赖。

用法：
  permsift doctor [--output NEW_DIRECTORY] [--json]
  permsift explain --config FILE --limits TRUSTED_FILE [--for run|tighten|observe|check] [--json]
  permsift run --config FILE --limits TRUSTED_FILE [options]
  permsift tighten --config FILE --limits TRUSTED_FILE [options]
  permsift check --config FILE --baseline REPORT_JSON --limits TRUSTED_FILE [options]
  permsift check --config FILE --limits TRUSTED_FILE [options]  (uses adopted baseline)
  permsift adopt RESULT --config FILE --limits TRUSTED_FILE [--output BASELINE_STORE] [--reason TEXT] [--json]
  permsift observe --config FILE --limits TRUSTED_FILE [--baseline USAGE_JSON] [options]
  permsift compare BEFORE_USAGE_JSON AFTER_USAGE_JSON [--output NEW_DIRECTORY] [--json]
  permsift diagnose RESULT [--output NEW_DIRECTORY] [--json]
  permsift inspect REPORT_JSON_OR_DIRECTORY [--json]
  permsift inspect USAGE_JSON --package NAME [--json]

选项：
  --output DIR       执行结果存到新目录；adopt 保存到可复用的基线库
  --save-artifacts   保存有限的最终产物，供后续离线检查成功条件
  --keep-workspaces  保留临时工作区，便于排查
  --json             完整 JSON 输出到 stdout，进度输出到 stderr
  --details          展开详细说明、证据与原始检查信息（不能与 --json 同用）
  --baseline FILE    check：已验证报告或采用的基线库；observe：用于比较的旧 usage.json
  --reason TEXT      adopt：记录你采用这份结果的理由
  --package NAME     inspect：按精确包名查看各任务的安装实例与来源记录
  --for MODE         explain：预览模式，默认 run；不执行任务或安装
  --help             查看帮助
  --version          查看版本

任务执行要求 macOS；任务断网，安装阶段使用明确的域名授权。
limits 必须来自你独立信任的位置。
compare / inspect / diagnose 只读保存材料，不安装、不执行项目。
explain 仅静态检查；adopt 仅保存选择和历史证据，不执行或搜索。
执行退出码：0 通过/兼容/观察完成/已采用；1 失败、回归或约定变化需审阅；
2 设置无效、无法确定或采集不完整；130 中断。
只读退出码：0 分析完整（可以有差异）；1 指定包未找到；2 材料无效或分析不完整。
只读分析完整不表示原任务通过；未采集不等于没有记录。
`;
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, limits: { type: 'string' }, output: { type: 'string' },
    'keep-workspaces': { type: 'boolean' }, 'save-artifacts': { type: 'boolean' }, json: { type: 'boolean' }, details: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    baseline: { type: 'string' },
    package: { type: 'string' }, reason: { type: 'string' }, for: { type: 'string' },
  } });
  if (values.version) { console.log(VERSION); return; }
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const mode = positionals[0];
  if (values.details && values.json) throw new Error('--details 和 --json 不能同时使用');
  if (values.for !== undefined && mode !== 'explain') throw new Error('--for is only supported by explain');
  if (values['save-artifacts'] && !['run', 'tighten', 'check', 'observe'].includes(mode)) throw new Error('--save-artifacts is only supported by run/tighten/check/observe');
  if (mode === 'explain') {
    if (positionals.length !== 1 || !values.config || !values.limits || values.output || values.baseline || values.package || values.reason || values['keep-workspaces']) throw new Error('Expected explain --config FILE --limits TRUSTED_FILE [--for run|tighten|observe|check] [--json]');
    const { explainConfiguration, explanationModes, configurationExplanationText } = await import('./src/configuration-explanation.js');
    const forMode = values.for ?? 'run';
    if (!explanationModes.includes(forMode as typeof explanationModes[number])) throw new Error('Expected --for run, tighten, observe or check');
    const report = await explainConfiguration({ configPath: values.config, limitsPath: values.limits, forMode: forMode as typeof explanationModes[number] });
    console.log(values.json ? JSON.stringify(report, null, 2) : configurationText(report, values.details ? configurationExplanationText(report) : undefined));
    process.exitCode = report.status === 'valid' ? 0 : 2;
    return;
  }
  if (mode === 'diagnose') {
    if (positionals.length !== 2 || values.config || values.limits || values.baseline || values.package || values.reason || values['keep-workspaces']) throw new Error('Expected diagnose RESULT [--output NEW_DIRECTORY] [--json]');
    const { diagnoseSuccess, saveSuccessDiagnostic } = await import('./src/success-diagnostics.js');
    const report = await diagnoseSuccess(positionals[1]);
    if (values.output) await saveSuccessDiagnostic(values.output, report);
    console.log(values.json ? JSON.stringify(report, null, 2) : diagnosticText(report, values.details));
    process.exitCode = report.status === 'diagnosed' ? 0 : 2;
    return;
  }
  if (values.reason !== undefined && mode !== 'adopt') throw new Error('--reason is only supported by adopt');
  if (mode === 'adopt') {
    if (positionals.length !== 2 || !values.config || !values.limits || values.package || values.baseline || values['keep-workspaces']) throw new Error('Expected adopt RESULT --config FILE --limits TRUSTED_FILE');
    const { adopt } = await import('./src/adoption.js');
    const adopted = await adopt({ source: positionals[1], configPath: values.config, limitsPath: values.limits, output: values.output, reason: values.reason });
    const record = await readResult(adopted.file), summary = explainResult(record);
    console.log(values.json ? JSON.stringify({ id: adopted.manifest.id, file: adopted.file, tasks: adopted.manifest.baseline.selections, task_executions: 0, installations: 0, summary }, null, 2) : terminalText(terminalView(record, summary), { details: values.details }));
    return;
  }
  if (mode === 'compare' || mode === 'inspect') {
    if (values.config || values.limits || values.baseline || values['keep-workspaces']) throw new Error('compare/inspect use saved reports only; execution options are not supported');
    if (mode === 'compare') {
      if (positionals.length !== 3 || values.package) throw new Error('Expected compare BEFORE_USAGE_JSON AFTER_USAGE_JSON');
      const report = await compareSavedUsage(positionals[1], positionals[2]);
      if (values.output) await saveComparison(values.output, report);
      const record = comparisonRecord(path.resolve(values.output ?? '.', 'comparison.json'), report);
      const view = terminalView(record, explainResult(record));
      if (!values.output) view.result = '';
      view.lines.unshift('比较：' + report.before.file + ' → ' + report.after.file);
      console.log(values.json ? JSON.stringify(report, null, 2) : terminalText(view, { details: values.details }));
      process.exitCode = report.status === 'compared' ? 0 : 2;
    } else {
      if (positionals.length !== 2 || values.output) throw new Error('Expected inspect REPORT_JSON_OR_DIRECTORY [--package NAME] [--json]');
      const file = path.resolve(positionals[1]);
      if (values.package) {
        const report = inspectPackage(await loadUsage(file), values.package, file);
        console.log(values.json ? JSON.stringify(report, null, 2) : packageText(report, values.details));
        process.exitCode = report.status === 'partial' ? 2 : report.found ? 0 : 1;
      } else {
        const record = await readResult(file), report = explainResult(record);
        console.log(values.json ? JSON.stringify(report, null, 2) : terminalText(terminalView(record, report), { details: values.details, inspect: true }));
        process.exitCode = report.analysis.status === 'partial' ? 2 : 0;
      }
    }
    return;
  }
  if (positionals.length !== 1 || !['run', 'tighten', 'doctor', 'check', 'observe'].includes(mode)) throw new Error('Expected doctor, run, tighten, check or observe. See --help.');
  if (values.package) throw new Error('--package is only supported by inspect');
  if (mode !== 'doctor' && (!values.config || !values.limits)) throw new Error('--config and --limits are required');
  if (mode === 'doctor' && (values.config || values.limits)) throw new Error('doctor uses built-in fixtures; use run to check a project configuration');
  if (mode !== 'check' && mode !== 'observe' && values.baseline) throw new Error('--baseline is only supported by check and observe');
  const { runExperiment } = await import('./src/engine.js');
  const progress = progressWriter(process.stderr);
  const progressOptions = values.details ? { onProgress: progress.message } : { onProgressEvent: progress.event };
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let doctorProject: string | undefined;
  try {
    if (mode === 'observe') {
      const { runObservation } = await import('./src/observe-command.js');
      const report = await runObservation({ configPath: values.config!, limitsPath: values.limits!, baselinePath: values.baseline, output: values.output,
        keepWorkspaces: values['keep-workspaces'], saveArtifacts: values['save-artifacts'], signal: controller.signal, ...progressOptions });
      progress.finish();
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(terminalText(await readPublishedTerminal(report.output), { details: values.details }));
      }
      process.exitCode = controller.signal.aborted ? 130 : report.status === 'observed' ? 0 : report.status === 'failed' ? 1 : 2;
      return;
    }
    if (mode === 'check') {
      const { runRegression } = await import('./src/regression.js');
      const report = await runRegression({ configPath: values.config!, limitsPath: values.limits!, baselinePath: values.baseline, output: values.output, keepWorkspaces: values['keep-workspaces'], saveArtifacts: values['save-artifacts'], signal: controller.signal, ...progressOptions });
      progress.finish();
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(terminalText(await readPublishedTerminal(report.output), { details: values.details }));
        if (report.candidate_config && report.status !== 'compatible') console.log(`待审阅方案：${cleanText(path.join(report.output, report.candidate_config))}`);
      }
      process.exitCode = controller.signal.aborted ? 130 : report.status === 'compatible' ? 0 : report.status === 'regressed' || report.status === 'review_required' ? 1 : 2;
      return;
    }
    let input;
    if (mode === 'doctor') {
      doctorProject = await mkdtemp(path.join(os.tmpdir(), 'permsift-doctor-'));
      await writeFile(path.join(doctorProject, 'doctor.cjs'), "require('node:fs').writeFileSync('result.json', JSON.stringify({sandbox:'working'}));\n");
      const config = configSchema.parse({ schema_version: 1, scenarios: [{ id: 'doctor', command: [process.execPath, 'doctor.cjs'], initial_write_grants: ['@workspace'], assertions: [{ type: 'json_equals', path: '@workspace/result.json', pointer: '/sandbox', value: 'working' }] }] });
      const limits = limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace'], repetitions: 1, budget_seconds: 60 });
      input = { config, limits, project: doctorProject, configFile: '', limitsFile: '' };
    }
    const report = await runExperiment({ mode: mode as 'run' | 'tighten' | 'doctor', configPath: values.config, limitsPath: values.limits, input, output: values.output, keepWorkspaces: values['keep-workspaces'], saveArtifacts: values['save-artifacts'], signal: controller.signal, ...progressOptions });
    progress.finish();
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(terminalText(await readPublishedTerminal(report.output), { details: values.details }));
    }
    process.exitCode = controller.signal.aborted ? 130 : report.status === 'verified' ? 0 : report.status === 'failed' ? 1 : 2;
  } finally {
    progress.finish();
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (doctorProject) await rm(doctorProject, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(`Permsift: ${cleanText(error instanceof Error ? error.message : String(error))}`); process.exitCode = 2; });
