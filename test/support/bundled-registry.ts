import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** One real tarball contains a scoped dependency and its hoisted transitive. */
export async function bundledRegistry(options: { directory?: string; material?: 'valid' | 'missing' | 'wrong-version' | 'wrong-declaration' } = {}) {
  const root = options.directory ?? await fs.mkdtemp(path.join(os.tmpdir(), 'permsift-bundled-registry-'));
  const project = path.join(root, 'project'), tarRoot = path.join(root, 'tar'), parent = path.join(tarRoot, 'package');
  await fs.mkdir(project, { recursive: true });
  const writePackage = async (directory: string, value: Record<string, unknown>, source: string) => {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ ...value, main: 'index.js', scripts: { postinstall: 'node -e "require(\'node:fs\').writeFileSync(\'SCRIPT_RAN\',\'bad\')"' } }));
    await fs.writeFile(path.join(directory, 'index.js'), source);
  };
  await writePackage(parent, { name: 'parent', version: '1.0.0', dependencies: { '@scope/child': '1.0.0' },
    bundleDependencies: options.material === 'wrong-declaration' ? [] : ['@scope/child'] }, "module.exports=require('@scope/child');");
  if (options.material !== 'missing') await writePackage(path.join(parent, 'node_modules/@scope/child'),
    { name: '@scope/child', version: options.material === 'wrong-version' ? '9.0.0' : '1.0.0', dependencies: { shared: '2.0.0' } }, "module.exports=require('shared')+1;");
  await writePackage(path.join(parent, 'node_modules/shared'), { name: 'shared', version: '2.0.0' }, 'module.exports=42;');
  const archive = path.join(root, 'parent.tgz');
  await promisify(execFile)('/usr/bin/tar', ['-czf', archive, '-C', tarRoot, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const bytes = await fs.readFile(archive), integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!); res.writeHead(req.url === '/parent.tgz' ? 200 : 404, { 'content-type': 'application/octet-stream' });
    res.end(req.url === '/parent.tgz' ? bytes : 'Not found');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const registry = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const lock = { name: 'bundled-project', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'bundled-project', version: '1.0.0', dependencies: { parent: '1.0.0' } },
    'node_modules/parent': { version: '1.0.0', resolved: registry + 'parent.tgz', integrity, hasInstallScript: true,
      dependencies: { '@scope/child': '1.0.0' }, bundleDependencies: ['@scope/child'] },
    'node_modules/parent/node_modules/@scope/child': { version: '1.0.0', inBundle: true, hasInstallScript: true, dependencies: { shared: '2.0.0' } },
    'node_modules/parent/node_modules/shared': { version: '2.0.0', inBundle: true, hasInstallScript: true },
  } };
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ ...lock.packages[''], private: true }));
  await fs.writeFile(path.join(project, 'verify.cjs'), `const assert=require('node:assert/strict'),fs=require('node:fs');
assert.equal(require('parent'),43);
for(const p of ['node_modules/parent','node_modules/parent/node_modules/@scope/child','node_modules/parent/node_modules/shared'])assert.equal(fs.existsSync(p+'/SCRIPT_RAN'),false);
fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/out.json',JSON.stringify({value:43}));`);
  const config = { schema_version: 1, project: './project', exclude: ['.git', 'node_modules', 'dist'], scenarios: [{
    id: 'build', install: { manager: 'npm', cache: 'cold', registry, initial_write_grants: ['@workspace/node_modules', '@cache', '@tmp'], auto_discover: false },
    initial_write_grants: ['@workspace/dist'], initial_read_grants: ['@workspace'], initial_network_grants: ['127.0.0.1'],
    auto_discover: false, auto_read_discover: false, timeout_seconds: 30, command: [process.execPath, 'verify.cjs'],
    assertions: [{ type: 'json_equals', path: '@workspace/dist/out.json', pointer: '/value', value: 43 }],
  }] };
  const limits = { schema_version: 1, allowed_write_roots: ['@workspace', '@cache', '@tmp'], allowed_read_roots: ['@workspace'],
    allowed_network_domains: ['127.0.0.1'], repetitions: 1, max_candidates: 0, budget_seconds: 120 };
  const configPath = path.join(root, 'config.json'), limitsPath = path.join(root, 'limits.json');
  const save = async () => {
    await fs.writeFile(path.join(project, 'package-lock.json'), JSON.stringify(lock));
    await fs.writeFile(configPath, JSON.stringify(config)); await fs.writeFile(limitsPath, JSON.stringify(limits));
  };
  await save();
  const close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return { root, project, configPath, limitsPath, config, limits, lock, requests, save, close };
}
