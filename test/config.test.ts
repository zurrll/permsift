import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { aliasSchema, configSchema, limitsSchema, validatePolicy, loadConfiguration } from '../src/config.js';

const scenario = { id: 'build', command: ['node', 'build.js'], initial_write_grants: ['@workspace'], assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }] };
const config = () => configSchema.parse({ schema_version: 1, scenarios: [scenario] });
const limits = () => limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace'] });

test('aliases reject traversal, globbing, absolute paths and shell expansions', () => {
  for (const value of ['@workspace/../secret', '@workspace/.', '@workspace//a', '@workspace/*', '/tmp', '@workspace/$HOME', '@workspace/$(whoami)', '@workspace\\secret']) {
    assert.equal(aliasSchema.safeParse(value).success, false, value);
  }
  assert.equal(aliasSchema.parse('@workspace/build-v1.2'), '@workspace/build-v1.2');
});
test('project config cannot inject raw backend settings or host validators', () => {
  assert.throws(() => configSchema.parse({ ...config(), allowAppleEvents: true }));
  assert.throws(() => configSchema.parse({ ...config(), scenarios: [{ ...scenario, assertions: [{ type: 'shell', command: 'echo fake' }] }] }));
});
test('explicit trusted ceiling rejects extra grants and subtree prefix confusion', () => {
  const c = config();
  const l = limits(); l.allowed_write_roots = ['@workspace/dist'];
  assert.throws(() => validatePolicy(c, l), /exceeds/);
  c.scenarios[0].initial_write_grants = ['@workspace/dist-other'];
  assert.throws(() => validatePolicy(c, l), /exceeds/);
});
test('narrowing cannot widen or move to another root', () => {
  const c = config();
  c.scenarios[0].narrower_candidates = [{ from: '@workspace', to: ['@cache'] }];
  assert.throws(() => validatePolicy(c, limits()), /strict descendants/);
});
test('duplicate scenario IDs and duplicate grants are rejected', () => {
  const c = config(); c.scenarios.push(c.scenarios[0]);
  assert.throws(() => validatePolicy(c, limits()), /Duplicate scenario/);
  const other = config(); other.scenarios[0].initial_write_grants.push('@workspace');
  assert.throws(() => validatePolicy(other, limits()), /Duplicate write/);
});
test('schema rejects missing assertions and invalid budgets', () => {
  assert.throws(() => configSchema.parse({ schema_version: 1, scenarios: [{ ...scenario, assertions: [] }] }));
  assert.throws(() => limitsSchema.parse({ ...limits(), repetitions: 0 }));
  assert.throws(() => limitsSchema.parse({ ...limits(), max_candidates: -1 }));
});
test('YAML duplicate keys are rejected before execution', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-config-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'config.yaml'), 'schema_version: 1\nschema_version: 2\n');
  await fs.writeFile(path.join(dir, 'limits.json'), JSON.stringify(limits()));
  await assert.rejects(loadConfiguration(path.join(dir, 'config.yaml'), path.join(dir, 'limits.json')), /unique|Duplicate|Map keys/i);
});
