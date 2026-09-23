import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { regenerateAppearance } from '../src/annotdraw.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';
import { PdfDict, PdfObject, isDict, isStream, name } from '../src/types.js';
import { decodePng } from './helpers/decode-png.js';

/** A bare annotation dict of `subtype`, alongside a fresh document to own its
 *  appearance objects — `test/annotdraw.test.ts`'s harness. */
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

/** A /BE dictionary of style `s` and intensity `i`. */
function be(s: string, i?: number): PdfDict {
  const d: PdfDict = new Map<string, PdfObject>([['S', name(s)]]);
  if (i !== undefined) d.set('I', i);
  return d;
}

describe('cloud borders (/BE /S /C)', () => {
  it('draws a cloudy square as Béziers, not a rectangle', () => {
    const { doc, dict } = attach('Square', [
      ['Rect', [0, 0, 120, 80]],
      ['C', [1, 0, 0]],
      ['BE', be('C', 2)],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain(' c\n');
    expect(body).not.toContain(' re');
  });

  it('draws a cloudy polygon as Béziers, not straight segments', () => {
    const { doc, dict } = attach('Polygon', [
      ['Rect', [0, 0, 140, 100]],
      ['Vertices', [20, 20, 120, 20, 70, 80]],
      ['C', [0, 0, 1]],
      ['BE', be('C', 1)],
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    const body = apBody(doc, dict);
    expect(body).toContain(' c\n');
    expect(body).not.toContain(' l ');
  });

  /** The /AP body of a square carrying `extra`, for comparison against the
   *  same square with no /BE at all. */
  function squareBody(extra: [string, PdfObject][]): string | undefined {
    const { doc, dict } = attach('Square', [
      ['Rect', [0, 0, 120, 80]], ['C', [1, 0, 0]],
      ['IC', [0, 0, 1]], ['BS', new Map<string, PdfObject>([['W', 2]])],
      ...extra,
    ]);
    expect(regenerateAppearance(doc, dict)).toBe(true);
    return apBody(doc, dict);
  }

  // The other half of v0tz.4's acceptance criterion, as a fence: each of these
  // draws the straight border UNCHANGED, byte for byte.
  it('leaves /I 0 byte-identical to no /BE', () => {
    expect(squareBody([['BE', be('C', 0)]])).toBe(squareBody([]));
  });

  it('leaves a solid /BE /S /S byte-identical to no /BE', () => {
    expect(squareBody([['BE', be('S')]])).toBe(squareBody([]));
  });

  it('defaults an absent /I beside /S /C to a cloud, not to nothing', () => {
    // /S /C is the request for a cloud; reading a missing /I as 0 would make
    // the dictionary mean nothing.
    expect(squareBody([['BE', be('C')]])).not.toBe(squareBody([]));
  });

  it('clamps /I above the spec range rather than scaling past it', () => {
    expect(squareBody([['BE', be('C', 9)]])).toBe(squareBody([['BE', be('C', 2)]]));
  });
});

describe('a cloudy square renders as a cloud', () => {
  /** A 120x80 square at [100 100 220 180] on the 300x200 target page, with a
   *  cloudy border or without. Device y is 200 - page y, so the square's
   *  bottom border falls on device row 99. */
  function render(cloud: boolean) {
    const d = Document.Open(buildAnnotTarget());
    const a = d.Pages[0].AddSquare({ rect: [100, 100, 220, 180], color: [0, 0, 0] });
    if (cloud) {
      a.Dict.set('BE', be('C', 2));
      a.Dict.delete('AP');
      expect(regenerateAppearance(d, a.Dict)).toBe(true);
    }
    return decodePng(d.Pages[0].ToImage());
  }

  /** Is any pixel of column `x` inked across the rows the straight bottom
   *  border occupies? */
  function inkedAtBottomBorder(img: ReturnType<typeof decodePng>, x: number): boolean {
    for (let y = 97; y <= 102; y++) if (img.at(x, y)[0] < 200) return true;
    return false;
  }

  // At /I 2 the bulge is 9pt, so the drawn box is inset 9.5 and its 101pt
  // bottom edge takes 6 scallops of 16.83. Measured on the render: the cusp
  // at form x=60 (page x=160) pulls the outline up to device rows 90-92,
  // while the peak near page x=135 reaches row 99 — where the straight
  // border's own stroke lies.
  it('leaves the straight border line empty at a scallop cusp', () => {
    expect(inkedAtBottomBorder(render(false), 160)).toBe(true);
    expect(inkedAtBottomBorder(render(true), 160)).toBe(false);
  });

  it('still reaches that line at a scallop peak', () => {
    // Without this the case above passes for a cloud that is merely missing,
    // or drawn too small to touch the border at all.
    expect(inkedAtBottomBorder(render(true), 135)).toBe(true);
  });
});
