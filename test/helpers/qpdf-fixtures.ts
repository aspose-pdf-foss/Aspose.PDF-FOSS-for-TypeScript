import { buildClassicPdf } from './build-pdf.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../../src/document.js';
import { PdfObject } from '../../src/types.js';

const dir = join('test', 'fixtures', 'qpdf');

/** One incremental-save shape that qpdf inspects offline and the suite pins.
 *
 *  The generator and the test both build from THIS list, which is what makes a
 *  golden mean anything: the bytes the test compares are provably the bytes
 *  qpdf was shown. A second case list is how a golden comes to attest to
 *  something no test produces. */
export interface QpdfFixture {
  /** File stem under `test/fixtures/qpdf/`. */
  name: string;
  /** What this shape covers that nothing else does. */
  covers: string;
  build(): Uint8Array;
}

/** The live object map, for the one fixture that needs to free an object —
 *  no public API deletes an object number (`RemovePage` only orphans). */
const liveOf = (doc: Document): Map<number, PdfObject> =>
  (doc as unknown as { objects: Map<number, PdfObject> }).objects;

export const QPDF_FIXTURES: QpdfFixture[] = [
  {
    name: 'base',
    covers: 'the control: an unmodified classic file, so a qpdf complaint about '
      + 'an appended file cannot be blamed on the base',
    build: () => buildClassicPdf(2),
  },
  {
    name: 'one-edit',
    covers: 'a single replaced object appended, the ordinary shape',
    build: () => {
      const doc = Document.Open(buildClassicPdf(2));
      doc.Pages[0].Dict.set('Rotate', 90);
      return doc.Save({ incremental: true });
    },
  },
  {
    name: 'freed-object',
    covers: 'an `f` entry — the one thing our own reader provably cannot check, '
      + 'because readXref drops free entries (2yvi)',
    build: () => {
      const doc = Document.Open(buildClassicPdf(2));
      const orphan = doc.Pages[1].Dict;
      let num = -1;
      for (const [n, v] of liveOf(doc)) if (v === orphan) num = n;
      doc.RemovePage(2);
      liveOf(doc).delete(num);
      return doc.Save({ incremental: true });
    },
  },
  {
    name: 'classic-onto-xref-stream',
    covers: 'a classic appended section chaining /Prev to a cross-reference '
      + 'STREAM, which CLAUDE.md documents as legal and nothing else verifies',
    build: () => {
      const base = Document.Open(buildClassicPdf(2)).Save({ compressed: true });
      const doc = Document.Open(base);
      doc.Pages[0].Dict.set('Rotate', 180);
      return doc.Save({ incremental: true });
    },
  },
  {
    name: 'encrypted-preserved',
    covers: 'a document opened encrypted and saved again, checked by a reader that '
      + 'is not ours -- the only external check on the encryption work',
    build: () => {
      // Read from a COMMITTED input rather than building one: buildEncryptedPdf
      // generates a random /ID per call, and /ID[0] is hashed into the R<=4 file
      // key -- so a built base would differ every run and byte-identity could
      // not be a fence at all.
      const base = new Uint8Array(readFileSync(join(dir, 'encrypted-base.pdf')));
      return Document.Open(base).Save();
    },
  },
];
