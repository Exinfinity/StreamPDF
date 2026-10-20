import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { HttpError } from './errors.js';

const PDF_MAGIC = Buffer.from('%PDF-');
const PROBE_BYTES = 5;
const PROBE_TIMEOUT_MS = 20_000;
const MIRROR_TIMEOUT_MS = 2 * 60_000;

const BASE_REMOTE_HEADERS = Object.freeze({
  'User-Agent': 'StreamPDF/1.0 (+https://github.com/local/stream-pdf)',
  Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5',
  'Accept-Encoding': 'identity',
});

export async function inspectSource({ source, value, remoteMirrorLimit = 64 * 1024 * 1024 }) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, 'EMPTY_SOURCE', '文档路径或 URL 不能为空。');
  }

  const trimmed = value.trim();
  const kind =
    source === 'url' || source === 'path'
      ? source
      : /^https?:\/\//i.test(trimmed)
        ? 'url'
        : 'path';

  if (kind === 'url') {
    return inspectRemoteSource(trimmed, remoteMirrorLimit);
  }
  if (kind === 'path') {
    return inspectLocalSource(trimmed);
  }
  throw new HttpError(400, 'INVALID_SOURCE', 'source 只能是 path、url 或 auto。');
}

export async function inspectLocalSource(inputPath) {
  const expanded = expandHome(inputPath.trim());
  const resolved = path.resolve(expanded);
  let realPath;

  try {
    realPath = await fsp.realpath(resolved);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new HttpError(
        404,
        'PATH_NOT_FOUND',
        `找不到本地文件：${resolved}`,
        '请确认路径存在，并使用服务器所在操作系统可识别的绝对路径。',
      );
    }
    throw new HttpError(400, 'PATH_UNREADABLE', `无法读取该路径：${error.message}`);
  }

  assertAllowedRoot(realPath);

  const descriptor = await describeLocalFile(realPath, {
    kind: 'local',
    name: path.basename(realPath),
    display: realPath,
  });
  descriptor.originalValue = inputPath;
  return descriptor;
}

async function describeLocalFile(filePath, { kind, name, display, cleanupDir = null }) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new HttpError(400, 'NOT_A_FILE', '该路径不是普通文件。');
    }
    if (stat.size <= 0) {
      throw new HttpError(422, 'EMPTY_FILE', '该文件为空。');
    }

    const header = Buffer.alloc(PROBE_BYTES);
    const { bytesRead } = await handle.read(header, 0, PROBE_BYTES, 0);
    if (bytesRead < PDF_MAGIC.length || !header.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      throw new HttpError(422, 'NOT_PDF', '该文件不是有效的 PDF（缺少 %PDF- 文件头）。');
    }

    const etag = `"local-${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    return {
      kind,
      name: sanitizeName(name || path.basename(filePath)),
      display,
      path: filePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      etag,
      lastModified: new Date(stat.mtimeMs).toUTCString(),
      contentType: 'application/pdf',
      cleanupDir,
      mirrored: false,
      remoteSupportsRange: null,
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error.code === 'EACCES') {
      throw new HttpError(403, 'PATH_FORBIDDEN', `没有权限读取该文件：${filePath}`);
    }
    throw new HttpError(400, 'PATH_UNREADABLE', `无法读取该文件：${error.message}`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function inspectRemoteSource(rawUrl, remoteMirrorLimit) {
  const url = parseHttpUrl(rawUrl);
  let response;

  try {
    response = await fetch(url, {
      headers: { ...BASE_REMOTE_HEADERS, Range: `bytes=0-${PROBE_BYTES - 1}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw remoteNetworkError(error, url);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw remoteStatusError(response.status, url);
  }

  const prefix = await readPrefix(response, PROBE_BYTES);
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
  const name = extractRemoteName(response, finalUrl);
  const display = formatRemoteDisplay(finalUrl);
  const lastModified = response.headers.get('last-modified') || new Date().toUTCString();
  const baseEtag = `"remote-${hashUrl(finalUrl.href)}"`;

  if (response.status === 206) {
    const total = parseContentRangeTotal(response.headers.get('content-range'));
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
      path: null,
      remoteUrl: finalUrl.href,
      originalUrl: url.href,
      size: total,
      etag: baseEtag,
      lastModified,
      contentType: 'application/pdf',
      cleanupDir: null,
      mirrored: false,
      remoteSupportsRange: true,
    };
  }

  // A 200 means the server ignored the Range header. Small documents can be
  // mirrored locally once; for large files doing that would defeat streaming.
  const lengthHeader = response.headers.get('content-length');
  const contentLength = lengthHeader === null ? NaN : Number(lengthHeader);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw new HttpError(
      422,
      'REMOTE_NO_RANGE',
      '远端服务器不支持 Range 请求，且没有提供可用的文件大小，无法进行流式加载。',
      '请使用支持 Range 的静态文件直链，或先把文件下载到本地再输入路径。',
    );
  }
  if (contentLength > remoteMirrorLimit) {
    throw new HttpError(
      422,
      'REMOTE_NO_RANGE',
      `远端服务器不支持 Range 请求，文件约 ${formatMegabytes(contentLength)}，超过本地镜像上限。`,
      '为了能流畅打开大文件，请使用支持 Range 的直链；或下载到本地后输入文件路径。',
    );
  }

  return mirrorRemoteFile(url, remoteMirrorLimit, name, display, baseEtag, lastModified);
}

async function mirrorRemoteFile(url, remoteMirrorLimit, name, display, etag, lastModified) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'stream-pdf-'));
  const filePath = path.join(directory, 'document.pdf');
  let response;

  try {
    response = await fetch(url, {
      headers: BASE_REMOTE_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
    });
    if (!response.ok || response.status !== 200 || !response.body) {
      throw remoteStatusError(response.status, url);
    }
    ensureIdentityEncoding(response.headers);

    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > remoteMirrorLimit) {
          callback(new HttpError(422, 'REMOTE_TOO_LARGE', '远端文件超过本地镜像上限，已停止下载。'));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(filePath, { flags: 'wx' }));
    const descriptor = await describeLocalFile(filePath, {
      kind: 'url',
      name,
      display,
      cleanupDir: directory,
    });
    descriptor.remoteUrl = response.url || url.href;
    descriptor.originalUrl = url.href;
    descriptor.etag = etag;
    descriptor.lastModified = lastModified || descriptor.lastModified;
    descriptor.mirrored = true;
    descriptor.remoteSupportsRange = false;
    descriptor.mirrorBytes = descriptor.size;
    return descriptor;
  } catch (error) {
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(
      502,
      'REMOTE_MIRROR_FAILED',
      `下载远端文件失败：${error.message}`,
      '该服务器不支持 Range，应用尝试镜像文件但没有成功。',
    );
  }
}

export async function fetchRemoteBody(source, { start, end, signal }) {
  const headers = { ...BASE_REMOTE_HEADERS };
  if (start !== null) {
    headers.Range = `bytes=${start}-${end}`;
  }

  let response;
  try {
    response = await fetch(source.remoteUrl, {
      headers,
      redirect: 'follow',
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new HttpError(502, 'REMOTE_FETCH_FAILED', `读取远端文件失败：${error.message}`);
  }

  if (start === null) {
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw remoteStatusError(response.status, new URL(source.remoteUrl));
    }
  } else {
    if (response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(
        502,
        'REMOTE_RANGE_LOST',
        `远端服务器本次没有返回 206 分片响应（HTTP ${response.status}）。`,
        '远端链接可能已失效，或该服务器不支持稳定的 Range 请求。',
      );
    }
    const range = parseContentRange(response.headers.get('content-range'));
    if (!range || range.start !== start || range.end > end) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(502, 'REMOTE_BAD_RANGE', '远端返回的 Content-Range 与请求不一致。');
    }
  }

  ensureIdentityEncoding(response.headers);
  if (!response.body) {
    throw new HttpError(502, 'REMOTE_EMPTY_BODY', '远端响应没有可读取的内容。');
  }
  return response;
}

export async function cleanupSource(source) {
  if (source?.cleanupDir) {
    await fsp.rm(source.cleanupDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function createLocalReadStream(source, start, end) {
  return createReadStream(source.path, {
    start,
    end,
    highWaterMark: 256 * 1024,
    autoClose: true,
  });
}

function parseHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'INVALID_URL', 'URL 格式不正确。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'INVALID_URL_PROTOCOL', '只支持 http:// 或 https:// 地址。');
  }
  return url;
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

function extractRemoteName(response, finalUrl) {
  const disposition = response.headers.get('content-disposition');
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

function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ensureIdentityEncoding(headers) {
  const encoding = headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new HttpError(
      422,
      'REMOTE_CONTENT_ENCODING',
      `远端响应使用了 ${encoding} 压缩，无法保证 Range 字节语义。`,
      '请使用未启用传输压缩的 PDF 直链。',
    );
  }
}

async function readPrefix(response, length) {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (received < length) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      received += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function expandHome(value) {
  if (value === '~') {
    return os.homedir();
  }
  if (/^~[\\/]/.test(value)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function assertAllowedRoot(realPath) {
  const configured = (process.env.PDF_ALLOWED_ROOTS || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(expandHome(entry)));

  if (configured.length === 0) {
    return;
  }

  const allowed = configured.some((root) => realPath === root || realPath.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new HttpError(
      403,
      'PATH_OUTSIDE_ALLOWED_ROOTS',
      '该路径不在 PDF_ALLOWED_ROOTS 允许的目录内。',
    );
  }
}

function remoteStatusError(status, url) {
  const host = url.host;
  if (status === 401 || status === 403) {
    return new HttpError(
      502,
      'REMOTE_FORBIDDEN',
      `远端拒绝访问（HTTP ${status}，${host}）。`,
      '该链接可能需要登录或签名；请使用可直接访问的公开链接。',
    );
  }
  if (status === 404) {
    return new HttpError(404, 'REMOTE_NOT_FOUND', `远端文件不存在（HTTP 404，${host}）。`);
  }
  return new HttpError(502, 'REMOTE_HTTP_ERROR', `远端返回 HTTP ${status}（${host}）。`);
}

function remoteNetworkError(error, url) {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return new HttpError(
      504,
      'REMOTE_TIMEOUT',
      `连接远端超时（${url.host}）。`,
      '请确认网络可访问该地址后重试。',
    );
  }
  return new HttpError(
    502,
    'REMOTE_UNREACHABLE',
    `无法访问远端文件：${error.message}`,
    '请检查链接与网络连接。',
  );
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}
