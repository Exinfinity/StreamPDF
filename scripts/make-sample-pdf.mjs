#!/usr/bin/env node
/**
 * Generate a valid multi-page PDF for local performance testing.
 *
 * Usage:
 *   node scripts/make-sample-pdf.mjs [output] [pages] [paddingMB]
 *
 * Default: test-output/streampdf-sample.pdf, 300 pages, 12 MB padding.
 * The padding is a valid but unreferenced stream, so the file is large enough
 * to exercise HTTP Range requests without making page rendering expensive.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const outputPath = path.resolve(process.argv[2] || 'test-output/streampdf-sample.pdf');
const pageCount = clampInt(process.argv[3], 300, 1, 50_000);
const paddingMB = clampInt(process.argv[4], 12, 0, 4096);

const objects = new Map();
let nextObjectId = 1;
const catalogId = nextObjectId++;
const pagesId = nextObjectId++;
const fontId = nextObjectId++;
const pageIds = [];
const pageObjects = [];

for (let page = 1; page <= pageCount; page += 1) {
  const pageId = nextObjectId++;
  const contentId = nextObjectId++;
  pageIds.push(pageId);
  pageObjects.push({ pageId, contentId, page });
}

// PDF.js prefetches the direct children of the root page-tree node. Use a
// balanced tree with a small fan-out, like real-world PDFs, so opening a long
// document does not prefetch every page dictionary at once.
const TREE_FANOUT = 8;
const pageParents = new Map(pageIds.map((id) => [id, pagesId]));
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
        const childNode = treeNodes.find((candidate) => candidate.id === child.ref);
        childNode.parentId = nodeId;
      }
    }

    nextLevel.push({ ref: nodeId, count, kind: 'node' });
  }
  treeLevel = nextLevel;
}

const rootKids = treeLevel.map((child) => child.ref);

objects.set(fontId, {
  body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
});

for (const { pageId, contentId, page } of pageObjects) {
  objects.set(pageId, {
    body: `<< /Type /Page /Parent ${pageParents.get(pageId)} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
  });
  objects.set(contentId, {
    dict: '',
    stream: Buffer.from(buildPageContent(page, pageCount), 'latin1'),
  });
}

for (const node of treeNodes) {
  objects.set(node.id, {
    body: `<< /Type /Pages /Parent ${node.parentId} 0 R /Kids [${node.kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${node.count} >>`,
  });
}

const paddingId = nextObjectId++;
const infoId = nextObjectId++;
const paddingBytes = Math.max(0, paddingMB) * 1024 * 1024;
if (paddingBytes > 0) {
  objects.set(paddingId, {
    dict: '',
    stream: buildPaddingStream(paddingBytes),
  });
}

objects.set(catalogId, {
  body: `<< /Type /Catalog /Pages ${pagesId} 0 R >>`,
});
objects.set(pagesId, {
  body: `<< /Type /Pages /Kids [${rootKids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`,
});
objects.set(infoId, {
  body: `<< /Title (${pdfString(`StreamPDF sample - ${pageCount} pages`)}) /Author (StreamPDF) /Creator (scripts/make-sample-pdf.mjs) >>`,
});

const chunks = [];
let offset = 0;
const offsets = new Map();

function push(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, 'latin1');
  chunks.push(data);
  offset += data.length;
}

push('%PDF-1.7\n');
push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

for (const [id, object] of [...objects.entries()].sort((a, b) => a[0] - b[0])) {
  offsets.set(id, offset);
  push(`${id} 0 obj\n`);
  if (object.stream) {
    const dict = object.dict || `<< /Length ${object.stream.length} >>`;
    push(`${dict}\nstream\n`);
    push(object.stream);
    push('\nendstream\nendobj\n');
  } else {
    push(`${object.body}\nendobj\n`);
  }
}

const xrefOffset = offset;
push(`xref\n0 ${nextObjectId}\n`);
push('0000000000 65535 f \n');
for (let id = 1; id < nextObjectId; id += 1) {
  const objectOffset = offsets.get(id);
  if (objectOffset === undefined) {
    push('0000000000 00000 f \n');
  } else {
    push(`${String(objectOffset).padStart(10, '0')} 00000 n \n`);
  }
}
push(
  `trailer\n<< /Size ${nextObjectId} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
);

await fsp.mkdir(path.dirname(outputPath), { recursive: true });
const pdf = Buffer.concat(chunks);
await fsp.writeFile(outputPath, pdf);
console.log(`Generated ${outputPath}`);
console.log(`  pages: ${pageCount}`);
console.log(`  size:  ${(pdf.length / (1024 * 1024)).toFixed(2)} MB (${pdf.length} bytes)`);

function buildPageContent(page, totalPages) {
  const number = page.toLocaleString('en-US');
  const progress = ((page / totalPages) * 100).toFixed(1);
  return `q
0.968 0.973 0.982 rg
0 0 595 842 re f
0.91 0.93 0.96 RG
0.8 w
40 40 515 762 re S

0.08 0.10 0.14 rg
BT
/F1 23 Tf
56 770 Td
(StreamPDF) Tj
/F1 10 Tf
0 -18 Td
(Range-streamed PDF performance sample) Tj
ET

0.30 0.36 0.45 rg
BT
/F1 40 Tf
56 690 Td
(Page ${number}) Tj
ET

0.48 0.54 0.62 rg
BT
/F1 10 Tf
56 650 Td
(${progress} percent through this document) Tj
ET

0.85 0.88 0.92 RG
56 620 m 539 620 l S
56 560 m 539 560 l S
56 500 m 539 500 l S
56 440 m 539 440 l S
56 380 m 539 380 l S
56 320 m 539 320 l S

BT
/F1 9 Tf
0.36 0.42 0.51 rg
56 606 Td
(This page is rendered on demand. The PDF file itself is requested in 1 MiB ranges.) Tj
0 -34 Td
(The backend never loads the whole document into memory. Scroll to a distant page) Tj
0 -34 Td
(and PDF.js asks the Node server for only the byte ranges it needs.) Tj
0 -34 Td
(The unreferenced padding stream makes the file large while keeping this page fast.) Tj
0 -34 Td
(Try zooming, rotating, or jumping with the page number field.) Tj
ET

0.36 0.90 0.72 rg
56 90 120 3 re f
0.90 0.93 0.97 RG
56 100 m 539 100 l S

BT
/F1 8 Tf
0.45 0.52 0.60 rg
56 72 Td
(StreamPDF performance sample - generated locally) Tj
ET
Q`;
}

function buildPaddingStream(bytes) {
  const line =
    'Padding stream for Range request testing. This object is intentionally not referenced by any page. ' +
    'It exists only to make the PDF large enough to exercise streaming and virtual rendering. ' +
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\n';
  const lineBuffer = Buffer.from(line, 'latin1');
  const repeatCount = Math.ceil(bytes / lineBuffer.length);
  const buffer = Buffer.allocUnsafe(repeatCount * lineBuffer.length);
  for (let i = 0; i < repeatCount; i += 1) {
    lineBuffer.copy(buffer, i * lineBuffer.length);
  }
  return buffer.subarray(0, bytes);
}

function pdfString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
