import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const name of ['bundle-kit', 'cached-build']) {
  const cwd = fileURLToPath(new URL(`../examples/projects/${name}/`, import.meta.url));
  console.log(`Preparing ${name} (locked dependencies, lifecycle scripts disabled)`);
  const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
