import * as fs from 'node:fs/promises';
import path from 'node:path';
import { integrationSuites } from './ci-suites.mjs';
import { runCommands } from './ci-runner.mjs';

const args = process.argv.slice(2), suite = args[0] ?? 'all';
if (args.length > 2 || args[1] !== undefined && args[1] !== '--list') throw new Error('Usage: run-integration.mjs [all|core|install] [--list]');
const entries = (await fs.readdir('dist/test/integration', { withFileTypes: true })).filter(e => e.name.endsWith('.test.js'));
if (entries.some(e => !e.isFile())) throw new Error('Integration inventory contains a non-regular test file');
const suites = integrationSuites(entries.map(e => e.name));
if (!Object.hasOwn(suites, suite)) throw new Error('Unknown integration suite');
const selection = { suite, files: suites[suite], all_files: suites.all };
if (args[1] === '--list') console.log(JSON.stringify(selection, null, 2));
else process.exitCode = await runCommands('integration-' + suite,
  [[process.execPath, '--test', '--test-concurrency=1', ...suites[suite].map(f => path.join('dist/test/integration', f))]], selection);
