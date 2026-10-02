import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { TestContext } from 'node:test';

export async function observationFixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-observe-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = { workspace: path.join(root, 'project'), tmp: path.join(root, 'tmp'), cache: path.join(root, 'cache') };
  for (const dir of Object.values(roots)) await fs.mkdir(dir);
  const pkg = async (relative: string, name: string, version: string, code = 'module.exports=1;', esm = false) => {
    const directory = path.join(roots.workspace, 'node_modules', relative);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, main: 'index.js', ...esm ? { type: 'module' } : {} }));
    await fs.writeFile(path.join(directory, 'index.js'), code);
  };
  await fs.writeFile(path.join(roots.workspace, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { alpha: '1.0.0', '@scope/esm': '1.0.0' } }));
  await pkg('alpha', 'alpha', '1.0.0', "module.exports=require('shared');");
  await pkg('alpha/node_modules/shared', 'shared', '2.0.0');
  await pkg('shared', 'shared', '1.0.0');
  await pkg('@scope/esm', '@scope/esm', '1.0.0', 'export default 4;', true);
  await pkg('unused', 'unused', '1.0.0');
  await fs.writeFile(path.join(roots.workspace, 'task.cjs'), `
const fs=require('node:fs');const {spawnSync}=require('node:child_process');
if(require('alpha')!==1)throw Error('alpha');
const child=spawnSync(process.execPath,['-e',"if(require('shared')!==1)throw Error('shared')"]);
if(child.status!==0)throw Error(child.stderr.toString());
import('@scope/esm').then(({default:value})=>{if(value!==4)throw Error('esm');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/result','fresh');});
`);
  const configPath = path.join(root, 'tasks.json'), limitsPath = path.join(root, 'limits.json');
  await fs.writeFile(configPath, JSON.stringify({ schema_version: 1, project: roots.workspace, scenarios: [{ id: 'build', command: [process.execPath, 'task.cjs'],
    initial_write_grants: ['@workspace/dist'], initial_read_grants: ['@workspace'], assertions: [{ type: 'file_contains', path: '@workspace/dist/result', text: 'fresh' }] }] }));
  await fs.writeFile(limitsPath, JSON.stringify({ schema_version: 1, allowed_write_roots: ['@workspace'], allowed_read_roots: ['@workspace'], repetitions: 3, budget_seconds: 120 }));
  return { root, roots, pkg, configPath, limitsPath };
}
