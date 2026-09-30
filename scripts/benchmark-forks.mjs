import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { forkSnapshot } from '../dist/src/filesystem.js';

// Synthetic dependencies plus a large asset. This is a local observation,
// not a guarantee for a different filesystem or a real project.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-fork-bench-')));
try {
  const source = path.join(root, 'input');
  await fs.mkdir(path.join(source, 'node_modules/pkg'), { recursive: true });
  const small = Buffer.alloc(64 * 1024, 65), large = Buffer.alloc(128 * 1024 * 1024, 66);
  for (let i = 0; i < 2048; i++) await fs.writeFile(path.join(source, 'node_modules/pkg', `${i}.js`), small);
  await fs.writeFile(path.join(source, 'asset.bin'), large);
  const samples = [];
  for (let i = 0; i < 3; i++) for (const kind of i % 2 ? ['clone', 'copy'] : ['copy', 'clone']) {
    const destination = path.join(root, `${kind}-${i}`), start = performance.now();
    const fork = kind === 'clone' ? await forkSnapshot(source, destination) : undefined;
    if (!fork) await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
    samples.push({ kind, duration_ms: Math.round(performance.now() - start), strategy: fork?.strategy ?? 'previous-node-copy' });
    const handle = await fs.open(path.join(destination, 'asset.bin'), 'r+');
    await handle.write(Buffer.from('changed')); await handle.close();
    assert.equal((await fs.readFile(path.join(source, 'asset.bin')))[0], 66);
    await fs.rm(path.join(destination, 'node_modules'), { recursive: true });
    assert.equal((await fs.readdir(path.join(source, 'node_modules/pkg'))).length, 2048);
    await fs.rm(destination, { recursive: true });
  }
  const median = kind => samples.filter(s => s.kind === kind).map(s => s.duration_ms).sort((a,b) => a-b)[1];
  const summary = { platform: process.platform, node: process.version, files: 2049, logical_bytes: small.length * 2048 + large.length,
    samples, median_copy_ms: median('copy'), median_clone_ms: median('clone'), isolation_verified: true,
    note: 'Measures workspace materialization only. Traversal, hashing, execution and deletion remain; cp may fall back on unsupported filesystems.' };
  await fs.mkdir('.permsift', { recursive: true });
  await fs.writeFile('.permsift/fork-benchmark.json', JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
