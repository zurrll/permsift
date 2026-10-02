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

const help = `Permsift ${VERSION} — Test tasks. Trim permissions.

Usage:
  permsift doctor [--output NEW_DIRECTORY] [--json]
  permsift run --config FILE --limits TRUSTED_FILE [options]
  permsift tighten --config FILE --limits TRUSTED_FILE [options]
  permsift check --config FILE --baseline REPORT_JSON --limits TRUSTED_FILE [options]
  permsift observe --config FILE --limits TRUSTED_FILE [--baseline USAGE_JSON] [options]
  permsift compare BEFORE_USAGE_JSON AFTER_USAGE_JSON [--output NEW_DIRECTORY] [--json]
  permsift inspect USAGE_JSON --package NAME [--json]

Options:
  --output DIR       Evidence directory; must not already exist
  --keep-workspaces  Preserve disposable workspaces for inspection
  --json             Print the full report as JSON (progress goes to stderr)
  --baseline FILE    check: verified report.json; observe: previous usage.json for comparison
  --package NAME     inspect: exact package name, all installation instances across tasks
  --help             Show help
  --version          Print version

Task execution requires macOS. No unsandboxed fallback. Task commands run offline;
optional npm install stages use explicit trusted domain grants.
Limits must be explicitly supplied from a location you trust.
compare/inspect only read saved usage reports; no sandbox, installation or task execution.
Exit: 0 verified/compatible/observed, 1 failure/regression, 2 invalid setup/inconclusive/incomplete capture, 130 interrupted.
Offline exit: 0 complete analysis (differences allowed), 1 inspect found no instance,
2 invalid report or partial analysis. Source not collected stays distinct from no record.
`;
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, limits: { type: 'string' }, output: { type: 'string' },
    'keep-workspaces': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    baseline: { type: 'string' },
    package: { type: 'string' },
  } });
  if (values.version) { console.log(VERSION); return; }
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const mode = positionals[0];
  if (mode === 'compare' || mode === 'inspect') {
    if (values.config || values.limits || values.baseline || values['keep-workspaces']) throw new Error('compare/inspect use saved reports only; execution options are not supported');
    if (mode === 'compare') {
      if (positionals.length !== 3 || values.package) throw new Error('Expected compare BEFORE_USAGE_JSON AFTER_USAGE_JSON');
      const report = await compareSavedUsage(positionals[1], positionals[2]);
      if (values.output) await saveComparison(values.output, report);
      console.log(values.json ? JSON.stringify(report, null, 2) : offlineComparisonMarkdown(report));
      process.exitCode = report.status === 'compared' ? 0 : 2;
    } else {
      if (positionals.length !== 2 || !values.package || values.output) throw new Error('Expected inspect USAGE_JSON --package NAME [--json]');
      const file = path.resolve(positionals[1]), report = inspectPackage(await loadUsage(file), values.package, file);
      console.log(values.json ? JSON.stringify(report, null, 2) : inspectionMarkdown(report));
      process.exitCode = report.status === 'partial' ? 2 : report.found ? 0 : 1;
    }
    return;
  }
  if (positionals.length !== 1 || !['run', 'tighten', 'doctor', 'check', 'observe'].includes(mode)) throw new Error('Expected doctor, run, tighten, check or observe. See --help.');
  if (values.package) throw new Error('--package is only supported by inspect');
  if (mode !== 'doctor' && (!values.config || !values.limits)) throw new Error('--config and --limits are required');
  if (mode === 'doctor' && (values.config || values.limits)) throw new Error('doctor uses built-in fixtures; use run to check a project configuration');
  if (mode === 'check' && !values.baseline) throw new Error('check requires --baseline REPORT_JSON');
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
        keepWorkspaces: values['keep-workspaces'], signal: controller.signal, onProgress: message => console.error(message) });
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`\n${report.status.toUpperCase()} · dependency usage · one execution per task`);
        for (const task of report.tasks) {
          if (task.capture_status === 'not_run') console.log(`  ${task.task}: not observed`);
          else {
            console.log(`  ${task.task}: installed ${task.inventory.packages.length} instances; Node module-load records ${task.loaded_packages.length} · task ${task.verdict} · module capture ${task.capture_status}`);
            console.log(task.compilation ? `    TypeScript inputs: ${task.compilation.files.length} files / ${task.compilation.packages.length} package instances · capture ${task.compilation.capture_status}` : '    TypeScript inputs: not collected');
            console.log(task.bundling ? `    esbuild: ${task.bundling.inputs.length} inputs / ${task.bundling.outputs.length} outputs / ${task.bundling.packages.length} input package instances · capture ${task.bundling.capture_status}` : '    esbuild: not collected');
            console.log('    Module hooks miss types, resource reads and native internals. Missing module records do not mean unused packages.');
          }
        }
        if (report.comparison) for (const t of report.comparison.tasks) console.log(`  ${t.task}: ${t.state}; newly observed ${t.added.length}, no longer observed ${t.removed.length}, version changes ${t.version_changes.length}`);
        if (report.comparison) for (const t of report.comparison.tasks) if (t.compilation) {
          console.log(`  ${t.task}: compiler-input comparison ${t.compilation.state}; newly recorded packages ${t.compilation.added.length}, no longer recorded ${t.compilation.removed.length}, changed explanations ${t.compilation.explanation_changes.length}`);
          for (const warning of t.compilation.warnings) console.log(`    ${warning}`);
        }
        console.log('Sources are reported separately. Missing observations do not justify deletion or permission removal.');
        if (report.comparison) for (const t of report.comparison.tasks) if (t.bundling) {
          console.log(`  ${t.task}: build-metadata comparison ${t.bundling.state}; package versions changed ${t.bundling.version_changes.length}; output contributions changed ${t.bundling.contribution_changes.length}; external references changed ${t.bundling.external_changes.length}`);
          for (const warning of t.bundling.warnings) console.log(`    ${warning}`);
        }
        console.log(`Usage: ${path.join(report.output, 'usage.md')}`);
        console.log(`Execution evidence: ${path.join(report.output, 'report.md')}`);
      }
      process.exitCode = controller.signal.aborted ? 130 : report.status === 'observed' ? 0 : report.status === 'failed' ? 1 : 2;
      return;
    }
    if (mode === 'check') {
      const { runRegression } = await import('./src/regression.js');
      const report = await runRegression({ configPath: values.config!, limitsPath: values.limits!, baselinePath: values.baseline!, output: values.output, keepWorkspaces: values['keep-workspaces'], signal: controller.signal, onProgress: message => console.error(message) });
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`\n${report.status.toUpperCase()} · ${report.trials} executions · input changed: ${report.inputs.input_changed ?? 'unknown'}`);
        for (const task of report.tasks) {
          console.log(`  ${task.id}: ${task.status}${task.repair_stop ? ` · repair ${task.repair_stop}` : ''}`);
          if (task.reason) console.log(`    ${task.reason}`);
          if (task.suggestion) console.log(`    added reads: ${task.suggestion.added_read.join(', ') || '(none)'}; added writes: ${task.suggestion.added_write.join(', ') || '(none)'}`);
          if (task.suggestion?.added_install_write) console.log(`    added install writes: ${task.suggestion.added_install_write.join(', ') || '(none)'}`);
          if (task.suggestion?.added_network) console.log(`    added install domains: ${task.suggestion.added_network.join(', ') || '(none)'}`);
        }
        if (report.error) console.error(report.error);
        console.log(`Report: ${path.join(report.output, 'report.md')}`);
        if (report.status === 'compatible') console.log(`Policy: ${path.join(report.output, 'compatible.yaml')}`);
        if (report.status === 'regressed' && report.tasks.every(t => t.status === 'compatible' || t.suggestion)) console.log(`Review suggestion: ${path.join(report.output, 'suggested.yaml')}`);
      }
      process.exitCode = controller.signal.aborted ? 130 : report.status === 'compatible' ? 0 : report.status === 'regressed' ? 1 : 2;
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
    const report = await runExperiment({ mode: mode as 'run' | 'tighten' | 'doctor', configPath: values.config, limitsPath: values.limits, input, output: values.output, keepWorkspaces: values['keep-workspaces'], signal: controller.signal, onProgress: message => console.error(message) });
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`\n${report.status.toUpperCase()} · ${report.trials.length} executions`);
      if (report.timings) {
        const largest = Object.entries(report.timings.phases).sort((a, b) => b[1].duration_ms - a[1].duration_ms)[0];
        console.log(`Time: ${(report.timings.total_ms / 1000).toFixed(1)} s${largest ? `; largest operation: ${largest[0]} ${(largest[1].duration_ms / 1000).toFixed(1)} s` : ''}`);
      }
      if (mode === 'tighten') console.log(`Search complete: ${report.search_complete}`);
      for (const [id, grants] of Object.entries(report.policies)) {
        console.log(`  ${id} write: ${grants.join(', ') || '(no variable write grants)'}`);
        if (report.install_policies[id]) { console.log(`  ${id} install write: ${report.install_policies[id].join(', ') || '(none)'}`); const stats = report.installation_stats[id]; if (stats) console.log(`  ${id} npm executions: ${stats.executed}; installed snapshot reuses: ${stats.reused}`); }
        if (report.read_modes[id] === 'explicit') console.log(`  ${id} read: ${report.read_policies[id].join(', ') || '(no project file/data read grants)'}`);
        if (report.network_searches[id] || report.network_policies[id].length) console.log(`  ${id} install network: ${report.network_policies[id].join(', ') || '(offline)'}`);
      }
      if (report.error) console.error(report.error);
      const unsuccessful = report.trials.filter(t => t.verdict !== 'pass');
      if (unsuccessful.length) console.log(`  ${unsuccessful.length} failed/unknown trials explained in the report (with recovery evidence when available).`);
      if (!report.baseline_verified && unsuccessful[0]?.diagnosis) console.error(unsuccessful[0].diagnosis.summary);
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
