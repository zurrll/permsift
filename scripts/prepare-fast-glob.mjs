import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const project = path.join(repository, '.permsift/third-party/fast-glob');
const remote = 'https://github.com/mrmlnc/fast-glob.git';
const commit = '48687898dd26d4e935a0e5ecf6720e7c5aeac15d';
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
try { await fs.access(project); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await fs.mkdir(project, { recursive: true });
  git('init'); git('remote', 'add', 'origin', remote);
  git('fetch', '--depth=1', 'origin', commit); git('checkout', '--detach', 'FETCH_HEAD');
}
if (git('remote', 'get-url', 'origin') !== remote || git('rev-parse', 'HEAD') !== commit) throw new Error('Conflicting fast-glob checkout; expected the documented pinned commit');
git('diff', '--exit-code', 'HEAD');
// Do not regenerate the lock or install dependencies here. Real installations happen in the sandbox.
for (const name of ['package-lock.json', 'verify.cjs']) {
  const target = path.join(project, name), content = await fs.readFile(path.join(repository, 'examples/third-party/fast-glob', name));
  const current = await fs.readFile(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (current && !current.equals(content)) throw new Error(`Refusing to replace changed fixture ${target}`);
  await fs.writeFile(target, content);
}
console.log(`Prepared fast-glob ${commit}; no dependencies installed outside the sandbox.`);
