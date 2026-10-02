import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Explicitly selected artifact only. References inside it are never followed. */
export async function readLegacyJson(file: string): Promise<unknown> {
  const limit = 32_000_000;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Model artifact must be a regular JSON file at most 32 MB');
    const chunks: Buffer[] = []; let total = 0;
    while (total <= limit) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead; chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total > limit) throw new Error('Model artifact exceeds 32 MB');
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } finally { await handle.close(); }
}
