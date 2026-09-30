import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path.join(root, 'examples/regression/dependency'), stdio: 'inherit' });
console.log('Prepared locked clsx dependency outside the sandbox checks.');
