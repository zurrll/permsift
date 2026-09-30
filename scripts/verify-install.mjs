import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { runExperiment } from '../dist/src/engine.js';
import { runRegression } from '../dist/src/regression.js';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(repository);
await fs.mkdir('.permsift',{recursive:true});
const root=await fs.mkdtemp(path.join(repository,'.permsift/install-workflow-'));
const source=path.join(repository,'examples/install/project'),limitsPath=path.join(repository,'examples/install/limits.json');
const config=parse(await fs.readFile('examples/install/permsift.yaml','utf8'));
const retained=[];
const progress=message=>console.error(message);
const readEvidence=async(r,trial)=>JSON.parse(await fs.readFile(path.join(r.output,trial.evidence),'utf8'));
const summarize=r=>({status:r.status,search_complete:r.search_complete,trials:r.trials.length,candidates:r.trials.filter(t=>t.phase.startsWith('candidate')).length,
  write:r.policies['install-build'],network:r.network_policies['install-build'],snapshot_hash:r.inputs.snapshot_hash,installation:r.inputs.installations?.['install-build'],report:path.join(r.output,'report.json')});
try {
  const coldProject=path.join(root,'cold-project');await fs.cp(source,coldProject,{recursive:true});
  const coldConfig=path.join(root,'cold.yaml');await fs.writeFile(coldConfig,stringify({...config,project:coldProject}));
  const cold=await runExperiment({mode:'tighten',configPath:coldConfig,limitsPath,output:path.join(root,'cold'),keepWorkspaces:true,onProgress:progress});
  if(cold.workspaces)retained.push(cold.workspaces);
  assert.equal(cold.status,'verified',`Cold workflow failed; inspect ${cold.output}/report.md`);
  assert.deepEqual(cold.network_policies['install-build'],['registry.npmjs.org']);
  const necessary=cold.network_searches['install-build'].steps.find(s=>s.operation==='remove registry.npmjs.org'&&s.decision==='rejected');assert.ok(necessary);assert.equal(cold.trials.find(t=>t.id===necessary.recovery_id).verdict,'pass');
  for(const t of cold.trials){const e=await readEvidence(cold,t);if(e.task)assert.deepEqual(e.task.policy.network.allowedDomains,[]);}
  const replay=await runExperiment({mode:'run',configPath:path.join(cold.output,'recommended.yaml'),limitsPath,output:path.join(root,'cold-replay'),onProgress:progress});assert.equal(replay.status,'verified');assert.equal(replay.inputs.snapshot_hash,cold.inputs.snapshot_hash);
  const check=await runRegression({configPath:coldConfig,limitsPath,baselinePath:path.join(cold.output,'report.json'),output:path.join(root,'check'),onProgress:progress});assert.equal(check.status,'compatible');

  const final=cold.trials.filter(t=>t.phase==='final'&&t.verdict==='pass').at(-1),e=await readEvidence(cold,final);
  const warmProject=path.join(root,'warm-project');await fs.cp(source,warmProject,{recursive:true});
  await fs.cp(path.join(e.roots.cache,'npm'),path.join(warmProject,'seed'),{recursive:true});
  const warmConfig=path.join(root,'warm.yaml');await fs.writeFile(warmConfig,stringify({...config,project:warmProject,scenarios:config.scenarios.map(s=>({...s,install:{...s.install,cache:'warm',cache_seed:'@workspace/seed'}}))}));
  const warm=await runExperiment({mode:'tighten',configPath:warmConfig,limitsPath,output:path.join(root,'warm'),onProgress:progress});assert.equal(warm.status,'verified',`Warm workflow failed; inspect ${warm.output}/report.md`);assert.deepEqual(warm.network_policies['install-build'],[]);
  for(const t of warm.trials){const w=await readEvidence(warm,t);if(w.installation)assert.ok(w.installation.command.includes('--offline'));}
  const warmReplay=await runExperiment({mode:'run',configPath:path.join(warm.output,'recommended.yaml'),limitsPath,output:path.join(root,'warm-replay'),onProgress:progress});assert.equal(warmReplay.status,'verified');assert.equal(warmReplay.inputs.snapshot_hash,warm.inputs.snapshot_hash);
  for(const directory of [coldProject,warmProject])await assert.rejects(fs.access(path.join(directory,'node_modules')));
  const summary={cold:summarize(cold),cold_replay:summarize(replay),regression:{status:check.status,trials:check.trials},warm:summarize(warm),warm_replay:summarize(warmReplay),root};
  await fs.writeFile(path.join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
} finally {for(const directory of retained)await fs.rm(directory,{recursive:true,force:true});}
