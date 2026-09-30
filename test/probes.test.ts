import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { controlChecks, startEndpoint, closeEndpoint } from '../src/probes.js';

test('missing fixtures and dead endpoints cannot be counted as blocked access', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-probes-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const endpoint = await startEndpoint();
  const fixtures = { secret: path.join(root,'secret'), outside: path.join(root,'outside'), report: path.join(root,'report'), marker: 'fake', port: endpoint.port };
  for (const file of [fixtures.secret, fixtures.outside, fixtures.report]) await fs.writeFile(file, 'fake');
  assert.ok((await controlChecks(fixtures)).every(c => c.status === 'pass'));
  await fs.unlink(fixtures.secret); await closeEndpoint(endpoint.server);
  const checks = await controlChecks(fixtures);
  assert.equal(checks[0].status, 'unknown'); assert.equal(checks.at(-1)?.status, 'unknown');
});
test('tampered fixture is reported without silently restoring its contents', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-probes-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const endpoint = await startEndpoint(); t.after(() => closeEndpoint(endpoint.server));
  const fixtures = { secret: path.join(root,'secret'), outside: path.join(root,'outside'), report: path.join(root,'report'), marker: 'fake', port: endpoint.port };
  for (const file of [fixtures.secret, fixtures.outside, fixtures.report]) await fs.writeFile(file, 'fake');
  await fs.writeFile(fixtures.outside, 'changed');
  assert.equal((await controlChecks(fixtures))[1].status, 'unknown');
  assert.equal(await fs.readFile(fixtures.outside, 'utf8'), 'changed');
});
