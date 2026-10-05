import { z } from 'zod';

const code = z.number().int().min(-2_147_483_648).max(2_147_483_647);
export const workerEventBase = z.object({ kind: z.literal('worker'), thread: z.number().int().positive(),
  action: z.enum(['created', 'ref', 'unref', 'terminate_requested', 'exit', 'parent_exit']), entry: z.string().max(4096).optional(),
  exit_code: code.optional(), referenced: z.boolean().optional(), termination_requested: z.boolean().optional() }).strict();
const valid = (e: z.infer<typeof workerEventBase> | Omit<z.infer<typeof workerEventBase>, 'kind'>) =>
  (e.action === 'created') === (e.entry !== undefined) && (e.action === 'exit') === (e.exit_code !== undefined) &&
  (e.action === 'parent_exit') === (e.referenced !== undefined) && (e.action === 'parent_exit') === (e.termination_requested !== undefined);
export const workerEventSchema = workerEventBase.refine(valid, 'Worker action fields disagree');
export const workerLifecycleSchema = workerEventBase.omit({ kind: true }).extend({ pid: z.number().int().positive(), parent_thread: z.number().int().nonnegative() }).strict()
  .refine(e => valid(e) && e.parent_thread !== e.thread, 'Worker lifecycle identity or fields disagree');
export type WorkerLifecycle = z.infer<typeof workerLifecycleSchema>;
export const workerEndSchema = z.object({ parent_trace: z.string().regex(/^\d+-\d+\.jsonl$/), entry: z.string().max(4096),
  termination_requested: z.boolean(), exit_code: code.optional(), referenced_at_parent_exit: z.boolean().optional(),
  exit_not_observed_at_parent_exit: z.literal(true).optional() }).strict();

/** Parent facts can explain a missing footer, never prove the worker trace complete. */
export function workerEnd(rows: readonly WorkerLifecycle[], file: string): z.infer<typeof workerEndSchema> | undefined {
  const [pid, thread] = file.replace('.jsonl', '').split('-').map(Number);
  const events = rows.filter(e => e.pid === pid && e.thread === thread), created = events.filter(e => e.action === 'created');
  if (created.length !== 1 || events.some(e => e.parent_thread !== created[0].parent_thread)) return undefined;
  const end = events.filter(e => e.action === 'exit').at(-1), parent = events.filter(e => e.action === 'parent_exit').at(-1);
  return { parent_trace: `${pid}-${created[0].parent_thread}.jsonl`, entry: created[0].entry!,
    termination_requested: events.some(e => e.action === 'terminate_requested' || e.termination_requested),
    ...end ? { exit_code: end.exit_code } : {}, ...parent ? { referenced_at_parent_exit: parent.referenced, exit_not_observed_at_parent_exit: true as const } : {} };
}

export function workerMissingReasons(end: z.infer<typeof workerEndSchema> | undefined): string[] {
  return !end ? [] : end.termination_requested ? ['worker_termination_requested'] : end.referenced_at_parent_exit === false ? ['worker_unref_at_parent_exit'] :
    end.exit_code !== undefined ? ['worker_exit_observed_without_footer'] : end.exit_not_observed_at_parent_exit ? ['worker_exit_not_observed_at_parent_exit'] : [];
}
