import { execFileSync } from 'node:child_process';
import { mkdir, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = path.join(root, '.permsift/third-party/clsx');
const commit = '925494cf31bcd97d3337aacd34e659e80cae7fe2';
const repository = 'https://github.com/lukeed/clsx.git';
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
let exists = true;
try { await access(project); } catch (e) { if (e.code !== 'ENOENT') throw e; exists = false; }
if (!exists) {
  await mkdir(project, { recursive: true });
  git('init'); git('remote', 'add', 'origin', repository);
  git('fetch', '--depth=1', 'origin', commit); git('checkout', '--detach', 'FETCH_HEAD');
}
if (git('remote', 'get-url', 'origin') !== repository || git('rev-parse', 'HEAD') !== commit) {
  throw new Error(`Expected the pinned clsx checkout at ${project}; move conflicting contents before retrying.`);
}
git('diff', '--exit-code', 'HEAD');
await copyFile(path.join(root, 'examples/third-party/clsx/package-lock.json'), path.join(project, 'package-lock.json'));
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: project, stdio: 'inherit' });
console.log(`Prepared clsx ${commit}; dependency preparation happened outside the sandbox experiment.`);
