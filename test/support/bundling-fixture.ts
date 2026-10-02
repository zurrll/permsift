import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { TestContext } from 'node:test';

/** Explicit controlled packages; only the real build tool is copied from the host. */
export async function bundlingFixture(t: Pick<TestContext, 'after'>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-bundle-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = { workspace: path.join(root, 'project'), cache: path.join(root, 'cache'), tmp: path.join(root, 'tmp') };
  for (const p of Object.values(roots)) await fs.mkdir(p);
  const metadata = JSON.parse(await fs.readFile('node_modules/esbuild/package.json', 'utf8'));
  for (const name of ['esbuild', `@esbuild/${process.platform}-${process.arch}`]) {
    const target = path.join(roots.workspace, 'node_modules', name); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(path.resolve('node_modules', name), target, { recursive: true });
  }
  const pkg = async (name: string, source: string, version = '1.0.0', extra: object = {}) => {
    const target = path.join(roots.workspace, 'node_modules', name); await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js', ...extra }));
    await fs.writeFile(path.join(target, 'index.js'), source);
  };
  await pkg('shared', 'export const answer = 42;');
  for (const name of ['app-a', 'app-b']) await pkg(name, "export { answer } from 'shared';");
  await pkg('lazy-pkg', 'export const lazyValue = 7;');
  await pkg('external-pkg', 'export const externalValue = 5;');
  await pkg('dropped', "throw Error('unused side-effect-free module must not execute'); export const unused = 9;", '1.0.0', { sideEffects: false });
  await pkg('type-only', "throw Error('type-only module must not execute');", '1.0.0', { types: 'index.d.ts' });
  await fs.writeFile(path.join(roots.workspace, 'node_modules/type-only/index.d.ts'), 'export type Shape = number;');
  await fs.mkdir(path.join(roots.workspace, 'src'));
  await fs.writeFile(path.join(roots.workspace, 'src/index.ts'), "import { answer } from 'app-a';\nimport { unused } from 'dropped';\nimport type { Shape } from 'type-only';\nimport { externalValue } from 'external-pkg';\nexport const value: Shape = answer + externalValue;\nexport const lazy = () => import('lazy-pkg');\n");
  await fs.writeFile(path.join(roots.workspace, 'package.json'), JSON.stringify({ name: 'controlled-bundle-fixture', type: 'module', devDependencies: { esbuild: metadata.version } }));
  await fs.writeFile(path.join(roots.workspace, 'build.mjs'), `import {build} from 'esbuild';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const result = await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'node',splitting:true,sourcemap:true,outdir:'dist',outExtension:{'.js':'.mjs'},external:['external-pkg'],metafile:true});
const built = await import('./dist/index.mjs');
assert.equal(built.value,47); assert.equal((await built.lazy()).lazyValue,7);
await writeFile('dist/meta.json',JSON.stringify(result.metafile));
await writeFile('dist/smoke.json',JSON.stringify({passed:true}));
`);
  const configPath = path.join(root, 'tasks.json'), limitsPath = path.join(root, 'limits.json');
  const scenario = { id: 'bundle', command: [process.execPath, 'build.mjs'], observation: { esbuild: {
    bundler: '@workspace/node_modules/esbuild', metafile: '@workspace/dist/meta.json', output_root: '@workspace/dist' } },
    initial_write_grants: ['@workspace/dist'], initial_read_grants: ['@workspace'], auto_discover: false,
    assertions: [{ type: 'json_equals', path: '@workspace/dist/smoke.json', pointer: '/passed', value: true }] };
  await fs.writeFile(configPath, JSON.stringify({ schema_version: 1, project: roots.workspace, exclude: ['.git', 'dist'], scenarios: [scenario] }));
  await fs.writeFile(limitsPath, JSON.stringify({ schema_version: 1, allowed_write_roots: ['@workspace/dist'], allowed_read_roots: ['@workspace'], repetitions: 3, budget_seconds: 120 }));
  return { root, roots, configPath, limitsPath, pkg, scenario };
}
