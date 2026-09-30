import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const compiled = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
const result = spawnSync(process.execPath, ['dist/cli.js', '--version'], { encoding: 'utf8' });
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(result.status, 0);
assert.equal(result.stdout.trim(), version);
await writeFile('dist/build-smoke.json', JSON.stringify({ version, cli_smoke: 'passed' }));
