import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Retain selection and original exit codes; a receipt never makes a failed process pass. */
export async function runCommands(label, commands, selection) {
  await fs.mkdir('.permsift', { recursive: true });
  const root = await fs.mkdtemp(path.join('.permsift', 'ci-' + label + '-'));
  const receipt = { kind: 'ci_verification', selection, platform: process.platform, node: process.version,
    started_at: new Date().toISOString(), status: 'running', commands: [] };
  const save = () => fs.writeFile(path.join(root, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n');
  await save(); console.log('CI selection and process results: ' + path.join(root, 'verification.json'));
  try {
    for (const [executable, ...args] of commands) {
      const start = performance.now(), child = spawn(executable, args, { stdio: 'inherit' });
      let requestedSignal;
      const interrupt = () => { requestedSignal ??= 'SIGINT'; child.kill('SIGINT'); }, terminate = () => { requestedSignal ??= 'SIGTERM'; child.kill('SIGTERM'); };
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
      let result;
      try { result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); }
      finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
      receipt.commands.push({ executable, args, exit_code: result.code, signal: result.signal,
        ...requestedSignal ? { interruption_requested: requestedSignal } : {}, duration_ms: performance.now() - start });
      await save();
      if (requestedSignal || result.code !== 0) {
        const signal = requestedSignal ?? result.signal;
        receipt.status = signal ? 'interrupted' : 'failed';
        return requestedSignal ? (requestedSignal === 'SIGINT' ? 130 : 143) : result.code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
      }
    }
    receipt.status = 'completed'; return 0;
  } catch (e) { receipt.status = 'failed'; receipt.error = String(e); throw e; }
  finally { receipt.finished_at = new Date().toISOString(); await save(); }
}
