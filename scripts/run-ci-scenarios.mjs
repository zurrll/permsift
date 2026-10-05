import { scenarioCommands } from './ci-suites.mjs';
import { runCommands } from './ci-runner.mjs';
const [suite = 'all', ...rest] = process.argv.slice(2);
if (rest.length) throw new Error('Usage: run-ci-scenarios.mjs [all|local|projects|upstream|install]');
process.exitCode = await runCommands('scenarios-' + suite, scenarioCommands(suite), { suite, scope: 'extended_scenarios_not_default_regression' });
