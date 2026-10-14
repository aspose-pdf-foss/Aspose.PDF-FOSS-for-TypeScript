// test/xfa-adobe-oracle.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PdfObject } from '../src/types.js';
import { ADOBE_PROBES, adobeGoldens, loadAdobeProbe, type AdobeFrag, type AdobeProbe } from './helpers/xfa-adobe.js';

/**
 * The Adobe Reader oracle for splitting a positioned subform (164g.11): each
 * probe in test/fixtures/xfa-adobe/ converted from its template and compared,
 * field by field, with the layout Adobe Reader 26.1 reported for it.
 *
 * Its ceiling: one producer, one version, hand-transcribed numbers.
 */
const g = adobeGoldens();
/** US Letter; every probe's content area sits at (0.5in, 0.5in). */
const PAGE_H = 792;
const ORIGIN = 36;
const TOL = 0.05;
const som = (path: string): string => path.split('.').map((s) => `${s}[0]`).join('.');

/** A field's expected rect in PDF space: its own fragment plus, on the same
 *  page, every ancestor subform's fragment and content inset. */
function expected(probe: AdobeProbe, path: string, f: AdobeFrag): { page: number; rect: number[] } | string {
  const [page, fx, fy, w, h] = f;
  let x = ORIGIN + fx;
  let y = ORIGIN + fy;
  const parts = path.split('.');
  for (let i = 2; i < parts.length; i++) {
    const anc = parts.slice(0, i).join('.');
    const frag = probe.subforms[anc]?.find((a) => a[0] === page);
    if (!frag) return `${anc} has no fragment on page ${String(page)}`;
    const [l, t] = probe.insets?.[anc] ?? [0, 0];
    x += frag[1] + l;
    y += frag[2] + t;
  }
  return { page, rect: [x, PAGE_H - y - h, x + w, PAGE_H - y] };
}

for (const name of ADOBE_PROBES) {
  const probe = g.probes[name];
  describe(`Adobe oracle: ${name}`, () => {
    const src = Document.Open(loadAdobeProbe(name));
    const report = src.ConvertXfaToAcroForm();
    const doc = Document.Open(src.Save());

    if (probe.expect === 'match') {
      it("produces Adobe's page count", () => {
        expect(doc.Pages.length).toBe(probe.pages);
      });
      it("puts every field on Adobe's page and box", () => {
        const widgets = new Map(doc.Form.Fields.map((fld) => {
          const page = doc.Pages.findIndex((pg) => ((doc.resolve(pg.Dict.get('Annots')) ?? []) as PdfObject[])
            .some((a) => doc.resolve(a) === fld.Dict));
          return [fld.FullName, { page: page + 1, rect: doc.resolve(fld.Dict.get('Rect')) as number[] }];
        }));
        const wrong: string[] = [];
        for (const [path, frags] of Object.entries(probe.fields)) {
          const want = expected(probe, path, frags[0]);
          const got = widgets.get(som(path));
          if (typeof want === 'string') { wrong.push(`${path}: ${want}`); continue; }
          if (!got || got.page !== want.page || got.rect.some((v, i) => Math.abs(v - want.rect[i]) > TOL))
            wrong.push(`${path}: want p${String(want.page)} [${want.rect.join(' ')}], got ${got ? `p${String(got.page)} [${got.rect.join(' ')}]` : 'nothing'}`);
        }
        expect(wrong).toEqual([]);
      });
    } else {
      it(`refuses the positioned subform's fields, naming ${String(probe.reason)}`, () => {
        const hits = report.skipped.filter((s) => s.what === 'field' && s.name?.startsWith('form1[0].pos[0].'));
        expect(hits.length).toBeGreaterThan(0);
        for (const h of hits) expect(h.reason).toContain(String(probe.reason));
      });
    }
  });
}
