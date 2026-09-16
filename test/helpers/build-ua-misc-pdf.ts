import { Document } from '../../src/document.js';
import { buildStampTarget } from './build-stamp-target.js';
import { name, type PdfDict, type PdfObject } from '../../src/types.js';
import type { StructElement } from '../../src/struct.js';

const str = (s: string): PdfObject =>
  ({ kind: 'string', bytes: new TextEncoder().encode(s) });

const stream = (dict: PdfDict, raw: Uint8Array): PdfObject =>
  ({ kind: 'stream', dict, raw });

/** A /ToUnicode CMap mapping each code to a code point, so a fixture can map
 *  ordinary text INTO the private use area. */
function toUnicodeStream(map: Record<number, number>): PdfObject {
  const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');
  // Beyond the BMP a /ToUnicode value is a UTF-16 SURROGATE PAIR, which is how
  // a supplementary PUA code point reaches the text at all.
  const utf16 = (cp: number): string => {
    if (cp <= 0xffff) return hex(cp, 4);
    const v = cp - 0x10000;
    return hex(0xd800 + (v >> 10), 4) + hex(0xdc00 + (v & 0x3ff), 4);
  };
  const entries = Object.entries(map)
    .map(([code, cp]) => `<${hex(Number(code), 2)}> <${utf16(cp)}>`);
  const text = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin begincmap',
    '/CMapName /Test def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    `${entries.length} beginbfchar`,
    ...entries,
    'endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const raw = new TextEncoder().encode(text);
  return stream(new Map<string, PdfObject>([['Length', raw.length]]), raw);
}

export interface UaMiscSpec {
  /** Draw text whose /ToUnicode maps the code INTO this code point. */
  puaCodePoint?: number;
  /** Shorthand for `puaCodePoint: 0xE001`. */
  puaText?: boolean;
  /** Property-list entries on the BDC wrapping the drawn text. */
  mcProps?: Record<string, string>;
  /** Wrap the drawn text in an /Artifact BDC instead of a /Span. */
  artifact?: boolean;
  /** Build a structure tree around the drawn text. */
  tagged?: boolean;
  /** Put an /Alt on the glyph's own element, or on its grandparent. */
  altOn?: 'self' | 'grandparent';
  /** /Alt value on the tagged element (tests 8.4.3-3). */
  altValue?: string;
  /** /ActualText value on the tagged element (tests 8.4.3-2). */
  actualTextValue?: string;
  /** /Info /Title; defaults to 'T'. */
  title?: string;
  /** Catalog /Lang; defaults to 'en-US'. Pass null to omit the key. */
  lang?: string | null;
  /** A /Lang on the drawn text's BDC property list. */
  bdcLang?: string;
  /** A /Lang on the tagged structure element. */
  elementLang?: string;
  /** Optional content. `configs` is how many /Configs entries to write. */
  oc?: {
    configs?: number;
    dName?: string | null;
    configName?: string | null;
    as?: boolean;
  };
  /** An outline item with a plain page destination (tests 8.8-1). */
  outlineDest?: boolean;
  /** A link annotation whose GoTo action carries /D and optionally /SD. */
  goTo?: { sd?: boolean; arrayIsStructDest?: boolean };
  /** An embedded file, with or without /Desc. */
  attachment?: { desc?: string | null };
  /** A /FileAttachment annotation's /FS, which is NOT in /EmbeddedFiles. */
  looseFileSpec?: boolean;
}

/**
 * A tagged, titled one-page document built to order for the 11 rules of
 * `q7hc.4.4`.
 *
 * It opens `buildStampTarget()` and calls `doc.CreateStructTree()` because
 * `validatePdfUa` SHORT-CIRCUITS on an untagged document — every rule would go
 * silent and every fixture would measure nothing. The drawn text's font, its
 * `/ToUnicode` and the content stream are written by hand, since no authoring
 * API maps a character into the private use area.
 */
export function buildUaMiscPdf(spec: UaMiscSpec): Uint8Array {
  const doc = Document.Open(buildStampTarget());
  doc.SetMetadata({ title: spec.title ?? 'T' });
  doc.DisplayDocTitle = true;
  const root = doc.CreateStructTree();
  const docEl = root.Append('Document');
  const page = doc.Pages[0];

  // ---- catalog /Lang -------------------------------------------------------
  // Written raw rather than through `doc.Lang`, which validates; 8.4.4-2 is
  // about tags a producer wrote that we would refuse to author.
  if (spec.lang === null) doc.catalog().delete('Lang');
  else doc.catalog().set('Lang', str(spec.lang ?? 'en-US'));

  // ---- the font, and the text it draws -------------------------------------
  const cp = spec.puaCodePoint ?? (spec.puaText === true ? 0xe001 : undefined);
  const font = new Map<string, PdfObject>([
    ['Type', name('Font')],
    ['Subtype', name('Type1')],
    ['BaseFont', name('Helvetica')],
    ['Encoding', name('WinAnsiEncoding')],
  ]);
  if (cp !== undefined) font.set('ToUnicode', doc.allocObject(toUnicodeStream({ 65: cp })));

  const res = doc.resolve(page.Dict.get('Resources'));
  const resources = res instanceof Map ? res : new Map<string, PdfObject>();
  resources.set('Font', new Map<string, PdfObject>([['F1', doc.allocObject(font)]]));
  page.Dict.set('Resources', resources);

  const props: string[] = [];
  if (spec.tagged === true || spec.mcProps !== undefined || spec.bdcLang !== undefined) {
    props.push('/MCID 0');
  }
  for (const [k, v] of Object.entries(spec.mcProps ?? {})) props.push(`/${k} (${v})`);
  if (spec.bdcLang !== undefined) props.push(`/Lang (${spec.bdcLang})`);

  const show = 'BT /F1 12 Tf 1 0 0 1 72 700 Tm (A) Tj ET';
  const content = spec.artifact === true
    ? `/Artifact << >> BDC\n${show}\nEMC`
    : props.length > 0
      ? `/Span << ${props.join(' ')} >> BDC\n${show}\nEMC`
      : show;
  const raw = new TextEncoder().encode(content);
  page.Dict.set('Contents', doc.allocObject(
    stream(new Map<string, PdfObject>([['Length', raw.length]]), raw),
  ));
  page.Dict.set('StructParents', 0);

  // ---- the structure tree around it ----------------------------------------
  if (spec.tagged === true) {
    const sect = docEl.Append('Sect');
    const p = sect.Append('P');
    // The glyph's OWN element is the /P. `altOn: 'grandparent'` puts the /Alt on
    // the Document instead, which 8.4.3-1 must NOT accept -- veraPDF reads the
    // element directly rather than walking ancestors.
    const target: StructElement = spec.altOn === 'grandparent' ? docEl : p;
    if (spec.altOn !== undefined) target.Alt = 'a replacement';
    if (spec.altValue !== undefined) p.Alt = spec.altValue;
    if (spec.actualTextValue !== undefined) p.ActualText = spec.actualTextValue;
    if (spec.elementLang !== undefined) p.Dict.set('Lang', str(spec.elementLang));
    // Wire MCID 0 of this page to the /P, so the glyph resolves to it.
    p.Dict.set('Pg', doc.pageRef(page.Number));
    p.Dict.set('K', 0);
    if (p.Ref !== undefined) {
      root.Dict.set('ParentTree', doc.allocObject(
        new Map<string, PdfObject>([['Nums', [0, [p.Ref]]]]),
      ));
    }
  }

  // ---- optional content ----------------------------------------------------
  if (spec.oc !== undefined) {
    const ocg = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('OCG')], ['Name', str('Layer')],
    ]));
    const cfg = (nm: string | null | undefined): PdfDict => {
      const d = new Map<string, PdfObject>([['OFF', []], ['ON', [ocg]]]);
      if (nm !== null && nm !== undefined) d.set('Name', str(nm));
      if (spec.oc?.as === true) {
        d.set('AS', [new Map<string, PdfObject>([
          ['Event', name('View')], ['OCGs', [ocg]], ['Category', [name('View')]],
        ])]);
      }
      return d;
    };
    const ocp = new Map<string, PdfObject>([
      ['OCGs', [ocg]],
      ['D', cfg(spec.oc.dName === undefined ? 'Default' : spec.oc.dName)],
    ]);
    if (spec.oc.configs !== undefined && spec.oc.configs > 0) {
      ocp.set('Configs', Array.from({ length: spec.oc.configs },
        () => cfg(spec.oc?.configName === undefined ? 'Preset' : spec.oc.configName)));
    }
    doc.catalog().set('OCProperties', ocp);
  }

  // ---- an outline with a plain PAGE destination ----------------------------
  if (spec.outlineDest === true) {
    doc.SetOutlines([{ Title: 'Chapter', Dest: { page: page.Number } }]);
  }

  // ---- a link whose GoTo action may carry /SD ------------------------------
  if (spec.goTo !== undefined) {
    const link = page.AddLink({ rect: [10, 10, 60, 30], action: { type: 'goto', page: page.Number } });
    const a = doc.resolve(link.Dict.get('A'));
    if (a instanceof Map) {
      const elRef = docEl.Ref;
      if (spec.goTo.arrayIsStructDest === true && elRef !== undefined) {
        // A structure-destination ARRAY in /D. 8.8-2 must STILL report: an
        // action qualifies only through /SD or a named destination.
        a.set('D', [elRef, name('Fit')]);
      }
      if (spec.goTo.sd === true && elRef !== undefined) a.set('SD', [elRef, name('Fit')]);
    }
  }

  // ---- an embedded file ----------------------------------------------------
  if (spec.attachment !== undefined) {
    const opts = spec.attachment.desc === null || spec.attachment.desc === undefined
      ? {}
      : { description: spec.attachment.desc };
    doc.AddAttachment('data.csv', new TextEncoder().encode('a,b\n1,2\n'), opts);
  }

  // ---- a filespec that is NOT in /EmbeddedFiles ----------------------------
  if (spec.looseFileSpec === true) {
    const fs = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Filespec')], ['F', str('loose.txt')], ['UF', str('loose.txt')],
    ]));
    const annot = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('FileAttachment')],
      ['Rect', [0, 0, 20, 20]], ['P', doc.pageRef(page.Number)], ['FS', fs],
    ]));
    const annots = doc.resolve(page.Dict.get('Annots'));
    if (Array.isArray(annots)) annots.push(annot);
    else page.Dict.set('Annots', [annot]);
  }

  doc.markModified();
  return doc.Save();
}
