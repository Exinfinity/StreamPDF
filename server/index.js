import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { createApp } from './app.js';
import { isLoopbackHostname } from './host.js';
import { createLogger, normalizeLogLevel } from './logger.js';
import { cleanupStaleTempDirs } from './temp-cleanup.js';

const logger = createLogger();

const port = parsePort(process.env.PORT, 3000);
const host = process.env.HOST || '127.0.0.1';
const allowedHosts = (process.env.ALLOWED_HOSTS || '').trim();
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').trim();
const explicitAuthToken = (process.env.AUTH_TOKEN || '').trim();
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
const enableMetrics = process.env.ENABLE_METRICS === '1';
const metricsLogIntervalMinutes = parseClampedInt(
  process.env.METRICS_LOG_INTERVAL_MINUTES,
  15,
  0,
  24 * 60,
);
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

// P1-1: a non-loopback bind is an explicit public/LAN deployment. Refuse to
// start without an operator-provided Host allowlist instead of silently
// accepting arbitrary Host headers (DNS rebinding / cache poisoning).
if (!isLoopbackHostname(host) && !allowedHosts) {
  console.error('拒绝启动：HOST 不是回环地址时必须设置 ALLOWED_HOSTS。');
  console.error('例如：ALLOWED_HOSTS=pdf.example.com,localhost HOST=0.0.0.0 npm start');
  process.exit(1);
}

// P3: a randomly generated token is a local-development convenience only.
// A public bind must always use an operator-managed secret so it never ends up
// in a service journal or container log.
if (!isLoopbackHostname(host) && !explicitAuthToken) {
  console.error('拒绝启动：HOST 不是回环地址时必须显式设置 AUTH_TOKEN。');
  console.error('请使用至少 16 个字符的随机令牌，并通过环境变量或 EnvironmentFile 注入。');
  process.exit(1);
}

let created;
try {
  created = createApp({
    logger,
    allowedHosts,
    allowedOrigins,
    maxDocuments,
    maxDocumentsPerIp,
    maxRemoteBytes,
    documentTtlMs: documentTtlMinutes * 60_000,
    maxConcurrentStreams,
    allowedRemotePorts,
    trustProxy,
    enableMetrics,
    metricsLogIntervalMs: metricsLogIntervalMinutes * 60_000,
    remoteHeadersTimeoutMs,
    remoteBodyIdleTimeoutMs,
  });
} catch (error) {
  logger.error('startup.config_invalid', { error });
  console.error(error?.message || '启动配置无效。');
  process.exit(1);
}

const { app, store, authToken, authTokenGenerated, stop } = created;

await handleGeneratedToken(authToken, authTokenGenerated);
await cleanupStaleTempDirs({ logger }).catch((error) => {
  logger.warn('temp.cleanup_failed', { error });
});

const server = app.listen(port, host, () => {
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log('');
  console.log('  StreamPDF 已启动');
  console.log(`  → http://${shownHost}:${port}`);
  console.log(`  监听 ${host}:${port}`);
  console.log(`  允许的 Host：${allowedHosts || 'localhost、127.0.0.1、::1（仅回环）'}`);
  if (allowedOrigins) {
    console.log(`  允许的 Origin：${allowedOrigins}`);
  }
  console.log('');
  if (!authTokenGenerated) {
    console.log('  访问令牌：已通过 AUTH_TOKEN 环境变量配置。');
  }
  console.log('');
  logger.info('server.started', {
    host,
    port,
    node: process.version,
    logLevel: normalizeLogLevel(process.env.LOG_LEVEL),
    publicBind: !isLoopbackHostname(host),
    metricsEnabled: enableMetrics,
  });
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
    logger.error('server.listen_failed', { error });
    console.error('服务器启动失败：', error.message);
  }
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info('server.shutdown', { signal });

  const forceTimer = setTimeout(() => {
    logger.error('server.shutdown_timeout');
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

process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', { error: reason });
});

process.on('uncaughtException', (error) => {
  logger.error('process.uncaught_exception', { error });
  process.exit(1);
});

/**
 * When no AUTH_TOKEN is configured, a random token is generated at startup.
 * Print it only on an interactive terminal. Non-interactive processes (systemd,
 * containers, log collectors) write it to a 0600 file instead, so the secret
 * never lands in a log stream.
 */
async function handleGeneratedToken(token, generated) {
  if (!generated) {
    return;
  }

  if (process.stdout.isTTY) {
    console.log('');
    console.log('  访问令牌（本次启动随机生成，重启后失效）：');
    console.log(`  ${token}`);
    console.log('');
    console.log('  如需固定令牌，请设置 AUTH_TOKEN 环境变量（至少 16 个字符）。');
    console.log('');
    return;
  }

  const tokenFile = path.resolve(process.cwd(), '.auth-token');
  try {
    // Remove any stale entry first: `rm` on a symlink unlinks the link itself,
    // and `wx` (O_CREAT|O_EXCL) refuses to follow one created in a race.
    await fsp.rm(tokenFile, { force: true });
    await fsp.writeFile(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
    await fsp.chmod(tokenFile, 0o600).catch(() => {});
    console.log(`  访问令牌已写入 ${tokenFile}（权限 0600）。`);
    console.log('  生产部署请改用 AUTH_TOKEN 环境变量或 EnvironmentFile。');
  } catch (error) {
    logger.error('startup.token_file_failed', { error });
    console.error('拒绝启动：无法写入随机访问令牌文件，且 stdout 不是终端。');
    console.error('请显式设置 AUTH_TOKEN 环境变量后重试。');
    process.exit(1);
  }
}

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
