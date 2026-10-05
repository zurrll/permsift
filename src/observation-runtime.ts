/** Compiled function source is copied into a private, write-protected CJS preload.
 * It uses only Node builtins; nothing from the host's node_modules is injected.
 * This is cooperative instrumentation for trusted tasks, not a security monitor. */
function preload(settings: { directory: string; maxEvents: number; maxBytes: number }) {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const mod = require('node:module') as typeof import('node:module');
  const threads = require('node:worker_threads') as typeof import('node:worker_threads');
  const { threadId } = threads;
  const cp = require('node:child_process') as typeof import('node:child_process');
  const file = path.join(settings.directory, `${process.pid}-${threadId}.jsonl`);
  let fd: number | undefined = fs.openSync(file, 'wx', 0o600);
  let count = 0, bytes = 0, truncated = false, ioError = false, ending = false;
  const reasons = new Set<string>();
  const seen = new Set<string>();
  const strings = new Map<string, number>();
  let writtenStrings = 0;
  const short = (s: unknown) => { if (typeof s !== 'string') return ''; if (s.length > 4096) { truncated = true; reasons.add('text_limit'); } return s.slice(0, 4096); };
  const location = (s: string | undefined) => {
    if (!s) return '';
    if (s.startsWith('file:')) { const u = new URL(s); u.search = ''; u.hash = ''; return short(u.href); }
    if (s.startsWith('node:')) return short(s);
    const protocol = s.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
    return protocol ? protocol[1] + ':' : short(s);
  };
  const write = (line: string) => {
    fd ??= fs.openSync(file, 'r+');
    const buffer = Buffer.from(line);
    if (fs.writeSync(fd, buffer, 0, buffer.length, bytes) !== buffer.length) throw new Error('Short trace write');
  };
  const finish = () => {
    const line = JSON.stringify({ kind: 'end', count, truncated, io_error: ioError, reasons: [...reasons], bytes_before_footer: bytes }) + '\n';
    try {
      write(line); fs.ftruncateSync(fd!, bytes + Buffer.byteLength(line));
    } catch { ioError = true; reasons.add('io_error'); }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Reader requires a valid footer. */ } fd = undefined; } }
  };
  const emit = (record: object, control = false) => {
    if ((truncated || ioError) && !control) { if (ending) finish(); return false; }
    const line = JSON.stringify(record) + '\n';
    if (!control && (count >= settings.maxEvents || bytes + Buffer.byteLength(line) > settings.maxBytes - 8192)) {
      truncated = true; reasons.add(count >= settings.maxEvents ? 'event_limit' : 'byte_limit'); if (ending) finish(); return false;
    }
    try { write(line); bytes += Buffer.byteLength(line); if (!control) count++; return true; }
    catch { ioError = true; reasons.add('io_error'); return false; }
    finally { if (ending) finish(); }
  };
  const unique = (record: { kind: string; [key: string]: unknown }) => {
    if (truncated || ioError) { if (ending) finish(); return; }
    if (record.kind === 'resolve' || record.kind === 'load') {
      const values = record.kind === 'resolve' ? [record.url, record.parent, record.request] : [record.url];
      const ids = values.map(value => { const text = value as string; if (!strings.has(text)) strings.set(text, strings.size); return strings.get(text)!; });
      const code = record.kind === 'resolve' ? 0 : 1, key = JSON.stringify([code, ...ids]);
      if (seen.has(key)) return;
      let next = writtenStrings;
      const refs = ids.map((id, i) => id < next ? id : (next++, [values[i]]));
      if (emit([code, ...refs])) { writtenStrings = next; seen.add(key); }
    } else {
      const key = JSON.stringify(record);
      if (!seen.has(key) && emit(record)) seen.add(key);
    }
  };
  const supported = typeof mod.registerHooks === 'function';
  emit({ kind: 'start', pid: process.pid, thread: threadId, node: process.version, hooks: supported, entry: short(process.argv[1]), encoding: 'interned-v1' }, true);
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
  // Parent-side facts explain missing worker footers; they never replace one.
  // Do not add an error listener: that would suppress the task's unhandled error.
  type State = { thread: number; referenced: boolean; termination_requested: boolean };
  const active = new Map<number, State>(), tracked = new WeakMap<object, State>();
  const OriginalWorker = threads.Worker;
  for (const method of ['ref', 'unref', 'terminate'] as const) {
    const original = OriginalWorker.prototype[method];
    (OriginalWorker.prototype as any)[method] = function (...args: any[]) {
      const result = Reflect.apply(original, this, args), state = tracked.get(this);
      if (state) {
        if (method === 'terminate') state.termination_requested = true; else state.referenced = method === 'ref';
        emit({ kind: 'worker', action: method === 'terminate' ? 'terminate_requested' : method, thread: state.thread });
        if (ending && active.has(state.thread)) emit({ kind: 'worker', action: 'parent_exit', ...state });
      }
      return result;
    };
  }
  threads.Worker = new Proxy(OriginalWorker, { construct(target, args, newTarget) {
    const worker = Reflect.construct(target, args, newTarget) as InstanceType<typeof OriginalWorker>;
    const entry = args[1]?.eval ? '(eval)' : args[0] instanceof URL ? location(args[0].href) : location(typeof args[0] === 'string' && /^(?:\.{1,2}\/|\/)/.test(args[0]) ? path.resolve(args[0]) : args[0]);
    if (!emit({ kind: 'worker', action: 'created', thread: worker.threadId, entry })) return worker;
    const state: State = { thread: worker.threadId, referenced: true, termination_requested: false };
    active.set(state.thread, state); tracked.set(worker, state);
    worker.once('exit', code => { active.delete(state.thread); emit({ kind: 'worker', action: 'exit', thread: state.thread, exit_code: code }); });
    if (ending) emit({ kind: 'worker', action: 'parent_exit', ...state });
    return worker;
  } });
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
    for (const state of active.values()) emit({ kind: 'worker', action: 'parent_exit', ...state });
    ending = true; finish();
  });
}

export const OBSERVER_VERSION = 'node-module-load-v4';
export function observationPreload(directory: string, maxEvents: number, maxBytes: number): string {
  return `'use strict';\ntry { (${preload.toString()})(${JSON.stringify({ directory, maxEvents, maxBytes })}); } catch (error) { console.error('Permsift observer could not start:', error.code || error.message); }\n`;
}
