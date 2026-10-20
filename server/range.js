/**
 * Parse one RFC 7233 byte range. Multi-range requests are deliberately
 * rejected: PDF.js only needs a single contiguous range, and supporting
 * multipart responses would make cancellation and byte accounting fragile.
 *
 * @param {string | undefined} header
 * @param {number} size
 * @returns {null | { start: number, end: number } | { invalid: true } | { unsatisfiable: true }}
 */
export function parseRangeHeader(header, size) {
  if (header === undefined || header === null || header === '') {
    return null;
  }
  if (typeof header !== 'string') {
    return { invalid: true };
  }

  const match = /^bytes\s*=\s*(.+)$/i.exec(header.trim());
  if (!match) {
    return { invalid: true };
  }

  const spec = match[1].trim();
  if (!spec || spec.includes(',')) {
    return { invalid: true };
  }

  const bounds = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!bounds) {
    return { invalid: true };
  }

  const [, startText, endText] = bounds;
  if (!startText && !endText) {
    return { invalid: true };
  }

  if (size <= 0) {
    return { unsatisfiable: true };
  }

  if (!startText) {
    const suffixLength = toSafeInteger(endText);
    if (suffixLength === null || suffixLength <= 0) {
      return { invalid: true };
    }
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = toSafeInteger(startText);
  if (start === null) {
    return { invalid: true };
  }
  if (start >= size) {
    return { unsatisfiable: true };
  }

  let end = endText ? toSafeInteger(endText) : size - 1;
  if (end === null || end < start) {
    return { invalid: true };
  }
  end = Math.min(end, size - 1);

  return { start, end };
}

function toSafeInteger(value) {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
