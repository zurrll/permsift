import path from 'node:path';
import type { Check } from './assertions.js';
import type { ProcessResult } from './process.js';
import { within, type Roots } from './filesystem.js';

export type Denial = { source: 'sandbox_log' | 'stderr'; operation: string; path?: string; detail: string };
export type Diagnosis = {
  stage?: 'install' | 'task';
  kind: 'passed' | 'execution_incomplete' | 'boundary_issue' | 'permission_denial_observed' | 'task_failed' | 'assertion_failure' | 'installation_verification_failure';
  summary: string; denials: Denial[]; failed_assertions: Check[]; boundary_issues: Check[];
  stderr_excerpt: string; log_limitations: string;
};
export function aliasForPath(file: string, roots: Roots): string {
  const absolute = path.resolve(roots.workspace, file);
  for (const [name, root] of Object.entries(roots)) if (within(root, absolute)) {
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    return `@${name}${relative ? '/' + relative : ''}`;
  }
  return file;
}
export function extractDenials(stderr: string, violations: { line: string }[], roots: Roots): Denial[] {
  const found: Denial[] = [];
  for (const event of violations) {
    const match = /\bdeny(?:\(\d+\))?\s+([a-z][a-z0-9-]*)(?:\s+([^\s{]+))?/i.exec(event.line);
    if (match) found.push({ source: 'sandbox_log', operation: match[1], ...(match[2] ? { path: match[1] === 'network-outbound' ? match[2] : match[2].startsWith('/') ? aliasForPath(match[2], roots) : undefined } : {}), detail: event.line.slice(0, 500) });
  }
  for (const line of stderr.split('\n')) {
    if (!/\b(EPERM|EACCES)\b|operation not permitted|permission denied/i.test(line)) continue;
    const match = /(?:permitted|denied),\s*([a-z]+)\s+['"]([^'"]+)['"]/i.exec(line);
    found.push({ source: 'stderr', operation: match?.[1] ?? 'unspecified', ...(match ? { path: aliasForPath(match[2], roots) } : {}), detail: line.slice(0, 500) });
  }
  return found.filter((item, i) => found.findIndex(other => other.source === item.source && other.operation === item.operation && other.path === item.path && other.detail === item.detail) === i).slice(0, 12);
}
export function diagnose(input: { task?: { process: ProcessResult; violations: { line: string }[] }; roots?: Roots; assertions: Check[]; boundaries: Check[]; verdict: string; reason?: string; installationChecks?: Check[] }): Diagnosis {
  const process = input.task?.process;
  const denials = process && input.roots ? extractDenials(process.stderr, input.task!.violations, input.roots) : [];
  const failed = input.assertions.filter(c => c.status !== 'pass');
  const boundary = input.boundaries.filter(c => c.status !== 'pass');
  let kind: Diagnosis['kind'] = 'passed';
  let summary = 'Task, fresh outputs and boundary checks passed.';
  if (input.verdict === 'unknown') { kind = 'execution_incomplete'; summary = input.reason ?? `Execution could not be verified (${process?.status ?? 'no task result'}).`; }
  else if (boundary.length) { kind = 'boundary_issue'; summary = 'A sandbox boundary or its control check failed; this policy is not acceptable.'; }
  else if (input.verdict !== 'pass' && input.installationChecks?.some(c => c.status !== 'pass')) { kind = 'installation_verification_failure'; summary = 'npm completed, but extracted bundled package metadata did not match the locked installation; the task was skipped.'; }
  else if (input.verdict !== 'pass' && process?.exit_code === 0) { kind = 'assertion_failure'; summary = 'The command finished, but its fresh output or expected test results did not satisfy the assertions.'; }
  else if (input.verdict !== 'pass' && denials.length) { kind = 'permission_denial_observed'; summary = 'The task failed verification and permission-denial evidence was observed. Review the operation, path, assertions and recovery together.'; }
  else if (input.verdict !== 'pass' && process?.exit_code !== 0) { kind = 'task_failed'; summary = `The task exited with ${process?.exit_code ?? 'no exit code'}; no attributable permission denial was captured.`; }
  else if (input.verdict !== 'pass') { kind = 'assertion_failure'; summary = 'The command finished, but its fresh output or expected test results did not satisfy the assertions.'; }
  return { kind, summary, denials, failed_assertions: failed, boundary_issues: boundary, stderr_excerpt: process?.stderr.slice(0, 1200) ?? '', log_limitations: 'Sandbox logs are best-effort and stderr is task-produced, not independently authenticated. Missing denial logs do not prove a non-permission failure; observed denials do not prove causation.' };
}
