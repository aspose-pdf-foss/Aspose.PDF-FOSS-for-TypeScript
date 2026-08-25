import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { EditableContent } from '../src/editcontent.js';
import { removeGlyphsUnder } from '../src/redact.js';
import { visitContent, GlyphEvent } from '../src/text.js';
import { inflateStream } from '../src/flate.js';
import { isStream, isDict } from '../src/types.js';
import { buildMultiStreamPage, buildSharedXObjectPages } from './helpers/build-edit-pdf.js';

/** Inflated content bytes of every /Contents stream + every form XObject, joined. */
function allContentText(doc: Document, pageIndex = 0): string {
  const page = doc.Pages[pageIndex];
  const dec = new TextDecoder('latin1');
  let s = dec.decode(page.Contents);
  const res = doc.resolve(page.Dict.get('Resources'));
  const xo = isDict(res) ? doc.resolve(res.get('XObject')) : undefined;
  if (isDict(xo)) for (const [, v] of xo) {
    const st = doc.resolve(v);
    if (isStream(st)) s += '\n' + dec.decode(inflateStream(st));
  }
  return s;
}

/** The concatenated contents of every `(...)` string literal in the content. */
function literalText(doc: Document, pageIndex = 0): string {
  return (allContentText(doc, pageIndex).match(/\(([^)]*)\)/g) ?? []).join('');
}

function glyphs(doc: Document, pageIndex = 0): GlyphEvent[] {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[pageIndex], { glyph: (e) => out.push(e) });
  return out;
}

describe('removeGlyphsUnder — whole show op', () => {
  it('removes an entire Tj covered by a rect, preserving surrounding ops', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (SECRET) Tj ET']));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    removeGlyphsUnder(doc, page, [[40, 95, 120, 115]], ec);
    ec.commit();

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).not.toContain('SECRET');
  });
});

describe('removeGlyphsUnder — partial run split', () => {
  it('drops only the covered glyphs and keeps survivors in place', () => {
    // Fixture font is Helvetica with no /Widths, so the AFM metrics apply
    // (A=B=667, C=D=722 @10 = 6.67 / 7.22 units per glyph).
    // Glyph x-spans: A[50,56.67] B[56.67,63.34] C[63.34,70.56] D[70.56,77.78].
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (ABCD) Tj ET']));
    const page = doc.Pages[0];

    const dBefore = glyphs(doc).find((g) => g.text === 'D')!.quad[0];

    const ec = new EditableContent(doc, page);
    removeGlyphsUnder(doc, page, [[57, 95, 70, 115]], ec); // covers B and C only
    ec.commit();

    const reopened = Document.Open(doc.Save());
    // B and C are gone from the rendered text and from the raw content bytes.
    const surviving = glyphs(reopened).map((g) => g.text);
    expect(surviving).toEqual(['A', 'D']);
    expect(literalText(reopened)).not.toMatch(/B|C/);

    // D's device position is unchanged: the removed run became an equal shift.
    const dAfter = glyphs(reopened).find((g) => g.text === 'D')!.quad[0];
    expect(dAfter).toBeCloseTo(dBefore, 1);
  });

  it('splits a TJ array, keeping original kerning numbers and survivors', () => {
    // [(AB) -50 (CD)]: A[50,56.67] B[56.67,63.34]; kern -50 -> +0.5;
    // C[63.84,71.06] D[71.06,78.28].
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td [(AB) -50 (CD)] TJ ET']));
    const page = doc.Pages[0];
    const dBefore = glyphs(doc).find((g) => g.text === 'D')!.quad[0];

    const ec = new EditableContent(doc, page);
    removeGlyphsUnder(doc, page, [[64.5, 95, 70.5, 115]], ec); // covers C only
    ec.commit();

    const reopened = Document.Open(doc.Save());
    expect(glyphs(reopened).map((g) => g.text)).toEqual(['A', 'B', 'D']);
    expect(literalText(reopened)).not.toContain('C');
    expect(allContentText(reopened)).toContain('-50'); // original kern preserved
    const dAfter = glyphs(reopened).find((g) => g.text === 'D')!.quad[0];
    expect(dAfter).toBeCloseTo(dBefore, 1);
  });
});

describe('removeGlyphsUnder — line-show operators', () => {
  it("keeps the T* move when splitting a ' (apostrophe) show op", () => {
    // 'keep' on the first line; (drop) ' moves to the next line then shows.
    const doc = Document.Open(buildMultiStreamPage(
      ["BT /F1 10 Tf 14 TL 50 200 Td (keep) Tj (drop) ' ET"]));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    removeGlyphsUnder(doc, page, [[45, 181, 75, 199]], ec); // covers 'drop' on line 2
    ec.commit();

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).toContain('keep');
    expect(literalText(reopened)).not.toContain('drop');
    expect(allContentText(reopened)).toContain('T*'); // newline move preserved
  });

  it('keeps the Tw/Tc state when splitting a " show op', () => {
    const doc = Document.Open(buildMultiStreamPage(
      ['BT /F1 10 Tf 14 TL 50 200 Td (keep) Tj 2 1 (drop) " ET']));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    removeGlyphsUnder(doc, page, [[45, 181, 75, 199]], ec);
    ec.commit();

    const reopened = Document.Open(doc.Save());
    const content = allContentText(reopened);
    expect(literalText(reopened)).not.toContain('drop');
    expect(content).toMatch(/2 Tw/); // word spacing from the " operand preserved
    expect(content).toMatch(/1 Tc/); // char spacing preserved
  });
});

describe('removeGlyphsUnder — Form XObject copy-on-write', () => {
  it('redacts text drawn through a shared XObject without touching the other page', () => {
    const doc = Document.Open(buildSharedXObjectPages()); // both pages draw Fm0 -> "shared"
    const page0 = doc.Pages[0];
    const ec = new EditableContent(doc, page0);
    removeGlyphsUnder(doc, page0, [[45, 45, 95, 75]], ec); // covers all of "shared"
    ec.commit();

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).not.toContain('shared');
    expect(reopened.Pages[1].GetText()).toBe('shared');     // other page intact
    expect(literalText(reopened, 0)).not.toContain('shared'); // gone from page 0's clone
    expect(literalText(reopened, 1)).toContain('shared');     // still in page 1's original
  });
});
