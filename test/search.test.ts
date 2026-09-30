import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioSchema } from '../src/config.js';
import { searchPolicy, candidates } from '../src/search.js';

const scenario = () => scenarioSchema.parse({ id: 'build', command: ['node'], initial_write_grants: ['@workspace', '@cache'], narrower_candidates: [{ from: '@workspace', to: ['@workspace/dist'] }], assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }] });
test('search shrinks a parent grant, removes unrelated writes and retains a necessary output grant', async () => {
  let n = 0;
  const result = await searchPolicy(scenario(), { canContinue: () => true, evaluate: async grants => ({ id: String(n++), verdict: grants.includes('@workspace') || grants.includes('@workspace/dist') ? 'pass' : 'fail' }) });
  assert.deepEqual(result.grants, ['@workspace/dist']);
  assert.ok(result.steps.some(s => s.decision === 'rejected' && s.recovery_id));
});
test('failure of the recovery makes the result unknown and stops search', async () => {
  const result = await searchPolicy(scenario(), { canContinue: () => true, evaluate: async (_grants, phase) => ({ id: phase, verdict: 'fail' }) });
  assert.equal(result.stop, 'unstable');
  assert.equal(result.steps[0].decision, 'unknown');
  assert.deepEqual(result.grants, ['@cache', '@workspace']);
});
test('budget exhaustion preserves a working candidate without claiming exhaustion', async () => {
  const result = await searchPolicy(scenario(), { canContinue: () => false, evaluate: async () => { throw new Error('must not run'); } });
  assert.equal(result.stop, 'budget'); assert.equal(result.steps.length, 0);
});
test('candidate decisions are re-evaluated after another permission changes', async () => {
  const s = scenario(); s.initial_write_grants = ['@workspace/a', '@workspace/b']; s.narrower_candidates = [];
  const result = await searchPolicy(s, { canContinue: () => true, evaluate: async grants => ({ id: grants.join(','), verdict: grants.length === 1 && grants.includes('@workspace/b') ? 'fail' : 'pass' }) });
  assert.deepEqual(result.grants, []);
  assert.equal(result.steps[0].decision, 'rejected');
});
test('removing a covered grant is not described as an actual scope reduction', () => {
  const rows = candidates(scenario(), ['@workspace', '@workspace/dist']);
  assert.equal(rows.find(r => r.operation === 'remove @workspace/dist')?.semantic_change, false);
});
test('replacement candidates cannot exceed the exported policy grant limit', () => {
  const s = scenario();
  s.narrower_candidates = [{ from: '@workspace', to: Array.from({ length: 32 }, (_, i) => `@workspace/output-${i}`) }];
  assert.ok(candidates(s, ['@workspace', '@cache']).every(c => c.grants.length <= 32));
  assert.ok(candidates(s, ['@workspace']).some(c => c.grants.length === 32));
});
