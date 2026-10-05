import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { name } from '../src/types.js';
import { visitContent } from '../src/text.js';
import type { TextFont } from '../src/font.js';
import { buildSimpleTextPdf, buildToUnicodePdf, buildType0Pdf } from './helpers/build-text-pdf.js';
import { buildSimpleCffPdf, buildSimpleTtfPdf, buildType1EmbeddedPdf } from './helpers/build-optimize-pdf.js';

const NIMBUS = new Uint8Array(readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.otf', import.meta.url)));
const T1 = new Uint8Array(readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.t1', import.meta.url)));
const LIB = new Uint8Array(readFileSync(new URL('./fixtures/fonts/LiberationSans-Regular.woff2', import.meta.url)));

/** The TextFont of the first glyph on page 1. */
const fontOf = (doc: Document): TextFont => {
  let f: TextFont | undefined;
  visitContent(doc, doc.Pages[0], { glyph: (e) => { f ??= e.font; } });
  return f!;
};
const bytes = (u: Uint8Array | undefined) => (u ? [...u] : undefined);

describe('TextFont.drawCode', () => {
  it('encodes through a non-embedded font by its encoding', () => {
    const f = fontOf(Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (A) Tj ET')));
    expect(bytes(f.drawCode('A'))).toEqual([0x41]);
    expect(f.drawCode('Ω')).toBeUndefined();
  });

  it('rejects a code that does not decode back to the character', () => {
    // /ToUnicode says code 0x41 is "Z": writing 0x41 for "A" would extract as Z.
    const cmap = '1 begincodespacerange <00> <FF> endcodespacerange\n1 beginbfchar <41> <005A> endbfchar\n';
    const f = fontOf(Document.Open(buildToUnicodePdf('BT /F1 12 Tf 20 250 Td (A) Tj ET', cmap)));
    expect(f.drawCode('A')).toBeUndefined();
    // 0x5A (WinAnsi's own Z) and 0x41 (remapped by /ToUnicode) both decode to
    // Z; the encoding's candidate is tried first.
    expect(bytes(f.drawCode('Z'))).toEqual([0x5a]);
  });

  it('refuses a character an embedded program does not map', () => {
    const f = fontOf(Document.Open(buildSimpleTtfPdf({ encoding: name('WinAnsiEncoding'), content: '(A)' })));
    expect(bytes(f.drawCode('A'))).toEqual([0x41]);
    expect(f.drawCode('C')).toBeUndefined();   // WinAnsi encodes C; the program's cmap has no C
  });

  it('refuses a glyph a subset blanked, which used to draw nothing', () => {
    const before = Document.Open(buildSimpleTtfPdf({ encoding: name('WinAnsiEncoding'), content: '(A)' }));
    expect(bytes(fontOf(before).drawCode('B'))).toEqual([0x42]);   // whole font: B has an outline
    before.Optimize();
    const after = Document.Open(before.Save());
    expect(fontOf(after).drawCode('B')).toBeUndefined();          // B's slot is now empty
    expect(bytes(fontOf(after).drawCode('A'))).toEqual([0x41]);
  });

  it('re-encodes a Type0 Identity-H font through the inverse ToUnicode', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfchar <0003> <0048> <0004> <0069> endbfchar\n';
    const f = fontOf(Document.Open(buildType0Pdf('BT /F1 12 Tf 20 250 Td <0003> Tj ET', cmap)));
    expect(bytes(f.drawCode('i'))).toEqual([0, 4]);
    expect(f.drawCode('Q')).toBeUndefined();
  });

  it('declines a Type0 font under any CMap but Identity', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfchar <0003> <0048> endbfchar\n';
    const f = fontOf(Document.Open(buildType0Pdf('BT /F1 12 Tf 20 250 Td <0003> Tj ET', cmap, { encoding: 'UniGB-UCS2-H' })));
    expect(f.drawCode('H')).toBeUndefined();
  });

  it('draws only what a real embedded Type0 subset holds', () => {
    const src = Document.New(PageFormat.A4);
    src.Pages[0].AddText('Draft', 50, 700, { font: src.AddFont(NIMBUS) });
    const f = fontOf(Document.Open(src.Save()));
    expect(f.drawCode('D')?.length).toBe(2);
    expect(f.drawCode('Q')).toBeUndefined();
  });

  it('keeps a space drawable though its glyph has no outline', () => {
    // Liberation is glyf-flavoured: its space glyph is a zero-length slot.
    const src = Document.New(PageFormat.A4);
    src.Pages[0].AddText('a b', 50, 700, { font: src.AddFont(LIB) });
    expect(fontOf(Document.Open(src.Save())).drawCode(' ')?.length).toBe(2);
  });

  it('treats gid 0 of a Type 1 program as an ordinary glyph', () => {
    // NimbusSans-Regular.t1 lists /A FIRST, so A is gid 0 in this program.
    const f = fontOf(Document.Open(buildType1EmbeddedPdf('BT /F1 12 Tf 20 250 Td (A) Tj ET', T1)));
    expect(bytes(f.drawCode('A'))).toEqual([0x41]);
  });

  it('refuses a Type 1 glyph a subset blanked to an empty charstring', () => {
    const before = Document.Open(buildType1EmbeddedPdf('BT /F1 12 Tf 20 250 Td (AB) Tj ET', T1));
    expect(bytes(fontOf(before).drawCode('C'))).toEqual([0x43]);   // whole program: C has an outline
    before.Optimize();
    const after = Document.Open(before.Save());
    expect(fontOf(after).drawCode('C')).toBeUndefined();
    expect(bytes(fontOf(after).drawCode('A'))).toEqual([0x41]);
  });

  it('refuses a CFF glyph a subset blanked to an empty charstring', () => {
    const before = Document.Open(buildSimpleCffPdf({ encoding: name('WinAnsiEncoding'), content: '(A)' }));
    expect(bytes(fontOf(before).drawCode('B'))).toEqual([0x42]);
    before.Optimize();
    const after = Document.Open(before.Save());
    expect(fontOf(after).drawCode('B')).toBeUndefined();
    expect(bytes(fontOf(after).drawCode('A'))).toEqual([0x41]);
  });
});
