import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { domainSchema, type Scenario } from './config.js';
import { forkSnapshot, manifest, noSymlinks, resolveAlias, hash, type Roots } from './filesystem.js';
import { executeSandbox, type BackendContext } from './backend.js';

export type InstallInput = { lock_hash: string; package_hash: string; resolved_domains: string[]; cache: 'cold' | 'warm'; cache_seed_hash?: string };
const fileHash = (text: string) => createHash('sha256').update(text).digest('hex');
export async function npmVersion() {
  const binary = await fs.realpath(path.join(path.dirname(process.execPath), 'npm'));
  const pkg = JSON.parse(await fs.readFile(path.join(path.dirname(binary), '..', 'package.json'), 'utf8'));
  if (pkg.name !== 'npm' || typeof pkg.version !== 'string') throw new Error('A companion npm installation is required next to Node');
  return pkg.version as string;
}
async function readPackage(root: string, name: string) {
  const file = path.join(root, name); await noSymlinks(root, file);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 5_000_000) throw new Error(`${name} must be a regular JSON file under 5 MB`);
  const text = await fs.readFile(file, 'utf8');
  return { hash: fileHash(text), value: JSON.parse(text) as Record<string, unknown> };
}
export async function inspectInstall(scenario: Scenario, inputRoot: string): Promise<InstallInput> {
  const install = scenario.install!;
  if (await fs.lstat(path.join(inputRoot, '.npmrc')).catch(() => undefined)) throw new Error('Install MVP does not accept project .npmrc; use explicit registry and no private credentials');
  if (await fs.lstat(path.join(inputRoot, 'npm-shrinkwrap.json')).catch(() => undefined)) throw new Error('Install MVP requires package-lock.json, not npm-shrinkwrap.json');
  const pkg = await readPackage(inputRoot, 'package.json'), lock = await readPackage(inputRoot, 'package-lock.json');
  if (pkg.value.workspaces) throw new Error('npm workspaces are not supported by this install MVP');
  if (![2, 3].includes(Number(lock.value.lockfileVersion)) || !lock.value.packages || typeof lock.value.packages !== 'object' || Array.isArray(lock.value.packages)) throw new Error('Install requires lockfileVersion 2 or 3 with a packages map');
  const domains = new Set<string>();
  for (const [name, raw] of Object.entries(lock.value.packages)) {
    if (name === '') continue;
    if (!name.startsWith('node_modules/') || name.split('/').some(p => p === '.' || p === '..') || !raw || typeof raw !== 'object') throw new Error('Only registry dependencies under node_modules are supported');
    const entry = raw as Record<string, unknown>;
    if (entry.link || typeof entry.resolved !== 'string' || typeof entry.integrity !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}(?:\s|$)/.test(entry.integrity)) throw new Error(`Registry URL and integrity are required: ${name}`);
    const url = new URL(entry.resolved);
    if (url.username || url.password || !domainSchema.safeParse(url.hostname).success || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error(`Unsupported dependency URL: ${name}`);
    domains.add(url.hostname);
  }
  let cache_seed_hash: string | undefined;
  if (install.cache === 'warm') {
    const seed = resolveAlias(install.cache_seed!, { workspace: inputRoot, cache: inputRoot, tmp: inputRoot });
    await noSymlinks(inputRoot, seed);
    if (!(await fs.stat(seed)).isDirectory()) throw new Error('Cache seed must be a directory');
    // Reject seed links as well: never grant a copied cache access to live host data.
    const entries = await manifest(seed);
    if (Object.values(entries).some(v => v.startsWith('symlink:'))) throw new Error('Cache seed must not contain symlinks');
    cache_seed_hash = hash(entries);
  }
  return { package_hash: pkg.hash, lock_hash: lock.hash, resolved_domains: [...domains].sort(), cache: install.cache, ...(cache_seed_hash ? { cache_seed_hash } : {}) };
}
export async function prepareInstallCache(scenario: Scenario, inputRoot: string, roots: Roots, options: { timeoutMs: number; signal?: AbortSignal }) {
  if (scenario.install!.cache === 'cold') return { condition: 'cold', initial_files: 0 };
  const seed = resolveAlias(scenario.install!.cache_seed!, { workspace: inputRoot, cache: inputRoot, tmp: inputRoot });
  const fork = await forkSnapshot(seed, path.join(roots.cache, 'npm'), options);
  return { condition: 'warm', fork };
}
export function installCommand(scenario: Scenario, roots: Roots) {
  // Absolute companion npm: no host shell expansion, no project-provided installer.
  const npm = path.join(path.dirname(process.execPath), 'npm');
  return [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=15000',
    '--userconfig=/dev/null', `--globalconfig=${path.join(roots.tmp, '.permsift-npm-global')}`, `--registry=${scenario.install!.registry}`,
    ...(scenario.install!.cache === 'warm' ? ['--offline'] : [])];
}
export function installFailureUnknown(execution: Awaited<ReturnType<typeof executeSandbox>>) {
  return execution.process.status !== 'completed' || /\b(?:FETCH_ERROR|EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|network timeout|socket hang up|\b(?:500|502|503|504)\b.*(?:GET|fetch)|UNABLE_TO_VERIFY|CERT_HAS_EXPIRED/i.test(execution.process.stderr);
}
export async function executeInstall(scenario: Scenario, context: BackendContext, expected: InstallInput) {
  const command = installCommand(scenario, context.roots);
  const execution = await executeSandbox(command, context);
  const pkg = await readPackage(context.roots.workspace, 'package.json'), lock = await readPackage(context.roots.workspace, 'package-lock.json');
  const inputs_unchanged = pkg.hash === expected.package_hash && lock.hash === expected.lock_hash;
  return { command, execution, inputs_unchanged, cache: scenario.install!.cache,
    verdict: !inputs_unchanged || installFailureUnknown(execution) ? 'unknown' as const : execution.process.exit_code === 0 ? 'pass' as const : 'fail' as const };
}
