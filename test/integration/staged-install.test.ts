import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runExperiment, type Report } from '../../src/engine.js';
import { runRegression } from '../../src/regression.js';
import { manifest } from '../../src/filesystem.js';

const macOnly = { skip: process.platform !== 'darwin' ? 'Requires the real macOS sandbox and npm proxy' : false };
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-install-integration-')));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project'),pkg=path.join(root,'tar','package');await fs.mkdir(project);await fs.mkdir(pkg,{recursive:true});
  await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'fixture-dep',version:'1.0.0',main:'index.js',scripts:{postinstall:"node -e \"require('node:fs').writeFileSync('SCRIPT_RAN','bad')\""}}));
  await fs.writeFile(path.join(pkg,'index.js'),'module.exports=42;');
  const archive=path.join(root,'pkg.tgz');await promisify(execFile)('/usr/bin/tar',['-czf',archive,'-C',path.join(root,'tar'),'package']);
  const bytes=await fs.readFile(archive),integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
  let requests=0,unavailable=false,nextUnavailable=false,hang=false;
  const server=createServer((req,res)=>{if(req.url!=='/pkg.tgz'){res.writeHead(404);res.end();return;}requests++;if(hang)return;const fail=unavailable||nextUnavailable;nextUnavailable=false;res.writeHead(fail?503:200,{'content-type':'application/octet-stream'});res.end(fail?'unavailable':bytes);});
  await new Promise<void>(resolve=>server.listen(0,'::',resolve));t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const port=(server.address() as {port:number}).port,url=`http://127.0.0.1:${port}/`;
  const lock={name:'install-test',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'install-test',version:'1.0.0',dependencies:{'fixture-dep':'1.0.0'}},'node_modules/fixture-dep':{version:'1.0.0',resolved:url+'pkg.tgz',integrity,hasInstallScript:true}}};
  await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'install-test',version:'1.0.0',private:true,dependencies:{'fixture-dep':'1.0.0'}}));
  await fs.writeFile(path.join(project,'package-lock.json'),JSON.stringify(lock));
  await fs.writeFile(path.join(project,'verify.cjs'),`const fs=require('node:fs');if(require('fixture-dep')!==42||fs.existsSync('node_modules/fixture-dep/SCRIPT_RAN'))process.exit(9);fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out','fresh');`);
  const config={schema_version:1,project:'./project',exclude:['dist','node_modules'],scenarios:[{id:'install',install:{manager:'npm',cache:'cold',registry:url},initial_network_grants:['127.0.0.1','unused.example'],command:[process.execPath,'verify.cjs'],timeout_seconds:20,auto_discover:false,initial_write_grants:['@workspace','@cache','@tmp'],assertions:[{type:'file_contains',path:'@workspace/dist/out',text:'fresh'}]}]};
  const limits={schema_version:1,allowed_write_roots:['@workspace','@cache','@tmp'],allowed_network_domains:['127.0.0.1','localhost','unused.example'],repetitions:2,budget_seconds:120,max_candidates:20};
  const configPath=path.join(root,'tasks.json'),limitsPath=path.join(root,'limits.json');
  const save=async()=>{await fs.writeFile(configPath,JSON.stringify(config));await fs.writeFile(limitsPath,JSON.stringify(limits));};await save();
  return{root,project,configPath,limitsPath,config,limits,save,lock,port,requests:()=>requests,unavailable:()=>{unavailable=true;},failNext:()=>{nextUnavailable=true;},hang:()=>{hang=true;},onRequest:(callback:()=>void)=>server.once('request',callback)};
}
const evidence=async(r:Report,index:number)=>JSON.parse(await fs.readFile(path.join(r.output,r.trials[index].evidence),'utf8'));


async function staged(t: TestContext) {
  const f = await fixture(t);
  const scenario = f.config.scenarios[0];
  Object.assign(scenario.install, { initial_write_grants: ['@workspace', '@cache', '@tmp'], auto_discover: false,
    narrower_candidates: [{ from: '@workspace', to: ['@workspace/node_modules'] }, { from: '@cache', to: ['@cache/npm'] }] });
  Object.assign(scenario, { initial_read_grants: ['@workspace'], narrower_candidates: [{ from: '@workspace', to: ['@workspace/dist'] }] });
  Object.assign(f.limits, { allowed_read_roots: ['@workspace'], repetitions: 2, budget_seconds: 180, max_candidates: 100 });
  // An unused installed package must be removable from reads without uninstalling it.
  Object.assign(f.lock.packages, { 'node_modules/unused-dep': { ...f.lock.packages['node_modules/fixture-dep'] } });
  const pkg = JSON.parse(await fs.readFile(path.join(f.project, 'package.json'), 'utf8')); pkg.dependencies['unused-dep'] = '1.0.0';
  Object.assign(f.lock.packages[''].dependencies, { 'unused-dep': '1.0.0' });
  await fs.writeFile(path.join(f.project, 'package.json'), JSON.stringify(pkg));
  await fs.writeFile(path.join(f.project, 'package-lock.json'), JSON.stringify(f.lock));
  await f.save(); return f;
}

test('separate stage policies shrink task reads/writes, reuse isolated installed state, and finish with real cold installations', macOnly, async t => {
  const f = await staged(t), source = await manifest(f.project);
  const r = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'staged'), keepWorkspaces: true });
  t.after(() => fs.rm(r.workspaces!, { recursive: true, force: true }));
  assert.equal(r.status, 'verified', JSON.stringify({last:r.trials.at(-1), error:r.error, unknown:r.trials.filter(t=>t.verdict==='unknown')}));
  assert.equal(r.search_complete, true);
  assert.deepEqual(r.install_policies.install, ['@cache/npm', '@workspace/node_modules']);
  assert.deepEqual(r.policies.install, ['@workspace/dist']);
  assert.ok(r.read_policies.install.includes('@workspace/node_modules/fixture-dep'));
  assert.ok(!r.read_policies.install.some(p => p === '@workspace' || p === '@workspace/node_modules' || p.includes('unused-dep')));
  const stats = r.installation_stats.install;
  assert.ok(stats.reused > 5); assert.equal(stats.snapshots, 1);
  assert.equal(stats.executed + stats.reused, r.trials.length);
  assert.ok(stats.executed < r.trials.length);
  const cached = [];
  for (let i = 0; i < r.trials.length; i++) {
    const e = await evidence(r, i);
    if (e.task) { assert.deepEqual(e.task.policy.network.allowedDomains, []); assert.equal(e.stage_policy_mode, 'separate'); }
    if (r.trials[i].installation_reused) {
      assert.equal(e.installation, undefined); assert.ok(e.installed_snapshot.source_trial); cached.push(e);
      assert.ok(e.before_offline_task.checks.every((c: {status:string}) => c.status === 'pass'));
    }
    if (r.trials[i].phase === 'final') {
      assert.equal(r.trials[i].installation_reused, false); assert.equal(e.install_cache.initial_files, 0);
      assert.ok(e.installation.inputs_unchanged); assert.ok(e.installation.execution.policy.filesystem.allowWrite.includes(path.join(e.roots.workspace, 'node_modules')));
      assert.deepEqual(e.task.policy.filesystem.allowWrite, [path.join(e.roots.workspace, 'dist')]);
    }
  }
  assert.ok(cached.length > 2);
  await fs.writeFile(path.join(cached[0].roots.workspace, 'node_modules/fixture-dep/index.js'), 'bad');
  await fs.rm(path.join(cached[0].roots.workspace, 'node_modules/unused-dep'), { recursive: true });
  assert.equal(await fs.readFile(path.join(cached[1].roots.workspace, 'node_modules/fixture-dep/index.js'), 'utf8'), 'module.exports=42;');
  assert.deepEqual(await manifest(f.project), source);
  const before = f.requests();
  const replay = await runExperiment({ mode: 'run', configPath: path.join(r.output, 'recommended.yaml'), limitsPath: f.limitsPath, output: path.join(f.root, 'replay') });
  assert.equal(replay.status, 'verified'); assert.equal(replay.installation_stats.install.reused, 0); assert.ok(f.requests() >= before + 4);
  const check = await runRegression({ ...f, baselinePath: path.join(r.output, 'report.json'), output: path.join(f.root, 'check') });
  assert.equal(check.status, 'compatible', JSON.stringify(check.tasks)); assert.equal(check.trials, 2);
});

test('task caches inside node_modules retain only their small write directory', macOnly, async t => {
  const f = await staged(t);
  Object.assign(f.config.scenarios[0], { initial_read_grants: undefined, narrower_candidates: [{ from: '@workspace', to: ['@workspace/dist', '@workspace/node_modules/.cache'] }] });
  await fs.appendFile(path.join(f.project, 'verify.cjs'), "fs.mkdirSync('node_modules/.cache',{recursive:true});fs.writeFileSync('node_modules/.cache/entry','needed');");
  await f.save();
  const r = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'cache') });
  assert.equal(r.status, 'verified', JSON.stringify({error:r.error, unknown:r.trials.filter(t=>t.verdict==='unknown')}));
  assert.deepEqual(r.policies.install, ['@workspace/dist', '@workspace/node_modules/.cache']);
  const denied = r.searches.install.steps.find(s => s.operation === 'remove @workspace/node_modules/.cache' && s.decision === 'rejected');
  assert.ok(denied); assert.equal(r.trials.find(t => t.id === denied.recovery_id)?.verdict, 'pass');
});


test('generated dependency reads participate in check and a missing package grant receives a verified task-only repair', macOnly, async t => {
  const f = await staged(t), scenario = f.config.scenarios[0];
  Object.assign(scenario, { initial_write_grants: ['@workspace/dist'], initial_read_grants: ['@workspace/verify.cjs', '@workspace/package.json', '@workspace/node_modules/fixture-dep'] });
  f.limits.repetitions = 1; await f.save();
  const baseline = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'read-baseline') }); assert.equal(baseline.status, 'verified');
  await fs.appendFile(path.join(f.project, 'verify.cjs'), "if(require('unused-dep')!==42)process.exit(11);");
  Object.assign(scenario, { initial_read_grants: ['@workspace'] }); await f.save();
  const r = await runRegression({ ...f, baselinePath: path.join(baseline.output, 'report.json'), output: path.join(f.root, 'read-check') });
  assert.equal(r.status, 'regressed', JSON.stringify(r.tasks)); assert.equal(r.tasks[0].repair_stop, 'verified');
  const added = r.tasks[0].suggestion!.added_read; assert.ok(added.length > 0); assert.ok(added.every(p => p === '@workspace/node_modules/unused-dep' || p.startsWith('@workspace/node_modules/unused-dep/')));
  assert.deepEqual(r.tasks[0].suggestion?.added_install_write, []);
  assert.deepEqual(r.tasks[0].suggestion?.write, ['@workspace/dist']);
  const replay = await runExperiment({ mode: 'run', configPath: path.join(r.output, 'suggested.yaml'), limitsPath: f.limitsPath, output: path.join(f.root, 'suggestion-replay') }); assert.equal(replay.status, 'verified');
});

test('successful cached task trials cannot replace final fresh installations during a registry outage', macOnly, async t => {
  const f = await staged(t); f.limits.repetitions = 1; await f.save();
  const r = await runExperiment({ ...f, mode: 'tighten', output: path.join(f.root, 'final-outage'), onProgress: message => { if (message.includes(' · final · ')) f.unavailable(); } });
  assert.equal(r.status, 'incomplete'); assert.equal(r.final_verified, false);
  assert.ok(r.trials.some(t => t.installation_reused && t.verdict === 'pass'));
  const final = r.trials.findIndex(t => t.phase === 'final'), e = await evidence(r, final);
  assert.equal(r.trials[final].installation_reused, false); assert.equal(r.trials[final].verdict, 'unknown');
  assert.ok(e.installation); assert.equal(e.task, undefined); assert.ok(e.task_skipped);
  await assert.rejects(fs.access(path.join(r.output, 'recommended.yaml')));
});

test('generated read target kinds are validated after installation and do not silently widen a historical file', macOnly, async t => {
  const f = await staged(t); f.limits.repetitions = 1;
  Object.assign(f.config.scenarios[0], { initial_read_grants: ['@workspace/verify.cjs', '@workspace/node_modules/fixture-dep'] }); await f.save();
  const r = await runExperiment({ ...f, mode: 'run', output: path.join(f.root, 'kind-change'), expectedReadKinds: { install: { '@workspace/node_modules/fixture-dep': 'file' } } });
  assert.equal(r.status, 'incomplete'); assert.match(r.trials[0].reason!, /changed kind/);
  const e = await evidence(r, 0); assert.ok(e.installation); assert.equal(e.task, undefined);
});
