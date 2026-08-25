import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { caretBody, redactMarkBody, regenerateAppearance } from '../src/annotdraw.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';
import { PdfDict, PdfObject, isDict, isStream, name } from '../src/types.js';
import type { WidgetGeom } from '../src/appearance.js';

/** A bare annotation dict of `subtype`, alongside a fresh document to own its
 *  appearance objects. The dict is not attached to a page: regenerateAppearance
 *  works on the dict alone. */
function attach(subtype: string, entries: [string, PdfObject][]): { doc: Document; dict: PdfDict } {
  const doc = Document.Open(buildAnnotTarget());
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Annot')],
    ['Subtype', name(subtype)],
    ...entries,
  ]);
  return { doc, dict };
}

/** The decoded /AP /N content stream, or undefined when there is none. */
function apBody(doc: Document, dict: PdfDict): string | undefined {
  const ap = doc.resolve(dict.get('AP'));
  if (!isDict(ap)) return undefined;
  const n = doc.resolve(ap.get('N'));
  return isStream(n) ? new TextDecoder('latin1').decode(n.raw) : undefined;
}

describe('regenerateAppearance', () => {
  it('draws a square from /Rect, /C, /IC and /BS /W', () => {
    const { doc, dict } = attach('Square', [
      ['Rect', [10, 10, 110, 60]],
      ['C', [1, 0, 0]],
      ['IC', [0, 0, 1]],
      ['BS', new Map<string, PdfObject>([['W', 2]])],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain(' re');          // a rectangle path
    expect(body).toContain('1 0 0 RG');     // stroke colour from /C
    expect(body).toContain('0 0 1 rg');     // fill colour from /IC
    expect(body).toContain('2 w');          // width from /BS /W
  });

  it('draws a circle as Béziers, not a rectangle', () => {
    const { doc, dict } = attach('Circle', [['Rect', [0, 0, 80, 40]], ['C', [0, 0, 0]]]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain(' c\n');
    expect(body).not.toContain(' re');
  });

  it('draws a highlight from /QuadPoints and applies /CA', () => {
    const { doc, dict } = attach('Highlight', [
      ['Rect', [0, 0, 100, 20]],
      ['QuadPoints', [0, 20, 100, 20, 0, 0, 100, 0]],
      ['C', [1, 1, 0]],
      ['CA', 0.4],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain('1 1 0 rg');
    expect(body).toContain('/GS0 gs');      // opacity < 1 installs an ExtGState
  });

  it('strokes an underline along the bottom of each quad', () => {
    const { doc, dict } = attach('Underline', [
      ['Rect', [0, 0, 100, 20]],
      ['QuadPoints', [0, 20, 100, 20, 0, 0, 100, 0]],
      ['C', [0, 0, 1]],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain('0 0 1 RG');
    expect(body).toContain(' l S');
  });

  it('draws a line with its /LE endings', () => {
    const { doc, dict } = attach('Line', [
      ['Rect', [0, 0, 100, 50]],
      ['L', [10, 10, 90, 40]],
      ['LE', [name('None'), name('ClosedArrow')]],
      ['C', [0, 0, 0]],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain(' m ');
    expect(body).toContain(' l ');
  });

  it('draws a polygon from /Vertices', () => {
    const { doc, dict } = attach('Polygon', [
      ['Rect', [0, 0, 60, 60]],
      ['Vertices', [0, 0, 50, 0, 25, 50]],
      ['C', [0, 0, 0]],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    expect(apBody(doc, dict)).toContain('h ');   // polygon closes its path
  });

  it('draws ink strokes from /InkList', () => {
    const { doc, dict } = attach('Ink', [
      ['Rect', [0, 0, 60, 60]],
      ['InkList', [[0, 0, 10, 10, 20, 5], [30, 30, 40, 40]]],
      ['C', [0, 0, 0]],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain(' m ');
    expect(body).not.toContain('h ');            // ink strokes stay open
  });

  it('draws a free-text box with its contents', () => {
    const { doc, dict } = attach('FreeText', [
      ['Rect', [0, 0, 120, 60]],
      ['Contents', { kind: 'string', bytes: new TextEncoder().encode('hello') }],
      ['DA', { kind: 'string', bytes: new TextEncoder().encode('0 0 0 rg /Helv 10 Tf') }],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    expect(apBody(doc, dict)).toContain('BT');
  });

  it('returns false and installs nothing for a subtype with no generator', () => {
    const { doc, dict } = attach('Sound', [['Rect', [0, 0, 20, 20]]]);
    expect(regenerateAppearance(doc, dict)).toBe(false);
    expect(dict.has('AP')).toBe(false);
  });

  it('returns false for a degenerate /Rect rather than dividing by zero', () => {
    const { doc, dict } = attach('Square', [['Rect', [10, 10, 10, 10]], ['C', [0, 0, 0]]]);
    expect(regenerateAppearance(doc, dict)).toBe(false);
    expect(dict.has('AP')).toBe(false);
  });

  it('returns false when the geometry entry is missing or malformed', () => {
    const noQuads = attach('Highlight', [['Rect', [0, 0, 100, 20]], ['C', [1, 1, 0]]]);
    expect(regenerateAppearance(noQuads.doc, noQuads.dict)).toBe(false);
    const badVerts = attach('Polygon', [['Rect', [0, 0, 60, 60]], ['Vertices', [0, 0]]]);
    expect(regenerateAppearance(badVerts.doc, badVerts.dict)).toBe(false);
  });
});

describe('redactMarkBody', () => {
  const quad = { x1: 0, y1: 10, x2: 20, y2: 10, x3: 0, y3: 0, x4: 20, y4: 0 };

  it('strokes the quad outline and never fills it', () => {
    const body = redactMarkBody([quad], [1, 0, 0]);
    expect(body).toContain('1 0 0 RG');   // stroke colour
    expect(body).toContain('h S');        // closed, stroked
    expect(body).not.toContain(' rg');    // no fill colour set
    expect(body).not.toMatch(/\bf\b/);    // no fill op
  });

  it('emits one closed subpath per quad', () => {
    const body = redactMarkBody([quad, quad], [0, 0, 0]);
    expect(body.match(/ m /g)).toHaveLength(2);
    expect(body.match(/h S/g)).toHaveLength(2);
  });
});

describe('caretBody', () => {
  const g: WidgetGeom = { w: 40, h: 20, rotate: 0 };

  it('draws a filled, curved wedge — not a plain triangle', () => {
    const body = caretBody(g, [0, 0, 0], 'none');
    expect(body).toContain('0 0 0 rg');           // fill colour
    expect(body.match(/ c\n/g)).toHaveLength(2);  // two curved sides
    expect(body).toContain('h f');                // closed and filled
    expect(body).not.toContain(' S');             // never stroked
  });

  it('curves the sides inward rather than straight to the apex', () => {
    // The left side runs (0,0) -> apex (20,20). A straight edge would put its
    // control points on that line; concave means both sit to the RIGHT of it,
    // which is the whole visual difference from a triangle.
    const body = caretBody(g, [0, 0, 0], 'none');
    const curve = body.split('\n').find((l) => l.endsWith(' c'))!;
    const [c1x, c1y, c2x, c2y] = curve.split(' ').map(Number);
    expect(c1x).toBeGreaterThan(c1y / 2); // line at height y has x = y/2
    expect(c2x).toBeGreaterThan(c2y / 2);
  });

  it('draws no text when the symbol is none', () => {
    expect(caretBody(g, [0, 0, 0], 'none')).not.toContain('Tj');
  });

  it('draws the paragraph sign naming the registered font key', () => {
    const body = caretBody(g, [0, 0, 0], 'paragraph');
    expect(body).toContain('Tj');
    // installShapeAP registers exactly one font, under the key F0. Naming /Helv
    // here would point at a resource that is not in the form (bug cu3b).
    expect(body).toContain('/F0 ');
    expect(body).not.toContain('/Helv');
  });

  it('narrows the caret to make room for the symbol', () => {
    const plain = caretBody(g, [0, 0, 0], 'none');
    const withSym = caretBody(g, [0, 0, 0], 'paragraph');
    const apexOf = (s: string) => Number(s.split('\n').find((l) => l.endsWith(' c'))!.split(' ')[4]);
    expect(apexOf(withSym)).toBeGreaterThan(apexOf(plain)); // apex pushed right
  });

  it('insets the drawing by /RD', () => {
    const plain = caretBody(g, [0, 0, 0], 'none');
    const inset = caretBody(g, [0, 0, 0], 'none', [4, 2, 4, 2]);
    expect(inset).not.toEqual(plain);
    expect(inset.startsWith('0 0 0 rg')).toBe(true);
    expect(inset).toContain('4 2 m'); // baseline starts at the inset corner
  });

  it('returns an empty body when /RD leaves no room', () => {
    expect(caretBody(g, [0, 0, 0], 'none', [30, 0, 30, 0])).toBe('');
  });
});

describe('regenerateAppearance — /Caret', () => {
  it('draws a caret from /Rect and /C', () => {
    const { doc, dict } = attach('Caret', [['Rect', [0, 0, 40, 20]], ['C', [1, 0, 0]]]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain('1 0 0 rg');
    expect(body).toContain('h f');
    expect(body).not.toContain('Tj'); // /Sy absent → no symbol
  });

  it('honours /Sy /P', () => {
    const { doc, dict } = attach('Caret', [
      ['Rect', [0, 0, 40, 20]], ['C', [0, 0, 0]], ['Sy', name('P')],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    expect(apBody(doc, dict)).toContain('Tj');
  });

  it('honours /RD by drawing inside a smaller box', () => {
    const plain = attach('Caret', [['Rect', [0, 0, 40, 20]], ['C', [0, 0, 0]]]);
    const inset = attach('Caret', [
      ['Rect', [0, 0, 40, 20]], ['C', [0, 0, 0]], ['RD', [4, 2, 4, 2]],
    ]);
    expect(regenerateAppearance(plain.doc, plain.dict)).toBe(true);
    expect(regenerateAppearance(inset.doc, inset.dict)).toBe(true);
    expect(apBody(inset.doc, inset.dict)).not.toEqual(apBody(plain.doc, plain.dict));
    expect(apBody(inset.doc, inset.dict)).toContain('4 2 m');
  });

  it('returns false when /RD leaves nothing to draw', () => {
    const { doc, dict } = attach('Caret', [
      ['Rect', [0, 0, 40, 20]], ['C', [0, 0, 0]], ['RD', [30, 0, 30, 0]],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(false);
    expect(dict.has('AP')).toBe(false);
  });
});
