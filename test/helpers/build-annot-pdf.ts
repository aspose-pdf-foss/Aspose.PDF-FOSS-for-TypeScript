import { Document } from '../../src/document.js';
import { buildStampTarget } from './build-stamp-target.js';
import type { StructElement } from '../../src/struct.js';
import { name, type PdfDict, type PdfObject } from '../../src/types.js';
import { PDF20_NS } from '../../src/structns.js';

/** Structure types present in the PDF 2.0 vocabulary and ABSENT from PDF 1.7,
 *  which therefore need an explicit namespace or `Append` rejects them. */
const PDF20_ONLY = new Set([
  'Artifact', 'Aside', 'DocumentFragment', 'Em', 'FENote', 'Strong', 'Sub', 'Title',
]);

/** One annotation to place on the page. */
export interface AnnotSpec {
  /** /Subtype, written verbatim — including subtypes our API cannot author. */
  subtype: string;
  /** /Rect; defaults to a 50x20 box. Pass [0,0,0,0] for a zero-size widget. */
  rect?: [number, number, number, number];
  /** /F annotation flags. */
  flags?: number;
  /** /Contents. */
  contents?: string;
  /** Extra raw dict entries — /Name, /FS, /AA, /FT, /Parent, /RC, /RV, /V... */
  extra?: Record<string, PdfObject>;
  /** Tag the annotation under a chain of structure elements, outermost first.
   *  Omit to leave it OUT of the structure tree, which most rules exempt. */
  under?: string[];
  /** Two annotations carrying the same `shareUnder` key are tagged under the
   *  SAME enclosing element, rather than each getting its own chain. Required
   *  by 8.10.1-2, which is about one Form holding two widgets. */
  shareUnder?: string;
  /** Append an Lbl to the innermost enclosing element. `'empty'` gives one
   *  with no /K, which does NOT count as a label. */
  label?: 'filled' | 'empty';
  /** /Alt on the innermost enclosing element. */
  alt?: string;
  /** /Alt on the OUTERMOST element of the `under` chain, so a rule that
   *  reads the INHERITED /Alt can be told from one that reads the direct
   *  parent. 8.10.3.5-1 reads the inherited one. */
  outerAlt?: string;
  /** Give the annotation an /AP /N stream that PAINTS something. `graphic`
   *  fills a rectangle (a path), `text` shows a glyph, `empty` paints nothing.
   *  A stream must be indirect, so the builder allocates it rather than the
   *  spec carrying one through `extra`. */
  ap?: 'graphic' | 'text' | 'empty';
}

export interface AnnotPdfSpec {
  annots: AnnotSpec[];
  /** Page /Tabs. Omit to leave the key absent. */
  tabs?: string;
  /** Catalog /AcroForm /XFA. */
  xfa?: boolean;
}

/** A PDF text string. */
export const str = (s: string): PdfObject =>
  ({ kind: 'string', bytes: new TextEncoder().encode(s) });

/** A tagged, titled document whose single page carries `spec.annots`.
 *
 *  Annotations are written as RAW DICTS rather than through `page.AddLink` and
 *  friends, because most of these subtypes (/Sound, /Movie, /TrapNet, /3D,
 *  /RichMedia, /PrinterMark) have no authoring API here and never will — they
 *  are prohibited or out of scope. */
export function buildAnnotPdf(spec: AnnotPdfSpec): Uint8Array {
  const doc = Document.Open(buildStampTarget());
  doc.Lang = 'en-US';
  doc.SetMetadata({ title: 'T' });
  doc.DisplayDocTitle = true;
  const root = doc.CreateStructTree();
  const docEl = root.Append('Document');
  const page = doc.Pages[0];

  if (spec.tabs !== undefined) page.Dict.set('Tabs', name(spec.tabs));
  if (spec.xfa === true) {
    const acro: PdfDict = new Map<string, PdfObject>([['XFA', []], ['Fields', []]]);
    doc.catalog().set('AcroForm', acro);
  }

  // Set /Annots FIRST and push into the live array: `Page.Annotations` resolves
  // `this.Dict.get('Annots')` on every call, so each annotation is visible to
  // `page.Annotations` as soon as it is pushed — which is what lets
  // `AddAnnotation` find it inside the loop.
  const annots: PdfObject[] = [];
  page.Dict.set('Annots', annots);

  const shared = new Map<string, StructElement>();
  for (const a of spec.annots) {
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Annot')],
      ['Subtype', name(a.subtype)],
      ['Rect', a.rect ?? [0, 0, 50, 20]],
      // `tagAnnotation` refuses an annotation with no /P — it needs a page to
      // tag against. `addLink` sets it the same way.
      ['P', doc.pageRef(page.Number)],
    ]);
    if (a.flags !== undefined) dict.set('F', a.flags);
    if (a.contents !== undefined) dict.set('Contents', str(a.contents));
    if (a.ap !== undefined) {
      // A Form XObject: /BBox is what makes it placeable, and the content is
      // the smallest thing that paints in each category. `empty` paints
      // nothing at all, which is what separates "has an appearance" from
      // "the appearance contains a graphic".
      const body = a.ap === 'graphic' ? '0 0 1 rg 0 0 40 20 re f'
        : a.ap === 'text' ? 'BT /F0 12 Tf 1 0 0 1 2 2 Tm (S) Tj ET'
          : '';
      const raw = new TextEncoder().encode(body);
      const apDict: PdfDict = new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')],
        ['BBox', [0, 0, 50, 20]], ['Length', raw.length],
      ]);
      // The page's own /Resources carry /F0, so the text form can resolve it.
      const pageRes = doc.resolve(page.Dict.get('Resources'));
      if (pageRes instanceof Map) apDict.set('Resources', pageRes);
      const apStream: PdfObject = { kind: 'stream', dict: apDict, raw };
      dict.set('AP', new Map<string, PdfObject>([['N', doc.allocObject(apStream)]]));
    }
    for (const [k, v] of Object.entries(a.extra ?? {})) dict.set(k, v);
    annots.push(doc.allocObject(dict));

    if (a.under !== undefined) {
      const key = a.shareUnder;
      let el = key === undefined ? undefined : shared.get(key);
      if (el === undefined) {
        el = docEl;
        // `Artifact` is a PDF 2.0 type and is ABSENT from the PDF 1.7
        // vocabulary, so a bare Append throws — `checkStructType` defaults to
        // the 1.7 arm. The same trap FENote springs in q7hc.4.1.
        let outer: StructElement | undefined;
        for (const t of a.under) {
          el = el.Append(t, PDF20_ONLY.has(t) ? { ns: PDF20_NS } : undefined);
          if (outer === undefined) outer = el;
        }
        if (a.outerAlt !== undefined && outer !== undefined) outer.Alt = a.outerAlt;
        if (key !== undefined) shared.set(key, el);
      }
      if (a.alt !== undefined) el.Alt = a.alt;
      if (a.label !== undefined) {
        const lbl = el.Append('Lbl');
        // `containsLbl` asks whether the Lbl's /K is non-empty, and an ELEMENT
        // kid counts — `PDStructElem.getChildren()` returns every /K entry.
        // A child element rather than MarkContent, because MarkContent adds an
        // MCID only where the region actually covers page content, so a rect
        // over an empty part of the page would leave the Lbl empty and the
        // fixture would measure the opposite of what it says.
        if (a.label === 'filled') lbl.Append('Span');
      }
      // AddAnnotation needs an Annotation handle; the raw dict is already in
      // the live /Annots array, so re-read it through the page's accessor.
      el.AddAnnotation(page.Annotations[annots.length - 1]!);
    }
  }

  doc.markModified();
  return doc.Save();
}
