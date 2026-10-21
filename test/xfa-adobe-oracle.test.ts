// test/xfa-adobe-oracle.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, type PdfDict, type PdfObject } from '../src/types.js';
import { decodeXfaPackets } from '../src/xfapacket.js';
import { decodeStream } from '../src/filters.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import { parseXfaDatasets, parseXfaDataGroups } from '../src/xfadata.js';
import { layoutPages, type XfaLayoutResult } from '../src/xfapage.js';
import { xfaFieldLines, xfaMeasurer } from '../src/xfaconvert.js';
import { ADOBE_PROBES, adobeGoldens, loadAdobeProbe, type AdobeFrag, type AdobeProbe } from './helpers/xfa-adobe.js';

/**
 * The Adobe Reader oracle for splitting: a positioned subform (164g.11, t3-t26)
 * and an lr-tb or table (164g.12, t27-t39). Field splitting is t40-t54
 * (164g.13); adhesion and keep intact="pageArea" are t55-t72 (164g.14) -- t65's
 * field D splits directly under the content area (164g.27). Overflow and break leaders and trailers are t73-t90
 * (164g.15); an lr-tb item that is itself a splittable subform is t122-t126
 * (164g.25); `<bookend>` leaders and trailers are t160-t176 (164g.29); the leader and trailer
 * shapes 164g.15 refused are t177-t186 (164g.31). Each probe in
 * test/fixtures/xfa-adobe/ is converted from its template and compared, field
 * by field, with the layout Adobe Reader 26.1 reported for it; a probe's draws
 * have no widget, so they are compared through our layout of the template.
 *
 * Its ceiling: one producer, one version, hand-transcribed numbers.
 */
const g = adobeGoldens();
/** US Letter; every probe's content area sits at (0.5in, 0.5in). */
const PAGE_H = 792;
const ORIGIN = 36;
const TOL = 0.05;
/** A dotted path to our SOM name: `[0]` on every segment that states no index
 *  of its own (164g.15: a leader copy is `H[1]`). */
const som = (path: string): string => path.split('.').map((s) => (s.endsWith(']') ? s : `${s}[0]`)).join('.');

interface TopBox { page: number; x: number; y: number; w: number; h: number }

/** The subforms whose fragments position `path`, outermost first and `form1`
 *  excluded: its dotted ancestors, except where `layoutParent` says Adobe laid
 *  a node out somewhere else (164g.15, t83). */
function ancestorsOf(probe: AdobeProbe, path: string): string[] {
  const at = path.lastIndexOf('.');
  if (at < 0) return [];
  const parent = probe.layoutParent?.[path] ?? path.slice(0, at);
  return parent.includes('.') ? [...ancestorsOf(probe, parent), parent] : [];
}
/** A node's box, top-down from the page's top-left: its own fragment plus, on
 *  the same page, every ancestor subform's fragment and content inset. */
function boxOf(probe: AdobeProbe, path: string, f: AdobeFrag): TopBox | string {
  const [page, fx, fy, w, h] = f;
  if (probe.absolute) return { page, x: ORIGIN + fx, y: ORIGIN + fy, w, h };
  let x = ORIGIN + fx;
  let y = ORIGIN + fy;
  for (const anc of ancestorsOf(probe, path)) {
    const frag = probe.subforms[anc]?.find((a) => a[0] === page);
    if (!frag) return `${anc} has no fragment on page ${String(page)}`;
    const [l, t] = probe.insets?.[anc] ?? [0, 0];
    x += frag[1] + l;
    y += frag[2] + t;
  }
  return { page, x, y, w, h };
}

/** Our layout of a probe's template, measured as the converter measures it. */
function laidOut(name: string): XfaLayoutResult {
  const doc = Document.Open(loadAdobeProbe(name));
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const set = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
  if ('reason' in set) throw new Error(set.reason);
  const datasets = set.packets.get('datasets');
  const tpl = parseXfaTemplate(set.packets.get('template')!, parseXfaDataGroups(datasets));
  const values = datasets ? parseXfaDatasets(datasets) : new Map<string, string | string[]>();
  // As the converter lays it out, field-line counter included: without it no
  // field splits, and t82's trailer, which a split lays down, is not placed.
  return layoutPages(tpl.body!, xfaMeasurer(doc, tpl, values), [], xfaFieldLines(doc, tpl, values).grid);
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
        /** A field's widgets: its /Kids, or the merged dict itself. */
        const widgetsOf = (d: PdfDict): PdfDict[] => {
          const kids = doc.resolve(d.get('Kids'));
          return Array.isArray(kids) ? kids.map((k) => doc.resolve(k) as PdfDict) : [d];
        };
        const pageOf = (w: PdfDict): number => doc.Pages.findIndex((pg) => ((doc.resolve(pg.Dict.get('Annots')) ?? []) as PdfObject[])
          .some((a) => doc.resolve(a) === w)) + 1;
        const widgets = new Map(doc.Form.Fields.map((fld) => [fld.FullName,
          widgetsOf(fld.Dict).map((w) => ({ page: pageOf(w), rect: doc.resolve(w.get('Rect')) as number[] }))
            .sort((a, b) => a.page - b.page)]));
        const wrong: string[] = [];
        for (const [path, frags] of Object.entries(probe.fields).filter(([q]) => !probe.only || probe.only.includes(q))) {
          const got = widgets.get(som(path)) ?? [];
          if (got.length !== frags.length) { wrong.push(`${path}: ${String(frags.length)} fragments, ${String(got.length)} widgets`); continue; }
          frags.forEach((frag, i) => {
            const b = boxOf(probe, path, frag);
            if (typeof b === 'string') { wrong.push(`${path}: ${b}`); return; }
            const want = { page: b.page, rect: [b.x, PAGE_H - b.y - b.h, b.x + b.w, PAGE_H - b.y] };
            const g2 = got[i];
            if (probe.fieldBoxes ? g2.page !== want.page
              : g2.page !== want.page || g2.rect.some((v, k) => Math.abs(v - want.rect[k]) > TOL))
              wrong.push(`${path}#${String(i)}: want p${String(want.page)} [${want.rect.join(' ')}], got p${String(g2.page)} [${g2.rect.join(' ')}]`);
          });
        }
        expect(wrong).toEqual([]);
      });
      if (probe.fieldBoxes) {
        it("puts every field's box on Adobe's page and box", () => {
          const laid = laidOut(name);
          const wrong: string[] = [];
          for (const [path, frags] of Object.entries(probe.fields)) {
            frags.forEach((frag, i) => {
              const want = boxOf(probe, path, frag);
              if (typeof want === 'string') { wrong.push(`${path}: ${want}`); return; }
              const hits = (laid.pages[want.page - 1]?.nodes ?? [])
                .filter((n) => n.node.kind === 'field' && n.node.field === som(path) && 'box' in n);
              if (hits.length !== 1) { wrong.push(`${path}#${String(i)}: ${String(hits.length)} placed on page ${String(want.page)}`); return; }
              const got = (hits[0] as { box: { x: number; y: number; w: number; h: number } }).box;
              if ([got.x - want.x, got.y - want.y, got.w - want.w, got.h - want.h].some((d) => Math.abs(d) > TOL))
                wrong.push(`${path}#${String(i)}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
            });
          }
          expect(wrong).toEqual([]);
        });
      }
      if (probe.draws) {
        it("puts every draw on Adobe's page and box", () => {
          const laid = laidOut(name);
          expect(laid.pages.length).toBe(probe.pages);
          const wrong: string[] = [];
          for (const [path, frags] of Object.entries(probe.draws!).filter(([q]) => !probe.only || probe.only.includes(q))) {
            const want = boxOf(probe, path, frags[0]);
            if (typeof want === 'string') { wrong.push(`${path}: ${want}`); continue; }
            // A draw's layout label is its bare name, with no occurrence index.
            const label = path.split('.').pop()!;
            const hits = (laid.pages[want.page - 1]?.nodes ?? [])
              .filter((n) => n.node.kind === 'draw' && n.node.label === label && 'box' in n);
            if (hits.length !== 1) { wrong.push(`${path}: ${String(hits.length)} placed draws labelled ${label} on page ${String(want.page)}`); continue; }
            const got = (hits[0] as { box: { x: number; y: number; w: number; h: number } }).box;
            if ([got.x - want.x, got.y - want.y, got.w - want.w, got.h - want.h].some((d) => Math.abs(d) > TOL))
              wrong.push(`${path}: want p${String(want.page)} ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
          }
          expect(wrong).toEqual([]);
        });
      }
    } else {
      const under = `${som(probe.refusedUnder ?? 'form1.pos')}.`;
      it(`refuses the split subform's fields, naming ${String(probe.reason)}`, () => {
        const hits = report.skipped.filter((s) => s.what === 'field' && s.name?.startsWith(under));
        expect(hits.length).toBeGreaterThan(0);
        for (const h of hits) expect(h.reason).toContain(String(probe.reason));
      });
    }
  });
}
