import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { cleanupStaleTempDirs, TEMP_NAME_PATTERN } from '../server/temp-cleanup.js';
import { silentLogger } from '../server/logger.js';

const WORK_DIR = path.resolve('test-output', `temp-cleanup-${process.pid}`);

test.before(async () => {
  await fsp.mkdir(WORK_DIR, { recursive: true });
});

test.after(async () => {
  await fsp.rm(WORK_DIR, { recursive: true, force: true });
});

test('removes only old directories with the legacy prefix', async () => {
  const oldDir = path.join(WORK_DIR, 'stream-pdf-abc123');
  const freshDir = path.join(WORK_DIR, 'stream-pdf-def456');
  const unrelated = path.join(WORK_DIR, 'other-directory');
  const oldFile = path.join(WORK_DIR, 'stream-pdf-ghi789');

  for (const dir of [oldDir, freshDir, unrelated]) {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'payload.pdf'), '%PDF-1.7');
  }
  await fsp.writeFile(oldFile, 'not a directory');

  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fsp.utimes(oldDir, old, old);
  await fsp.utimes(oldFile, old, old);

  const result = await cleanupStaleTempDirs({ dir: WORK_DIR, logger: silentLogger() });

  assert.equal(result.removed, 1);
  assert.equal(result.errors, 0);
  await assert.rejects(fsp.stat(oldDir), /ENOENT/);
  assert.ok((await fsp.stat(freshDir)).isDirectory());
  assert.ok((await fsp.stat(unrelated)).isDirectory());
  assert.ok((await fsp.stat(oldFile)).isFile());
});

test('does not follow symlinks planted in the temp directory', async () => {
  const outside = path.join(WORK_DIR, 'outside-target');
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(outside, 'keep.txt'), 'keep');

  const link = path.join(WORK_DIR, 'stream-pdf-zzz999');
  try {
    await fsp.symlink(outside, link);
  } catch {
    // Symlink creation may be unavailable on some platforms; nothing to test.
    return;
  }

  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fsp.utimes(link, old, old).catch(() => {});

  const result = await cleanupStaleTempDirs({ dir: WORK_DIR, logger: silentLogger() });
  assert.equal(result.removed, 0);
  assert.equal((await fsp.stat(path.join(outside, 'keep.txt'))).isFile(), true);
});

test('legacy temp name pattern matches mkdtemp output only', () => {
  assert.equal(TEMP_NAME_PATTERN.test('stream-pdf-abc123'), true);
  assert.equal(TEMP_NAME_PATTERN.test('stream-pdf-abc12'), false);
  assert.equal(TEMP_NAME_PATTERN.test('stream-pdf-../../etc'), false);
  assert.equal(TEMP_NAME_PATTERN.test('stream-pdf-ABC_12'), false);
});
