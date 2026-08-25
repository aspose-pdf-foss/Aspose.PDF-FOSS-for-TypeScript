// Generates test/fixtures/corrupt/*.pdf — damaged real-world PDFs for the
// recovery suite (issue dxfk.4), plus the provenance figures that describe them.
//
// Unlike every other fixture directory, these are not third-party binaries in
// the usual sense: a corrupt file has no producer. What is third-party is the
// *source*. Damaging a builder-made PDF proves only that our reader survives
// our own writer's layout, so the sources here come from Ghostscript and qpdf,
// and the damage is applied to their bytes.
//
// The one-off qpdf step (its output is committed, so this is only needed to
// regenerate from scratch):
//
//   qpdf --object-streams=generate --compress-streams=y \
//     test/fixtures/pdfx/ghostscript-x3-noicc.pdf \
//     test/fixtures/corrupt/qpdf-objstm-source.pdf
//
// Then:
//
//   npm i --no-save tsx
//   npx tsx scripts/gen-corrupt-fixtures.ts
//
// Not part of `npm test`. Re-running it must reproduce the committed SHA-256s
// in test/fixtures/corrupt/PROVENANCE.md byte for byte; if it does not, the
// damage functions drifted and the provenance is stale.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  corruptStartxref, destroyTrailer, prependBytes, truncateTail, corruptObjStmPayload,
} from '../test/helpers/damage-pdf.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'fixtures', 'corrupt');

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const CLASSIC = join(ROOT, 'test', 'fixtures', 'pdfx', 'ghostscript-x3-noicc.pdf');
const OBJSTM = join(OUT, 'qpdf-objstm-source.pdf');

/** The junk prepended to shift a classic table's offsets. A PDF comment, so the
 *  bytes are legal at file scope and the only fault is that every offset in the
 *  xref table is now `shift` too small. */
const JUNK = '%X-Junk-Header 1\r\n';

interface Fixture {
  name: string;
  source: string;
  /** Human description of the damage, for PROVENANCE.md. */
  damage: string;
  apply: (b: Uint8Array) => Uint8Array;
}

const FIXTURES: Fixture[] = [
  {
    name: 'gs-x3-startxref-past-eof.pdf',
    source: CLASSIC,
    damage: `startxref value replaced with (file length + 5000), pointing past EOF. `
      + `Byte length unchanged except for the digits of the offset.`,
    apply: (b) => corruptStartxref(b),
  },
  {
    name: 'gs-x3-trailer-keyword-destroyed.pdf',
    source: CLASSIC,
    damage: `the last "trailer" keyword overwritten with "#######" in place. `
      + `Byte length unchanged; the trailer dict itself is untouched and still `
      + `findable by the sweep.`,
    apply: (b) => destroyTrailer(b),
  },
  {
    name: 'gs-x3-offsets-shifted.pdf',
    source: CLASSIC,
    damage: `${JSON.stringify(JUNK)} prepended, shifting every byte in the file by `
      + `${JUNK.length}. The xref table and startxref are otherwise untouched, so `
      + `every offset they hold is now ${JUNK.length} too small.`,
    apply: (b) => prependBytes(b, JUNK),
  },
  {
    name: 'gs-x3-truncated-mid-stream.pdf',
    source: CLASSIC,
    damage: `last 30% of the file removed, which takes the xref table, the trailer, `
      + `and the tail of the last content stream with it.`,
    apply: (b) => truncateTail(b, Math.floor(b.length * 0.30)),
  },
  {
    name: 'qpdf-objstm-payload-damaged.pdf',
    source: OBJSTM,
    damage: `the last 10% of the /ObjStm payload overwritten with 0x5A ("Z") in `
      + `place. Byte length unchanged, so every xref offset stays valid and the `
      + `container is the only damage in the file.`,
    apply: (b) => corruptObjStmPayload(b, 0.9),
  },
];

const rows: string[] = [];
for (const f of FIXTURES) {
  const src = new Uint8Array(readFileSync(f.source));
  const out = f.apply(src);
  writeFileSync(join(OUT, f.name), out);
  rows.push([
    `### ${f.name}`,
    '',
    `**Source:** \`${f.source.slice(ROOT.length + 1).replace(/\\/g, '/')}\``,
    `(${src.length} bytes, SHA-256 \`${sha(src)}\`)`,
    '',
    `**Damage:** ${f.damage}`,
    '',
    `**Result:** ${out.length} bytes, SHA-256 \`${sha(out)}\``,
    '',
  ].join('\n'));
  process.stdout.write(`${f.name}\n  in  ${src.length}B ${sha(src)}\n  out ${out.length}B ${sha(out)}\n`);
}

process.stdout.write('\n--- paste into PROVENANCE.md ---\n\n');
process.stdout.write(rows.join('\n'));
