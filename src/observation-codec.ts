import { z } from 'zod';

export const TRACE_ENCODING = 'interned-v1';
export const MAX_TRACE_STRINGS = 30_000;
const reference = z.union([z.number().int().nonnegative().max(MAX_TRACE_STRINGS - 1), z.tuple([z.string().max(4096)])]);
const compact = z.union([z.tuple([z.literal(0), reference, reference, reference]), z.tuple([z.literal(1), reference])]);

/** Definitions are inline, so a valid prefix remains decodable after interruption. */
export function traceDecoder(encoding?: string) {
  const strings: string[] = [], defined = new Set<string>();
  return {
    get size() { return strings.length; },
    decode(value: unknown): unknown {
      if (!Array.isArray(value)) return value;
      if (encoding !== TRACE_ENCODING) throw new Error('Compact record without a supported trace encoding');
      const row = compact.parse(value);
      const resolve = (ref: z.infer<typeof reference>): string => {
        if (typeof ref === 'number') {
          if (ref >= strings.length) throw new Error('Undefined trace string reference');
          return strings[ref];
        }
        if (strings.length >= MAX_TRACE_STRINGS || defined.has(ref[0])) throw new Error('Duplicate or bounded trace string definition');
        strings.push(ref[0]); defined.add(ref[0]); return ref[0];
      };
      return row[0] === 0 ? { kind: 'resolve', url: resolve(row[1]), parent: resolve(row[2]), request: resolve(row[3]) } : { kind: 'load', url: resolve(row[1]) };
    },
  };
}
