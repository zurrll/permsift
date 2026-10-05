import { assertNativeEvidence } from '../support/native-evidence.js';
import { assertSummary } from '../support/result-summary.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { runExperiment } from '../../src/engine.js';
import { runRegression } from '../../src/regression.js';

const macOnly = { skip: process.platform !== 'darwin' ? 'Requires real macOS sandbox-exec; no mock substitute' : false };
const writer = "const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out','fresh');";
async function fixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'permsift-regression-integration-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project = path.join(root,'project'); await fs.mkdir(project); await fs.writeFile(path.join(project,'task.cjs'),writer);
  const config = { schema_version:1, project:'./project', scenarios:[{id:'build',command:[process.execPath,'task.cjs'],initial_write_grants:['@workspace/dist'],initial_read_grants:['@workspace/task.cjs'],auto_discover:false,assertions:[{type:'file_contains',path:'@workspace/dist/out',text:'fresh'}]}] };
  const configPath=path.join(root,'tasks.json'), limitsPath=path.join(root,'limits.json');
  await fs.writeFile(configPath,JSON.stringify(config));
  await fs.writeFile(limitsPath,JSON.stringify({schema_version:1,allowed_write_roots:['@workspace'],allowed_read_roots:['@workspace'],repetitions:2,budget_seconds:120,max_candidates:8}));
  const baseline=await runExperiment({mode:'run',configPath,limitsPath,output:path.join(root,'baseline')}); assert.equal(baseline.status,'verified',baseline.error);
  config.scenarios[0].initial_write_grants=['@workspace']; config.scenarios[0].initial_read_grants=['@workspace'];
  await fs.writeFile(configPath,JSON.stringify(config));
  return {root,project,config,configPath,limitsPath,baselinePath:path.join(root,'baseline/report.json')};
}
test('compatible code changes verify old scopes only, without rerunning minimization or wider controls',macOnly,async t=>{
  const f=await fixture(t); await fs.writeFile(path.join(f.project,'task.cjs'),writer+'// harmless change\n');
  const r=await runRegression({...f,output:path.join(f.root,'check')});
  assert.equal(r.status,'compatible',r.error); assert.equal(r.inputs.input_changed,true); assert.equal(r.trials,2); assert.equal(r.candidate_count,0);
  assert.deepEqual(r.tasks[0].stages.map(s=>s.phase),['old']);
  const run=JSON.parse(await fs.readFile(path.join(r.output,'tasks/build/old/report.json'),'utf8'));
  assert.deepEqual(run.policies.build,['@workspace/dist']); assert.deepEqual(run.read_policies.build,['@workspace/task.cjs']);
  await fs.access(path.join(r.output,'compatible.yaml')); await assert.rejects(fs.access(path.join(r.output,'suggested.yaml')));
});
test('new input needs a tested exact read addition, keeps shared preparation and produces a replayable suggestion',macOnly,async t=>{
  const f=await fixture(t); await fs.writeFile(path.join(f.project,'added.json'),'42');
  await fs.writeFile(path.join(f.project,'task.cjs'),"if(require('node:fs').readFileSync('added.json','utf8')!=='42')process.exit(9);"+writer);
  const before=await fs.readFile(f.configPath,'utf8'); const baselineBefore=await fs.readFile(f.baselinePath,'utf8');
  const r=await runRegression({...f,output:path.join(f.root,'check')});
  assert.equal(r.status,'regressed',r.error); assert.equal(r.tasks[0].status,'permission_change'); assert.equal(r.tasks[0].repair_stop,'verified');
  assert.deepEqual(r.tasks[0].suggestion?.added_read,['@workspace/added.json']); assert.deepEqual(r.tasks[0].suggestion?.added_write,[]);
  assert.equal(r.candidate_count,1); assert.deepEqual(r.tasks[0].stages.map(s=>s.phase),['old','control','old-confirm','control-confirm','repair-1','repair-verify-1']);
  const overview = await assertSummary(r.output);
  assert.equal(overview.analysis.status, 'complete');
  assert.equal(overview.tasks[0].claims.find(c => c.dimension === 'suggestion')!.status, 'corroborated');
  assert.equal(overview.tasks[0].claims.find(c => c.dimension === 'task')!.status, 'pass');
  const stages: string[][]=[];
  for(const s of r.tasks[0].stages){const run=JSON.parse(await fs.readFile(path.join(r.output,path.dirname(s.report),'report.json'),'utf8'));assert.equal(run.inputs.snapshot_hash,r.inputs.snapshot_hash);await assertNativeEvidence(run);
    const e=JSON.parse(await fs.readFile(path.join(run.output,run.trials[0].evidence),'utf8')); stages.push(e.prepared_directories);assert.ok(e.before.checks.every((c:{status:string})=>c.status==='pass'));assert.ok(e.after.checks.every((c:{status:string})=>c.status==='pass'));}
  assert.ok(stages.every(p=>JSON.stringify(p)===JSON.stringify(stages[0])));
  assert.equal(await fs.readFile(f.configPath,'utf8'),before); assert.equal(await fs.readFile(f.baselinePath,'utf8'),baselineBefore);
  const replay=await runExperiment({mode:'run',configPath:path.join(r.output,'suggested.yaml'),limitsPath:f.limitsPath,output:path.join(f.root,'replay')}); assert.equal(replay.status,'verified');
});
test('an installed dependency added after the baseline is repaired with tested package or file hypotheses',macOnly,async t=>{
  const f=await fixture(t); await fs.mkdir(path.join(f.project,'node_modules','style'),{recursive:true});
  await fs.writeFile(path.join(f.project,'node_modules/style/package.json'),'{"name":"style","version":"2.0.0","main":"index.js"}');
  await fs.writeFile(path.join(f.project,'node_modules/style/index.js'),"module.exports='fresh';");
  await fs.writeFile(path.join(f.project,'task.cjs'),"if(require('style')!=='fresh')process.exit(9);"+writer);
  const r=await runRegression({...f,output:path.join(f.root,'check')});
  assert.equal(r.tasks[0].status,'permission_change',JSON.stringify(r)); assert.equal(r.tasks[0].repair_stop,'verified');
  assert.ok(r.tasks[0].suggestion!.added_read.length);
  assert.ok(r.tasks[0].suggestion!.added_read.every(p=>p==='@workspace/node_modules/style'||p.startsWith('@workspace/node_modules/style/')));
});
test('code or assertion failure under both policies remains unresolved and does not export a repair',macOnly,async t=>{
  const f=await fixture(t); await fs.writeFile(path.join(f.project,'task.cjs'),"throw new Error('ordinary code bug');");
  const r=await runRegression({...f,output:path.join(f.root,'check')});
  assert.equal(r.status,'regressed'); assert.equal(r.tasks[0].status,'unresolved_failure'); assert.equal(r.candidate_count,0);
  assert.deepEqual(r.tasks[0].stages.map(s=>s.verdict),['fail','fail']); await assert.rejects(fs.access(path.join(r.output,'suggested.yaml')));
});
test('changing the live project between comparisons cannot change the frozen comparison input',macOnly,async t=>{
  const f=await fixture(t); await fs.writeFile(path.join(f.project,'added.json'),'42');
  await fs.writeFile(path.join(f.project,'task.cjs'),"if(require('node:fs').readFileSync('added.json','utf8')!=='42')process.exit(9);"+writer);
  let changed=false;
  const r=await runRegression({...f,output:path.join(f.root,'check'),onProgress:message=>{if(!changed&&message.includes(' · control · ')){changed=true; writeFileSync(path.join(f.project,'added.json'),'changed live');}}});
  assert.equal(r.tasks[0].repair_stop,'verified'); assert.equal(changed,true);
  const replay=await runExperiment({mode:'run',configPath:path.join(r.output,'suggested.yaml'),limitsPath:f.limitsPath,output:path.join(f.root,'replay-live')}); assert.equal(replay.status,'failed');
});
test('historical exact file targets becoming directories are inconclusive instead of recursively widening reads',macOnly,async t=>{
  const f=await fixture(t); await fs.unlink(path.join(f.project,'task.cjs'));await fs.mkdir(path.join(f.project,'task.cjs'));
  const r=await runRegression({...f,output:path.join(f.root,'check')});assert.equal(r.status,'inconclusive');assert.equal(r.trials,0);assert.match(r.tasks[0].reason!,/changed kind/);
});
test('repair candidate budgets preserve the regression result without inventing a verified suggestion',macOnly,async t=>{
  const f=await fixture(t); await fs.writeFile(path.join(f.project,'added.json'),'42');await fs.writeFile(path.join(f.project,'task.cjs'),"require('node:fs').readFileSync('added.json','utf8');"+writer);
  const limits=JSON.parse(await fs.readFile(f.limitsPath,'utf8'));limits.max_candidates=0;await fs.writeFile(f.limitsPath,JSON.stringify(limits));
  const r=await runRegression({...f,output:path.join(f.root,'check')});assert.equal(r.status,'regressed');assert.equal(r.tasks[0].status,'permission_change');assert.equal(r.tasks[0].repair_stop,'budget');assert.equal(r.candidate_count,0);
  await assert.rejects(fs.access(path.join(r.output,'suggested.yaml')));
});
test('CLI check returns regression exit code even for a verified repair and separates JSON from progress',macOnly,async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'added.json'),'42');await fs.writeFile(path.join(f.project,'task.cjs'),"require('node:fs').readFileSync('added.json','utf8');"+writer);
  const result=spawnSync(process.execPath,['dist/cli.js','check','--config',f.configPath,'--limits',f.limitsPath,'--baseline',f.baselinePath,'--output',path.join(f.root,'cli'),'--json'],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,1,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.status,'regressed');
  assert.ok(report.tasks[0].stages.some((s:{phase:string})=>s.phase==='old-confirm'));assert.match(result.stderr,/确认旧规则失败/);
});
test('new write directories are compared again under shared preparation before a precise repair is accepted',macOnly,async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'task.cjs'),writer+"fs.mkdirSync('extra',{recursive:true});fs.writeFileSync('extra/log','needed');");
  const r=await runRegression({...f,output:path.join(f.root,'check')});assert.equal(r.tasks[0].repair_stop,'verified',JSON.stringify(r));
  assert.deepEqual(r.tasks[0].suggestion?.added_write,['@workspace/extra']);
  const stages=r.tasks[0].stages;assert.ok(stages.some(s=>s.phase.startsWith('prepare-old-')&&s.verdict==='fail'));assert.ok(stages.some(s=>s.phase.startsWith('prepare-control-')&&s.verdict==='pass'));
  const final=stages.find(s=>s.phase.startsWith('repair-verify-'))!;
  assert.ok(stages.filter(s=>s.phase.startsWith('prepare-')||s.phase.startsWith('repair-')).every(s=>JSON.stringify(s.prepared_directories)===JSON.stringify(final.prepared_directories)));
});
test('precreating a directory that makes the old policy pass is a preparation change, not a proven permission addition',macOnly,async t=>{
  const f=await fixture(t);
  await fs.writeFile(f.configPath,JSON.stringify({...f.config,scenarios:f.config.scenarios.map(s=>({...s,initial_write_grants:['@workspace/dist']}))}));
  const baseline=await runExperiment({...f,mode:'run',output:path.join(f.root,'directory-read-baseline')});assert.equal(baseline.status,'verified');
  await fs.writeFile(f.configPath,JSON.stringify(f.config));
  await fs.writeFile(path.join(f.project,'task.cjs'),writer+"if(!fs.existsSync('extra'))fs.mkdirSync('extra');");
  const r=await runRegression({...f,baselinePath:path.join(baseline.output,'report.json'),output:path.join(f.root,'check')});assert.equal(r.status,'inconclusive');assert.equal(r.tasks[0].suggestion,undefined);
  assert.match(r.tasks[0].reason!,/Revised preparation/);await assert.rejects(fs.access(path.join(r.output,'suggested.yaml')));
});
test('a failing earlier task does not silently skip later compatible tasks',macOnly,async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'second.cjs'),writer);
  const first={...f.config.scenarios[0],initial_write_grants:['@workspace/dist'],initial_read_grants:['@workspace/task.cjs']};
  const second={...first,id:'second',command:[process.execPath,'second.cjs'],initial_read_grants:['@workspace/second.cjs']};
  await fs.writeFile(f.configPath,JSON.stringify({...f.config,scenarios:[first,second]}));
  const baseline=await runExperiment({...f,mode:'run',output:path.join(f.root,'two-task-baseline')});assert.equal(baseline.status,'verified');
  await fs.writeFile(f.configPath,JSON.stringify({...f.config,scenarios:[first,second].map(s=>({...s,initial_write_grants:['@workspace'],initial_read_grants:['@workspace']}))}));
  await fs.writeFile(path.join(f.project,'task.cjs'),"throw new Error('broken first task');");
  const r=await runRegression({...f,baselinePath:path.join(baseline.output,'report.json'),output:path.join(f.root,'check')});
  assert.deepEqual(r.tasks.map(s=>s.status),['unresolved_failure','compatible']);assert.equal(r.status,'regressed');
});
test('timeout and cancellation preserve inconclusive evidence without attempting a wider policy',macOnly,async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.project,'task.cjs'),"setInterval(()=>{},1000);");
  await fs.writeFile(f.configPath,JSON.stringify({...f.config,scenarios:f.config.scenarios.map(s=>({...s,timeout_seconds:1}))}));
  const r=await runRegression({...f,output:path.join(f.root,'timeout')});assert.equal(r.status,'inconclusive');assert.deepEqual(r.tasks[0].stages.map(s=>s.phase),['old']);
  const controller=new AbortController();
  const stopped=await runRegression({...f,output:path.join(f.root,'cancelled'),signal:controller.signal,onProgress:()=>controller.abort()});
  assert.equal(stopped.status,'inconclusive');assert.match(stopped.error!,/interrupted/);await assert.rejects(fs.access(path.join(stopped.output,'suggested.yaml')));
});
test('recorded prepared output directories may be absent from the source without invalidating historical reads',macOnly,async t=>{
  const f=await fixture(t);
  const narrow={...f.config,scenarios:f.config.scenarios.map(s=>({...s,initial_write_grants:['@workspace/dist'],initial_read_grants:['@workspace/task.cjs','@workspace/dist']}))};
  await fs.writeFile(f.configPath,JSON.stringify(narrow));
  const baseline=await runExperiment({...f,mode:'run',output:path.join(f.root,'prepared-read-baseline')});assert.equal(baseline.status,'verified');
  await assert.rejects(fs.access(path.join(f.project,'dist')));await fs.writeFile(f.configPath,JSON.stringify(f.config));
  const r=await runRegression({...f,baselinePath:path.join(baseline.output,'report.json'),output:path.join(f.root,'check')});
  assert.equal(r.status,'compatible',JSON.stringify(r));assert.equal(r.inputs.input_changed,false);assert.equal(r.trials,2);
});
