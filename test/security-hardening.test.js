import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createApp } from '../server/app.js';
import { createLogger, silentLogger } from '../server/logger.js';
import { normalizeAllowedOrigins } from '../server/origin-guard.js';

const AUTH_TOKEN = 'test-access-token-0123456789';

/* ------------------------------------------------------- P2-1 Security headers */

test('sends the complete security header set (P2-1)', async () => {
  const previous = process.env.ENABLE_HSTS;
  delete process.env.ENABLE_HSTS;
  const context = await startApp();
  try {
    const response = await fetch(`${context.baseUrl}/`);
    assert.equal(response.status, 200);

    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-dns-prefetch-control'), 'off');
    assert.equal(response.headers.get('origin-agent-cluster'), '?1');
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('x-permitted-cross-domain-policies'), 'none');
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.match(response.headers.get('x-request-id') || '', /^[0-9a-f-]{36}$/);

    const permissions = response.headers.get('permissions-policy') || '';
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'browsing-topics=()']) {
      assert.ok(permissions.includes(feature), `missing ${feature}`);
    }

    const csp = response.headers.get('content-security-policy') || '';
    for (const directive of [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
    ]) {
      assert.ok(csp.includes(directive), `missing ${directive}`);
    }
    assert.doesNotMatch(csp, /'unsafe-eval'/);
    assert.doesNotMatch(csp, /'unsafe-inline'.*script-src|script-src[^;]*'unsafe-inline'/);

    assert.equal(response.headers.get('strict-transport-security'), null);
  } finally {
    if (previous === undefined) {
      delete process.env.ENABLE_HSTS;
    } else {
      process.env.ENABLE_HSTS = previous;
    }
    await context.cleanup();
  }
});

test('adds HSTS only when explicitly enabled', async () => {
  const previous = process.env.ENABLE_HSTS;
  process.env.ENABLE_HSTS = '1';
  const context = await startApp();
  try {
    const response = await fetch(`${context.baseUrl}/api/health`);
    assert.match(response.headers.get('strict-transport-security') || '', /max-age=31536000/);
  } finally {
    if (previous === undefined) {
      delete process.env.ENABLE_HSTS;
    } else {
      process.env.ENABLE_HSTS = previous;
    }
    await context.cleanup();
  }
});

/* --------------------------------------------------- P2-3 CSRF / Origin guard */

test('rejects cross-site state-changing requests (P2-3)', async () => {
  const context = await startApp();
  try {
    const crossSite = await api(context, '/api/documents', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: { source: 'path', value: '/etc/passwd' },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.error.code, 'CROSS_SITE_REQUEST');

    const fetchMeta = await api(context, '/api/documents', {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
      body: { source: 'path', value: '/etc/passwd' },
    });
    assert.equal(fetchMeta.status, 403);
    assert.equal(fetchMeta.body.error.code, 'CROSS_SITE_REQUEST');

    const opaqueOrigin = await api(context, '/api/documents', {
      method: 'POST',
      headers: { Origin: 'null' },
      body: { source: 'path', value: '/etc/passwd' },
    });
    assert.equal(opaqueOrigin.status, 403);
    assert.equal(opaqueOrigin.body.error.code, 'CROSS_SITE_REQUEST');

    const forgedOrigin = await api(context, '/api/documents', {
      method: 'POST',
      headers: { Origin: 'https://evil.example/path?x=1' },
      body: { source: 'path', value: '/etc/passwd' },
    });
    assert.equal(forgedOrigin.status, 403);

    const differentPort = await api(context, '/api/documents', {
      method: 'POST',
      headers: { Origin: `${context.baseUrl.replace(/:\d+$/, ':1')}` },
      body: { source: 'path', value: '/etc/passwd' },
    });
    assert.equal(differentPort.status, 403);

    const deleteCrossSite = await api(context, '/api/documents/not-a-real-id', {
      method: 'DELETE',
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(deleteCrossSite.status, 403);
    assert.equal(deleteCrossSite.body.error.code, 'CROSS_SITE_REQUEST');
  } finally {
    await context.cleanup();
  }
});

test('allows same-origin and non-browser requests', async () => {
  const context = await startApp();
  try {
    // Same-origin browser fetch: the guard passes, then the path-mode policy
    // rejects the payload.
    const sameOrigin = await api(context, '/api/documents', {
      method: 'POST',
      headers: { Origin: context.baseUrl, 'Sec-Fetch-Site': 'same-origin' },
      body: { source: 'path', value: '/etc/passwd' },
    });
    assert.equal(sameOrigin.status, 403);
    assert.equal(sameOrigin.body.error.code, 'LOCAL_FILES_DISABLED');

    // Server-to-server / curl requests carry no Origin and still need a token.
    const curl = await api(context, '/api/documents', {
      method: 'POST',
      body: { source: 'path', value: '/etc/passwd' },
    });
    assert.equal(curl.status, 403);
    assert.equal(curl.body.error.code, 'LOCAL_FILES_DISABLED');

    const sameOriginDelete = await api(context, '/api/documents/not-a-real-id', {
      method: 'DELETE',
      headers: { Origin: context.baseUrl },
    });
    // DELETE is intentionally idempotent for unknown sessions; the important
    // part is that the cross-site guard did not block it.
    assert.equal(sameOriginDelete.status, 204);

    // Read-only methods are exempt from the cross-site check: browsers cannot
    // read the response without CORS, and the API still requires a token.
    const config = await api(context, '/api/config', {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(config.status, 200);
  } finally {
    await context.cleanup();
  }
});

test('accepts explicitly configured cross-origin frontends', async () => {
  const context = await startApp({ allowedOrigins: 'https://app.example.com' });
  try {
    const allowed = await api(context, '/api/documents', {
      method: 'POST',
      headers: { Origin: 'https://app.example.com', 'Sec-Fetch-Site': 'cross-site' },
      body: { source: 'path', value: '/etc/passwd' },
    });
    assert.equal(allowed.status, 403);
    assert.equal(allowed.body.error.code, 'LOCAL_FILES_DISABLED');

    const other = await api(context, '/api/documents', {
      method: 'POST',
      headers: { Origin: 'https://other.example.com' },
      body: { source: 'path', value: '/etc/passwd' },
    });
    assert.equal(other.status, 403);
    assert.equal(other.body.error.code, 'CROSS_SITE_REQUEST');
  } finally {
    await context.cleanup();
  }
});

test('normalizes ALLOWED_ORIGINS strictly', () => {
  assert.deepEqual(
    [...normalizeAllowedOrigins('https://APP.example.com, http://localhost:8080')].sort(),
    ['http://localhost:8080', 'https://app.example.com'],
  );
  for (const value of [
    '*',
    'app.example.com',
    'https://app.example.com/path',
    'https://app.example.com?x=1',
    'https://user:pass@app.example.com',
    'ftp://app.example.com',
  ]) {
    assert.throws(() => normalizeAllowedOrigins(value), /ALLOWED_ORIGINS/);
  }
});

/* --------------------------------------------------------- P3 metrics surface */

test('metrics endpoint is opt-in, authenticated and non-cacheable', async () => {
  const disabled = await startApp();
  try {
    const notFound = await api(disabled, '/api/metrics');
    assert.equal(notFound.status, 404);
  } finally {
    await disabled.cleanup();
  }

  const context = await startApp({ enableMetrics: true });
  try {
    const noAuth = await api(context, '/api/metrics', { token: null });
    assert.equal(noAuth.status, 401);

    const opened = await api(context, '/api/config');
    assert.equal(opened.status, 200);

    const failedOpen = await api(context, '/api/documents', {
      method: 'POST',
      body: { source: 'url', value: 'http://169.254.169.254/blocked.pdf' },
    });
    assert.equal(failedOpen.status, 403);

    await api(context, '/api/config', { token: 'wrong-token-1234567890' });

    const response = await fetch(`${context.baseUrl}/api/metrics`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') || '', /no-store/);

    const { metrics } = await response.json();
    assert.ok(metrics.requests >= 4);
    assert.equal(metrics.documents, 0);
    assert.ok(metrics.documentsOpenFailed >= 1);
    assert.ok(metrics.upstreamFailures >= 1);
    assert.ok(metrics.authFailures >= 1);
    assert.ok(metrics.responses4xx >= 2);
    assert.equal(metrics.responses5xx, 0);
    assert.equal(typeof metrics.uptimeSeconds, 'number');
  } finally {
    await context.cleanup();
  }
});

/* ------------------------------------------------------ P3 Log redaction E2E */

test('server logs never contain URL secrets, bearer tokens or failed guesses', async () => {
  const lines = [];
  const logger = createLogger({
    level: 'debug',
    sink: (line) => lines.push(line),
  });
  const context = await startApp({ logger });
  const secret = 'SUPER_SECRET_QUERY_TOKEN_1234';

  try {
    await api(context, '/api/documents', {
      method: 'POST',
      headers: { Origin: context.baseUrl },
      body: {
        source: 'url',
        value: `http://127.0.0.1/private.pdf?token=${secret}#page=2`,
      },
    });

    await api(context, '/api/config', { token: 'wrong-token-SUPER-SECRET' });
  } finally {
    await context.cleanup();
  }

  const joined = lines.join('\n');
  assert.match(joined, /document\.open_failed/);
  assert.doesNotMatch(joined, new RegExp(secret));
  assert.doesNotMatch(joined, /wrong-token-SUPER-SECRET/);
  assert.doesNotMatch(joined, /Bearer [A-Za-z0-9]/);
  assert.doesNotMatch(joined, /#page=2/);
});

/* ---------------------------------------------------------------- Helpers */

async function startApp(options = {}) {
  const created = createApp({
    authToken: AUTH_TOKEN,
    logger: silentLogger(),
    metricsLogIntervalMs: 0,
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
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async cleanup() {
      created.stop?.();
      await created.store.cleanupAll();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function api(context, route, { method = 'GET', body, token = AUTH_TOKEN, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (body) {
    requestHeaders['Content-Type'] = 'application/json';
  }
  if (token !== null) {
    requestHeaders.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${context.baseUrl}${route}`, {
    method,
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  if (response.status !== 204) {
    parsed = await response.json().catch(() => null);
  }
  return { status: response.status, body: parsed, headers: response.headers };
}
