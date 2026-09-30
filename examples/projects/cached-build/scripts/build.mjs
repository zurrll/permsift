import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const cache = path.join(process.env.XDG_CACHE_HOME, 'typescript');
const temporary = path.join(tmpdir(), 'compiler');
await mkdir(cache, { recursive: true });
await mkdir(temporary, { recursive: true });
const job = await mkdtemp(path.join(temporary, 'job-'));
try {
  // A temporary write removed before exit must still be tested, not inferred away.
  await writeFile(path.join(job, 'input.json'), JSON.stringify({ target: 'ES2022' }));
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--incremental', '--tsBuildInfoFile', path.join(cache, 'build.tsbuildinfo')], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const { greeting } = await import('../dist/index.js');
  assert.equal(greeting('Permsift'), 'Hello, Permsift!');
  await writeFile('dist/build.json', JSON.stringify({ smoke_test: 'passed' }));
} finally { await rm(job, { recursive: true, force: true }); }
