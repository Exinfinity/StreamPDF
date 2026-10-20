import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { DocumentStore } from './documents.js';
import { HttpError, errorPayload } from './errors.js';
import { parseRangeHeader } from './range.js';
import { createLocalReadStream, fetchRemoteBody } from './sources.js';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const DEFAULT_PDFJS_DIR = path.join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist');
const RANGE_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_REMOTE_MIRROR_LIMIT = 64 * 1024 * 1024;

export function createApp(options = {}) {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const pdfjsDir = options.pdfjsDir ?? DEFAULT_PDFJS_DIR;
  const rangeChunkSize = options.rangeChunkSize ?? RANGE_CHUNK_SIZE;
  const remoteMirrorLimit = options.remoteMirrorLimit ?? DEFAULT_REMOTE_MIRROR_LIMIT;
  const store =
    options.store ??
    new DocumentStore({
      ttlMs: options.documentTtlMs,
      remoteMirrorLimit,
    });

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      documents: store.docs.size,
      uptime: Math.round(process.uptime()),
    });
  });

  app.get('/api/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      appName: 'StreamPDF',
      rangeChunkSize,
      remoteMirrorLimit,
      maxUploadSize: null,
    });
  });

  app.post('/api/documents', async (req, res) => {
    const body = req.body ?? {};
    if (typeof body.value !== 'string' || !body.value.trim()) {
      throw new HttpError(400, 'EMPTY_SOURCE', '请输入本地 PDF 路径或 URL。');
    }
    if (body.value.length > 8192) {
      throw new HttpError(400, 'SOURCE_TOO_LONG', '路径或 URL 过长。');
    }

    const doc = await store.open({
      source: typeof body.source === 'string' ? body.source : 'auto',
      value: body.value,
    });
    res.status(201).json({ document: store.publicInfo(doc) });
  });

  app.get('/api/documents/:id', (req, res) => {
    const doc = store.require(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ document: store.publicInfo(doc) });
  });

  app.get('/api/documents/:id/stats', (req, res) => {
    const doc = store.require(req.params.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ stats: store.publicStats(doc) });
  });

  app.delete('/api/documents/:id', (req, res) => {
    store.remove(req.params.id);
    res.status(204).end();
  });

  app.get('/api/documents/:id/content', (req, res, next) => {
    handleContent({ req, res, next, store });
  });

  app.head('/api/documents/:id/content', (req, res, next) => {
    try {
      const doc = store.require(req.params.id);
      const range = parseRangeHeader(req.headers.range, doc.size);
      const headers = contentHeaders(doc, req.query.download === '1');
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
      }

      if (range === null) {
        res.status(200).setHeader('Content-Length', String(doc.size));
      } else if (range.invalid || range.unsatisfiable) {
        res.status(416).setHeader('Content-Range', `bytes */${doc.size}`);
      } else {
        res
          .status(206)
          .setHeader('Content-Range', `bytes ${range.start}-${range.end}/${doc.size}`)
          .setHeader('Content-Length', String(range.end - range.start + 1));
      }
      res.end();
    } catch (error) {
      next(error);
    }
  });

  app.use(
    '/vendor/pdfjs',
    express.static(pdfjsDir, {
      index: false,
      dotfiles: 'deny',
      maxAge: '7d',
      setHeaders(res) {
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      },
    }),
  );

  app.use(
    express.static(publicDir, {
      index: 'index.html',
      etag: true,
      maxAge: 0,
      setHeaders(res) {
        if (res.req?.path === '/' || res.req?.path?.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: '接口不存在。', hint: null },
      });
      return;
    }
    res.status(404).type('text/plain; charset=utf-8').send('404 Not Found');
  });

  app.use((error, _req, res, _next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    for (const header of [
      'Accept-Ranges',
      'Cache-Control',
      'Content-Disposition',
      'Content-Length',
      'Content-Range',
      'Content-Type',
      'ETag',
      'Last-Modified',
    ]) {
      res.removeHeader(header);
    }

    let normalized = error;
    if (error?.type === 'entity.parse.failed') {
      normalized = new HttpError(400, 'INVALID_JSON', '请求体不是有效的 JSON。');
    } else if (error?.type === 'entity.too.large') {
      normalized = new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大。');
    } else if (!(error instanceof HttpError)) {
      console.error('[stream-pdf] unhandled error:', error);
      normalized = new HttpError(500, 'INTERNAL', '服务器内部错误。');
    }

    res.status(normalized.status ?? 500).json(errorPayload(normalized));
  });

  return { app, store };
}

function handleContent({ req, res, next, store }) {
  let doc;
  try {
    doc = store.require(req.params.id);
  } catch (error) {
    next(error);
    return;
  }

  const size = doc.size;
  let range = parseRangeHeader(req.headers.range, size);
  const treatAsFull = range !== null && req.headers['if-range'] && req.headers['if-range'] !== doc.etag;
  if (treatAsFull) {
    range = null;
  }

  if (range?.invalid || range?.unsatisfiable) {
    res
      .status(416)
      .setHeader('Content-Range', `bytes */${size}`)
      .type('text/plain; charset=utf-8')
      .send('416 Range Not Satisfiable');
    return;
  }

  const isRange = range !== null;
  const start = isRange ? range.start : 0;
  const end = isRange ? range.end : size - 1;

  for (const [name, value] of Object.entries(contentHeaders(doc, req.query.download === '1'))) {
    res.setHeader(name, value);
  }

  if (!isRange && req.headers['if-none-match']) {
    const matches = req.headers['if-none-match']
      .split(',')
      .map((value) => value.trim())
      .includes(doc.etag);
    if (matches) {
      res.status(304).end();
      return;
    }
  }

  res.status(isRange ? 206 : 200);
  if (isRange) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', String(end - start + 1));

  store.startRequest(doc, { isRange, start, end });

  let finished = false;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    store.finishRequest(doc);
  };
  res.once('close', finish);
  res.once('finish', finish);

  const abortController = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  (async () => {
    let sourceStream;
    if (doc.path) {
      sourceStream = createLocalReadStream(doc, start, end);
    } else {
      try {
        const response = await fetchRemoteBody(doc, {
          start: isRange ? start : null,
          end: isRange ? end : null,
          signal: abortController.signal,
        });
        sourceStream = Readable.fromWeb(response.body);
      } catch (error) {
        finish();
        next(error);
        return;
      }
    }

    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        store.addServedBytes(doc, chunk.length);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(sourceStream, meter, res);
    } catch (error) {
      finish();
      if (
        res.destroyed ||
        req.destroyed ||
        error?.name === 'AbortError' ||
        error?.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        error?.code === 'ECONNRESET'
      ) {
        res.destroy();
        return;
      }
      console.error('[stream-pdf] stream failed:', error);
      if (!res.headersSent) {
        next(error);
      } else {
        res.destroy();
      }
    }
  })().catch((error) => {
    finish();
    next(error);
  });
}

function contentHeaders(doc, download) {
  return {
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600, immutable',
    ETag: doc.etag,
    'Last-Modified': doc.lastModified,
    'Content-Disposition': buildContentDisposition(doc.name, download),
    'X-Content-Type-Options': 'nosniff',
  };
}

function buildContentDisposition(name, download) {
  const fallback = String(name || 'document.pdf')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name || 'document.pdf').replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data: blob:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "media-src 'self' blob:",
      "frame-src 'self' blob:",
    ].join('; '),
  );
  next();
}
