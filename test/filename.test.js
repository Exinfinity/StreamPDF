import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FALLBACK_NAME,
  MAX_NAME_CODE_POINTS,
  clampCodePoints,
  sanitizeDisplayText,
  sanitizeDocumentName,
  stripUnsafeCharacters,
} from '../server/filename.js';

test('sanitizeDocumentName strips control and bidi characters', () => {
  assert.equal(sanitizeDocumentName('report\u0000\u202e.pdf'), 'report.pdf');
  assert.equal(sanitizeDocumentName('  quarterly\u2066 report  '), 'quarterly report');
});

test('sanitizeDocumentName removes filesystem metacharacters and headers quotes', () => {
  assert.equal(sanitizeDocumentName('../etc/passwd'), '.._etc_passwd');
  assert.equal(sanitizeDocumentName('a"b\\c:d*e?f<g>h|i.pdf'), 'a_b_c_d_e_f_g_h_i.pdf');
});

test('sanitizeDocumentName falls back for empty or dot-only names', () => {
  assert.equal(sanitizeDocumentName(''), FALLBACK_NAME);
  assert.equal(sanitizeDocumentName('...'), FALLBACK_NAME);
  assert.equal(sanitizeDocumentName('  '), FALLBACK_NAME);
  assert.equal(sanitizeDocumentName(null), FALLBACK_NAME);
});

test('sanitizeDocumentName bounds the code-point length', () => {
  const longName = 'a'.repeat(MAX_NAME_CODE_POINTS + 100);
  assert.equal([...sanitizeDocumentName(longName)].length, MAX_NAME_CODE_POINTS);
  // Multi-byte code points must not be cut in half.
  const emoji = '😀'.repeat(20);
  assert.equal(sanitizeDocumentName(emoji), emoji);
});

test('sanitizeDisplayText keeps URLs readable but strips spoofing characters', () => {
  assert.equal(
    sanitizeDisplayText('example.com/a\u202eb\u0000.pdf'),
    'example.com/ab.pdf',
  );
  assert.equal([...sanitizeDisplayText('x'.repeat(1000), { max: 10 })].length, 10);
});

test('clampCodePoints and stripUnsafeCharacters handle non-strings', () => {
  assert.equal(clampCodePoints('abcdef', 3), 'abc');
  assert.equal(stripUnsafeCharacters(undefined), '');
});
