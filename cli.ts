#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema, limitsSchema } from './src/config.js';
import { VERSION } from './src/version.js';
import { loadUsage } from './src/usage-report.js';
import { inspectPackage, inspectionMarkdown } from './src/usage-inspection.js';
import { compareSavedUsage, offlineComparisonMarkdown, saveComparison } from './src/offline-usage.js';
import { readResult, comparisonRecord } from './src/result-reader.js';
import { explainResult, summaryMarkdown, summaryText } from './src/result-explanation.js';
import { readPublishedSummary } from './src/result-output.js';

const help = `Permsift ${VERSION} — Test tasks. Trim permissions.

Usage:
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

Options:
  --output DIR       Execution: new evidence directory; adopt: reusable baseline store
  --save-artifacts   Save bounded final output bytes for optional offline success diagnostics
  --keep-workspaces  Preserve disposable workspaces for inspection
  --json             Print the full report as JSON (progress goes to stderr)
  --baseline FILE    check: verified report.json, adopted baseline.json or store; observe: previous usage.json for comparison
  --reason TEXT      adopt: explanation retained with the explicit selection
  --package NAME     inspect: exact package name, all installation instances across tasks
  --for MODE         explain: preview execution mode (default: run); no task or installation
  --help             Show help
  --version          Print version

Task execution requires macOS. No unsandboxed fallback. Task commands run offline;
optional npm install stages use explicit trusted domain grants.
Limits must be explicitly supplied from a location you trust.
compare/inspect/diagnose only read saved reports; no sandbox, installation or task execution.
explain only reads configuration/limits and resolves project; exit 0 statically valid, 2 invalid.
adopt saves bounded JSON evidence and a selection; no task, installation or permission search.
Exit: 0 verified/compatible/observed/adopted, 1 failure/regression/changed terms requiring review, 2 invalid setup/inconclusive/incomplete capture, 130 interrupted.
Offline exit: 0 complete analysis (differences allowed), 1 inspect found no instance,
2 invalid report or partial analysis. Overview exit codes describe saved-material analysis,
not whether the recorded task passed. Source not collected stays distinct from no record.
`;
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, limits: { type: 'string' }, output: { type: 'string' },
    'keep-workspaces': { type: 'boolean' }, 'save-artifacts': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    baseline: { type: 'string' },
    package: { type: 'string' }, reason: { type: 'string' }, for: { type: 'string' },
  } });
  if (values.version) { console.log(VERSION); return; }
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const mode = positionals[0];
  if (values.for !== undefined && mode !== 'explain') throw new Error('--for is only supported by explain');
  if (values['save-artifacts'] && !['run', 'tighten', 'check', 'observe'].includes(mode)) throw new Error('--save-artifacts is only supported by run/tighten/check/observe');
  if (mode === 'explain') {
    if (positionals.length !== 1 || !values.config || !values.limits || values.output || values.baseline || values.package || values.reason || values['keep-workspaces']) throw new Error('Expected explain --config FILE --limits TRUSTED_FILE [--for run|tighten|observe|check] [--json]');
    const { explainConfiguration, explanationModes, configurationExplanationText } = await import('./src/configuration-explanation.js');
    const forMode = values.for ?? 'run';
    if (!explanationModes.includes(forMode as typeof explanationModes[number])) throw new Error('Expected --for run, tighten, observe or check');
    const report = await explainConfiguration({ configPath: values.config, limitsPath: values.limits, forMode: forMode as typeof explanationModes[number] });
    console.log(values.json ? JSON.stringify(report, null, 2) : configurationExplanationText(report));
    process.exitCode = report.status === 'valid' ? 0 : 2;
    return;
  }
  if (mode === 'diagnose') {
    if (positionals.length !== 2 || values.config || values.limits || values.baseline || values.package || values.reason || values['keep-workspaces']) throw new Error('Expected diagnose RESULT [--output NEW_DIRECTORY] [--json]');
    const { diagnoseSuccess, successDiagnosticMarkdown, saveSuccessDiagnostic } = await import('./src/success-diagnostics.js');
    const report = await diagnoseSuccess(positionals[1]);
    if (values.output) await saveSuccessDiagnostic(values.output, report);
    console.log(values.json ? JSON.stringify(report, null, 2) : successDiagnosticMarkdown(report));
    process.exitCode = report.status === 'diagnosed' ? 0 : 2;
    return;
  }
  if (values.reason !== undefined && mode !== 'adopt') throw new Error('--reason is only supported by adopt');
  if (mode === 'adopt') {
    if (positionals.length !== 2 || !values.config || !values.limits || values.package || values.baseline || values['keep-workspaces']) throw new Error('Expected adopt RESULT --config FILE --limits TRUSTED_FILE');
    const { adopt } = await import('./src/adoption.js');
    const adopted = await adopt({ source: positionals[1], configPath: values.config, limitsPath: values.limits, output: values.output, reason: values.reason });
    const summary = explainResult(await readResult(adopted.file));
    console.log(values.json ? JSON.stringify({ id: adopted.manifest.id, file: adopted.file, tasks: adopted.manifest.baseline.selections, task_executions: 0, installations: 0, summary }, null, 2) : summaryMarkdown(summary));
    return;
  }
  if (mode === 'compare' || mode === 'inspect') {
    if (values.config || values.limits || values.baseline || values['keep-workspaces']) throw new Error('compare/inspect use saved reports only; execution options are not supported');
    if (mode === 'compare') {
      if (positionals.length !== 3 || values.package) throw new Error('Expected compare BEFORE_USAGE_JSON AFTER_USAGE_JSON');
      const report = await compareSavedUsage(positionals[1], positionals[2]);
      if (values.output) await saveComparison(values.output, report);
      console.log(values.json ? JSON.stringify(report, null, 2) : summaryMarkdown(explainResult(comparisonRecord(path.resolve(values.output ?? '.', 'comparison.json'), report))) + '\n' + offlineComparisonMarkdown(report));
      process.exitCode = report.status === 'compared' ? 0 : 2;
    } else {
      if (positionals.length !== 2 || values.output) throw new Error('Expected inspect REPORT_JSON_OR_DIRECTORY [--package NAME] [--json]');
      const file = path.resolve(positionals[1]);
      if (values.package) {
        const report = inspectPackage(await loadUsage(file), values.package, file);
        console.log(values.json ? JSON.stringify(report, null, 2) : inspectionMarkdown(report));
        process.exitCode = report.status === 'partial' ? 2 : report.found ? 0 : 1;
      } else {
        const report = explainResult(await readResult(file));
        console.log(values.json ? JSON.stringify(report, null, 2) : summaryMarkdown(report));
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
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let doctorProject: string | undefined;
  try {
    if (mode === 'observe') {
      const { runObservation } = await import('./src/observe-command.js');
      const report = await runObservation({ configPath: values.config!, limitsPath: values.limits!, baselinePath: values.baseline, output: values.output,
        keepWorkspaces: values['keep-workspaces'], saveArtifacts: values['save-artifacts'], signal: controller.signal, onProgress: message => console.error(message) });
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log('\n' + summaryText(await readPublishedSummary(report.output)));
        console.log(`Overview: ${path.join(report.output, 'summary.md')}`);
        console.log(`Usage: ${path.join(report.output, 'usage.md')}`);
        console.log(`Execution evidence: ${path.join(report.output, 'report.md')}`);
      }
      process.exitCode = controller.signal.aborted ? 130 : report.status === 'observed' ? 0 : report.status === 'failed' ? 1 : 2;
      return;
    }
    if (mode === 'check') {
      const { runRegression } = await import('./src/regression.js');
      const report = await runRegression({ configPath: values.config!, limitsPath: values.limits!, baselinePath: values.baseline, output: values.output, keepWorkspaces: values['keep-workspaces'], saveArtifacts: values['save-artifacts'], signal: controller.signal, onProgress: message => console.error(message) });
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`\n${report.status.toUpperCase()} · ${report.trials} executions · input changed: ${report.inputs.input_changed ?? 'unknown'}`);
        console.log(summaryText(await readPublishedSummary(report.output)));
        if (report.error) console.error(report.error);
        console.log(`Overview: ${path.join(report.output, 'summary.md')}`);
        console.log(`Report: ${path.join(report.output, 'report.md')}`);
        if (report.status === 'compatible') console.log(`Policy: ${path.join(report.output, 'compatible.yaml')}`);
        if (report.candidate_config && report.status !== 'compatible') console.log(`Review suggestion: ${path.join(report.output, report.candidate_config)}`);
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
    const report = await runExperiment({ mode: mode as 'run' | 'tighten' | 'doctor', configPath: values.config, limitsPath: values.limits, input, output: values.output, keepWorkspaces: values['keep-workspaces'], saveArtifacts: values['save-artifacts'], signal: controller.signal, onProgress: message => console.error(message) });
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`\n${report.status.toUpperCase()} · ${report.trials.length} executions`);
      if (report.timings) {
        const largest = Object.entries(report.timings.phases).sort((a, b) => b[1].duration_ms - a[1].duration_ms)[0];
        console.log(`Time: ${(report.timings.total_ms / 1000).toFixed(1)} s${largest ? `; largest operation: ${largest[0]} ${(largest[1].duration_ms / 1000).toFixed(1)} s` : ''}`);
      }
      console.log(summaryText(await readPublishedSummary(report.output)));
      if (report.error) console.error(report.error);
      const unsuccessful = report.trials.filter(t => t.verdict !== 'pass');
      if (unsuccessful.length) console.log(`  ${unsuccessful.length} failed/unknown trials explained in the report (with recovery evidence when available).`);
      if (!report.baseline_verified && unsuccessful[0]?.diagnosis) console.error(unsuccessful[0].diagnosis.summary);
      console.log(`Overview: ${path.join(report.output, 'summary.md')}`);
      console.log(`Report: ${path.join(report.output, 'report.md')}`);
      if (mode !== 'doctor') console.log(`Policy: ${path.join(report.output, report.status === 'verified' ? 'recommended.yaml' : 'unverified-candidate.yaml')}`);
    }
    process.exitCode = controller.signal.aborted ? 130 : report.status === 'verified' ? 0 : report.status === 'failed' ? 1 : 2;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (doctorProject) await rm(doctorProject, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(`Permsift: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; });
