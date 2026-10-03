import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertBundledEvidence } from './bundled-dependencies.js';
import { aliasSchema, readAliasSchema, domainSchema, configSchema, isStaged, type Config } from './config.js';
import { hash, within } from './filesystem.js';
import { protectionAgreement } from './model/definitions.js';
import { recorded } from './model/identity.js';
import { protectionStageSchema, evaluateProtections } from './protection-facts.js';
import { readLegacyJson } from './model/io.js';
import type { HistoricalVerification } from './terms.js';

const grants = z.array(aliasSchema).max(32).refine(a => new Set(a).size === a.length, 'Duplicate baseline grant');
const reads = z.array(readAliasSchema).max(32).refine(a => new Set(a).size === a.length, 'Duplicate baseline read grant');
const domains = z.array(domainSchema).max(32).refine(a => new Set(a).size === a.length, 'Duplicate baseline network grant');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const baselineSchema = z.object({
  schema_version: z.literal(1), mode: z.enum(['run', 'tighten']), status: z.literal('verified'),
  baseline_verified: z.literal(true), final_verified: z.literal(true),
  environment: z.record(z.string()), inputs: z.object({ snapshot_hash: digest, config_hash: digest, limits_hash: digest }),
  policies: z.record(grants), read_policies: z.record(reads), read_modes: z.record(z.enum(['explicit', 'legacy'])),
  network_policies: z.record(domains).optional(), install_policies: z.record(grants).optional(),
  trials: z.array(z.object({ scenario: z.string(), verdict: z.enum(['pass', 'fail', 'unknown']), grants, read_grants: reads,
    network_grants: domains.optional(), install_grants: grants.optional(), installation_reused: z.boolean().optional(), evidence: z.string().regex(/^evidence\/[a-f0-9-]+\.json$/) })).min(1),
});
export type Baseline = {
  file: string; config: Config; environment: Record<string, string>; snapshot_hash: string; limits_hash: string;
  policies: Record<string, string[]>; read_policies: Record<string, string[]>; read_modes: Record<string, 'explicit' | 'legacy'>;
  prepared: Record<string, string[]>; read_kinds: Record<string, Record<string, 'file' | 'directory'>>;
  network_policies: Record<string, string[]>; install_policies: Record<string, string[]>; adoption?: { id: string; selected_at: string };
  history?: Record<string, HistoricalVerification>;
};
async function jsonFile(file: string) {
  if ((await fs.stat(file)).size > 25_000_000) throw new Error('Baseline JSON exceeds 25 MB');
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}
const same = (a: string[], b: string[]) => hash([...a].sort()) === hash([...b].sort());
export async function loadVerifiedBaseline(file: string): Promise<Baseline> {
  const canonical = await fs.realpath(file);
  const directory = path.dirname(canonical);
  const rawReport = await jsonFile(canonical), report = baselineSchema.parse(rawReport);
  const installations = z.object({ inputs: z.object({ installations: z.record(z.object({ bundled: z.unknown().optional() })).optional() }) }).parse(rawReport).inputs.installations;
  const input = z.object({ config: configSchema }).parse(await jsonFile(path.join(directory, 'inputs.json')));
  if (hash(input.config) !== report.inputs.config_hash) throw new Error('Baseline config does not match its recorded hash');
  const ids = input.config.scenarios.map(s => s.id).sort();
  for (const record of [report.policies, report.read_policies, report.read_modes, ...report.network_policies ? [report.network_policies] : []]) {
    if (!same(Object.keys(record), ids)) throw new Error('Baseline scenario records do not match inputs.json');
  }
  const prepared: Baseline['prepared'] = {}, read_kinds: Baseline['read_kinds'] = {};
  const network_policies = report.network_policies ?? Object.fromEntries(ids.map(id => [id, []]));
  const install_policies = report.install_policies ?? {};
  if (!same(Object.keys(install_policies), input.config.scenarios.filter(isStaged).map(s => s.id))) throw new Error('Baseline install stage records do not match inputs.json');
  for (const scenario of input.config.scenarios) {
    const id = scenario.id;
    if (scenario.install && !report.network_policies) throw new Error('Install baseline is missing network policies');
    if (report.read_modes[id] !== (scenario.initial_read_grants === undefined ? 'legacy' : 'explicit')) throw new Error('Baseline read mode does not match its config');
    if (report.read_modes[id] === 'legacy' && !same(report.read_policies[id], ['@workspace'])) throw new Error('Invalid legacy read policy');
    const trial = [...report.trials].reverse().find(t => t.scenario === id && t.verdict === 'pass' && same(t.grants, report.policies[id]) && same(t.read_grants, report.read_policies[id]) && same(t.network_grants ?? [], network_policies[id]) && (!isStaged(scenario) || t.installation_reused === false && same(t.install_grants ?? [], install_policies[id])));
    if (!trial) throw new Error(`Baseline has no passing evidence for ${id}`);
    const evidenceFile = await fs.realpath(path.join(directory, trial.evidence));
    if (!within(directory, evidenceFile)) throw new Error('Baseline evidence escapes its report directory');
    const rawEvidence = await jsonFile(evidenceFile);
    assertBundledEvidence(installations?.[id]?.bundled, z.object({ installation: z.unknown().optional() }).parse(rawEvidence).installation, true);
    const evidence = z.object({ scenario: z.literal(id), grants, read_grants: reads, prepared_directories: z.array(aliasSchema).max(2048),
      network_grants: domains.optional(), install_grants: grants.optional(), summary: z.object({ installation_reused: z.boolean().optional() }).optional(), stage_policy_mode: z.enum(['separate', 'shared']).optional(), read_grant_kinds: z.record(z.enum(['file', 'directory'])).optional(),
      protections: z.array(protectionStageSchema.passthrough()).max(2).optional() }).parse(rawEvidence);
    if (!same(evidence.grants, report.policies[id]) || !same(evidence.read_grants, report.read_policies[id])) throw new Error('Baseline evidence policy mismatch');
    if (!same(evidence.network_grants ?? [], network_policies[id])) throw new Error('Baseline evidence network policy mismatch');
    if (isStaged(scenario) && (evidence.stage_policy_mode !== 'separate' || evidence.summary?.installation_reused !== false || !same(evidence.install_grants ?? [], install_policies[id]))) throw new Error('Baseline lacks fresh full-flow installation policy evidence');
    prepared[id] = evidence.prepared_directories;
    read_kinds[id] = evidence.read_grant_kinds ?? {};
    if (report.read_modes[id] === 'explicit' && !same(Object.keys(read_kinds[id]), report.read_policies[id])) throw new Error('Baseline is missing exact read target kinds');
    if (scenario.protection_goals && evaluateProtections(protectionAgreement(id, scenario), evidence.protections ? recorded(evidence.protections) : undefined).status !== 'pass') throw new Error('Baseline lacks passing declared protection evidence: ' + id);
  }
  return { file: canonical, config: input.config, environment: report.environment, snapshot_hash: report.inputs.snapshot_hash, limits_hash: report.inputs.limits_hash,
    policies: report.policies, read_policies: report.read_policies, read_modes: report.read_modes, prepared, read_kinds, network_policies, install_policies };
}

/** Historical comparison reports remain supported; adopted records validate their retained evidence on every load. */
export async function loadBaseline(selected: string): Promise<Baseline> {
  let file = path.resolve(selected);
  if ((await fs.lstat(file)).isDirectory()) {
    for (const name of ['baseline.json', 'current.json', 'report.json']) {
      const candidate = path.join(file, name);
      const exists = await fs.lstat(candidate).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
      if (exists) { file = candidate; break; }
    }
  }
  const raw = await readLegacyJson(file);
  if (raw && typeof raw === 'object' && 'kind' in raw && ['permsift_adopted_baseline', 'permsift_baseline_selection'].includes(String(raw.kind))) {
    const { readAdoption } = await import('./adoption.js');
    return (await readAdoption(file)).baseline;
  }
  return loadVerifiedBaseline(file);
}
