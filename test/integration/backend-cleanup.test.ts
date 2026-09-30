import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Socket } from 'node:net';
import { executeSandbox } from '../../src/backend.js';

test('a real CONNECT tunnel whose peer never sends FIN cannot hang backend cleanup', {
  skip: process.platform !== 'darwin' ? 'Requires real macOS sandbox and proxy' : false,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-connect-cleanup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = { workspace: path.join(root, 'workspace'), cache: path.join(root, 'cache'), tmp: path.join(root, 'tmp') };
  for (const directory of Object.values(roots)) await fs.mkdir(directory);
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.on('data', () => socket.write('permsift-ok'));
    // Intentionally retain our write half after the client sends FIN.
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  const script = `const net=require('node:net');const u=new URL(process.env.HTTP_PROXY);const auth=Buffer.from(decodeURIComponent(u.username)+':'+decodeURIComponent(u.password)).toString('base64');const s=net.connect(Number(u.port),u.hostname);let tunneled=false;s.on('connect',()=>s.write('CONNECT 127.0.0.1:${port} HTTP/1.1\\r\\nHost: 127.0.0.1:${port}\\r\\nProxy-Authorization: Basic '+auth+'\\r\\n\\r\\n'));s.on('data',b=>{const text=b.toString();if(!tunneled&&text.includes('200')){tunneled=true;s.write('ping');}else if(text.includes('permsift-ok')){console.log('received');s.end();process.exit(0);}});s.on('error',()=>process.exit(8));setTimeout(()=>process.exit(9),2000);`;
  const result = await executeSandbox([process.execPath, '-e', script], { roots, experimentRoot: root, protectedPaths: [], grants: [], networkGrants: ['127.0.0.1'], invocationId: 'connect-cleanup', timeoutMs: 3000, maxOutputBytes: 4096 });
  assert.equal(result.process.exit_code, 0, result.process.stderr); assert.equal(result.process.status, 'completed');
  assert.equal(result.process.stdout.trim(), 'received'); assert.equal(result.backend_cleanup.isolated_worker, true); assert.equal(result.backend_cleanup.forced, true);
  const plumbing = result.policy.filesystem.denyRead.find(p => p.startsWith('/private/tmp/permsift-backend-'));
  assert.ok(plumbing); await assert.rejects(fs.access(plumbing), 'Forced cleanup must also remove backend socket files');
  // Reuse is a fresh backend worker, not the stuck proxy's singleton.
  const next = await executeSandbox([process.execPath, '-e', "console.log('next')"], { roots, experimentRoot: root, protectedPaths: [], grants: [], invocationId: 'after-connect-cleanup', timeoutMs: 3000, maxOutputBytes: 4096 });
  assert.equal(next.process.exit_code, 0); assert.equal(next.backend_cleanup.forced, false);
});
