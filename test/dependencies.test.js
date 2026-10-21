import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('pdfjs-dist is upgraded past the affected CVE range', async () => {
  const packagePath = path.resolve('node_modules', 'pdfjs-dist', 'package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const [major, minor, patch] = pkg.version.split('.').map(Number);

  const patched =
    major > 6 ||
    (major === 6 && minor > 2) ||
    (major === 6 && minor === 2 && patch >= 108);
  assert.equal(patched, true, `pdfjs-dist ${pkg.version} is vulnerable (need >= 6.2.108)`);
});

test('frontend disables PDF scripting explicitly', async () => {
  const source = await readFile(path.resolve('public', 'js', 'app.js'), 'utf8');
  assert.match(source, /enableScripting:\s*false/);
  assert.doesNotMatch(source, /enableScripting:\s*true/);
});

test('frontend never auto-opens documents from query parameters (P1-3)', async () => {
  const source = await readFile(path.resolve('public', 'js', 'app.js'), 'utf8');
  assert.doesNotMatch(source, /\bURLSearchParams\b/);
  assert.doesNotMatch(source, /location\.search/);
  assert.doesNotMatch(source, /\b(autoUrl|autoPath|autoOpen)\b/);
  assert.doesNotMatch(source, /\.get\(\s*['"](?:url|path|open)['"]\s*\)/);
});
