import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function cli(...args: string[]) { return spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' }); }
test('CLI help and version are available without sandbox execution', () => {
  const help = cli('--help'); assert.equal(help.status, 0); assert.match(help.stdout, /tighten/);
  const version = cli('--version'); assert.equal(version.status, 0); assert.match(version.stdout, /^0\.12\.0/);
});
test('observe is explicit, requires trusted limits and only accepts usage baselines', () => {
  assert.match(cli('--help').stdout, /observe --config FILE --limits TRUSTED_FILE/);
  assert.equal(cli('observe', '--config', 'tasks.yaml').status, 2);
  assert.equal(cli('observe', '--config', 'tasks.yaml', '--limits', 'limits.json', '--baseline', 'missing-usage.json').status, 2);
});
test('check accepts the implicit baseline form and other commands reject baseline options', () => {
  const missing = cli('check', '--config', 'tasks.yaml', '--limits', 'limits.json');
  assert.equal(missing.status, 2);
  // Unsupported hosts fail at the platform gate before configuration or baseline loading.
  assert.match(missing.stderr, process.platform === 'darwin' ? /ENOENT/ : /^Permsift: Permsift requires macOS\. No unsandboxed fallback is available\.\n$/);
  for (const args of [['run', '--config', 'tasks.yaml', '--limits', 'limits.json'], ['doctor']]) {
    const rejected = cli(...args, '--baseline', 'old.json');
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /--baseline is only supported by check and observe/);
  }
  assert.match(cli('--help').stdout, /check --config FILE --baseline REPORT_JSON/);
});
test('execution commands check the host platform before reading missing input files', () => {
  for (const mode of ['run', 'tighten', 'check', 'observe']) {
    const result = cli(mode, '--config', 'tasks.yaml', '--limits', 'limits.json');
    assert.equal(result.status, 2, mode);
    assert.equal(result.stdout, '', mode);
    if (process.platform === 'darwin') assert.match(result.stderr, /ENOENT/, mode);
    else assert.equal(result.stderr, 'Permsift: Permsift requires macOS. No unsandboxed fallback is available.\n', mode);
  }
});
test('CLI requires an explicit limits file and rejects misspelled flags', () => {
  assert.equal(cli('tighten', '--config', 'anything').status, 2);
  assert.equal(cli('tighten', '--disable-sandbox').status, 2);
  assert.equal(cli('doctor', '--config', 'ignored.yaml').status, 2);
  assert.equal(cli('unknown').status, 2);
});

test('success diagnostics are explicit and reject execution/configuration options', () => {
  assert.match(cli('--help').stdout, /diagnose RESULT/); assert.match(cli('--help').stdout, /save-artifacts/);
  assert.equal(cli('diagnose', 'missing-result', '--config', 'tasks.yaml').status, 2);
  assert.equal(cli('diagnose', 'missing-result', '--save-artifacts').status, 2);
  assert.equal(cli('inspect', 'missing-result', '--save-artifacts').status, 2);
  assert.equal(cli('doctor', '--save-artifacts').status, 2);
});

test('configuration explanation has an offline entrance, mode selection and no execution/output options', () => {
  assert.match(cli('--help').stdout, /explain --config FILE --limits TRUSTED_FILE/);
  assert.equal(cli('explain', '--config', 'missing.json').status, 2);
  const missing = cli('explain', '--config', 'missing.json', '--limits', 'also-missing.json', '--json');
  assert.equal(missing.status, 2); assert.equal(JSON.parse(missing.stdout).status, 'invalid');
  assert.equal(JSON.parse(missing.stdout).issues.length, 2);
  for (const args of [['--for', 'wrong'], ['--output', 'unwanted'], ['--baseline', 'old.json'], ['--save-artifacts'], ['--keep-workspaces'], ['extra']]) {
    assert.equal(cli('explain', '--config', 'tasks.yaml', '--limits', 'limits.json', ...args).status, 2);
  }
  assert.equal(cli('run', '--for', 'observe').status, 2);
});
