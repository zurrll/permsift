import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { configSchema, limitsSchema, loadConfiguration, validatePolicy, isStaged, type Config } from './config.js';
import { readLegacyJson } from './model/io.js';
import { objectId, semanticHash, canonical } from './model/identity.js';
import type { AdoptedBaseline } from './model/types.js';
import { readResult, type ExecutionView, type ResultRecord } from './result-reader.js';
import { hash, within } from './filesystem.js';
import type { Baseline } from './baseline.js';
import { compareConfigurationTerms, compareTerms } from './terms.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(16384);
const relative = z.string().regex(/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json$/);
const selectionSchema = z.object({ schema_version: z.literal(1), kind: z.literal('permsift_baseline_selection'),
  baseline_id: text, file: z.string().regex(/^records\/[a-f0-9]{64}\/baseline\.json$/) }).strict();
const manifestSchema = z.object({ schema_version: z.literal(1), kind: z.literal('permsift_adopted_baseline'), id: text,
  selected_at: z.string().datetime(), action: z.literal('explicit_adoption'), reason: z.string().max(4096),
  previous: z.object({ id: text, file: z.string().regex(/^records\/[a-f0-9]{64}\/baseline\.json$/) }).strict().nullable(),
  source: z.object({ selected_file: text, artifact_hash: digest }).strict(), authorization_limits_hash: digest,
  artifacts: z.array(z.object({ path: relative, hash: digest }).strict()).min(2).max(4096),
  baseline: z.object({ id: text, selection: z.literal('explicit_adoption'), adoption: z.literal('recorded'), resolution: z.literal('validated'),
    selected_at: z.string().datetime(), producer_reference: text, task_ids: z.array(text).min(1).max(16),
    selections: z.array(z.object({ task_key: text, task_id: text, agreement_id: text, policy_id: text,
      execution_ids: z.array(text).min(1).max(10) }).strict()).min(1).max(16) }).strict(),
}).strict();
export type AdoptionManifest = z.infer<typeof manifestSchema>;
export type AdoptionRecord = { file: string; manifest: AdoptionManifest; config: Config; baseline: Baseline;
  tasks: { key: string; proofs: ExecutionView[]; report: string; result: ResultRecord }[]; parent_available: boolean | null };
export const defaultStore = (configFile: string) => path.join(path.dirname(path.resolve(configFile)), '.permsift-baselines');
export const defaultSelection = (configFile: string) => path.join(defaultStore(configFile), 'current.json');
const known = <T>(v: { state: string; value?: T }, label: string): T => {
  if (v.state !== 'recorded' || v.value === undefined) throw new Error('Baseline lacks recorded ' + label);
  return v.value;
};
const passed = (v: ExecutionView) => known(v.facts.reported_verdict, 'verdict') === 'pass' &&
  v.facts.outcomes.task.status === 'pass' && v.facts.outcomes.boundaries.status === 'pass' &&
  (v.agreement?.declaration.state !== 'recorded' || v.facts.outcomes.protections?.status === 'pass');

/** A bounded JSON-only reader: no linked directories, source trees, dependency trees or arbitrary producer paths. */
async function sourceReader(root: string) {
  const files = new Map<string, unknown>(); let bytes = 0;
  const read = async (relativePath: string, optional = false) => {
    relative.parse(relativePath);
    if (files.has(relativePath)) return files.get(relativePath);
    const target = path.join(root, relativePath);
    let directory = root;
    for (const part of relativePath.split('/').slice(0, -1)) {
      directory = path.join(directory, part);
      const stat = await fs.lstat(directory).catch(e => { if (optional && e.code === 'ENOENT') return undefined; throw e; });
      if (!stat) return undefined;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Baseline artifact directory must not be a link');
    }
    const stat = await fs.lstat(target).catch(e => { if (optional && e.code === 'ENOENT') return undefined; throw e; });
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Baseline artifact must be a regular JSON file');
    bytes += stat.size;
    if (files.size >= 4096 || bytes > 128_000_000) throw new Error('Baseline retained evidence exceeds 4096 files / 128 MB');
    const raw = await readLegacyJson(target); files.set(relativePath, raw); return raw;
  };
  return { files, read };
}

/** Select the complete final verification, including repetitions. Search history is not copied as verification proof. */
async function collectSource(file: string) {
  if (path.basename(file) !== 'report.json') throw new Error('Select a conventional report.json or result directory');
  const root = path.dirname(file), reader = await sourceReader(root);
  const raw = await reader.read('report.json'), inputs = await reader.read('inputs.json');
  const retained = z.object({ config: configSchema, limits: limitsSchema }).parse(inputs);
  const record = await readResult(file, { verificationOnly: true });
  if (raw && typeof raw === 'object' && 'error' in raw && raw.error) throw new Error('Source workflow records an error');
  if (!record.model || !['run', 'tighten', 'check'].includes(record.model.workflow.kind)) throw new Error('Adopt requires run/tighten or a completely verified check result');
  const tasks: AdoptionRecord['tasks'] = [];
  const scenarios: Config['scenarios'] = [];
  let snapshotHash: string | undefined, environment: Record<string, string> | undefined;
  const add = async (scenario: Config['scenarios'][number], result: ResultRecord, prefix: string) => {
    if (!result.model || !['run', 'tighten'].includes(result.model.workflow.kind) || result.model.workflow.reported_status !== 'verified' ||
      result.model.workflow.verification.state !== 'recorded' || !result.model.workflow.verification.value.baseline_verified || !result.model.workflow.verification.value.final_verified)
      throw new Error('Task verification workflow is incomplete: ' + scenario.id);
    const phase = result.model.workflow.kind === 'tighten' ? 'final' : 'baseline';
    const proofs = result.executions.filter(v => v.task === scenario.id && v.facts.origin.phase === phase);
    const taskInputs = prefix ? await reader.read(prefix + 'inputs.json') : inputs;
    const recordedInputs = z.object({ config: configSchema, limits: limitsSchema }).parse(taskInputs);
    const actualScenario = recordedInputs.config.scenarios.find(s => s.id === scenario.id)!;
    if (!actualScenario || compareTerms(scenario, actualScenario, { ignorePreparation: true }).changed)
      throw new Error('Current/verified task definitions disagree: ' + scenario.id);
    if (proofs.length !== recordedInputs.limits.repetitions || !proofs.every(passed)) throw new Error('Baseline requires all passing repeated task/boundary/protection evidence: ' + scenario.id);
    const expectedChecks = actualScenario.assertions.map(a => `${a.type}:${a.path}`).sort();
    if (proofs.some(v => canonical(known(v.facts.assertions, 'success checks').map(c => c.name).sort()) !== canonical(expectedChecks)))
      throw new Error('Retained success checks do not cover the configured assertions: ' + scenario.id);
    const currentId = result.model.workflow.current_policies.find(p => p.task_key === scenario.id)?.policy_id;
    const chosen = proofs[0].policy;
    if (!chosen || !proofs.every(v => v.policy?.id === chosen.id) || result.model.policies.find(p => p.id === currentId)?.id !== chosen.id)
      throw new Error('Final verification does not match selected policy: ' + scenario.id);
    if (isStaged(actualScenario) && proofs.some(v => known(v.facts.conditions.installation_state, 'installation state').reused || v.facts.installation.state !== 'recorded' || v.facts.installation.value.reported_verdict !== 'pass'))
      throw new Error('Staged baseline requires fresh full-flow installation evidence');
    const inputHash = known(proofs[0].facts.conditions.input_hash, 'input hash'), env = known(proofs[0].facts.conditions.environment, 'environment');
    if (snapshotHash && snapshotHash !== inputHash || environment && canonical(environment) !== canonical(env)) throw new Error('Baseline tasks do not share verified inputs/environment');
    snapshotHash = inputHash; environment = env;
    const preparation = known(proofs[0].facts.conditions.preparation, 'preparation');
    if (!proofs.every(v => canonical(known(v.facts.conditions.preparation, 'preparation')) === canonical(preparation))) throw new Error('Final repetitions changed preparation');
    if (scenario.prepare_directories.some(p => !preparation.includes(p))) throw new Error('Verification lacks declared preparation: ' + scenario.id);
    const reads = known(chosen.task.read, 'read policy'), writes = known(chosen.task.write, 'write policy');
    if (reads.mode === 'explicit') known(reads.target_kinds, 'exact read target kinds');
    const install = chosen.installation.state === 'recorded' ? chosen.installation.value : undefined;
    const selected: Config['scenarios'][number] = { ...actualScenario, initial_write_grants: writes,
      ...(reads.mode === 'explicit' ? { initial_read_grants: reads.grants } : {}),
      ...(install ? { initial_network_grants: known(install.network, 'installation domains'), ...(isStaged(actualScenario) ? { install: { ...actualScenario.install!, initial_write_grants: install.write, narrower_candidates: [], auto_discover: false } } : {}) } : {}),
      // Preserve the user declaration; the full derived execution preparation is retained separately in Baseline.prepared.
      prepare_directories: scenario.prepare_directories, auto_discover: false, auto_read_discover: false, narrower_candidates: [], narrower_read_candidates: [] };
    scenarios.push(selected);
    if (prefix) await reader.read(prefix + 'report.json');
    // Keep the original producer index, but only copy proof sidecars for the final repetitions.
    const index = await reader.read(prefix + 'executions/index.json', true);
    for (const proof of proofs) {
      const trial = result.model.executions.find(e => e.origin.phase === phase && e.origin.record === (proof.native ? 'evidence/' + path.basename(proof.reference) : proof.reference));
      if (!trial) throw new Error('Selected proof has no corresponding producer trial');
      await reader.read(prefix + trial.origin.record);
      if (proof.native) await reader.read(prefix + proof.reference);
      else if (index) throw new Error('Indexed final native evidence is missing');
    }
    tasks.push({ key: scenario.id, proofs, report: prefix + 'report.json', result });
  };
  if (record.model.workflow.kind === 'check') {
    if (!['compatible', 'review_required', 'regressed'].includes(record.model.workflow.reported_status)) throw new Error('Inconclusive checks cannot be adopted');
    const source = z.object({ error: z.string().optional(), tasks: z.array(z.object({ id: z.string(), status: z.string(),
      suggestion: z.object({ verified: z.literal(true) }).optional() })).max(32) }).parse(raw);
    if (source.error) throw new Error('Failed check workflow cannot be adopted');
    for (const scenario of retained.config.scenarios) {
      const row = source.tasks.find(t => t.id === scenario.id);
      if (!row) throw new Error('Check lacks current task: ' + scenario.id);
      const phase = row.status === 'compatible' ? 'old' : row.status === 'new_task_verified' ? 'new' : row.status === 'permission_change' && row.suggestion?.verified ?
        [...record.children].reverse().find(c => c.task === scenario.id && /^repair-verify-/.test(c.phase))?.phase : undefined;
      const selected = record.children.find(c => c.task === scenario.id && c.phase === phase);
      if (!selected?.result) throw new Error('Check lacks fully verified selected task policy: ' + scenario.id);
      if (row.status === 'permission_change') {
        const role = record.model.workflow.comparisons.find(c => c.task_key === scenario.id)?.suggestion_policy;
        const expected = role?.state === 'recorded' ? record.model.policies.find(p => p.id === role.value) : undefined;
        const actual = selected.result.executions[0]?.policy;
        const outline = (p: NonNullable<ExecutionView['policy']>) => ({ write: known(p.task.write, 'suggested writes'),
          read: p.task.read.state === 'recorded' ? p.task.read.value.grants : scenario.initial_read_grants === undefined ? ['@workspace'] : null,
          installation: p.installation.state === 'recorded' ? { write: p.installation.value.write, network: known(p.installation.value.network, 'suggested domains') } : null });
        if (!expected || !actual || canonical(outline(expected)) !== canonical(outline(actual))) throw new Error('Verified repair does not match the proposed policy: ' + scenario.id);
      }
      await add(scenario, selected.result, `tasks/${scenario.id}/${selected.phase}/`);
    }
  } else for (const scenario of retained.config.scenarios) await add(scenario, record, '');
  const config = configSchema.parse({ ...retained.config, scenarios });
  const baseline: Baseline = { file, config, environment: environment!, snapshot_hash: snapshotHash!, limits_hash: known(record.model.source.recorded_hashes.limits, 'limits hash'),
    policies: {}, read_policies: {}, read_modes: {}, prepared: {}, read_kinds: {}, network_policies: {}, install_policies: {} };
  for (const task of tasks) {
    const p = task.proofs[0].policy!, read = known(p.task.read, 'read policy'), install = p.installation.state === 'recorded' ? p.installation.value : undefined;
    baseline.policies[task.key] = known(p.task.write, 'write policy'); baseline.read_policies[task.key] = read.grants; baseline.read_modes[task.key] = read.mode;
    baseline.read_kinds[task.key] = read.target_kinds.state === 'recorded' ? read.target_kinds.value : {};
    baseline.prepared[task.key] = known(task.proofs[0].facts.conditions.preparation, 'preparation');
    baseline.network_policies[task.key] = install ? known(install.network, 'network grants') : [];
    if (install?.mode === 'separate') baseline.install_policies[task.key] = install.write;
  }
  return { ...reader, config, baseline, tasks, artifact_hash: semanticHash(raw) };
}

const selectionContent = (source: Awaited<ReturnType<typeof collectSource>>, selectedAt: string): Omit<AdoptedBaseline, 'id'> => ({
  selection: 'explicit_adoption', adoption: 'recorded', resolution: 'validated', selected_at: selectedAt,
  producer_reference: 'source/report.json', task_ids: source.tasks.map(t => t.proofs[0].facts.task_id),
  selections: source.tasks.map(t => ({ task_key: t.key, task_id: t.proofs[0].facts.task_id,
    agreement_id: t.proofs[0].facts.agreement_id, policy_id: t.proofs[0].policy!.id, execution_ids: t.proofs.map(p => p.facts.id) })) });

export async function readAdoption(selected: string): Promise<AdoptionRecord> {
  let file = path.resolve(selected);
  if ((await fs.lstat(file)).isDirectory()) {
    try { await fs.access(path.join(file, 'baseline.json')); file = path.join(file, 'baseline.json'); }
    catch { file = path.join(file, 'current.json'); }
  }
  let raw = await readLegacyJson(file);
  let selectedId: string | undefined;
  if (raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'permsift_baseline_selection') {
    const pointer = selectionSchema.parse(raw); selectedId = pointer.baseline_id;
    const reader = await sourceReader(path.dirname(file)); raw = await reader.read(pointer.file); file = path.join(path.dirname(file), pointer.file);
  }
  const manifest = manifestSchema.parse(raw), { id, ...content } = manifest;
  if (id !== objectId('adoption', content) || selectedId && selectedId !== id) throw new Error('Adoption identity/selection mismatch');
  const root = path.dirname(file), reader = await sourceReader(root);
  const paths = manifest.artifacts.map(a => a.path);
  if (new Set(paths).size !== paths.length || !paths.includes('source/report.json') || !paths.includes('source/inputs.json') || paths.some(p => !p.startsWith('source/')))
    throw new Error('Invalid adopted artifact set');
  for (const artifact of manifest.artifacts) if (semanticHash(await reader.read(artifact.path)) !== artifact.hash) throw new Error('Adopted evidence hash mismatch: ' + artifact.path);
  const source = await collectSource(path.join(root, 'source/report.json'));
  if (source.artifact_hash !== manifest.source.artifact_hash || canonical([...source.files.keys()].map(p => 'source/' + p).sort()) !== canonical([...paths].sort())) throw new Error('Adoption source/artifact coverage mismatch');
  const baselineContent = selectionContent(source, manifest.selected_at);
  if (canonical(manifest.baseline) !== canonical({ id: objectId('baseline', baselineContent), ...baselineContent })) throw new Error('Adopted baseline reference mismatch');
  let parentAvailable: boolean | null = null;
  if (manifest.previous) {
    const store = path.resolve(root, '../..');
    parentAvailable = await fs.lstat(path.join(store, manifest.previous.file)).then(s => s.isFile() && !s.isSymbolicLink(), () => false);
  }
  const history = Object.fromEntries(source.tasks.map(t => [t.key, { reference: file, execution_ids: t.proofs.map(p => p.facts.id), task: 'pass' as const, boundaries: 'pass' as const,
    protection_goals: source.config.scenarios.find(s => s.id === t.key)!.protection_goals?.map(g => ({ key: g.key, status: 'pass' as const })) ?? [] }]));
  return { file, manifest, config: source.config, baseline: { ...source.baseline, file, history, adoption: { id, selected_at: manifest.selected_at } },
    tasks: source.tasks, parent_available: parentAvailable };
}

export async function adopt(options: { source: string; configPath: string; limitsPath: string; output?: string; reason?: string }): Promise<AdoptionRecord> {
  const input = await loadConfiguration(options.configPath, options.limitsPath);
  let sourceFile = path.resolve(options.source);
  if ((await fs.lstat(sourceFile)).isDirectory()) {
    for (const name of ['baseline.json', 'current.json', 'report.json']) {
      const candidate = path.join(sourceFile, name);
      const exists = await fs.lstat(candidate).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
      if (exists) { sourceFile = candidate; break; }
    }
  }
  const raw = await readLegacyJson(sourceFile);
  if (raw && typeof raw === 'object' && 'kind' in raw && ['permsift_adopted_baseline', 'permsift_baseline_selection'].includes(String(raw.kind)))
    sourceFile = path.join(path.dirname((await readAdoption(sourceFile)).file), 'source/report.json');
  const source = await collectSource(sourceFile);
  if (Object.values(compareConfigurationTerms(source.config, input.config)).some(t => t.changed)) throw new Error('Selected evidence does not verify the configured task terms; review/run the current definitions first');
  validatePolicy({ ...source.config, scenarios: source.config.scenarios.map(s => ({ ...s, prepare_directories: source.baseline.prepared[s.id] })) }, input.limits);
  const requested = path.resolve(options.output ?? defaultStore(input.configFile));
  await fs.mkdir(path.dirname(requested), { recursive: true });
  const store = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  if (within(path.dirname(sourceFile), store)) throw new Error('Baseline store must be outside the source result directory');
  if (within(input.project, store) && !input.config.exclude.includes(path.relative(input.project, store).split(path.sep)[0]))
    throw new Error('Baseline store inside the project must be under an excluded top-level directory (add .permsift-baselines to exclude or choose --output outside the project)');
  await fs.mkdir(store, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(store)).isSymbolicLink()) throw new Error('Baseline store must not be a link');
  const lockFile = path.join(store, '.adopt.lock'), lock = await fs.open(lockFile, 'wx', 0o600);
  let pending: string | undefined;
  try {
    const current = path.join(store, 'current.json');
    let previous: AdoptionManifest['previous'] = null;
    const exists = await fs.lstat(current).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
    if (exists) {
      const old = await readAdoption(current);
      previous = { id: old.manifest.id, file: path.relative(store, old.file).split(path.sep).join('/') };
    }
    const selectedAt = new Date().toISOString(), baselineContent = selectionContent(source, selectedAt);
    const content = { schema_version: 1 as const, kind: 'permsift_adopted_baseline' as const, selected_at: selectedAt, action: 'explicit_adoption' as const,
      reason: options.reason ?? '', previous, source: { selected_file: sourceFile, artifact_hash: source.artifact_hash }, authorization_limits_hash: hash(input.limits),
      artifacts: [...source.files].map(([name, value]) => ({ path: 'source/' + name, hash: semanticHash(value) })).sort((a, b) => a.path.localeCompare(b.path)),
      baseline: { id: objectId('baseline', baselineContent), ...baselineContent } };
    const manifest = manifestSchema.parse({ id: objectId('adoption', content), ...content });
    const directory = path.join(store, 'records', manifest.id.split(':').at(-1)!);
    await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    if ((await fs.lstat(path.dirname(directory))).isSymbolicLink()) throw new Error('Baseline records directory must not be a link');
    await fs.mkdir(directory, { mode: 0o700 });
    for (const [name, value] of source.files) {
      const target = path.join(directory, 'source', name); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    const manifestFile = path.join(directory, 'baseline.json');
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const validated = await readAdoption(manifestFile);
    pending = path.join(store, '.current-' + randomUUID() + '.json');
    await fs.writeFile(pending, JSON.stringify({ schema_version: 1, kind: 'permsift_baseline_selection', baseline_id: manifest.id,
      file: path.relative(store, manifestFile).split(path.sep).join('/') }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(pending, current); pending = undefined;
    return validated;
  } finally { if (pending) await fs.rm(pending, { force: true }); await lock.close(); await fs.rm(lockFile, { force: true }); }
}
