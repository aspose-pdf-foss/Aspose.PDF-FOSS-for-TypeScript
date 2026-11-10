import { PdfObject, name, ref } from '../../src/types.js';
import { serializeDocument } from '../../src/serializer.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** One NON-embedded font on the page. */
export interface FontSpec {
  baseFont: string;
  subtype?: string;              // default Type1
  encoding?: PdfObject;
  /** FirstChar 32 when given. */
  widths?: number[];
  /** A descriptor dict to attach (the builder makes it indirect). */
  descriptor?: Map<string, PdfObject>;
  /** Index into `fonts` whose descriptor this font SHARES. */
  shareDescriptorWith?: number;
  /** Write the font dict DIRECTLY in the page /Resources rather than as an
   *  indirect object. */
  direct?: boolean;
  /** Type0 only: a /ToUnicode CMap body for the font. */
  toUnicode?: string;
  /** Type0 only: the descendant's /CIDSystemInfo /Ordering. Default Identity. */
  ordering?: string;
  /** Type0 only: the /Encoding name. Default Identity-H. */
  cidEncoding?: string;
  /** Type0 only: the descendant's /W array. */
  cidWidths?: PdfObject;
  /** Text this font shows. Empty: declared and never drawn. */
  text: string;
}

/**
 * One page, each font shown on its own line, each font dict indirect unless
 * `direct`. A
 * `Type0` font gets a non-embedded `CIDFontType2` descendant and shows its
 * text as Identity-H two-byte codes.
 */
export function buildNonEmbeddedFontPdf(fonts: FontSpec[]): Uint8Array {
  const objects = new Map<number, PdfObject>();
  let next = 10;
  const alloc = (o: PdfObject): number => { const n = next++; objects.set(n, o); return n; };
  const fontRes = new Map<string, PdfObject>();
  const fdNums: number[] = [];
  let body = '';
  fonts.forEach((f, i) => {
    const dict = new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name(f.subtype ?? 'Type1')], ['BaseFont', name(f.baseFont)],
    ]);
    if (f.encoding !== undefined) dict.set('Encoding', f.encoding);
    if (f.widths) { dict.set('FirstChar', 32); dict.set('LastChar', 32 + f.widths.length - 1); dict.set('Widths', f.widths); }
    if (f.shareDescriptorWith !== undefined) {
      dict.set('FontDescriptor', ref(fdNums[f.shareDescriptorWith], 0));
      fdNums.push(fdNums[f.shareDescriptorWith]);
    } else if (f.descriptor) {
      const n = alloc(f.descriptor);
      fdNums.push(n);
      dict.set('FontDescriptor', ref(n, 0));
    } else fdNums.push(-1);
    if (f.subtype === 'Type0') {
      const desc = alloc(new Map<string, PdfObject>([
        ['Type', name('Font')], ['Subtype', name('CIDFontType2')], ['BaseFont', name(f.baseFont)],
        ['CIDSystemInfo', new Map<string, PdfObject>([['Registry', { kind: 'string', bytes: enc('Adobe') } as PdfObject], ['Ordering', { kind: 'string', bytes: enc(f.ordering ?? 'Identity') } as PdfObject], ['Supplement', 0]])],
        ...(f.cidWidths !== undefined ? [['W', f.cidWidths] as [string, PdfObject]] : []),
        ...(f.descriptor ? [['FontDescriptor', dict.get('FontDescriptor')!] as [string, PdfObject]] : []),
      ]));
      if (f.descriptor) dict.delete('FontDescriptor');
      dict.set('Encoding', name(f.cidEncoding ?? 'Identity-H'));
      if (f.toUnicode !== undefined) dict.set('ToUnicode', ref(alloc({ kind: 'stream', dict: new Map([['Length', f.toUnicode.length]]), raw: enc(f.toUnicode) }), 0));
      dict.set('DescendantFonts', [ref(desc, 0)]);
    }
    fontRes.set(`F${i + 1}`, f.direct ? dict : ref(alloc(dict), 0));
    if (f.text === '') return;
    const shown = f.subtype === 'Type0'
      ? `<${[...f.text].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`
      : `(${f.text})`;
    body += `BT /F${i + 1} 24 Tf 20 ${160 - i * 30} Td ${shown} Tj ET\n`;
  });
  objects.set(3, { kind: 'stream', dict: new Map([['Length', body.length]]), raw: enc(body) });
  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(5, 0)], ['MediaBox', [0, 0, 400, 200]], ['Contents', ref(3, 0)],
    ['Resources', new Map<string, PdfObject>([['Font', fontRes]])],
  ]));
  objects.set(5, new Map<string, PdfObject>([['Type', name('Pages')], ['Kids', [ref(2, 0)]], ['Count', 1]]));
  objects.set(1, new Map<string, PdfObject>([['Type', name('Catalog')], ['Pages', ref(5, 0)]]));
  return serializeDocument(objects, new Map<string, PdfObject>([['Root', ref(1, 0)]]));
}
