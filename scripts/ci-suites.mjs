// Every compiled integration file belongs to exactly one default macOS job.
export const INSTALL_FILES = ['install.test.js', 'staged-install.test.js'];
export function integrationSuites(files) {
  if (!files.length || new Set(files).size !== files.length || files.some(f => !/^[\w.-]+\.test\.js$/.test(f))) throw new Error('Invalid integration file inventory');
  if (INSTALL_FILES.some(f => !files.includes(f))) throw new Error('An installation integration file is missing; review the CI partition');
  const all = [...files].sort();
  return { all, core: all.filter(f => !INSTALL_FILES.includes(f)), install: all.filter(f => INSTALL_FILES.includes(f)) };
}

// Commands retain their original arguments, preparation order and experiment limits.
export const SCENARIOS = {
  local: [['environment:verify'], ['maintenance:verify'], ['success:verify'], ['protection:verify'], ['demo:read']],
  projects: [['examples:prepare'], ['onboarding:verify', '--', '--live'], ['observe:verify'], ['compile:verify'], ['bundle:verify'], ['examples:verify'], ['self:verify']],
  upstream: [['third-party:prepare'], ['third-party:verify'], ['regression:prepare'], ['regression:verify']],
  install: [['install:verify'], ['stages:verify']],
};
export function scenarioCommands(suite) {
  const selected = suite === 'all' ? Object.keys(SCENARIOS) : [suite];
  if (selected.some(s => !Object.hasOwn(SCENARIOS, s))) throw new Error('Unknown scenario suite');
  return selected.flatMap(s => SCENARIOS[s].map(args => ['npm', 'run', ...args]));
}
