import { PdfObject, name, ref } from '../../src/types.js';
import { serializeDocument } from '../../src/serializer.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A non-embedded simple font dict. */
export function simpleFont(baseFont: string, encoding: PdfObject = name('WinAnsiEncoding')): Map<string, PdfObject> {
  return new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name(baseFont)], ['Encoding', encoding],
  ]);
}

/** A Form XObject: its content, and its own resources (omit to inherit). */
export interface FormSpec { content: string; fonts?: Record<string, string>; forms?: Record<string, string>; resources?: false }

export interface PageSpec {
  content: string;
  /** Font resource key -> font name in `fonts`. */
  fonts?: Record<string, string>;
  /** XObject key -> form name in `forms`. */
  forms?: Record<string, string>;
  /** ExtGState key -> font name, set through `/Font [ref size]`. */
  gsFonts?: Record<string, string>;
  /** Share this page's /Resources (indirect) with page `n` (0-based). */
  shareResourcesWith?: number;
}

/**
 * Pages drawing text in named fonts, with Form XObjects and font dicts as
 * indirect objects shared by name. Font and form names are global to the file,
 * so two pages naming one font share ONE dict.
 */
export function buildFontReplacePdf(o: {
  fonts: Record<string, Map<string, PdfObject>>;
  forms?: Record<string, FormSpec>;
  pages: PageSpec[];
}): Uint8Array {
  const objects = new Map<number, PdfObject>();
  let next = 10;
  const alloc = (x: PdfObject): number => { const n = next++; objects.set(n, x); return n; };
  const fontNum = new Map<string, number>();
  for (const [k, d] of Object.entries(o.fonts)) fontNum.set(k, alloc(d));
  const fontDict = (m?: Record<string, string>): Map<string, PdfObject> =>
    new Map(Object.entries(m ?? {}).map(([k, f]) => [k, ref(fontNum.get(f)!, 0)]));

  const formNum = new Map<string, number>();
  const formDicts = new Map<string, Map<string, PdfObject>>();
  for (const [k, f] of Object.entries(o.forms ?? {})) {
    const dict = new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 400, 200]], ['Length', f.content.length],
    ]);
    formDicts.set(k, dict);
    formNum.set(k, alloc({ kind: 'stream', dict, raw: enc(f.content) }));
  }
  const xobjDict = (m?: Record<string, string>): Map<string, PdfObject> =>
    new Map(Object.entries(m ?? {}).map(([k, f]) => [k, ref(formNum.get(f)!, 0)]));
  for (const [k, f] of Object.entries(o.forms ?? {})) {
    if (f.resources === false) continue;
    formDicts.get(k)!.set('Resources', new Map<string, PdfObject>([['Font', fontDict(f.fonts)], ['XObject', xobjDict(f.forms)]]));
  }

  const kids: PdfObject[] = [];
  const resNums: number[] = [];
  o.pages.forEach((p) => {
    const content = alloc({ kind: 'stream', dict: new Map([['Length', p.content.length]]), raw: enc(p.content) });
    let resRef: number;
    if (p.shareResourcesWith !== undefined) resRef = resNums[p.shareResourcesWith];
    else {
      const res = new Map<string, PdfObject>([['Font', fontDict(p.fonts)], ['XObject', xobjDict(p.forms)]]);
      if (p.gsFonts) {
        const gs = new Map<string, PdfObject>();
        for (const [k, f] of Object.entries(p.gsFonts)) {
          gs.set(k, new Map<string, PdfObject>([['Type', name('ExtGState')], ['Font', [ref(fontNum.get(f)!, 0), 24]]]));
        }
        res.set('ExtGState', gs);
      }
      resRef = alloc(res);
    }
    resNums.push(resRef);
    kids.push(ref(alloc(new Map<string, PdfObject>([
      ['Type', name('Page')], ['Parent', ref(2, 0)], ['MediaBox', [0, 0, 400, 200]],
      ['Contents', ref(content, 0)], ['Resources', ref(resRef, 0)],
    ])), 0));
  });
  objects.set(2, new Map<string, PdfObject>([['Type', name('Pages')], ['Kids', kids], ['Count', kids.length]]));
  objects.set(1, new Map<string, PdfObject>([['Type', name('Catalog')], ['Pages', ref(2, 0)]]));
  return serializeDocument(objects, new Map<string, PdfObject>([['Root', ref(1, 0)]]));
}
