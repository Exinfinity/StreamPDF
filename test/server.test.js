import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server/app.js';
import { silentLogger } from '../server/logger.js';

const WORK_DIR = path.resolve('test-output', `integration-${process.pid}`);
const PDF_SIZE = 3 * 1024 * 1024 + 321;
const AUTH_TOKEN = 'test-access-token-0123456789';

let remote;
let payload;
let main;
let secure;
const extraContexts = [];

test.before(async () => {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  payload = Buffer.alloc(PDF_SIZE, 0x20);
  payload.write('%PDF-1.7\n', 0, 'latin1');
  payload.write('StreamPDF integration fixture\n', 11, 'latin1');
  payload.write('%%EOF\n', PDF_SIZE - 6, 'latin1');

  remote = await startRemoteFixture(payload);
  // Opt-in intranet mode: the fixture listens on loopback with a random port,
  // so this exercises private/loopback access with no port allowlist.
  main = await startApp({
    allowPrivateAddresses: true,
    documentRateLimit: false,
    contentRateLimit: false,
    deleteRateLimit: false,
  });
  // Default public-only mode, used to regression-test the strict SSRF policy.
  secure = await startApp({
    documentRateLimit: false,
    contentRateLimit: false,
    deleteRateLimit: false,
  });
});

test.after(async () => {
  for (const context of [main, secure, ...extraContexts]) {
    await context?.cleanup();
  }
  await closeServer(remote?.server);
  await fsp.rm(WORK_DIR, { recursive: true, force: true });
});

/* --------------------------------------------------------------- Authentication */

test('requires a bearer token for every document API', async () => {
  const health = await fetch(`${main.baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const configNoAuth = await api(main, '/api/config', { token: null });
  assert.equal(configNoAuth.status, 401);
  assert.match(configNoAuth.headers.get('www-authenticate') || '', /Bearer/);

  const configWrong = await api(main, '/api/config', { token: 'wrong-token-1234567890' });
  assert.equal(configWrong.status, 401);

  const createNoAuth = await api(main, '/api/documents', {
    method: 'POST',
    token: null,
    body: { source: 'url', value: `http://127.0.0.1:${remote.port}/range.pdf` },
  });
  assert.equal(createNoAuth.status, 401);
  assert.equal(createNoAuth.body.error.code, 'UNAUTHORIZED');

  const configOk = await api(main, '/api/config');
  assert.equal(configOk.status, 200);
  assert.ok(configOk.body.rangeChunkSize > 0);
  assert.equal('remoteMirrorLimit' in configOk.body, false);
});

test('rate limits repeated failed authentication attempts', async () => {
  const context = await startApp({
    authFailureRateLimit: { windowMs: 60_000, max: 2 },
    documentRateLimit: false,
    contentRateLimit: false,
    deleteRateLimit: false,
  });
  extraContexts.push(context);

  for (let index = 0; index < 2; index += 1) {
    const response = await api(context, '/api/config', { token: 'wrong-token-1234567890' });
    assert.equal(response.status, 401);
  }

  const limited = await api(context, '/api/config', { token: 'wrong-token-1234567890' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

/* ------------------------------------------------------------------ P0-1 LFI */

test('removes server-side path reads entirely', async () => {
  const pathSource = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'path', value: '/etc/passwd' },
  });
  assert.equal(pathSource.status, 403);
  assert.equal(pathSource.body.error.code, 'LOCAL_FILES_DISABLED');

  const autoSource = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'auto', value: '/etc/passwd' },
  });
  assert.equal(autoSource.status, 400);
  assert.equal(autoSource.body.error.code, 'INVALID_SOURCE');

  const plainPath = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: '/etc/passwd' },
  });
  assert.equal(plainPath.status, 400);
  assert.equal(plainPath.body.error.code, 'INVALID_URL');
});

/* ------------------------------------------------------------------ P0-2 SSRF */

test('opt-in intranet mode allows loopback/host targets on non-standard ports', async () => {
  const created = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.rangeUrl },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.document.size, PDF_SIZE);
  await api(main, `/api/documents/${created.body.document.id}`, { method: 'DELETE' });
});

test('opt-in intranet mode still blocks link-local, cloud metadata and reserved targets', async () => {
  for (const value of [
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/',
    'http://[fe80::1]/',
    'http://0.0.0.0/',
    'http://224.0.0.1/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/',
  ]) {
    const response = await api(main, '/api/documents', {
      method: 'POST',
      body: { source: 'url', value },
    });
    assert.equal(response.status, 403, `${value} should stay blocked in intranet mode`);
    assert.equal(response.body.error.code, 'REMOTE_ADDRESS_BLOCKED', value);
  }
});

test('default public-only mode blocks loopback, private, link-local and cloud metadata targets', async () => {
  const blocked = [
    'http://127.0.0.1/',
    'http://localhost/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.100.100.200/latest/meta-data/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://[::ffff:127.0.0.1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/',
  ];

  for (const value of blocked) {
    const response = await api(secure, '/api/documents', {
      method: 'POST',
      body: { source: 'url', value },
    });
    assert.equal(response.status, 403, `${value} should be blocked`);
    assert.equal(response.body.error.code, 'REMOTE_ADDRESS_BLOCKED', value);
  }
});

test('default public-only mode rejects disallowed ports, embedded credentials and unsafe schemes', async () => {
  const port = await api(secure, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: 'http://example.com:8080/book.pdf' },
  });
  assert.equal(port.status, 403);
  assert.equal(port.body.error.code, 'URL_PORT_NOT_ALLOWED');

  const credentials = await api(secure, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: 'http://user:pass@example.com/book.pdf' },
  });
  assert.equal(credentials.status, 400);
  assert.equal(credentials.body.error.code, 'URL_CREDENTIALS_NOT_ALLOWED');

  for (const value of ['file:///etc/passwd', 'ftp://example.com/book.pdf', 'gopher://example.com/']) {
    const response = await api(secure, '/api/documents', {
      method: 'POST',
      body: { source: 'url', value },
    });
    assert.equal(response.status, 400, value);
    assert.equal(response.body.error.code, 'INVALID_URL_PROTOCOL', value);
  }
});

test('revalidates every redirect hop', async () => {
  const toFile = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: `${remote.origin}/redirect-file` },
  });
  assert.equal(toFile.status, 400);
  assert.equal(toFile.body.error.code, 'INVALID_URL_PROTOCOL');

  const loop = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: `${remote.origin}/redirect-loop` },
  });
  assert.equal(loop.status, 502);
  assert.equal(loop.body.error.code, 'REMOTE_TOO_MANY_REDIRECTS');

  const safeRedirect = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: `${remote.origin}/redirect-range` },
  });
  assert.equal(safeRedirect.status, 201);
  assert.equal(safeRedirect.body.document.size, PDF_SIZE);
  await api(main, `/api/documents/${safeRedirect.body.document.id}`, { method: 'DELETE' });
});

/* --------------------------------------------------------- Remote streaming */

test('opens a remote PDF and serves exact byte ranges', async () => {
  const created = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.rangeUrl },
  });
  assert.equal(created.status, 201);
  const doc = created.body.document;
  assert.equal(doc.source, 'url');
  assert.equal(doc.size, PDF_SIZE);
  assert.equal(doc.rangeSupported, true);
  assert.equal('location' in doc, false);
  for (const field of ['ownerIp', 'remoteUrl', 'originalUrl', 'etag', 'lastModified', 'maxRemoteBytes']) {
    assert.equal(field in doc, false, `${field} must not be exposed`);
  }
  assert.equal(JSON.stringify(doc).includes(WORK_DIR), false);

  const full = await content(main, doc.contentUrl, 'bytes=100-199');
  assert.equal(full.status, 206);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-range'), `bytes 100-199/${PDF_SIZE}`);
  assert.equal(full.headers.get('content-length'), '100');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload.subarray(100, 200));

  const suffix = await content(main, doc.contentUrl, 'bytes=-64');
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), payload.subarray(PDF_SIZE - 64));

  const openEnded = await content(main, doc.contentUrl, 'bytes=1000-');
  assert.equal(openEnded.status, 206);
  assert.equal(openEnded.headers.get('content-length'), String(PDF_SIZE - 1000));
  await openEnded.body.cancel();

  const head = await fetch(`${main.baseUrl}${doc.contentUrl}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(head.headers.get('content-length'), String(PDF_SIZE));

  const stats = await api(main, `/api/documents/${doc.id}/stats`);
  assert.equal(stats.status, 200);
  assert.ok(stats.body.stats.rangeRequests >= 2);
  assert.ok(stats.body.stats.bytesServed > 0);

  assert.equal((await api(main, `/api/documents/${doc.id}`, { method: 'DELETE' })).status, 204);
});

test('returns 416 for unsatisfiable ranges', async () => {
  const created = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.rangeUrl },
  });
  const doc = created.body.document;
  const response = await content(main, doc.contentUrl, `bytes=${PDF_SIZE}-`);
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), `bytes */${PDF_SIZE}`);
  await response.body.cancel();
  await api(main, `/api/documents/${doc.id}`, { method: 'DELETE' });
});

test('rejects a remote PDF when the origin ignores Range', async () => {
  const created = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.noRangeUrl },
  });
  assert.equal(created.status, 422);
  assert.equal(created.body.error.code, 'REMOTE_NO_RANGE');
});

test('rejects non-PDF remote content', async () => {
  const created = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.notPdfUrl },
  });
  assert.equal(created.status, 422);
  assert.equal(created.body.error.code, 'REMOTE_NOT_PDF');
});

test('does not leak upstream status codes or addresses in remote errors', async () => {
  for (const [route, status, code] of [
    ['/missing.pdf', 404, 'REMOTE_NOT_FOUND'],
    ['/status-500.pdf', 502, 'REMOTE_HTTP_ERROR'],
  ]) {
    const response = await api(main, '/api/documents', {
      method: 'POST',
      body: { source: 'url', value: `${remote.origin}${route}` },
    });
    assert.equal(response.status, status, route);
    assert.equal(response.body.error.code, code, route);

    const payload = JSON.stringify(response.body);
    assert.doesNotMatch(payload, /127\.0\.0\.1/, route);
    assert.doesNotMatch(payload, new RegExp(`:${remote.port}`), route);
    assert.doesNotMatch(payload, new RegExp(String(status)), route);
    assert.doesNotMatch(payload, /HTTP \d{3}/, route);
  }
});

test('marks content responses as non-cacheable and sandboxed', async () => {
  const created = await api(main, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.rangeUrl },
  });
  const response = await content(main, created.body.document.contentUrl, 'bytes=0-9');
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  await response.body.cancel();
  await api(main, `/api/documents/${created.body.document.id}`, { method: 'DELETE' });
});

/* ------------------------------------------------------------ P0-5 limits */

test('enforces the per-client document quota', async () => {
  const context = await startApp({
    allowPrivateAddresses: true,
    allowedRemotePorts: [remote.port],
    maxDocuments: 10,
    maxDocumentsPerIp: 1,
    documentRateLimit: false,
    contentRateLimit: false,
    deleteRateLimit: false,
  });
  extraContexts.push(context);

  const first = await api(context, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.rangeUrl },
  });
  assert.equal(first.status, 201);

  const second = await api(context, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.rangeUrl },
  });
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, 'DOCUMENT_QUOTA_EXCEEDED');

  await api(context, `/api/documents/${first.body.document.id}`, { method: 'DELETE' });

  const third = await api(context, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.rangeUrl },
  });
  assert.equal(third.status, 201);
});

test('enforces the global document limit', async () => {
  const context = await startApp({
    allowPrivateAddresses: true,
    allowedRemotePorts: [remote.port],
    maxDocuments: 1,
    maxDocumentsPerIp: 10,
    documentRateLimit: false,
    contentRateLimit: false,
    deleteRateLimit: false,
  });
  extraContexts.push(context);

  const first = await api(context, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.rangeUrl },
  });
  assert.equal(first.status, 201);

  const second = await api(context, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.noRangeUrl },
  });
  assert.equal(second.status, 503);
  assert.equal(second.body.error.code, 'MAX_DOCUMENTS_REACHED');
});

test('rate limits document creation', async () => {
  const context = await startApp({
    allowPrivateAddresses: true,
    allowedRemotePorts: [remote.port],
    maxDocuments: 10,
    maxDocumentsPerIp: 10,
    documentRateLimit: { windowMs: 60_000, max: 2 },
    contentRateLimit: false,
    deleteRateLimit: false,
  });
  extraContexts.push(context);

  for (let index = 0; index < 2; index += 1) {
    const response = await api(context, '/api/documents', {
      method: 'POST',
      body: { source: 'url', value: remote.rangeUrl },
    });
    assert.equal(response.status, 201);
  }

  const limited = await api(context, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.rangeUrl },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('times out a slow upstream', async () => {
  const context = await startApp({
    allowPrivateAddresses: true,
    allowedRemotePorts: [remote.port],
    remoteHeadersTimeoutMs: 200,
    documentRateLimit: false,
    contentRateLimit: false,
    deleteRateLimit: false,
  });
  extraContexts.push(context);

  const created = await api(context, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: `${remote.origin}/slow-headers.pdf` },
  });
  assert.equal(created.status, 504);
  assert.equal(created.body.error.code, 'REMOTE_TIMEOUT');
});

test('aborts a full-body response larger than MAX_REMOTE_BYTES', async () => {
  const context = await startApp({
    allowPrivateAddresses: true,
    allowedRemotePorts: [remote.port],
    maxRemoteBytes: 1024,
    documentRateLimit: false,
    contentRateLimit: false,
    deleteRateLimit: false,
  });
  extraContexts.push(context);

  const created = await api(context, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.rangeUrl },
  });
  assert.equal(created.status, 201);

  await assert.rejects(async () => {
    const response = await fetch(`${context.baseUrl}${created.body.document.contentUrl}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    await response.arrayBuffer();
  });

  // A client must not be able to bypass the cap by requesting the whole file
  // through a single Range request.
  await assert.rejects(async () => {
    const response = await fetch(`${context.baseUrl}${created.body.document.contentUrl}`, {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        Range: `bytes=0-${PDF_SIZE - 1}`,
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    await response.arrayBuffer();
  });
});

test('releases concurrency slots after completed and aborted responses', async () => {
  const context = await startApp({
    allowPrivateAddresses: true,
    allowedRemotePorts: [remote.port],
    maxConcurrentStreams: 2,
    documentRateLimit: false,
    contentRateLimit: false,
    deleteRateLimit: false,
  });
  extraContexts.push(context);

  const created = await api(context, '/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remote.rangeUrl },
  });
  const route = created.body.document.contentUrl;

  for (let index = 0; index < 5; index += 1) {
    const response = await content(context, route, 'bytes=0-1023');
    assert.equal(response.status, 206, `completed request ${index}`);
    await response.arrayBuffer();
  }

  for (let index = 0; index < 5; index += 1) {
    const response = await content(context, route, 'bytes=0-1048575');
    assert.equal(response.status, 206, `aborted request ${index}`);
    await response.body.cancel();
  }

  await waitFor(() => context.getStreamStats().active === 0);
  assert.ok(context.getStreamStats().peak <= 2);
});

test('returns a helpful error for unknown document sessions', async () => {
  const response = await api(main, '/api/documents/not-a-real-id/stats');
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'DOCUMENT_NOT_FOUND');
});

/* ------------------------------------------------------------------ Helpers */

async function startApp(options = {}) {
  const created = createApp({ authToken: AUTH_TOKEN, logger: silentLogger(), ...options });
  const server = created.app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    ...created,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async cleanup() {
      created.stop?.();
      await created.store.cleanupAll();
      await closeServer(server);
    },
  };
}

async function api(context, route, { method = 'GET', body, token = AUTH_TOKEN } = {}) {
  const headers = {};
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${context.baseUrl}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  if (response.status !== 204) {
    parsed = await response.json().catch(() => null);
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function content(context, route, range) {  return fetch(`${context.baseUrl}${route}`, {
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      ...(range ? { Range: range } : {}),
    },
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for condition');
}

async function startRemoteFixture(pdfPayload) {
  const state = {
    rangeRequestCount: 0,
    port: 0,
    origin: '',
    server: null,
    rangeUrl: '',
    noRangeUrl: '',
    notPdfUrl: '',
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');

    if (url.pathname === '/redirect-range') {
      res.statusCode = 302;
      res.setHeader('Location', '/range.pdf');
      res.end();
      return;
    }
    if (url.pathname === '/redirect-file') {
      res.statusCode = 302;
      res.setHeader('Location', 'file:///etc/passwd');
      res.end();
      return;
    }
    if (url.pathname === '/redirect-loop') {
      res.statusCode = 302;
      res.setHeader('Location', '/redirect-loop');
      res.end();
      return;
    }
    if (url.pathname === '/slow-headers.pdf') {
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/pdf');
        res.end(pdfPayload);
      }, 500);
      return;
    }
    if (url.pathname === '/not-pdf.pdf') {
      const body = Buffer.from('<html>not a pdf</html>');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Length', String(body.length));
      res.end(body);
      return;
    }
    if (url.pathname === '/missing.pdf') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (url.pathname === '/status-500.pdf') {
      res.statusCode = 500;
      res.end('upstream failure');
      return;
    }

    const isNoRange = url.pathname === '/no-range.pdf';
    const body = pdfPayload;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Accept-Ranges', isNoRange ? 'none' : 'bytes');

    if (!isNoRange && req.headers.range) {
      state.rangeRequestCount += 1;
      const range = parseRequestRange(req.headers.range, body.length);
      if (!range) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${body.length}`);
        res.end();
        return;
      }
      const slice = body.subarray(range.start, range.end + 1);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${body.length}`);
      res.setHeader('Content-Length', String(slice.length));
      res.end(slice);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  state.server = server;
  state.port = server.address().port;
  state.origin = origin;
  state.rangeUrl = `${origin}/range.pdf`;
  state.noRangeUrl = `${origin}/no-range.pdf`;
  state.notPdfUrl = `${origin}/not-pdf.pdf`;
  return state;
}

function parseRequestRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) {
    return null;
  }
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return null;
  }
  return { start, end };
}

function closeServer(server) {
  if (!server) {
    return Promise.resolve();
  }
  server.closeAllConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
