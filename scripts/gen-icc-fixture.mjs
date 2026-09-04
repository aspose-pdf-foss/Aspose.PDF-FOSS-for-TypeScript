// Author the synthetic CMYK ICC profile `test/fixtures/icc/` holds, and
// generate its goldens by driving Windows Color System.
//
// The profile is AUTHORED rather than vendored: `RSWOP.icm` is "Copyright (c)
// 2000 Microsoft Corporation" with no licence grant, and unlike a golden table
// our engine needs profile bytes at TEST time, so vendoring would cost the
// suite its hermeticity. WCS reads what we wrote — it must both accept the
// profile and agree with our transform through it.
//
// Deterministic: no clock is read, so re-running produces byte-identical
// output. Not run by `npm test`; see test/fixtures/icc/PROVENANCE.md.
//
// Usage: npm run gen:icc
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test', 'fixtures', 'icc');
const profilePath = join(outDir, 'synthetic-cmyk.icc');
const goldenPath = join(outDir, 'goldens.json');

const be32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); return b; };
const beu32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const beu16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v & 0xffff); return b; };
const sig = (s) => Buffer.from(s, 'latin1');
const s15 = (v) => be32(Math.round(v * 65536));

const xyzTag = (x, y, z) =>
  Buffer.concat([sig('XYZ '), beu32(0), s15(x), s15(y), s15(z)]);

const textTag = (s) =>
  Buffer.concat([sig('text'), beu32(0), Buffer.from(s + '\0', 'latin1')]);

/** v2 textDescriptionType: an ascii block, then unicode and scriptcode ones. */
function descTag(s) {
  const ascii = Buffer.from(s + '\0', 'latin1');
  return Buffer.concat([
    sig('desc'), beu32(0),
    beu32(ascii.length), ascii,
    beu32(0), beu32(0),            // unicode language code, count
    beu16(0), Buffer.from([0]),    // scriptcode code, count
    Buffer.alloc(67),              // macintosh description
  ]);
}

/**
 * lut16Type ('mft2'). `clut` is flat uint16, `grid ** inCh` entries of `outCh`
 * values, with the FIRST input channel varying SLOWEST.
 */
function mft2(inCh, outCh, grid, inTables, clut, outTables) {
  const matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1].map(s15);
  const parts = [
    sig('mft2'), beu32(0),
    Buffer.from([inCh, outCh, grid, 0]),
    ...matrix,
    beu16(inTables[0].length), beu16(outTables[0].length),
  ];
  for (const t of inTables) parts.push(Buffer.concat(t.map(beu16)));
  parts.push(Buffer.concat(clut.map(beu16)));
  for (const t of outTables) parts.push(Buffer.concat(t.map(beu16)));
  return Buffer.concat(parts);
}

const ramp = (n) => Array.from({ length: n }, (_, i) => Math.round(i * 65535 / (n - 1)));
const q16 = (v) => Math.round(Math.max(0, Math.min(1, v)) * 65535);

// The B2A pipeline, Lab -> CMYK, and the reason the whole fixture works.
//
// The CLUT is an AFFINE function of the grid coordinates:
//
//   C = 0.10 + 0.40*l   M = 0.20 + 0.30*a   Y = 0.30 + 0.20*b   K = 0.05 + 0.10*l
//
// With a 2x2x2 grid an affine function has no cross terms, so TRILINEAR and
// TETRAHEDRAL interpolation agree exactly — which is what lets the golden
// comparison be exact rather than tolerant. Each output also depends on ONE
// input, so a transposed CLUT walk is visible: read the axes in the wrong
// order and moving `a` moves C rather than M.
const B2A_GRID = 2;
const b2aClut = [];
for (let l = 0; l < B2A_GRID; l++) {
  for (let a = 0; a < B2A_GRID; a++) {
    for (let b = 0; b < B2A_GRID; b++) {
      b2aClut.push(q16(0.10 + 0.40 * l), q16(0.20 + 0.30 * a),
                   q16(0.30 + 0.20 * b), q16(0.05 + 0.10 * l));
    }
  }
}
const b2a0 = mft2(3, 4, B2A_GRID,
  [ramp(2), ramp(2), ramp(2)], b2aClut,
  [ramp(2), ramp(2), ramp(2), ramp(2)]);

// A trivial A2B, CMYK -> Lab. Its values do not matter — only its presence,
// which ICC requires of an output profile.
const a2bClut = [];
for (let i = 0; i < 2 ** 4; i++) a2bClut.push(32768, 32768, 32768);
const a2b0 = mft2(4, 3, 2,
  [ramp(2), ramp(2), ramp(2), ramp(2)], a2bClut,
  [ramp(2), ramp(2), ramp(2)]);

// A gamut tag: Lab in, ONE output, 0 meaning in gamut.
const gamt = mft2(3, 1, 2, [ramp(2), ramp(2), ramp(2)],
  Array.from({ length: 8 }, () => 0), [ramp(2)]);

// ICC requires an N-component LUT-based OUTPUT profile to carry all three
// intents plus a gamut tag. WCS enforces it: with A2B0 and B2A0 alone it
// reports ERROR_INVALID_PROFILE (2011) and refuses to build a transform.
// Measured, not assumed — this is the finding that shaped the fixture.
const tags = [
  ['desc', descTag('Synthetic affine CMYK test profile')],
  ['cprt', textTag('Public domain test fixture')],
  ['wtpt', xyzTag(0.9642, 1.0, 0.8249)],
  ['A2B0', a2b0], ['A2B1', a2b0], ['A2B2', a2b0],
  ['B2A0', b2a0], ['B2A1', b2a0], ['B2A2', b2a0],
  ['gamt', gamt],
];

const headerSize = 128;
let offset = headerSize + 4 + tags.length * 12;
const entries = [];
const blobs = [];
for (const [name, data] of tags) {
  const pad = (4 - (data.length % 4)) % 4;
  entries.push([name, offset, data.length]);
  blobs.push(data, Buffer.alloc(pad));
  offset += data.length + pad;
}

const header = Buffer.alloc(128);
header.writeUInt32BE(offset, 0);
sig('none').copy(header, 4);
header.writeUInt32BE(0x02400000, 8);       // v2.4
sig('prtr').copy(header, 12);
sig('CMYK').copy(header, 16);
sig('Lab ').copy(header, 20);
// A FIXED date, so the output is byte-identical on every run.
header.writeUInt16BE(2026, 24); header.writeUInt16BE(9, 26); header.writeUInt16BE(4, 28);
sig('acsp').copy(header, 36);
sig('MSFT').copy(header, 40);
header.writeUInt32BE(0, 64);               // perceptual
s15(0.9642).copy(header, 68);
s15(1.0).copy(header, 72);
s15(0.8249).copy(header, 76);

const table = Buffer.concat([
  beu32(tags.length),
  ...entries.map(([n, o, s]) => Buffer.concat([sig(n), beu32(o), beu32(s)])),
]);
const profile = Buffer.concat([header, table, ...blobs]);
if (profile.length !== offset) throw new Error(`size ${profile.length} != ${offset}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(profilePath, profile);
const sha256 = createHash('sha256').update(profile).digest('hex');
console.log(`wrote ${profilePath} (${profile.length} bytes, sha256 ${sha256.slice(0, 16)}…)`);

// --- goldens -----------------------------------------------------------

// The eight cube corners, mid grey, and a deterministic scatter.
const samples = [
  [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 255, 255],
  [128, 128, 128],
];
for (let i = 0; i < 20; i++) {
  // A fixed low-discrepancy scatter: no RNG, so the list never moves.
  const f = (n, base) => Math.round(255 * ((n * base) % 1));
  samples.push([f(i + 1, 0.618034), f(i + 1, 0.381966), f(i + 1, 0.754878)]);
}

const stdin = samples.map((s) => s.join(',')).join('\n');
const psScript = join(here, 'gen-icc-goldens.ps1');
const raw = execFileSync('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-Profile', profilePath,
], { input: stdin, encoding: 'utf8' });

const out = [];
for (const line of raw.split(/\r?\n/)) {
  const t = line.trim();
  if (!t) continue;
  const n = t.split(',').map(Number);
  if (n.length !== 7 || n.some(Number.isNaN)) throw new Error(`bad line: ${t}`);
  out.push({
    rgb: [n[0], n[1], n[2]],
    // Divide HERE rather than in PowerShell: this machine's locale formats
    // decimals with a comma, so a float crossing that boundary arrives as
    // "0,5000" and parses to NaN.
    cmyk: [n[3] / 65535, n[4] / 65535, n[5] / 65535, n[6] / 65535],
  });
}
if (out.length !== samples.length) {
  throw new Error(`got ${out.length} goldens for ${samples.length} samples`);
}

writeFileSync(goldenPath, JSON.stringify({
  profile: 'synthetic-cmyk.icc',
  sha256,
  source: 'Windows Color System (mscms.dll) via scripts/gen-icc-goldens.ps1',
  sourceProfile: 'sRGB Color Space Profile.icm (Windows)',
  intent: 0,
  samples: out,
}, null, 2) + '\n');
console.log(`wrote ${goldenPath} (${out.length} samples)`);
