import { fork } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { BackendContext, SandboxResult } from './backend.js';

/** The worker owns all proxy sockets. Parent waits for its actual exit and
 * bounds reset(), including CONNECT tunnels that server.close cannot drain. */
export async function superviseSandbox(command: string[], context: BackendContext, worker = new URL('./sandbox-worker.js', import.meta.url)) {
  const started = Date.now();
  if (context.signal?.aborted) throw new Error('Backend execution interrupted before worker start');
  // A short, private directory avoids the macOS Unix-socket path limit and
  // lets the parent remove plumbing even after a forcibly terminated reset.
  const plumbing = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'permsift-backend-')));
  try {
    return await new Promise<SandboxResult & { backend_cleanup: { isolated_worker: true; forced: boolean; reason?: string } }>((resolve, reject) => {
      const child = fork(worker, [], { detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        // Backend plumbing needs a short socket path; the sandboxed command still
        // receives its own HOME/TMPDIR from cleanEnvironment and the inner env.
        env: { PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: homedir(), TMPDIR: plumbing + '/', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' } });
      let result: SandboxResult | undefined, error: string | undefined, taskPid: number | undefined;
      let finished = false, forced = false, timedOut = false, aborted = false, stderr = '';
      let cleanupTimer: NodeJS.Timeout | undefined;
      const killGroup = (pid?: number) => { if (pid) try { process.kill(-pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') error = String(e); } };
      const force = () => { forced = true; killGroup(taskPid); killGroup(child.pid); };
      const armCleanup = () => { if (!cleanupTimer) cleanupTimer = setTimeout(force, 1000); };
      const cancel = () => { if (child.connected) child.send({ type: 'cancel' }, () => {}); armCleanup(); };
      const abort = () => { aborted = true; cancel(); };
      const timer = setTimeout(() => { timedOut = true; cancel(); }, Math.max(1, context.timeoutMs));
      context.signal?.addEventListener('abort', abort, { once: true });
      if (context.signal?.aborted) abort();
      child.stderr?.on('data', chunk => { if (stderr.length < 16384) stderr += chunk.toString().slice(0, 16384 - stderr.length); });
      child.on('message', message => {
        const m = message as { type: string; pid?: number; result?: SandboxResult; error?: string };
        if (m.type === 'task_start') taskPid = m.pid;
        if (m.type === 'result') {
          result = m.result; taskPid = undefined; // runProcess already killed the completed task's group.
          clearTimeout(timer); armCleanup();
        }
        if (m.type === 'finished') finished = true;
        if (m.type === 'error') { error = m.error; armCleanup(); }
      });
      child.on('error', e => { error = e.message; armCleanup(); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); if (cleanupTimer) clearTimeout(cleanupTimer);
        context.signal?.removeEventListener('abort', abort);
        // Also handles an unexpected worker crash while a detached task was live.
        killGroup(taskPid);
        if (!result || error || (!finished && !forced)) { reject(new Error(error ?? `Backend worker exited without complete evidence (${code ?? signal}); ${stderr}`)); return; }
        if (aborted || timedOut) result = { ...result, process: { ...result.process, status: aborted ? 'aborted' : 'timed_out', duration_ms: Date.now() - started } };
        resolve({ ...result, backend_cleanup: { isolated_worker: true, forced, ...(forced ? { reason: 'Worker cleanup exceeded 1 second; its process group was terminated and exit confirmed' } : {}) } });
      });
      const { signal: _signal, ...serializable } = context;
      child.send({ type: 'start', command, context: { ...serializable, protectedPaths: [...serializable.protectedPaths, plumbing], timeoutMs: Math.max(1, context.timeoutMs - (Date.now() - started)) } }, e => { if (e) { error = e.message; force(); } });
    });
  } finally { await fs.rm(plumbing, { recursive: true, force: true }); }
}
