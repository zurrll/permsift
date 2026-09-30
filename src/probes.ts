import { createServer, createConnection, type Server } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { executeSandbox, type BackendContext } from './backend.js';
import type { Check } from './assertions.js';

export function canConnect(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}
export async function startEndpoint(): Promise<{ server: Server; port: number }> {
  const server = createServer(socket => { socket.on('error', () => {}); socket.end('permsift-control'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, port: (server.address() as { port: number }).port };
}
export const closeEndpoint = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
export type Fixtures = { secret: string; outside: string; report: string; marker: string; port: number };

export async function controlChecks(fixtures: Fixtures): Promise<Check[]> {
  const checks: Check[] = [];
  for (const file of [fixtures.secret, fixtures.outside, fixtures.report]) {
    try {
      if (await readFile(file, 'utf8') !== fixtures.marker) throw new Error('Fixture changed');
      // Actual writeability control, restricted to the fake fixture only.
      if (file !== fixtures.secret) await writeFile(file, fixtures.marker);
      checks.push({ name: `control:${file}`, status: 'pass', detail: 'Fixture present; content verified' });
    } catch (e) { checks.push({ name: `control:${file}`, status: 'unknown', detail: String(e) }); }
  }
  checks.push({ name: 'control:network_endpoint', status: await canConnect(fixtures.port) ? 'pass' : 'unknown', detail: 'Host loopback connectivity control' });
  return checks;
}

export function probeScript(fixtures: Fixtures) {
  return `
const fs = require('node:fs'); const net = require('node:net');
const f = ${JSON.stringify(fixtures)}; const checks = [];
function blocked(name, action) {
  try { action(); checks.push({name,status:'fail',detail:'Operation was allowed'}); }
  catch(e) { checks.push({name,status:['EPERM','EACCES'].includes(e.code)?'pass':'unknown',detail:String(e.code)}); }
}
blocked('secret_unreadable',()=>fs.readFileSync(f.secret));
blocked('outside_unwritable',()=>fs.writeFileSync(f.outside,'tampered'));
blocked('report_unwritable',()=>fs.writeFileSync(f.report,'tampered'));
const s = net.createConnection({host:'127.0.0.1',port:f.port});
let done = false;
function finish(status,detail) { if(done)return;done=true;s.destroy();checks.push({name:'network_blocked',status,detail});console.log(JSON.stringify(checks)); }
s.once('connect',()=>finish('fail','Connection succeeded'));
s.once('error',e=>finish(['EPERM','EACCES'].includes(e.code)?'pass':'unknown',String(e.code)));
s.setTimeout(1000,()=>finish('unknown','Probe timed out'));
`;
}
export async function boundaryChecks(fixtures: Fixtures, context: BackendContext) {
  const controls = await controlChecks(fixtures);
  if (controls.some(c => c.status !== 'pass')) return { checks: controls, execution: null };
  const execution = await executeSandbox([process.execPath, '-e', probeScript(fixtures)], { ...context, invocationId: context.invocationId + '-probe', timeoutMs: Math.min(context.timeoutMs, 5000) });
  let checks: Check[];
  try {
    if (execution.process.status !== 'completed' || execution.process.exit_code !== 0) throw new Error('Probe process did not complete');
    checks = JSON.parse(execution.process.stdout);
    const expected = ['secret_unreadable', 'outside_unwritable', 'report_unwritable', 'network_blocked'];
    if (!Array.isArray(checks) || checks.length !== 4 || checks.some((c, i) => c.name !== expected[i] || !['pass','fail','unknown'].includes(c.status))) throw new Error('Invalid probe response');
  } catch (e) { checks = [{ name: 'probe_execution', status: 'unknown', detail: String(e) }]; }
  const after = await controlChecks(fixtures);
  return { checks: [...controls, ...checks, ...after], execution };
}
