import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadUsage, type Comparable } from './usage-report.js';
import { compareUsage, comparisonMarkdown, escape, type UsageComparison } from './usage-comparison.js';
import { VERSION } from './version.js';
import { publishSummary } from './result-output.js';

type Input = { file: string; status: Comparable['status']; version?: string; tasks: { task: string; verdict?: string;
  module_capture: string; compiler_capture: string; build_capture: string }[] };
export type OfflineComparison = { schema_version: 1; kind: 'dependency_usage_comparison'; version: string;
  status: 'compared' | 'partial'; before: Input; after: Input; comparison: UsageComparison };

export async function compareSavedUsage(beforeFile: string, afterFile: string): Promise<OfflineComparison> {
  const before = await loadUsage(beforeFile), after = await loadUsage(afterFile);
  const comparison = compareUsage(before, after, path.resolve(beforeFile));
  const input = (r: Comparable, file: string): Input => ({ file: path.resolve(file), status: r.status, version: r.version,
    tasks: r.tasks.map(t => ({ task: t.task, ...t.capture_status !== 'not_run' ? { verdict: t.verdict } : {}, module_capture: t.capture_status === 'not_run' ? 'not_run' : t.module_capture_status ?? t.capture_status,
      compiler_capture: t.capture_status === 'not_run' ? 'not_run' : t.compilation?.capture_status ?? 'not_collected',
      build_capture: t.capture_status === 'not_run' ? 'not_run' : t.bundling?.capture_status ?? 'not_collected' })) });
  const a = input(before, beforeFile), b = input(after, afterFile);
  const partial = [a, b].some(i => i.status !== 'observed' || i.tasks.some(t => t.verdict !== 'pass' || t.module_capture !== 'captured' ||
    [t.compiler_capture, t.build_capture].some(c => c !== 'captured' && c !== 'not_collected'))) ||
    comparison.tasks.some(t => t.state === 'unavailable' || t.compilation?.state === 'unavailable' || t.bundling?.state === 'unavailable');
  return { schema_version: 1, kind: 'dependency_usage_comparison', version: VERSION, status: partial ? 'partial' : 'compared', before: a, after: b, comparison };
}

export function offlineComparisonMarkdown(r: OfflineComparison): string {
  return ['# Permsift saved dependency comparison', '', `Analysis: **${r.status}**. No tasks executed. Differences do not mean a regression or successful permission validation.`, '',
    ...(['before', 'after'] as const).flatMap(side => [`${side}: ${escape(r[side].file)}; saved observation: ${r[side].status}.`,
      ...r[side].tasks.map(t => `- ${escape(t.task)}: outcome ${t.verdict ?? 'not_run'}; module ${t.module_capture}; compiler ${t.compiler_capture}; build ${t.build_capture}.`), '']),
    ...comparisonMarkdown(r.comparison)].join('\n');
}

export async function saveComparison(directory: string, report: OfflineComparison): Promise<void> {
  // Exclusive creation preserves existing files, including either input report.
  await fs.mkdir(path.dirname(path.resolve(directory)), { recursive: true });
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'comparison.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(directory, 'comparison.md'), offlineComparisonMarkdown(report), { flag: 'wx' });
  await publishSummary(path.join(directory, 'comparison.json'), path.join(directory, 'comparison.md'));
}
