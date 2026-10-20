import { createApp } from './app.js';

const port = parsePort(process.env.PORT, 3000);
const host = process.env.HOST || '127.0.0.1';
const { app, store } = createApp({
  remoteMirrorLimit: parsePositiveInt(process.env.REMOTE_MIRROR_LIMIT_MB, 64) * 1024 * 1024,
});

const server = app.listen(port, host, () => {
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log('');
  console.log('  StreamPDF 已启动');
  console.log(`  → http://${shownHost}:${port}`);
  console.log(`  监听 ${host}:${port}`);
  console.log('');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用。可用 PORT=3001 npm start 指定其他端口。`);
  } else {
    console.error('服务器启动失败：', error);
  }
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在关闭服务…`);
  store.stop();
  const forceTimer = setTimeout(() => {
    console.error('关闭超时，强制退出。');
    process.exit(1);
  }, 5000);
  forceTimer.unref();

  server.close(() => {
    clearTimeout(forceTimer);
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
