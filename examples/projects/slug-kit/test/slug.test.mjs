import test from 'node:test';
import assert from 'node:assert/strict';
import { slug } from '../src/slug.mjs';

test('normalizes accents', () => assert.equal(slug('Café déjà vu'), 'cafe-deja-vu'));
test('collapses punctuation', () => assert.equal(slug('Hello,  World!'), 'hello-world'));
test('handles empty input', () => assert.equal(slug(''), ''));
