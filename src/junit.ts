import { XMLParser, XMLValidator } from 'fast-xml-parser';

type Element = { name: string; attrs: Record<string, string>; children: Element[] };
export type JunitResult = { passed: boolean; detail: string };

// Decode exactly one XML reference layer. In the pinned parser, processEntities
// alone leaves numeric references untouched; HTML mode expands extra named
// entities too. Keeping this small XML-only decoder avoids both behaviors.
function xmlReferences(value: string): string {
  return value.replace(/&([^&;]*);/g, (_, reference: string) => {
    const predefined: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, reference)) return predefined[reference];
    if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(reference)) throw new Error('Unsupported XML entity reference: &' + reference + ';');
    const code = reference.startsWith('#x') ? Number.parseInt(reference.slice(2), 16) : Number(reference.slice(1));
    if (![9, 10, 13].includes(code) && !(code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) throw new Error('Invalid XML character reference');
    return String.fromCodePoint(code);
  });
}

/** Shared strict parser for acceptance and diagnostic perturbations. */
export function parseJunitXml(xml: string): unknown {
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('JUnit DTD and entity declarations are forbidden');
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error(`Malformed JUnit XML: ${validation.err.msg}`);
  return new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, parseAttributeValue: false,
    processEntities: false, attributeValueProcessor: (_name, value) => xmlReferences(value), tagValueProcessor: (_name, value) => xmlReferences(value) }).parse(xml);
}

/** Strict supported JUnit subset; no DTD/entity expansion or project code. */
export function checkJunit(xml: string, expected: string[]): JunitResult {
  const ordered = parseJunitXml(xml);
  let count = 0;
  function elements(value: unknown, depth = 0): Element[] {
    if (!Array.isArray(value) || depth > 64) throw new Error('JUnit structure is invalid or too deeply nested');
    const result: Element[] = [];
    for (const entry of value as Record<string, unknown>[]) {
      for (const name of Object.keys(entry).filter(k => k !== ':@')) {
        if (name === '#text' || name.startsWith('?') || name === '#comment') continue;
        if (++count > 20_000) throw new Error('JUnit element limit exceeded');
        result.push({ name, attrs: (entry[':@'] ?? {}) as Record<string, string>, children: elements(entry[name], depth + 1) });
      }
    }
    return result;
  }
  const roots = elements(ordered);
  if (roots.length !== 1 || !['testsuite', 'testsuites'].includes(roots[0].name)) throw new Error('JUnit requires exactly one testsuite or testsuites root');
  const names: string[] = [];
  const identities = new Set<string>();
  const issues: string[] = [];
  function visit(suite: Element) {
    const start = names.length;
    for (const child of suite.children) {
      if (child.name === 'testsuite') visit(child);
      else if (child.name === 'testcase') {
        const name = child.attrs.name;
        if (typeof name !== 'string' || !name.trim()) throw new Error('JUnit testcase needs a nonempty name');
        const identity = `${child.attrs.classname ?? ''}\0${name}`;
        if (identities.has(identity)) issues.push(`Duplicate testcase: ${name}`);
        identities.add(identity); names.push(name);
        if (child.children.some(c => ['failure', 'error', 'skipped'].includes(c.name))) issues.push(`Failed, errored or skipped testcase: ${name}`);
        if (child.attrs.status && !['run', 'passed'].includes(child.attrs.status)) issues.push(`Unsupported testcase status: ${name} (${child.attrs.status})`);
        if (child.children.some(c => !['failure', 'error', 'skipped', 'system-out', 'system-err', 'properties'].includes(c.name))) throw new Error(`Unsupported testcase element in ${name}`);
      } else if (!['properties', 'system-out', 'system-err'].includes(child.name)) throw new Error(`Unsupported JUnit suite element: ${child.name}`);
    }
    for (const key of ['tests', 'failures', 'errors', 'skipped', 'disabled']) {
      if (suite.attrs[key] === undefined) continue;
      if (!/^\d+$/.test(suite.attrs[key])) throw new Error(`Invalid JUnit ${key} count`);
      const total = Number(suite.attrs[key]);
      if (key === 'tests' ? total !== names.length - start : total > 0) issues.push(`Suite ${key}=${total} disagrees with passing testcase evidence`);
    }
  }
  visit(roots[0]);
  if (!names.length) issues.push('JUnit report contains no testcases');
  for (const name of expected) {
    const matches = names.filter(n => n === name).length;
    if (matches !== 1) issues.push(`Expected testcase ${name}: found ${matches} (use globally unique testcase names)`);
  }
  return { passed: issues.length === 0, detail: issues.length ? issues.slice(0, 8).join('; ') : `${names.length} JUnit testcases passed; all ${expected.length} expected cases present` };
}
