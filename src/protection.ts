import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeSandbox, type BackendContext } from './backend.js';
import { noSymlinks, resolveAlias, type Roots } from './filesystem.js';
import type { ProtectionGoal } from './model/types.js';
import type { Check } from './assertions.js';
import { goalOperations, goalVerdict, type GoalResult, type ProtectionStage } from './protection-facts.js';

type Fixture = { key: string; target: string; root?: string; files: string[]; actions: { name: string; file: string; destination?: string }[] };
export type ProtectionRun = ProtectionStage & { execution: Awaited<ReturnType<typeof executeSandbox>> | null; fixture_files: number };
const unknown = (name: string, detail: string): Check => ({ name, status: 'unknown', detail });

export async function targetCheck(goal: ProtectionGoal, roots: Roots): Promise<Check> {
  const name = 'target:' + goal.key;
  try {
    const target = resolveAlias(goal.target, roots);
    await noSymlinks(roots.workspace, target);
    const stat = await fs.lstat(target);
    if (goal.target_kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new Error('Target kind differs from the declaration');
    return { name, status: 'pass', detail: `${goal.target}: existing ${goal.target_kind}; no linked path components` };
  } catch (e) { return unknown(name, `${goal.target}: ${String(e)}`); }
}

/** Probe program contains only bounded engine-created fake paths and data. */
export function protectionScript(fixtures: Fixture[]) {
  return `const fs=require('node:fs');const fixtures=${JSON.stringify(fixtures)};const results=[];
for(const fixture of fixtures){const checks=[];for(const action of fixture.actions){try{
switch(action.name){
case 'read_file':fs.readFileSync(action.file);break;
case 'list_directory':fs.readdirSync(action.file);break;
case 'write_existing_file':fs.appendFileSync(action.file,'probe-write');break;
case 'create_file':fs.writeFileSync(action.file,'probe-created',{flag:'wx'});break;
case 'remove_file':fs.unlinkSync(action.file);break;
case 'rename_file':fs.renameSync(action.file,action.destination);break;
default:throw new Error('Unsupported operation');}
checks.push({name:action.name,status:'fail',detail:'Direct operation was allowed'});
}catch(e){checks.push({name:action.name,status:['EPERM','EACCES'].includes(e.code)?'pass':'unknown',detail:String(e.code||e.message)})}}
results.push({key:fixture.key,checks})}console.log(JSON.stringify(results));`;
}

export async function fixtureControl(fixture: Fixture, marker: string, after = false, checks: Check[] = []): Promise<Check> {
  try {
    if (fixture.root) await noSymlinks(fixture.root, fixture.target);
    const target = await fs.lstat(fixture.target);
    if (fixture.files.includes(fixture.target) ? !target.isFile() : !target.isDirectory()) throw new Error('Fake target kind changed');
    // A known allowed write/remove/rename is already a failed goal. Preserve
    // that fact; its expected mutation is not an unexplained fixture tamper.
    const mutated = new Set(checks.filter(c => c.status === 'fail').map(c => c.name));
    for (const file of fixture.files) {
      if (after && fixture.actions.some(a => a.file === file && mutated.has(a.name) && a.name !== 'read_file')) continue;
      if (fixture.root) await noSymlinks(fixture.root, file);
      if (!(await fs.lstat(file)).isFile()) throw new Error('Fake fixture is not a regular file');
      if (await fs.readFile(file, 'utf8') !== marker) throw new Error('Fake fixture changed');
      if (!after) await fs.writeFile(file, marker);
    }
    for (const action of fixture.actions.filter(a => a.name === 'create_file' || a.name === 'rename_file')) {
      const destination = action.name === 'create_file' ? action.file : action.destination!;
      if (after && mutated.has(action.name)) continue;
      if (await fs.lstat(destination).catch(e => { if (e.code === 'ENOENT') return undefined; throw e; })) throw new Error('Unexpected destination already exists');
      if (!after) { await fs.writeFile(destination, marker, { flag: 'wx' }); await fs.unlink(destination); }
    }
    if (fixture.actions.some(a => a.name === 'list_directory')) await fs.readdir(fixture.target);
    return { name: 'fixture', status: 'pass', detail: after && mutated.size ? 'Unchanged fake fixtures verified; expected mutations from allowed operations remain failed probes' : after ? 'Fake fixture contents and types verified after the probe' : 'Fake fixture contents, types and host access verified before the probe' };
  } catch (e) { return unknown('fixture', String(e)); }
}

/** A minimal shape projection, never a project/dependency copy. No task input
 * is read as probe content or overwritten. All goals share one sandbox call. */
export async function protectionChecks(goals: ProtectionGoal[], context: BackendContext, moment: 'before' | 'after'): Promise<ProtectionRun> {
  const results: GoalResult[] = await Promise.all(goals.map(async goal => ({ key: goal.key, target: await targetCheck(goal, context.roots), controls_before: [], controls_after: [], checks: [], status: 'unknown' as const })));
  const result: ProtectionRun = { stage: 'task', moment, method: 'isolated_fake_workspace_v1', results, execution: null, fixture_files: 0 };
  const root = path.join(context.experimentRoot, 'protection-probes', randomUUID());
  const roots: Roots = { workspace: path.join(root, 'workspace'), cache: path.join(root, 'cache'), tmp: path.join(root, 'tmp') };
  const marker = 'permsift-fake-protection-' + randomUUID();
  const fixtures: Fixture[] = [];
  try {
    for (const p of Object.values(roots)) await fs.mkdir(p, { recursive: true });
    const fakeFiles = new Set<string>();
    const file = async (p: string) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, marker); fakeFiles.add(p); };
    // Reproduce only the positive-grant endpoints and their actual kinds.
    for (const alias of [...new Set([...context.grants, ...context.readGrants ?? []])]) {
      const actual = resolveAlias(alias, context.roots), taskRoot = context.roots[alias.slice(1).split('/')[0] as keyof Roots];
      await noSymlinks(taskRoot, actual); const stat = await fs.lstat(actual), destination = resolveAlias(alias, roots);
      if (stat.isDirectory()) await fs.mkdir(destination, { recursive: true });
      else if (stat.isFile()) await file(destination);
      else throw new Error('Grant endpoint is not a regular file/directory');
    }
    for (const [i, goal] of goals.entries()) {
      const entry = results[i]; if (entry.target.status !== 'pass') continue;
      const target = resolveAlias(goal.target, roots), files: string[] = [];
      if (goal.target_kind === 'directory') await fs.mkdir(target, { recursive: true });
      else { await file(target); files.push(target); }
      const actions = goalOperations(goal).map((name, j) => {
        const p = goal.target_kind === 'file' ? target : path.join(target, `.permsift-protection-${i}-${j}`);
        return { name, file: name === 'list_directory' ? target : p, ...name === 'rename_file' ? { destination: p + '-renamed' } : {} };
      });
      for (const action of actions) if (action.name !== 'create_file' && action.name !== 'list_directory' && !files.includes(action.file)) { await file(action.file); files.push(action.file); }
      fixtures.push({ key: goal.key, target, root: roots.workspace, files, actions });
    }
    result.fixture_files = fakeFiles.size;
    for (const fixture of fixtures) results.find(r => r.key === fixture.key)!.controls_before = [await fixtureControl(fixture, marker)];
    const ready = fixtures.filter(f => results.find(r => r.key === f.key)!.controls_before.every(c => c.status === 'pass'));
    if (ready.length) {
      result.execution = await executeSandbox([process.execPath, '-e', protectionScript(ready)], {
        ...context, roots, observer: undefined, protectedWritePaths: undefined, protectionGoals: goals,
        // Every probe is offline, with the task's fixed read/write semantics.
        networkGrants: [], invocationId: context.invocationId + '-protection-' + moment,
        timeoutMs: Math.min(context.timeoutMs, 5000),
      });
      const execution = result.execution.process;
      if (execution.status !== 'completed' || execution.exit_code !== 0) throw new Error('Protection probe process did not complete');
      const parsed: { key: string; checks: Check[] }[] = JSON.parse(execution.stdout);
      if (!Array.isArray(parsed) || parsed.length !== ready.length || parsed.some((p, i) => p.key !== ready[i].key || !Array.isArray(p.checks) ||
        p.checks.length !== ready[i].actions.length || p.checks.some((c, j) => c.name !== ready[i].actions[j].name || !['pass', 'fail', 'unknown'].includes(c.status) || typeof c.detail !== 'string'))) throw new Error('Invalid protection probe response');
      for (const p of parsed) results.find(r => r.key === p.key)!.checks = p.checks;
    }
    for (const fixture of fixtures) {
      const entry = results.find(r => r.key === fixture.key)!;
      entry.controls_after = [await fixtureControl(fixture, marker, true, entry.checks)];
      // Check the real task target again, without accessing its contents.
      const current = await targetCheck(goals.find(g => g.key === fixture.key)!, context.roots);
      if (current.status !== 'pass') entry.target = current;
      entry.status = goalVerdict(entry);
    }
  } catch (e) {
    for (const entry of results) { entry.controls_after.push(unknown('probe_execution', String(e))); entry.status = goalVerdict(entry); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  return result;
}
