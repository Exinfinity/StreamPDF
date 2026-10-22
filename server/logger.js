/**
 * Structured, redacting logger (P3).
 *
 * Security logs must never contain bearer tokens, cookies, credentials, URL
 * query strings/fragments or full filesystem paths. Every value passed to this
 * logger goes through the same sanitizer, so a future call site cannot leak a
 * secret by accident.
 */

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

// Key names whose values are always replaced, regardless of content.
const SECRET_KEY_PATTERN =
  /authorization|cookie|token|secret|password|passwd|api[-_]?key|session|credential|signature/i;

// C0/C1 controls plus Unicode bidirectional overrides. These make log lines
// ambiguous (log forging) and are also used to spoof file names in the UI.
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const QUOTED_PATH_PATTERN = /(["'])((?:[A-Za-z]:[\\/]|\/)[^"'\n]*)\1/g;
const MAX_TEXT_LENGTH = 2000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 4;

export function stripUnsafeControls(value) {
  return String(value).replace(UNSAFE_CONTROLS, '');
}

export function basename(value) {
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '[path]';
}

/**
 * Keep scheme, host and path; drop userinfo, query string and fragment.
 */
export function redactUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return '[url]';
    }
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Redact an arbitrary log message: remove control characters, strip URL query
 * strings and replace quoted absolute paths with their basename.
 */
export function redactText(value) {
  let text = stripUnsafeControls(value);
  text = text.replace(BEARER_PATTERN, 'Bearer [redacted]');
  text = text.replace(HTTP_URL_PATTERN, (match) => redactUrl(match));
  text = text.replace(
    QUOTED_PATH_PATTERN,
    (_match, quote, target) => `${quote}${basename(target)}${quote}`,
  );
  return text.slice(0, MAX_TEXT_LENGTH);
}

export function sanitizeError(error) {
  if (error && typeof error === 'object') {
    const record = { message: redactText(error.message ?? String(error)) };
    if (typeof error.name === 'string') {
      record.name = redactText(error.name);
    }
    if (typeof error.code === 'string' || typeof error.code === 'number') {
      record.code = redactText(error.code);
    }
    if (Number.isInteger(error.status)) {
      record.status = error.status;
    }
    return record;
  }
  return { message: redactText(String(error)) };
}

function sanitizeValue(value, depth, seen) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Error) {
    return sanitizeError(value);
  }
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'object') {
    return redactText(String(value));
  }
  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1, seen));
  }

  const output = {};
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
  for (const [key, item] of entries) {
    if (SECRET_KEY_PATTERN.test(key)) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = sanitizeValue(item, depth + 1, seen);
  }
  return output;
}

export function sanitizeFields(fields) {
  if (!fields || typeof fields !== 'object') {
    return {};
  }
  return sanitizeValue(fields, 0, new WeakSet());
}

export function normalizeLogLevel(value) {
  const level = String(value ?? '').trim().toLowerCase();
  return Object.hasOwn(LEVELS, level) ? level : 'info';
}

export function createLogger({
  level = process.env.LOG_LEVEL,
  sink = (line) => process.stdout.write(`${line}\n`),
  now = () => new Date(),
} = {}) {
  const threshold = LEVELS[normalizeLogLevel(level) ?? 'info'] ?? LEVELS.info;

  function log(levelName, event, fields) {
    const numeric = LEVELS[levelName];
    if (!numeric || numeric < threshold) {
      return false;
    }
    const record = {
      time: now().toISOString(),
      level: levelName,
      event: redactText(event ?? 'event'),
      ...sanitizeFields(fields),
    };
    try {
      sink(JSON.stringify(record));
    } catch {
      // Logging must never crash a request.
    }
    return true;
  }

  return {
    level: normalizeLogLevel(level),
    log,
    debug: (event, fields) => log('debug', event, fields),
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  };
}

export function silentLogger() {
  return createLogger({ level: 'silent', sink: () => {} });
}
