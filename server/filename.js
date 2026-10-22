/**
 * File-name hardening (P2-5 follow-up): strip control and Unicode
 * bidirectional-override characters, reject reserved/invalid characters and
 * bound the length so untrusted PDF metadata cannot spoof log lines, HTTP
 * headers or the UI.
 */

const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const FILESYSTEM_UNSAFE = /[\\/:*?"<>|]/g;
const FALLBACK_NAME = '未命名文档.pdf';
const MAX_NAME_CODE_POINTS = 160;
const MAX_DISPLAY_CODE_POINTS = 512;

export function clampCodePoints(value, max) {
  const points = Array.from(String(value));
  return points.length > max ? points.slice(0, max).join('') : points.join('');
}

export function stripUnsafeCharacters(value) {
  return String(value ?? '').replace(UNSAFE_CHARACTERS, '');
}

export function sanitizeDocumentName(value, { fallback = FALLBACK_NAME } = {}) {
  const cleaned = clampCodePoints(
    stripUnsafeCharacters(value).replace(FILESYSTEM_UNSAFE, '_').trim(),
    MAX_NAME_CODE_POINTS,
  );
  if (!cleaned || /^\.+$/.test(cleaned) || /^\s*$/.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

export function sanitizeDisplayText(value, { max = MAX_DISPLAY_CODE_POINTS } = {}) {
  return clampCodePoints(stripUnsafeCharacters(value), max).trim();
}

export { FALLBACK_NAME, MAX_NAME_CODE_POINTS };
