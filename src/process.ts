import { spawn } from 'node:child_process';

export type ProcessResult = {
  exit_code: number | null; signal: string | null; stdout: string; stderr: string;
  status: 'completed' | 'timed_out' | 'aborted' | 'output_limit' | 'error'; duration_ms: number; error?: string;
};
export function shellQuote(value: string) {
  if (value.includes('\0')) throw new Error('NUL in argument');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export async function runProcess(argv: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal;
}): Promise<ProcessResult> {
  const started = Date.now();
  if (options.signal?.aborted) return { exit_code: null, signal: null, stdout: '', stderr: '', status: 'aborted', duration_ms: 0 };
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let status: ProcessResult['status'] = 'completed';
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let bytes = 0;
    let error: string | undefined;
    const kill = () => {
      if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') error = String(e);
      }
    };
    const stop = (reason: ProcessResult['status']) => { if (status === 'completed') status = reason; kill(); };
    const abort = () => stop('aborted');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timeout = setTimeout(() => stop('timed_out'), Math.max(1, options.timeoutMs));
    for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (chunk: Buffer) => {
      const remaining = Math.max(0, options.maxOutputBytes - bytes);
      chunks[stream].push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) stop('output_limit');
    });
    child.on('error', e => { error = e.message; status = 'error'; });
    // A background child may retain stdout; kill the process group at leader exit.
    child.on('exit', kill);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      resolve({ exit_code: code, signal, stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString(), status, duration_ms: Date.now() - started, ...(error ? { error } : {}) });
    });
  });
}
