import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { homedir } from 'node:os';
import path from 'node:path';
import { access, lstat, realpath } from 'node:fs/promises';
import { readAliasSchema } from './config.js';
import { noSymlinks, resolveAlias, within, type Roots } from './filesystem.js';
import { runProcess, shellQuote } from './process.js';
import { superviseSandbox } from './sandbox-supervisor.js';
import type { ObserverContext } from './observation.js';

export const BACKEND_VERSION = '0.0.77';
export function requirePlatform() {
  if (process.platform !== 'darwin') throw new Error('Permsift requires macOS. No unsandboxed fallback is available.');
}
export type BackendContext = {
  roots: Roots; experimentRoot: string; protectedPaths: string[];
  grants: string[]; invocationId: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal;
  readGrants?: string[]; protectedWritePaths?: string[];
  readKinds?: Record<string, 'file' | 'directory'>;
  networkGrants?: string[];
  /** Engine-owned preload/collector only. Never accepted from project config. */
  observer?: ObserverContext;
};

// SRT treats plain paths as recursive subpaths. A one-character glob compiles
// to an anchored regex, granting this path only (including cwd directory access).
export function exactReadPattern(file: string): string {
  if (/[\[\]*?]/.test(file)) throw new Error('Read search requires paths without glob metacharacters');
  const name = path.basename(file);
  const index = name.search(/[A-Za-z0-9_]/);
  if (index < 0) throw new Error(`Cannot create an exact read rule for ${file}`);
  return path.join(path.dirname(file), name.slice(0, index) + '[' + name[index] + ']' + name.slice(index + 1));
}

export async function policyFor(context: BackendContext): Promise<SandboxRuntimeConfig> {
  const { roots } = context;
  for (const root of Object.values(roots)) await noSymlinks(context.experimentRoot, root);
  const write = [];
  for (const alias of context.grants) {
    const resolved = resolveAlias(alias, roots);
    const root = roots[alias.slice(1).split('/')[0] as keyof Roots];
    await noSymlinks(root, resolved);
    await access(resolved);
    write.push(resolved);
  }
  if (context.observer) {
    const base = path.join(roots.tmp, '.permsift-observer');
    if (context.observer.bootstrap !== path.join(base, 'preload.cjs') || context.observer.directory !== path.join(base, 'logs')) throw new Error('Invalid observer control paths');
    await noSymlinks(roots.tmp, context.observer.bootstrap);
    await noSymlinks(roots.tmp, context.observer.directory);
    if (!(await lstat(context.observer.bootstrap)).isFile() || !(await lstat(context.observer.directory)).isDirectory()) throw new Error('Invalid observer control types');
    write.push(context.observer.directory);
  }
  const nodeRoot = path.dirname(path.dirname(await realpath(process.execPath)));
  if (nodeRoot === homedir()) throw new Error('Node installed directly under HOME is not supported; use an isolated Node installation.');
  const read = context.readGrants === undefined ? Object.values(roots) : [exactReadPattern(roots.workspace), roots.cache, roots.tmp];
  for (const alias of context.readGrants ?? []) {
    readAliasSchema.parse(alias);
    const resolved = resolveAlias(alias, roots);
    if (/[\[\]*?]/.test(resolved)) throw new Error('Read search requires paths without glob metacharacters');
    await noSymlinks(roots.workspace, resolved);
    const stat = await lstat(resolved);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Read grants must target existing regular files or directories: ${alias}`);
    const kind = context.readKinds?.[alias] ?? (stat.isFile() ? 'file' : 'directory');
    read.push(kind === 'file' ? exactReadPattern(resolved) : resolved);
  }
  return {
    network: { allowedDomains: context.networkGrants ?? [], deniedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false, allowUnixSockets: [] },
    filesystem: {
      denyRead: [...new Set(['/Users', homedir(), context.experimentRoot, ...context.protectedPaths])],
      allowRead: [...read, ...(within(homedir(), nodeRoot) ? [nodeRoot] : [])],
      allowWrite: write,
      denyWrite: ['/tmp/claude', '/private/tmp/claude', ...context.protectedPaths, ...context.protectedWritePaths ?? [], ...context.observer ? [context.observer.bootstrap] : []],
    },
    allowPty: false, allowAppleEvents: false, enableWeakerNetworkIsolation: false, enableWeakerNestedSandbox: false,
  };
}

export function cleanEnvironment(roots: Roots): NodeJS.ProcessEnv {
  return {
    PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: roots.tmp, TMPDIR: roots.tmp + '/', XDG_CACHE_HOME: roots.cache,
    npm_config_cache: path.join(roots.cache, 'npm'), npm_config_update_notifier: 'false',
    npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_userconfig: '/dev/null', npm_config_globalconfig: path.join(roots.tmp, '.permsift-npm-global'),
    CI: '1', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC',
  };
}

// SRT has a singleton manager. The engine serializes executions; reject accidental concurrent use.
let busy = false;
export async function executeSandbox(command: string[], context: BackendContext) {
  requirePlatform();
  return superviseSandbox(command, context);
}
/** Worker-only entry point. Each invocation owns its runtime and proxy sockets. */
export async function executeSandboxNative(command: string[], context: BackendContext, hooks: {
  onStart?: (pid: number) => void; onResult?: (result: SandboxResult) => void;
} = {}) {
  requirePlatform();
  if (busy) throw new Error('Concurrent backend execution is not supported');
  busy = true;
  const stripped = Object.entries(process.env).filter(([key]) => /^(JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|GIT_CONFIG|CLAUDE_CODE_TMPDIR|CLAUDE_TMPDIR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)/.test(key));
  try {
    const policy = await policyFor(context);
    // SRT composes certain settings into its command string from the host environment.
    for (const [key] of stripped) delete process.env[key];
    await SandboxManager.initialize(policy, undefined, true);
    // SRT adds TMPDIR=/tmp/claude inside its wrapper. Override it inside the
    // sandbox too, using argv quoting; the shared default directory stays denied.
    const text = ['/usr/bin/env', `TMPDIR=${context.roots.tmp}/`, 'NO_PROXY=', 'no_proxy=', ...command].map(shellQuote).join(' ');
    const wrapped = await SandboxManager.wrapWithSandboxArgv(text, '/bin/bash', undefined, context.signal, context.roots.workspace, { commandId: context.invocationId });
    const effective = { read: SandboxManager.getFsReadConfig(), write: SandboxManager.getFsWriteConfig(), network: SandboxManager.getNetworkRestrictionConfig() };
    // wrapped.env is the entire host environment on POSIX. Intentionally do not inherit it.
    const env = cleanEnvironment(context.roots);
    if (context.observer) env.NODE_OPTIONS = `--require ${JSON.stringify(context.observer.bootstrap)}`;
    const processResult = await runProcess(wrapped.argv, { cwd: context.roots.workspace, env, timeoutMs: context.timeoutMs, maxOutputBytes: context.maxOutputBytes, signal: context.signal, onStart: hooks.onStart });
    const violations = SandboxManager.getSandboxViolationStore().getViolationsForCommand(context.invocationId);
    const result = { process: processResult, policy, effective, violations };
    hooks.onResult?.(result);
    return result;
  } finally {
    try { await SandboxManager.reset(); }
    finally {
      for (const [key, value] of stripped) if (value !== undefined) process.env[key] = value;
      busy = false;
    }
  }
}
export type SandboxResult = Awaited<ReturnType<typeof executeSandboxNative>>;
