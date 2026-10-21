import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRemotePolicy,
  isPublicAddress,
  parseRemoteUrl,
} from '../server/http-client.js';
import { HttpError } from '../server/errors.js';

test('isPublicAddress accepts only globally routable unicast addresses', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(address), true, address);
  }

  const blocked = [
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '100.100.100.200',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '2001::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ];
  for (const address of blocked) {
    assert.equal(isPublicAddress(address), false, address);
  }

  assert.equal(isPublicAddress('not-an-ip'), false);
});

test('parseRemoteUrl rejects credentials, bad schemes and disallowed ports', () => {
  const policy = createRemotePolicy({ allowedPorts: [80, 443] });

  assert.equal(parseRemoteUrl('https://example.com/book.pdf', policy).host, 'example.com');
  assert.equal(parseRemoteUrl('http://example.com:80/book.pdf', policy).port, '');

  assert.throws(
    () => parseRemoteUrl('http://user:pass@example.com/book.pdf', policy),
    (error) => error instanceof HttpError && error.code === 'URL_CREDENTIALS_NOT_ALLOWED',
  );
  assert.throws(
    () => parseRemoteUrl('file:///etc/passwd', policy),
    (error) => error instanceof HttpError && error.code === 'INVALID_URL_PROTOCOL',
  );
  assert.throws(
    () => parseRemoteUrl('https://example.com:8443/book.pdf', policy),
    (error) => error instanceof HttpError && error.code === 'URL_PORT_NOT_ALLOWED',
  );
});
