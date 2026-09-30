import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, extractDenials, aliasForPath } from '../src/diagnostics.js';
import type { ProcessResult } from '../src/process.js';

const roots = { workspace: '/scratch/workspace', cache: '/scratch/cache', tmp: '/scratch/tmp' };
const process = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({ status: 'completed', exit_code: 1, signal: null, duration_ms: 5, stdout: '', stderr: '', ...overrides });
const failed = [{ name: 'output', status: 'fail' as const, detail: 'Fresh output missing' }];
test('denial explanations normalize paths and preserve log provenance without attributing other roots', () => {
  const denials = extractDenials("Error: EPERM: operation not permitted, open 'dist/out'", [{ line: 'Sandbox: node deny(1) file-write-create /scratch/cache/compiler/state {tag}' }], roots);
  assert.equal(denials[0].path, '@cache/compiler/state'); assert.equal(denials[0].source, 'sandbox_log');
  assert.equal(denials[1].path, '@workspace/dist/out'); assert.equal(denials[1].source, 'stderr');
  assert.equal(aliasForPath('/scratch/workspace-other/file', roots), '/scratch/workspace-other/file');
});
test('timeout and ordinary task failure do not turn into unsupported permission claims', () => {
  const base = { roots, assertions: failed, boundaries: [], verdict: 'fail' };
  assert.equal(diagnose({ ...base, task: { process: process({ stderr: 'SyntaxError: invalid source' }), violations: [] } }).kind, 'task_failed');
  const timeout = diagnose({ ...base, verdict: 'unknown', task: { process: process({ status: 'timed_out', exit_code: null }), violations: [] } });
  assert.equal(timeout.kind, 'execution_incomplete'); assert.match(timeout.summary, /timed_out/);
  assert.equal(diagnose({ ...base, task: { process: process({ exit_code: 0 }), violations: [] } }).kind, 'assertion_failure');
});
test('a captured denial is evidence with caveats, not a causal conclusion', () => {
  const d = diagnose({ roots, assertions: failed, boundaries: [], verdict: 'fail', task: { process: process({ stderr: "Error: EACCES: permission denied, mkdir 'dist'" }), violations: [] } });
  assert.equal(d.kind, 'permission_denial_observed'); assert.equal(d.failed_assertions.length, 1);
  assert.match(d.log_limitations, /do not prove causation/);
});
