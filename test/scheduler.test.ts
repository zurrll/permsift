import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioSchema } from '../src/config.js';
import { searchPolicy, type TrialVerdict } from '../src/search.js';

const scenario = (names: string[]) => scenarioSchema.parse({
  id: 'build', command: ['node'], initial_write_grants: [], initial_read_grants: names.map(n => '@workspace/' + n),
  assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }],
});

test('batching unused siblings reduces evaluations while preserving necessary grants and recovery', async () => {
  const s = scenario(['a-required', ...Array.from({ length: 18 }, (_, i) => `unused-${String(i).padStart(2, '0')}`)]);
  const calls: { grants: string[]; phase: string }[] = [];
  const works = (grants: string[]) => grants.includes('@workspace/a-required');
  const result = await searchPolicy(s, { permission: 'read', canContinue: () => true, evaluate: async (grants, phase) => {
    calls.push({ grants, phase }); return { id: String(calls.length), verdict: works(grants) ? 'pass' : 'fail' };
  } });
  assert.deepEqual(result.grants, ['@workspace/a-required']);
  assert.equal(result.stop, 'exhausted');
  assert.ok(result.steps.some(s => s.source === 'group_removal' && s.decision === 'accepted' && s.removed_grants!.length > 1));
  assert.ok(result.steps.filter(s => s.decision === 'rejected').every(s => s.recovery_id));
  assert.ok(calls.filter(c => c.phase === 'recovery_read').every(c => works(c.grants)));
  // Previous single-removal scheduling retries the required first grant after
  // every successful deletion, with one recovery for each rejected attempt.
  const previousCalls = 3 * (s.initial_read_grants!.length - 1) + 2;
  assert.ok(calls.length < previousCalls / 2, `${calls.length} evaluations vs ${previousCalls}`);
  assert.ok(result.steps.filter(s => s.operation === 'remove @workspace/a-required').length <= 2);
});

test('a failed group is split and does not label every group member as necessary', async () => {
  const s = scenario(['a-required', 'b-unused', 'c-unused']);
  let count = 0;
  const result = await searchPolicy(s, { permission: 'read', canContinue: () => true, evaluate: async grants => ({ id: String(++count), verdict: grants.includes('@workspace/a-required') ? 'pass' : 'fail' }) });
  assert.equal(result.steps[0].source, 'group_removal'); assert.equal(result.steps[0].decision, 'rejected');
  assert.ok(result.steps.some(s => s.decision === 'accepted' && s.removed_grants?.join(',') === '@workspace/b-unused,@workspace/c-unused'));
  assert.deepEqual(result.grants, ['@workspace/a-required']);
  const lastRound = result.steps.filter(s => s.round === result.rounds);
  assert.ok(lastRound.length && lastRound.every(s => s.decision === 'rejected'));
  assert.deepEqual(lastRound[0].before, result.grants);
});

test('failed removals are revisited in a later round when another removal changes behavior', async () => {
  const s = scenario(['a-input', 'b-feature', 'c-required']);
  let count = 0;
  const works = (grants: string[]) => grants.includes('@workspace/c-required') && (!grants.includes('@workspace/b-feature') || grants.includes('@workspace/a-input'));
  const result = await searchPolicy(s, { permission: 'read', canContinue: () => true, evaluate: async grants => ({ id: String(++count), verdict: works(grants) ? 'pass' : 'fail' }) });
  const input = result.steps.filter(s => s.operation === 'remove @workspace/a-input');
  assert.equal(input[0].decision, 'rejected'); assert.equal(input.at(-1)?.decision, 'accepted');
  assert.ok(input[0].round < input.at(-1)!.round);
  assert.deepEqual(result.grants, ['@workspace/c-required']);
});

test('two permissions can be removed together even when each individual deletion would fail', async () => {
  const s = scenario(['a-required', 'b-pair', 'c-pair']);
  let count = 0;
  const works = (grants: string[]) => grants.includes('@workspace/a-required') && grants.includes('@workspace/b-pair') === grants.includes('@workspace/c-pair');
  assert.equal(works(['@workspace/a-required', '@workspace/b-pair']), false);
  assert.equal(works(['@workspace/a-required', '@workspace/c-pair']), false);
  const result = await searchPolicy(s, { permission: 'read', canContinue: () => true, evaluate: async grants => ({ id: String(++count), verdict: works(grants) ? 'pass' : 'fail' }) });
  assert.deepEqual(result.grants, ['@workspace/a-required']);
  assert.ok(result.steps.some(s => s.decision === 'accepted' && s.removed_grants?.length === 2));
});

test('candidate budget includes groups and stops before evaluating split children', async () => {
  const s = scenario(['a', 'b', 'c']);
  let remaining = 1; const phases: string[] = [];
  const result = await searchPolicy(s, { permission: 'read', canContinue: () => remaining > 0, evaluate: async (_grants, phase) => {
    phases.push(phase); if (phase === 'candidate_read') remaining--;
    return { id: String(phases.length), verdict: phase === 'recovery_read' ? 'pass' : 'fail' };
  } });
  assert.equal(result.stop, 'budget'); assert.equal(result.steps.length, 1);
  assert.deepEqual(result.grants, s.initial_read_grants);
  assert.deepEqual(phases, ['candidate_read', 'recovery_read']);
});

test('unstable group recovery stops before splitting or accepting any new policy', async () => {
  const s = scenario(['a', 'b', 'c']); let count = 0;
  const result = await searchPolicy(s, { permission: 'read', canContinue: () => true, evaluate: async () => ({ id: String(++count), verdict: 'fail' }) });
  assert.equal(count, 2); assert.equal(result.stop, 'unstable');
  assert.equal(result.steps[0].decision, 'unknown'); assert.deepEqual(result.grants, s.initial_read_grants);
});

test('unknown group results remain inconclusive while recovered split trials can still narrow', async () => {
  const s = scenario(['a-required', 'b-unused', 'c-unused']); let count = 0;
  const result = await searchPolicy(s, { permission: 'read', canContinue: () => true, evaluate: async grants => {
    let verdict: TrialVerdict = grants.includes('@workspace/a-required') ? 'pass' : 'fail';
    if (++count === 1) verdict = 'unknown';
    return { id: String(count), verdict };
  } });
  assert.equal(result.steps[0].decision, 'unknown'); assert.ok(result.steps[0].recovery_id);
  assert.deepEqual(result.grants, ['@workspace/a-required']);
  assert.ok(result.steps.some(s => s.decision === 'accepted'));
});

test('identical failed policies guide splitting within one round but final necessary removals run fresh', async () => {
  const s = scenario(['placeholder']); s.initial_read_grants = ['@workspace'];
  s.narrower_read_candidates = [{ from: '@workspace', to: ['@workspace/a-required', '@workspace/b-unused', '@workspace/c-unused'] }];
  const calls: { grants: string[]; phase: string }[] = [];
  const result = await searchPolicy(s, { permission: 'read', canContinue: () => true, evaluate: async (grants, phase) => {
    calls.push({ grants, phase }); return { id: String(calls.length), verdict: grants.includes('@workspace') || grants.includes('@workspace/a-required') ? 'pass' : 'fail' };
  } });
  assert.deepEqual(result.grants, ['@workspace/a-required']);
  assert.ok(result.reuses.some(r => r.after.length === 0 && r.failed_trial_id === result.steps[0].trial_id));
  assert.equal(calls.filter(c => c.phase === 'candidate_read' && c.grants.length === 0).length, 2);
  const final = result.steps.at(-1)!;
  assert.deepEqual(final.before, result.grants); assert.equal(final.decision, 'rejected');
  assert.ok(final.round > result.reuses[0].round);
});

test('unknown results are never reused as failure hints', async () => {
  const s = scenario(['placeholder']); s.initial_read_grants = ['@workspace'];
  s.narrower_read_candidates = [{ from: '@workspace', to: ['@workspace/a-required', '@workspace/b-unused', '@workspace/c-unused'] }];
  let count = 0; let emptyCandidates = 0;
  const result = await searchPolicy(s, { permission: 'read', canContinue: () => true, evaluate: async (grants, phase) => {
    if (phase === 'candidate_read' && !grants.length) emptyCandidates++;
    const verdict = ++count === 1 ? 'unknown' : grants.includes('@workspace') || grants.includes('@workspace/a-required') ? 'pass' : 'fail';
    return { id: String(count), verdict };
  } });
  assert.equal(result.steps[0].decision, 'unknown');
  assert.ok(result.reuses.every(r => r.failed_trial_id !== result.steps[0].trial_id));
  assert.equal(emptyCandidates, 3);
});

test('write siblings use the same batching and recovery while read permissions remain outside the search', async () => {
  const s = scenario(['a-required', 'b-unused', 'c-unused']);
  s.initial_write_grants = s.initial_read_grants!; s.initial_read_grants = [];
  const phases: string[] = [];
  const result = await searchPolicy(s, { canContinue: () => true, evaluate: async (grants, phase) => {
    phases.push(phase); return { id: String(phases.length), verdict: grants.includes('@workspace/a-required') ? 'pass' : 'fail' };
  } });
  assert.deepEqual(result.grants, ['@workspace/a-required']);
  assert.ok(result.steps.some(s => s.source === 'group_removal' && s.decision === 'accepted'));
  assert.ok(result.steps.every(s => s.permission === 'write'));
  assert.ok(phases.includes('recovery')); assert.ok(!phases.some(p => p.includes('read')));
});

test('a complete comparison after the last accepted change does not cause a duplicate closing round', async () => {
  const s = scenario(['a-unused', 'z-required']); let calls = 0;
  const result = await searchPolicy(s, { permission: 'read', canContinue: () => true, evaluate: async grants => ({
    id: String(++calls), verdict: grants.includes('@workspace/z-required') ? 'pass' : 'fail',
  }) });
  assert.equal(result.rounds, 1); assert.equal(calls, 3);
  assert.deepEqual(result.grants, ['@workspace/z-required']);
  assert.deepEqual(result.steps.at(-1)?.before, result.grants);
  assert.equal(result.steps.at(-1)?.decision, 'rejected');
});
