import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, type PdfObject } from '../src/types.js';
import { decodePdfText } from '../src/metadata.js';
import {
  CHROME_FILES, chromeGoldens, loadDynamicPdf, loadMasterPdf, type GoldenBorder, type GoldenText, type MasterFile,
} from './helpers/xfa-dynamic.js';

/**
 * The pdf.js oracle for chrome (164g.4): pdf.js 6.3.289's XFA engine rendered
 * into headless Chrome (`npm run gen:xfa`). Structural, not pixels -- pdf.js
 * shapes text with browser fonts, so only MEMBERSHIP (which glyphs fall in a
 * box) and box geometry are compared.
 *
 * Its ceiling: pdf.js is a reimplementation, not Adobe -- evidence, not
 * conformance.
 */
const g = chromeGoldens();
const load = (f: string) => Document.Open(f === 'opm1644.pdf' ? loadDynamicPdf() : loadMasterPdf(f as MasterFile));
/** Points. Chrome's 1/64-px layout units accumulate down a page, well under 1pt. */
const TOL = 1;
const DEBUG = process.env.XFA_CHROME_DEBUG === '1';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const allSolid = (b: GoldenBorder) => b.styles.every((s) => s === 'solid') && b.widths.every((w) => w > 0);
/** What Chrome reports for a CSS border of width w at device-pixel ratio 1:
 *  a border is snapped to whole device pixels, and one below a pixel is
 *  drawn as one. pdf.js writes our points as px, so 0.5pt reads back as 1. */
const chromeWidth = (w: number) => (w < 1 ? 1 : Math.floor(w));

/** Pinned exactly. Raise only in the issue that changes it. Every text miss
 *  is a leaf `report.skipped` names (see PROVENANCE); the two OPM border
 *  misses sit below Q1, which pdf.js lays out 2.5pt shorter than we do. */
const MATCHED_TEXT: Record<string, number> = { 'opm1644.pdf': 49, 'dod-dd2875.pdf': 74, 'dod-dd1494.pdf': 268 };
const MATCHED_BORDERS: Record<string, number> = { 'opm1644.pdf': 46, 'dod-dd2875.pdf': 62, 'dod-dd1494.pdf': 53 };
const BUTTON_CAPTIONS: Record<string, number> = { 'opm1644.pdf': 3, 'dod-dd2875.pdf': 0, 'dod-dd1494.pdf': 24 };

for (const file of CHROME_FILES) {
  describe(`chrome oracle: ${file}`, () => {
    const gold = g.files[file];
    const src = load(file);
    const report = src.ConvertXfaToAcroForm();
    const doc = Document.Open(src.Save());

    it("produces pdf.js's page count, every page painted", () => {
      expect(doc.Pages.length).toBe(gold.pages);
      expect(report.chromePages).toBe(gold.pages);
    });

    // A push button's caption is its FACE -- the widget's /MK /CA and /AP,
    // never page content -- so those are checked on the widget instead.
    const buttons = doc.Form.Fields.filter((f) => f.Type === 'pushbutton').map((f) => {
      const page = doc.Pages.findIndex((pg) => ((doc.resolve(pg.Dict.get('Annots')) ?? []) as PdfObject[])
        .some((a) => doc.resolve(a) === f.Dict));
      const mk = doc.resolve(f.Dict.get('MK'));
      const ca = isDict(mk) ? mk.get('CA') : undefined;
      return { page: page + 1, rect: doc.resolve(f.Dict.get('Rect')) as number[],
        ca: ca === undefined ? '' : decodePdfText((ca as { bytes: Uint8Array }).bytes) };
    });
    const buttonAt = (t: GoldenText) => {
      const h = doc.Pages[t.page - 1].MediaBox[3];
      const cx = t.x + t.w / 2;
      const cy = h - (t.y + t.h / 2);
      return buttons.find((b) => b.page === t.page && cx >= b.rect[0] && cx <= b.rect[2] && cy >= b.rect[1] && cy <= b.rect[3]);
    };

    it("carries pdf.js's push-button captions as the button's /MK /CA", () => {
      const onButtons = gold.texts.filter((t) => t.kind === 'caption' && buttonAt(t) !== undefined);
      const wrong = onButtons.filter((t) => norm(buttonAt(t)!.ca) !== t.text).map((t) => `"${t.text}" got "${buttonAt(t)!.ca}"`);
      expect(wrong).toEqual([]);
      expect(onButtons.length).toBe(BUTTON_CAPTIONS[file]);
    });

    it("spells pdf.js's text inside each draw and caption box", () => {
      let matched = 0;
      const misses: string[] = [];
      const frags = doc.Pages.map((p) => p.GetTextFragments());
      const texts = gold.texts.filter((t) => !(t.kind === 'caption' && buttonAt(t) !== undefined));
      for (const t of texts) {
        const h = doc.Pages[t.page - 1].MediaBox[3];
        const inside = frags[t.page - 1].filter((fr) => {
          const cx = (fr.quad[0] + fr.quad[2]) / 2;
          const cy = h - (fr.quad[1] + fr.quad[3]) / 2;
          return cx >= t.x - TOL && cx <= t.x + t.w + TOL && cy >= t.y - TOL && cy <= t.y + t.h + TOL;
        });
        const ours = norm(inside.map((fr) => fr.text).join(' '));
        // Spaces are not compared: pdf.js wraps with browser metrics, so a
        // line break -- and the space it swallows -- may fall elsewhere.
        if (norm(ours.replace(/\s/g, '')) === norm(t.text.replace(/\s/g, ''))) matched += 1;
        else misses.push(`p${String(t.page)} ${t.kind} [${String(t.x)},${String(t.y)} ${String(t.w)}x${String(t.h)}] "${t.text}" got "${ours}"`);
      }
      if (DEBUG) console.log(file, 'text misses:\n' + misses.join('\n'));
      expect({ matched, of: texts.length }).toEqual({ matched: MATCHED_TEXT[file], of: texts.length });
    });

    it('strokes every side where pdf.js draws a solid border', () => {
      let matched = 0;
      const misses: string[] = [];
      const solid = gold.borders.filter(allSolid);
      const paths = doc.Pages.map((p) => p.GetPaths());
      for (const b of solid) {
        const h = doc.Pages[b.page - 1].MediaBox[3];
        // Each stroked path's OUTER extent, top-down, beside its width.
        const outer = paths[b.page - 1].filter((p) => p.stroke).map((p) => {
          const lw = p.lineWidth / 2;
          return { lw: p.lineWidth, x0: p.bbox[0] - lw, y0: h - p.bbox[3] - lw, x1: p.bbox[2] + lw, y1: h - p.bbox[1] + lw };
        });
        const near = (u: number, v: number) => Math.abs(u - v) <= TOL;
        const [L, T, R, B] = [b.x, b.y, b.x + b.w, b.y + b.h];
        const spansX = (o: typeof outer[0]) => near(o.x0, L) && near(o.x1, R);
        const spansY = (o: typeof outer[0]) => near(o.y0, T) && near(o.y1, B);
        const side = [
          (o: typeof outer[0]) => near(o.y0, T) && spansX(o),
          (o: typeof outer[0]) => near(o.x1, R) && spansY(o),
          (o: typeof outer[0]) => near(o.y1, B) && spansX(o),
          (o: typeof outer[0]) => near(o.x0, L) && spansY(o),
        ];
        const ok = side.every((test, i) => outer.some((o) => test(o) && chromeWidth(o.lw) === b.widths[i]));
        if (ok) matched += 1;
        else misses.push(`p${String(b.page)} [${String(b.x)},${String(b.y)} ${String(b.w)}x${String(b.h)}] w${b.widths.join('/')} r${b.radius}`);
      }
      if (DEBUG) console.log(file, 'border misses:\n' + misses.join('\n'));
      expect({ matched, of: solid.length }).toEqual({ matched: MATCHED_BORDERS[file], of: solid.length });
    });
  });
}
