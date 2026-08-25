import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isDict, isStream, type PdfDict } from '../src/types.js';
import { PageGraphics } from '../src/graphics.js';
import { decodePng } from './helpers/decode-png.js';

const doc2 = () => {
  const doc = Document.New();
  doc.AddPage(PageFormat.A4);
  return doc;
};

describe('Document.NewTilingPattern', () => {
  it('allocates one PatternType 1 stream carrying the tile ops', () => {
    const doc = doc2();
    const pat = doc.NewTilingPattern(20, 30, (t) => {
      t.setFillColor([1, 0, 0]).drawRect(0, 0, 10, 10).fill();
    });
    expect(pat.paintType).toBe(1);
    const obj = doc.resolve(pat.ref);
    expect(isStream(obj)).toBe(true);
    const s = obj as { dict: PdfDict; raw: Uint8Array };
    expect(s.dict.get('PatternType')).toBe(1);
    expect(s.dict.get('BBox')).toEqual([0, 0, 20, 30]);
    expect(new TextDecoder().decode(s.raw)).toContain('1 0 0 rg');
  });

  it('lands a tile registration in the TILE resources, not the page', () => {
    // The seam the whole VectorGraphics split exists for.
    const doc = doc2();
    const pat = doc.NewTilingPattern(20, 20, (t) => {
      t.setOpacity(0.5).drawRect(0, 0, 10, 10).fill();
    });
    const s = doc.resolve(pat.ref) as { dict: PdfDict };
    const res = doc.resolve(s.dict.get('Resources')) as PdfDict;
    expect(isDict(doc.resolve(res.get('ExtGState')))).toBe(true);

    const pageRes = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    const pageGs = isDict(pageRes)
      ? doc.resolve((pageRes as PdfDict).get('ExtGState')) : undefined;
    expect(isDict(pageGs)).toBe(false);
  });

  it('carries an empty /Resources for a tile that registered nothing', () => {
    const doc = doc2();
    const pat = doc.NewTilingPattern(10, 10, (t) => {
      t.setFillColor([0, 0, 0]).drawRect(0, 0, 5, 5).fill();
    });
    const s = doc.resolve(pat.ref) as { dict: PdfDict };
    expect(s.dict.has('Resources')).toBe(true);
  });

  it('refuses a tile whose callback draws nothing', () => {
    // An empty tile has no defensible ink, so it is refused at authoring time
    // rather than painting an invisible fill. This differs on purpose from
    // gradientPaint, whose degenerate cases collapse to a solid — one stop
    // still has a colour to paint.
    const doc = doc2();
    expect(() => doc.NewTilingPattern(10, 10, () => { /* nothing */ })).toThrow(TypeError);
  });

  it('allocates nothing when it refuses', () => {
    const doc = doc2();
    const before = doc.Save().length;
    expect(() => doc.NewTilingPattern(0, 10, () => { /* unreached */ })).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });

  it('marks an uncolored pattern PaintType 2', () => {
    const doc = doc2();
    const pat = doc.NewTilingPattern(10, 10, (t) => {
      t.drawRect(0, 0, 5, 5).fill();
    }, { uncolored: true });
    expect(pat.paintType).toBe(2);
    const s = doc.resolve(pat.ref) as { dict: PdfDict };
    expect(s.dict.get('PaintType')).toBe(2);
  });

  it('refuses colour operators inside an uncolored tile', () => {
    // A viewer ignores every colour operator in a PaintType 2 tile, so
    // emitting them produces bytes nothing honours — which reads as a
    // rendering bug rather than a mistake.
    const doc = doc2();
    expect(() => doc.NewTilingPattern(10, 10, (t) => {
      t.setFillColor([1, 0, 0]).drawRect(0, 0, 5, 5).fill();
    }, { uncolored: true })).toThrow(TypeError);

    expect(() => doc.NewTilingPattern(10, 10, (t) => {
      t.setStrokeColor([1, 0, 0]).drawLine(0, 0, 5, 5).stroke();
    }, { uncolored: true })).toThrow(TypeError);

    expect(() => doc.NewTilingPattern(10, 10, (t) => {
      t.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 10, y2: 0,
        stops: [{ offset: 0, color: [1, 0, 0] }, { offset: 1, color: [0, 0, 1] }],
      }).drawRect(0, 0, 5, 5).fill();
    }, { uncolored: true })).toThrow(TypeError);
  });

  it('accepts those same calls in a COLORED tile', () => {
    // The companion: without it, "throws on setFillColor" is satisfied by a
    // build that throws on setFillColor everywhere.
    const doc = doc2();
    expect(() => doc.NewTilingPattern(10, 10, (t) => {
      t.setFillColor([1, 0, 0]).drawRect(0, 0, 5, 5).fill();
    })).not.toThrow();
  });
});

/** Concatenate the decoded content of page `i`. */
const contentOf = (doc: Document, i = 0): string =>
  new TextDecoder().decode(doc.Pages[i].Contents);

describe('setFillPattern / setStrokePattern', () => {
  const hatch = (doc: Document) => doc.NewTilingPattern(10, 10, (t) => {
    t.setLineWidth(1).setStrokeColor([0, 0, 1]).drawLine(0, 0, 10, 10).stroke();
  });

  it('selects a colored pattern for fill', () => {
    const doc = doc2();
    const g = new PageGraphics(doc, doc.Pages[0]);
    g.setFillPattern(hatch(doc)).drawRect(0, 0, 50, 50).fill();
    g.apply();
    const c = contentOf(doc);
    expect(c).toContain('/Pattern cs');
    expect(c).toMatch(/\/P\d+ scn/);
  });

  it('uses the upper-case operators for stroke', () => {
    const doc = doc2();
    const g = new PageGraphics(doc, doc.Pages[0]);
    g.setStrokePattern(hatch(doc)).drawRect(0, 0, 50, 50).stroke();
    g.apply();
    const c = contentOf(doc);
    expect(c).toContain('/Pattern CS');
    expect(c).toMatch(/\/P\d+ SCN/);
  });

  it('emits the colour before the key for an uncolored pattern', () => {
    const doc = doc2();
    const pat = doc.NewTilingPattern(10, 10, (t) => {
      t.setLineWidth(1).drawLine(0, 0, 10, 10).stroke();
    }, { uncolored: true });
    const g = new PageGraphics(doc, doc.Pages[0]);
    g.setFillPattern(pat, [1, 0, 0]).drawRect(0, 0, 50, 50).fill();
    g.apply();
    const c = contentOf(doc);
    // An uncolored pattern selects an underlying colour space.
    expect(c).toContain('/Pattern /DeviceRGB cs');
    expect(c).toMatch(/1 0 0 \/P\d+ scn/);
  });

  it('registers one pattern used on two pages as ONE object', () => {
    // The whole argument for Document-level creation: a hatch on forty pages
    // must be one stream, not forty.
    const doc = doc2();
    doc.AddPage(PageFormat.A4);
    const pat = hatch(doc);
    for (const page of doc.Pages) {
      const g = new PageGraphics(doc, page);
      g.setFillPattern(pat).drawRect(0, 0, 50, 50).fill();
      g.apply();
    }
    const reopened = Document.Open(doc.Save());
    let streams = 0;
    for (const [, obj] of reopened.objectEntries()) {
      const d = isStream(obj) ? obj.dict : undefined;
      if (d && reopened.resolve(d.get('PatternType')) === 1) streams++;
    }
    expect(streams).toBe(1);
  });

  it('reuses one resource key for the same pattern used twice on a page', () => {
    const doc = doc2();
    const pat = hatch(doc);
    const g = new PageGraphics(doc, doc.Pages[0]);
    g.setFillPattern(pat).drawRect(0, 0, 20, 20).fill();
    g.setFillPattern(pat).drawRect(30, 30, 20, 20).fill();
    g.apply();
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
    const pt = doc.resolve(res.get('Pattern')) as PdfDict;
    expect([...pt.keys()]).toHaveLength(1);
  });
});

describe('tiling acceptance', () => {
  it('repeats the tile on the lattice', () => {
    // A test asserting only that a /Pattern resource exists passes with the
    // steps, the matrix and the paint type all simultaneously wrong. Probe
    // pixels instead: one inside a painted module, one in the gap.
    //
    // Note ToImage is SYNCHRONOUS and returns a Uint8Array — no await.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.custom(100, 100));
    // A 20x20 tile whose ink is a 10x10 red square in its lower-left quarter,
    // so the lower-left of every cell is painted and the rest is not.
    const pat = doc.NewTilingPattern(20, 20, (t) => {
      t.setFillColor([1, 0, 0]).drawRect(0, 0, 10, 10).fill();
    });
    const g = new PageGraphics(doc, page);
    g.setFillPattern(pat).drawRect(0, 0, 100, 100).fill();
    g.apply();

    const png = decodePng(page.ToImage({ scale: 1 }));
    // Device y runs DOWN from the top, user y runs up: user (x, y) on a 100pt
    // page is device (x, 100 - y).
    //
    // Correct lattice (step 20): ink occupies x,y in [0,10) mod 20.
    // Cell (2,2)'s ink, user (45,45) -> painted.
    expect(png.at(45, 55)).toEqual([255, 0, 0, 255]);
    // The gap in that same cell, user (55,55) -> unpainted white.
    expect(png.at(55, 45)).toEqual([255, 255, 255, 255]);

    // The two probes above are NOT enough, measured: doubling XStep leaves
    // both green, because ink then sits at x in [0,10)/[40,50)/[80,90) and 45
    // and 55 fall the same way. These two ODD-cell probes are what pin the
    // steps — each is painted at step 20 and lands in a gap at step 40.
    expect(png.at(25, 75)).toEqual([255, 0, 0, 255]);   // user (25,25): pins xStep
    expect(png.at(5, 75)).toEqual([255, 0, 0, 255]);    // user (5,25):  pins yStep
  });
});
