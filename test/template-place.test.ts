import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isStream, type PdfDict } from '../src/types.js';
import { decodePng } from './helpers/decode-png.js';

const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

/** A document with `n` A4 pages. */
const docWith = (n: number) => {
  const doc = Document.New();
  for (let i = 0; i < n; i++) doc.AddPage(PageFormat.A4);
  return doc;
};

/** A drawn-into 100x50 template. */
const drawn = (doc: Document) => {
  const t = doc.NewTemplate(100, 50);
  t.page.Graphics().setFillColor([1, 0, 0]).drawRect(0, 0, 100, 50).fill().apply();
  return t;
};

describe('Document.NewTemplate', () => {
  it('exposes a drawable page that is NOT in the page tree', () => {
    // The load-bearing assumption of the whole feature: a Page is a thin live
    // wrapper over a dict, so an off-tree one draws exactly like a real page.
    const doc = docWith(1);
    const before = doc.Pages.length;
    const t = doc.NewTemplate(100, 50);
    t.page.Graphics().drawRect(0, 0, 10, 10).fill().apply();
    expect(doc.Pages).toHaveLength(before);
    expect(t.page.Contents.length).toBeGreaterThan(0);
  });

  it('accepts the ordinary authoring APIs', () => {
    // AddText and Graphics both reach the page only through appendContent and
    // ensureOwnResources, neither of which cares about the page tree. Asserted
    // rather than assumed, because nothing else in the suite pins it.
    const doc = docWith(1);
    const t = doc.NewTemplate(200, 80);
    t.page.AddText('ACME', 10, 30, { fontSize: 18 });
    t.page.Graphics().drawLine(0, 4, 200, 4).stroke().apply();
    const body = dec(t.page.Contents);
    expect(body).toContain('(ACME) Tj');
    expect(body).toContain('200 4 l');   // drawLine emits m/l/S, not a rect
    // ensureOwnResources reached the off-tree page too: AddText registered its
    // font there, which is what the form's /Resources will carry.
    const res = t.page.Dict.get('Resources') as PdfDict;
    expect(res.get('Font')).toBeDefined();
  });

  it('rejects a non-positive size and allocates nothing', () => {
    const doc = docWith(1);
    const before = doc.Save().length;
    expect(() => doc.NewTemplate(0, 50)).toThrow(TypeError);
    expect(() => doc.NewTemplate(100, -1)).toThrow(TypeError);
    expect(() => doc.NewTemplate(Number.NaN, 50)).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });
});

describe('Template.PlaceOn', () => {
  it('allocates ONE form for placements on two pages', () => {
    // The whole argument for the feature: a logo on forty pages is one object.
    const doc = docWith(2);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [40, 700, 100, 50]);
    t.PlaceOn(doc.Pages[1], [40, 700, 100, 50]);

    const rt = Document.Open(doc.Save());
    let forms = 0;
    for (const [, obj] of rt.objectEntries()) {
      if (isStream(obj) && (obj.dict.get('Subtype') as { name?: string })?.name === 'Form') forms++;
    }
    expect(forms).toBe(1);
    for (const p of rt.Pages) expect(dec(p.Contents)).toMatch(/\/Fm\d+ Do/);
  });

  it('emits two Do against ONE key when placed twice on one page', () => {
    const doc = docWith(1);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [0, 700, 100, 50]);
    t.PlaceOn(doc.Pages[0], [200, 700, 100, 50]);
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
    const xo = doc.resolve(res.get('XObject')) as PdfDict;
    expect([...xo.keys()]).toHaveLength(1);
    expect(dec(doc.Pages[0].Contents).match(/\/Fm\d+ Do/g)).toHaveLength(2);
  });

  it('stretches the form onto the rect', () => {
    // BBox is 100x50, rect is 200x50, so sx = 2 and sy = 1.
    const doc = docWith(1);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [40, 700, 200, 50]);
    expect(dec(doc.Pages[0].Contents)).toContain('2 0 0 1 40 700 cm');
  });

  it('freezes the template: page throws after the first placement', () => {
    const doc = docWith(1);
    const t = drawn(doc);
    expect(() => t.page).not.toThrow();          // companion: fine before
    t.PlaceOn(doc.Pages[0], [0, 700, 100, 50]);
    expect(() => t.page).toThrow(TypeError);
  });

  it('catches an edit made through a stashed page reference', () => {
    // The getter cannot intercept a Page already handed out, so the build
    // records the content length and a later placement checks it.
    const doc = docWith(2);
    const t = drawn(doc);
    const stashed = t.page;
    t.PlaceOn(doc.Pages[0], [0, 700, 100, 50]);
    stashed.Graphics().drawRect(0, 0, 5, 5).fill().apply();
    expect(() => t.PlaceOn(doc.Pages[1], [0, 700, 100, 50])).toThrow(TypeError);
  });

  it('refuses an empty template and allocates nothing', () => {
    const doc = docWith(1);
    const t = doc.NewTemplate(100, 50);
    const before = doc.Save().length;
    expect(() => t.PlaceOn(doc.Pages[0], [0, 700, 100, 50])).toThrow(TypeError);
    expect(doc.Save().length).toBe(before);
  });

  it('rejects a non-positive rect', () => {
    const doc = docWith(1);
    const t = drawn(doc);
    expect(() => t.PlaceOn(doc.Pages[0], [0, 700, 0, 50])).toThrow(TypeError);
    expect(() => t.PlaceOn(doc.Pages[0], [0, 700, 100, Number.NaN])).toThrow(TypeError);
  });
});

describe('PlaceOn options', () => {
  it("contains rather than stretching with fit: 'contain'", () => {
    // A 100x50 template into a 100x100 rect: contain gives s = 1 both axes and
    // centres vertically by 25; stretch would give sy = 2.
    const doc = docWith(1);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [0, 0, 100, 100], { fit: 'contain' });
    expect(dec(doc.Pages[0].Contents)).toContain('1 0 0 1 0 25 cm');
  });

  it('emits an /ExtGState for opacity below 1, and none at 1', () => {
    const doc = docWith(2);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [0, 700, 100, 50], { opacity: 0.5 });
    expect(dec(doc.Pages[0].Contents)).toMatch(/\/GS\d+ gs/);

    t.PlaceOn(doc.Pages[1], [0, 700, 100, 50], { opacity: 1 });
    expect(dec(doc.Pages[1].Contents)).not.toMatch(/\/GS\d+ gs/);
  });

  it('rotates about the rect origin', () => {
    // A 100x50 template into a 100x50 rect at (40, 700) is an exact fit, so
    // the base placement is [1, 0, 0, 1, 40, 700]. Rotating 90 deg CCW about
    // (40, 700) composes to EXACTLY [0, 1, -1, 0, 40, 700] — computed, not
    // guessed: the translation is unchanged because the pivot IS the rect
    // origin, which is the whole claim being made.
    const doc = docWith(1);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [40, 700, 100, 50], { rotation: 90 });
    const m = dec(doc.Pages[0].Contents).match(/([-\d. ]+) cm/)![1].trim().split(/\s+/).map(Number);
    expect(m[0]).toBeCloseTo(0, 6);
    expect(m[1]).toBeCloseTo(1, 6);
    expect(m[2]).toBeCloseTo(-1, 6);
    expect(m[3]).toBeCloseTo(0, 6);
    expect(m[4]).toBeCloseTo(40, 6);
    expect(m[5]).toBeCloseTo(700, 6);
  });

  it('wraps the placement as an /Artifact when asked', () => {
    const doc = docWith(1);
    const t = drawn(doc);
    t.PlaceOn(doc.Pages[0], [0, 700, 100, 50], { artifact: true });
    const body = dec(doc.Pages[0].Contents);
    expect(body).toContain('/Artifact BMC');
    expect(body).toContain('EMC');
  });

  it('rejects bad options before allocating', () => {
    const doc = docWith(1);
    const t = drawn(doc);
    expect(() => t.PlaceOn(doc.Pages[0], [0, 0, 10, 10], { fit: 'cover' as never }))
      .toThrow(TypeError);
    expect(() => t.PlaceOn(doc.Pages[0], [0, 0, 10, 10], { opacity: 2 })).toThrow(TypeError);
    expect(() => t.PlaceOn(doc.Pages[0], [0, 0, 10, 10], { rotation: Number.NaN }))
      .toThrow(TypeError);
  });
});

describe('template acceptance', () => {
  it('paints the template inside its rect and nowhere else', () => {
    // Asserting only that an /XObject resource exists passes with the
    // placement matrix entirely wrong. Probe pixels instead.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.custom(200, 200));
    const t = doc.NewTemplate(100, 50);
    t.page.Graphics().setFillColor([1, 0, 0]).drawRect(0, 0, 100, 50).fill().apply();
    t.PlaceOn(page, [50, 100, 100, 50]);

    const png = decodePng(page.ToImage({ scale: 1 }));
    // Device y runs DOWN: user (100, 125) -> device (100, 75), inside the rect.
    expect(png.at(100, 75)).toEqual([255, 0, 0, 255]);
    // Just left of the rect, same height -> unpainted.
    expect(png.at(20, 75)).toEqual([255, 255, 255, 255]);
    // Just below the rect, same column -> unpainted.
    expect(png.at(100, 140)).toEqual([255, 255, 255, 255]);
  });
});
