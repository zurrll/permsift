import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const full = reason => ({ sandbox: true, reason });
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);

/** A small documentation allowlist; unknown or mixed changes retain full coverage. */
export function classifyChangedPaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 10_000) return full('Empty or oversized change list');
  const documentation = name => typeof name === 'string' && !/[\u0000-\u001f\u007f]/.test(name) && !name.split('/').some(p => !p || p === '.' || p === '..') &&
    (['README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md'].includes(name) || /^docs\/.+\.md$/.test(name));
  return paths.every(documentation) ? { sandbox: false, reason: 'Documentation-only change; real sandbox tests are not required' } : full('Execution-related or unrecognized files changed');
}

export function classifyEvent(eventName, event, cwd = process.cwd()) {
  let range;
  if (eventName === 'push' && sha(event.before) && sha(event.after)) range = [event.before, event.after];
  else if (eventName === 'pull_request' && sha(event.pull_request?.base?.sha) && sha(event.pull_request?.head?.sha))
    range = [event.pull_request.base.sha + '...' + event.pull_request.head.sha];
  else return full('No trustworthy comparison range; retaining full sandbox coverage');
  // Disabling rename detection lists both old and new paths, so moving code into
  // docs cannot hide an execution-related deletion. No shell or fetched script.
  const result = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', ...range, '--'], { cwd, encoding: 'utf8', maxBuffer: 4_000_000 });
  if (result.error || result.status !== 0) return full('Cannot read the complete diff; retaining full sandbox coverage');
  return classifyChangedPaths(result.stdout.split('\0').filter(Boolean));
}

export function main(env = process.env) {
  let selection;
  try { selection = classifyEvent(env.GITHUB_EVENT_NAME, JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))); }
  catch { selection = full('Cannot read the event; retaining full sandbox coverage'); }
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  fs.appendFileSync(env.GITHUB_OUTPUT, `sandbox=${selection.sandbox}\n`);
  console.log(JSON.stringify(selection));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `Sandbox selection: ${selection.sandbox ? 'full regression' : 'documentation only'}\n\n${selection.reason}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
