import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import type { Assertion } from './config.js';
import { testResultsSchema } from './assertions.js';

export type Mutation = { kind: string; description: string; content: string | undefined; intended: 'absence' | 'format' | 'content' | 'scope' };
const changedValue = (v: unknown) => v === null ? false : typeof v === 'boolean' ? !v : typeof v === 'string' ? v + '_permsift_changed' : typeof v === 'number' ? v === 0 ? 1 : 0 : null;
const xmlOptions = { preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, parseAttributeValue: false, processEntities: true };
type XmlNode = Record<string, unknown> & { ':@'?: Record<string, string> };
function junitMutation(content: string, kind: string, expected: string[]): string | undefined {
  const tree = new XMLParser(xmlOptions).parse(content) as XmlNode[];
  const cases: { parent: XmlNode[]; node: XmlNode; name: string }[] = [];
  function visit(nodes: XmlNode[]) {
    for (const node of nodes) for (const key of Object.keys(node)) {
      if (key === 'testcase') cases.push({ parent: nodes, node, name: node[':@']?.name ?? '' });
      else if (Array.isArray(node[key])) visit(node[key] as XmlNode[]);
    }
  }
  visit(tree);
  const chosen = kind === 'unexpected_failed' ? cases.find(c => !expected.includes(c.name)) : kind === 'remove_unexpected' ? cases.find(c => !expected.includes(c.name)) :
    ['remove_expected', 'rename_expected'].includes(kind) ? cases.find(c => expected.includes(c.name)) : cases[0];
  if (!chosen) return undefined;
  if (kind === 'remove_expected' || kind === 'remove_unexpected') chosen.parent.splice(chosen.parent.indexOf(chosen.node), 1);
  else if (kind === 'rename_expected') chosen.node[':@']!.name = uniqueName(cases.map(c => c.name));
  else if (kind === 'duplicate_test') chosen.parent.push(structuredClone(chosen.node));
  else (chosen.node.testcase as XmlNode[]).push({ failure: [{ '#text': 'Permsift diagnostic failure' }] });
  // Preserve report consistency: deletion/failure is tested independently of stale summary counts.
  function recount(nodes: XmlNode[]): { tests: number; failures: number; errors: number; skipped: number } {
    const sum = { tests: 0, failures: 0, errors: 0, skipped: 0 };
    for (const node of nodes) {
      if (Array.isArray(node.testcase)) {
        sum.tests++;
        for (const key of ['failure', 'error', 'skipped'] as const) if ((node.testcase as XmlNode[]).some(c => Object.hasOwn(c, key))) sum[key === 'failure' ? 'failures' : key === 'error' ? 'errors' : 'skipped']++;
      } else for (const key of ['testsuite', 'testsuites']) if (Array.isArray(node[key])) {
        const counts = recount(node[key] as XmlNode[]);
        for (const field of Object.keys(sum) as (keyof typeof sum)[]) {
          sum[field] += counts[field]; if (node[':@']?.[field] !== undefined) node[':@']![field] = String(counts[field]);
        }
      }
    }
    return sum;
  }
  recount(tree);
  return new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', processEntities: true }).build(tree) as string;
}
function uniqueName(names: string[]) { let name = '__permsift_renamed__'; while (names.includes(name)) name += '_'; return name; }
export function mutationsFor(content: string, assertions: Assertion[]): Mutation[] {
  const result: Mutation[] = [
    { kind: 'missing_file', description: 'Remove this artifact', content: undefined, intended: 'absence' },
    { kind: 'empty_file', description: 'Keep the artifact but clear its bytes', content: '', intended: assertions.some(a => ['json_equals', 'test_results', 'junit'].includes(a.type)) ? 'format' : 'content' },
  ];
  const seen = new Set<string>();
  const add = (m: Mutation) => { const key = JSON.stringify([m.kind, m.content]); if (!seen.has(key)) { seen.add(key); result.push(m); } };
  for (const a of assertions) {
    if (a.type === 'file_contains') {
      let removed = content.split(a.text).join('');
      // Joining fragments can recreate a match (aabb minus ab becomes ab).
      // The fallback clears bytes so the recorded perturbation really lacks the marker.
      if (removed.includes(a.text)) removed = '';
      add({ kind: 'remove_marker', description: 'Remove the checked text: ' + a.text.slice(0, 120), content: removed, intended: 'content' });
      if (content !== a.text) add({ kind: 'marker_only', description: 'Keep only the checked marker; this tests scope, not business correctness', content: a.text, intended: 'scope' });
    }
    if (a.type === 'json_equals') {
      try {
        const value: unknown = JSON.parse(content), parts = a.pointer.split('/').slice(1).map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'));
        let target = value;
        for (const key of parts.slice(0, -1)) target = target !== null && typeof target === 'object' && Object.hasOwn(target, key) ? (target as Record<string, unknown>)[key] : undefined;
        let modified: unknown = value;
        if (!parts.length) modified = changedValue(value);
        else if (target !== null && typeof target === 'object' && Object.hasOwn(target, parts.at(-1)!)) {
          Object.defineProperty(target, parts.at(-1)!, { value: changedValue((target as Record<string, unknown>)[parts.at(-1)!]), enumerable: true, configurable: true, writable: true });
        } else continue;
        add({ kind: 'change_json_value', description: 'Change the checked JSON value at ' + (a.pointer || '(root)'), content: JSON.stringify(modified), intended: 'content' });
      } catch { /* control evaluation reports invalid material; no synthetic semantic mutation */ }
    }
    if (a.type === 'test_results' || a.type === 'junit') {
      for (const kind of ['test_failed', 'remove_expected', 'rename_expected', 'duplicate_test', 'unexpected_failed', 'remove_unexpected']) {
        let modified: string | undefined;
        if (a.type === 'junit') modified = junitMutation(content, kind, a.expected_tests);
        else {
          const { tests } = testResultsSchema.parse(JSON.parse(content));
          const index = ['unexpected_failed', 'remove_unexpected'].includes(kind) ? tests.findIndex(t => !a.expected_tests.includes(t.name)) :
            ['remove_expected', 'rename_expected'].includes(kind) ? tests.findIndex(t => a.expected_tests.includes(t.name)) : 0;
          if (index < 0 || !tests[index]) continue;
          if (kind === 'remove_expected' || kind === 'remove_unexpected') tests.splice(index, 1);
          else if (kind === 'rename_expected') tests[index].name = uniqueName(tests.map(t => t.name));
          else if (kind === 'duplicate_test') tests.push({ ...tests[index] });
          else tests[index].status = 'failed';
          modified = JSON.stringify({ tests });
        }
        if (modified !== undefined) add({ kind, description: ({ test_failed: 'Change a reported passing test to failed', remove_expected: 'Remove a configured expected test', rename_expected: 'Rename a configured expected test', duplicate_test: 'Duplicate one test identity', unexpected_failed: 'Fail a test outside the expected-name list', remove_unexpected: 'Remove a test outside the expected-name list; scope observation' } as Record<string, string>)[kind], content: modified, intended: kind === 'remove_unexpected' ? 'scope' : 'content' });
      }
    }
  }
  return result;
}
