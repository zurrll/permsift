import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { saveJson } from './filesystem.js';
import { readResult } from './result-reader.js';
import { explainResult, summaryMarkdown, type ResultSummary } from './result-explanation.js';
import { readLegacyJson } from './model/io.js';
import { adaptLegacy } from './model/legacy.js';
import type { ResultRecord } from './result-reader.js';
import { terminalView, type TerminalView } from './terminal.js';

/** Once per completed workflow, outside the trial/search loop. No new task or project read. */
export async function publishSummary(file: string, markdown: string): Promise<ResultSummary> {
  let result: ResultRecord;
  try { result = await readResult(file); }
  catch (error) {
    // A failed journal can leave partial/invalid companions. Preserve the workflow's
    // existing failure contract; never promote the refused companions into facts.
    const model = adaptLegacy(await readLegacyJson(file));
    result = { file, artifact_hash: model.source.artifact_hash, model, executions: model.executions.map(e => ({ task: model.tasks.find(t => t.id === e.task_id)!.key,
      reference: e.origin.record, facts: e, native: false })), children: [], gaps: ['Companion validation failed; only the workflow projection is available: ' + String(error)] };
  }
  const summary = explainResult(result), directory = path.dirname(file), overview = summaryMarkdown(summary);
  await saveJson(path.join(directory, 'summary.json'), summary);
  await saveJson(path.join(directory, 'terminal.json'), terminalView(result, summary));
  await writeFile(path.join(directory, 'summary.md'), overview, { mode: 0o600 });
  const details = await readFile(markdown, 'utf8');
  await writeFile(markdown, overview + '\n---\n\n' + details, { mode: 0o600 });
  return summary;
}

/** The CLI reads its just-published projection, avoiding a second traversal of execution sidecars. */
export async function readPublishedSummary(directory: string): Promise<ResultSummary> {
  return await readLegacyJson(path.join(directory, 'summary.json')) as ResultSummary;
}

/** Display cache produced by this workflow, never used by inspect or policy acceptance. */
export async function readPublishedTerminal(directory: string): Promise<TerminalView> {
  return await readLegacyJson(path.join(directory, 'terminal.json')) as TerminalView;
}
