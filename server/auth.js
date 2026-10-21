import { randomBytes, timingSafeEqual } from 'node:crypto';

import { HttpError } from './errors.js';

const MIN_TOKEN_LENGTH = 16;

export function generateAuthToken() {
  return randomBytes(32).toString('base64url');
}

export function normalizeAuthToken(value) {
  if (value === undefined || value === null || value === '') {
    return { token: generateAuthToken(), generated: true };
  }

  const token = String(value);
  if (token.length < MIN_TOKEN_LENGTH || !/^[\x21-\x7e]+$/.test(token)) {
    throw new HttpError(
      500,
      'AUTH_TOKEN_INVALID',
      `AUTH_TOKEN 必须至少 ${MIN_TOKEN_LENGTH} 个字符，且不能包含空格或控制字符。`,
    );
  }
  return { token, generated: false };
}

export function requireAuth(expectedToken, { onUnauthorized } = {}) {
  const expected = Buffer.from(expectedToken, 'utf8');

  return (req, res, next) => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const actual = Buffer.from(token, 'utf8');
    const valid = actual.length === expected.length && timingSafeEqual(actual, expected);

    if (!valid) {
      if (typeof onUnauthorized === 'function') {
        onUnauthorized(req, res);
      } else {
        sendUnauthorized(res);
      }
      return;
    }

    next();
  };
}

export function sendUnauthorized(res) {
  res.setHeader('WWW-Authenticate', 'Bearer realm="StreamPDF"');
  res.status(401).json({
    error: {
      code: 'UNAUTHORIZED',
      message: '未认证或访问令牌无效。',
      hint: null,
    },
  });
}
