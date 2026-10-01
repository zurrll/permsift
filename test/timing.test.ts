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
