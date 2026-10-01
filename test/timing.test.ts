import test from 'node:test';
import assert from 'node:assert/strict';
import { Timings, summarizeTimings } from '../src/timing.js';

test('monotonic timing charges nested operations once, including failed operations', async () => {
  let now = 0; const timings = new Timings(() => now);
  await timings.measure('preparation', async () => {
    now += 2;
    await timings.measure('hash', async () => { now += 5; });
    now += 3;
  });
  await assert.rejects(timings.measure('task', async () => { now += 7; throw new Error('failure'); }), /failure/);
  now += 4;
  const result = timings.snapshot();
  assert.deepEqual(result, { total_ms: 21, measured_ms: 17, other_ms: 4, phases: { preparation: { duration_ms: 5, calls: 1 }, hash: { duration_ms: 5, calls: 1 }, task: { duration_ms: 7, calls: 1 } } });
  assert.equal(summarizeTimings(40, [result, result]).phases.hash!.duration_ms, 10);
  assert.equal(summarizeTimings(40, [result, result]).other_ms, 6);
  // Earlier snapshots are stable after more measurements.
  await timings.measure('hash', async () => { now += 1; });
  assert.equal(result.phases.hash!.duration_ms, 5);
});

test('hash diagnostics aggregate counts without charging overlapping service time as wall time', () => {
  const timings = new Timings(() => 10);
  const profile = { algorithm: 'bounded', completed: true, duration_ms: 5, files: 3, directories: 1, symlinks: 0, content_bytes: 12, concurrency: 8, peak_buffered_files: 3, operations: { read: { calls: 3, service_ms: 20 } } };
  timings.recordHashScan(profile); const before = timings.snapshot();
  timings.recordHashScan({ ...profile, completed: false });
  assert.equal(before.hash_scan!.scans, 1); assert.equal(before.hash_scan!.operations.read!.service_ms, 20);
  const combined = summarizeTimings(100, [before, timings.snapshot()]);
  assert.equal(combined.hash_scan!.scans, 3); assert.equal(combined.hash_scan!.incomplete_scans, 1);
  assert.equal(combined.hash_scan!.content_bytes, 36); assert.equal(combined.hash_scan!.operations.read!.service_ms, 60);
  assert.equal(combined.measured_ms, 0); assert.equal(combined.other_ms, 100);
  assert.equal(combined.hash_scan!.peak_buffered_files, 3);
});
