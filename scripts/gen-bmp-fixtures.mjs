// Regenerate test/fixtures/bmp/ — real-producer BMPs plus an independent
// decoder's reading of each, for test/bmp-real.test.ts (issue 10u9.8).
//
// NOT run by `npm test`. The one npm package it needs is not a dependency of
// this repo; install it once OUTSIDE and uninstall, the pattern
// test/fixtures/jpeg/PROVENANCE.md records.
//
//     mkdir /tmp/bmpgen && cd /tmp/bmpgen && npm init -y && npm install bmp-js@0.1.0
//     node <repo>/scripts/gen-bmp-fixtures.mjs --modules /tmp/bmpgen
//
// TWO PARTIES, WRITER AND READER, NEITHER OF THEM US.
//
// The writer is GDI+ (scripts/gen-bmp-fixtures.ps1) — Windows' own imaging
// stack, and the closest thing BMP has to a reference implementation, the
// format being Microsoft's. It is also the only writer available here that
// emits sub-8-bit palettes, BI_BITFIELDS and a partial palette at all.
//
// The reader is bmp-js, an unrelated pure-JS decoder. That matters: for a
// palette file the ground truth CANNOT be the source image, because GDI+ picks
// its own adaptive palette, so it has to come from something that reads the
// file. Using GDI+ for both halves would put one stack on both sides of the
// comparison.
//
// bmp-js cannot read BI_BITFIELDS, so gdi-16bpp-565 gets no .expected.raw and
// is asserted against the source within its quantization bound instead. That is
// a genuine hole in the oracle and PROVENANCE.md says so rather than hiding it.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const mi = argv.indexOf('--modules');
if (mi < 0 || !argv[mi + 1]) {
  console.error('usage: node scripts/gen-bmp-fixtures.mjs --modules <dir with bmp-js installed>');
  process.exit(2);
}
const modulesDir = path.resolve(argv[mi + 1]);
const req = createRequire(pathToFileURL(path.join(modulesDir, 'noop.cjs')));
const bmpjs = req('bmp-js');

const repo = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const OUT = path.join(repo, 'test/fixtures/bmp');
const PS1 = path.join(repo, 'scripts/gen-bmp-fixtures.ps1');

if (process.platform !== 'win32') {
  console.error('gen-bmp-fixtures: GDI+ is the producer, so this must run on Windows.');
  process.exit(2);
}

// 1. GDI+ writes the .bmp files.
console.log(execFileSync('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Out', OUT],
  { encoding: 'utf8' }).trimEnd());
console.log();

// 2. bmp-js reads each back; its decode becomes the frozen ground truth.
//    bmp-js hands back ABGR; our RasterImage is RGB + separate alpha, so the
//    oracle is written as interleaved RGB to match what a test compares.
const rows = [];
for (const f of fs.readdirSync(OUT).filter((n) => n.endsWith('.bmp')).sort()) {
  const name = f.replace(/\.bmp$/, '');
  const bytes = fs.readFileSync(path.join(OUT, f));
  const row = { name, bytes: bytes.length, sha: createHash('sha256').update(bytes).digest('hex') };
  try {
    const d = bmpjs.decode(bytes);
    const rgb = Buffer.alloc(d.width * d.height * 3);
    for (let p = 0; p < d.width * d.height; p++) {
      rgb[p * 3] = d.data[p * 4 + 3];      // R
      rgb[p * 3 + 1] = d.data[p * 4 + 2];  // G
      rgb[p * 3 + 2] = d.data[p * 4 + 1];  // B
    }
    fs.writeFileSync(path.join(OUT, `${name}.expected.raw`), rgb);
    row.oracle = `bmp-js ${d.width}x${d.height} bpp=${d.bitPP}`;
  } catch (e) {
    // Expected for gdi-16bpp-565: bmp-js has no BI_BITFIELDS support.
    const stale = path.join(OUT, `${name}.expected.raw`);
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
    row.oracle = `NONE — bmp-js declined (${String(e.message).slice(0, 40)})`;
  }
  rows.push(row);
}

for (const r of rows) {
  console.log(`${r.name.padEnd(18)} ${String(r.bytes).padStart(5)}B  sha256 ${r.sha.slice(0, 12)}…  ${r.oracle}`);
}
