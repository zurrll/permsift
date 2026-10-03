// A local source archive; no npm publishing, dependencies, or saved experiments.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { sourceManifest, verifySource, sha256, digest, writeJson, json } from './lib/trial-support.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { output: { type: 'string' } } });
const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trimEnd();
// Read current bytes of tracked/indexed files, including staged new sources.
// Untracked files are never picked up implicitly.
let exported;
try { await fs.access(path.join(repository, '.git')); } catch (e) {
  if (e.code !== 'ENOENT') throw e;
  exported = await json(path.join(repository, 'TRIAL-MANIFEST.json'));
  await verifySource(repository, exported);
}
const files = exported ? exported.files.map(f => f.path) : git('ls-files', '-z', '--cached').split('\0').filter(Boolean);
const manifest = { schema_version: 1, kind: 'permsift_source_trial', version: (await json(path.join(repository, 'package.json'))).version,
  created_at: new Date().toISOString(), git_revision: exported?.git_revision ?? git('rev-parse', 'HEAD'), git_status: exported?.git_status ?? git('status', '--porcelain'), files: await sourceManifest(repository, files) };
manifest.source_sha256 = sha256(JSON.stringify(manifest.files));
const root = values.output ? path.resolve(values.output) : (await fs.mkdir(path.join(repository, '.permsift'), { recursive: true }), await fs.mkdtemp(path.join(repository, '.permsift/trial-bundle-')));
if (values.output) await fs.mkdir(root); // Refuse to overwrite an existing destination.
const copy = path.join(root, 'permsift'); await fs.mkdir(copy);
for (const file of manifest.files) {
  const target = path.join(copy, file.path); await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(repository, file.path), target); await fs.chmod(target, file.mode);
}
await verifySource(copy, manifest); await writeJson(path.join(copy, 'TRIAL-MANIFEST.json'), manifest);
const archive = path.join(root, `permsift-${manifest.version}-trial.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', root, 'permsift'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
await writeJson(path.join(root, 'bundle.json'), { archive, archive_sha256: await digest(archive), source_sha256: manifest.source_sha256,
  git_revision: manifest.git_revision, git_status: manifest.git_status, files: manifest.files.length });
console.log(archive);
