import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Assertion } from './config.js';
import { noSymlinks, resolveAlias, type Roots } from './filesystem.js';
import { checkJunit } from './junit.js';

export type Check = { name: string; status: 'pass' | 'fail' | 'unknown'; detail: string };
export type AssertionEvaluation = Check & { cause: 'satisfied' | 'content_mismatch' | 'invalid_format' | 'missing_file' | 'unreadable_file' };
export async function safeRead(file: string, root: string) {
  await noSymlinks(root, file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error('Assertion target must be a regular file <= 1 MiB');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
export const testResultsSchema = z.object({ tests: z.array(z.object({ name: z.string(), status: z.enum(['passed', 'failed', 'skipped']) }).strict()) }).strict();

/** The same semantic evaluator serves task acceptance and offline diagnostics. No project code. */
export function evaluateAssertion(assertion: Assertion, content: string | undefined): AssertionEvaluation {
  const name = `${assertion.type}:${assertion.path}`;
  if (content === undefined) return { name, status: 'fail', cause: 'missing_file', detail: 'Assertion file is missing' };
  try {
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
      const { tests } = testResultsSchema.parse(JSON.parse(content));
      const names = tests.map(t => t.name);
      passed = new Set(names).size === names.length && tests.every(t => t.status === 'passed') && assertion.expected_tests.every(name => names.includes(name));
    }
    if (assertion.type === 'junit') {
      const junit = checkJunit(content, assertion.expected_tests);
      passed = junit.passed; detail = junit.detail;
    }
    return { name, status: passed ? 'pass' : 'fail', cause: passed ? 'satisfied' : 'content_mismatch', detail: detail ?? (passed ? 'Assertion satisfied' : 'Expected content or test outcomes not satisfied') };
  } catch (e) { return { name, status: 'fail', cause: 'invalid_format', detail: String(e) }; }
}
export async function checkAssertionsDetailed(assertions: Assertion[], roots: Roots): Promise<AssertionEvaluation[]> {
  const result: AssertionEvaluation[] = [];
  for (const assertion of assertions) {
    try { result.push(evaluateAssertion(assertion, await safeRead(resolveAlias(assertion.path, roots), roots.workspace))); }
    catch (e) { result.push({ name: `${assertion.type}:${assertion.path}`, status: 'fail', cause: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing_file' : 'unreadable_file', detail: String(e) }); }
  }
  return result;
}
export async function checkAssertions(assertions: Assertion[], roots: Roots): Promise<Check[]> {
  // Preserve the saved Check contract, native identities and historical verdict semantics.
  return (await checkAssertionsDetailed(assertions, roots)).map(({ cause, ...check }) => check);
}
