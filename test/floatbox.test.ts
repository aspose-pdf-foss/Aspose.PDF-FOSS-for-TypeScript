import { describe, it, expect } from 'vitest';
import { FloatingBox } from '../src/floatbox.js';
import { Document } from '../src/index.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

function newBox(opts: any) {
  const doc = Document.Open(buildBlankPage());
  return { doc, box: new FloatingBox(doc, opts) };
}

describe('FloatingBox model', () => {
  it('validates its options', () => {
    const { doc } = newBox({ width: 100 });
    expect(() => new FloatingBox(doc, { width: 0 })).toThrow(TypeError);
    expect(() => new FloatingBox(doc, { width: -5 })).toThrow(TypeError);
    expect(() => new FloatingBox(doc, { width: 100, spacing: -1 })).toThrow(TypeError);
    expect(() => new FloatingBox(doc, { width: 100, padding: -2 })).toThrow(TypeError);
    expect(() => new FloatingBox(doc, { width: 100, border: { width: -1, color: [0, 0, 0] } })).toThrow(TypeError);
    expect(() => new FloatingBox(doc, { width: 100, background: [2, 0, 0] as any })).toThrow(TypeError);
  });

  it('contentWidth subtracts padding and border from the outer width', () => {
    const { box } = newBox({ width: 100, padding: 6, border: { width: 2, color: [0, 0, 0] } });
    expect(box.contentWidth()).toBeCloseTo(100 - 12 - 4, 6); // 84
  });

  it('measures a one-line paragraph as leading + padding + border', () => {
    const { box } = newBox({ width: 100, padding: 5, border: { width: 1, color: [0, 0, 0] } });
    box.AddParagraph('short', { fontSize: 10, leading: 12 });
    // one line (12) + padTop+padBottom (10) + 2*border (2) = 24
    expect(box.measure()).toBeCloseTo(24, 6);
  });

  it('measures an image at its aspect ratio and adds inter-element spacing', () => {
    const { box } = newBox({ width: 100, spacing: 4 }); // no padding/border
    box.AddImage(buildPngRgb());                 // 2x1 → height = contentWidth/2
    box.AddParagraph('cap', { fontSize: 10, leading: 12 });
    // contentWidth = 100; image height = 100/2 = 50; + spacing 4 + line 12 = 66
    expect(box.measure()).toBeCloseTo(50 + 4 + 12, 6);
  });

  it('AddParagraph / AddImage are chainable', () => {
    const { box } = newBox({ width: 100 });
    expect(box.AddParagraph('a')).toBe(box);
    expect(box.AddImage(buildPngRgb())).toBe(box);
  });
});

describe('FloatingBox.paintAt', () => {
  it('paints background fill and border stroke around the box', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const box = new FloatingBox(doc, { width: 80, padding: 4,
      background: [0.9, 0.9, 1], border: { width: 1, color: [0, 0, 0] } });
    box.AddParagraph('hello', { fontSize: 10, leading: 12 });
    const h = box.paintAt(page, 50, 700);
    expect(h).toBeCloseTo(box.measure(), 6);
    const content = new TextDecoder('latin1').decode(page.Contents);
    const ops = content.split(/\s+/);
    expect(ops).toContain('rg');   // fill color set (background)
    expect(ops).toContain('re');   // rectangle path
    expect(ops).toContain('f');    // fill
    expect(ops).toContain('RG');   // stroke color set (border)
    expect(ops).toContain('S');    // stroke
    expect(content).toContain('(hello)'); // inner paragraph text
  });

  it('draws an inner image inside the padding box', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const box = new FloatingBox(doc, { width: 60, padding: 5 });
    box.AddImage(buildPngRgb()); // 2x1 → 50x25 at contentWidth 50
    box.paintAt(page, 100, 700);
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain(' Do');  // XObject draw
    expect(content).toContain(' cm');  // image placement matrix
  });
});

describe('FloatingBox per-side borders', () => {
  const opsOf = (doc: Document) =>
    new TextDecoder('latin1').decode(doc.Pages[0].Contents);
  /** Standalone `re` operators in the page content. */
  const rectOps = (s: string) => (s.match(/(^|\s)re(\s|$)/g) ?? []).length;

  function painted(sides?: unknown) {
    const { doc, box } = newBox({
      width: 100, padding: 5,
      border: { width: 2, color: [0, 0, 0], ...(sides === undefined ? {} : { sides }) },
    });
    box.AddParagraph('x', { fontSize: 10, leading: 12 });
    box.paintAt(doc.Pages[0], 20, 700);
    return opsOf(doc);
  }

  it('a left-only border strokes one edge, not a rect', () => {
    const s = painted({ left: true });
    expect(rectOps(s)).toBe(0);
    // The stroke is inset by half the border width, as the four-sided one is.
    const segs = [...s.matchAll(/([-\d.]+) ([-\d.]+) m\s+([-\d.]+) ([-\d.]+) l/g)];
    expect(segs.length).toBe(1);
    expect(Number(segs[0][1])).toBeCloseTo(21, 6);   // x + bw/2
    expect(Number(segs[0][3])).toBeCloseTo(21, 6);   // vertical
  });

  it('keeps padding on every side regardless of which edges are drawn', () => {
    const { box: all } = newBox({ width: 100, padding: 5, border: { width: 2, color: [0, 0, 0] } });
    const { box: left } = newBox({
      width: 100, padding: 5, border: { width: 2, color: [0, 0, 0], sides: { left: true } },
    });
    all.AddParagraph('x', { fontSize: 10, leading: 12 });
    left.AddParagraph('x', { fontSize: 10, leading: 12 });
    // Geometry does not move when only the drawn edges change, so toggling
    // `sides` never reflows the text inside the box.
    expect(left.contentWidth()).toBeCloseTo(all.contentWidth(), 6);
    expect(left.measure()).toBeCloseTo(all.measure(), 6);
  });

  it("omitting sides, 'all' and all four flags are byte-identical", () => {
    const base = painted();
    expect(painted('all')).toBe(base);
    expect(painted({ top: true, right: true, bottom: true, left: true })).toBe(base);
    expect(rectOps(base)).toBeGreaterThanOrEqual(1);   // still the rect shorthand
  });

  it("sides: 'none' draws no border at all", () => {
    // Operators are newline-joined, so the stroke is a standalone `S` token —
    // matching on ' S' would never fire and the test would pass regardless.
    const strokes = (s: string) => (s.match(/(^|\s)S(\s|$)/g) ?? []).length;
    expect(strokes(painted())).toBeGreaterThanOrEqual(1);
    expect(strokes(painted('none'))).toBe(0);
  });

  it('uses the same sides vocabulary as the table BorderInfo', async () => {
    // One spelling for "a rectangle with a subset of its edges drawn".
    const { resolveBorderSides } = await import('../src/bordersides.js');
    const tableauthor = await import('../src/tableauthor.js');
    expect(tableauthor.resolveBorderSides).toBe(resolveBorderSides);
  });

  it('rejects a malformed sides value', () => {
    const { doc } = newBox({ width: 100 });
    expect(() => new FloatingBox(doc, {
      width: 100, border: { width: 1, color: [0, 0, 0], sides: 'outer' as never },
    })).toThrow(/sides/);
    expect(() => new FloatingBox(doc, {
      width: 100, border: { width: 1, color: [0, 0, 0], sides: { botton: true } as never },
    })).toThrow(/sides/);
  });
});
