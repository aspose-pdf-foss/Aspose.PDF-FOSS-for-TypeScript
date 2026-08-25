// Regenerate test/fixtures/tiff/ — real-producer TIFFs plus an independent
// decoder's reading of each, for test/tiff-real.test.ts (issue 10u9.9).
//
// NOT run by `npm test`, and its two producers are NOT dependencies of this
// repo. Same authoring pattern as test/fixtures/jpeg/: install the encoders
// once OUTSIDE the repo, freeze the bytes they produce, uninstall.
//
//     mkdir /tmp/tiffgen && cd /tmp/tiffgen && npm init -y
//     npm install sharp@0.35.3 utif2@4.1.0
//     node <repo>/scripts/gen-tiff-fixtures.mjs --modules /tmp/tiffgen
//
// `--modules` is required because ESM resolves bare specifiers relative to THIS
// file, which sits in a repo that must stay zero-dependency.
//
// WHY TWO PRODUCERS. They cover different halves and neither alone is enough.
// libtiff (through libvips, through sharp) writes everything real-world files
// use — LZW, Deflate, PackBits, JPEG, G4, tiles, strips — but only in NATIVE
// byte order, which is little-endian here. utif2 is an unrelated pure-JS
// implementation that writes big-endian. Two independently written encoders
// agreeing with our decoder is a stronger anchor than one.
//
// WHY THE .expected.raw FILES. The point of a real-producer fixture is to catch
// a bug our own builder and reader would agree on, so the ground truth must not
// come from us either. At generation time the encoded file is handed BACK to
// libvips and its decode is frozen beside it — so every assertion compares our
// decoder against libvips's, including the lossy JPEG case, which has no other
// honest oracle. (For the utif2 file the oracle is libvips too, which is
// independent of utif2, so that fixture is genuinely two-sided.)

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const mi = argv.indexOf('--modules');
if (mi < 0 || !argv[mi + 1]) {
  console.error('usage: node scripts/gen-tiff-fixtures.mjs --modules <dir with sharp + utif2 installed>');
  process.exit(2);
}
const modulesDir = path.resolve(argv[mi + 1]);
const req = createRequire(pathToFileURL(path.join(modulesDir, 'noop.cjs')));
const sharp = req('sharp');
const UTIF = req('utif2');

const OUT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), 'test/fixtures/tiff');
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// The source images. Ours by design, which is what lets every assertion be
// exact: the shared-convention bug class needs the BYTES to be third-party,
// not the picture (the rule test/fixtures/jpeg/PROVENANCE.md records).
//
// 20x12 and asymmetric on purpose, against the fixture traps this repo already
// names: not square (a transposition would show), rows all differ (a row-order
// flip would show), channels all differ (a channel swap would show), and the
// width is not a multiple of the 16px tile (an edge tile is partial, so the
// padding rule is exercised) nor of 8 bits at 1bpp (so row padding is too).
// ---------------------------------------------------------------------------
const W = 20, H = 12;

const rgb = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    rgb[i] = (x * 11 + 7) & 0xff;
    rgb[i + 1] = (y * 23 + 3) & 0xff;
    rgb[i + 2] = (x * 5 + y * 31) & 0xff;
  }
}
const rgbSrc = () => sharp(rgb, { raw: { width: W, height: H, channels: 3 } });

// A bilevel-friendly source: a diagonal wedge, so no row equals its neighbour
// and G4's vertical coding has real work to do. A flat or striped image would
// let a tiled and a stripped encode agree for the wrong reason.
const gray = Buffer.alloc(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) gray[y * W + x] = (x * 3 + y * 5) % 23 < 11 ? 0x00 : 0xff;
}
const bilevelSrc = () => sharp(gray, { raw: { width: W, height: H, channels: 1 } })
  .toColourspace('b-w');

// RGBA for the utif2 file. Alpha stays 255 on purpose: utif2 writes
// ExtraSamples=1 (ASSOCIATED, i.e. premultiplied) but does not premultiply its
// samples. At full opacity the two readings coincide, so the fixture is honest;
// with partial alpha it would assert our division rule against a producer that
// got the flag wrong.
const rgba = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    rgba[i] = rgb[(y * W + x) * 3];
    rgba[i + 1] = rgb[(y * W + x) * 3 + 1];
    rgba[i + 2] = rgb[(y * W + x) * 3 + 2];
    rgba[i + 3] = 255;
  }
}

// ---------------------------------------------------------------------------
// The fixtures. `oracle` names the colourspace libvips should decode back into,
// so the frozen .expected.raw has the same channel layout our decoder produces.
// ---------------------------------------------------------------------------
const CASES = [
  // The reason this issue exists: `columns` handed to decodeCcitt is the BLOCK
  // width, not the image width, and no builder fixture separates them.
  ['libtiff-g4-tiled', () => bilevelSrc().tiff({
    compression: 'ccittfax4', bitdepth: 1, tile: true, tileWidth: 16, tileHeight: 16 }), 'b-w'],
  // Its differential partner: the same picture, strip-organised. Tiles and
  // strips take different assembly paths and hand decodeCcitt different
  // widths, so a bug in either shows up as the two disagreeing.
  ['libtiff-g4-strips', () => bilevelSrc().tiff({
    compression: 'ccittfax4', bitdepth: 1, tileHeight: 4 }), 'b-w'],

  // Predictor 2 across a tile boundary — the case where block width and image
  // width differ for the un-differencing walk as well.
  ['libtiff-lzw-tiled-pred', () => rgbSrc().tiff({
    compression: 'lzw', predictor: 'horizontal', tile: true, tileWidth: 16, tileHeight: 16 }), 'srgb'],
  // Multi-strip LZW with no predictor: pins the per-block codec reset (a
  // single-block image cannot see it).
  ['libtiff-lzw-strips', () => rgbSrc().tiff({
    compression: 'lzw', predictor: 'none', tileHeight: 4 }), 'srgb'],

  ['libtiff-packbits', () => rgbSrc().tiff({ compression: 'packbits' }), 'srgb'],
  ['libtiff-deflate-pred', () => rgbSrc().tiff({
    compression: 'deflate', predictor: 'horizontal' }), 'srgb'],
  // Photometric 5, four samples per pixel. Its oracle is NOT libvips's read of
  // the file: libvips applies an ICC transform on the way back out, so its
  // answer differs from the stored bytes by a few counts per channel. Since the
  // file is uncompressed, the exact ground truth is what libtiff was HANDED,
  // frozen separately below as libtiff-cmyk.source.raw.
  ['libtiff-cmyk', () => rgbSrc().toColourspace('cmyk').tiff({ compression: 'none' }), 'cmyk'],
  // JPEG in a TIFF. libvips picks photometric 2 (RGB) at this quality and
  // writes the embedded stream with SOF component ids R,G,B -- the shape that
  // exposed the combinePlanes bug this file found. Note it does NOT reach the
  // DCTDecode passthrough either:
  // libtiff always emits shared tables (tag 347 JPEGTables), and passthrough
  // requires their absence. It exercises the JPEGTables decode path instead,
  // which is the route real-world TIFFs actually take.
  ['libtiff-jpeg-rgb', () => rgbSrc().tiff({ compression: 'jpeg', quality: 90 }), 'srgb'],
];

const written = [];

async function freeze(name, bytes, oracleSpace) {
  const file = path.join(OUT, `${name}.tif`);
  fs.writeFileSync(file, bytes);
  const dec = await sharp(file).toColourspace(oracleSpace).raw()
    .toBuffer({ resolveWithObject: true });
  fs.writeFileSync(path.join(OUT, `${name}.expected.raw`), dec.data);
  written.push({
    name, bytes: bytes.length,
    sha: createHash('sha256').update(bytes).digest('hex'),
    w: dec.info.width, h: dec.info.height, ch: dec.info.channels,
    rawSha: createHash('sha256').update(dec.data).digest('hex'),
  });
}

for (const [name, make, oracle] of CASES) {
  await freeze(name, await make().toBuffer(), oracle);
}

// The big-endian half, from an unrelated implementation.
await freeze('utif-rgba-mm', Buffer.from(UTIF.encodeImage(rgba, W, H)), 'srgb');

// The exact encoder inputs, so a regenerated fixture can be checked against
// what it was actually asked to encode rather than against its own output.
fs.writeFileSync(path.join(OUT, 'source-rgb.raw'), rgb);
fs.writeFileSync(path.join(OUT, 'source-bilevel.raw'), gray);
// The CMYK encoder input, for the reason given at that case above.
fs.writeFileSync(path.join(OUT, 'libtiff-cmyk.source.raw'),
  await rgbSrc().toColourspace('cmyk').raw().toBuffer());

const v = (p) => JSON.parse(fs.readFileSync(path.join(modulesDir, 'node_modules', p, 'package.json'), 'utf8')).version;
console.log(`sharp ${v('sharp')} | libvips ${sharp.versions.vips} | libtiff ${sharp.versions.tiff} | utif2 ${v('utif2')}`);
console.log();
for (const r of written) {
  console.log(`${r.name.padEnd(24)} ${String(r.bytes).padStart(5)}B  ${r.w}x${r.h}x${r.ch}  sha256 ${r.sha.slice(0, 12)}…  raw ${r.rawSha.slice(0, 12)}…`);
}
