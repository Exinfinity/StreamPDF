import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { createApp } from '../server/app.js';
import { silentLogger } from '../server/logger.js';
import {
  isLoopbackHostname,
  normalizeAllowedHosts,
  parseHostHeader,
} from '../server/host.js';

const AUTH_TOKEN = 'test-access-token-0123456789';

test('parses and normalizes Host headers', () => {
  assert.equal(parseHostHeader('pdf.example.com'), 'pdf.example.com');
  assert.equal(parseHostHeader('PDF.EXAMPLE.COM:8443'), 'pdf.example.com');
  assert.equal(parseHostHeader('pdf.example.com.'), 'pdf.example.com');
  assert.equal(parseHostHeader('[::1]:3000'), '::1');
  assert.equal(parseHostHeader('[2001:db8::1]'), '2001:db8::1');
  assert.equal(parseHostHeader('127.0.0.1:3000'), '127.0.0.1');

  assert.equal(parseHostHeader(''), null);
  assert.equal(parseHostHeader('evil.example/path'), null);
  assert.equal(parseHostHeader('evil.example:bad'), null);
  assert.equal(parseHostHeader('evil.example:0'), null);
  assert.equal(parseHostHeader('[::1'), null);
  assert.equal(parseHostHeader('2001:db8::1'), null);
  assert.equal(parseHostHeader('user@evil.example'), null);
  assert.equal(parseHostHeader('pdf.example.com', ['Host', 'a', 'Host', 'b']), null);
});

test('detects loopback hostnames', () => {
  for (const hostname of ['localhost', 'LOCALHOST.', '127.0.0.1', '127.0.0.2', '::1', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopbackHostname(hostname), true, hostname);
  }
  for (const hostname of ['example.com', '10.0.0.1', '192.168.1.1', '::2', '']) {
    assert.equal(isLoopbackHostname(hostname), false, hostname);
  }
});

test('rejects wildcard, URL and malformed ALLOWED_HOSTS entries', () => {
  assert.deepEqual([...normalizeAllowedHosts('pdf.example.com, PDF.EXAMPLE.COM:8443')].sort(), [
    'pdf.example.com',
  ]);
  for (const value of ['*', 'https://pdf.example.com', 'pdf.example.com/path', 'bad host']) {
    assert.throws(() => normalizeAllowedHosts(value), /ALLOWED_HOSTS/);
  }
});

test('rejects unlisted Host headers before routing (P1-1)', async () => {
  const context = await startApp({ allowedHosts: 'pdf.example.com' });
  try {
    const rebound = await requestWithHost(context, '/api/health', 'evil.example:3000');
    assert.equal(rebound.status, 421);
    assert.equal(rebound.body, 'Misdirected Request');

    const suffix = await requestWithHost(context, '/api/health', 'pdf.example.com.evil.example');
    assert.equal(suffix.status, 421);

    const allowed = await requestWithHost(context, '/api/health', 'pdf.example.com');
    assert.equal(allowed.status, 200);
    assert.deepEqual(JSON.parse(allowed.body), { ok: true });

    const allowedWithPort = await requestWithHost(context, '/api/health', 'PDF.EXAMPLE.COM:8443');
    assert.equal(allowedWithPort.status, 200);

    // Loopback aliases stay usable for local health checks.
    const loopback = await requestWithHost(context, '/api/health', '127.0.0.1');
    assert.equal(loopback.status, 200);

    // The guard also protects API routes, not just the health endpoint.
    const api = await requestWithHost(context, '/api/config', 'evil.example');
    assert.equal(api.status, 421);
  } finally {
    await context.cleanup();
  }
});

test('default Host allowlist accepts loopback and rejects attacker hosts', async () => {
  const context = await startApp();
  try {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const response = await requestWithHost(context, '/api/health', host);
      assert.equal(response.status, 200, host);
    }
    const response = await requestWithHost(context, '/api/health', 'attacker.example');
    assert.equal(response.status, 421);
  } finally {
    await context.cleanup();
  }
});

async function startApp(options = {}) {
  const created = createApp({
    authToken: AUTH_TOKEN,
    logger: silentLogger(),
    documentRateLimit: false,
    contentRateLimit: false,
    deleteRateLimit: false,
    authFailureRateLimit: false,
    ...options,
  });
  const server = created.app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    ...created,
    server,
    async cleanup() {
      created.stop?.();
      await created.store.cleanupAll();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function requestWithHost(context, path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: context.server.address().port,
        path,
        method: 'GET',
        headers: { Host: host },
        setHost: false,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
