import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { isDict } from '../src/types.js';

// 164g.4: chrome is painted only on pages the converter CREATES. A hybrid's
// pages carry Designer's rendering already; painting again draws every label
// twice. So converting a hybrid must leave each page's content byte-identical.
const HYBRIDS = ['irs-f1040.pdf', 'irs-fw9.pdf', 'uscis-i130.pdf', 'uscis-i765.pdf', 'dod-dd1155.pdf', 'dod-dd1391.pdf'];
const load = (f: string) => Document.Open(new Uint8Array(readFileSync(`test/fixtures/xfa/${f}`)));
const contentHash = (doc: Document) => doc.Pages.map((p) => createHash('sha256').update(p.Contents).digest('hex'));

/** `/AcroForm /Fields` emptied, as `test/xfa-real.test.ts` does: the converter
 *  then CREATES every field on the hybrid's own pages, the shape most likely
 *  to tempt it into painting. It is also the only way to convert DD 1155,
 *  which carries a signature field and is refused as it stands. */
function stripped(f: string): Document {
  const doc = load(f);
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (isDict(acro)) acro.set('Fields', []);
  for (const p of doc.Pages) p.Dict.delete('Annots');
  doc.markModified();
  return Document.Open(doc.Save());
}

describe('hybrid pages are untouched by chrome (164g.4)', () => {
  for (const f of HYBRIDS) {
    if (f !== 'dod-dd1155.pdf') {
      it(`${f}, as published`, () => {
        const doc = load(f);
        const before = contentHash(doc);
        const r = doc.ConvertXfaToAcroForm();
        expect(r.chromePages).toBe(0);
        expect(contentHash(doc)).toEqual(before);
      });
    }
    it(`${f}, its fields stripped`, () => {
      const doc = stripped(f);
      const before = contentHash(doc);
      const r = doc.ConvertXfaToAcroForm();
      expect(r.fields.some((x) => x.route === 'positioned')).toBe(true);
      expect(r.chromePages).toBe(0);
      expect(contentHash(doc)).toEqual(before);
    });
  }
});
