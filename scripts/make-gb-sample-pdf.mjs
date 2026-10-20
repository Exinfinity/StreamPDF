#!/usr/bin/env node
/**
 * Generate a valid, roughly 1 GB PDF to test real Range streaming.
 *
 * Usage:
 *   node scripts/make-gb-sample-pdf.mjs [output] [pages] [targetMB]
 *
 * The page objects are spread across sparse padding holes, so jumping to a
 * page forces the browser to request a distant byte range instead of reusing
 * the first chunk. The page tree is balanced because PDF.js prefetches the
 * direct children of its root node.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const outputPath = path.resolve(process.argv[2] || 'test-output/streambook-1gb.pdf');
const pageCount = clampInt(process.argv[3], 201, 2, 5000);
const targetMB = clampInt(process.argv[4], 1024, 2, 20_000);
const padPerGap = Math.max(1, Math.floor((targetMB * 1024 * 1024) / (pageCount - 1)));

const objects = new Map();
let nextObjectId = 1;
const catalogId = nextObjectId++;
const pagesId = nextObjectId++;
const fontId = nextObjectId++;
const pageIds = [];
const contentIds = [];
const pageParents = new Map();

for (let page = 1; page <= pageCount; page += 1) {
  const pageId = nextObjectId++;
  const contentId = nextObjectId++;
  pageIds.push(pageId);
  contentIds.push(contentId);
  pageParents.set(pageId, pagesId);
}

const TREE_FANOUT = 8;
const treeNodes = [];
let treeLevel = pageIds.map((ref) => ({ ref, count: 1, kind: 'page' }));
while (treeLevel.length > TREE_FANOUT) {
  const nextLevel = [];
  for (let index = 0; index < treeLevel.length; index += TREE_FANOUT) {
    const group = treeLevel.slice(index, index + TREE_FANOUT);
    const nodeId = nextObjectId++;
    const count = group.reduce((sum, child) => sum + child.count, 0);
    const node = { id: nodeId, kids: group.map((child) => child.ref), count, parentId: pagesId };
    treeNodes.push(node);
    for (const child of group) {
      if (child.kind === 'page') {
        pageParents.set(child.ref, nodeId);
      } else {
        treeNodes.find((candidate) => candidate.id === child.ref).parentId = nodeId;
      }
    }
    nextLevel.push({ ref: nodeId, count, kind: 'node' });
  }
  treeLevel = nextLevel;
}
const rootKids = treeLevel.map((child) => child.ref);
const paddingIds = [];
for (let index = 0; index < pageCount - 1; index += 1) {
  paddingIds.push(nextObjectId++);
}
const infoId = nextObjectId++;
const xrefSize = nextObjectId;

let offset = 0;
const offsets = new Map();
const handle = await fsp.open(outputPath, 'w');

async function write(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  await handle.write(buffer, 0, buffer.length, offset);
  offset += buffer.length;
}

async function writeObject(id, body) {
  offsets.set(id, offset);
  await write(`${id} 0 obj\n`);
  await write(body);
  await write('\nendobj\n');
}

function pageBody(index) {
  const page = index + 1;
  return `<< /Type /Page /Parent ${pageParents.get(pageIds[index])} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`;
}

function pageContent(page) {
  return `q
0.97 0.975 0.985 rg
0 0 595 842 re f
0.1 0.12 0.17 rg
BT
/F1 28 Tf
56 750 Td
(Large PDF page ${page}) Tj
/F1 12 Tf
0 -34 Td
(This is a valid PDF of roughly ${targetMB} MB.) Tj
0 -20 Td
(Page objects are spread across padding holes, so navigating to this page) Tj
0 -20 Td
(requires a distant HTTP Range request. The whole file was not downloaded.) Tj
ET
0.3 0.88 0.7 rg
56 90 140 4 re f
Q`;
}

await write('%PDF-1.7\n');
await write(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

await writeObject(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
await writeObject(pagesId, `<< /Type /Pages /Kids [${rootKids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`);
await writeObject(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

for (let index = 0; index < pageCount; index += 1) {
  const page = index + 1;
  await writeObject(pageIds[index], pageBody(index));

  offsets.set(contentIds[index], offset);
  const content = Buffer.from(pageContent(page), 'latin1');
  await write(`${contentIds[index]} 0 obj\n<< /Length ${content.length} >>\nstream\n`);
  await write(content);
  await write('\nendstream\nendobj\n');

  if (index < pageCount - 1) {
    offsets.set(paddingIds[index], offset);
    await write(`${paddingIds[index]} 0 obj\n<< /Length ${padPerGap} >>\nstream\n`);
    await handle.truncate(offset + padPerGap);
    offset += padPerGap;
    await write('\nendstream\nendobj\n');
  }
}

for (const node of treeNodes) {
  await writeObject(
    node.id,
    `<< /Type /Pages /Parent ${node.parentId} 0 R /Kids [${node.kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${node.count} >>`,
  );
}

await writeObject(
  infoId,
  `<< /Title (StreamPDF large range test) /Author (StreamPDF) /Creator (scripts/make-gb-sample-pdf.mjs) >>`,
);

const xrefOffset = offset;
await write(`xref\n0 ${xrefSize}\n`);
await write('0000000000 65535 f \n');
for (let id = 1; id < xrefSize; id += 1) {
  const objectOffset = offsets.get(id);
  await write(
    objectOffset === undefined
      ? '0000000000 00000 f \n'
      : `${String(objectOffset).padStart(10, '0')} 00000 n \n`,
  );
}
await write(
  `trailer\n<< /Size ${xrefSize} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
);
await handle.truncate(offset);
await handle.close();

const stat = await fsp.stat(outputPath);
console.log(`Generated ${outputPath}`);
console.log(`  pages:       ${pageCount}`);
console.log(`  padding/gap: ${(padPerGap / (1024 * 1024)).toFixed(2)} MB`);
console.log(`  file size:   ${(stat.size / (1024 * 1024 * 1024)).toFixed(3)} GB (${stat.size} bytes)`);
console.log(`  page 2 at:   ${offsets.get(pageIds[1])} bytes`);
console.log(`  last page:   ${offsets.get(pageIds.at(-1))} bytes`);
console.log('  tip: open it in StreamPDF, then jump to the last page.');

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
