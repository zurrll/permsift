import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

export const aliasSchema = z.string().regex(/^@(workspace|cache|tmp)(\/[A-Za-z0-9_.@-]+)*$/).refine(
  value => !value.split('/').some(part => part === '.' || part === '..'), 'Dot path components are forbidden')
  .refine(value => !value.split('/').some(part => part.startsWith('.permsift-read-') || part.startsWith('.permsift-protection-')), 'Reserved probe namespace');
export const readAliasSchema = aliasSchema.refine(p => p === '@workspace' || p.startsWith('@workspace/'), 'Read search is limited to @workspace');
const workspaceFile = aliasSchema.refine(p => p.startsWith('@workspace/'), 'Must be a file under @workspace');
const expectedTests = z.array(z.string().min(1)).min(1).max(10_000).refine(names => new Set(names).size === names.length, 'Expected test names must be unique');
export const domainSchema = z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/)
  .refine(s => s.split('.').every(label => label.length <= 63), 'Domain label exceeds 63 characters')
  .refine(s => s !== 'permsift-denied.invalid', 'Reserved network-probe domain');
const installSchema = z.object({
  manager: z.literal('npm'), cache: z.enum(['cold', 'warm']).default('cold'),
  initial_write_grants: z.array(aliasSchema).max(32).optional(),
  narrower_candidates: z.array(z.object({ from: aliasSchema, to: z.array(aliasSchema).min(1).max(32) }).strict()).max(32).optional(),
  auto_discover: z.boolean().optional(),
  cache_seed: readAliasSchema.optional(),
  registry: z.string().url().default('https://registry.npmjs.org/').refine(s => {
    try { const u = new URL(s); return !u.username && !u.password && !u.search && !u.hash && u.pathname === '/' && domainSchema.safeParse(u.hostname).success &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))); }
    catch { return false; }
  }, 'Registry must be an HTTPS origin (HTTP loopback is allowed for local fixtures)'),
}).strict();
const assertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file_exists'), path: workspaceFile }).strict(),
  z.object({ type: z.literal('file_contains'), path: workspaceFile, text: z.string().min(1) }).strict(),
  z.object({ type: z.literal('json_equals'), path: workspaceFile, pointer: z.string().regex(/^(\/[^/]*)*$/), value: z.unknown().refine(v => v !== undefined, 'value is required') }).strict(),
  z.object({ type: z.literal('test_results'), path: workspaceFile, expected_tests: expectedTests }).strict(),
  z.object({ type: z.literal('junit'), path: workspaceFile, expected_tests: expectedTests }).strict(),
]);
export const protectionGoalSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  target: workspaceFile.refine(p => p.length <= 512, 'Protection target exceeds 512 characters'), target_kind: z.enum(['file', 'directory']),
  operation: z.enum(['read', 'create', 'write']), stage: z.literal('task'), expected: z.literal('denied'),
}).strict().refine(g => g.operation !== 'create' || g.target_kind === 'directory', 'Create goals require an existing directory');
const protectionGoals = z.array(protectionGoalSchema).min(1).max(16)
  .refine(goals => new Set(goals.map(g => g.key)).size === goals.length, 'Protection goal keys must be unique');
export const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  command: z.array(z.string().min(1).refine(s => !s.includes('\0'))).min(1),
  timeout_seconds: z.number().int().min(1).max(600).default(120),
  initial_write_grants: z.array(aliasSchema).max(32),
  initial_read_grants: z.array(readAliasSchema).max(32).optional(),
  initial_network_grants: z.array(domainSchema).max(32).optional(),
  install: installSchema.optional(),
  protection_goals: protectionGoals.optional(),
  observation: z.object({
    typescript: z.object({ compiler: workspaceFile }).strict().optional(),
    esbuild: z.object({ bundler: workspaceFile, metafile: workspaceFile, output_root: workspaceFile }).strict().optional(),
  }).strict().refine(o => o.typescript || o.esbuild, 'Select at least one observation source').optional(),
  auto_read_discover: z.boolean().default(true),
  narrower_read_candidates: z.array(z.object({ from: readAliasSchema, to: z.array(readAliasSchema).min(1).max(32) }).strict()).max(32).default([]),
  auto_discover: z.boolean().default(true),
  prepare_directories: z.array(aliasSchema).max(2048).default([]),
  narrower_candidates: z.array(z.object({ from: aliasSchema, to: z.array(aliasSchema).min(1).max(32) }).strict()).max(32).default([]),
  assertions: z.array(assertionSchema).min(1).max(64),
}).strict();
export const configSchema = z.object({
  schema_version: z.literal(1),
  project: z.string().min(1).default('.'),
  exclude: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/).refine(s => s !== '.' && s !== '..')).default(['.git', '.permsift', 'dist', 'reports']),
  scenarios: z.array(scenarioSchema).min(1).max(16),
}).strict();
export const limitsSchema = z.object({
  schema_version: z.literal(1),
  allowed_write_roots: z.array(aliasSchema).min(1),
  allowed_read_roots: z.array(readAliasSchema).max(64).optional(),
  allowed_network_domains: z.array(domainSchema).max(64).optional(),
  max_candidates: z.number().int().min(0).max(500).default(30),
  budget_seconds: z.number().int().min(1).max(7200).default(900),
  repetitions: z.number().int().min(1).max(10).default(3),
  max_output_bytes: z.number().int().min(1024).max(10_000_000).default(262144),
  max_snapshot_bytes: z.number().int().min(1024).max(10_000_000_000).default(500_000_000),
  max_discovery_depth: z.number().int().min(1).max(8).default(3),
  max_discovery_dirs: z.number().int().min(1).max(512).default(64),
  max_read_discovery_entries: z.number().int().min(1).max(2048).default(128),
  max_read_discovery_depth: z.number().int().min(1).max(8).default(3),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type Limits = z.infer<typeof limitsSchema>;
export const contains = (parent: string, child: string) => child === parent || child.startsWith(parent + '/');

export function validatePolicy(config: Config, limits: Limits, observe = false): void {
  const ids = new Set<string>();
  for (const scenario of config.scenarios) {
    if (scenario.observation?.typescript) {
      if (scenario.command.length > 1000 || scenario.command.some(arg => arg.length > 4096) || scenario.observation.typescript.compiler.length > 4096) throw new Error('TypeScript observation command exceeds collector bounds');
      const compiler = scenario.observation.typescript.compiler.slice('@workspace/'.length);
      if (path.basename(scenario.command[0]) !== 'node' || path.isAbsolute(scenario.command[1] ?? '') || path.posix.normalize(scenario.command[1] ?? '') !== compiler + '/bin/tsc') throw new Error('TypeScript observation requires direct node <compiler>/bin/tsc execution');
      const unsupported = new Set(['--build', '-b', '--watch', '-w', '--listfilesonly', '--listfiles', '--showconfig', '--help', '-h', '-?', '--version', '-v', '--all', '--init', '--extendeddiagnostics', '--diagnostics', '--traceresolution']);
      if (scenario.command.slice(2).some(arg => arg.startsWith('@') || unsupported.has(arg.toLowerCase().split('=')[0]))) throw new Error('TypeScript observation does not support build/watch, response files or alternate diagnostic modes');
    }
    const bundle = scenario.observation?.esbuild;
    if (bundle) {
      if (scenario.command.length > 1000 || scenario.command.some(arg => arg.length > 4096) || Object.values(bundle).some(p => p.length > 4096)) throw new Error('esbuild observation exceeds collector bounds');
      if (!contains(bundle.output_root, bundle.metafile) || bundle.output_root === bundle.metafile) throw new Error('esbuild metafile must be inside the declared output_root');
      if (contains(bundle.output_root, bundle.bundler) || bundle.output_root.split('/').includes('node_modules')) throw new Error('esbuild output_root must not contain installed tools or node_modules');
      if (observe && !scenario.initial_write_grants.some(p => contains(p, bundle.output_root))) throw new Error('esbuild output_root requires an existing task write grant for observe');
    }
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (scenario.initial_network_grants !== undefined && !scenario.install) throw new Error('Network grants require an install stage; task commands always run offline');
    if (scenario.install) {
      if (limits.allowed_network_domains === undefined) throw new Error('Install requires explicit allowed_network_domains in trusted limits');
      const domains = scenario.initial_network_grants ?? [];
      if (new Set(domains).size !== domains.length) throw new Error('Duplicate network grant');
      if (domains.some(d => !limits.allowed_network_domains!.includes(d))) throw new Error('Network grant exceeds trusted limits');
      if (!config.exclude.includes('node_modules')) throw new Error('Install scenarios must exclude top-level node_modules');
      if (scenario.install.cache === 'warm' ? !scenario.install.cache_seed?.startsWith('@workspace/') : scenario.install.cache_seed !== undefined) throw new Error('Warm cache requires a project cache_seed; cold cache forbids a seed');
      if (scenario.initial_read_grants !== undefined && !isStaged(scenario)) throw new Error('Install currently requires legacy workspace reads; set separate install.initial_write_grants to search task reads');
      const install = installationScenario(scenario);
      if (!isStaged(scenario) && (scenario.install.narrower_candidates !== undefined || scenario.install.auto_discover !== undefined)) throw new Error('Install stage options require install.initial_write_grants');
      if (new Set(install.initial_write_grants).size !== install.initial_write_grants.length) throw new Error('Duplicate install write grant');
      for (const rule of install.narrower_candidates) if (rule.to.some(p => !contains(rule.from, p) || rule.from === p)) throw new Error('Install narrowing must target strict descendants');
      for (const grant of [...install.initial_write_grants, ...install.narrower_candidates.flatMap(r => [r.from, ...r.to])]) {
        if (!limits.allowed_write_roots.some(root => contains(root, grant))) throw new Error(`Install grant exceeds trusted limits: ${grant}`);
      }
    }
    if (new Set(scenario.initial_write_grants).size !== scenario.initial_write_grants.length) throw new Error('Duplicate write grant');
    for (const rule of scenario.narrower_candidates) {
      if (rule.to.some(p => !contains(rule.from, p) || rule.from === p)) throw new Error('Narrowing must target strict descendants');
    }
    for (const grant of [...scenario.initial_write_grants, ...scenario.prepare_directories, ...scenario.narrower_candidates.flatMap(c => [c.from, ...c.to])]) {
      if (!limits.allowed_write_roots.some(root => contains(root, grant))) throw new Error(`Grant exceeds trusted limits: ${grant}`);
    }
    if (scenario.initial_read_grants === undefined) {
      if (scenario.narrower_read_candidates.length) throw new Error('Read candidates require initial_read_grants');
      continue;
    }
    if (limits.allowed_read_roots === undefined) throw new Error('Read search requires explicit allowed_read_roots in trusted limits');
    if (new Set(scenario.initial_read_grants).size !== scenario.initial_read_grants.length) throw new Error('Duplicate read grant');
    for (const rule of scenario.narrower_read_candidates) {
      if (rule.to.some(p => !contains(rule.from, p) || rule.from === p)) throw new Error('Read narrowing must target strict descendants');
    }
    for (const grant of [...scenario.initial_read_grants, ...scenario.narrower_read_candidates.flatMap(c => [c.from, ...c.to])]) {
      if (!limits.allowed_read_roots.some(root => contains(root, grant))) throw new Error(`Read grant exceeds trusted limits: ${grant}`);
    }
  }
}

export const isStaged = (scenario: Scenario) => scenario.install?.initial_write_grants !== undefined;
/** A separate installer retains broad project reads; task read rules apply only after npm completes. */
export function installationScenario(scenario: Scenario): Scenario {
  return { ...scenario, initial_write_grants: scenario.install?.initial_write_grants ?? scenario.initial_write_grants,
    protection_goals: undefined,
    initial_read_grants: undefined, narrower_read_candidates: [],
    narrower_candidates: scenario.install?.narrower_candidates ?? [], auto_discover: scenario.install?.auto_discover ?? true };
}

async function readConfig(file: string): Promise<unknown> {
  const document = parseDocument(await readFile(file, 'utf8'), { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map(e => e.message).join('\n'));
  return document.toJS({ maxAliasCount: 0 });
}
export async function loadConfiguration(configPath: string, limitsPath: string) {
  const configFile = await realpath(configPath);
  const limitsFile = await realpath(limitsPath);
  const config = configSchema.parse(await readConfig(configFile));
  const limits = limitsSchema.parse(await readConfig(limitsFile));
  validatePolicy(config, limits);
  const project = await realpath(path.resolve(path.dirname(configFile), config.project));
  return { config, limits, project, configFile, limitsFile };
}
