// Development-only independent decode oracle; not run by npm test.
// Download https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz, then:
// npx tsx scripts/check-jbig2-encoder.ts <path-to-tgz>
// The published npm integrity is verified before loading Mozilla's standalone
// image decoder. No package is installed and no runtime dependency is added.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { encodeJbig2 } from '../src/jbig2encode.js';

const integrity = 'sha512-/Y3fcFrXEAsMjJXeL9J8+ZG9U01LbuWaYypvDW2ycW1jL269L3js3DVBjDJ0Up9Np1uqDXsDrRihHANhZOlwdQ==';
const archive = readFileSync(process.argv[2]);
if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== integrity)
  throw new Error('Expected the published pdfjs-dist 4.10.38 tarball');
const tar = gunzipSync(archive);
let source: Buffer | undefined;
for (let pos = 0; pos + 512 <= tar.length;) {
  const filename = tar.subarray(pos, pos + 100).toString().replace(/\0.*$/, '');
  const size = parseInt(tar.subarray(pos + 124, pos + 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
  if (filename === 'package/image_decoders/pdf.image_decoders.mjs') {
    source = tar.subarray(pos + 512, pos + 512 + size); break;
  }
  pos += 512 + Math.ceil(size / 512) * 512;
}
if (!source) throw new Error('Standalone image decoder missing from tarball');
const { Jbig2Image } = await import(`data:text/javascript;base64,${source.toString('base64')}`);
let checked = 0;
for (const width of [1, 7, 8, 9, 17, 64, 257, 513, 1024]) {
  for (const kind of ['white', 'black', 'repeated', 'noise']) {
    const height = 67, stride = Math.ceil(width / 8), samples = new Uint8Array(stride * height);
    let seed = 0x12345678;
    for (let y = 0; y < height; y++) for (let i = 0; i < stride; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[y * stride + i] = kind === 'white' ? 255 : kind === 'black' ? 0
        : kind === 'repeated' ? ((i * 37) ^ Math.floor(y / 13)) & 255 : seed >>> 24;
    }
    const encoded = encodeJbig2(width, height, samples);
    const decoded: Uint8Array = new Jbig2Image().parseChunks([{ data: encoded, start: 0, end: encoded.length }]);
    if (decoded.length !== samples.length) throw new Error(`Wrong output length at ${width}/${kind}`);
    // PDF.js's Jbig2Image returns packed 1=black. Its PDF stream adapter then
    // inverts those bits to PDF samples. Compare real pixels, excluding padding.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const shift = 7 - (x & 7), off = y * stride + (x >> 3);
      if (((decoded[off] >> shift) & 1) !== (((samples[off] >> shift) & 1) ^ 1))
        throw new Error(`PDF.js mismatch at ${width}/${kind}: (${x},${y})`);
    }
    checked++;
  }
}
console.log(`PDF.js 4.10.38 independently decoded ${checked} encoded bitmaps: all real pixels match.`);
