import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkAssertions, safeRead } from '../src/assertions.js';
import { classifyTrial } from '../src/engine.js';

test('semantic assertions reject skipped, missing, failed and duplicate test cases', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-assert-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const roots = { workspace: root, cache: root, tmp: root };
  for (const tests of [[{name:'a',status:'skipped'}], [], [{name:'a',status:'failed'}], [{name:'a',status:'passed'},{name:'a',status:'passed'}]]) {
    await fs.writeFile(path.join(root, 'tests.json'), JSON.stringify({ tests }));
    const checks = await checkAssertions([{ type: 'test_results', path: '@workspace/tests.json', expected_tests: ['a'] }], roots);
    assert.equal(checks[0].status, 'fail');
  }
  await fs.writeFile(path.join(root, 'tests.json'), JSON.stringify({ tests: [{name:'a',status:'passed'}] }));
  assert.equal((await checkAssertions([{ type: 'test_results', path: '@workspace/tests.json', expected_tests: ['a'] }], roots))[0].status, 'pass');
});
test('JSON pointers are own-property-only and preserve exact value types', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-assert-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'out'), '{"a/b":{"~":1}}');
  const checks = await checkAssertions([
    { type: 'json_equals', path: '@workspace/out', pointer: '/a~1b/~0', value: 1 },
    { type: 'json_equals', path: '@workspace/out', pointer: '/a~1b/~0', value: '1' },
    { type: 'json_equals', path: '@workspace/out', pointer: '/constructor', value: {} },
  ], { workspace: root, cache: root, tmp: root });
  assert.deepEqual(checks.map(c=>c.status), ['pass','fail','fail']);
});
test('host assertions reject symlink escape, directories and oversized files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-assert-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink('/etc/hosts', path.join(root, 'link'));
  await assert.rejects(safeRead(path.join(root, 'link'), root), /Symlink/);
  await assert.rejects(safeRead(root, root), /regular file/);
  await fs.writeFile(path.join(root, 'big'), Buffer.alloc(1_048_577));
  await assert.rejects(safeRead(path.join(root, 'big'), root), /1 MiB/);
});
test('zero exit code cannot override assertion failure or missing probe evidence', () => {
  const pass = { name: 'check', status: 'pass' as const, detail: '' };
  assert.equal(classifyTrial('completed', 0, [{ ...pass, status: 'fail' }], [pass]), 'fail');
  assert.equal(classifyTrial('completed', 0, [pass], [{ ...pass, status: 'unknown' }]), 'unknown');
  assert.equal(classifyTrial('timed_out', null, [pass], [pass]), 'unknown');
  assert.equal(classifyTrial('completed', 1, [pass], [pass]), 'fail');
  assert.equal(classifyTrial('completed', 0, [pass], []), 'unknown');
  assert.equal(classifyTrial('completed', 0, [], [pass]), 'unknown');
});
