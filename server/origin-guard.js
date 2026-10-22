/**
 * CSRF / cross-site request guard (P2-3).
 *
 * The application authenticates with an `Authorization: Bearer` header, which
 * is not attached automatically by browsers and is therefore not CSRF-prone
 * today. This guard is defence in depth: if a future version adds cookie
 * sessions, state-changing API calls are already rejected unless they come
 * from the same origin (or an explicitly configured origin).
 *
 * Policy:
 * - GET/HEAD/OPTIONS are read-only and exempt.
 * - `Sec-Fetch-Site: cross-site` is always rejected.
 * - An `Origin` header must have a hostname matching the request `Host`, or be
 *   listed in `ALLOWED_ORIGINS`. `Origin: null` is rejected.
 * - Requests without browser headers (curl, server-to-server) still need the
 *   bearer token, so they are allowed.
 */

import { HttpError } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

export function normalizeAllowedOrigins(value) {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(',');
  const allowed = new Set();

  for (const entry of entries) {
    const raw = String(entry ?? '').trim();
    if (!raw) {
      continue;
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw invalidOriginsError();
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw invalidOriginsError();
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw invalidOriginsError();
    }
    allowed.add(url.origin.toLowerCase());
  }

  return allowed;
}

export function createOriginGuard({ allowedOrigins = [], logger } = {}) {
  const configured = normalizeAllowedOrigins(allowedOrigins);

  return function originGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const originHeader = req.headers.origin;
    let origin = null;
    if (originHeader !== undefined) {
      if (typeof originHeader !== 'string') {
        reject(req, res, next, logger, 'ORIGIN_INVALID');
        return;
      }
      origin = parseOrigin(originHeader);
      if (!origin) {
        reject(req, res, next, logger, 'ORIGIN_INVALID');
        return;
      }
      // An explicitly configured cross-origin frontend is allowed even when
      // the browser labels the request `cross-site`.
      if (configured.has(origin.origin.toLowerCase())) {
        next();
        return;
      }
    }

    const fetchSite = req.headers['sec-fetch-site'];
    if (typeof fetchSite === 'string' && fetchSite) {
      const normalized = fetchSite.trim().toLowerCase();
      if (!ALLOWED_FETCH_SITES.has(normalized)) {
        reject(req, res, next, logger, 'SEC_FETCH_SITE_CROSS_SITE');
        return;
      }
    }

    if (!origin) {
      // Non-browser clients (curl, server-to-server) do not send Origin but
      // still need the bearer token.
      next();
      return;
    }

    if (!matchesRequestHost(req, origin)) {
      reject(req, res, next, logger, 'ORIGIN_MISMATCH');
      return;
    }

    next();
  };
}

function reject(req, res, next, logger, reason) {
  logger?.warn?.('request.cross_site_blocked', {
    requestId: req.id,
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    method: req.method,
    path: `${req.baseUrl || ''}${req.path || ''}`,
    reason,
    origin: req.headers.origin ?? null,
    secFetchSite: req.headers['sec-fetch-site'] ?? null,
  });
  next(
    new HttpError(
      403,
      'CROSS_SITE_REQUEST',
      '已拒绝跨站请求。',
      '状态变更接口只接受同源请求；如使用独立前端域名，请配置 ALLOWED_ORIGINS。',
    ),
  );
}

function parseOrigin(value) {
  const raw = value.trim();
  if (!raw || raw.toLowerCase() === 'null') {
    return null;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) {
    return null;
  }
  // An Origin header is a serialized origin; paths other than "/" are not
  // valid and indicate a spoofing attempt.
  if (url.pathname !== '/') {
    return null;
  }
  return { origin: url.origin, hostname: url.hostname.toLowerCase(), port: url.port };
}

function matchesRequestHost(req, origin) {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== 'string' || !hostHeader) {
    return false;
  }
  let request;
  try {
    request = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  if (request.hostname.toLowerCase().replace(/\.$/, '') !== origin.hostname.replace(/\.$/, '')) {
    return false;
  }
  // Only enforce the port when both sides spell one out. Reverse proxies
  // commonly forward `$host` without the default port while the browser
  // includes it in `Origin`, and scheme termination differs behind TLS.
  if (request.port && origin.port && request.port !== origin.port) {
    return false;
  }
  return true;
}

function invalidOriginsError() {
  return new HttpError(
    500,
    'ALLOWED_ORIGINS_INVALID',
    'ALLOWED_ORIGINS 配置无效：只能填写逗号分隔的 http(s) 源（scheme://host[:port]），不能包含路径、查询或凭据。',
  );
}
