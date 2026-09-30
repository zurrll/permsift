import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, shellQuote } from '../src/process.js';
import { cleanEnvironment } from '../src/backend.js';

const options = () => ({ cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 3000, maxOutputBytes: 4096 });
test('shell argument quoting preserves metacharacters without executing them', async () => {
  const value = "spaces ' quotes $(echo INJECTED) `echo no` ; $HOME\nend";
  const command = [process.execPath, '-e', 'process.stdout.write(process.argv[1])', value].map(shellQuote).join(' ');
  const result = await runProcess(['/bin/sh', '-c', command], options());
  assert.equal(result.exit_code, 0); assert.equal(result.stdout, value);
});
test('unbounded output is stopped and evidence is capped', async () => {
  const result = await runProcess([process.execPath, '-e', "setInterval(()=>process.stdout.write('x'.repeat(8192)),1)"], options());
  assert.equal(result.status, 'output_limit'); assert.ok(Buffer.byteLength(result.stdout) <= 4096);
});
test('timeout kills the workload process group', async () => {
  const result = await runProcess([process.execPath, '-e', 'setInterval(()=>{},1000)'], { ...options(), timeoutMs: 100 });
  assert.equal(result.status, 'timed_out'); assert.ok(result.duration_ms < 2500);
});
test('leader exit cleans up a background child that retains stdout', async () => {
  const script = "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.exit(0)";
  const result = await runProcess([process.execPath, '-e', script], options());
  assert.equal(result.status, 'completed'); assert.ok(result.duration_ms < 2500);
});
test('cancellation and spawn errors are explicit', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const result = await runProcess([process.execPath, '-e', 'setInterval(()=>{},1000)'], { ...options(), signal: controller.signal });
  clearTimeout(timer); assert.equal(result.status, 'aborted');
  const missing = await runProcess(['/permsift/does-not-exist'], options());
  assert.equal(missing.status, 'error');
});
test('child environment does not inherit ambient tokens, shell startup files or Node injection flags', () => {
  process.env.PERMSIFT_TEST_TOKEN = 'fake';
  const env = cleanEnvironment({ workspace: '/test/work', cache: '/test/cache', tmp: '/test/tmp' });
  assert.equal(env.PERMSIFT_TEST_TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.BASH_ENV, undefined);
  assert.equal(env.HOME, '/test/tmp');
  delete process.env.PERMSIFT_TEST_TOKEN;
});
