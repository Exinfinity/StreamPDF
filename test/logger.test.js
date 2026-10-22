import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLogger,
  normalizeLogLevel,
  redactText,
  redactUrl,
  sanitizeError,
  sanitizeFields,
  silentLogger,
  stripUnsafeControls,
} from '../server/logger.js';

test('redactUrl drops credentials, query strings and fragments', () => {
  assert.equal(
    redactUrl('https://user:secret@example.com:8443/a/b.pdf?token=abc#page=2'),
    'https://example.com:8443/a/b.pdf',
  );
  assert.equal(redactUrl('file:///etc/passwd'), '[url]');
  assert.equal(redactUrl('not a url'), '[invalid-url]');
});

test('redactText removes bearer tokens, control characters and absolute paths', () => {
  const redacted = redactText(
    "Authorization: Bearer abcdefghijklmnop1234 open '/home/alice/private/secret.pdf' \u202e spoof",
  );
  assert.doesNotMatch(redacted, /abcdefghijklmnop1234/);
  assert.doesNotMatch(redacted, /\/home\/alice/);
  assert.match(redacted, /secret\.pdf/);
  assert.doesNotMatch(redacted, /\u202e/);
});

test('stripUnsafeControls removes bidirectional overrides', () => {
  assert.equal(stripUnsafeControls('safe\u202ename\u2066x'), 'safenamex');
});

test('sanitizeFields redacts secret keys recursively but keeps safe values', () => {
  const circular = { safe: 'ok' };
  circular.self = circular;

  const sanitized = sanitizeFields({
    authorization: 'Bearer should-not-appear',
    cookie: 'session=1',
    nested: { token: 'nope', url: 'https://example.com/a?b=c', safe: 2 },
    list: [{ password: 'nope', value: 'fine' }],
    circular,
  });

  const json = JSON.stringify(sanitized);
  assert.doesNotMatch(json, /should-not-appear/);
  assert.doesNotMatch(json, /nope/);
  assert.doesNotMatch(json, /\?b=c/);
  assert.match(json, /"safe":2/);
  assert.match(json, /"value":"fine"/);
  assert.match(json, /\[redacted\]/);
  assert.match(json, /\[circular\]/);
});

test('sanitizeError never exposes stack traces or quoted absolute paths', () => {
  const error = new Error("ENOENT: no such file or directory, open '/srv/private/data.pdf'");
  error.code = 'ENOENT';
  error.status = 500;
  const sanitized = sanitizeError(error);

  assert.equal(sanitized.code, 'ENOENT');
  assert.equal(sanitized.status, 500);
  assert.match(sanitized.message, /data\.pdf/);
  assert.doesNotMatch(sanitized.message, /\/srv\/private/);
  assert.equal('stack' in sanitized, false);
});

test('logger writes structured JSON and honours the level threshold', () => {
  const lines = [];
  const logger = createLogger({
    level: 'info',
    sink: (line) => lines.push(JSON.parse(line)),
    now: () => new Date('2026-10-22T00:00:00.000Z'),
  });

  assert.equal(logger.debug('debug.event', { a: 1 }), false);
  assert.equal(logger.info('document.opened', { documentId: 'doc-1', url: 'https://x/y?q=1' }), true);

  assert.equal(lines.length, 1);
  assert.equal(lines[0].time, '2026-10-22T00:00:00.000Z');
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].event, 'document.opened');
  assert.equal(lines[0].documentId, 'doc-1');
  assert.equal(lines[0].url, 'https://x/y');
});

test('logging cannot crash the process when the sink throws', () => {
  const logger = createLogger({
    level: 'info',
    sink: () => {
      throw new Error('disk full');
    },
  });
  assert.doesNotThrow(() => logger.error('boom', { error: new Error('x') }));
});

test('silent logger emits nothing', () => {
  const lines = [];
  const logger = createLogger({ level: 'silent', sink: (line) => lines.push(line) });
  logger.error('should.not.appear');
  assert.equal(lines.length, 0);
  assert.equal(typeof silentLogger().info, 'function');
});

test('normalizeLogLevel falls back to info', () => {
  assert.equal(normalizeLogLevel('warn'), 'warn');
  assert.equal(normalizeLogLevel('TRACE'), 'info');
  assert.equal(normalizeLogLevel(undefined), 'info');
});
