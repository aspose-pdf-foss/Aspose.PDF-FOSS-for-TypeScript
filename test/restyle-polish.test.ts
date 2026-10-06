import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseContentStream, type ContentOp } from '../src/content.js';
import { isName, isDict } from '../src/types.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { renderPageRgb } from '../src/raster.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildSimpleTextPdf, buildFormTextPdf } from './helpers/build-text-pdf.js';
import { buildTaggedMultiStreamPage } from './helpers/build-edit-pdf.js';

// RestyleText follow-ups (u3l5.12).
const plain = (s: string) => Document.Open(buildSimpleTextPdf(s));
const opText = (op: ContentOp): string => [
  ...op.operands.map((o) => (typeof o === 'number' ? String(o) : isName(o) ? `/${o.name}` : '…')), op.operator,
].join(' ');
const ops = (doc: Document) => parseContentStream(doc.Pages[0].Contents).map(opText);
const glyphs = (doc: Document): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (g) => out.push(g) });
  return out;
};
/** Pixels in a page-space box (y0 < y1) for which `pred` holds, at scale 2. */
const count = (doc: Document, [x0, y0, x1, y1]: number[], pred: (r: number, g: number, b: number) => boolean): number => {
  const { width, height, rgb, device } = renderPageRgb(doc, doc.Pages[0], 2);
  const px = (x: number, y: number) => [device[0] * x + device[2] * y + device[4], device[1] * x + device[3] * y + device[5]];
  const [ax, ay] = px(x0, y0), [bx, by] = px(x1, y1);
  let n = 0;
  for (let y = Math.max(0, Math.floor(Math.min(ay, by))); y < Math.min(height, Math.ceil(Math.max(ay, by))); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(ax, bx))); x < Math.min(width, Math.ceil(Math.max(ax, bx))); x++) {
      const i = (y * width + x) * 3;
      if (pred(rgb[i], rgb[i + 1], rgb[i + 2])) n++;
    }
  }
  return n;
};
/** The `re` operator of a decoration rule: its numbers print as themselves. */
const isRule = (s: string) => s.endsWith(' re');
const firstRule = (t: string[]) => t.findIndex(isRule);
const lastRule = (t: string[]) => t.length - 1 - [...t].reverse().findIndex(isRule);

describe('RestyleText under a clipping render mode (u3l5.12)', () => {
  // Tr 7 draws nothing and clips to the glyphs at ET; the blue fill after it
  // shows only through them. A rule painted after ET is cut to the glyph
  // outlines and then painted over in blue, so no black would show at all.
  const SRC = 'BT /F1 24 Tf 7 Tr 20 200 Td (Hello world) Tj ET 0 0 1 rg 0 0 300 300 re f';

  it('puts the rules before BT, so the clip does not cut them', () => {
    const doc = plain(SRC);
    expect(doc.Pages[0].RestyleText('world', { strikethrough: true })).toBe(1);
    const t = ops(doc);
    expect(firstRule(t)).toBeGreaterThanOrEqual(0);
    expect(firstRule(t)).toBeLessThan(t.indexOf('BT'));
    const q = glyphs(doc).filter((g) => 'world'.includes(g.text) && g.quad[0] > 60).map((g) => g.quad);
    const box = [Math.min(...q.map((r) => r[0])), Math.min(...q.map((r) => r[1])), Math.max(...q.map((r) => r[2])), Math.max(...q.map((r) => r[3]))];
    expect(count(doc, box, (r, g, b) => r < 60 && g < 60 && b < 60)).toBeGreaterThan(50);
  });

  it('treats the whole text object as clipping when an earlier run clips', () => {
    // "world" itself is drawn in mode 0, but "Hello" in mode 7 makes the ET
    // clip to its outlines, which would cut away a rule under "world".
    const doc = plain('BT /F1 24 Tf 7 Tr 20 200 Td (Hello) Tj 0 Tr ( world) Tj ET 0 0 1 rg 0 0 300 300 re f');
    expect(glyphs(doc).find((g) => g.text === 'w')!.renderMode ?? 0).toBe(0);
    doc.Pages[0].RestyleText('world', { strikethrough: true });
    const t = ops(doc);
    expect(firstRule(t)).toBeGreaterThanOrEqual(0);
    expect(firstRule(t)).toBeLessThan(t.indexOf('BT'));
  });

  it('keeps the rules after ET for text that does not clip', () => {
    const doc = plain('BT /F1 24 Tf 20 200 Td (Hello world) Tj ET');
    doc.Pages[0].RestyleText('world', { strikethrough: true });
    const t = ops(doc);
    expect(lastRule(t)).toBeGreaterThan(t.indexOf('ET'));
  });
});

describe("RestyleText draws a text-coloured rule in the fill's own colour space (u3l5.12)", () => {
  it('re-emits a CMYK fill rather than its RGB approximation', () => {
    const doc = plain('0 0 0 1 k BT /F1 12 Tf 20 250 Td (Hello world) Tj ET');
    doc.Pages[0].RestyleText('world', { underline: true });
    const t = ops(doc);
    expect(t[lastRule(t) - 1]).toBe('0 0 0 1 k');
    expect(t.some((s) => s.endsWith(' rg'))).toBe(false);
  });

  it('keeps an explicit rule colour, and a replacement colour', () => {
    const a = plain('0 0 0 1 k BT /F1 12 Tf 20 250 Td (Hello world) Tj ET');
    a.Pages[0].RestyleText('world', { underline: { color: [1, 0, 0] } });
    expect(ops(a)).toContain('1 0 0 rg');
    const b = plain('0 0 0 1 k BT /F1 12 Tf 20 250 Td (Hello world) Tj ET');
    b.Pages[0].RestyleText('world', { underline: true, color: [0, 0, 1] });
    const t = ops(b);
    expect(t[lastRule(t) - 1]).toBe('0 0 1 rg');
  });

  it('copies a colour space named on the page into the form the text is in', () => {
    const doc = Document.Open(buildFormTextPdf('/CS0 cs 1 sc /Fm0 Do', 'BT /F1 12 Tf 20 250 Td (Hello world) Tj ET', {
      pageRes: '/ColorSpace << /CS0 [/Indexed /DeviceRGB 1 <0000FF00FF00>] >>',
    }));
    doc.Pages[0].RestyleText('world', { underline: true });
    const xobjs = doc.resolve(doc.Pages[0].Resources!.get('XObject')) as Map<string, never>;
    const form = doc.resolve(xobjs.get('Fm0')) as unknown as { dict: Map<string, never> };
    const cs = doc.resolve(doc.resolve(form.dict.get('Resources')) && (doc.resolve(form.dict.get('Resources')) as Map<string, never>).get('ColorSpace'));
    expect(isDict(cs) && cs.has('CS0')).toBe(true);
    // The rule is green, index 1 of the copied space: just under the baseline.
    const w = glyphs(doc).find((g) => g.text === 'w')!.quad;
    expect(count(doc, [w[0], w[1] - 4, w[2], w[1]], (r, g, b) => g > 180 && r < 80 && b < 80)).toBeGreaterThan(5);
  });
});

describe('RestyleText in a Form XObject drawn twice (u3l5.12)', () => {
  const twice = () => Document.Open(buildFormTextPdf(
    'q /Fm0 Do Q q 1 0 0 1 60 0 cm /Fm0 Do Q', 'BT /F1 12 Tf 20 250 Td (ab) Tj ET'));

  it('decorates once when every drawing is matched', () => {
    const doc = twice();
    expect(doc.Pages[0].GetText()).toBe('ab ab');
    expect(doc.Pages[0].RestyleText('ab', { underline: true })).toBe(2);
  });

  it('refuses a decoration a match covers in only one drawing, changing nothing', () => {
    const doc = twice();
    const before = doc.Save();
    expect(() => doc.Pages[0].RestyleText(/b a/, { underline: true })).toThrow(UnsupportedFeatureError);
    expect(() => doc.Pages[0].RestyleText(/b a/, { underline: true })).toThrow(/drawn 2 times/);
    expect(doc.Save()).toEqual(before);
  });
});

describe('RestyleText finds the text object by tracking BT and ET (u3l5.12)', () => {
  it('decorates a show operator outside any text object around itself', () => {
    // Malformed: (bbb) Tj sits between two text objects.
    const doc = plain('BT /F1 12 Tf 20 250 Td (aaa) Tj ET (bbb) Tj BT 20 100 Td (ccc) Tj ET');
    doc.Pages[0].RestyleText('bbb', { underline: true });
    const t = ops(doc);
    const show = t.indexOf('… Tj', t.indexOf('ET'));
    expect(t[show + 1]).toBe('q');
    expect(t.indexOf('BT', show)).toBeGreaterThan(t.indexOf('Q', show));
  });
});

describe('RestyleText keeps a tagged decoration outside structure content across streams (u3l5.12)', () => {
  it('places the artifacts outside a structure sequence that spans three streams', () => {
    const doc = Document.Open(buildTaggedMultiStreamPage([
      '/P << /MCID 0 >> BDC', 'BT /F1 12 Tf 20 250 Td (Hello world) Tj ET', 'EMC',
    ]));
    doc.Pages[0].RestyleText('world', { underline: true, background: [1, 1, 0] });
    const stack: string[] = [];
    let artifacts = 0;
    for (const op of parseContentStream(doc.Pages[0].Contents)) {
      if (op.operator === 'BDC' || op.operator === 'BMC') {
        const tag = (op.operands[0] as { name: string }).name;
        if (tag === 'Artifact') { artifacts++; expect(stack.filter((s) => s !== 'Artifact' && s !== 'OC')).toEqual([]); }
        stack.push(tag);
      } else if (op.operator === 'EMC') stack.pop();
    }
    expect(artifacts).toBe(2);
  });
});
