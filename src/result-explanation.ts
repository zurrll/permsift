import path from 'node:path';
import type { ExecutionView, ResultRecord, SavedComparison } from './result-reader.js';
import type { Evaluation, PolicyPlan, Saved } from './model/types.js';
import { canonical, freeze } from './model/identity.js';
import { escape } from './usage-comparison.js';
import { evaluateProtections } from './protection-facts.js';
import { recorded } from './model/identity.js';

export type EvidenceReference = { file: string; pointer: string; object_id?: string; availability?: 'not_supplied' };
export type Claim = { dimension: string; status: string; statement: string; evidence: EvidenceReference[];
  action: { text: string; command?: string[] } };
export type Decision = { permission: string; operation: Saved<string>; reported_decision: string;
  support: 'corroborated' | 'reported_only' | 'contradictory'; scope_change: 'reported_reduction' | 'reported_no_scope_change' | 'not_saved';
  before: Saved<string[]>; after: Saved<string[]>; candidate: string; recovery: string;
  evidence: EvidenceReference[]; action: string };
export type TaskSummary = { task: string; policy?: PolicyPlan; claims: Claim[]; decisions: Decision[];
  stages: { phase: string; reported_verdict: string; task: string; boundaries: string; protections?: string; retained: boolean; evidence: EvidenceReference[] }[] };
export type ResultSummary = { schema_version: 1; kind: 'permsift_result_summary'; source: { file: string; artifact_hash: string; format: string };
  workflow: { kind: string; reported_status: string } | null; analysis: { status: 'complete' | 'partial'; gaps: string[] };
  tasks: TaskSummary[]; claims: Claim[]; limitations: string[] };

function aggregate(values: Evaluation[]): Evaluation['status'] {
  if (!values.length) return 'not_run';
  if (values.some(v => v.status === 'fail')) return 'fail';
  if (values.every(v => v.status === 'pass')) return 'pass';
  if (values.some(v => v.status === 'unknown')) return 'unknown';
  if (values.every(v => v.status === 'not_run')) return 'not_run';
  return 'not_saved';
}
const present = <T>(v: Saved<T>) => v.state === 'recorded' ? v.value : undefined;
const verdict = (v?: ExecutionView) => v ? present(v.facts.reported_verdict) ?? 'not_saved' : 'not_saved';
const protectionStatus = (v: ExecutionView) => v.facts.outcomes.protections?.status ?? (v.agreement?.declaration.state === 'recorded' ? 'not_saved' : undefined);
const contradictoryPass = (v?: ExecutionView) => !!v && verdict(v) === 'pass' && ([v.facts.outcomes.task.status, v.facts.outcomes.boundaries.status].some(s => s === 'fail' || s === 'unknown' || s === 'not_run') || protectionStatus(v) !== undefined && protectionStatus(v) !== 'pass');
const fullyPassed = (v?: ExecutionView) => !!v && verdict(v) === 'pass' && v.facts.outcomes.task.status === 'pass' && v.facts.outcomes.boundaries.status === 'pass' && (protectionStatus(v) === undefined || protectionStatus(v) === 'pass');
const sameGrants = (a: PolicyPlan | undefined, b: PolicyPlan | undefined) => !!a && !!b &&
  canonical(a.task.write) === canonical(b.task.write) && present(a.task.read)?.mode === present(b.task.read)?.mode &&
  canonical(present(a.task.read)?.grants ?? null) === canonical(present(b.task.read)?.grants ?? null) &&
  canonical(present(a.installation)?.write ?? null) === canonical(present(b.installation)?.write ?? null) &&
  canonical(present(present(a.installation)?.network ?? { state: 'not_saved', reason: '' }) ?? null) === canonical(present(present(b.installation)?.network ?? { state: 'not_saved', reason: '' }) ?? null);

/** Pure projection: all conclusions/actions share the same typed inputs in JSON, terminal and Markdown. */
export function explainResult(result: ResultRecord): ResultSummary {
  const root = path.dirname(result.file);
  const ref = (record: ResultRecord, pointer: string, object_id?: string): EvidenceReference => ({ file: path.relative(root, record.file).split(path.sep).join('/'), pointer, ...object_id ? { object_id } : {} });
  const eref = (record: ResultRecord, v: ExecutionView, field: string): EvidenceReference => {
    // A report-only projection supports a reported verdict/absence of independent
    // detail; it must not cite an absent sidecar as if that file were supplied.
    if (!v.native && !record.model?.source.evidence_records.some(e => e.path === v.reference)) return ref(record, '/trials', v.facts.id);
    return { file: path.relative(root, path.join(path.dirname(record.file), v.reference)).split(path.sep).join('/'),
      pointer: v.native ? (field !== '/policy' ? '/execution' : '') + field : '', object_id: field === '/policy' ? v.policy?.id : v.facts.id };
  };
  const claim = (dimension: string, status: string, statement: string, evidence: EvidenceReference[], text: string, command?: string[]): Claim => ({ dimension, status, statement, evidence, action: { text, ...command ? { command } : {} } });
  const model = result.model;
  const summary: ResultSummary = { schema_version: 1, kind: 'permsift_result_summary',
    source: { file: path.basename(result.file), artifact_hash: result.artifact_hash, format: result.native ? 'native-execution-v' + result.native.schema_version : model?.source.format ?? 'usage-comparison-v1' },
    workflow: model ? { kind: model.workflow.kind, reported_status: model.workflow.reported_status } : result.comparisonOnly ? { kind: 'compare', reported_status: result.comparisonOnly.status } : null,
    analysis: { status: 'complete', gaps: [] }, tasks: [], claims: [], limitations: [] };
  const gap = (s: string) => { summary.analysis.status = 'partial'; summary.analysis.gaps.push(s); };
  function outcomes(task: TaskSummary, record: ResultRecord, values: ExecutionView[], scope: string) {
    for (const dimension of ['task', 'boundaries'] as const) {
      const status = aggregate(values.map(v => v.facts.outcomes[dimension]));
      const descriptions = dimension === 'task' ? 'process and declared success checks' : 'fixed sandbox probes and host controls';
      task.claims.push(claim(dimension, status, `${scope}: ${descriptions} ${status} across ${values.length} retained execution(s).`,
        values.length ? values.map(v => eref(record, v, v.native ? '/outcomes/' + dimension : dimension === 'task' ? '/task' : '/before')) : [ref(record, '/trials')],
        status === 'pass' ? 'Review the declared check scope and recorded execution conditions before relying on this result.' :
          status === 'not_saved' ? 'Read the available execution sidecars; missing material limits this conclusion. Restore the result bundle if available, or validate again with the current project and trusted limits.' :
          status === 'not_run' ? 'Inspect installation/setup or budget errors before running the task again.' : 'Inspect failed/unknown checks and process details before changing permissions.'));
      if (status !== 'pass' && status !== 'fail') gap(task.task + ': ' + dimension + ' ' + status + ' (' + scope + ')');
    }
    protectionOutcomes(task, record, values, scope);
    const installation = values.filter(v => v.facts.installation.state === 'recorded' ||
      (v.facts.conditions.requirements.state === 'recorded' && v.facts.conditions.requirements.value.install));
    if (installation.length) {
      const executed = installation.filter(v => v.facts.installation.state === 'recorded').length;
      const reused = installation.filter(v => v.facts.conditions.installation_state.state === 'recorded' && v.facts.conditions.installation_state.value.reused).length;
      const missing = installation.length - executed - reused;
      task.claims.push(claim('installation', missing ? 'partial' : 'recorded', `${scope}: ${executed} installer execution record(s), ${reused} installed-snapshot reuse(s), ${missing} without a recorded installer/reuse result.`,
        installation.map(v => eref(record, v, '/installation')), 'Inspect installer results and snapshot hashes separately. Reuse means no installer process ran in that trial; final full-flow verification should install afresh.'));
      if (missing) gap(task.task + ': installation details incomplete');
    }
  }
  function protectionOutcomes(task: TaskSummary, record: ResultRecord, values: ExecutionView[], scope: string) {
    const declared = values.map(v => v.agreement).find(a => a?.declaration.state === 'recorded') ?? record.model?.agreements.find(a => a.task_key === task.task && a.declaration.state === 'recorded');
    if (declared?.declaration.state === 'recorded') {
      const status = aggregate(values.map(v => v.facts.outcomes.protections ?? { status: 'not_saved', basis: 'Protection evidence not supplied' }));
      task.claims.push(claim('protections', status, `${scope}: declared task protections ${status}. Installation is outside their tested scope.`,
        values.map(v => eref(record, v, '/protections')), 'Review each target, operation, host controls and before/after probe. Keep these goals fixed when considering wider rules or repairs.'));
      for (const goal of declared.declaration.value) {
        const evaluated = values.map(v => evaluateProtections({ ...declared, declaration: recorded([goal]) }, v.facts.protections?.state === 'recorded' ? recorded(v.facts.protections.value.map(s => ({ ...s, results: s.results.filter(r => r.key === goal.key) }))) : v.facts.protections));
        const state = aggregate(evaluated);
        const stages = ['before', 'after'].map(moment => moment + ': ' + aggregate(values.map(v => {
          const saved = v.facts.protections, result = saved?.state === 'recorded' ? saved.value.find(s => s.moment === moment)?.results.find(r => r.key === goal.key) : undefined;
          return { status: result?.status ?? (saved?.state === 'recorded' || saved?.state === 'not_run' ? 'not_run' : 'not_saved'), basis: '' };
        }))).join('; ');
        const issues = [...new Set(values.flatMap(v => v.facts.protections?.state === 'recorded' ? v.facts.protections.value.flatMap(s => s.results.filter(r => r.key === goal.key).flatMap(r => [r.target, ...r.controls_before, ...r.controls_after, ...r.checks].filter(c => c.status !== 'pass').map(c => c.name + ': ' + c.detail))) : []))].slice(0, 3).map(s => s.slice(0, 280));
        task.claims.push(claim('protection_goal:' + goal.key, state, `${scope}: ${goal.key}: ${goal.operation} ${goal.target_kind} ${goal.target} must be denied in the task stage; direct fake-workspace checks ${state} (${stages}).${issues.length ? ' ' + issues.join('; ') : ''}`,
          values.map(v => eref(record, v, '/protections')), state === 'pass' ? 'Review the tested operations; this is bounded direct-access coverage, not all access channels.' :
            'Inspect target kind/existence, fixture controls and probe errors. A missing resource is not proof of denial; do not broaden access through this goal to repair a task.'));
        if (state !== 'pass' && state !== 'fail') gap(task.task + ': protection ' + goal.key + ' ' + state);
      }
      if (status !== 'pass' && status !== 'fail') gap(task.task + ': protections ' + status);
    }
  }
  function policy(task: TaskSummary, value: PolicyPlan | undefined, evidence: EvidenceReference[]) {
    if (!value) return;
    task.policy = value;
    const show = (v: Saved<string[]>) => v.state === 'recorded' ? v.value.join(', ') || '(none)' : v.state;
    const read = present(value.task.read), install = present(value.installation);
    task.claims.push(claim('policy', 'recorded', `Task writes: ${show(value.task.write)}; task reads (${read?.mode ?? 'not_saved'}): ${read ? read.grants.join(', ') || '(none)' : 'not_saved'}; task network: ${show(value.task.network)}.` +
      (value.protection_denials ? ` Fixed task denials: ${value.protection_denials.map(g => g.operation + ' ' + g.target).join(', ')}; these take precedence over positive grants.` : '') +
      (install ? ` Installer writes (${install.mode}): ${install.write.join(', ') || '(none)'}; installer domains: ${show(install.network)}.` : ` Installation policy: ${value.installation.state}.`), evidence,
      'Review these variable grants together with read target kinds, preparation and backend defaults. This is not a complete list of every permission granted by the backend.'));
    if (read?.mode === 'explicit') {
      const kinds = present(read.target_kinds);
      task.claims.push(claim('read_target_kinds', kinds ? 'recorded' : 'not_saved', kinds ? 'Recorded read targets: ' + (Object.entries(kinds).map(([path, kind]) => path + ' (' + kind + ')').join(', ') || '(no project read grants)') + '.' :
        'Read grant paths are retained, but their file/directory kinds are not supplied.', evidence, 'Check target kinds when reviewing/replaying reads; a file replaced by a directory changes the possible scope.'));
      if (!kinds) gap(task.task + ': read target kinds not saved');
    }
  }
  function comparison(c: SavedComparison, record: ResultRecord) {
    const conditions = c.conditions;
    summary.claims.push(claim('comparison_conditions', 'reported', `Saved comparison: input changed ${conditions.input_changed}; config changed ${conditions.config_changed}; limits changed ${conditions.limits_changed}; environment changes ${conditions.environment_changed.join(', ') || '(none)'}; observer changed ${conditions.observer_changed}.`,
      [ref(record, '/comparison/conditions')], 'Review changed inputs, commands and collector conditions before attributing differences to a dependency upgrade. The baseline path is a recorded reference; it was not loaded.'));
    if (record.comparisonOnly) for (const side of ['before', 'after'] as const) for (const [i, t] of record.comparisonOnly[side].tasks.entries()) {
      summary.claims.push(claim('comparison_task_' + side, 'reported', `${side} ${t.task}: composite verdict ${t.verdict ?? 'not_run'}; module ${t.module_capture}; compiler ${t.compiler_capture}; build ${t.build_capture}.`,
        [ref(record, '/' + side + '/tasks/' + i)], 'Review task outcomes and each source separately before interpreting changed or missing records.'));
    }
    for (const [index, row] of c.tasks.entries()) {
      let task = summary.tasks.find(t => t.task === row.task);
      if (!task) { task = { task: row.task, claims: [], decisions: [], stages: [] }; summary.tasks.push(task); }
      const sources = [['modules', row], ...row.compilation ? [['compiler', row.compilation] as const] : [], ...row.bundling ? [['build', row.bundling] as const] : []] as const;
      for (const [source, changes] of sources) {
        const pointer = '/comparison/tasks/' + index + (source === 'modules' ? '' : source === 'compiler' ? '/compilation' : '/bundling');
        const partial = changes.state !== 'compared' || changes.warnings.length > 0 || result.comparisonOnly?.status === 'partial';
        task.claims.push(claim(source + '_changes', partial ? 'partial' : 'reported', `Saved ${source} comparison (${changes.state}): ${changes.added.length} newly recorded, ${changes.removed.length} no longer recorded, ${changes.version_changes.length} version change(s).` +
          (changes.version_changes.length ? ' ' + changes.version_changes.slice(0, 5).map(v => `${v.name} ${v.before} → ${v.after} at ${v.path}`).join('; ') + '.' : '') +
          ('contribution_changes' in changes ? ` ${changes.contribution_changes.length} output contribution change(s); ${changes.changed_outputs.length} changed output(s); ${changes.external_changes.length} external-reference change(s).` : '') +
          ('added_files' in changes ? ` ${changes.added_files.length} new file(s); ${changes.removed_files.length} no longer recorded; ${changes.explanation_changes.length} explanation change(s).` : '') +
          (changes.warnings.length ? ' ' + changes.warnings.join(' ') : ''), [ref(record, pointer)],
          partial ? 'Inspect source coverage and warnings first. A missing record in a partial comparison does not establish removal.' : 'Inspect package locations, file explanations, import chains and output contributions in the saved comparison. No deletion or permission change follows from this difference.'));
        if (partial) gap(row.task + ': ' + source + ' comparison is partial/unavailable');
      }
    }
  }

  if (result.adoption) {
    const a = result.adoption, m = a.manifest;
    summary.workflow = { kind: 'adopt', reported_status: 'adopted' };
    summary.claims.push(claim('adoption', 'recorded', `Explicitly adopted ${m.id} at ${m.selected_at}.${m.reason ? ' Reason: ' + m.reason : ''}`,
      [ref(result, '/baseline'), ref(result, '/reason')], 'Run check with the current project configuration and independently trusted limits; historical verification does not establish current compatibility.'));
    summary.claims.push(claim('history', m.previous ? a.parent_available ? 'linked' : 'unavailable' : 'first_selection',
      m.previous ? `Previous selection: ${m.previous.id}; predecessor file ${a.parent_available ? 'available' : 'not available'}. Its evidence has not been reloaded by this inspection.` : 'No previous adoption is recorded.',
      [ref(result, '/previous')], 'Inspect the previous record separately when reviewing why the adopted policy changed.'));
    for (const retained of a.tasks) {
      const task: TaskSummary = { task: retained.key, claims: [], decisions: [], stages: [] }; summary.tasks.push(task);
      policy(task, retained.proofs[0].policy, [eref(retained.result, retained.proofs[0], '/policy')]);
      outcomes(task, retained.result, retained.proofs, 'Historical adopted verification');
      task.claims.push(claim('current_validation', 'not_run', 'Adoption records a choice of saved verification; it does not execute or check the current project.',
        [ref(result, '/action')], 'Use check to establish current results before relying on this policy for changed inputs.'));
      const facts = retained.proofs[0].facts;
      task.claims.push(claim('conditions', 'recorded', `Verified input: ${present(facts.conditions.input_hash)}; environment: ${JSON.stringify(present(facts.conditions.environment))}; requirements: ${JSON.stringify(present(facts.conditions.requirements))}.`,
        [ref(retained.result, '/inputs'), ref(retained.result, '/environment'),
          { file: path.relative(root, path.join(path.dirname(retained.result.file), 'inputs.json')).split(path.sep).join('/'), pointer: '/config' }],
        'These are historical conditions; new environment, input or installation changes require new validation.'));
    }
    summary.claims.push(claim('cost', 'recorded', 'Adoption and inspection execute 0 tasks and 0 installations; only bounded saved JSON evidence is read/copied.',
      [ref(result, '/artifacts')], 'Measure actual check/repair costs separately.'));
    summary.limitations.push('Adoption is an explicit selection of historical evidence, not a future guarantee or execution permission. Independently trusted limits remain required.',
      'Protection evidence covers task-stage direct operations on the recorded paths and fixtures; installation and other access channels are outside its coverage.',
      'Hashes check retained content consistency; they do not authenticate the producer. The host can modify the adoption store.',
      'Long-term maintenance benefit and independent user understanding have not been established by this inspection.');
  } else if (result.native) {
    const native = result.native, task: TaskSummary = { task: native.task.key, claims: [], decisions: [], stages: [] };
    summary.tasks.push(task); policy(task, native.policy, [ref(result, '/policy', native.policy.id)]);
    outcomes(task, result, result.executions, 'Single execution');
    task.claims.push(claim('workflow', 'not_saved', 'A single execution does not record acceptance, recovery, search completion or final repeated verification.', [ref(result, '/execution/origin')], 'Inspect its parent report.json for workflow decisions.'));
    gap(task.task + ': parent workflow not supplied');
  } else if (model?.source.format === 'experiment-v1') {
    const verification = present(model.workflow.verification);
    summary.claims.push(claim('workflow', model.workflow.reported_status, `Workflow reports ${model.workflow.reported_status}; baseline verified ${verification?.baseline_verified ?? 'not_saved'}; final verified ${verification?.final_verified ?? 'not_saved'}; search complete ${present(model.workflow.search_complete) ?? 'not_saved'}.`,
      [ref(result, '/status'), ref(result, '/baseline_verified'), ref(result, '/final_verified'), ref(result, '/search_complete')],
      model.workflow.kind === 'doctor' ? 'Inspect these built-in fixtures and host controls; a passing doctor does not validate a project policy.' :
        model.workflow.kind === 'observe' ? 'Review task assertions, boundary checks and each selected observation source separately.' :
        model.workflow.reported_status === 'verified' ? 'Review the exported policy; replay it on an available project with current trusted limits before adopting it.' : 'Inspect incomplete/failed execution evidence before using the current candidate as a baseline.',
      model.workflow.kind === 'doctor' || model.workflow.kind === 'observe' ? undefined : ['permsift', 'run', '--config', model.workflow.reported_status === 'verified' ? 'recommended.yaml' : 'unverified-candidate.yaml', '--limits', '<TRUSTED_LIMITS>', '--output', '<NEW_DIRECTORY>']));
    if (model.workflow.reported_status === 'verified' && (!verification?.baseline_verified || !verification.final_verified)) {
      summary.claims.push(claim('verification', 'contradictory', 'The reported verified workflow lacks passing baseline/final verification flags.', [ref(result, '/status'), ref(result, '/final_verified')], 'Resolve the workflow contradiction before using this policy as a verified result.'));
      gap('Workflow verification flags contradict its reported status');
    }
    for (const definition of model.tasks) {
      const task: TaskSummary = { task: definition.key, claims: [], decisions: [], stages: [] }; summary.tasks.push(task);
      const all = result.executions.filter(v => v.task === task.task);
      const role = model.workflow.current_policies.find(p => p.task_key === task.task), original = model.policies.find(p => p.id === role?.policy_id);
      const matched = [...all].reverse().find(v => sameGrants(v.policy, original) && v.facts.reported_verdict.state === 'recorded' && v.facts.reported_verdict.value === 'pass');
      const current = matched?.policy ?? original;
      policy(task, current, [ref(result, '/policies/' + task.task, original?.id), ...matched ? [eref(result, matched, matched.native ? '/policy' : '/read_grant_kinds')] : []]);
      const selected = model.workflow.kind === 'tighten' && all.some(v => v.facts.origin.phase === 'final') ? all.filter(v => v.facts.origin.phase === 'final') :
        model.workflow.kind === 'tighten' ? all.filter(v => ['baseline', 'discovery_baseline'].includes(v.facts.origin.phase)) : all;
      outcomes(task, result, selected, model.workflow.kind === 'tighten' && selected[0]?.facts.origin.phase !== 'final' ? 'Baseline; final verification not reached' : model.workflow.kind === 'tighten' ? 'Final verification' : 'Task workflow');
      const selectedOrigins = selected.map(v => v.native ? v.facts.origin.record.replace(/^executions\//, 'evidence/') : v.reference);
      const currentMismatch = model.executions.filter(e => selectedOrigins.includes(e.origin.record)).some(e => !sameGrants(model.policies.find(p => p.id === present(e.policy_id)), current));
      if (model.workflow.reported_status === 'verified' && (!selected.length || selected.some(v => contradictoryPass(v) || verdict(v) !== 'pass') || currentMismatch || (model.workflow.kind === 'tighten' && selected[0]?.facts.origin.phase !== 'final'))) {
        task.claims.push(claim('verification', 'contradictory', 'Reported verification is not supported by matching final/current-policy execution facts.', [ref(result, '/final_verified'), ref(result, '/policies/' + task.task)], 'Resolve mismatched policies, unsuccessful checks or missing final repetitions before relying on this result.'));
        gap(task.task + ': verification contradicts retained execution facts');
      }
      for (const search of model.workflow.searches.filter(s => s.task_key === task.task)) {
        const searchPointer = '/' + ({ write: 'searches', read: 'read_searches', network: 'network_searches', install_write: 'install_searches' }[search.permission] ?? 'searches') + '/' + task.task;
        task.claims.push(claim('search', search.stop, `${search.permission} search stopped: ${search.stop}; producer decisions: ${search.decisions.filter(d => d === 'accepted').length} accepted, ${search.decisions.filter(d => d === 'rejected').length} rejected, ${search.decisions.filter(d => d === 'unknown').length} unknown.`, [ref(result, searchPointer)],
          search.stop === 'exhausted' ? 'Review generated/configured operations and discovery limits. Exhaustion does not prove globally minimum permissions.' : search.stop === 'unstable' ? 'Resolve the failed recovery or unstable task before interpreting the policy comparison.' : 'Keep the verified scope separate from unfinished search; increase the budget only if further narrowing is worth its cost.'));
        if (!['exhausted', 'fixed_point'].includes(search.stop)) gap(task.task + ': ' + search.permission + ' search stopped ' + search.stop);
        for (const [i, step] of search.steps.entries()) {
          const candidate = all.find(v => v.facts.origin.record === `executions/${present(step.trial_id)}.json` || v.reference === `evidence/${present(step.trial_id)}.json`),
            recovery = all.find(v => v.facts.origin.record === `executions/${present(step.recovery_id)}.json` || v.reference === `evidence/${present(step.recovery_id)}.json`);
          const cv = verdict(candidate), rv = verdict(recovery);
          const contradiction = step.decision === 'accepted' ? !!candidate && (cv !== 'pass' || contradictoryPass(candidate)) : step.decision === 'rejected' ?
            (!!candidate && cv !== 'fail') || (!!recovery && (rv !== 'pass' || contradictoryPass(recovery))) : false;
          const supported = step.decision === 'accepted' ? fullyPassed(candidate) : step.decision === 'rejected' ? cv === 'fail' && candidate?.facts.outcomes.task.status === 'fail' && candidate.facts.outcomes.boundaries.status === 'pass' && fullyPassed(recovery) : false;
          const support = contradiction ? 'contradictory' : supported ? 'corroborated' : 'reported_only';
          const evidence = [ref(result, searchPointer + '/steps/' + i), ...candidate ? [eref(result, candidate, candidate.native ? '/outcomes' : '/summary')] : [], ...recovery ? [eref(result, recovery, recovery.native ? '/outcomes' : '/summary')] : []];
          task.decisions.push({ permission: search.permission, operation: step.operation, reported_decision: step.decision, support,
            scope_change: step.semantic_change.state !== 'recorded' ? 'not_saved' : step.semantic_change.value ? 'reported_reduction' : 'reported_no_scope_change', before: step.before, after: step.after,
            candidate: cv, recovery: step.recovery_id.state === 'recorded' ? rv : 'not_applicable', evidence,
            action: contradiction ? 'Resolve inconsistent or unstable evidence before relying on this decision.' : support === 'reported_only' ? 'Read candidate/recovery sidecars for the independent task and boundary results; the producer decision alone does not establish necessity.' : step.decision === 'rejected' ? 'Retain this grant for the tested comparison; inspect the failed task and passing recovery. This is scenario-specific evidence.' : 'Review the accepted change and final repetition evidence before adopting the exported policy.' });
          if (support !== 'corroborated' || step.decision === 'unknown') gap(task.task + ': ' + search.permission + ' decision ' + (i + 1) + ' ' + (step.decision === 'unknown' ? 'unknown' : support));
        }
      }
      for (const d of result.discovery?.filter(d => d.task === task.task) ?? []) {
        task.claims.push(claim('candidate_generation', d.truncated ? 'truncated' : 'recorded', `${d.dimension}: automatic generation ${d.enabled ?? 'not_saved'}; truncated ${d.truncated ?? 'not_saved'}; ${d.rules ?? 'not_saved'} generated rule(s). ${d.limitations.join(' ')}`,
          [ref(result, '/' + d.dimension + '/' + task.task)], 'Inspect configured/manual candidates and generation limits. Unseen paths and combinations were not exhaustively tested.'));
        if (d.truncated) gap(task.task + ': ' + d.dimension + ' candidate generation truncated');
      }
      if (model.workflow.kind === 'tighten') {
        const required = ['write', ...present(current?.task.read ?? { state: 'not_saved', reason: '' })?.mode === 'explicit' ? ['read'] : [],
          ...current?.installation.state === 'recorded' ? ['network', ...current.installation.value.mode === 'separate' ? ['install_write'] : []] : []];
        for (const permission of required) if (!model.workflow.searches.some(s => s.task_key === task.task && s.permission === permission)) {
          task.claims.push(claim('search', 'not_saved', 'No retained ' + permission + ' search summary for this task.', [ref(result, '/search_complete')], 'Inspect the workflow record to distinguish a search not reached from a summary not saved; final validation alone does not establish search coverage.'));
          gap(task.task + ': ' + permission + ' search summary not saved');
        }
      }
    }
  } else if (model?.source.format === 'regression-v1') {
    if (model.workflow.input_scope_change) summary.claims.push(claim('input_scope', 'changed',
      `Snapshot exclusions changed: ${JSON.stringify(model.workflow.input_scope_change.before)} → ${JSON.stringify(model.workflow.input_scope_change.after)}. Passing current inputs does not establish the original input-selection conditions.`,
      [ref(result, '/exclusion_change')], 'Review the changed input selection before adopting the current verification.'));
    for (const [index, row] of model.workflow.comparisons.entries()) {
      const task: TaskSummary = { task: row.task_key, claims: [], decisions: [], stages: [] }; summary.tasks.push(task);
      const base = '/tasks/' + index, reason = present(row.reason), stop = present(row.repair_stop);
      for (const stage of row.stages) {
        const child = result.children.find(c => c.task === task.task && c.phase === stage.phase), values = child?.result?.executions ?? [];
        task.stages.push({ phase: stage.phase, reported_verdict: stage.reported_verdict, task: child?.result ? aggregate(values.map(v => v.facts.outcomes.task)) : 'not_saved',
          ...values.some(v => v.facts.outcomes.protections) ? { protections: aggregate(values.map(v => v.facts.outcomes.protections ?? { status: 'not_saved', basis: '' })) } : {},
          boundaries: child?.result ? aggregate(values.map(v => v.facts.outcomes.boundaries)) : 'not_saved', retained: !!child?.result,
          evidence: [child?.result ? ref(child.result, '/status') : { file: child?.reference ?? stage.report.replace(/\.md$/, '.json'), pointer: '/status', availability: 'not_supplied' }] });
        if (!child?.result) gap(task.task + ': ' + stage.phase + ' child report not available');
        else {
          protectionOutcomes(task, child.result, values, stage.phase);
          const taskState = task.stages.at(-1)!.task, boundaryState = task.stages.at(-1)!.boundaries;
          if (!['pass', 'fail'].includes(taskState) || boundaryState !== 'pass') gap(task.task + ': ' + stage.phase + ' independent task/boundary details ' + taskState + '/' + boundaryState);
          const flags = present(child.result.model!.workflow.verification);
          if (stage.reported_verdict === 'pass' && (child.result.model!.workflow.reported_status !== 'verified' || !flags?.baseline_verified || !flags.final_verified || values.some(contradictoryPass))) {
            task.claims.push(claim('stage_verification', 'contradictory', stage.phase + ': reported stage pass disagrees with child verification facts.', [ref(child.result, '/status')], 'Resolve the child workflow/check evidence before relying on this stage.'));
            gap(task.task + ': ' + stage.phase + ' stage verification contradictory');
          }
        }
      }
      const causal = ['old', 'control', 'old-confirm', 'control-confirm'].map(phase => task.stages.find(s => s.phase === phase));
      const conflict = row.reported_status === 'permission_change' && causal.some((s, i) => !s || s.reported_verdict !== (i % 2 ? 'pass' : 'fail') || (s.retained && (s.boundaries === 'fail' || s.boundaries === 'unknown' || (i % 2 && s.task !== 'pass' && s.task !== 'not_saved') || (!(i % 2) && s.task === 'pass'))));
      task.claims.push(claim('comparison', conflict ? 'contradictory' : row.reported_status,
        row.reported_status === 'permission_change' ? `Producer reports old-policy failure, passing wider control, fresh old-policy failure and passing control recovery.${reason ? ' ' + reason : ''}` :
          row.reported_status === 'compatible' ? 'Old policy passed against current inputs and current success checks; permission minimization was not repeated.' : row.reported_status === 'unresolved_failure' ? 'Old and wider policies both failed; permissions are not established as the cause.' : `Comparison ${row.reported_status}.${reason ? ' ' + reason : ''}`,
        [ref(result, base + '/status'), ...task.stages.flatMap(s => s.evidence)], conflict ? 'Resolve stage/fact contradictions before interpreting this as a permission regression.' : row.reported_status === 'unresolved_failure' ? 'Inspect task errors and success checks under both policies before granting more access.' : 'Review the old/control/confirmation stages under matching preparation and inputs.'));
      if (conflict || row.reported_status === 'inconclusive' || row.reported_status === 'pending') gap(task.task + ': comparison ' + (conflict ? 'contradictory' : row.reported_status));
      if (present(row.definition_changed)) task.claims.push(claim('definition', 'changed', 'Producer reports a change in command, success checks, timeout or installation requirements; it does not isolate which changed.', [ref(result, base + '/task_definition_changed')], 'Review the current task/check definitions. Passing the new checks does not prove the original checks were preserved.'));
      if (row.history) {
        const h = row.history;
        task.claims.push(claim('history_task', 'pass', 'Adopted historical task checks passed. This is separate from current verification.',
          [ref(result, base + '/history/task')], 'Use the fresh stage results to assess the current project.'));
        task.claims.push(claim('history_boundaries', 'pass', 'Adopted historical fixed boundary checks passed within their recorded scope.',
          [ref(result, base + '/history/boundaries')], 'Read the fresh boundary checks and current environment separately.'));
        for (const goal of h.protection_goals) task.claims.push(claim('history_protection_goal:' + goal.key, goal.status,
          `${goal.key}: adopted historical protection checks passed; no current protection is inferred from that historical pass.`,
          [ref(result, base + '/history/protection_goals')], 'Compare this goal with the current declaration and its fresh probe evidence.'));
      }
      if (row.terms) {
        const terms = row.terms;
        task.claims.push(claim('terms', terms.changed ? 'changed' : 'same', `${terms.presence} task; terms ${terms.changed ? 'changed' : 'unchanged'}. Current selected-policy verification: ${row.current_verification ?? 'not_saved'}.` +
          (terms.changed ? ' Passing current checks does not establish preservation of the original terms.' : ''),
          [ref(result, base + '/terms'), ref(result, base + '/current_verification')], 'Review the exact changes before explicitly adopting a new baseline.'));
        for (const change of terms.changes) task.claims.push(claim('changed_' + change.dimension, 'changed',
          `${change.dimension}: ${JSON.stringify(change.before ?? '(absent)')} → ${JSON.stringify(change.after ?? '(absent)')}.`,
          [ref(result, base + '/terms/changes')], 'This is an exact definition difference; no stronger/weaker assertion inference is made.'));
        for (const d of terms.dimensions.filter(d => d.dimension.startsWith('protection_goal:'))) task.claims.push(claim('continuity_' + d.dimension, d.relation,
          `${d.dimension}: ${d.relation}. Historical checks remain historical; current proof is reported separately.`,
          [ref(result, base + '/terms/dimensions')], d.relation === 'removed' ? 'This goal is absent from the current agreement; its old result is not a current protection promise.' : 'Read the fresh before/after protection checks for current coverage.'));
      }
      const suggestionId = present(row.suggestion_policy), suggestion = model.policies.find(p => p.id === suggestionId);
      if (suggestion) {
        const stage = [...result.children].reverse().find(c => c.task === task.task && /^repair-verify-/.test(c.phase));
        const matched = stage?.result?.executions.find(v => sameGrants(v.policy, suggestion));
        policy(task, matched?.policy ?? suggestion, [ref(result, base + '/suggestion', suggestion.id), ...matched && stage?.result ? [eref(stage.result, matched, matched.native ? '/policy' : '/read_grant_kinds')] : []]);
        const corroborated = !!stage?.result && stage.result.executions.length > 0 && stage.result.executions.every(fullyPassed);
        const bad = !!stage?.result && stage.result.executions.some(v => contradictoryPass(v) || verdict(v) !== 'pass');
        task.claims.push(claim('suggestion', bad ? 'contradictory' : corroborated ? 'corroborated' : 'reported_only', `Producer records a verified repair suggestion${stop ? '; repair stopped ' + stop : ''}. Adoption is not recorded.`, [ref(result, base + '/suggestion'), ...stage?.result ? [ref(stage.result, '/final_verified')] : []],
          bad ? 'Resolve repair verification evidence before using this suggestion.' : 'Review the added scope in suggested.yaml, then replay on the current project with independently trusted limits before adoption.', ['permsift', 'run', '--config', 'suggested.yaml', '--limits', '<TRUSTED_LIMITS>', '--output', '<NEW_DIRECTORY>']));
        if (!corroborated) gap(task.task + ': repair verification ' + (bad ? 'contradictory' : 'reported_only'));
        if (stage?.result) outcomes(task, stage.result, stage.result.executions, 'Repair repeated verification');
      } else if (stop) task.claims.push(claim('repair', stop, 'Repair stopped: ' + stop + '; no verified suggestion retained.', [ref(result, base + '/repair_stop')], 'Review denial hints and cost before trying additional candidate repairs.'));
      for (const stage of result.children.filter(c => c.task === task.task)) if (stage.result) for (const g of stage.result.gaps) gap(task.task + ': ' + g);
    }
  }

  if (result.usage || result.native || model?.workflow.kind === 'observe') {
    const usage = result.usage;
    const records = usage ? usage.tasks : result.native ? present(result.native.execution.observations.records) ? [present(result.native.execution.observations.records)!] : [] :
      result.executions.flatMap(v => { const t = present(v.facts.observations.records); return t ? [t] : []; });
    for (const [index, record] of records.entries()) {
      let task = summary.tasks.find(t => t.task === record.task);
      if (!task) { task = { task: record.task, claims: [], decisions: [], stages: [] }; summary.tasks.push(task); }
      const r = ref(result, usage ? '/tasks/' + index : result.native ? '/execution/observations/records' : '/dependency_observations/' + record.task);
      if (record.capture_status === 'not_run') { task.claims.push(claim('observation', 'not_run', 'Task observation did not run: ' + record.reason, [r], 'Inspect setup, installation and the execution budget before observing again.')); gap(record.task + ': observation not run'); continue; }
      if (usage) {
        const live = result.executionReport?.executions.filter(v => v.task === task!.task) ?? [];
        if (live.length) outcomes(task, result.executionReport!, live, 'Observed execution');
        else { task.claims.push(claim('task', 'reported_only', `Usage report records composite task verdict ${record.verdict}; independent assertion/boundary evidence is not supplied.`, [r], 'Inspect the matching execution report for process, assertions and boundary checks.')); gap(task.task + ': independent execution evidence not supplied'); }
      }
      for (const source of ['inventory', 'modules', 'compiler', 'build'] as const) {
        const status = source === 'inventory' ? record.inventory ? record.inventory.complete ? 'captured' : 'incomplete' : 'not_saved' : source === 'modules' ? record.module_capture_status ?? record.capture_status : source === 'compiler' ? record.compilation?.capture_status ?? 'not_collected' : record.bundling?.capture_status ?? 'not_collected';
        const count = source === 'inventory' ? record.inventory?.packages.length : source === 'modules' ? record.loaded_packages.length : source === 'compiler' ? record.compilation?.packages.length : record.bundling?.packages.length;
        const issues = source === 'inventory' ? record.inventory?.issues ?? [] : source === 'modules' ? [...record.issues ?? [], ...record.coverage_gaps ?? []] : source === 'compiler' ? record.compilation?.issues ?? [] : record.bundling?.issues ?? [];
        task.claims.push(claim(source, status, `${source}: ${status}; ${count === undefined ? 'no package count available' : count + ' package instance record(s)'}.${issues.length ? ' ' + issues.join(' ') : ''}`, [r],
          status === 'not_collected' ? 'Select this source only if it answers a task question; its absence is not a zero-use result.' : status === 'captured' ? 'Inspect the same package across tasks and sources; these counts have different scopes and cannot be added as a used-package total.' : 'Inspect collector issues and source coverage. Positive records remain useful; missing records cannot establish absence.'));
        if (!['captured', 'not_collected'].includes(status)) gap(task.task + ': ' + source + ' ' + status);
      }
      const zeros = record.bundling?.packages.flatMap(p => p.contributions.filter(c => c.bytes_in_output === 0).map(c => ({ name: p.name, path: p.path, output: c.output }))) ?? [];
      if (zeros.length) task.claims.push(claim('build_contribution', record.bundling!.capture_status, `${zeros.length} recorded zero-byte contribution(s): ${zeros.slice(0, 5).map(p => p.name + ' at ' + p.path + ' → ' + p.output).join('; ')}. Zero bytes is a recorded value for that output, not a missing source or a package deletion verdict.`, [r],
        'Inspect input files, import chains and per-output contributions for this package.', ['permsift', 'inspect', path.basename(result.file), '--package', zeros[0].name]));
    }
    summary.limitations.push('Module hooks, compiler inputs and build metadata describe separate sources. Missing records and zero-byte contributions do not establish unused packages or safe deletion/permission removal.');
  }
  if (result.comparison) comparison(result.comparison, result);
  const costRecord = result.cost ? result : result.executionReport;
  if (costRecord?.cost) {
    const cost = costRecord.cost, installs = Object.values(cost.installations ?? {});
    summary.claims.unshift(claim('cost', 'reported', `Workflow records ${cost.trials} controlled execution(s)` +
      (cost.installations ? `, ${installs.reduce((n, v) => n + v.executed, 0)} installer execution(s), ${installs.reduce((n, v) => n + v.reused, 0)} installed-snapshot reuse(s)` : '') +
      (cost.duration_ms !== undefined ? `, ${(cost.duration_ms / 1000).toFixed(2)} s measured workflow time (before overview generation)` : '') + '.',
      [ref(costRecord, '/trials'), ...cost.installations ? [ref(costRecord, '/installation_stats')] : []], 'Use these costs with accepted changes, search stops and source coverage to judge whether more experiments are worthwhile.'));
    if (cost.protections) summary.claims.push(claim('protection_cost', 'reported', `Declared protection checks used ${cost.protections.calls} stage check(s), ${(cost.protections.duration_ms / 1000).toFixed(2)} s measured time including fake-workspace setup, probes and cleanup. Goals are batched; no dependency tree is copied for these probes.`,
      [ref(costRecord, '/timings/phases/protections')], 'Choose a small set of valuable targets and review this extra cost alongside the original controlled execution count.'));
  }
  if (model || result.native) {
    const declared = result.native?.agreement.declaration.state === 'recorded' || model?.agreements.some(a => a.declaration.state === 'recorded') || result.executions.some(v => v.agreement?.declaration.state === 'recorded');
    const adopted = model?.baselines.find(b => b.selection === 'adopted_reference');
    summary.claims.push(claim('agreement', declared ? 'recorded' : 'not_declared', (declared ? 'Protection declarations are retained; task claims distinguish current and historical coverage.' : 'No user protection-goal declaration is recorded.') +
      (adopted ? ' Check records an explicitly adopted baseline reference; the source store is not followed by this saved-report inspection.' : ' Baseline adoption is not recorded.'),
      [ref(result, result.native ? '/agreement' : model?.source.format === 'regression-v1' ? '/baseline' : '/schema_version')], 'Review the tested tasks and fixed-probe scope; keep verified suggestions separate from adoption decisions.'));
    summary.limitations.push('Task success and fixed boundary probes are separate conclusions. Probes cover their recorded fixtures/stages, not all access channels or undeclared user protection goals.',
      'Results apply to recorded inputs, task checks, preparation, installation state, instrumentation and environment. Hash/reference validation checks consistency; it does not authenticate a producer.',
      'Saved records can be read without the project. New validation/replay needs an available project, suitable sandbox environment, current configuration and independently trusted limits.');
  }
  for (const g of result.gaps) gap(g);
  if (result.executionReport) for (const g of result.executionReport.gaps) gap(g);
  summary.analysis.gaps = [...new Set(summary.analysis.gaps)];
  return freeze(summary);
}

const shell = (v: string) => /^[A-Za-z0-9_./@-]+$/.test(v) ? v : "'" + v.replaceAll("'", "'\\''") + "'";
function evidenceMarkdown(refs: EvidenceReference[]) {
  return refs.map(r => '[' + escape(r.file + ' ' + (r.pointer || '(root)')) + '](' + r.file.split('/').map(encodeURIComponent).join('/') + ')' + (r.availability ? ' (not supplied)' : '')).join(', ');
}
export function summaryMarkdown(summary: ResultSummary): string {
  const command = (tokens: string[]) => { const value = tokens.map(shell).join(' '); const fence = '`'.repeat(Math.max(1, ...[...value.matchAll(/`+/g)].map(m => m[0].length + 1))); return fence + ' ' + value + ' ' + fence; };
  const claims = (items: Claim[]) => items.flatMap(c => [`- **${escape(c.dimension)}: ${escape(c.status)}** — ${escape(c.statement)}`,
    `  Evidence: ${evidenceMarkdown(c.evidence)}. Next: ${escape(c.action.text)}`,
    ...c.action.command ? ['  Command (from the result directory; replace placeholders): ' + command(c.action.command)] : []]);
  return ['## Result overview', '', summary.workflow ? `Workflow reports **${escape(summary.workflow.reported_status)}** (${escape(summary.workflow.kind)}).` : 'Single execution facts; no workflow result inferred.',
    `Saved-material analysis: **${summary.analysis.status}**. This describes evidence availability, not task success.`, '', ...claims(summary.claims), '',
    ...summary.tasks.flatMap(t => [`### ${escape(t.task)}`, '', ...claims(t.claims), '',
      ...t.stages.length ? ['| Stage | Reported verdict | Independent task | Boundaries | Protections | Material | Evidence |', '| --- | --- | --- | --- | --- | --- | --- |',
        ...t.stages.map(s => `| ${escape(s.phase)} | ${s.reported_verdict} | ${s.task} | ${s.boundaries} | ${s.protections ?? 'not supplied'} | ${s.retained ? 'retained' : 'not supplied'} | ${evidenceMarkdown(s.evidence)} |`), ''] : [],
      ...t.decisions.length ? ['<details><summary>Candidate decisions and recovery evidence</summary>', '',
        ...t.decisions.flatMap(d => [`- ${escape(present(d.operation) ?? 'Operation not saved')}: ${escape(d.reported_decision)} (${d.support}); candidate ${d.candidate}, recovery ${d.recovery}; scope ${d.scope_change}.`,
          `  Before: ${escape(d.before.state === 'recorded' ? d.before.value.join(', ') || '(none)' : d.before.state)}; after: ${escape(d.after.state === 'recorded' ? d.after.value.join(', ') || '(none)' : d.after.state)}.`,
          `  Evidence: ${evidenceMarkdown(d.evidence)}. Next: ${escape(d.action)}`]), '', '</details>', ''] : []]),
    ...summary.analysis.gaps.length ? ['### Material gaps / unfinished work', '', ...summary.analysis.gaps.slice(0, 20).map(g => '- ' + escape(g)),
      ...summary.analysis.gaps.length > 20 ? ['- Additional gaps are listed in summary.json.'] : [], ''] : [],
    ...summary.limitations.map(s => '- ' + escape(s)), ''].join('\n');
}
/** Compact terminal view of the same claims; full decisions/evidence remain in the saved overview. */
export function summaryText(summary: ResultSummary): string {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  const lines = ['Result overview · ' + (summary.workflow ? summary.workflow.kind + ' reports ' + summary.workflow.reported_status : 'single execution') + ' · saved material ' + summary.analysis.status];
  for (const c of summary.claims) lines.push(`  ${c.dimension} [${c.status}]: ${c.statement}`, `    Next: ${c.action.text}`);
  for (const t of summary.tasks) {
    lines.push('  ' + t.task + ':');
    for (const c of t.claims) lines.push(`    ${c.dimension} [${c.status}]: ${c.statement}`, `      Evidence: ${c.evidence.slice(0, 2).map(r => r.file + ' ' + r.pointer).join(', ')}${c.evidence.length > 2 ? ' (more in summary.json)' : ''}`, `      Next: ${c.action.text}`);
    if (t.decisions.length) lines.push('    Candidate/recovery details: summary.md / summary.json');
  }
  if (summary.analysis.gaps.length) lines.push('  Gaps: ' + summary.analysis.gaps.slice(0, 4).join('; ') + (summary.analysis.gaps.length > 4 ? '; more in summary.json' : ''));
  return lines.map(clean).join('\n');
}
