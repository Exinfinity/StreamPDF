/**
 * Small fixed-window, per-client-IP rate limiter. The application is usually
 * deployed behind a reverse proxy, so this is a second line of defence rather
 * than a replacement for proxy-level limits.
 */
export function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const buckets = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }, Math.max(windowMs, 10_000));
  cleanup.unref?.();

  function middleware(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: '请求过于频繁，请稍后重试。',
          hint: null,
        },
      });
      return;
    }

    next();
  }

  middleware.stop = () => clearInterval(cleanup);
  return middleware;
}

export function disabledLimiter() {
  return (_req, _res, next) => next();
}
