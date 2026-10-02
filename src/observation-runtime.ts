/** Compiled function source is copied into a private, write-protected CJS preload.
 * It uses only Node builtins; nothing from the host's node_modules is injected.
 * This is cooperative instrumentation for trusted tasks, not a security monitor. */
function preload(settings: { directory: string; maxEvents: number; maxBytes: number }) {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const mod = require('node:module') as typeof import('node:module');
  const { threadId } = require('node:worker_threads') as typeof import('node:worker_threads');
  const cp = require('node:child_process') as typeof import('node:child_process');
  const fd = fs.openSync(path.join(settings.directory, `${process.pid}-${threadId}.jsonl`), 'wx', 0o600);
  let count = 0, bytes = 0, truncated = false, ioError = false;
  const seen = new Set<string>();
  const short = (s: unknown) => { if (typeof s !== 'string') return ''; if (s.length > 4096) truncated = true; return s.slice(0, 4096); };
  const location = (s: string | undefined) => {
    if (!s) return '';
    if (s.startsWith('file:')) { const u = new URL(s); u.search = ''; u.hash = ''; return short(u.href); }
    if (s.startsWith('node:')) return short(s);
    const protocol = s.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
    return protocol ? protocol[1] + ':' : short(s);
  };
  const emit = (record: object, control = false) => {
    if (ioError) return;
    const line = JSON.stringify(record) + '\n';
    if (!control && (count >= settings.maxEvents || bytes + Buffer.byteLength(line) > settings.maxBytes - 8192)) { truncated = true; return; }
    try { fs.writeSync(fd, line); bytes += Buffer.byteLength(line); if (!control) count++; }
    catch { ioError = true; }
  };
  const unique = (record: object) => {
    if (truncated || ioError) return;
    const key = JSON.stringify(record);
    if (!seen.has(key)) { emit(record); if (!truncated) seen.add(key); }
  };
  const supported = typeof mod.registerHooks === 'function';
  emit({ kind: 'start', pid: process.pid, thread: threadId, node: process.version, hooks: supported, entry: short(process.argv[1]) }, true);
  if (supported) mod.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      unique({ kind: 'resolve', url: location(result.url), parent: location(context.parentURL), request: location(specifier) });
      return result;
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      unique({ kind: 'load', url: location(url) });
      return result;
    },
  });
  // Record launch attempts, including native tools which the module hooks cannot
  // observe. Do not store command arguments, inherited environments or tokens.
  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync'] as const) {
    const original = cp[method] as Function;
    (cp as any)[method] = function (...args: any[]) {
      const options = args.slice(1).find(a => a && typeof a === 'object' && !Array.isArray(a));
      const environment = options?.env ?? process.env;
      unique({ kind: 'child', method, executable: method === 'exec' || method === 'execSync' ? '(shell command)' : short(args[0]),
        preload_inherited: typeof environment.NODE_OPTIONS === 'string' && environment.NODE_OPTIONS.includes(__filename) });
      return Reflect.apply(original, this, args);
    };
  }
  mod.syncBuiltinESMExports();
  // execve replaces Node without firing its exit handlers. Keep that launch
  // attempt visible; the missing footer still marks module capture incomplete.
  if (typeof process.execve === 'function') {
    const original = process.execve;
    process.execve = function (file, args, environment) {
      const env = environment ?? process.env;
      unique({ kind: 'child', method: 'execve', executable: short(file),
        preload_inherited: typeof env.NODE_OPTIONS === 'string' && env.NODE_OPTIONS.includes(__filename) });
      return Reflect.apply(original, this, [file, args, environment]);
    };
  }
  process.once('exit', () => {
    emit({ kind: 'end', count, truncated, io_error: ioError }, true);
    try { fs.closeSync(fd); } catch { /* The reader requires a valid footer. */ }
  });
}

export const OBSERVER_VERSION = 'node-module-load-v2';
export function observationPreload(directory: string, maxEvents: number, maxBytes: number): string {
  return `'use strict';\ntry { (${preload.toString()})(${JSON.stringify({ directory, maxEvents, maxBytes })}); } catch (error) { console.error('Permsift observer could not start:', error.code || error.message); }\n`;
}
