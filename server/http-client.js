import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import ipaddr from 'ipaddr.js';

import { HttpError } from './errors.js';

const DEFAULT_ALLOWED_PORTS = Object.freeze([80, 443]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_HEADERS_TIMEOUT_MS = 20_000;
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;

// RFC 1918, loopback, link-local, CGNAT, documentation, benchmark,
// multicast and reserved IPv4 ranges. These are rejected in the opt-in
// public-only mode (`ALLOW_PRIVATE_ADDRESSES=0`).
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_IPV6_RANGES = [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['64:ff9b::', 96], // NAT64 well-known prefix
  ['64:ff9b:1::', 48], // local-use NAT64
];

const BLOCKED_V4 = new net.BlockList();
for (const [address, prefix] of BLOCKED_IPV4_RANGES) {
  BLOCKED_V4.addSubnet(address, prefix, 'ipv4');
}

const BLOCKED_V6 = new net.BlockList();
for (const [address, prefix] of BLOCKED_IPV6_RANGES) {
  BLOCKED_V6.addSubnet(address, prefix, 'ipv6');
}

// Intranet mode is deliberately narrower than "anything goes": it allows
// public, RFC1918/ULA private, loopback and CGNAT addresses (plus host
// services), which covers LAN and same-host PDF sources. Link-local/cloud
// metadata, multicast, unspecified and reserved ranges stay blocked.
const INTRANET_IPV4_RANGES = new Set(['unicast', 'private', 'loopback', 'carrierGradeNat']);
const INTRANET_IPV6_RANGES = new Set(['unicast', 'uniqueLocal', 'loopback']);
const KNOWN_METADATA_ADDRESSES = new Set(['100.100.100.200']); // Alibaba Cloud; 169.254.169.254 is link-local

// Default deployment target is an intranet: private, loopback and CGNAT
// targets are allowed. Set `allowPrivateAddresses: false` (or
// `ALLOW_PRIVATE_ADDRESSES=0`) to restore the public-only SSRF policy.
export function createRemotePolicy({ allowPrivateAddresses = true, allowedPorts = DEFAULT_ALLOWED_PORTS } = {}) {
  const ports = new Set();
  for (const value of allowedPorts) {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      ports.add(port);
    }
  }
  if (ports.size === 0) {
    throw new Error('allowedPorts 至少需要一个有效端口。');
  }
  return Object.freeze({
    allowPrivateAddresses: allowPrivateAddresses === true,
    allowedPorts: ports,
  });
}

export const DEFAULT_REMOTE_POLICY = createRemotePolicy();

/**
 * Validate a user supplied URL before it can reach the network layer.
 * This deliberately rejects credentials in the URL and non-HTTP(S) schemes.
 * Ports outside the allow list are only rejected in the public-only mode;
 * intranet mode permits any port so LAN/host services remain reachable.
 */
export function parseRemoteUrl(raw, policy = DEFAULT_REMOTE_POLICY) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new HttpError(400, 'INVALID_URL', 'URL 格式不正确。');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'INVALID_URL_PROTOCOL', '只支持 http:// 或 https:// 地址。');
  }
  if (url.username || url.password) {
    throw new HttpError(400, 'URL_CREDENTIALS_NOT_ALLOWED', 'URL 中不能包含用户名或密码。');
  }

  // In intranet mode any port is allowed so host/LAN services on non-standard
  // ports (8080, 5000, …) can be previewed. The allowlist still applies when
  // the operator opts into the public-only policy.
  const port = effectivePort(url);
  if (!policy.allowPrivateAddresses && !policy.allowedPorts.has(port)) {
    throw new HttpError(
      403,
      'URL_PORT_NOT_ALLOWED',
      '不允许访问该端口。',
      `公网严格模式只允许 ${[...policy.allowedPorts].join('、')} 端口。`,
    );
  }

  // Fragments are never sent to an origin and only add noise to logs.
  url.hash = '';
  return url;
}

/**
 * Resolve a hostname and return one validated IP address. The caller pins the
 * returned address in the connection lookup, so the hostname cannot be
 * re-resolved to a different (private) address between validation and connect.
 */
export async function resolveRemoteAddress(hostname, policy = DEFAULT_REMOTE_POLICY) {
  const host = stripBrackets(hostname).replace(/\.$/, '');
  const literalFamily = net.isIP(host);

  if (literalFamily !== 0) {
    if (!isAllowedAddress(host, policy)) {
      throw blockedAddressError();
    }
    return { address: host, family: literalFamily };
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new HttpError(502, 'REMOTE_DNS_FAILED', '无法解析远端的域名。');
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new HttpError(502, 'REMOTE_DNS_FAILED', '无法解析远端的域名。');
  }

  // Validate every DNS record before choosing one, so a hostname that
  // alternates between allowed and blocked records cannot be used to slip a
  // link-local/metadata address past the check. Intranet mode accepts
  // split-horizon DNS that resolves an internal name to a private address.
  for (const record of records) {
    if (!isAllowedAddress(record.address, policy)) {
      throw blockedAddressError();
    }
  }

  const chosen = records[0];
  return { address: chosen.address, family: chosen.family };
}

export function isPublicAddress(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(stripBrackets(address));
  } catch {
    return false;
  }

  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }

  if (parsed.kind() === 'ipv4') {
    // ipaddr.js classifies private/loopback/link-local/CGNAT etc. plus a few
    // reserved ranges. Requiring "unicast" adds a second, independent check.
    if (parsed.range() !== 'unicast') {
      return false;
    }
    return !BLOCKED_V4.check(parsed.toString(), 'ipv4');
  }

  if (parsed.kind() === 'ipv6') {
    if (parsed.range() !== 'unicast') {
      return false;
    }
    return !BLOCKED_V6.check(parsed.toString(), 'ipv6');
  }

  return false;
}

/**
 * True for addresses that the default intranet policy may proxy: public
 * unicast, RFC1918/CGNAT IPv4, ULA IPv6 and loopback (host services). Link-
 * local/cloud metadata, multicast and reserved ranges remain blocked so the
 * relaxation is limited to LAN and same-host targets.
 */
export function isIntranetAddress(address) {
  let parsed;
  try {
    parsed = ipaddr.parse(stripBrackets(address));
  } catch {
    return false;
  }

  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }

  if (parsed.kind() === 'ipv4') {
    if (!INTRANET_IPV4_RANGES.has(parsed.range())) {
      return false;
    }
    return !KNOWN_METADATA_ADDRESSES.has(parsed.toString());
  }

  if (parsed.kind() === 'ipv6') {
    return INTRANET_IPV6_RANGES.has(parsed.range());
  }

  return false;
}

function isAllowedAddress(address, policy) {
  return policy.allowPrivateAddresses ? isIntranetAddress(address) : isPublicAddress(address);
}

/**
 * Minimal HTTP(S) client with configurable address policy:
 * - only HTTP(S), no embedded credentials
 * - port allow list in public-only mode; any port in intranet mode
 * - DNS results pinned at connect time
 * - redirects handled manually, each hop revalidated
 * - header timeout and body idle timeout
 *
 * Intranet mode does not imply "no validation": scheme, credentials,
 * redirects, DNS pinning and timeouts still apply.
 */
export async function safeRequest(
  rawUrl,
  {
    method = 'GET',
    headers = {},
    signal,
    policy = DEFAULT_REMOTE_POLICY,
    headersTimeoutMs = DEFAULT_HEADERS_TIMEOUT_MS,
    bodyIdleTimeoutMs = DEFAULT_BODY_IDLE_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = {},
) {
  let url = parseRemoteUrl(rawUrl, policy);
  let redirects = 0;

  for (;;) {
    const target = await resolveRemoteAddress(url.hostname, policy);
    const response = await requestOnce(url, target, {
      method,
      headers,
      signal,
      headersTimeoutMs,
      bodyIdleTimeoutMs,
    });

    const location = headerValue(response.headers, 'location');
    if (REDIRECT_STATUSES.has(response.status) && location) {
      if (redirects >= maxRedirects) {
        response.body.destroy();
        throw new HttpError(502, 'REMOTE_TOO_MANY_REDIRECTS', '远端重定向次数过多。');
      }

      let nextUrl;
      try {
        nextUrl = new URL(location, url);
      } catch {
        response.body.destroy();
        throw new HttpError(502, 'REMOTE_BAD_REDIRECT', '远端返回了无效的重定向地址。');
      }

      response.body.destroy();
      // Re-run every validation for the redirect target: scheme, credentials,
      // port and (on the next loop) the resolved IP address.
      url = parseRemoteUrl(nextUrl.href, policy);
      redirects += 1;
      continue;
    }

    return { ...response, url: url.href };
  }
}

export function headerValue(headers, name) {
  if (!headers) {
    return null;
  }
  const value = headers[String(name).toLowerCase()];
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value === undefined ? null : value;
}

function requestOnce(url, target, { method, headers, signal, headersTimeoutMs, bodyIdleTimeoutMs }) {
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;

    const lookup = (_hostname, options, callback) => {
      // Always hand back the already validated address. This is the DNS
      // pinning step that defeats DNS rebinding between validation and connect.
      if (options && options.all) {
        callback(null, [{ address: target.address, family: target.family }]);
        return;
      }
      callback(null, target.address, target.family);
    };

    const req = transport.request(
      url,
      {
        method,
        headers: {
          ...headers,
          'Accept-Encoding': 'identity',
        },
        lookup,
        signal,
      },
      (res) => {
        settled = true;
        res.setTimeout(bodyIdleTimeoutMs, () => {
          res.destroy(new HttpError(504, 'REMOTE_TIMEOUT', '读取远端数据超时。'));
        });
        resolve({
          status: res.statusCode ?? 502,
          headers: res.headers,
          body: res,
          url: url.href,
        });
      },
    );

    req.setTimeout(headersTimeoutMs, () => {
      req.destroy(new HttpError(504, 'REMOTE_TIMEOUT', '连接远端超时。'));
    });

    req.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(normalizeNetworkError(error));
    });

    req.end();
  });
}

function normalizeNetworkError(error) {
  if (error instanceof HttpError) {
    return error;
  }
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return error;
  }
  if (error?.name === 'TimeoutError') {
    return new HttpError(504, 'REMOTE_TIMEOUT', '连接远端超时。');
  }
  // Deliberately do not echo socket/TLS error messages: they can reveal
  // internal DNS/network details.
  return new HttpError(
    502,
    'REMOTE_UNREACHABLE',
    '无法访问远端地址。',
    '请确认链接可从服务器访问；公网严格模式下还需确认目标端口在允许范围内。',
  );
}

function effectivePort(url) {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

function stripBrackets(value) {
  const text = String(value);
  return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
}

function blockedAddressError() {
  return new HttpError(
    403,
    'REMOTE_ADDRESS_BLOCKED',
    '不允许访问该地址。',
    '内网模式允许公网、私网、CGNAT 与本机地址；链路本地/云元数据、组播和保留地址仍会被拒绝。公网严格模式（ALLOW_PRIVATE_ADDRESSES=0）则只允许公网地址。',
  );
}
