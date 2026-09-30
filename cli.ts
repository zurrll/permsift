#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema, limitsSchema } from './src/config.js';
import { runExperiment, VERSION } from './src/engine.js';

const help = `Permsift ${VERSION} — Test tasks. Trim permissions.

Usage:
  permsift doctor [--output NEW_DIRECTORY] [--json]
  permsift run --config FILE --limits TRUSTED_FILE [options]
  permsift tighten --config FILE --limits TRUSTED_FILE [options]

Options:
  --output DIR       Evidence directory; must not already exist
  --keep-workspaces  Preserve disposable workspaces for inspection
  --json             Print the full report as JSON (progress goes to stderr)
  --help             Show help
  --version          Print version

macOS only. No unsandboxed fallback. Project commands run offline.
Limits must be explicitly supplied from a location you trust.
Exit: 0 verified, 1 task/boundary failure, 2 invalid setup/incomplete, 130 interrupted.
`;
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, limits: { type: 'string' }, output: { type: 'string' },
    'keep-workspaces': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
  } });
  if (values.version) { console.log(VERSION); return; }
  if (values.help || positionals.length === 0) { console.log(help); return; }
  const mode = positionals[0];
  if (positionals.length !== 1 || !['run', 'tighten', 'doctor'].includes(mode)) throw new Error('Expected doctor, run or tighten. See --help.');
  if (mode !== 'doctor' && (!values.config || !values.limits)) throw new Error('--config and --limits are required');
  if (mode === 'doctor' && (values.config || values.limits)) throw new Error('doctor uses built-in fixtures; use run to check a project configuration');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let doctorProject: string | undefined;
  try {
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
      for (const [id, grants] of Object.entries(report.policies)) {
        console.log(`  ${id} write: ${grants.join(', ') || '(no variable write grants)'}`);
        if (report.read_modes[id] === 'explicit') console.log(`  ${id} read: ${report.read_policies[id].join(', ') || '(no project file/data read grants)'}`);
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
