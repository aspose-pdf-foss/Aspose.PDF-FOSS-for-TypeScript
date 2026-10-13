// src/xfapaint.ts
/**
 * XFA chrome operations written as page content (164g.4). The only chrome
 * module holding a `Document`: `xfachrome.ts` decides WHAT to paint, this
 * decides how a PDF says it.
 *
 * **Invariant:** text is drawn in the face that MEASURED it -- the
 * Standard-14 face for the Arial / Times New Roman / Courier New substitutes,
 * whose advances equal the Liberation metrics that measured them (so nothing
 * is embedded), otherwise the measured program embedded through `AddFont` --
 * so ink and layout box cannot disagree.
 *
 * **Invariant:** each page area's master chrome is ONE Form XObject, built
 * for that area's own page height and placed on every page using it.
 *
 * **Invariant:** coordinates arrive in the XFA page frame (y down) and are
 * flipped here and nowhere else: `pdfY = pageHeight - y`. Pages this runs on
 * are the converter's own, created with a `[0 0 w h]` box.
 */
import type { Document } from './document.js';
import { name, type PdfDict, type PdfObject, type PdfRef } from './types.js';
import { appendContent, ensureOwnResources, ensureOwnSubdict, num, registerXObjectRef, streamOf } from './pagecontent.js';
import { driverFor, registerFontIn, type AuthoringFont } from './stamp.js';
import { decorRects, resolveDecor, vmetricsFor } from './textdecor.js';
import { rethrowLimit } from './errors.js';
import type { ChromeOp, PathCmd } from './xfachrome.js';
import { facePicker, type FacePicker } from './xfafont.js';
import type { RunStyle } from './xfarich.js';
import type { SfntFont } from './sfnt.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The chrome to paint on a converted dynamic document: each page's body
 *  operations, and each page area's master operations with its page size. */
export interface XfaChromePlan {
  pages: Array<{ pageArea: number; ops: ChromeOp[] }>;
  masters: Map<number, { ops: ChromeOp[]; w: number; h: number }>;
}

/** Fonts for chrome text, resolved through `facePicker` and memoized: one
 *  `AddFont` per measured program, however many runs use it. */
export class ChromeFonts {
  private readonly embedded = new Map<SfntFont, AuthoringFont | { reason: string }>();
  constructor(private readonly doc: Document, private readonly pick: FacePicker) {}

  fontFor(style: RunStyle, text: string): AuthoringFont | { reason: string } {
    const r = this.pick(style, text);
    if ('reason' in r) return r;
    if ('std14' in r.source) return r.source.std14;
    const s = r.source.sfnt;
    let f = this.embedded.get(s);
    if (f === undefined) {
      try {
        f = this.doc.AddFont(s.raw);
      } catch (caught) { rethrowLimit(caught);
        f = { reason: `the face could not be embedded (${caught instanceof Error ? caught.message : String(caught)})` };
      }
      this.embedded.set(s, f);
    }
    return f;
  }
}

function pathOps(path: readonly PathCmd[], h: number): string {
  return path.map((c) => {
    switch (c[0]) {
      case 'M': return `${num(c[1])} ${num(h - c[2])} m`;
      case 'L': return `${num(c[1])} ${num(h - c[2])} l`;
      case 'C': return `${num(c[1])} ${num(h - c[2])} ${num(c[3])} ${num(h - c[4])} ${num(c[5])} ${num(h - c[6])} c`;
      default: return 'h';
    }
  }).join(' ');
}

const rgb = (c: readonly number[]): string => c.map(num).join(' ');
const CAP = { butt: 0, round: 1, square: 2 } as const;
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Operations as content-stream bytes. Fonts are registered in `fonts`, the
 * `/Font` dictionary of whatever the bytes are written into. A text op whose
 * face cannot be resolved or embedded is skipped through `skip`.
 */
export function chromeContent(
  doc: Document, fonts: PdfDict, ops: readonly ChromeOp[], pageHeight: number,
  cache: ChromeFonts, skip: (reason: string) => void,
): Uint8Array {
  let s = '';
  const h = pageHeight;
  for (const op of ops) {
    if (op.kind === 'fill') {
      s += `q ${rgb(op.color)} rg ${pathOps(op.path, h)} f Q\n`;
      continue;
    }
    if (op.kind === 'stroke') {
      const dash = op.dash ? `[${op.dash.map(num).join(' ')}] 0 d ` : '';
      s += `q ${rgb(op.color)} RG ${num(op.width)} w ${String(CAP[op.cap])} J ${op.join === 'round' ? 1 : 0} j `
        + `${dash}${pathOps(op.path, h)} S Q\n`;
      continue;
    }
    const font = cache.fontFor(op.style, op.text);
    if (typeof font === 'object' && 'reason' in font) {
      skip(`"${op.text}": ${font.reason}, so it is not painted`);
      continue;
    }
    const key = registerFontIn(doc, fonts, font);
    const drv = driverFor(font);
    const y = h - op.y;
    s += `BT /${key} ${num(op.style.size)} Tf ${rgb(op.color)} rg ${num(op.x)} ${num(y)} Td <${hex(drv.encode(op.text))}> Tj ET\n`;
    if (op.underline || op.lineThrough) {
      const d = resolveDecor({
        ...(op.underline ? { underline: true } : {}),
        ...(op.lineThrough ? { strikethrough: true } : {}),
      }, [op.color[0], op.color[1], op.color[2]], op.style.size, vmetricsFor(font));
      if (d) {
        const r = decorRects([{ x: op.x, baseline: y, width: drv.measure(op.text, op.style.size) }], d);
        s += r.beneath + r.above;
        if (!s.endsWith('\n')) s += '\n';
      }
    }
  }
  return enc(s);
}

/**
 * Paint a converted dynamic document's chrome. Returns the number of pages
 * that received any. `skip` reports what was not painted.
 */
export function paintChrome(doc: Document, chrome: XfaChromePlan, skip: (reason: string) => void): number {
  const cache = new ChromeFonts(doc, facePicker(doc));
  const forms = new Map<number, PdfRef>();
  for (const [k, m] of chrome.masters) {
    if (m.ops.length === 0) continue;
    const fonts: PdfDict = new Map();
    const st = streamOf(chromeContent(doc, fonts, m.ops, m.h, cache, skip));
    st.dict.set('Type', name('XObject'));
    st.dict.set('Subtype', name('Form'));
    st.dict.set('BBox', [0, 0, m.w, m.h]);
    st.dict.set('Resources', new Map<string, PdfObject>([['Font', fonts]]));
    forms.set(k, doc.allocObject(st));
  }
  let painted = 0;
  chrome.pages.forEach((pg, i) => {
    const page = doc.Pages[i];
    if (!page) return;
    const form = forms.get(pg.pageArea);
    if (!form && pg.ops.length === 0) return;
    const mb = page.MediaBox;
    const h = mb[3] - mb[1];
    if (form) {
      const key = registerXObjectRef(doc, page, form);
      appendContent(doc, page, enc(`q /${key} Do Q\n`));
    }
    if (pg.ops.length > 0) {
      const fonts = ensureOwnSubdict(doc, ensureOwnResources(doc, page), 'Font');
      appendContent(doc, page, chromeContent(doc, fonts, pg.ops, h, cache, skip));
    }
    painted += 1;
  });
  return painted;
}
