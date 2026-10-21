import { createApp } from './app.js';

const port = parsePort(process.env.PORT, 3000);
const host = process.env.HOST || '127.0.0.1';
const maxDocuments = parseClampedInt(process.env.MAX_DOCUMENTS, 100, 1, 10_000);
const maxDocumentsPerIp = parseClampedInt(process.env.MAX_DOCUMENTS_PER_IP, 5, 1, 1_000);
const maxRemoteBytes = parseClampedInt(
  process.env.MAX_REMOTE_BYTES,
  2 * 1024 * 1024 * 1024,
  64 * 1024,
  16 * 1024 * 1024 * 1024,
);
const documentTtlMinutes = parseClampedInt(process.env.DOCUMENT_TTL_MINUTES, 30, 1, 24 * 60);
const maxConcurrentStreams = parseClampedInt(process.env.MAX_CONCURRENT_STREAMS, 100, 1, 1000);
const allowedRemotePorts = parsePortList(process.env.ALLOWED_REMOTE_PORTS, [80, 443]);
const trustProxy = process.env.TRUST_PROXY === '1' ? 1 : false;
const remoteHeadersTimeoutMs = parseClampedInt(
  process.env.REMOTE_HEADERS_TIMEOUT_MS,
  20_000,
  1_000,
  120_000,
);
const remoteBodyIdleTimeoutMs = parseClampedInt(
  process.env.REMOTE_BODY_IDLE_TIMEOUT_MS,
  30_000,
  1_000,
  300_000,
);

let created;
try {
  created = createApp({
    maxDocuments,
    maxDocumentsPerIp,
    maxRemoteBytes,
    documentTtlMs: documentTtlMinutes * 60_000,
    maxConcurrentStreams,
    allowedRemotePorts,
    trustProxy,
    remoteHeadersTimeoutMs,
    remoteBodyIdleTimeoutMs,
  });
} catch (error) {
  console.error(error?.message || '启动配置无效。');
  process.exit(1);
}

const { app, store, authToken, authTokenGenerated, stop } = created;

const server = app.listen(port, host, () => {
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log('');
  console.log('  StreamPDF 已启动');
  console.log(`  → http://${shownHost}:${port}`);
  console.log(`  监听 ${host}:${port}`);
  console.log('');
  if (authTokenGenerated) {
    console.log('  访问令牌（本次启动随机生成，重启后失效）：');
    console.log(`  ${authToken}`);
    console.log('');
    console.log('  如需固定令牌，请设置 AUTH_TOKEN 环境变量（至少 16 个字符）。');
  } else {
    console.log('  访问令牌：已通过 AUTH_TOKEN 环境变量配置。');
  }
  console.log('');
});

server.headersTimeout = 10_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 5_000;
server.maxConnections = 200;
server.maxRequestsPerSocket = 100;
server.timeout = 120_000;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用。可用 PORT=3001 npm start 指定其他端口。`);
  } else {
    console.error('服务器启动失败：', error);
  }
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在关闭服务…`);

  const forceTimer = setTimeout(() => {
    console.error('关闭超时，强制退出。');
    process.exit(1);
  }, 5000);
  forceTimer.unref();

  store.stop();
  stop?.();

  const closed = new Promise((resolve) => server.close(resolve));
  const graceful = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (!graceful) {
    server.closeAllConnections?.();
  }

  await store.cleanupAll().catch(() => {});
  clearTimeout(forceTimer);
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function parseClampedInt(value, fallback, min, max) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parsePortList(value, fallback) {
  if (!value) {
    return fallback;
  }
  const ports = String(value)
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0 && entry <= 65535);
  return ports.length > 0 ? [...new Set(ports)] : fallback;
}
