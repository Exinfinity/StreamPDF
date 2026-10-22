/**
 * Legacy temporary-mirror cleanup (P2-4).
 *
 * Current versions never write PDF content to disk (unsupported Range origins
 * are rejected instead of mirrored). Older releases created
 * `stream-pdf-XXXXXX` directories under the OS temp directory; a crash or
 * SIGKILL could leave them behind. This startup sweep removes only our own
 * prefix, only real directories, and only entries older than a day.
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEMP_PREFIX = 'stream-pdf-';
// mkdtemp() appends six random alphanumeric characters.
const TEMP_NAME_PATTERN = /^stream-pdf-[A-Za-z0-9]{6}$/;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function cleanupStaleTempDirs({
  dir = os.tmpdir(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
  logger,
} = {}) {
  const result = { scanned: 0, removed: 0, errors: 0 };

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    logger?.warn?.('temp.cleanup_failed', { dir: path.basename(dir), error });
    result.errors += 1;
    return result;
  }

  for (const entry of entries) {
    // Dirent.isDirectory() is false for symlinks, so a symlink planted in a
    // world-writable temp directory can never redirect the recursive removal.
    if (!entry.isDirectory() || !TEMP_NAME_PATTERN.test(entry.name)) {
      continue;
    }
    result.scanned += 1;
    const target = path.join(dir, entry.name);
    try {
      const stats = await fsp.lstat(target);
      if (!stats.isDirectory() || now - stats.mtimeMs < maxAgeMs) {
        continue;
      }
      await fsp.rm(target, { recursive: true, force: true });
      result.removed += 1;
    } catch (error) {
      result.errors += 1;
      logger?.warn?.('temp.cleanup_entry_failed', { entry: entry.name, error });
    }
  }

  if (result.removed > 0) {
    logger?.info?.('temp.cleanup_done', {
      removed: result.removed,
      scanned: result.scanned,
      errors: result.errors,
    });
  }
  return result;
}

export { TEMP_NAME_PATTERN, TEMP_PREFIX };
