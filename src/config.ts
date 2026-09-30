import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

export const aliasSchema = z.string().regex(/^@(workspace|cache|tmp)(\/[A-Za-z0-9_.@-]+)*$/).refine(
  value => !value.split('/').some(part => part === '.' || part === '..'), 'Dot path components are forbidden')
  .refine(value => !value.split('/').some(part => part.startsWith('.permsift-read-')), 'Reserved read-probe namespace');
export const readAliasSchema = aliasSchema.refine(p => p === '@workspace' || p.startsWith('@workspace/'), 'Read search is limited to @workspace');
const workspaceFile = aliasSchema.refine(p => p.startsWith('@workspace/'), 'Must be a file under @workspace');
const expectedTests = z.array(z.string().min(1)).min(1).max(10_000).refine(names => new Set(names).size === names.length, 'Expected test names must be unique');
const assertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file_exists'), path: workspaceFile }).strict(),
  z.object({ type: z.literal('file_contains'), path: workspaceFile, text: z.string().min(1) }).strict(),
  z.object({ type: z.literal('json_equals'), path: workspaceFile, pointer: z.string().regex(/^(\/[^/]*)*$/), value: z.unknown().refine(v => v !== undefined, 'value is required') }).strict(),
  z.object({ type: z.literal('test_results'), path: workspaceFile, expected_tests: expectedTests }).strict(),
  z.object({ type: z.literal('junit'), path: workspaceFile, expected_tests: expectedTests }).strict(),
]);
export const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  command: z.array(z.string().min(1).refine(s => !s.includes('\0'))).min(1),
  timeout_seconds: z.number().int().min(1).max(600).default(120),
  initial_write_grants: z.array(aliasSchema).max(32),
  initial_read_grants: z.array(readAliasSchema).max(32).optional(),
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

export function validatePolicy(config: Config, limits: Limits): void {
  const ids = new Set<string>();
  for (const scenario of config.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
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
