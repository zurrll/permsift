import { traceBudget, type TraceBudget } from './trace-budget.js';

/** Compiled function source is copied into a private, write-protected CJS preload.
 * It uses only Node builtins; nothing from the host's node_modules is injected.
 * This is cooperative instrumentation for trusted tasks, not a security monitor. */
function preload(settings: { directory: string; maxEvents: number; maxBytes: number; budget: TraceBudget }) {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const mod = require('node:module') as typeof import('node:module');
  const threads = require('node:worker_threads') as typeof import('node:worker_threads');
  const { threadId } = threads;
  const cp = require('node:child_process') as typeof import('node:child_process');
  const file = path.join(settings.directory, `${process.pid}-${threadId}.jsonl`);
  let fd: number | undefined = fs.openSync(file, 'wx', 0o600);
  let count = 0, bytes = 0, ioError = false, ending = false;
  const { budget } = settings;
  const details = { events: 0, bytes: 0, reasons: new Set<string>() };
  const workers = { events: 0, bytes: 0, history_events: 0, history_bytes: 0, omitted_workers: 0, reasons: new Set<string>() };
  type State = { thread: number; referenced: boolean; termination_requested: boolean; exit_code?: number };
  const states = new Map<number, State>(), tracked = new WeakMap<object, State>();
  const seen = new Set<string>();
  const strings = new Map<string, number>();
  let writtenStrings = 0;
  const short = (s: unknown, worker = false) => { if (typeof s !== 'string') return ''; if (s.length > 4096) (worker ? workers : details).reasons.add(worker ? 'worker_text_limit' : 'text_limit'); return s.slice(0, 4096); };
  const location = (s: string | undefined, worker = false) => {
    if (!s) return '';
    if (s.startsWith('file:')) { const u = new URL(s); u.search = ''; u.hash = ''; return short(u.href, worker); }
    if (s.startsWith('node:')) return short(s, worker);
    const protocol = s.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
    return protocol ? protocol[1] + ':' : short(s, worker);
  };
  const write = (line: string) => {
    fd ??= fs.openSync(file, 'r+');
    const buffer = Buffer.from(line);
    if (fs.writeSync(fd, buffer, 0, buffer.length, bytes) !== buffer.length) throw new Error('Short trace write');
  };
  const finish = () => {
    const reasons = [...details.reasons, ...workers.reasons, ...ioError ? ['io_error'] : []];
    const line = JSON.stringify({ kind: 'end', count, truncated: details.reasons.size > 0 || workers.reasons.size > 0, io_error: ioError, reasons, bytes_before_footer: bytes,
      channels: { details: { ...details, reasons: [...details.reasons] }, workers: { ...workers, reasons: [...workers.reasons] } },
      worker_states: [...states.values()].map(s => ({ ...s, ...s.exit_code === undefined ? { parent_exit: true } : {} })) }) + '\n';
    try {
      if (Buffer.byteLength(line) > budget.footer_bytes || bytes + Buffer.byteLength(line) > settings.maxBytes) throw new Error('Footer exceeds reserved bytes');
      write(line); fs.ftruncateSync(fd!, bytes + Buffer.byteLength(line));
    } catch { ioError = true; }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Reader requires a valid footer. */ } fd = undefined; } }
  };
  const emit = (record: object, channel: 'control' | 'details' | 'created' | 'history' = 'details') => {
    const line = JSON.stringify(record) + '\n', size = Buffer.byteLength(line);
    if (ioError) { if (ending) finish(); return false; }
    if (channel === 'details') {
      if (details.reasons.size) { if (ending) finish(); return false; }
      if (details.events >= budget.details.events || details.bytes + size > budget.details.bytes || bytes + size > settings.maxBytes - budget.footer_bytes) {
        details.reasons.add(details.events >= budget.details.events ? 'event_limit' : 'byte_limit'); if (ending) finish(); return false;
      }
    } else if (channel === 'history') {
      if (workers.reasons.has('worker_history_event_limit') || workers.reasons.has('worker_history_byte_limit')) { if (ending) finish(); return false; }
      if (workers.history_events >= budget.workers.history_events || workers.history_bytes + size > budget.workers.history_bytes || bytes + size > settings.maxBytes - budget.footer_bytes) {
        workers.reasons.add(workers.history_events >= budget.workers.history_events ? 'worker_history_event_limit' : 'worker_history_byte_limit'); if (ending) finish(); return false;
      }
    } else if (channel === 'created') {
      if (workers.bytes - workers.history_bytes + size > budget.workers.bytes - budget.workers.history_bytes || bytes + size > settings.maxBytes - budget.footer_bytes) {
        workers.reasons.add('worker_creation_byte_limit'); if (ending) finish(); return false;
      }
    }
    try {
      write(line); bytes += size;
      if (channel !== 'control') count++;
      if (channel === 'details') { details.events++; details.bytes += size; }
      if (channel === 'created' || channel === 'history') { workers.events++; workers.bytes += size; }
      if (channel === 'history') { workers.history_events++; workers.history_bytes += size; }
      return true;
    }
    catch { ioError = true; return false; }
    finally { if (ending) finish(); }
  };
  const unique = (record: { kind: string; [key: string]: unknown }) => {
    if (details.reasons.size || ioError) { if (ending) finish(); return; }
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
  emit({ kind: 'start', pid: process.pid, thread: threadId, node: process.version, hooks: supported, entry: short(process.argv[1]), encoding: 'interned-v1', budget }, 'control');
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
  const OriginalWorker = threads.Worker;
  for (const method of ['ref', 'unref', 'terminate'] as const) {
    const original = OriginalWorker.prototype[method];
    (OriginalWorker.prototype as any)[method] = function (...args: any[]) {
      const result = Reflect.apply(original, this, args), state = tracked.get(this);
      if (state) {
        if (method === 'terminate') state.termination_requested = true; else state.referenced = method === 'ref';
        emit({ kind: 'worker', action: method === 'terminate' ? 'terminate_requested' : method, thread: state.thread }, 'history');
      }
      return result;
    };
  }
  threads.Worker = new Proxy(OriginalWorker, { construct(target, args, newTarget) {
    const worker = Reflect.construct(target, args, newTarget) as InstanceType<typeof OriginalWorker>;
    if (states.size >= budget.workers.max_workers) { workers.omitted_workers = Math.min(2_147_483_647, workers.omitted_workers + 1); workers.reasons.add('worker_state_limit'); if (ending) finish(); return worker; }
    const entry = args[1]?.eval ? '(eval)' : args[0] instanceof URL ? location(args[0].href, true) : location(typeof args[0] === 'string' && /^(?:\.{1,2}\/|\/)/.test(args[0]) ? path.resolve(args[0]) : args[0], true);
    if (!emit({ kind: 'worker', action: 'created', thread: worker.threadId, entry }, 'created')) { workers.omitted_workers = Math.min(2_147_483_647, workers.omitted_workers + 1); if (ending) finish(); return worker; }
    const state: State = { thread: worker.threadId, referenced: true, termination_requested: false };
    states.set(state.thread, state); tracked.set(worker, state);
    worker.once('exit', code => { state.exit_code = code; emit({ kind: 'worker', action: 'exit', thread: state.thread, exit_code: code }, 'history'); });
    if (ending) finish();
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
    ending = true; finish();
  });
}

export const OBSERVER_VERSION = 'node-module-load-v5';
export function observationPreload(directory: string, maxEvents: number, maxBytes: number): string {
  return `'use strict';\ntry { (${preload.toString()})(${JSON.stringify({ directory, maxEvents, maxBytes, budget: traceBudget(maxEvents, maxBytes) })}); } catch (error) { console.error('Permsift observer could not start:', error.code || error.message); }\n`;
}
