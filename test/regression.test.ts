import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema, limitsSchema } from '../src/config.js';
import { hash } from '../src/filesystem.js';
import { loadBaseline, regressionConfigs, regressionVerdict, repairCandidates } from '../src/regression.js';
import type { Report } from '../src/engine.js';
import type { Diagnosis } from '../src/diagnostics.js';

async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-regression-unit-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = configSchema.parse({ schema_version: 1, scenarios: [{ id: 'build', command: ['node','task.cjs'], initial_write_grants: ['@workspace'], initial_read_grants: ['@workspace'], assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }] }] });
  const limits = limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace'], allowed_read_roots: ['@workspace'] });
  const report = { schema_version: 1, mode: 'tighten', status: 'verified', baseline_verified: true, final_verified: true,
    environment: { node: process.version }, inputs: { snapshot_hash: 'a'.repeat(64), config_hash: hash(config), limits_hash: hash(limits) },
    policies: { build: ['@workspace/dist'] }, read_policies: { build: ['@workspace/task.cjs'] }, read_modes: { build: 'explicit' },
    trials: [{ scenario: 'build', verdict: 'pass', grants: ['@workspace/dist'], read_grants: ['@workspace/task.cjs'], evidence: 'evidence/abc.json' }] };
  const evidence = { scenario: 'build', grants: report.policies.build, read_grants: report.read_policies.build, prepared_directories: ['@workspace', '@workspace/dist'], read_grant_kinds: { '@workspace/task.cjs': 'file' } };
  await fs.mkdir(path.join(root, 'evidence'));
  const reportFile = path.join(root, 'report.json');
  await fs.writeFile(path.join(root, 'inputs.json'), JSON.stringify({ config }));
  await fs.writeFile(reportFile, JSON.stringify(report));
  await fs.writeFile(path.join(root,'evidence/abc.json'), JSON.stringify(evidence));
  return { root, config, limits, report, evidence, reportFile };
}
const diagnosis = (denials: Diagnosis['denials'] = [], stderr_excerpt = ''): Diagnosis => ({ kind: 'task_failed', summary: 'failed', denials, stderr_excerpt, failed_assertions: [], boundary_issues: [], log_limitations: 'untrusted output' });

test('baseline import uses recorded grants and exact read kinds rather than executing historical commands', async t => {
  const f = await fixture(t); const baseline = await loadBaseline(f.reportFile);
  const configs = regressionConfigs(f.config, baseline, f.limits);
  assert.deepEqual(configs.old.scenarios[0].initial_read_grants, ['@workspace/task.cjs']);
  assert.deepEqual(configs.control.scenarios[0].initial_read_grants, ['@workspace']);
  assert.deepEqual(configs.old.scenarios[0].prepare_directories, configs.control.scenarios[0].prepare_directories);
  assert.equal(baseline.read_kinds.build['@workspace/task.cjs'], 'file');
  const current = structuredClone(f.config); current.scenarios[0].command = ['node','new-task.cjs'];
  assert.deepEqual(regressionConfigs(current, baseline, f.limits).old.scenarios[0].command, current.scenarios[0].command);
});
test('unverified or inconsistent historical reports cannot become a baseline', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.reportFile, JSON.stringify({ ...f.report, status: 'incomplete' }));
  await assert.rejects(loadBaseline(f.reportFile));
  await fs.writeFile(f.reportFile, JSON.stringify({ ...f.report, inputs: { ...f.report.inputs, config_hash: 'b'.repeat(64) } }));
  await assert.rejects(loadBaseline(f.reportFile), /recorded hash/);
  await fs.writeFile(f.reportFile, JSON.stringify({ ...f.report, policies: { build: ['@workspace/other'] } }));
  await assert.rejects(loadBaseline(f.reportFile), /no passing evidence/);
});
test('baseline evidence must remain inside the report and preserve exact file kinds', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root,'evidence/abc.json'), JSON.stringify({ ...f.evidence, read_grant_kinds: {} }));
  await assert.rejects(loadBaseline(f.reportFile), /target kinds/);
  await fs.writeFile(path.join(f.root,'outside.json'), JSON.stringify(f.evidence));
  await fs.unlink(path.join(f.root,'evidence/abc.json'));
  await fs.symlink('../outside.json', path.join(f.root,'evidence/abc.json'));
  // A link inside the same report is allowed; escaping the report is not.
  await loadBaseline(f.reportFile);
  const external = await fs.mkdtemp(path.join(os.tmpdir(),'permsift-baseline-outside-'));
  t.after(() => fs.rm(external, {recursive:true,force:true}));
  await fs.writeFile(path.join(external,'outside.json'), JSON.stringify(f.evidence));
  await fs.unlink(path.join(f.root,'evidence/abc.json')); await fs.symlink(path.join(external,'outside.json'), path.join(f.root,'evidence/abc.json'));
  await assert.rejects(loadBaseline(f.reportFile), /escapes/);
});
test('task IDs, read modes, control coverage and current trusted ceilings are checked before execution', async t => {
  const f = await fixture(t); const baseline = await loadBaseline(f.reportFile);
  const changed = structuredClone(f.config); changed.scenarios[0].id = 'different';
  assert.throws(() => regressionConfigs(changed, baseline, f.limits), /Task IDs changed/);
  const legacy = structuredClone(f.config); delete legacy.scenarios[0].initial_read_grants;
  assert.throws(() => regressionConfigs(legacy, baseline, f.limits), /Read mode changed/);
  const narrow = structuredClone(f.config); narrow.scenarios[0].initial_read_grants = [];
  assert.throws(() => regressionConfigs(narrow, baseline, f.limits), /Control reads/);
  assert.throws(() => regressionConfigs(f.config, baseline, { ...f.limits, allowed_write_roots: ['@cache'] }), /trusted limits/);
});
test('incomplete execution and boundary issues cannot be classified as a permission or ordinary task failure', () => {
  const r = (status: Report['status'], verdict: 'pass'|'fail'|'unknown', d = diagnosis()) => ({ status, baseline_verified: status === 'verified', final_verified: status === 'verified', trials: [{ verdict, diagnosis: d }] } as Report);
  assert.equal(regressionVerdict(r('verified','pass')), 'pass');
  assert.equal(regressionVerdict(r('failed','fail')), 'fail');
  assert.equal(regressionVerdict(r('incomplete','unknown')), 'unknown');
  assert.equal(regressionVerdict(r('failed','fail', { ...diagnosis(), boundary_issues: [{ name:'boundary',status:'fail',detail:'bad boundary' }] })), 'unknown');
  assert.equal(regressionVerdict({ ...r('verified','pass'), final_verified: false }), 'unknown');
});
test('denial hints produce separate bounded read and write hypotheses and skip links or outside aliases', async t => {
  const f = await fixture(t); const root = path.join(f.root,'input'); await fs.mkdir(root);
  await fs.writeFile(path.join(root,'added.json'),'{}'); await fs.symlink('added.json',path.join(root,'link.json'));
  const old = regressionConfigs(f.config, await loadBaseline(f.reportFile), f.limits).old.scenarios[0];
  const control = f.config.scenarios[0];
  const hints = ['@workspace/added.json','@workspace/link.json','@workspace/../escape','/Users/private'].map(p=>({source:'stderr' as const,operation:'open',path:p,detail:'fake'}));
  const candidates = await repairCandidates(old,control,[diagnosis(hints)],root);
  assert.ok(candidates.some(s=>s.initial_read_grants?.includes('@workspace/added.json')));
  assert.ok(candidates.some(s=>s.initial_write_grants.includes('@workspace')));
  assert.ok(candidates.every(s=>!s.initial_read_grants?.includes('@workspace/link.json')));
  const bounded = { ...control, initial_read_grants: ['@workspace/task.cjs'], initial_write_grants: ['@workspace/dist'] };
  assert.equal((await repairCandidates(old,bounded,[diagnosis(hints)],root)).length,0);
});
test('missing module output is only a scoped installed-package hypothesis, with no traversal or executable resolver', async t => {
  const f = await fixture(t); const root=path.join(f.root,'input'); await fs.mkdir(path.join(root,'node_modules','@demo','style'),{recursive:true});
  const old = regressionConfigs(f.config, await loadBaseline(f.reportFile), f.limits).old.scenarios[0];
  const candidates = await repairCandidates(old,f.config.scenarios[0],[diagnosis([], "Cannot find module '@demo/style'\nCannot find module '../../escape'")],root);
  assert.deepEqual(candidates.map(s=>s.initial_read_grants),[['@workspace/node_modules/@demo/style','@workspace/task.cjs']]);
});
test('relative CommonJS requests can suggest existing exact files while traversal remains excluded', async t => {
  const f=await fixture(t);const root=path.join(f.root,'input');await fs.mkdir(path.join(root,'src'),{recursive:true});await fs.writeFile(path.join(root,'src/helper.js'),'module.exports=42;');
  const old=regressionConfigs(f.config,await loadBaseline(f.reportFile),f.limits).old.scenarios[0];
  const candidates=await repairCandidates(old,f.config.scenarios[0],[diagnosis([],"Cannot find module './src/helper'\nCannot find module './src/../../escape'")],root);
  assert.deepEqual(candidates.map(s=>s.initial_read_grants),[['@workspace/src/helper.js','@workspace/task.cjs']]);
});
test('mkdir evidence resolves ambiguous create logs and tries precise write directories before ancestors', async t => {
  const f=await fixture(t);const root=path.join(f.root,'input');await fs.mkdir(root);
  const old=regressionConfigs(f.config,await loadBaseline(f.reportFile),f.limits).old.scenarios[0];
  const hints=[{source:'sandbox_log' as const,operation:'file-write-create',path:'@workspace/extra',detail:'create'},{source:'stderr' as const,operation:'mkdir',path:'@workspace/extra',detail:'mkdir'},
    {source:'stderr' as const,operation:'open',path:'@workspace/other-file',detail:'open'}];
  const candidates=await repairCandidates(old,f.config.scenarios[0],[diagnosis(hints)],root);
  assert.deepEqual(candidates[0].initial_write_grants,['@workspace/dist','@workspace/extra']);
  assert.ok(candidates.some(s=>s.initial_write_grants.includes('@workspace')));
});

test('historical network evidence, control ceilings and cache conditions are checked independently', async t => {
  const f=await fixture(t);delete f.config.scenarios[0].initial_read_grants;
  f.config.exclude.push('node_modules');f.config.scenarios[0].install={manager:'npm',cache:'cold',registry:'https://registry.npmjs.org/'};
  f.config.scenarios[0].initial_network_grants=['registry.npmjs.org','other.example'];f.limits.allowed_network_domains=['registry.npmjs.org','other.example'];
  const report={...f.report,network_policies:{build:['registry.npmjs.org']},read_modes:{build:'legacy'},read_policies:{build:['@workspace']},
    inputs:{...f.report.inputs,config_hash:hash(configSchema.parse(f.config))},trials:[{...f.report.trials[0],read_grants:['@workspace'],network_grants:['registry.npmjs.org']}]};
  const evidence={...f.evidence,read_grants:['@workspace'],read_grant_kinds:{},network_grants:['registry.npmjs.org']};
  await fs.writeFile(path.join(f.root,'inputs.json'),JSON.stringify({config:f.config}));await fs.writeFile(f.reportFile,JSON.stringify(report));await fs.writeFile(path.join(f.root,'evidence/abc.json'),JSON.stringify(evidence));
  const baseline=await loadBaseline(f.reportFile),configs=regressionConfigs(f.config,baseline,f.limits);
  assert.deepEqual(configs.old.scenarios[0].initial_network_grants,['registry.npmjs.org']);assert.deepEqual(configs.control.scenarios[0].initial_network_grants,['registry.npmjs.org','other.example']);
  const changed=structuredClone(f.config);changed.scenarios[0].initial_network_grants=[];assert.throws(()=>regressionConfigs(changed,baseline,f.limits),/Control domains/);
  changed.scenarios[0].initial_network_grants=['registry.npmjs.org'];changed.scenarios[0].install!.cache='warm';assert.throws(()=>regressionConfigs(changed,baseline,f.limits),/cache mode/);
  assert.throws(()=>regressionConfigs(f.config,baseline,{...f.limits,allowed_network_domains:[]}),/exceeds trusted/);
  await fs.writeFile(path.join(f.root,'evidence/abc.json'),JSON.stringify({...evidence,network_grants:['other.example']}));await assert.rejects(loadBaseline(f.reportFile),/network policy mismatch/);
});

test('only captured exact network hosts inside the wider control generate domain repair hypotheses',async t=>{
  const f=await fixture(t);const old={...f.config.scenarios[0],initial_read_grants:undefined,install:{manager:'npm' as const,cache:'cold' as const,registry:'https://registry.npmjs.org/'},initial_network_grants:['registry.npmjs.org']};
  const control={...old,initial_network_grants:['registry.npmjs.org','cdn.example']};
  const hints=[{source:'sandbox_log' as const,operation:'network-outbound',path:'cdn.example:443',detail:'deny'},
    {source:'sandbox_log' as const,operation:'network-outbound',path:'outside.example:443',detail:'deny'},
    {source:'stderr' as const,operation:'unspecified',path:'untrusted.example',detail:'fake'}];
  const candidates=await repairCandidates(old,control,[diagnosis(hints)],f.root);
  assert.deepEqual(candidates.map(s=>s.initial_network_grants),[['cdn.example','registry.npmjs.org']]);
});
