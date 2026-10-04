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
import type { ProgressEvent } from '../../src/progress.js';
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

test('cold npm install uses real domain filtering, fresh caches, disabled scripts and an offline build, then replays',macOnly,async t=>{
  const f=await fixture(t),before=await manifest(f.project);
  const r=await runExperiment({...f,mode:'tighten',output:path.join(f.root,'search')});
  assert.equal(r.status,'verified',JSON.stringify(r.trials.at(-1)?.diagnosis));assert.equal(r.search_complete,true);
  assert.deepEqual(r.network_policies.install,['127.0.0.1']);assert.ok(r.network_searches.install.steps.some(s=>s.decision==='accepted'&&s.operation==='remove unused.example'));
  const rejected=r.network_searches.install.steps.find(s=>s.operation==='remove 127.0.0.1'&&s.decision==='rejected')!;
  assert.ok(rejected);assert.equal(r.trials.find(t=>t.id===rejected.recovery_id)?.verdict,'pass');
  const failed=await evidence(r,r.trials.findIndex(t=>t.id===rejected.trial_id));
  assert.match(failed.installation.execution.violations.map((v:{line:string})=>v.line).join('\n'),/deny network-outbound 127\.0\.0\.1:/);
  for (let i=0;i<r.trials.length;i++) {const e=await evidence(r,i);assert.equal(e.install_cache.condition,'cold');assert.equal(e.install_cache.initial_files,0);
    if(e.task){assert.deepEqual(e.task.policy.network.allowedDomains,[]);assert.equal(e.installation.inputs_unchanged,true);assert.ok(e.before_offline_task.checks.every((c:{status:string})=>c.status==='pass'));}}
  assert.deepEqual(await manifest(f.project),before);assert.ok(f.requests()>=4,'Baseline and final repetitions must genuinely download from the fixture');
  const replay=await runExperiment({mode:'run',configPath:path.join(r.output,'recommended.yaml'),limitsPath:f.limitsPath,output:path.join(f.root,'replay')});assert.equal(replay.status,'verified');assert.deepEqual(replay.network_policies,r.network_policies);
});

test('fixed warm cache is cloned per trial, installs offline with no domains and replays while the registry is down',macOnly,async t=>{
  const f=await fixture(t);f.limits.repetitions=1;await f.save();
  const progress: ProgressEvent[] = [];
  const cold=await runExperiment({...f,mode:'run',output:path.join(f.root,'cold'),keepWorkspaces:true,onProgressEvent:event=>progress.push(event)});assert.equal(cold.status,'verified');
  assert.deepEqual(progress.map(event=>event.stage),['prepare','install','task']);
  assert.ok(progress.every(event=>event.task==='install'&&event.phase==='baseline'&&event.attempt===1&&event.repetitions===1));
  t.after(()=>fs.rm(cold.workspaces!,{recursive:true,force:true}));const e=await evidence(cold,0);
  await fs.cp(path.join(e.roots.cache,'npm'),path.join(f.project,'seed'),{recursive:true});const seed=await manifest(path.join(f.project,'seed'));
  const scenario=f.config.scenarios[0];Object.assign(scenario.install,{cache:'warm',cache_seed:'@workspace/seed'});scenario.initial_network_grants=[];f.limits.repetitions=2;await f.save();f.unavailable();const before=f.requests();
  const warm=await runExperiment({...f,mode:'run',output:path.join(f.root,'warm'),keepWorkspaces:true});t.after(()=>fs.rm(warm.workspaces!,{recursive:true,force:true}));assert.equal(warm.status,'verified',JSON.stringify(warm.trials[0].diagnosis));
  assert.equal(f.requests(),before);assert.deepEqual(await manifest(path.join(f.project,'seed')),seed);
  assert.equal((warm.inputs.installations as Record<string,{cache_seed_hash:string}>).install.cache_seed_hash.length,64);
  const first=await evidence(warm,0),second=await evidence(warm,1);assert.ok(first.installation.command.includes('--offline'));assert.deepEqual(first.installation.execution.policy.network.allowedDomains,[]);
  assert.match(first.install_cache.fork.strategy,/preferred/);assert.notEqual(first.roots.cache,second.roots.cache);
  await fs.rm(first.roots.cache,{recursive:true});assert.equal(await fs.readFile(path.join(second.roots.workspace,'node_modules/fixture-dep/index.js'),'utf8'),'module.exports=42;');
  const replay=await runExperiment({mode:'run',configPath:path.join(warm.output,'recommended.yaml'),limitsPath:f.limitsPath,output:path.join(f.root,'warm-replay')});assert.equal(replay.status,'verified');assert.equal(f.requests(),before);
});

test('missing network grants fail before the offline command; lock mismatch and stale output cannot pass',macOnly,async t=>{
  const f=await fixture(t);f.config.scenarios[0].initial_network_grants=[];f.limits.repetitions=1;await f.save();
  await fs.mkdir(path.join(f.project,'dist'));await fs.writeFile(path.join(f.project,'dist/out'),'fresh');
  const denied=await runExperiment({...f,mode:'run',output:path.join(f.root,'denied')});assert.equal(denied.status,'failed');assert.equal(f.requests(),0);assert.ok((await evidence(denied,0)).task_skipped);
  f.config.scenarios[0].initial_network_grants=['127.0.0.1'];await f.save();await fs.writeFile(path.join(f.project,'package.json'),JSON.stringify({name:'install-test',dependencies:{'fixture-dep':'2.0.0'}}));
  const mismatch=await runExperiment({...f,mode:'run',output:path.join(f.root,'mismatch')});assert.equal(mismatch.status,'failed');assert.ok((await evidence(mismatch,0)).task_skipped);await assert.rejects(fs.access(path.join(mismatch.output,'recommended.yaml')));
});

test('registry outages remain unknown rather than proving a domain or exporting a working policy',macOnly,async t=>{
  const f=await fixture(t);f.unavailable();const r=await runExperiment({...f,mode:'tighten',output:path.join(f.root,'outage')});
  assert.equal(r.status,'incomplete');assert.equal(r.trials[0].verdict,'unknown');assert.equal(r.baseline_verified,false);assert.ok((await evidence(r,0)).task_skipped);await assert.rejects(fs.access(path.join(r.output,'recommended.yaml')));
});

test('an intermittent registry failure rejects no domain as necessary and records an unknown with a passing recovery',macOnly,async t=>{
  const f=await fixture(t);f.limits.repetitions=1;await f.save();let injected=false;
  const r=await runExperiment({...f,mode:'tighten',output:path.join(f.root,'intermittent'),onProgress:message=>{if(!injected&&message.includes('candidate_network')&&message.includes('network: 127.0.0.1')&&!message.includes('unused.example')){injected=true;f.failNext();}}});
  assert.equal(r.status,'verified');assert.equal(r.search_complete,false);
  const unknown=r.network_searches.install.steps.find(s=>s.decision==='unknown')!;assert.ok(unknown);assert.equal(r.trials.find(t=>t.id===unknown.recovery_id)?.verdict,'pass');
  if (!r.network_policies.install.includes('unused.example')) {
    const later=r.network_searches.install.steps.find(s=>s.operation===unknown.operation&&s.decision==='accepted'&&r.trials.findIndex(t=>t.id===s.trial_id)>r.trials.findIndex(t=>t.id===unknown.trial_id));
    assert.ok(later,'A later removal needs its own fresh passing trial');assert.equal(r.trials.find(t=>t.id===later.trial_id)?.verdict,'pass');
  }
});

test('a lockfile host change is checked with old domains and a tested, bounded domain repair',macOnly,async t=>{
  const f=await fixture(t);f.limits.repetitions=1;f.config.scenarios[0].initial_network_grants=['127.0.0.1'];await f.save();
  const baseline=await runExperiment({...f,mode:'run',output:path.join(f.root,'baseline')});assert.equal(baseline.status,'verified');
  f.lock.packages['node_modules/fixture-dep'].resolved=`http://localhost:${f.port}/pkg.tgz`;await fs.writeFile(path.join(f.project,'package-lock.json'),JSON.stringify(f.lock));f.config.scenarios[0].initial_network_grants=['127.0.0.1','localhost'];await f.save();
  const r=await runRegression({...f,baselinePath:path.join(baseline.output,'report.json'),output:path.join(f.root,'check')});assert.equal(r.status,'regressed',JSON.stringify(r.tasks));
  assert.equal(r.tasks[0].status,'permission_change');assert.deepEqual(r.tasks[0].suggestion?.added_network,['localhost']);assert.equal(r.tasks[0].repair_stop,'verified');
  const replay=await runExperiment({mode:'run',configPath:path.join(r.output,'suggested.yaml'),limitsPath:f.limitsPath,output:path.join(f.root,'replay')});assert.equal(replay.status,'verified');
});

test('install timeouts and cancellation cannot execute the later command or export a verified policy',macOnly,async t=>{
  const f=await fixture(t);f.hang();f.config.scenarios[0].timeout_seconds=1;f.limits.repetitions=1;await f.save();
  const timed=await runExperiment({...f,mode:'run',output:path.join(f.root,'timed')});assert.equal(timed.status,'incomplete');assert.equal(timed.trials[0].verdict,'unknown');
  const first=await evidence(timed,0);assert.equal(first.installation.execution.process.status,'timed_out');assert.ok(first.task_skipped);assert.equal(first.task,undefined);
  f.config.scenarios[0].timeout_seconds=20;await f.save();const controller=new AbortController();f.onRequest(()=>controller.abort());
  const aborted=await runExperiment({...f,mode:'run',signal:controller.signal,output:path.join(f.root,'aborted')});assert.equal(aborted.status,'incomplete');assert.equal(aborted.trials[0].verdict,'unknown');assert.equal((await evidence(aborted,0)).installation.execution.process.status,'aborted');
  for (const r of [timed,aborted])await assert.rejects(fs.access(path.join(r.output,'recommended.yaml')));
});
