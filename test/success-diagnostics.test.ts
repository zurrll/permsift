import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configSchema, limitsSchema, type Assertion } from '../src/config.js';
import { checkAssertions, checkAssertionsDetailed, evaluateAssertion } from '../src/assertions.js';
import { mutationsFor, type Mutation } from '../src/success-mutations.js';
import { bytesHash, captureSuccessMaterials, materialSchema, readMaterial } from '../src/success-materials.js';
import { diagnoseSuccess, successDiagnosticMarkdown } from '../src/success-diagnostics.js';
import { executionRequest } from '../src/execution-request.js';
import { nativeExecution } from '../src/model/native.js';
import { hash } from '../src/filesystem.js';
import { evidenceReport, type Trial } from '../src/experiment-report.js';
import type { ExecutionResult } from '../src/execute-once.js';

const equal: Assertion = { type: 'json_equals', path: '@workspace/dist/out.json', pointer: '/checked', value: 'passed' };
const exists: Assertion = { type: 'file_exists', path: equal.path };
const results: Assertion = { type: 'test_results', path: '@workspace/reports/tests.json', expected_tests: ['required'] };
const junit: Assertion = { type: 'junit', path: '@workspace/reports/tests.xml', expected_tests: ['required'] };
const resultsContent = JSON.stringify({ tests: [{ name: 'required', status: 'passed' }, { name: 'extra', status: 'passed' }] });
const junitContent = '<testsuites tests="2" failures="0"><testsuite tests="2" failures="0"><testcase classname="unit" name="required"/><testcase classname="unit" name="extra"/></testsuite></testsuites>';
async function directory(t: TestContext) { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-success-unit-'))); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

/** Synthesized complete native reports exercise proof selection; sandbox execution has separate tests. */
async function fixture(t: TestContext, assertions: Assertion[] = [exists, equal, results, junit]) {
  const root = await directory(t), output = path.join(root, 'result'), workspace = path.join(root, 'workspace');
  await fs.mkdir(path.join(output, 'evidence'), { recursive: true }); await fs.mkdir(path.join(output, 'executions'));
  await fs.mkdir(path.join(workspace, 'dist'), { recursive: true }); await fs.mkdir(path.join(workspace, 'reports'));
  await fs.writeFile(path.join(workspace, 'dist/out.json'), '{"checked":"passed","other":1}');
  await fs.writeFile(path.join(workspace, 'reports/tests.json'), resultsContent); await fs.writeFile(path.join(workspace, 'reports/tests.xml'), junitContent);
  const config = configSchema.parse({ schema_version: 1, scenarios: [{ id: 'build', command: ['node', 'task.cjs'], initial_write_grants: ['@workspace'], assertions }] });
  const limits = limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace'], repetitions: 2 });
  const environment = { node: process.version }, trials: Trial[] = [], entries: unknown[] = [];
  const report = { schema_version: 1, id: 'unit-source', mode: 'tighten', status: 'verified', environment,
    inputs: { config_hash: hash(config), limits_hash: hash(limits), snapshot_hash: 'a'.repeat(64) }, policies: { build: ['@workspace'] }, read_policies: { build: ['@workspace'] }, read_modes: { build: 'legacy' },
    network_policies: { build: [] }, trials, searches: {}, baseline_verified: true, final_verified: true, search_complete: true };
  const boundaries = ['control:fixture', 'control:network_endpoint', 'secret_unreadable', 'outside_unwritable', 'report_unwritable', 'network_blocked'].map(name => ({ name, status: 'pass' as const, detail: 'Synthetic host evidence, not sandbox execution' }));
  const samplePack = JSON.parse(await fs.readFile('examples/model-cases/current-demo.json', 'utf8'));
  const task = (Object.values(samplePack.evidence)[0] as ExecutionResult['details']).task;
  const request = executionRequest({ scenario: config.scenarios[0], limits, policy: { write: ['@workspace'], read: ['@workspace'], readMode: 'legacy', network: [], installWrite: ['@workspace'] },
    conditions: { input: { path: workspace, hash: report.inputs.snapshot_hash }, configHash: hash(config), limitsHash: hash(limits), scenarioHash: hash(config.scenarios[0]), environment, preparation: [] },
    sources: { inputDirectories: false, installedDirectories: false, afterTaskDirectories: false, readInventory: false, dependencies: false, installedState: false }, workspace: { kind: 'input' },
    budget: { deadline: Date.now() + 10000 }, resources: { scratch: root, protectedPaths: [], fixtures: { secret: root + '/secret', outside: root + '/outside', report: root + '/report', marker: 'fake', port: 1 }, readProbeDirectories: [] } });
  for (const id of ['first', 'second']) {
    const result: ExecutionResult = { id, verdict: 'pass', duration_ms: 1, actualCommand: ['node', 'task.cjs'], installationAttempted: false, installationReused: false,
      details: { task, assertions: await checkAssertions(assertions, { workspace, tmp: root, cache: root }), before: { checks: boundaries }, after: { checks: boundaries } } } as ExecutionResult;
    const facts = nativeExecution(request, result, { producer_id: report.id, record: `executions/${id}.json`, phase: 'final' });
    const trial: Trial = { id, scenario: 'build', phase: 'final', grants: ['@workspace'], read_grants: ['@workspace'], read_mode: 'legacy', network_grants: [], verdict: 'pass', duration_ms: 1, evidence: `evidence/${id}.json` };
    trials.push(trial);
    const notice = id === 'first' ? await captureSuccessMaterials({ output, roots: { workspace, tmp: root, cache: root }, assertions,
      source: { trial: id, task: 'build', execution_id: facts.execution.id, task_id: facts.task.id, policy_id: facts.policy.id, phase: 'final' } }) : undefined;
    await fs.writeFile(path.join(output, trial.evidence), JSON.stringify({ ...evidenceReport(trial, result.details), ...(notice ? { success_artifacts: notice } : {}) }));
    await fs.writeFile(path.join(output, `executions/${id}.json`), JSON.stringify(facts));
    entries.push({ trial: id, evidence: trial.evidence, facts: `executions/${id}.json`, execution_id: facts.execution.id });
  }
  await fs.writeFile(path.join(output, 'executions/index.json'), JSON.stringify({ schema_version: 1, kind: 'permsift_execution_index', entries }));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report)); await fs.writeFile(path.join(output, 'inputs.json'), JSON.stringify({ config, limits }));
  return { root, workspace, output, report };
}
async function rewriteMaterial(f: Awaited<ReturnType<typeof fixture>>, edit: (raw: ReturnType<typeof materialSchema.parse>) => Promise<void> | void) {
  const manifestFile = path.join(f.output, 'artifacts/first/manifest.json'), evidenceFile = path.join(f.output, 'evidence/first.json');
  const manifest = materialSchema.parse(JSON.parse(await fs.readFile(manifestFile, 'utf8'))); await edit(manifest);
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const evidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8')); evidence.success_artifacts.hash = bytesHash(Buffer.from(JSON.stringify(manifest)));
  await fs.writeFile(evidenceFile, JSON.stringify(evidence));
}

test('task fail semantics stay unchanged while missing, unreadable, malformed and mismatched causes differ', async t => {
  const root = await directory(t), roots = { workspace: root, tmp: root, cache: root };
  const assertion: Assertion = { ...equal, path: '@workspace/out' };
  assert.equal((await checkAssertionsDetailed([assertion], roots))[0].cause, 'missing_file');
  await fs.mkdir(path.join(root, 'out')); assert.equal((await checkAssertionsDetailed([assertion], roots))[0].cause, 'unreadable_file');
  await fs.rm(path.join(root, 'out'), { recursive: true }); await fs.writeFile(path.join(root, 'out'), '{broken');
  assert.equal((await checkAssertionsDetailed([assertion], roots))[0].cause, 'invalid_format');
  await fs.writeFile(path.join(root, 'out'), '{"checked":"failed"}');
  assert.equal((await checkAssertionsDetailed([assertion], roots))[0].cause, 'content_mismatch');
  assert.deepEqual((await checkAssertions([assertion], roots)).map(c => c.status), ['fail']);
  assert.equal('cause' in (await checkAssertions([assertion], roots))[0], false, 'Saved native Check shape stays compatible');
});
test('content perturbations remove joined markers and preserve JSON pointers, exact types and prototype-shaped keys', () => {
  const marker: Assertion = { type: 'file_contains', path: '@workspace/out', text: 'ab' };
  const removed = mutationsFor('aabb', [marker]).find(m => m.kind === 'remove_marker')!;
  assert.equal(removed.content!.includes('ab'), false);
  assert.equal(evaluateAssertion(marker, removed.content).cause, 'content_mismatch');
  assert.ok(!mutationsFor('ab', [marker]).some(m => m.kind === 'marker_only'), 'An unchanged control is not counted as a new perturbation');
  for (const [pointer, value, content] of [['/a~1b/~0', 1, '{"a/b":{"~":1}}'], ['', false, 'false'], ['/__proto__', 'safe', '{"__proto__":"safe"}']] as const) {
    const a: Assertion = { ...equal, pointer, value };
    const mutation: Mutation = mutationsFor(content, [a]).find(item => item.kind === 'change_json_value')!;
    assert.ok(mutation); assert.doesNotThrow(() => JSON.parse(mutation.content!));
    assert.equal(evaluateAssertion(a, mutation.content).cause, 'content_mismatch');
  }
});
test('JSON test perturbations separately expose failed, missing, renamed, duplicate and non-expected cases', () => {
  const list = mutationsFor(resultsContent, [results]);
  for (const kind of ['test_failed', 'remove_expected', 'rename_expected', 'duplicate_test', 'unexpected_failed']) {
    const mutation = list.find(m => m.kind === kind)!; assert.ok(mutation, kind);
    assert.equal(evaluateAssertion(results, mutation.content).cause, 'content_mismatch', kind);
  }
  assert.equal(evaluateAssertion(results, list.find(m => m.kind === 'remove_unexpected')!.content).status, 'pass');
  assert.equal(evaluateAssertion(results, '').cause, 'invalid_format');
});
test('JUnit perturbations retain valid nested summaries, escaped names, classname identity and semantic failure causes', () => {
  for (const kind of ['test_failed', 'remove_expected', 'rename_expected', 'duplicate_test', 'unexpected_failed']) {
    const m = mutationsFor(junitContent, [junit]).find(m => m.kind === kind)!;
    const evaluation = evaluateAssertion(junit, m.content); assert.equal(evaluation.cause, 'content_mismatch', `${kind}: ${evaluation.detail}`);
  }
  const nonExpected = mutationsFor(junitContent, [junit]).find(m => m.kind === 'remove_unexpected')!;
  assert.equal(evaluateAssertion(junit, nonExpected.content).status, 'pass', 'Consistent summary counts do not invent required non-expected tests');
  const escaped = { ...junit, expected_tests: ['one & two'] };
  const xml = '<testsuite tests="1"><testcase classname="unit" name="one &amp; two"/></testsuite>';
  const renamed = mutationsFor(xml, [escaped]).find(m => m.kind === 'rename_expected')!;
  assert.equal(evaluateAssertion(escaped, renamed.content).cause, 'content_mismatch');
});
test('JUnit diagnostic selects numeric-escaped expected names and preserves literal reference text', () => {
  const assertion: Assertion = { ...junit, expected_tests: ["quote '"] };
  const xml = '<testsuite tests="2"><testcase name="quote &#x27;"/><testcase name="literal &amp;#39;"/></testsuite>';
  assert.equal(evaluateAssertion(assertion, xml).status, 'pass');
  const mutations = mutationsFor(xml, [assertion]);
  for (const kind of ['remove_expected', 'rename_expected', 'duplicate_test', 'test_failed']) {
    const m = mutations.find(m => m.kind === kind)!;
    assert.ok(m); assert.equal(evaluateAssertion(assertion, m.content).cause, 'content_mismatch', kind);
  }
  const removed = mutations.find(m => m.kind === 'remove_unexpected')!;
  assert.equal(evaluateAssertion(assertion, removed.content).status, 'pass');
  assert.ok(mutations.find(m => m.kind === 'rename_expected')!.content!.includes('&amp;#39;'), 'Builder must preserve the literal ampersand reference');
});
test('material retention rejects links, oversized and interrupted reads, enforces aggregate limits and leaves originals unchanged', async t => {
  const root = await directory(t), workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'one'), '1234'); await fs.writeFile(path.join(workspace, 'two'), '5678');
  await fs.symlink('one', path.join(workspace, 'link'));
  await assert.rejects(readMaterial(workspace, path.join(workspace, 'link'), 10), /Symlink/);
  await assert.rejects(readMaterial(workspace, path.join(workspace, 'one'), 3), /byte budget/);
  await assert.rejects(readMaterial(workspace, path.join(workspace, 'one'), 10, 0), /budget/);
  await assert.rejects(readMaterial(workspace, path.join(workspace, 'one'), 10, Infinity, AbortSignal.abort()), /interrupted/);
  const notice = await captureSuccessMaterials({ output: root, roots: { workspace, tmp: root, cache: root }, assertions: ['one', 'two', 'link'].map(name => ({ type: 'file_exists', path: '@workspace/' + name })),
    source: { trial: 'retained', task: 'build', phase: 'final', execution_id: 'execution:v1:' + 'a'.repeat(64), task_id: 'task:v1:' + 'b'.repeat(64), policy_id: 'policy:v1:' + 'c'.repeat(64) },
    limits: { files: 1, file_bytes: 8, total_bytes: 4, milliseconds: 2000 } });
  assert.equal(notice.state, 'saved');
  const manifest = materialSchema.parse(JSON.parse(await fs.readFile(path.join(root, 'artifacts/retained/manifest.json'), 'utf8')));
  assert.deepEqual(manifest.files.map(f => f.state), ['saved', 'not_saved', 'not_saved']); assert.equal(manifest.total_bytes, 4);
  assert.equal(await fs.readFile(path.join(workspace, 'one'), 'utf8'), '1234');
});
test('optional retention write failure records not_saved instead of throwing into task acceptance', async t => {
  const root = await directory(t); await fs.writeFile(path.join(root, 'artifacts'), 'occupied');
  const capture = await captureSuccessMaterials({ output: root, roots: { workspace: root, tmp: root, cache: root }, assertions: [exists],
    source: { trial: 'one', task: 'build', phase: 'final', execution_id: 'execution:v1:' + 'a'.repeat(64), task_id: 'task:v1:' + 'b'.repeat(64), policy_id: 'policy:v1:' + 'c'.repeat(64) } });
  assert.equal(capture.state, 'not_saved');
});
test('offline diagnosis binds a final repetition and groups individual and collective checks by artifact', async t => {
  const f = await fixture(t), report = await diagnoseSuccess(f.output);
  assert.equal(report.status, 'diagnosed', JSON.stringify(report)); assert.equal(report.tasks.length, 1);
  const row = report.tasks[0]; assert.equal(row.sample?.trial, 'first'); assert.equal(row.sample?.phase, 'final'); assert.equal(row.final_repetitions, 2);
  const artifact = row.artifacts.find(a => a.path === equal.path)!;
  assert.equal(artifact.assertions.length, 2);
  const empty = artifact.mutations.find(m => m.kind === 'empty_file')!;
  assert.equal(empty.checks[0].status, 'pass'); assert.equal(empty.checks[1].cause, 'invalid_format'); assert.equal(empty.all_artifact_assertions_reject, true);
  assert.equal(artifact.mutations.find(m => m.kind === 'change_json_value')!.checks[1].cause, 'content_mismatch');
  assert.ok(row.artifacts.find(a => a.path === results.path)!.findings.some(s => s.includes('outside the expected-name')));
  assert.match(successDiagnosticMarkdown(report), /All retained artifact assertions/);
  await fs.rm(f.workspace, { recursive: true }); assert.equal((await diagnoseSuccess(f.output)).status, 'diagnosed', 'Original project is unnecessary');
});
test('known existence-only weakness is reported without claiming the complete task accepted a broken build', async t => {
  const f = await fixture(t, [exists]), report = await diagnoseSuccess(f.output), artifact = report.tasks[0].artifacts[0];
  assert.equal(report.status, 'diagnosed'); assert.equal(artifact.mutations.find(m => m.kind === 'missing_file')!.artifact_checks_reject, true);
  assert.equal(artifact.mutations.find(m => m.kind === 'empty_file')!.artifact_checks_reject, false);
  assert.ok(artifact.findings.some(s => s.includes('accept an empty readable file'))); assert.match(report.limitations.join(' '), /internal behavior tests/);
});
test('missing old materials stay not_saved and never fall back to earlier workspaces', async t => {
  const f = await fixture(t), file = path.join(f.output, 'evidence/first.json');
  const raw = JSON.parse(await fs.readFile(file, 'utf8')); delete raw.success_artifacts; await fs.writeFile(file, JSON.stringify(raw));
  const report = await diagnoseSuccess(f.output); assert.equal(report.status, 'partial'); assert.equal(report.tasks[0].state, 'not_saved');
});
test('tampered material bytes or final identities cannot yield a successful diagnostic', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.output, 'artifacts/first/00.bin'), 'bad bytes');
  const report = await diagnoseSuccess(f.output); assert.equal(report.status, 'partial');
  assert.ok(report.tasks[0].artifacts.every(a => a.mutations.length === 0), 'Full control must be available');
  await rewriteMaterial(f, raw => { raw.source.execution_id = 'execution:v1:' + 'd'.repeat(64); });
  assert.match((await diagnoseSuccess(f.output)).tasks[0].reason!, /identity\/hash/);
});
test('a semantically failing unmodified control stops mutations even if retained hashes are internally consistent', async t => {
  const f = await fixture(t, [equal]);
  await rewriteMaterial(f, async raw => {
    const file = raw.files[0]; assert.equal(file.state, 'saved'); if (file.state !== 'saved') return;
    const bytes = Buffer.from('{"checked":"failed","other":1}'); assert.equal(bytes.length, file.bytes);
    await fs.writeFile(path.join(f.output, 'artifacts/first', file.file), bytes); file.hash = bytesHash(bytes);
  });
  const report = await diagnoseSuccess(f.output); assert.equal(report.status, 'partial');
  assert.match(report.tasks[0].artifacts[0].reason!, /control did not pass/); assert.equal(report.tasks[0].artifacts[0].mutations.length, 0);
});
test('incomplete repeated final evidence never uses an earlier passing result', async t => {
  const f = await fixture(t); f.report.trials.pop(); await fs.writeFile(path.join(f.output, 'report.json'), JSON.stringify(f.report));
  const report = await diagnoseSuccess(f.output); assert.equal(report.status, 'partial'); assert.match(report.tasks[0].reason!, /repetitions are incomplete/);
});
test('untrusted artifact references and symlink companions do not read outside the selected result', async t => {
  const f = await fixture(t), file = path.join(f.output, 'evidence/first.json'), raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.success_artifacts.manifest = '../../outside.json'; await fs.writeFile(file, JSON.stringify(raw));
  assert.match((await diagnoseSuccess(f.output)).tasks[0].reason!, /reference/);
  raw.success_artifacts.manifest = 'artifacts/first/manifest.json'; await fs.writeFile(file, JSON.stringify(raw));
  await fs.rename(path.join(f.output, 'artifacts'), path.join(f.root, 'moved')); await fs.symlink(path.join(f.root, 'moved'), path.join(f.output, 'artifacts'));
  assert.match((await diagnoseSuccess(f.output)).tasks[0].reason!, /Symlink/);
});

test('preliminary phase or another policy cannot be substituted even after rehashing a material manifest', async t => {
  const f = await fixture(t, [exists]);
  await rewriteMaterial(f, raw => { raw.source.phase = 'baseline'; });
  assert.match((await diagnoseSuccess(f.output)).tasks[0].reason!, /identity\/hash/);
  await rewriteMaterial(f, raw => { raw.source.phase = 'final'; raw.source.policy_id = 'policy:v1:' + 'd'.repeat(64); });
  assert.match((await diagnoseSuccess(f.output)).tasks[0].reason!, /identity\/hash/);
});
test('saved material absence prevents collective mutation conclusions instead of counting a missing capture as a detected defect', async t => {
  const f = await fixture(t);
  await rewriteMaterial(f, raw => {
    const file = raw.files[0]; if (file.state !== 'saved') throw new Error('Expected saved fixture');
    raw.files[0] = { path: file.path, state: 'not_saved', reason: 'Synthetic capture failure' }; raw.total_bytes -= file.bytes;
  });
  const evidenceFile = path.join(f.output, 'evidence/first.json');
  const evidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(f.output, 'artifacts/first/manifest.json'), 'utf8')); evidence.success_artifacts.bytes = manifest.total_bytes;
  await fs.writeFile(evidenceFile, JSON.stringify(evidence));
  const report = await diagnoseSuccess(f.output); assert.equal(report.status, 'partial');
  assert.equal(report.tasks[0].artifacts[0].state, 'not_saved'); assert.ok(report.tasks[0].artifacts.every(a => !a.mutations.length));
});

test('historical complete JSON-only proofs remain explicitly not_saved without inventing native identities', async t => {
  const f = await fixture(t, [exists]); await fs.rm(path.join(f.output, 'executions'), { recursive: true });
  const report = await diagnoseSuccess(f.output); assert.equal(report.status, 'partial'); assert.equal(report.tasks[0].state, 'not_saved');
  assert.match(report.tasks[0].reason!, /identities/); assert.equal(report.tasks[0].artifacts.length, 0);
});
