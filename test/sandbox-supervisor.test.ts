import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { superviseSandbox } from '../src/sandbox-supervisor.js';

async function fixture(t: TestContext, body: string) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-supervisor-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worker = path.join(root, 'worker.cjs'), pidFile = path.join(root, 'pid');
  const result = { process: { status: 'completed', exit_code: 0, signal: null, stdout: 'real-result', stderr: '', duration_ms: 1 }, policy: {}, effective: {}, violations: [] };
  await fs.writeFile(worker, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.once('message',()=>{const result=${JSON.stringify(result)};${body}});`);
  return { worker: pathToFileURL(worker), pidFile, context: { roots: { workspace: root, cache: root, tmp: root }, experimentRoot: root, protectedPaths: [], grants: [], invocationId: 'unit', timeoutMs: 500, maxOutputBytes: 1024 } };
}
test('supervisor waits for worker exit and records normal cleanup', async t => {
  const f = await fixture(t, `process.send({type:'result',result},()=>process.send({type:'finished'},()=>process.exit(0)));`);
  const result = await superviseSandbox(['unused'], f.context, f.worker);
  assert.equal(result.process.stdout, 'real-result'); assert.equal(result.backend_cleanup.forced, false);
  const pid = Number(await fs.readFile(f.pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
});
test('a completed result survives a stuck cleanup only after its isolated worker is killed', async t => {
  const f = await fixture(t, `process.send({type:'result',result});setInterval(()=>{},1000);`);
  const result = await superviseSandbox(['unused'], f.context, f.worker);
  assert.equal(result.process.status, 'completed'); assert.equal(result.backend_cleanup.forced, true);
  const pid = Number(await fs.readFile(f.pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
});
test('a hung worker with no execution result cannot invent successful evidence', async t => {
  const f = await fixture(t, `setInterval(()=>{},1000);`);
  await assert.rejects(superviseSandbox(['unused'], { ...f.context, timeoutMs: 100 }, f.worker), /without complete evidence/);
  const pid = Number(await fs.readFile(f.pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
});
test('cancellation during stuck cleanup preserves an aborted result and terminates the worker', async t => {
  const f = await fixture(t, `process.send({type:'result',result});setInterval(()=>{},1000);`);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 200); t.after(() => clearTimeout(timer));
  const result = await superviseSandbox(['unused'], { ...f.context, signal: controller.signal }, f.worker);
  assert.equal(result.process.status, 'aborted'); assert.equal(result.backend_cleanup.forced, true);
});
