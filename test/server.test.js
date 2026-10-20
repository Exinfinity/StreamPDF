import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../server/app.js';

const WORK_DIR = path.resolve('test-output', `integration-${process.pid}`);
const PDF_SIZE = 3 * 1024 * 1024 + 321;

let localServer;
let remoteServer;
let baseUrl;
let store;
let payload;
let localPdfPath;
let notPdfPath;

test.before(async () => {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  payload = Buffer.alloc(PDF_SIZE, 0x20);
  payload.write('%PDF-1.7\n', 0, 'latin1');
  payload.write('StreamPDF integration fixture\n', 11, 'latin1');
  payload.write('%%EOF\n', PDF_SIZE - 6, 'latin1');

  localPdfPath = path.join(WORK_DIR, 'fixture.pdf');
  notPdfPath = path.join(WORK_DIR, 'not-a-pdf.txt');
  await fsp.writeFile(localPdfPath, payload);
  await fsp.writeFile(notPdfPath, 'this is not a pdf');

  remoteServer = await startRemoteFixture(payload);
  const created = createApp({ remoteMirrorLimit: 5 * 1024 * 1024 });
  store = created.store;
  localServer = created.app.listen(0, '127.0.0.1');
  await once(localServer, 'listening');
  baseUrl = `http://127.0.0.1:${localServer.address().port}`;
});

test.after(async () => {
  store?.stop();
  await closeServer(localServer);
  await closeServer(remoteServer?.server);
  await fsp.rm(WORK_DIR, { recursive: true, force: true });
});

test('opens a local PDF and serves exact byte ranges', async () => {
  const created = await api('/api/documents', {
    method: 'POST',
    body: { source: 'path', value: localPdfPath },
  });
  assert.equal(created.status, 201);
  const doc = created.body.document;
  assert.equal(doc.source, 'path');
  assert.equal(doc.size, PDF_SIZE);
  assert.equal(doc.rangeSupported, true);

  const full = await fetch(`${baseUrl}${doc.contentUrl}`, {
    headers: { Range: 'bytes=100-199' },
  });
  assert.equal(full.status, 206);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-range'), `bytes 100-199/${PDF_SIZE}`);
  assert.equal(full.headers.get('content-length'), '100');
  const bytes = Buffer.from(await full.arrayBuffer());
  assert.deepEqual(bytes, payload.subarray(100, 200));

  const suffix = await fetch(`${baseUrl}${doc.contentUrl}`, {
    headers: { Range: 'bytes=-64' },
  });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), payload.subarray(PDF_SIZE - 64));

  const openEnded = await fetch(`${baseUrl}${doc.contentUrl}`, {
    headers: { Range: 'bytes=1000-' },
  });
  assert.equal(openEnded.status, 206);
  assert.equal(openEnded.headers.get('content-length'), String(PDF_SIZE - 1000));
  await openEnded.body.cancel();

  const head = await fetch(`${baseUrl}${doc.contentUrl}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(head.headers.get('content-length'), String(PDF_SIZE));

  const stats = await api(`/api/documents/${doc.id}/stats`);
  assert.equal(stats.status, 200);
  assert.ok(stats.body.stats.rangeRequests >= 2);
  assert.ok(stats.body.stats.bytesServed > 0);

  const deleted = await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
});

test('returns 416 for unsatisfiable ranges', async () => {
  const created = await api('/api/documents', {
    method: 'POST',
    body: { source: 'path', value: localPdfPath },
  });
  const doc = created.body.document;
  const response = await fetch(`${baseUrl}${doc.contentUrl}`, {
    headers: { Range: `bytes=${PDF_SIZE}-` },
  });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), `bytes */${PDF_SIZE}`);
  await response.body.cancel();
});

test('rejects non-PDF local files and missing paths', async () => {
  const notPdf = await api('/api/documents', {
    method: 'POST',
    body: { source: 'path', value: notPdfPath },
  });
  assert.equal(notPdf.status, 422);
  assert.equal(notPdf.body.error.code, 'NOT_PDF');

  const missing = await api('/api/documents', {
    method: 'POST',
    body: { source: 'path', value: path.join(WORK_DIR, 'does-not-exist.pdf') },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'PATH_NOT_FOUND');
});

test('proxies remote Range requests without buffering the PDF', async () => {
  const created = await api('/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remoteServer.rangeUrl },
  });
  assert.equal(created.status, 201);
  const doc = created.body.document;
  assert.equal(doc.source, 'url');
  assert.equal(doc.mirrored, false);
  assert.equal(doc.size, PDF_SIZE);

  const response = await fetch(`${baseUrl}${doc.contentUrl}`, {
    headers: { Range: 'bytes=456-789' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 456-789/${PDF_SIZE}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, payload.subarray(456, 790));

  const stats = await api(`/api/documents/${doc.id}/stats`);
  assert.ok(stats.body.stats.rangeRequests >= 1);
  assert.equal(remoteServer.rangeRequestCount > 0, true);
});

test('mirrors a small remote PDF when the origin ignores Range', async () => {
  const created = await api('/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remoteServer.noRangeUrl },
  });
  assert.equal(created.status, 201);
  const doc = created.body.document;
  assert.equal(doc.mirrored, true);
  assert.equal(doc.source, 'url');
  assert.equal(doc.size, PDF_SIZE);

  const response = await fetch(`${baseUrl}${doc.contentUrl}`, {
    headers: { Range: 'bytes=10-19' },
  });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(10, 20));
});

test('rejects an oversized remote PDF when the origin ignores Range', async () => {
  const created = await api('/api/documents', {
    method: 'POST',
    body: { source: 'url', value: remoteServer.oversizedNoRangeUrl },
  });
  assert.equal(created.status, 422);
  assert.equal(created.body.error.code, 'REMOTE_NO_RANGE');
});

test('returns helpful errors for unknown document sessions', async () => {
  const response = await api('/api/documents/not-a-real-id/stats');
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'DOCUMENT_NOT_FOUND');
});

async function api(route, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  if (response.status !== 204) {
    parsed = await response.json().catch(() => null);
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function startRemoteFixture(pdfPayload) {
  const state = {
    rangeRequestCount: 0,
    server: null,
    rangeUrl: '',
    noRangeUrl: '',
    oversizedNoRangeUrl: '',
  };

  const server = http.createServer((req, res) => {
    const isOversized = req.url.startsWith('/oversized.pdf');
    const isNoRange = req.url.startsWith('/no-range.pdf');
    const body = isOversized
      ? Buffer.concat([pdfPayload, Buffer.alloc(4 * 1024 * 1024)])
      : pdfPayload;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Accept-Ranges', isNoRange || isOversized ? 'none' : 'bytes');

    if (!isNoRange && !isOversized && req.headers.range) {
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
  state.rangeUrl = `${origin}/range.pdf`;
  state.noRangeUrl = `${origin}/no-range.pdf`;
  state.oversizedNoRangeUrl = `${origin}/oversized.pdf`;
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
