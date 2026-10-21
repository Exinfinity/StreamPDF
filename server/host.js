import ipaddr from 'ipaddr.js';

import { HttpError } from './errors.js';

const MAX_HOST_HEADER_LENGTH = 512;

/**
 * Parse an HTTP Host header (or an entry of ALLOWED_HOSTS) into a lowercase
 * hostname, discarding the optional port. Returns null for anything that is
 * ambiguous or malformed, including duplicate Host headers.
 *
 * Bracket handling is deliberate: an IPv6 Host must use brackets
 * (`[::1]:3000`); an unbracketed value containing more than one colon is
 * rejected instead of guessed at.
 */
export function parseHostHeader(value, rawHeaders = []) {
  if (typeof value !== 'string') {
    return null;
  }

  // Node normally rejects duplicate Host headers, but check rawHeaders as a
  // second line of defence. Different front-end/proxy combinations have
  // historically disagreed about which duplicate wins.
  if (Array.isArray(rawHeaders) && rawHeaders.length > 0) {
    let hostCount = 0;
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (String(rawHeaders[index]).toLowerCase() === 'host') {
        hostCount += 1;
      }
    }
    if (hostCount > 1) {
      return null;
    }
  }

  const raw = value.trim().toLowerCase();
  if (!raw || raw.length > MAX_HOST_HEADER_LENGTH) {
    return null;
  }
  if (/[\s/\\?#@,%]/.test(raw)) {
    return null;
  }

  let hostname;
  if (raw.startsWith('[')) {
    const closing = raw.indexOf(']');
    if (closing === -1) {
      return null;
    }
    hostname = raw.slice(1, closing);
    const rest = raw.slice(closing + 1);
    if (rest && !parsePortSuffix(rest)) {
      return null;
    }
    if (!hostname || ipaddr.IPv6.isValid(hostname) === false) {
      return null;
    }
  } else {
    const firstColon = raw.indexOf(':');
    const lastColon = raw.lastIndexOf(':');
    if (firstColon !== lastColon) {
      // Unbracketed IPv6 (or a malformed authority). Requiring brackets keeps
      // the hostname/port boundary unambiguous.
      return null;
    }
    if (lastColon !== -1) {
      if (!parsePortSuffix(raw.slice(lastColon))) {
        return null;
      }
      hostname = raw.slice(0, lastColon);
    } else {
      hostname = raw;
    }
  }

  hostname = hostname.replace(/\.$/, '');
  if (!hostname || !isValidHostname(hostname)) {
    return null;
  }
  return hostname;
}

/**
 * Normalize ALLOWED_HOSTS (comma separated string or array) into a Set of
 * lowercase hostnames. Loopback hostnames are always accepted separately, so
 * local health checks keep working when a public domain is configured.
 */
export function normalizeAllowedHosts(value) {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(',');
  const allowed = new Set();

  for (const entry of entries) {
    const raw = String(entry ?? '').trim();
    if (!raw) {
      continue;
    }
    if (raw.includes('*') || raw.includes('://') || /[\s/\\?#@,=]/.test(raw)) {
      throw new HttpError(
        500,
        'ALLOWED_HOSTS_INVALID',
        'ALLOWED_HOSTS 配置无效：只能填写逗号分隔的主机名（可带端口），不支持通配符或 URL。',
      );
    }
    const hostname = parseHostHeader(raw);
    if (!hostname) {
      throw new HttpError(
        500,
        'ALLOWED_HOSTS_INVALID',
        'ALLOWED_HOSTS 配置无效：包含无法识别的主机名。',
      );
    }
    allowed.add(hostname);
  }

  return allowed;
}

/**
 * True for localhost and for any loopback IP, including expanded IPv6 forms
 * and IPv4-mapped IPv6 loopback addresses.
 */
export function isLoopbackHostname(value) {
  const hostname = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  if (!hostname) {
    return false;
  }
  if (hostname === 'localhost') {
    return true;
  }

  try {
    let parsed = ipaddr.parse(hostname);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
      parsed = parsed.toIPv4Address();
    }
    return parsed.range() === 'loopback';
  } catch {
    return false;
  }
}

export function createHostGuard(value) {
  const allowed = normalizeAllowedHosts(value);

  return function hostGuard(req, res, next) {
    const hostname = parseHostHeader(req.headers.host, req.rawHeaders);
    if (!hostname || (!allowed.has(hostname) && !isLoopbackHostname(hostname))) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(421).type('text/plain; charset=utf-8').send('Misdirected Request');
      return;
    }
    next();
  };
}

function parsePortSuffix(value) {
  // value is either '' or ':port'.
  const match = /^:(\d{1,5})$/.exec(value);
  if (!match) {
    return false;
  }
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isValidHostname(hostname) {
  if (ipaddr.isValid(hostname)) {
    return true;
  }
  // DNS names, including underscore labels used by some internal services.
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(
    hostname,
  );
}
