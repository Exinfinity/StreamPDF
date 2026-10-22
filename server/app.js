import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { normalizeAuthToken, requireAuth, sendUnauthorized } from './auth.js';
import { DocumentStore } from './documents.js';
import { HttpError, errorPayload } from './errors.js';
import { sanitizeDocumentName } from './filename.js';
import { createHostGuard } from './host.js';
import { createRemotePolicy } from './http-client.js';
import { createLogger, basename, redactUrl } from './logger.js';
import { createOriginGuard } from './origin-guard.js';
import { createRateLimiter, disabledLimiter } from './rate-limit.js';
import { parseRangeHeader } from './range.js';
import { fetchRemoteBody } from './sources.js';

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const DEFAULT_PDFJS_DIR = path.join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist');
const RANGE_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_STREAMS = 100;
const DEFAULT_METRICS_LOG_INTERVAL_MS = 15 * 60 * 1000;

export function createApp(options = {}) {
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const pdfjsDir = options.pdfjsDir ?? DEFAULT_PDFJS_DIR;
  const rangeChunkSize = options.rangeChunkSize ?? RANGE_CHUNK_SIZE;
  const logger = options.logger ?? createLogger();
  const { token: authToken, generated: authTokenGenerated } = normalizeAuthToken(
    options.authToken !== undefined ? options.authToken : process.env.AUTH_TOKEN,
  );

  // P1-1: reject requests whose Host header is not explicitly allowed. This
  // closes the DNS-rebinding precondition for a loopback-bound instance and
  // prevents Host-header cache poisoning when deployed behind a proxy.
  const allowedHosts =
    options.allowedHosts !== undefined ? options.allowedHosts : process.env.ALLOWED_HOSTS;

  // P2-3: state-changing API requests must not arrive cross-site. This is
  // defence in depth on top of the bearer token (which browsers never attach
  // automatically) and keeps the design safe if cookie sessions are added.
  const allowedOrigins =
    options.allowedOrigins !== undefined
      ? options.allowedOrigins
      : process.env.ALLOWED_ORIGINS;

  const enableMetrics = options.enableMetrics === true;
  const metricsLogIntervalMs =
    options.metricsLogIntervalMs === undefined
      ? DEFAULT_METRICS_LOG_INTERVAL_MS
      : Math.max(0, Number(options.metricsLogIntervalMs) || 0);

  // Public-facing strict mode is the default: only global unicast addresses
  // and the port allowlist are accepted. A trusted intranet can opt in with
  // `allowPrivateAddresses: true` (or ALLOW_PRIVATE_ADDRESSES=1), which also
  // permits any port while still blocking link-local/metadata.
  const remotePolicy =
    options.remotePolicy ??
    createRemotePolicy({
      allowPrivateAddresses: options.allowPrivateAddresses === true,
      allowedPorts: options.allowedRemotePorts ?? [80, 443],
    });

  const store =
    options.store ??
    new DocumentStore({
      ttlMs: options.documentTtlMs,
      maxDocuments: options.maxDocuments,
      maxDocumentsPerIp: options.maxDocumentsPerIp,
      maxRemoteBytes: options.maxRemoteBytes,
      remotePolicy,
      remoteHeadersTimeoutMs: options.remoteHeadersTimeoutMs,
      remoteBodyIdleTimeoutMs: options.remoteBodyIdleTimeoutMs,
    });

  const metrics = {
    requests: 0,
    responses4xx: 0,
    responses5xx: 0,
    authFailures: 0,
    rateLimited: 0,
    documentsOpened: 0,
    documentsOpenFailed: 0,
    upstreamFailures: 0,
  };
  const startedAt = Date.now();

  const documentLimiter = makeLimiter('documents.create', options.documentRateLimit, {
    windowMs: 60_000,
    max: 10,
  });
  const contentLimiter = makeLimiter('documents.content', options.contentRateLimit, {
    windowMs: 60_000,
    max: 600,
  });
  const deleteLimiter = makeLimiter('documents.delete', options.deleteRateLimit, {
    windowMs: 60_000,
    max: 30,
  });
  const authFailureLimiter = makeLimiter('auth.failure', options.authFailureRateLimit, {
    windowMs: 60_000,
    max: 10,
  });
  const maxConcurrentStreams = options.maxConcurrentStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS;
  let activeStreams = 0;
  let peakStreams = 0;

  const authenticate = requireAuth(authToken, {
    onUnauthorized(req, res) {
      metrics.authFailures += 1;
      logger.warn('auth.failed', {
        requestId: req.id,
        ip: clientAddress(req),
        method: req.method,
        path: req.path,
      });
      // Rate limit only failed authentication attempts. A client that keeps
      // guessing tokens gets a 429 instead of an unlimited 401 oracle.
      authFailureLimiter(req, res, () => sendUnauthorized(res));
    },
  });

  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy !== undefined) {
    app.set('trust proxy', options.trustProxy);
  }

  // Correlate client reports and proxy logs with structured server events.
  app.use((req, res, next) => {
    req.id = randomUUID();
    res.setHeader('X-Request-Id', req.id);
    metrics.requests += 1;
    res.once('finish', () => {
      if (res.statusCode >= 500) {
        metrics.responses5xx += 1;
      } else if (res.statusCode >= 400) {
        metrics.responses4xx += 1;
      }
    });
    next();
  });
  app.use(securityHeaders);
  app.use(createHostGuard(allowedHosts, logger));
  app.use('/api', createOriginGuard({ allowedOrigins, logger }));

  // API responses can contain document metadata and per-session statistics;
  // never let a browser or intermediary cache them.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Public health endpoint intentionally exposes liveness only.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Every other API endpoint, including configuration and document content,
  // requires a shared bearer token. Failed attempts are rate limited.
  app.use('/api', authenticate);

  if (enableMetrics) {
    // Opt-in, authenticated aggregate counters for Prometheus-style scraping
    // or a proxy-side probe. Kept off by default to avoid an unnecessary
    // information surface.
    app.get('/api/metrics', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ metrics: collectMetrics() });
    });
  }

  // Parse JSON only after authentication, so unauthenticated clients cannot
  // spend CPU/memory on request bodies.
  app.use(express.json({ limit: '32kb' }));

  app.get('/api/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      appName: 'StreamPDF',
      rangeChunkSize,
    });
  });

  app.post('/api/documents', documentLimiter, async (req, res) => {
    const body = req.body ?? {};
    if (body.source === 'path') {
      throw new HttpError(
        403,
        'LOCAL_FILES_DISABLED',
        '服务器本地文件读取功能已移除，只支持 HTTP(S) URL。',
      );
    }
    if (body.source !== undefined && body.source !== 'url') {
      throw new HttpError(400, 'INVALID_SOURCE', 'source 只能是 url。');
    }
    if (typeof body.value !== 'string' || !body.value.trim()) {
      throw new HttpError(400, 'EMPTY_SOURCE', '请输入 PDF 的 HTTP(S) URL。');
    }
    if (body.value.length > 8192) {
      throw new HttpError(400, 'SOURCE_TOO_LONG', 'URL 过长。');
    }

    let doc;
    try {
      doc = await store.open({
        value: body.value,
        ip: clientAddress(req),
      });
    } catch (error) {
      metrics.documentsOpenFailed += 1;
      logger.warn('document.open_failed', {
        requestId: req.id,
        ip: clientAddress(req),
        code: error?.code ?? 'INTERNAL',
        target: redactTarget(body.value),
      });
      throw error;
    }

    metrics.documentsOpened += 1;
    logger.info('document.opened', {
      requestId: req.id,
      ip: clientAddress(req),
      documentId: doc.id,
      size: doc.size,
      display: doc.display,
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

  app.delete('/api/documents/:id', deleteLimiter, (req, res) => {
    const removed = store.remove(req.params.id);
    logger.info('document.deleted', {
      requestId: req.id,
      ip: clientAddress(req),
      documentId: req.params.id,
      removed,
    });
    res.status(204).end();
  });

  app.get('/api/documents/:id/content', contentLimiter, streamSlot, (req, res, next) => {
    handleContent({ req, res, next, store, logger, metrics });
  });

  app.head('/api/documents/:id/content', contentLimiter, streamSlot, (req, res, next) => {
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

  app.use((error, req, res, _next) => {
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
    res.setHeader('Cache-Control', 'no-store');

    let normalized = error;
    let loggedUnexpected = false;
    if (error?.type === 'entity.parse.failed') {
      normalized = new HttpError(400, 'INVALID_JSON', '请求体不是有效的 JSON。');
    } else if (error?.type === 'entity.too.large') {
      normalized = new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大。');
    } else if (error instanceof HttpError) {
      // Keep semantic 4xx/5xx errors from upstream/content paths.
    } else {
      logger.error('request.failed', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        error,
        status: 500,
      });
      loggedUnexpected = true;
      normalized = new HttpError(500, 'INTERNAL', '服务器内部错误。');
    }

    const status = normalized.status ?? 500;
    const code = String(normalized.code ?? 'INTERNAL');
    if (code.startsWith('REMOTE_')) {
      metrics.upstreamFailures += 1;
      logger.warn('upstream.failed', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status,
        code,
      });
    } else if (status >= 500 && !loggedUnexpected) {
      logger.warn('request.error', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status,
        code,
      });
    }

    res.status(status).json(errorPayload(normalized));
  });

  // Release one concurrency slot as soon as the response is done.
  function streamSlot(req, res, next) {
    // The client may already have gone away before middleware runs; in that
    // case there is nothing to stream and no slot to hold.
    if (res.destroyed || req.destroyed) {
      next();
      return;
    }

    if (activeStreams >= maxConcurrentStreams) {
      logger.warn('stream.limit_reached', {
        requestId: req.id,
        active: activeStreams,
        max: maxConcurrentStreams,
      });
      res.setHeader('Retry-After', '5');
      res.status(503).json({
        error: {
          code: 'TOO_MANY_CONCURRENT_STREAMS',
          message: '当前并发读取请求过多，请稍后重试。',
          hint: null,
        },
      });
      return;
    }

    activeStreams += 1;
    peakStreams = Math.max(peakStreams, activeStreams);
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      activeStreams -= 1;
    };
    res.once('finish', release);
    res.once('close', release);
    req.once('close', release);
    next();
  }

  function makeLimiter(scope, settings, defaults) {
    if (settings === false) {
      return disabledLimiter();
    }
    return createRateLimiter({
      ...defaults,
      ...(settings ?? {}),
      onLimited(req, details) {
        metrics.rateLimited += 1;
        logger.warn('rate.limited', {
          requestId: req.id,
          ip: clientAddress(req),
          method: req.method,
          path: req.path,
          scope,
          retryAfter: details?.retryAfter,
        });
      },
    });
  }

  function collectMetrics() {
    let bytesServed = 0;
    let activeRequests = 0;
    for (const doc of store.docs.values()) {
      bytesServed += doc.stats.bytesServed;
      activeRequests += doc.stats.activeRequests;
    }
    return {
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      documents: store.docs.size,
      clientBuckets: store.ipCounts.size,
      activeStreams,
      peakStreams,
      maxConcurrentStreams,
      activeRequests,
      bytesServed,
      ...metrics,
    };
  }

  let metricsTimer = null;
  if (metricsLogIntervalMs > 0) {
    metricsTimer = setInterval(() => {
      logger.info('metrics.snapshot', collectMetrics());
    }, metricsLogIntervalMs);
    metricsTimer.unref?.();
  }

  return {
    app,
    store,
    logger,
    authToken,
    authTokenGenerated,
    getStreamStats() {
      return { active: activeStreams, peak: peakStreams, max: maxConcurrentStreams };
    },
    getMetrics: collectMetrics,
    stop() {
      store.stop();
      documentLimiter.stop?.();
      contentLimiter.stop?.();
      deleteLimiter.stop?.();
      authFailureLimiter.stop?.();
      if (metricsTimer) {
        clearInterval(metricsTimer);
        metricsTimer = null;
      }
    },
  };
}

function handleContent({ req, res, next, store, logger, metrics }) {
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
    try {
      const response = await fetchRemoteBody(doc, {
        start: isRange ? start : null,
        end: isRange ? end : null,
        signal: abortController.signal,
        policy: store.remotePolicy,
        maxRemoteBytes: store.maxRemoteBytes,
        headersTimeoutMs: store.remoteHeadersTimeoutMs,
        bodyIdleTimeoutMs: store.remoteBodyIdleTimeoutMs,
      });
      sourceStream = response.body;
    } catch (error) {
      finish();
      if (isClientAbort(error, req, res, abortController)) {
        res.destroy();
        return;
      }
      next(error);
      return;
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
        isClientAbort(error, req, res, abortController) ||
        error?.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        error?.code === 'ECONNRESET'
      ) {
        res.destroy();
        return;
      }
      if (!res.headersSent) {
        next(error);
      } else {
        // The error handler cannot send a response any more; record the
        // failure and tear the connection down instead of truncating silently.
        if (typeof error?.code === 'string' && error.code.startsWith('REMOTE_')) {
          metrics.upstreamFailures += 1;
        }
        logger?.error?.('stream.failed', {
          requestId: req.id,
          documentId: doc.id,
          code: error?.code ?? 'INTERNAL',
          error,
        });
        res.destroy();
      }
    }
  })().catch((error) => {
    finish();
    if (isClientAbort(error, req, res, abortController)) {
      res.destroy();
      return;
    }
    next(error);
  });
}

function isClientAbort(error, req, res, abortController) {
  return (
    abortController.signal.aborted ||
    res.destroyed ||
    req.destroyed ||
    error?.name === 'AbortError' ||
    error?.code === 'ABORT_ERR'
  );
}

function contentHeaders(doc, download) {
  return {
    'Content-Type': 'application/pdf',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: doc.etag,
    'Last-Modified': doc.lastModified,
    'Content-Disposition': buildContentDisposition(doc.name, download),
    'X-Content-Type-Options': 'nosniff',
  };
}

function buildContentDisposition(name, download) {
  const safeName = sanitizeDocumentName(name);
  const fallback = safeName
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 150);
  const encoded = encodeURIComponent(safeName).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader(
    'Permissions-Policy',
    [
      'accelerometer=()',
      'autoplay=()',
      'browsing-topics=()',
      'camera=()',
      'display-capture=()',
      'geolocation=()',
      'gyroscope=()',
      'interest-cohort=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'payment=()',
      'usb=()',
    ].join(', '),
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (process.env.ENABLE_HSTS === '1') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
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
      "manifest-src 'self'",
      "frame-src 'self' blob:",
      "form-action 'self'",
    ].join('; '),
  );
  next();
}

function clientAddress(req) {
  // With TRUST_PROXY=1 Express derives req.ip from X-Forwarded-For using the
  // configured hop count. Without it req.ip is the socket address, so a
  // client cannot spoof quotas by sending X-Forwarded-For.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Log an untrusted open target without exposing URL query strings or local
 * path components: URLs keep scheme/host/path, anything else keeps only the
 * basename.
 */
function redactTarget(value) {
  const text = String(value ?? '').slice(0, 1024);
  try {
    return redactUrl(new URL(text).href);
  } catch {
    return basename(text || '[empty]');
  }
}
