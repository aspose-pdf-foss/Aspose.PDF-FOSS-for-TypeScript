// Generates src/cidunidata.ts — Adobe's CID -> Unicode mapping tables.
//
// Downloads the pinned mapping-resources-pdf release into a gitignored cmaps/
// dir (cached, alongside gen-cmaps.ts's download), parses each table with the
// library's own parseCMap — they are ordinary bfchar/bfrange CMaps, keyed by
// CID rather than by character code — re-encodes with the library's own
// encodeCidUnicode, brotli-compresses each table separately and emits the
// committed src/cidunidata.ts.
//
//   npm run gen:cidunicode
//
// Why bundle these at all, when the code->CID CMaps are already bundled and
// could in principle be inverted: measured against these tables, inversion
// agrees on 39% of Adobe-Japan1's CIDs, 86% of Adobe-CNS1's, 94% of
// Adobe-Korea1's. Many-to-one mappings cannot be round-tripped — Japan1 CID 93
// is U+00A6 and CID 99 is U+007C, and inversion returns them swapped — and
// 13,569 Japan1 CIDs are not reachable from UCS-2 at all. The five tables cost
// ~120 KB of source; guessing costs correct text.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gunzipSync } from 'node:zlib';
import { parseCMap } from '../src/cmap.js';
import { encodeCidUnicode, type CidUnicodeMap } from '../src/cidunicode.js';

/** Pinned upstream release of adobe-type-tools/mapping-resources-pdf. */
const TAG = '20230118';
const TARBALL = `https://codeload.github.com/adobe-type-tools/mapping-resources-pdf/tar.gz/refs/tags/${TAG}`;

/** `/CIDSystemInfo /Ordering` -> Adobe's table for that collection. There is no
 *  table for Identity (whose CIDs are glyph indices, not characters) or for the
 *  deprecated Japan2. */
const TABLES: { ordering: string; file: string }[] = [
  { ordering: 'Japan1', file: 'Adobe-Japan1-UCS2' },
  { ordering: 'GB1', file: 'Adobe-GB1-UCS2' },
  { ordering: 'CNS1', file: 'Adobe-CNS1-UCS2' },
  { ordering: 'Korea1', file: 'Adobe-Korea1-UCS2' },
  { ordering: 'KR', file: 'Adobe-KR-UCS2' },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = join(root, 'cmaps', 'mapping-resources-pdf');
const outFile = join(root, 'src', 'cidunidata.ts');

function download(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const go = (u: string) => get(u, { headers: { 'user-agent': 'gen-cidunicode' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return go(res.headers.location);
      }
      if (res.statusCode !== 200) { reject(new Error(`${u} -> ${res.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
    go(url);
  });
}

/** Minimal POSIX tar reader — see the twin in gen-cmaps.ts. */
function untar(buf: Buffer): { path: string; data: Buffer }[] {
  const out: { path: string; data: Buffer }[] = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const name = buf.subarray(off, off + 100).toString('latin1').replace(/\0.*$/, '');
    if (!name) { off += 512; continue; }
    const size = parseInt(buf.subarray(off + 124, off + 136).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(buf[off + 156]);
    const prefix = buf.subarray(off + 345, off + 500).toString('latin1').replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    off += 512;
    if (type === '0' || type === '\0') out.push({ path: full, data: buf.subarray(off, off + size) });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

async function ensureSources(): Promise<void> {
  if (existsSync(join(rawDir, 'pdf2unicode', 'Adobe-Japan1-UCS2'))) return;
  process.stdout.write(`downloading mapping-resources-pdf ${TAG}\n`);
  const gz = await download(TARBALL);
  process.stdout.write(`  ${gz.length} bytes, sha256 ${createHash('sha256').update(gz).digest('hex')}\n`);
  for (const f of untar(gunzipSync(gz))) {
    const rel = f.path.replace(/^[^/]+\//, '');
    if (!rel) continue;
    const dest = join(rawDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.data);
  }
}

/** Adobe's "there is no Unicode for this CID". Dropping it here is what keeps
 *  replacement characters out of extracted text — see cidunicode.ts. */
const NO_MAPPING = '�';

function build(ordering: string, file: string): { map: CidUnicodeMap; dropped: number; total: number } {
  const text = readFileSync(join(rawDir, 'pdf2unicode', file));
  const entries = parseCMap(new Uint8Array(text)).entries();
  if (entries.length === 0) throw new Error(`${file}: parsed no entries`);

  const singleCids: number[] = [], singleUnits: number[] = [];
  const multiCids: number[] = [], multi: string[] = [];
  let dropped = 0;
  for (const [cid, dst] of entries) {
    if (dst.length === 0 || dst.includes(NO_MAPPING)) { dropped++; continue; }
    if (dst.length === 1) { singleCids.push(cid); singleUnits.push(dst.charCodeAt(0)); }
    else { multiCids.push(cid); multi.push(dst); }
  }
  return {
    map: {
      singleCids: Uint32Array.from(singleCids),
      singleUnits: Uint32Array.from(singleUnits),
      multiCids: Uint32Array.from(multiCids),
      multi,
    },
    dropped,
    total: entries.length,
  };
}

await ensureSources();

const rows: string[] = [];
let entryCount = 0, droppedCount = 0, byteCount = 0;
for (const { ordering, file } of TABLES) {
  const { map, dropped, total } = build(ordering, file);
  const blob = brotliCompressSync(encodeCidUnicode(map), {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: map.singleCids.length * 3,
    },
  });
  entryCount += total - dropped;
  droppedCount += dropped;
  byteCount += blob.length;
  rows.push(`  ${JSON.stringify(ordering)}: ${JSON.stringify(blob.toString('base64'))},`);
  process.stdout.write(
    `  ${ordering.padEnd(7)} ${String(total - dropped).padStart(6)} entries `
    + `(${dropped} unmapped dropped) -> ${blob.length} bytes\n`);
}

const out = `// GENERATED by scripts/gen-cidunicode.ts - DO NOT EDIT BY HAND.
// Adobe's CID -> Unicode tables, from mapping-resources-pdf ${TAG}, as
// brotli-compressed cidunicode.ts blobs. Regenerate: npm run gen:cidunicode
//
// ${entryCount.toLocaleString('en-US')} mappings across ${TABLES.length} collections, ${byteCount.toLocaleString('en-US')} compressed bytes.
// ${droppedCount} entries Adobe maps to U+FFFD ("no Unicode for this CID") are
// dropped, so an unmappable CID contributes no text instead of a replacement
// character. Read these through cidunicode.ts.

/** \`/CIDSystemInfo /Ordering\` -> base64 of the brotli-compressed blob. */
export const CID_UNICODE_DATA: Record<string, string> = {
${rows.join('\n')}
};
`;
writeFileSync(outFile, out);
process.stdout.write(`wrote ${outFile} (${(out.length / 1024).toFixed(0)} KB)\n`);
