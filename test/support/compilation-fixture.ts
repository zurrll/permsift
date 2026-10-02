import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { TestContext } from 'node:test';

/** Copy the installed compiler and its platform executable, not host dependencies. */
export async function copyCompiler(workspace: string) {
  const source = path.resolve('node_modules/typescript');
  const metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  const target = path.join(workspace, 'node_modules/typescript');
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.cp(source, target, { recursive: true });
  const platform = `@typescript/typescript-${process.platform}-${process.arch}`;
  if (metadata.optionalDependencies?.[platform]) {
    await fs.mkdir(path.dirname(path.join(workspace, 'node_modules', platform)), { recursive: true });
    await fs.cp(path.resolve('node_modules', platform), path.join(workspace, 'node_modules', platform), { recursive: true });
  }
  return metadata.version as string;
}
export async function compilationFixture(t: TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-compile-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = { workspace: path.join(root, 'project'), tmp: path.join(root, 'tmp'), cache: path.join(root, 'cache') };
  for (const p of Object.values(roots)) await fs.mkdir(p);
  const version = await copyCompiler(roots.workspace);
  await fs.mkdir(path.join(roots.workspace, 'src'));
  const pkg = async (name: string, version: string, declaration: string) => {
    const directory = path.join(roots.workspace, 'node_modules', name); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, types: 'index.d.ts', main: 'index.js' }));
    await fs.writeFile(path.join(directory, 'index.d.ts'), declaration);
    await fs.writeFile(path.join(directory, 'index.js'), "throw Error('This type-only fixture must not execute');");
  };
  await pkg('type-a', '1.0.0', 'export interface Shape { value: number }');
  await pkg('type-b', '1.0.0', 'export interface Shape { value: number }');
  await pkg('@types/ambient-a', '1.0.0', 'declare const AmbientFixture: number;');
  await fs.writeFile(path.join(roots.workspace, 'src/index.ts'), "import type { Shape } from 'type-a';\nexport const answer = (x: Shape): number => x.value;\nexport const marker: typeof AmbientFixture = 1;\n");
  await fs.writeFile(path.join(roots.workspace, 'package.json'), JSON.stringify({ name: 'compile-fixture', type: 'module', devDependencies: { typescript: version, 'type-a': '1.0.0', 'type-b': '1.0.0', '@types/ambient-a': '1.0.0' } }));
  await fs.writeFile(path.join(roots.workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', declaration: true, outDir: 'dist', rootDir: 'src', types: ['ambient-a'], skipLibCheck: true }, include: ['src/**/*.ts'] }));
  const configPath = path.join(root, 'tasks.json'), limitsPath = path.join(root, 'limits.json');
  await fs.writeFile(configPath, JSON.stringify({ schema_version: 1, project: roots.workspace, exclude: ['.git', 'dist'], scenarios: [{ id: 'compile',
    command: [process.execPath, 'node_modules/typescript/bin/tsc'], observation: { typescript: { compiler: '@workspace/node_modules/typescript' } },
    initial_read_grants: ['@workspace'], initial_write_grants: ['@workspace/dist'], auto_discover: false,
    assertions: [{ type: 'file_contains', path: '@workspace/dist/index.js', text: 'answer' }, { type: 'file_contains', path: '@workspace/dist/index.d.ts', text: 'Shape' }] }] }));
  await fs.writeFile(limitsPath, JSON.stringify({ schema_version: 1, allowed_read_roots: ['@workspace'], allowed_write_roots: ['@workspace/dist'], repetitions: 3, budget_seconds: 120, max_output_bytes: 2_000_000 }));
  return { root, roots, configPath, limitsPath, pkg, version };
}
