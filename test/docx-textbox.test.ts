import { describe, it, expect } from 'vitest';
import { docxTextboxBody, type TextboxPage } from '../src/docxtextbox.js';
import type { TextGroup } from '../src/docxgroup.js';

const A4: [number, number, number, number] = [0, 0, 595.28, 841.89];

/** A group of `text` whose glyphs are `size * 0.5` wide each. */
function group(text: string, x: number, baseline: number, size = 10): TextGroup {
  return {
    quad: [x, baseline, x + text.length * size * 0.5, baseline + size],
    fontSize: size, text,
  };
}

const page = (p: Partial<TextboxPage> = {}): TextboxPage =>
  ({ box: A4, groups: [], images: [], ...p });

describe('docxTextboxBody', () => {
  it('places a group at its quad, in twips from the page top-left', () => {
    // A 10pt group whose baseline sits at y=741.89 has quad top 751.89, so it
    // is 90pt below the A4 page top: 90 * 20 = 1800 twips. x = 72pt = 1440.
    const xml = docxTextboxBody([page({ groups: [group('Hello', 72, 741.89)] })]);
    expect(xml).toContain('w:x="1440"');
    expect(xml).toContain('w:y="1800"');
  });

  it('measures against the sizing box origin, not the page', () => {
    // A CropBox offset by (20, 30): a group at x=92 is 72pt from the box's left
    // edge, and its top is measured down from the box's own top.
    const xml = docxTextboxBody([page({
      box: [20, 30, 615.28, 871.89], groups: [group('Hello', 92, 771.89)],
    })]);
    expect(xml).toContain('w:x="1440"');
    expect(xml).toContain('w:y="1800"');
  });

  it('errs wide on the frame width', () => {
    // A group 25pt wide: 25 * 1.25 + 2 = 33.25pt = 665 twips. Word re-measures
    // with a substituted face, and a narrow frame wraps to a second line while
    // an over-wide one displaces nothing under w:wrap="none".
    const xml = docxTextboxBody([page({ groups: [group('Hello', 72, 700)] })]);
    expect(xml).toContain('w:w="665"');
  });

  it('never claims width past the sizing box edge', () => {
    // 10pt of room left, so the 33.25pt the headroom asks for is clamped.
    const xml = docxTextboxBody([page({ groups: [group('Hello', 585.28, 700)] })]);
    expect(xml).toContain('w:w="200"');
  });

  it('emits the run size, colour and emphasis', () => {
    const g: TextGroup = { ...group('Hi', 72, 700, 14), color: [255, 0, 0], bold: true };
    const xml = docxTextboxBody([page({ groups: [g] })]);
    expect(xml).toContain('<w:sz w:val="28"/>');
    expect(xml).toContain('<w:color w:val="FF0000"/>');
    expect(xml).toContain('<w:b/>');
  });

  it('places a skewed group unrotated at its quad top-left', () => {
    // A frame has no rotation to give it, and visible ink beats silently
    // dropped content — the rule svgdraw.ts sets.
    const g: TextGroup = { ...group('turn', 72, 700), skewed: true };
    const xml = docxTextboxBody([page({ groups: [g] })]);
    expect(xml).toContain('w:x="1440"');
    expect(xml).toContain('turn');
    expect(xml).not.toContain('rot=');
  });

  it('skips a group with no text', () => {
    const xml = docxTextboxBody([page({ groups: [{ ...group('', 72, 700), text: '' }] })]);
    expect(xml).not.toContain('w:framePr');
  });

  it('states each page size in its own section', () => {
    const xml = docxTextboxBody([
      page({ box: [0, 0, 595.28, 841.89] }),
      page({ box: [0, 0, 612, 792] }),
    ]);
    expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"/>');   // A4
    expect(xml).toContain('<w:pgSz w:w="12240" w:h="15840"/>');   // US Letter
  });

  it('puts a non-final sectPr inside a paragraph and the final one in the body', () => {
    // The two spellings are not interchangeable, and the wrong one is a file
    // Word refuses — the same class of rule as w:tcPr's ordered children.
    const xml = docxTextboxBody([page(), page()]);
    expect(xml).toContain('<w:p><w:pPr><w:sectPr>');
    expect(xml.trimEnd().endsWith('</w:sectPr>')).toBe(true);
  });

  it('emits one unframed anchor paragraph per page', () => {
    // A framed paragraph is lifted out of the flow, so a page of nothing but
    // frames has no flow content and its section collapses into the next.
    const xml = docxTextboxBody([page({ groups: [group('Hi', 72, 700)] })]);
    expect((xml.match(/w:framePr/g) ?? [])).toHaveLength(1);
    expect((xml.match(/<w:p>/g) ?? [])).toHaveLength(2);
  });

  it('states zero page margins', () => {
    // Frames anchor to the page edge regardless, but the unframed anchor
    // paragraph does not — a default 1" margin could give it a page of its own.
    const xml = docxTextboxBody([page()]);
    expect(xml).toContain('w:top="0"');
    expect(xml).toContain('w:left="0"');
  });

  it('emits the backdrop before any text frame', () => {
    // Frames stack in document order, so a backdrop emitted after the text
    // hides the page.
    const xml = docxTextboxBody([page({
      groups: [group('Hi', 72, 700)], backdrop: { rid: 'rId9' },
    })]);
    expect(xml.indexOf('rId9')).toBeLessThan(xml.indexOf('Hi'));
  });

  it('sizes the backdrop to the whole sizing box', () => {
    const xml = docxTextboxBody([page({ backdrop: { rid: 'rId9' } })]);
    expect(xml).toContain('w:x="0"');
    expect(xml).toContain('w:y="0"');
    expect(xml).toContain('w:w="11906"');
  });

  it('places an image at its quad', () => {
    const xml = docxTextboxBody([page({
      images: [{ rid: 'rId5', quad: [72, 600, 172, 700], alt: 'a chart' }],
    })]);
    expect(xml).toContain('rId5');
    expect(xml).toContain('descr="a chart"');
    expect(xml).toContain('w:x="1440"');
  });

  it('gives every drawing a distinct non-zero docPr id', () => {
    // Word tolerates a duplicate in some builds and calls the file corrupt in
    // others, which makes it look like a reader-dependent defect.
    const xml = docxTextboxBody([page({
      backdrop: { rid: 'rId9' },
      images: [
        { rid: 'rId5', quad: [10, 10, 20, 20] },
        { rid: 'rId6', quad: [30, 30, 40, 40] },
      ],
    })]);
    const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => Number(m[1]));
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((n) => n > 0)).toBe(true);
  });

  it('counts drawing ids across pages, not within one', () => {
    const xml = docxTextboxBody([
      page({ images: [{ rid: 'rId5', quad: [10, 10, 20, 20] }] }),
      page({ images: [{ rid: 'rId6', quad: [10, 10, 20, 20] }] }),
    ]);
    const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => Number(m[1]));
    expect(new Set(ids).size).toBe(2);
  });

  it('returns a body with a sectPr for a page with no content', () => {
    expect(docxTextboxBody([page()])).toContain('<w:sectPr>');
  });

  it('returns an empty string for no pages', () => {
    expect(docxTextboxBody([])).toBe('');
  });
});
