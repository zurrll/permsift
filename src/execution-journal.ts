import path from 'node:path';
import { saveJson } from './filesystem.js';
import type { NativeExecution } from './model/native.js';

type Entry = { trial: string; facts: string; evidence: string; execution_id: string };
/** Writes finish before a workflow may accept a result, publish a snapshot, or start another trial. */
export class ExecutionJournal {
  private entries: Entry[] = [];
  constructor(private output: string, private write: typeof saveJson = saveJson) {}
  async record(trial: { id: string; evidence: string }, evidence: unknown, facts: NativeExecution, checkpoint: () => Promise<void>) {
    const entry: Entry = { trial: trial.id, facts: `executions/${trial.id}.json`, evidence: trial.evidence, execution_id: facts.execution.id };
    await this.write(path.join(this.output, trial.evidence), evidence);
    await this.write(path.join(this.output, entry.facts), facts);
    const next = [...this.entries, entry];
    await this.write(path.join(this.output, 'executions/index.json'), { schema_version: 1, kind: 'permsift_execution_index', entries: next });
    await checkpoint();
    this.entries = next;
  }
}
