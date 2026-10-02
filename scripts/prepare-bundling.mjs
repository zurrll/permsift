import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url)); process.chdir(repository);
execFileSync(process.execPath, ['scripts/prepare-fast-glob.mjs'], { stdio: 'inherit' });
const source = path.join(repository, '.permsift/third-party/fast-glob');
const project = path.join(repository, '.permsift/third-party/fast-glob-bundle');
async function same(a, b) {
  const x = await fs.lstat(a), y = await fs.lstat(b);
  if (x.isSymbolicLink() || y.isSymbolicLink()) return x.isSymbolicLink() && y.isSymbolicLink() && await fs.readlink(a) === await fs.readlink(b);
  if (x.isFile() && y.isFile()) return (await fs.readFile(a)).equals(await fs.readFile(b));
  if (!x.isDirectory() || !y.isDirectory()) return false;
  const names = (await fs.readdir(a)).sort();
  if (JSON.stringify(names) !== JSON.stringify((await fs.readdir(b)).sort())) return false;
  for (const name of names) if (!await same(path.join(a, name), path.join(b, name))) return false;
  return true;
}
const exists = await fs.lstat(project).catch(e => { if (e.code !== 'ENOENT') throw e; });
if (exists) {
  if (!exists.isDirectory() || exists.isSymbolicLink()) throw new Error('Prepared project must be an ordinary directory');
  for (const name of ['src', 'fixtures', 'LICENSE']) if (!await same(path.join(source, name), path.join(project, name))) throw new Error(`Prepared upstream asset changed: ${name}; refusing to replace it`);
  for (const name of ['package.json', 'package-lock.json', 'build.cjs']) if (!await same(path.join(repository, 'examples/third-party/fast-glob-bundle', name), path.join(project, name))) throw new Error(`Prepared task asset changed: ${name}; refusing to replace it`);
  console.log(`Reused unchanged pinned source and task assets at ${project}; no dependencies installed.`);
  process.exit(0);
}
await fs.mkdir(project);
for (const name of ['src', 'fixtures', 'LICENSE']) await fs.cp(path.join(source, name), path.join(project, name), { recursive: true });
for (const name of ['package.json', 'package-lock.json', 'build.cjs']) await fs.copyFile(path.join(repository, 'examples/third-party/fast-glob-bundle', name), path.join(project, name));
await fs.writeFile(path.join(project, 'permsift-source.json'), JSON.stringify({ project: 'fast-glob', version: '3.3.3',
  remote: 'https://github.com/mrmlnc/fast-glob.git', commit: '48687898dd26d4e935a0e5ecf6720e7c5aeac15d',
  adaptation: 'Unchanged upstream src/fixtures/LICENSE; TypeScript 4.9.5 CommonJS syntax transpilation then esbuild, with minimal locked runtime/tool dependencies. No type checking, not upstream npm run build.' }, null, 2) + '\n');
console.log(`Prepared ${project}; dependencies will be installed in the sandbox.`);
