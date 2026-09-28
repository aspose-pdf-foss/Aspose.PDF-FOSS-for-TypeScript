import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PdfDict, PdfObject, isDict, isStream, isArray, name, ref } from '../src/types.js';
import { serializeDocument } from '../src/serializer.js';
import { parseSfnt } from '../src/sfnt.js';
import { decodeStream } from '../src/filters.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

interface Opts {
  baseFont?: string;
  encoding?: PdfObject;
  widths?: number[];            // FirstChar 32
  text?: string;
}

/** A page showing `text` in a NON-embedded simple /Type1 font. */
function buildStd14Pdf(o: Opts = {}): Uint8Array {
  const objects = new Map<number, PdfObject>();
  const font = new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name(o.baseFont ?? 'Helvetica')],
  ]);
  if (o.encoding !== undefined) font.set('Encoding', o.encoding);
  if (o.widths) { font.set('FirstChar', 32); font.set('LastChar', 32 + o.widths.length - 1); font.set('Widths', o.widths); }
  objects.set(4, font);
  const body = `BT /F1 36 Tf 20 40 Td (${o.text ?? 'Hello, World'}) Tj ET`;
  objects.set(3, { kind: 'stream', dict: new Map([['Length', body.length]]), raw: enc(body) });
  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(5, 0)], ['MediaBox', [0, 0, 300, 100]], ['Contents', ref(3, 0)],
    ['Resources', new Map<string, PdfObject>([['Font', new Map<string, PdfObject>([['F1', ref(4, 0)]])]])],
  ]));
  objects.set(5, new Map<string, PdfObject>([['Type', name('Pages')], ['Kids', [ref(2, 0)]], ['Count', 1]]));
  objects.set(1, new Map<string, PdfObject>([['Type', name('Catalog')], ['Pages', ref(5, 0)]]));
  return serializeDocument(objects, new Map<string, PdfObject>([['Root', ref(1, 0)]]));
}

function f1(doc: Document): PdfDict {
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font'));
  const f = isDict(fonts) ? doc.resolve(fonts.get('F1')) : undefined;
  if (!isDict(f)) throw new Error('no F1');
  return f;
}
function program(doc: Document): Uint8Array | undefined {
  const fd = doc.resolve(f1(doc).get('FontDescriptor'));
  const ff = isDict(fd) ? doc.resolve(fd.get('FontFile2')) : undefined;
  return isStream(ff) ? decodeStream(ff) : undefined;
}

describe('ConvertToPdfA — embeds the bundled substitute for a Latin Standard-14 font (29z6.6)', () => {
  it('embeds, passes PDF/A-2b, and renders exactly as the non-embedded page did', () => {
    const pdf = buildStd14Pdf({ encoding: name('WinAnsiEncoding') });
    const before = Document.Open(pdf).Pages[0].ToImage();
    const doc = Document.Open(pdf);
    const conv = doc.ConvertToPdfA('2b');
    expect(conv.passed).toBe(true);
    expect(conv.applied.filter((a) => a.rule === 'FontEmbedded').map((a) => a.action))
      .toEqual(["Embedded the bundled Liberation Sans substitute for Standard-14 font 'Helvetica'."]);
    const saved = Document.Open(doc.Save());
    expect(saved.Pages[0].ToImage()).toEqual(before);
    expect(saved.Pages[0].GetText()).toBe('Hello, World');
    const font = f1(saved);
    expect((font.get('Subtype') as { name: string }).name).toBe('TrueType');
    expect(saved.ValidatePdfA('2b').Errors).toEqual([]);
  });

  it('shrinks the embedded face to the glyphs shown', () => {
    const doc = Document.Open(buildStd14Pdf({ encoding: name('WinAnsiEncoding') }));
    doc.ConvertToPdfA('2b');
    const bytes = program(Document.Open(doc.Save()))!;
    const f = parseSfnt(bytes);
    const cmap = f.cmapSubtable(3, 1)!;
    expect(f.glyphData(cmap.get(0x48)!).length).toBeGreaterThan(0);     // 'H' shown
    expect(f.glyphData(cmap.get(0x5a)!).length).toBe(0);                // 'Z' not
  });

  it('writes /Widths from the AFM metrics when the font has none', () => {
    const doc = Document.Open(buildStd14Pdf({ encoding: name('WinAnsiEncoding') }));
    doc.ConvertToPdfA('2b');
    const font = f1(doc);
    expect(font.get('FirstChar')).toBe(0);
    const w = doc.resolve(font.get('Widths'));
    expect(isArray(w) && w[0x48]).toBe(722);                            // Helvetica 'H'
  });

  it('keeps StandardEncoding semantics when the font states no /Encoding', () => {
    // 0x27 is quoteright in StandardEncoding and quotesingle in WinAnsi: the
    // rewrite to a PDF/A-legal WinAnsi base must name quoteright explicitly.
    const doc = Document.Open(buildStd14Pdf({ text: "it\\'s" }));
    const conv = doc.ConvertToPdfA('2b');
    expect(conv.passed).toBe(true);
    const e = doc.resolve(f1(doc).get('Encoding'));
    expect(isDict(e) && (e.get('BaseEncoding') as { name: string }).name).toBe('WinAnsiEncoding');
    const diffs = isDict(e) ? (doc.resolve(e.get('Differences')) as PdfObject[]) : [];
    const at = diffs.indexOf(0x27);
    expect(at).toBeGreaterThanOrEqual(0);
    expect((diffs[at + 1] as { name: string }).name).toBe('quoteright');
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toBe('it’s');
  });

  it('declines, putting the font back exactly, when a shown code\'s width disagrees', () => {
    const pdf = buildStd14Pdf({ encoding: name('WinAnsiEncoding'), text: 'H', widths: Array(95).fill(1000) });
    const doc = Document.Open(pdf);
    const orig = new Map(f1(doc));
    const conv = doc.ConvertToPdfA('2b');
    expect(conv.applied.some((a) => a.rule === 'FontEmbedded')).toBe(false);
    expect(conv.unresolved.map((i) => i.rule)).toContain('FontEmbedded');
    expect(new Map(f1(doc))).toEqual(orig);
  });

  it('accepts /Widths that agree for the codes shown, even where AFM and the face differ elsewhere', () => {
    // Helvetica's AFM and the bundled face disagree on ± (0xB1); an unshown code
    // must not decline the font.
    const widths = Array.from({ length: 95 }, (_, i) => (i === 0x48 - 32 ? 722 : 1000));
    const doc = Document.Open(buildStd14Pdf({ encoding: name('WinAnsiEncoding'), text: 'H', widths }));
    expect(doc.ConvertToPdfA('2b').passed).toBe(true);
  });

  it('leaves Symbol and a non-Standard-14 name alone', () => {
    for (const baseFont of ['Symbol', 'Arial']) {
      const doc = Document.Open(buildStd14Pdf({ baseFont }));
      const conv = doc.ConvertToPdfA('2b');
      expect(conv.applied.some((a) => a.rule === 'FontEmbedded')).toBe(false);
      expect(program(doc)).toBeUndefined();
    }
  });

  it('keeps the old behaviour under preserve: [\'fontEmbedding\']', () => {
    const doc = Document.Open(buildStd14Pdf({ encoding: name('WinAnsiEncoding') }));
    const conv = doc.ConvertToPdfA('2b', { preserve: ['fontEmbedding'] });
    expect(conv.unresolved.map((i) => i.rule)).toEqual(['FontEmbedded']);
    expect(program(doc)).toBeUndefined();
  });
});
