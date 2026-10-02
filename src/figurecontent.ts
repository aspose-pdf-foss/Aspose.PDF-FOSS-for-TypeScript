/** What a structure element's marked content draws (`3ywf.4`): its image
 *  XObjects, and the page-space extent of everything it paints.
 *
 *  Extracted from `docmodel.ts`, whose HTML/Markdown/DOCX/EPUB exports and
 *  `aialttext.ts` both need "which images does this /Figure show" — one owner,
 *  so an export and alt-text generation cannot disagree about a figure.
 *
 *  **Invariant:** both maps are memoized per page and built LAZILY, each in one
 *  content walk — a page with N figures is walked once per map, not N times.
 *  The image map and the extent map are separate because the exports need only
 *  the first, and the extent walk subscribes to glyphs and paths as well.
 *
 *  **Invariant:** keyed by MCID, never by page position or resource order;
 *  `page.Images` is `/Resources` order and says nothing about which figure
 *  draws what. Inline images are absent: they live in no object.
 *
 *  **Invariant:** the walk recurses into child elements — a Figure's content is
 *  normally its own MCIDs, but nothing forbids nesting it deeper. */
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type { PdfStream } from './types.js';
import { visitContent, type Rect } from './text.js';

export interface PlacedImage { stream: PdfStream; width: number; height: number }

const SHOWN = { skipHidden: true } as const;

/** The page an element's first content item sits on, else its own `/Pg`. */
export function figurePage(el: StructElement): Page | undefined {
  for (const item of el.ContentItems) if (item.page) return item.page;
  for (const child of el.Children) {
    const p = figurePage(child);
    if (p) return p;
  }
  return el.Page;
}

export class FigureContent {
  private readonly images = new Map<Page, Map<number, PlacedImage[]>>();
  private readonly extents = new Map<Page, Map<number, Rect>>();

  /** `only`: ignore content on any other page (a page-filtered export). */
  constructor(private readonly doc: Document, private readonly only?: Page) {}

  /** Every image this element's marked content draws, in content order. */
  imagesOf(el: StructElement): PlacedImage[] {
    const out: PlacedImage[] = [];
    this.collectImages(el, out);
    return out;
  }

  /** The page-space union of every glyph, image and path this element's marked
   *  content paints on `page`, or undefined when it paints nothing there. */
  bboxOf(el: StructElement, page: Page): Rect | undefined {
    let box: Rect | undefined;
    this.collectExtent(el, page, (r) => {
      box = box ? [Math.min(box[0], r[0]), Math.min(box[1], r[1]), Math.max(box[2], r[2]), Math.max(box[3], r[3])] : [...r];
    });
    return box;
  }

  private collectImages(el: StructElement, out: PlacedImage[]): void {
    for (const item of el.ContentItems) {
      if (item.kind !== 'mcid' || !item.page) continue;
      if (this.only && item.page !== this.only) continue; // another page's half of a split figure
      for (const s of this.pageImages(item.page).get(item.mcid) ?? []) out.push(s);
    }
    for (const child of el.Children) this.collectImages(child, out);
  }

  private collectExtent(el: StructElement, page: Page, add: (r: Rect) => void): void {
    for (const item of el.ContentItems) {
      if (item.kind !== 'mcid' || item.page !== page) continue;
      const r = this.pageExtents(page).get(item.mcid);
      if (r) add(r);
    }
    for (const child of el.Children) this.collectExtent(child, page, add);
  }

  private pageImages(page: Page): Map<number, PlacedImage[]> {
    let map = this.images.get(page);
    if (map) return map;
    const m = new Map<number, PlacedImage[]>();
    visitContent(this.doc, page, {
      image: (e) => {
        if (e.mcid === undefined || !e.stream) return;
        const placed: PlacedImage = {
          stream: e.stream, width: Math.abs(e.quad[2] - e.quad[0]), height: Math.abs(e.quad[3] - e.quad[1]),
        };
        const list = m.get(e.mcid);
        if (list) list.push(placed); else m.set(e.mcid, [placed]);
      },
    }, SHOWN);
    this.images.set(page, m);
    map = m;
    return map;
  }

  private pageExtents(page: Page): Map<number, Rect> {
    let map = this.extents.get(page);
    if (map) return map;
    const m = new Map<number, Rect>();
    const grow = (mcid: number | undefined, x0: number, y0: number, x1: number, y1: number): void => {
      if (mcid === undefined) return;
      const lo: Rect = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      const cur = m.get(mcid);
      m.set(mcid, cur
        ? [Math.min(cur[0], lo[0]), Math.min(cur[1], lo[1]), Math.max(cur[2], lo[2]), Math.max(cur[3], lo[3])]
        : lo);
    };
    visitContent(this.doc, page, {
      glyph: (e) => grow(e.mcid, e.quad[0], e.quad[1], e.quad[2], e.quad[3]),
      image: (e) => grow(e.mcid, e.quad[0], e.quad[1], e.quad[2], e.quad[3]),
      path: (e) => { for (const s of e.segments) grow(e.mcid, s[0], s[1], s[2], s[3]); },
    }, SHOWN);
    this.extents.set(page, m);
    map = m;
    return map;
  }
}
