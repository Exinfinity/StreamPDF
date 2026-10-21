import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { HttpError } from './errors.js';
import {
  DEFAULT_REMOTE_POLICY,
  headerValue,
  parseRemoteUrl,
  safeRequest,
} from './http-client.js';

const PDF_MAGIC = Buffer.from('%PDF-');
const PROBE_BYTES = 5;
const PROBE_TIMEOUT_MS = 20_000;

export const DEFAULT_MAX_REMOTE_BYTES = 2 * 1024 * 1024 * 1024;

const BASE_REMOTE_HEADERS = Object.freeze({
  'User-Agent': 'StreamPDF/1.0',
  Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5',
  'Accept-Encoding': 'identity',
});

/**
 * Only remote HTTP(S) URLs are supported. All server-side local file reading
 * (including the former PDF_ALLOWED_ROOTS path mode) was removed as part of
 * the P0-1 remediation.
 */
export async function inspectSource({
  value,
  policy = DEFAULT_REMOTE_POLICY,
  maxRemoteBytes = DEFAULT_MAX_REMOTE_BYTES,
  headersTimeoutMs,
  bodyIdleTimeoutMs,
}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'EMPTY_SOURCE', 'PDF 的 HTTP(S) URL 不能为空。');
  }

  const trimmed = value.trim();
  if (trimmed.length > 8192) {
    throw new HttpError(400, 'SOURCE_TOO_LONG', 'URL 过长。');
  }

  return inspectRemoteSource(trimmed, {
    policy,
    maxRemoteBytes,
    headersTimeoutMs,
    bodyIdleTimeoutMs,
  });
}

async function inspectRemoteSource(
  rawUrl,
  { policy, maxRemoteBytes, headersTimeoutMs, bodyIdleTimeoutMs },
) {
  const url = parseRemoteUrl(rawUrl, policy);
  let response;

  try {
    response = await safeRequest(url, {
      headers: { ...BASE_REMOTE_HEADERS, Range: `bytes=0-${PROBE_BYTES - 1}` },
      policy,
      headersTimeoutMs,
      bodyIdleTimeoutMs,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw remoteNetworkError(error);
  }

  if (response.status < 200 || response.status >= 300) {
    response.body.destroy();
    throw remoteStatusError(response.status);
  }

  let prefix;
  try {
    prefix = await readPrefix(response.body, PROBE_BYTES);
  } catch (error) {
    throw remoteNetworkError(error);
  }

  if (prefix.length < PDF_MAGIC.length || !prefix.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new HttpError(
      422,
      'REMOTE_NOT_PDF',
      '远端内容不是 PDF（响应开头没有 %PDF- 标记）。',
      '如果该链接是一个网页，请使用文件本身的直链。',
    );
  }

  ensureIdentityEncoding(response.headers);

  const finalUrl = new URL(response.url || url.href);
  const name = extractRemoteName(response.headers, finalUrl);
  const display = formatRemoteDisplay(finalUrl);
  const lastModified = headerValue(response.headers, 'last-modified') || new Date().toUTCString();
  const baseEtag = `"remote-${hashUrl(finalUrl.href)}"`;

  if (response.status !== 206) {
    // A 200 means the origin ignored the Range header. Mirroring the file to
    // disk would reintroduce server-side file reads and a disk exhaustion
    // surface, so Range support is required instead.
    throw new HttpError(
      422,
      'REMOTE_NO_RANGE',
      '远端服务器不支持 Range 请求，无法进行流式加载。',
      '请使用支持 Range 的 PDF 直链；本服务不读取、也不缓存服务器本地文件。',
    );
  }

  const total = parseContentRangeTotal(headerValue(response.headers, 'content-range'));
  if (total === null || total <= 0) {
    throw new HttpError(
      502,
      'REMOTE_BAD_RANGE',
      '远端返回了 Range 响应，但缺少有效的 Content-Range 总大小。',
      '该服务器可能不兼容标准 Range 请求。',
    );
  }

  return {
    kind: 'url',
    name,
    display,
    remoteUrl: finalUrl.href,
    originalUrl: url.href,
    size: total,
    etag: baseEtag,
    lastModified,
    contentType: 'application/pdf',
    mirrored: false,
    remoteSupportsRange: true,
    maxRemoteBytes,
  };
}

export async function fetchRemoteBody(
  source,
  {
    start,
    end,
    signal,
    policy = DEFAULT_REMOTE_POLICY,
    maxRemoteBytes = source.maxRemoteBytes ?? DEFAULT_MAX_REMOTE_BYTES,
    headersTimeoutMs,
    bodyIdleTimeoutMs,
  },
) {
  const headers = { ...BASE_REMOTE_HEADERS };
  if (start !== null) {
    headers.Range = `bytes=${start}-${end}`;
  }

  let response;
  try {
    response = await safeRequest(source.remoteUrl, {
      headers,
      policy,
      headersTimeoutMs,
      bodyIdleTimeoutMs,
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw remoteNetworkError(error);
  }

  if (start === null) {
    if (response.status !== 200) {
      response.body.destroy();
      throw remoteStatusError(response.status);
    }
  } else {
    if (response.status !== 206) {
      response.body.destroy();
      throw new HttpError(
        502,
        'REMOTE_RANGE_LOST',
        `远端服务器本次没有返回 206 分片响应（HTTP ${response.status}）。`,
        '远端链接可能已失效，或该服务器不支持稳定的 Range 请求。',
      );
    }
    const range = parseContentRange(headerValue(response.headers, 'content-range'));
    if (!range || range.start !== start || range.end !== end) {
      response.body.destroy();
      throw new HttpError(502, 'REMOTE_BAD_RANGE', '远端返回的 Content-Range 与请求不一致。');
    }
    const contentLength = headerValue(response.headers, 'content-length');
    if (contentLength !== null && Number(contentLength) !== end - start + 1) {
      response.body.destroy();
      throw new HttpError(502, 'REMOTE_BAD_RANGE', '远端返回的 Content-Length 与请求范围不一致。');
    }
  }

  try {
    ensureIdentityEncoding(response.headers);
  } catch (error) {
    response.body.destroy();
    throw error;
  }
  if (!response.body) {
    throw new HttpError(502, 'REMOTE_EMPTY_BODY', '远端响应没有可读取的内容。');
  }
  const configuredMax = Math.max(0, Number(maxRemoteBytes) || DEFAULT_MAX_REMOTE_BYTES);
  const expected = start === null ? null : end - start + 1;
  const limit = expected === null ? configuredMax : Math.min(expected, configuredMax);

  return {
    ...response,
    body: limitBody(response.body, limit, expected),
  };
}

function limitBody(body, maxBytes, expectedBytes = null) {
  return Readable.from(
    (async function* () {
      let received = 0;
      for await (const chunk of body) {
        received += chunk.length;
        if (received > maxBytes) {
          throw new HttpError(413, 'REMOTE_TOO_LARGE', '远端响应超过允许的大小。');
        }
        yield chunk;
      }
      if (expectedBytes !== null && received !== expectedBytes) {
        throw new HttpError(502, 'REMOTE_BAD_RANGE', '远端响应提前结束，字节数与请求范围不一致。');
      }
    })(),
    { objectMode: false },
  );
}

function parseContentRangeTotal(header) {
  if (!header) {
    return null;
  }
  const match = /^bytes\s+(?:\d+-\d+|\*)\/(\d+|\*)$/i.exec(header.trim());
  if (!match || match[1] === '*') {
    return null;
  }
  const total = Number(match[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

function parseContentRange(header) {
  if (!header) {
    return null;
  }
  const match = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/i.exec(header.trim());
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    return null;
  }
  return { start, end };
}

function extractRemoteName(headers, finalUrl) {
  const disposition = headerValue(headers, 'content-disposition');
  if (disposition) {
    const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
    if (utf8) {
      try {
        return sanitizeName(decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, '')));
      } catch {
        // Fall through to the simple filename parser.
      }
    }
    const simple = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(disposition);
    if (simple) {
      const value = (simple[1] || simple[2] || '').trim();
      if (value) {
        return sanitizeName(value);
      }
    }
  }

  try {
    const lastPart = finalUrl.pathname.split('/').filter(Boolean).pop();
    if (lastPart) {
      return sanitizeName(decodeURIComponent(lastPart));
    }
  } catch {
    // Use the generic name below.
  }
  return '远端文档.pdf';
}

function sanitizeName(value) {
  const cleaned = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return cleaned || '未命名文档.pdf';
}

function formatRemoteDisplay(url) {
  try {
    return `${url.host}${decodeURIComponent(url.pathname)}`;
  } catch {
    return url.host;
  }
}

function hashUrl(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function ensureIdentityEncoding(headers) {
  const encoding = headerValue(headers, 'content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new HttpError(
      422,
      'REMOTE_CONTENT_ENCODING',
      `远端响应使用了 ${encoding} 压缩，无法保证 Range 字节语义。`,
      '请使用未启用传输压缩的 PDF 直链。',
    );
  }
}

async function readPrefix(stream, length) {
  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      received += chunk.length;
      if (received >= length) {
        break;
      }
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function remoteStatusError(status) {
  if (status === 401 || status === 403) {
    return new HttpError(
      502,
      'REMOTE_FORBIDDEN',
      `远端拒绝访问（HTTP ${status}）。`,
      '该链接可能需要登录或签名；请使用可直接访问的公开链接。',
    );
  }
  if (status === 404) {
    return new HttpError(404, 'REMOTE_NOT_FOUND', '远端文件不存在（HTTP 404）。');
  }
  return new HttpError(502, 'REMOTE_HTTP_ERROR', `远端返回 HTTP ${status}。`);
}

function remoteNetworkError(error) {
  if (error instanceof HttpError) {
    return error;
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return new HttpError(504, 'REMOTE_TIMEOUT', '连接远端超时。', '请确认网络可访问该地址后重试。');
  }
  return new HttpError(
    502,
    'REMOTE_UNREACHABLE',
    '无法访问远端地址。',
    '请检查链接与网络连接。',
  );
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}
