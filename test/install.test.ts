import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configSchema, limitsSchema, validatePolicy, domainSchema } from '../src/config.js';
import { inspectInstall, installCommand, installFailureUnknown } from '../src/install.js';
import { searchPolicy } from '../src/search.js';
import type { executeSandbox } from '../src/backend.js';

const config = () => configSchema.parse({ schema_version: 1, exclude: ['node_modules'], scenarios: [{ id: 'install', install: { manager: 'npm' },
  command: ['node', 'verify.cjs'], initial_write_grants: ['@workspace'], initial_network_grants: ['registry.npmjs.org'], assertions: [{ type: 'file_exists', path: '@workspace/dist/out' }] }] });
const limits = () => limitsSchema.parse({ schema_version: 1, allowed_write_roots: ['@workspace'], allowed_network_domains: ['registry.npmjs.org'] });
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-install-unit-'))); t.after(() => fs.rm(root, {recursive:true,force:true}));
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'test',version:'1.0.0'}));
  const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/pkg': { version:'1.0.0', resolved:'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',integrity:'sha512-YWJjZA==' } } };
  await fs.writeFile(path.join(root,'package-lock.json'),JSON.stringify(lock)); return {root,lock};
}
test('domain grants are exact, canonical, bounded, install-only and independently trusted', () => {
  for (const value of ['*','*.example.com','example.com:443','https://example.com','EXAMPLE.COM','evil.com/../../x','example.com.','permsift-denied.invalid','a'.repeat(64)+'.com']) assert.equal(domainSchema.safeParse(value).success,false,value);
  assert.equal(domainSchema.parse('registry.npmjs.org'),'registry.npmjs.org');
  validatePolicy(config(),limits());
  assert.throws(()=>validatePolicy(config(),{...limits(),allowed_network_domains:undefined}),/explicit allowed_network/);
  assert.throws(()=>validatePolicy(config(),{...limits(),allowed_network_domains:['npmjs.org']}),/exceeds/);
  const c=config();c.scenarios[0].initial_network_grants!.push('registry.npmjs.org'); assert.throws(()=>validatePolicy(c,limits()),/Duplicate network/);
  delete c.scenarios[0].install;assert.throws(()=>validatePolicy(c,limits()),/require an install/);
});
test('install requires excluded installed artifacts, legacy reads and an explicit warm seed', () => {
  const c=config();c.exclude=[];assert.throws(()=>validatePolicy(c,limits()),/exclude/);
  c.exclude=['node_modules'];c.scenarios[0].initial_read_grants=['@workspace'];assert.throws(()=>validatePolicy(c,limits()),/legacy/);delete c.scenarios[0].initial_read_grants;
  c.scenarios[0].install!.cache='warm';assert.throws(()=>validatePolicy(c,limits()),/cache_seed/);
  c.scenarios[0].install!.cache_seed='@workspace/seed';validatePolicy(c,limits());
  c.scenarios[0].install!.cache='cold';assert.throws(()=>validatePolicy(c,limits()),/cold cache/);
  assert.throws(()=>configSchema.parse({...config(),scenarios:[{...config().scenarios[0],install:{manager:'npm',registry:'https://user:token@example.com/'}}]}));
});
test('lock inspection records fixed content and hosts but never adds domain permissions', async t => {
  const f=await fixture(t),s=config().scenarios[0];const data=await inspectInstall(s,f.root);
  assert.deepEqual(data.resolved_domains,['registry.npmjs.org']);assert.equal(data.cache,'cold');assert.equal(data.lock_hash.length,64);
  await fs.writeFile(path.join(f.root,'package.json'),'{}');assert.notEqual((await inspectInstall(s,f.root)).package_hash,data.package_hash);
});
test('non-registry links, missing integrity, obsolete locks and project npm configuration are rejected', async t => {
  const f=await fixture(t),s=config().scenarios[0];
  for (const resolved of ['file:../outside','git+https://github.com/example/pkg.git','https://user:token@registry.npmjs.org/pkg.tgz','http://external.example/pkg.tgz']) {
    await fs.writeFile(path.join(f.root,'package-lock.json'),JSON.stringify({...f.lock,packages:{'node_modules/pkg':{...f.lock.packages['node_modules/pkg'],resolved}}}));await assert.rejects(inspectInstall(s,f.root));
  }
  await fs.writeFile(path.join(f.root,'package-lock.json'),JSON.stringify({...f.lock,lockfileVersion:1}));await assert.rejects(inspectInstall(s,f.root),/lockfileVersion/);
  await fs.writeFile(path.join(f.root,'package-lock.json'),JSON.stringify(f.lock));await fs.writeFile(path.join(f.root,'.npmrc'),'fake-token');await assert.rejects(inspectInstall(s,f.root),/\.npmrc/);
});
test('warm cache hashes a fixed seed and rejects cache symlink escapes', async t => {
  const f=await fixture(t),s=config().scenarios[0];s.install={...s.install!,cache:'warm',cache_seed:'@workspace/seed'};
  await fs.mkdir(path.join(f.root,'seed'));await fs.writeFile(path.join(f.root,'seed','a'),'cache');
  const first=await inspectInstall(s,f.root);await fs.writeFile(path.join(f.root,'seed','a'),'changed');assert.notEqual((await inspectInstall(s,f.root)).cache_seed_hash,first.cache_seed_hash);
  await fs.symlink('../package.json',path.join(f.root,'seed','link'));await assert.rejects(inspectInstall(s,f.root),/symlinks/);
});
test('installer disables lifecycle scripts, config inheritance, retries and warm-cache network', () => {
  const s=config().scenarios[0],roots={workspace:'/w',cache:'/c',tmp:'/t'};
  const cold=installCommand(s,roots);assert.ok(cold.includes('--ignore-scripts'));assert.ok(cold.includes('--fetch-retries=0'));assert.ok(!cold.includes('--offline'));
  s.install!.cache='warm';assert.ok(installCommand(s,roots).includes('--offline'));
  const execution=(stderr:string,status='completed')=>({process:{stderr,status}} as Awaited<ReturnType<typeof executeSandbox>>);
  assert.equal(installFailureUnknown(execution('npm error ECONNRESET')),true);assert.equal(installFailureUnknown(execution('npm error 503 GET https://example.com/pkg')),true);
  assert.equal(installFailureUnknown(execution('npm error FETCH_ERROR\nnpm error network timeout at: https://example.com/pkg')),true);
  assert.equal(installFailureUnknown(execution('npm error E403')),false);assert.equal(installFailureUnknown(execution('','timed_out')),true);
});
test('network search removes domains only, restores failures and retains unknown comparisons', async () => {
  const s=config().scenarios[0];s.initial_network_grants=['registry.npmjs.org','unused.example'];s.narrower_candidates=[{from:'registry.npmjs.org',to:['evil.example']}];
  const phases:string[]=[];const r=await searchPolicy(s,{permission:'network',canContinue:()=>true,evaluate:async(g,phase)=>{phases.push(phase);return{id:String(phases.length),verdict:g.includes('registry.npmjs.org')?'pass':'fail'};}});
  assert.deepEqual(r.grants,['registry.npmjs.org']);assert.ok(phases.includes('recovery_network'));assert.ok(r.steps.every(s=>s.permission==='network'&&s.operation.startsWith('remove')));
});
