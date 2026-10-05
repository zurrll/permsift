import path from 'node:path';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import { configSchema, assertionName, isFileAssertion, type Assertion } from './config.js';
import { evaluateAssertion, type AssertionEvaluation } from './assertions.js';
import { readResult, type ResultRecord, type ExecutionView } from './result-reader.js';
import { canonical, legacyHash } from './model/identity.js';
import { readMaterial, materialSchema, bytesHash, MATERIAL_LIMITS, type MaterialSource } from './success-materials.js';
import { mutationsFor, type Mutation } from './success-mutations.js';
import { saveJson } from './filesystem.js';

export const DIAGNOSTIC_LIMITS = Object.freeze({ mutations: 256, milliseconds: 5000, task_executions: 0, installations: 0 });
type Evaluation = AssertionEvaluation & { index: number };
type ArtifactDiagnostic = { path: string; state: 'diagnosed' | 'not_saved' | 'inconclusive'; reason?: string;
  assertions: { index: number; definition: Assertion }[]; control?: Evaluation[];
  skipped_perturbations: { kind: string; reason: string }[];
  mutations: { kind: string; description: string; intended: Mutation['intended']; checks: Evaluation[]; artifact_checks_reject: boolean; all_artifact_assertions_reject: boolean }[];
  findings: string[] };
export type SuccessDiagnostic = { schema_version: 1; kind: 'permsift_success_diagnostic'; status: 'diagnosed' | 'partial'; source: string;
  duration_ms: number; limits: typeof DIAGNOSTIC_LIMITS; tasks: { task: string; state: 'diagnosed' | 'not_saved' | 'inconclusive';
    reason?: string; sample?: MaterialSource; final_repetitions?: number; sample_rule?: string; policy_id?: string; artifacts: ArtifactDiagnostic[] }[]; limitations: string[] };
const noticeSchema = z.union([
  z.object({ state: z.literal('saved'), manifest: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/), duration_ms: z.number(), bytes: z.number().int().nonnegative() }).strict(),
  z.object({ state: z.literal('not_saved'), reason: z.string(), duration_ms: z.number() }).strict(),
]);
const passes = (v: ExecutionView) => v.native && v.facts.reported_verdict.state === 'recorded' && v.facts.reported_verdict.value === 'pass' &&
  (v.facts.conditions.requirements.state !== 'recorded' || !v.facts.conditions.requirements.value.install ||
    v.facts.installation.state === 'recorded' && v.facts.installation.value.reported_verdict === 'pass' && v.facts.installation.value.reused.state === 'recorded' && !v.facts.installation.value.reused.value) &&
  v.facts.outcomes.task.status === 'pass' && v.facts.outcomes.boundaries.status === 'pass' && (!v.facts.outcomes.protections || v.facts.outcomes.protections.status === 'pass');
const message = (e: unknown) => String(e).slice(0, 1800);
const evaluate = (defs: Assertion[], contents: Map<string, string | undefined>): Evaluation[] => defs.flatMap((a, index) => isFileAssertion(a) ? [{ index, ...evaluateAssertion(a, contents.get(a.path)) }] : []);

/** Saved outputs only. Never launches a process, follows workspace paths, or changes a policy. */
export async function diagnoseSuccess(selected: string): Promise<SuccessDiagnostic> {
  const started = Date.now(), deadline = started + DIAGNOSTIC_LIMITS.milliseconds;
  const record = await readResult(selected, { verificationOnly: true });
  const result: SuccessDiagnostic = { schema_version: 1, kind: 'permsift_success_diagnostic', status: 'diagnosed', source: record.file,
    duration_ms: 0, limits: DIAGNOSTIC_LIMITS, tasks: [], limitations: [
      'Only retained artifact assertions are re-evaluated. Task commands, internal behavior tests, input changes and report honesty are outside this diagnostic.',
      'A rejected malformed report proves format rejection, not business-content verification. Passing a perturbation does not establish a business defect.',
      'One explicitly identified final verification repetition is sampled per task. Other repetitions are validated as evidence but their output bytes are not sampled.',
      'Hashes check retained-material consistency; they do not authenticate the report producer. No test-quality score or permission-safety conclusion is produced.',
    ] };
  let trials = 0;
  const gap = (task: string, reason: string, state: 'not_saved' | 'inconclusive' = 'inconclusive') => {
    result.status = 'partial'; result.tasks.push({ task, state, reason, artifacts: [] });
  };
  const read = async (root: string, relative: string, max = 1_048_576) => readMaterial(root, path.join(root, relative), max, deadline);
  const inspect = async (run: ResultRecord, onlyTask?: string) => {
    const model = run.model;
    if (!model || !['run', 'tighten', 'observe'].includes(model.workflow.kind)) { gap(onlyTask ?? '(result)', 'Select run/tighten/observe evidence or a verified check result'); return; }
    for (const task of model.tasks.filter(t => !onlyTask || t.key === onlyTask)) {
      const workflow = model.workflow, phase = workflow.kind === 'tighten' ? 'final' : workflow.kind === 'observe' ? 'observe' : 'baseline';
      const proofs = run.executions.filter(v => v.task === task.key && v.facts.origin.phase === phase);
      const root = path.dirname(run.file);
      if (workflow.reported_status !== 'verified' || workflow.verification.state !== 'recorded' || !workflow.verification.value.final_verified ||
        !workflow.verification.value.baseline_verified || !proofs.length || !proofs.every(v => v.facts.reported_verdict.state === 'recorded' && v.facts.reported_verdict.value === 'pass')) { gap(task.key, 'Complete passing final verification is unavailable; no earlier/control/candidate outputs substituted'); continue; }
      if (proofs.every(v => !v.native)) { gap(task.key, 'Native final identities and optional artifact bytes were not retained; no historical workspace is followed', 'not_saved'); continue; }
      if (!proofs.every(passes)) { gap(task.key, 'Final verification lacks complete native task/boundary/protection evidence'); continue; }
      if (task.definition.state !== 'recorded') { gap(task.key, 'Success conditions were not retained', 'not_saved'); continue; }
      let definitions = task.definition.value.success_conditions;
      let addedRow: SuccessDiagnostic['tasks'][number] | undefined;
      try {
        const rawInputs = JSON.parse((await read(root, 'inputs.json')).toString('utf8'));
        for (const key of ['config', 'limits'] as const) {
          const recorded = model.source.recorded_hashes[key];
          if (recorded.state !== 'recorded' || legacyHash(rawInputs[key]) !== recorded.value) throw new Error('Retained diagnostic inputs changed or do not match recorded ' + key + ' hash');
        }
        const inputs = z.object({ config: configSchema, limits: z.object({ repetitions: z.number().int().min(1).max(10) }) }).parse(rawInputs);
        definitions = inputs.config.scenarios.find(s => s.id === task.key)!.assertions;
        if (proofs.length !== (workflow.kind === 'observe' ? 1 : inputs.limits.repetitions)) throw new Error('Final verification repetitions are incomplete');
        const policyId = workflow.current_policies.find(p => p.task_key === task.key)?.policy_id;
        if (!policyId || !proofs.every(v => v.policy?.id === policyId)) throw new Error('Final proof does not match the selected policy');
        const chosen = proofs[0];
        const retained = chosen.facts.assertions;
        if (retained.state !== 'recorded' || proofs.some(p => p.facts.assertions.state !== 'recorded' || canonical(p.facts.assertions.value.map(c => c.name)) !== canonical(definitions.map(assertionName)))) throw new Error('Final proof does not cover the configured assertion sequence');
        if (!definitions.some(isFileAssertion)) { result.tasks.push({ task: task.key, state: 'diagnosed', reason: 'Exit-code checks only; no artifact assertions to perturb. Completed process evidence was checked, task-internal tests were not re-run.', artifacts: [] }); continue; }
        const trial = path.basename(chosen.reference, '.json');
        if (!/^[a-zA-Z0-9_-]+$/.test(trial)) throw new Error('Invalid final trial reference');
        const evidence = z.object({ success_artifacts: noticeSchema.optional() }).parse(JSON.parse((await read(root, `evidence/${trial}.json`, 32_000_000)).toString('utf8')));
        const notice = evidence.success_artifacts;
        if (!notice || notice.state === 'not_saved') { gap(task.key, notice?.reason ?? 'Artifact bytes were not saved; re-running a task is not part of offline diagnosis', 'not_saved'); continue; }
        if (notice.manifest !== `artifacts/${trial}/manifest.json`) throw new Error('Material reference does not match selected final trial');
        const manifest = materialSchema.parse(JSON.parse((await read(root, notice.manifest)).toString('utf8')));
        if (bytesHash(Buffer.from(JSON.stringify(manifest))) !== notice.hash || manifest.source.trial !== trial || manifest.source.task !== task.key || manifest.source.task_id !== task.id ||
          manifest.source.execution_id !== chosen.facts.id || manifest.source.policy_id !== policyId || manifest.source.phase !== phase) throw new Error('Retained material identity/hash does not match final verification');
        const paths = [...new Set(definitions.filter(isFileAssertion).map(a => a.path))];
        if (new Set(manifest.files.map(f => f.path)).size !== manifest.files.length || canonical([...manifest.files.map(f => f.path)].sort()) !== canonical([...paths].sort())) throw new Error('Material paths do not match success conditions');
        const saved = manifest.files.filter(f => f.state === 'saved');
        if (saved.length > manifest.limits.files || new Set(saved.map(f => f.file)).size !== saved.length || saved.some(f => f.bytes > manifest.limits.file_bytes) ||
          saved.reduce((sum, f) => sum + f.bytes, 0) !== manifest.total_bytes || manifest.total_bytes > manifest.limits.total_bytes || manifest.total_bytes !== notice.bytes) throw new Error('Material byte/count budget metadata is inconsistent');
        const row: SuccessDiagnostic['tasks'][number] = { task: task.key, state: 'diagnosed', sample: manifest.source, final_repetitions: proofs.length,
          sample_rule: 'First completed passing repetition of the selected final verification; no preliminary/search/control output substitution', policy_id: policyId, artifacts: [] };
        result.tasks.push(row); addedRow = row;
        const contents = new Map<string, string | undefined>();
        for (const file of manifest.files) {
          const artifact: ArtifactDiagnostic = { path: file.path, state: 'not_saved', assertions: definitions.flatMap((definition, index) => isFileAssertion(definition) && definition.path === file.path ? [{ index, definition }] : []), mutations: [], skipped_perturbations: [], findings: [] };
          row.artifacts.push(artifact);
          if (file.state === 'not_saved') { artifact.reason = file.reason; continue; }
          try {
            const bytes = await read(root, `artifacts/${trial}/${file.file}`, MATERIAL_LIMITS.file_bytes);
            if (bytes.length !== file.bytes || bytesHash(bytes) !== file.hash) throw new Error('Retained output bytes/hash mismatch');
            contents.set(file.path, bytes.toString('utf8'));
          } catch (e) { artifact.state = 'inconclusive'; artifact.reason = message(e); }
        }
        const fullControl = paths.every(p => contents.has(p)) ? evaluate(definitions, contents) : undefined;
        for (const artifact of row.artifacts) {
          if (!contents.has(artifact.path)) continue;
          artifact.control = evaluate(definitions, contents).filter(c => { const a = definitions[c.index]; return isFileAssertion(a) && a.path === artifact.path; });
          if (artifact.control.some(c => c.status !== 'pass') || fullControl?.some(c => c.status !== 'pass')) {
            artifact.state = 'inconclusive'; artifact.reason = 'Unmodified retained-material control did not pass; no mutation conclusions'; continue;
          }
          if (!fullControl) {
            artifact.state = 'inconclusive'; artifact.reason = 'Full unmodified assertion control unavailable because another artifact was not saved; no mutation conclusions'; continue;
          }
          artifact.state = 'diagnosed';
          let mutations: Mutation[];
          try { mutations = mutationsFor(contents.get(artifact.path)!, artifact.assertions.map(a => a.definition)); }
          catch (e) { artifact.state = 'inconclusive'; artifact.reason = 'Mutation preparation failed: ' + message(e); continue; }
          if (artifact.assertions.some(a => a.definition.type === 'file_contains') && !mutations.some(m => m.kind === 'marker_only')) artifact.skipped_perturbations.push({ kind: 'marker_only', reason: 'The retained file already consists only of the checked marker' });
          if (artifact.assertions.some(a => ['test_results', 'junit'].includes(a.definition.type))) {
            for (const kind of ['unexpected_failed', 'remove_unexpected']) if (!mutations.some(m => m.kind === kind)) artifact.skipped_perturbations.push({ kind, reason: 'No test outside an applicable expected-name list is present in this material' });
          }
          for (const mutation of mutations) {
            if (trials >= DIAGNOSTIC_LIMITS.mutations || Date.now() >= deadline) { artifact.state = 'inconclusive'; artifact.reason = 'Diagnostic mutation/time budget reached; remaining perturbations not evaluated'; break; }
            trials++;
            const modified = new Map(contents); modified.set(artifact.path, mutation.content);
            const all = evaluate(definitions, modified), checks = all.filter(c => { const a = definitions[c.index]; return isFileAssertion(a) && a.path === artifact.path; });
            artifact.mutations.push({ kind: mutation.kind, description: mutation.description, intended: mutation.intended, checks,
              artifact_checks_reject: checks.some(c => c.status !== 'pass'), all_artifact_assertions_reject: all.some(c => c.status !== 'pass') });
          }
          const empty = artifact.mutations.find(m => m.kind === 'empty_file');
          if (empty && !empty.artifact_checks_reject) artifact.findings.push('The artifact checks accept an empty readable file. They check existence, not useful content; task-internal behavior tests were not re-run.');
          if (artifact.mutations.some(m => m.kind === 'unexpected_failed' && m.checks.some(c => c.cause === 'content_mismatch'))) artifact.findings.push('Tests outside the expected-name list must also pass. Expected names are a required subset, not the only tests checked.');
          if (artifact.mutations.some(m => m.kind === 'remove_unexpected' && !m.artifact_checks_reject)) artifact.findings.push('Removing this non-expected test remains accepted; the configured expected-name list does not require that test.');
          if (artifact.mutations.some(m => m.kind === 'marker_only' && !m.artifact_checks_reject)) artifact.findings.push('Keeping only the checked text remains accepted. This identifies the content check scope; it does not prove the task would accept a broken build.');
          if (empty?.checks.some(c => c.cause === 'invalid_format')) artifact.findings.push('An empty file is rejected for invalid structured format. Semantic value/test changes are reported separately.');
          if (artifact.assertions.some(a => a.definition.type === 'file_exists')) artifact.findings.push('If nonempty or meaningful content is part of success, add a suitable content assertion or a task behavior check. Existence alone does not express that requirement.');
        }
        if (row.artifacts.some(a => a.state !== 'diagnosed')) { row.state = row.artifacts.some(a => a.state === 'inconclusive') ? 'inconclusive' : 'not_saved'; result.status = 'partial'; }
      } catch (e) {
        if (addedRow) { addedRow.state = 'inconclusive'; addedRow.reason = message(e); result.status = 'partial'; }
        else gap(task.key, message(e));
      }
    }
  };
  if (record.adoption) gap('(baseline)', 'Adoption retains verification JSON, not optional output bytes. Select the original execution result; offline diagnosis does not follow historical source locations.', 'not_saved');
  else if (record.model?.workflow.kind === 'check') {
    for (const task of record.model.workflow.comparisons) {
      if (task.reported_status === 'removed_task') continue;
      if (!['compatible', 'new_task_verified'].includes(task.reported_status) && !(task.reported_status === 'permission_change' && task.suggestion_verified.state === 'recorded' && task.suggestion_verified.value)) {
        gap(task.task_key, 'This check task has no accepted complete final verification'); continue;
      }
      const child = record.children.find(c => c.task === task.task_key);
      if (child?.result) await inspect(child.result, task.task_key);
      else gap(task.task_key, 'Check has no complete selected verification; no control/repair-search output substituted');
    }
  } else if (record.executionReport) await inspect(record.executionReport);
  else await inspect(record);
  result.duration_ms = Date.now() - started;
  return result;
}
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[|`\[\]\r\n]/g, ' ');
export function successDiagnosticMarkdown(report: SuccessDiagnostic): string {
  return ['# Success-condition diagnostic', '', `Analysis: **${report.status}**. Task executions: **0**; installations: **0**.`,
    `Source: ${escape(report.source)}`, '', ...report.tasks.flatMap(task => [
      `## ${escape(task.task)}`, '', `Material analysis: **${task.state}**. ${escape(task.reason ?? '')}`,
      ...task.sample ? [`Sample: ${task.sample.trial}; phase: ${task.sample.phase}; policy: ${task.policy_id}; final repetitions: ${task.final_repetitions}.`, task.sample_rule!, ''] : [''],
      ...task.artifacts.flatMap(a => [`### ${escape(a.path)}`, '', `Material: **${a.state}**. ${escape(a.reason ?? '')}`, '',
        ...a.assertions.map(x => `- Check ${x.index}: ${x.definition.type}${x.definition.type === 'json_equals' ? ' ' + escape(x.definition.pointer) : ''}`), '',
        '| Perturbation | Individual checks | These artifact checks | All retained artifact assertions | Failure causes |', '| --- | --- | --- | --- | --- |',
        ...a.mutations.map(m => `| ${escape(m.description)} | ${m.checks.map(c => `${c.index}: ${c.status}`).join(', ')} | ${m.artifact_checks_reject ? 'rejected' : 'accepted'} | ${m.all_artifact_assertions_reject ? 'rejected' : 'accepted'} | ${m.checks.filter(c => c.status !== 'pass').map(c => `${c.index}: ${c.cause}`).join(', ') || 'none'} |`), '',
        ...a.skipped_perturbations.map(s => `- Not applicable: ${s.kind}: ${s.reason}`), ...a.findings.map(f => '- ' + f), '']),
    ]), '## Scope', '', ...report.limitations.map(s => '- ' + s), '', `Host analysis: ${report.duration_ms.toFixed(1)} ms. No overall quality score.`, ''].join('\n');
}
export async function saveSuccessDiagnostic(directory: string, report: SuccessDiagnostic) {
  await fs.mkdir(path.dirname(path.resolve(directory)), { recursive: true });
  await fs.mkdir(directory, { mode: 0o700 });
  await saveJson(path.join(directory, 'diagnostic.json'), report);
  await fs.writeFile(path.join(directory, 'diagnostic.md'), successDiagnosticMarkdown(report), { mode: 0o600 });
}
