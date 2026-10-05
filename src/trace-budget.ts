import { z } from 'zod';

export const DETAIL_REASONS = ['event_limit', 'byte_limit', 'text_limit'] as const;
export const LOAD_REASONS = ['load_event_limit', 'load_byte_limit', 'load_text_limit'] as const;
export const WORKER_REASONS = ['worker_history_event_limit', 'worker_history_byte_limit', 'worker_creation_byte_limit', 'worker_state_limit', 'worker_text_limit'] as const;
export const TRACE_REASONS = [...LOAD_REASONS, ...DETAIL_REASONS, ...WORKER_REASONS, 'io_error'] as const;
const amount = (max: number) => z.number().int().nonnegative().max(max);
export const traceBudgetSchema = z.object({
  loads: z.object({ events: amount(10_000), bytes: amount(2_000_000) }).strict().optional(),
  details: z.object({ events: amount(10_000), bytes: amount(2_000_000) }).strict(),
  workers: z.object({ events: amount(128), bytes: amount(64_000), history_events: amount(128), history_bytes: amount(16_000), max_workers: amount(16) }).strict(),
  footer_bytes: z.literal(8192),
}).strict().refine(b => (b.loads?.events ?? 0) + b.details.events + b.workers.events > 0 && (b.loads?.events ?? 0) + b.details.events + b.workers.events <= 10_000 && (b.loads?.bytes ?? 0) + b.details.bytes + b.workers.bytes + b.footer_bytes <= 2_000_000 &&
  b.workers.history_events + b.workers.max_workers <= b.workers.events && b.workers.history_bytes <= b.workers.bytes, 'Inconsistent trace budget');
export type TraceBudget = z.infer<typeof traceBudgetSchema>;
export const traceChannelsSchema = z.object({
  loads: z.object({ events: amount(10_000), bytes: amount(2_000_000), reasons: z.array(z.enum(LOAD_REASONS)).max(3) }).strict().optional(),
  details: z.object({ events: amount(10_000), bytes: amount(2_000_000), reasons: z.array(z.enum(DETAIL_REASONS)).max(3) }).strict(),
  workers: z.object({ events: amount(128), bytes: amount(64_000), history_events: amount(128), history_bytes: amount(16_000), omitted_workers: amount(2_147_483_647),
    reasons: z.array(z.enum(WORKER_REASONS)).max(5) }).strict(),
}).strict();
export type TraceChannels = z.infer<typeof traceChannelsSchema>;

/** Allocation changes what can be retained, never the total trace ceilings. */
export function traceBudget(events: number, bytes: number): TraceBudget {
  if (!Number.isInteger(events) || events < 1 || events > 10_000 || !Number.isInteger(bytes) || bytes < 8192 || bytes > 2_000_000) throw new Error('Invalid observer trace ceilings');
  const workerEvents = Math.min(128, Math.floor(events / 4)), workerBytes = Math.min(64_000, Math.floor((bytes - 8192) / 4));
  const maxWorkers = Math.min(16, Math.floor(workerEvents / 2));
  const loadEvents = Math.min(6000, Math.ceil((events - workerEvents) * 2 / 3)), loadBytes = Math.floor((bytes - workerBytes - 8192) * 0.6);
  return traceBudgetSchema.parse({ loads: { events: loadEvents, bytes: loadBytes }, details: { events: events - workerEvents - loadEvents, bytes: bytes - workerBytes - 8192 - loadBytes },
    workers: { events: workerEvents, bytes: workerBytes, history_events: workerEvents - maxWorkers, history_bytes: Math.floor(workerBytes / 4), max_workers: maxWorkers }, footer_bytes: 8192 });
}

export function validateChannels(b: TraceBudget, c: TraceChannels, count: number, ioError = false) {
  if (!!b.loads !== !!c.loads || (c.loads?.events ?? 0) + c.details.events + c.workers.events !== count ||
    (c.loads?.events ?? 0) > (b.loads?.events ?? 0) || (c.loads?.bytes ?? 0) > (b.loads?.bytes ?? 0) ||
    c.details.events > b.details.events || c.details.bytes > b.details.bytes ||
    c.workers.events > b.workers.events || c.workers.bytes > b.workers.bytes || c.workers.history_events > b.workers.history_events || c.workers.history_bytes > b.workers.history_bytes ||
    c.workers.history_events > c.workers.events || c.workers.history_bytes > c.workers.bytes ||
    c.workers.events - c.workers.history_events > b.workers.max_workers || c.workers.bytes - c.workers.history_bytes > b.workers.bytes - b.workers.history_bytes)
    throw new Error('Trace channel counts exceed or contradict their budgets');
  if (new Set(c.loads?.reasons).size !== (c.loads?.reasons.length ?? 0) || new Set(c.details.reasons).size !== c.details.reasons.length || new Set(c.workers.reasons).size !== c.workers.reasons.length ||
    (c.workers.omitted_workers > 0 && !ioError && !c.workers.reasons.some(r => r === 'worker_state_limit' || r === 'worker_creation_byte_limit')) ||
    (c.workers.omitted_workers === 0 && c.workers.reasons.some(r => r === 'worker_state_limit' || r === 'worker_creation_byte_limit'))) throw new Error('Trace channel omissions are inconsistent');
}

/** Legacy shared-channel traces cannot distinguish load health from details. */
export function traceSourceIncomplete(trace: { footer: string; reasons: string[]; budget?: TraceBudget }, source: 'loads' | 'resolutions') {
  if (trace.footer !== 'present') return true;
  const unrelated: readonly string[] = !trace.budget?.loads ? [] : source === 'loads' ? DETAIL_REASONS : LOAD_REASONS;
  return trace.reasons.some(reason => !unrelated.includes(reason));
}
