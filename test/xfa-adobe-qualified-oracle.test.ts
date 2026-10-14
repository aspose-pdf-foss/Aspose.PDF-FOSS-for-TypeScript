// test/xfa-adobe-qualified-oracle.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PdfObject } from '../src/types.js';
import { QUALIFIED_PROBES, qualifiedGoldens, loadAdobeProbe } from './helpers/xfa-adobe.js';

/**
 * The Adobe Reader oracle for qualified pagination (164g.9): each probe in
 * test/fixtures/xfa-adobe/ converted from its template, and the page area of
 * every created page -- read back from the AREA-X marker its master chrome
 * paints -- and the page of every field compared with what Reader 26.1
 * reported. A probe Reader could not lay out must be refused by name.
 *
 * Its ceiling: one producer, one version, hand transcription, on-screen layout.
 */
const g = qualifiedGoldens();

for (const name of QUALIFIED_PROBES) {
  const probe = g.probes[name];
  describe(`Adobe qualified oracle: ${name}`, () => {
    const src = Document.Open(loadAdobeProbe(name));
    const report = src.ConvertXfaToAcroForm();
    const doc = Document.Open(src.Save());

    if (probe.expect === 'match') {
      it("lays out Adobe's page areas, page by page", () => {
        const got = doc.Pages.map((pg) => /AREA-(\w+)/.exec(pg.GetText())?.[1] ?? '?');
        expect(got).toEqual(probe.areas);
      });
      it("puts every field on Adobe's page", () => {
        const pageOf = new Map(doc.Form.Fields.map((fld) => [fld.FullName, 1 + doc.Pages.findIndex((pg) =>
          ((doc.resolve(pg.Dict.get('Annots')) ?? []) as PdfObject[]).some((a) => doc.resolve(a) === fld.Dict))]));
        const got = Object.fromEntries(Object.keys(probe.fields).map((f) => [f, pageOf.get(f)]));
        expect(got).toEqual(probe.fields);
      });
    } else {
      it(`refuses what Reader could not lay out, citing "${String(probe.reason)}"`, () => {
        for (const f of Object.keys(probe.fields)) {
          const hit = report.skipped.find((s) => s.what === 'field' && s.name === f);
          expect(hit?.reason, f).toContain(String(probe.reason));
        }
      });
    }
  });
}
