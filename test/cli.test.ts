import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function cli(...args: string[]) { return spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' }); }
test('CLI help and version are available without sandbox execution', () => {
  const help = cli('--help'); assert.equal(help.status, 0); assert.match(help.stdout, /tighten/);
  const version = cli('--version'); assert.equal(version.status, 0); assert.match(version.stdout, /^0\.1\.0/);
});
test('CLI requires an explicit limits file and rejects misspelled flags', () => {
  assert.equal(cli('tighten', '--config', 'anything').status, 2);
  assert.equal(cli('tighten', '--disable-sandbox').status, 2);
  assert.equal(cli('doctor', '--config', 'ignored.yaml').status, 2);
  assert.equal(cli('unknown').status, 2);
});
