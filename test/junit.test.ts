import test from 'node:test';
import assert from 'node:assert/strict';
import { checkJunit } from '../src/junit.js';

test('JUnit supports nested suites, classname identities and predefined entities', () => {
  const xml = '<?xml version="1.0"?><testsuites tests="2"><testsuite tests="2" failures="0"><testcase classname="unit" name="one &amp; two"/><testsuite tests="1"><testcase name="another"/></testsuite></testsuite></testsuites>';
  assert.equal(checkJunit(xml, ['one & two', 'another']).passed, true);
});
test('JUnit fails closed on missing, skipped, failed, errored, duplicate and empty tests', () => {
  for (const body of ['', '<testcase name="other"/>', '<testcase name="a"><failure/></testcase>', '<testcase name="a"><error/></testcase>', '<testcase name="a"><skipped/></testcase>', '<testcase name="a"/><testcase name="a"/>']) {
    assert.equal(checkJunit(`<testsuite>${body}</testsuite>`, ['a']).passed, false, body);
  }
  assert.equal(checkJunit('<testsuite failures="1"><testcase name="a"/></testsuite>', ['a']).passed, false);
  assert.equal(checkJunit('<testsuite tests="2"><testcase name="a"/></testsuite>', ['a']).passed, false);
  assert.equal(checkJunit('<testsuite><testcase name="a" status="notrun"/></testsuite>', ['a']).passed, false);
});
test('JUnit rejects malformed XML, unexpected roots, DTDs, entities and excessive depth', () => {
  for (const xml of ['<testsuite>', '<other/>', '<testsuite/><testsuite/>', '<!DOCTYPE testsuite SYSTEM "file:///etc/passwd"><testsuite/>', '<!DOCTYPE testsuite [<!ENTITY x "boom">]><testsuite/>', '<testsuite tests="abc"/>', '<testsuite><unknown/></testsuite>', '<testsuite>'.repeat(70) + '</testsuite>'.repeat(70)]) {
    assert.throws(() => checkJunit(xml, ['a']), Error, xml.slice(0, 80));
  }
});
