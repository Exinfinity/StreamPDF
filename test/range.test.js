import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRangeHeader } from '../server/range.js';

test('parseRangeHeader returns null when there is no Range header', () => {
  assert.equal(parseRangeHeader(undefined, 100), null);
  assert.equal(parseRangeHeader('', 100), null);
});

test('parseRangeHeader parses closed, open and suffix ranges', () => {
  assert.deepEqual(parseRangeHeader('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRangeHeader('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRangeHeader('bytes=-10', 100), { start: 90, end: 99 });
});

test('parseRangeHeader clamps end to the file size', () => {
  assert.deepEqual(parseRangeHeader('bytes=90-1000', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRangeHeader('bytes=-1000', 100), { start: 0, end: 99 });
});

test('parseRangeHeader rejects invalid and multi-range requests', () => {
  assert.deepEqual(parseRangeHeader('items=0-1', 100), { invalid: true });
  assert.deepEqual(parseRangeHeader('bytes=0-1,4-5', 100), { invalid: true });
  assert.deepEqual(parseRangeHeader('bytes=10-5', 100), { invalid: true });
  assert.deepEqual(parseRangeHeader('bytes=-0', 100), { invalid: true });
  assert.deepEqual(parseRangeHeader('bytes=abc-def', 100), { invalid: true });
});

test('parseRangeHeader marks out-of-bounds ranges as unsatisfiable', () => {
  assert.deepEqual(parseRangeHeader('bytes=100-', 100), { unsatisfiable: true });
  assert.deepEqual(parseRangeHeader('bytes=999-1000', 100), { unsatisfiable: true });
  assert.deepEqual(parseRangeHeader('bytes=0-1', 0), { unsatisfiable: true });
});
