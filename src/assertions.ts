import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Assertion } from './config.js';
import { noSymlinks, resolveAlias, type Roots } from './filesystem.js';
import { checkJunit } from './junit.js';

export type Check = { name: string; status: 'pass' | 'fail' | 'unknown'; detail: string };
export async function safeRead(file: string, root: string) {
  await noSymlinks(root, file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error('Assertion target must be a regular file <= 1 MiB');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
const testResults = z.object({ tests: z.array(z.object({ name: z.string(), status: z.enum(['passed', 'failed', 'skipped']) }).strict()) }).strict();
export async function checkAssertions(assertions: Assertion[], roots: Roots): Promise<Check[]> {
  const result: Check[] = [];
  for (const assertion of assertions) {
    const name = `${assertion.type}:${assertion.path}`;
    try {
      const content = await safeRead(resolveAlias(assertion.path, roots), roots.workspace);
      let passed = true;
      let detail: string | undefined;
      if (assertion.type === 'file_contains') passed = content.includes(assertion.text);
      if (assertion.type === 'json_equals') {
        let value: unknown = JSON.parse(content);
        for (const part of assertion.pointer.split('/').slice(1).map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'))) {
          value = value !== null && typeof value === 'object' && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
        }
        passed = isDeepStrictEqual(value, assertion.value);
      }
      if (assertion.type === 'test_results') {
        const { tests } = testResults.parse(JSON.parse(content));
        const names = tests.map(t => t.name);
        passed = new Set(names).size === names.length && tests.every(t => t.status === 'passed') && assertion.expected_tests.every(name => names.includes(name));
      }
      if (assertion.type === 'junit') {
        const junit = checkJunit(content, assertion.expected_tests);
        passed = junit.passed; detail = junit.detail;
      }
      result.push({ name, status: passed ? 'pass' : 'fail', detail: detail ?? (passed ? 'Assertion satisfied' : 'Expected content or test outcomes not satisfied') });
    } catch (e) { result.push({ name, status: 'fail', detail: String(e) }); }
  }
  return result;
}
