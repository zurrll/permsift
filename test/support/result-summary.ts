import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readResult } from '../../src/result-reader.js';
import { explainResult, summaryMarkdown, type ResultSummary } from '../../src/result-explanation.js';

/** Uses the executions already produced by an integration test. Never runs another task. */
export async function assertSummary(output: string, primary = 'report'): Promise<ResultSummary> {
  const saved: ResultSummary = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
  assert.deepEqual(saved, explainResult(await readResult(path.join(output, primary + '.json'))));
  assert.equal(await readFile(path.join(output, 'summary.md'), 'utf8'), summaryMarkdown(saved));
  assert.ok((await readFile(path.join(output, primary + '.md'), 'utf8')).startsWith(summaryMarkdown(saved)));
  return saved;
}
