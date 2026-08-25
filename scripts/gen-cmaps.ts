// Generates src/cmapdata.ts — the bundled predefined Adobe CMaps.
//
// Downloads the pinned cmap-resources release into a gitignored cmaps/ dir
// (cached), parses every CMap with the library's own parseCidCMap, re-encodes
// the ranges with the library's own encodeCMapGeometry, brotli-compresses each
// CMap separately and emits the committed src/cmapdata.ts.
//
//   npm run gen:cmaps
//
// Parsing through src/cidcmap.ts rather than a parser local to this script is
// deliberate: the text parser is *also* the runtime path for an embedded
// /Encoding CMap stream, so generating through it means the bundled data and a
// document's own CMap cannot be read by two subtly different grammars.
//
// Per-CMap compression rather than one stream over all 195 costs about 8% of
// the total (753 KB against 697 KB) and buys the loader the only property that
// matters at runtime: opening a document that names one CMap inflates that one
// CMap, not the corpus.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gunzipSync } from 'node:zlib';
import { parseCidCMap } from '../src/cidcmap.js';
import { encodeCMapGeometry } from '../src/cmapcodec.js';

/** Pinned upstream release of adobe-type-tools/cmap-resources. */
const TAG = '20231115';
const TARBALL = `https://codeload.github.com/adobe-type-tools/cmap-resources/tar.gz/refs/tags/${TAG}`;

/**
 * The collections a PDF may name, and the `/CIDSystemInfo /Ordering` each one
 * carries. Adobe-Manga1 is shipped upstream but is not a PDF predefined
 * collection, so it is not bundled.
 */
const COLLECTIONS: { dir: string; ordering: string }[] = [
  { dir: 'Adobe-Japan1-7', ordering: 'Japan1' },
  { dir: 'Adobe-GB1-6', ordering: 'GB1' },
  { dir: 'Adobe-CNS1-7', ordering: 'CNS1' },
  { dir: 'Adobe-Korea1-2', ordering: 'Korea1' },
  { dir: 'Adobe-KR-9', ordering: 'KR' },
  { dir: 'Adobe-Identity-0', ordering: 'Identity' },
  // Superseded by Adobe-Japan1 but still named by files produced before it.
  { dir: 'deprecated/Adobe-Japan2-0', ordering: 'Japan2' },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = join(root, 'cmaps');
const outFile = join(root, 'src', 'cmapdata.ts');

function download(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const go = (u: string) => get(u, { headers: { 'user-agent': 'gen-cmaps' } }, (res) => {
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

/** Minimal POSIX tar reader — enough to unpack one release tarball, and less
 *  trouble than requiring a `tar` binary on every platform this runs on. */
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
  if (existsSync(join(rawDir, 'Adobe-Japan1-7', 'CMap', 'UniJIS-UCS2-H'))) return;
  process.stdout.write(`downloading cmap-resources ${TAG}\n`);
  const gz = await download(TARBALL);
  process.stdout.write(`  ${gz.length} bytes, sha256 ${createHash('sha256').update(gz).digest('hex')}\n`);
  for (const f of untar(gunzipSync(gz))) {
    // Strip the "cmap-resources-<tag>/" root the archive wraps everything in.
    const rel = f.path.replace(/^[^/]+\//, '');
    if (!rel) continue;
    const dest = join(rawDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.data);
  }
}

interface Entry {
  name: string;
  ordering: string;
  supplement: number;
  wmode: 0 | 1;
  usecmap: string;
  blob: string;
  ranges: number;
}

function collect(): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const { dir, ordering } of COLLECTIONS) {
    const cmapDir = join(rawDir, dir, 'CMap');
    if (!existsSync(cmapDir)) throw new Error(`missing collection: ${cmapDir}`);
    for (const file of readdirSync(cmapDir).sort()) {
      const parts = parseCidCMap(new Uint8Array(readFileSync(join(cmapDir, file))));
      // The file name is the resource name a PDF's /Encoding gives; a
      // disagreement with /CMapName means the pin moved under us.
      if (parts.name && parts.name !== file)
        throw new Error(`${dir}/${file}: /CMapName is ${parts.name}`);
      if (seen.has(file)) throw new Error(`duplicate CMap name across collections: ${file}`);
      seen.add(file);
      if (parts.ordering && parts.ordering !== ordering)
        throw new Error(`${dir}/${file}: /Ordering is ${parts.ordering}, expected ${ordering}`);

      const blob = brotliCompressSync(encodeCMapGeometry(parts), {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: parts.cidRanges.length * 4,
        },
      });
      entries.push({
        name: file,
        ordering,
        supplement: parts.supplement ?? 0,
        wmode: parts.wmode,
        usecmap: parts.usecmap ?? '',
        blob: blob.toString('base64'),
        ranges: parts.cidRanges.length + parts.notdefRanges.length,
      });
    }
  }
  return entries;
}

await ensureSources();
const entries = collect();

const orderings = [...new Set(entries.map((e) => e.ordering))];
const meta = entries
  .map((e) => `  ${JSON.stringify(e.name)}: ${JSON.stringify(
    `${orderings.indexOf(e.ordering)},${e.supplement},${e.wmode},${e.usecmap}`)},`)
  .join('\n');
const data = entries
  .map((e) => `  ${JSON.stringify(e.name)}: ${JSON.stringify(e.blob)},`)
  .join('\n');

const out = `// GENERATED by scripts/gen-cmaps.ts - DO NOT EDIT BY HAND.
// The predefined Adobe CMaps, from cmap-resources ${TAG}, as brotli-compressed
// cmapcodec.ts blobs. Regenerate: npm run gen:cmaps
//
// ${entries.length} CMaps, ${entries.reduce((a, e) => a + e.ranges, 0).toLocaleString('en-US')} ranges.
// Read them through predefcmap.ts, which inflates one CMap on demand and
// resolves its usecmap chain; nothing here is useful on its own.

/** \`/CIDSystemInfo /Ordering\` values, indexed by {@link CMAP_META}'s first field. */
export const CMAP_ORDERINGS: readonly string[] = ${JSON.stringify(orderings)};

/** CMap name -> "orderingIndex,supplement,wmode,usecmapName".
 *  Everything answerable without inflating the CMap's ranges. */
export const CMAP_META: Record<string, string> = {
${meta}};

/** CMap name -> base64 of the brotli-compressed cmapcodec.ts blob. */
export const CMAP_DATA: Record<string, string> = {
${data}};
`;
writeFileSync(outFile, out);
process.stdout.write(
  `wrote ${outFile}: ${entries.length} CMaps, ${(out.length / 1048576).toFixed(2)} MB\n`);
