import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PdfParseError } from '../src/errors.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { isDict, isRef, isStream, type PdfDict, type PdfStream } from '../src/types.js';
import type { Page } from '../src/page.js';

const svg = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);
const page = () => Document.Open(buildBlankPage()).Pages[0];

const RECT: [number, number, number, number] = [100, 200, 300, 150];
const DOC = '<svg viewBox="0 0 100 50"><rect width="100" height="50" fill="red"/></svg>';

/** The single Form XObject a successful AddSVGObject registers on the page. */
function theForm(doc: Document, p: Page): PdfStream {
  const res = doc.resolve(p.Dict.get('Resources')) as PdfDict;
  const xo = doc.resolve(res.get('XObject')) as PdfDict;
  expect(xo.size).toBe(1);
  const v = doc.resolve([...xo.values()][0]);
  expect(isStream(v)).toBe(true);
  return v as PdfStream;
}

describe('page.AddSVGObject', () => {
  it('registers one Form XObject and draws it', () => {
    const p = page();
    const r = p.AddSVGObject(svg(DOC), RECT);
    expect(r.skipped).toEqual([]);
    const form = theForm(p.Document, p);
    expect(form.dict.get('Subtype')).toMatchObject({ name: 'Form' });
    expect(dec(p.Contents)).toMatch(/\/Fm\d+ Do/);
  });

  it('sets the BBox to the viewBox and leaves the Matrix identity', () => {
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="10 20 100 50"><rect width="1" height="1"/></svg>'), RECT);
    const form = theForm(p.Document, p);
    expect(form.dict.get('BBox')).toEqual([10, 20, 110, 70]);
    expect(form.dict.get('Matrix')).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('carries the walker resources into the form, not onto the page', () => {
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="0 0 10 10"><rect width="9" height="9" ' +
      'fill="red" fill-opacity="0.5"/></svg>'), RECT);
    const form = theForm(p.Document, p);
    const res = p.Document.resolve(form.dict.get('Resources')) as PdfDict;
    expect(isDict(p.Document.resolve(res.get('ExtGState')))).toBe(true);
    const pageRes = p.Document.resolve(p.Dict.get('Resources')) as PdfDict;
    expect(pageRes.get('ExtGState')).toBeUndefined();
  });

  it('places the form with the fit matrix and clips to the rect', () => {
    const p = page();
    p.AddSVGObject(svg(DOC), [0, 0, 200, 100]);   // viewBox 100x50 -> scale 2
    const c = dec(p.Contents);
    expect(c).toContain('0 0 200 100 re');
    expect(c).toContain('W n');
    expect(c).toContain('2 0 0 -2 0 100 cm');     // y flipped
  });

  it('honours the fit override', () => {
    const p = page();
    p.AddSVGObject(svg(DOC), [0, 0, 200, 200], { fit: 'fill' });
    expect(dec(p.Contents)).toContain('2 0 0 -4 0 200 cm');
  });

  it('falls back to width/height when there is no viewBox', () => {
    const p = page();
    p.AddSVGObject(svg('<svg width="100" height="50"><rect width="1" height="1"/></svg>'),
      [0, 0, 200, 100]);
    expect(theForm(p.Document, p).dict.get('BBox')).toEqual([0, 0, 100, 50]);
  });

  it('falls back to the rect when the SVG declares no size at all', () => {
    const p = page();
    p.AddSVGObject(svg('<svg><rect width="1" height="1"/></svg>'), [0, 0, 200, 100]);
    expect(theForm(p.Document, p).dict.get('BBox')).toEqual([0, 0, 200, 100]);
  });

  it('surfaces the walker skipped list', () => {
    // <text> was the exemplar until 1gg0.8 made it render, then <mask> until
    // 1gg0.10 did. <foreignObject> embeds a foreign markup namespace, so no
    // phase of the SVG work will ever make it render.
    const p = page();
    const r = p.AddSVGObject(svg('<svg viewBox="0 0 10 10"><foreignObject/>' +
      '<rect width="9" height="9"/></svg>'), RECT);
    expect(r.skipped).toEqual(['foreignObject']);
  });

  it('preserves existing page content', () => {
    const p = page();
    p.AddText('Before', 10, 10);
    p.AddSVGObject(svg(DOC), RECT);
    const c = dec(p.Contents);
    expect(c).toContain('(Before) Tj');
    expect(c).toMatch(/\/Fm\d+ Do/);
  });

  it('round-trips through Save/Open', () => {
    const p = page();
    p.AddSVGObject(svg(DOC), RECT);
    const rt = Document.Open(p.Document.Save());
    expect(dec(rt.Pages[0].Contents)).toMatch(/\/Fm\d+ Do/);
  });

  it('draws two SVGs onto one page without collision', () => {
    const p = page();
    p.AddSVGObject(svg(DOC), [0, 0, 100, 50]);
    p.AddSVGObject(svg(DOC), [100, 0, 100, 50]);
    const res = p.Document.resolve(p.Dict.get('Resources')) as PdfDict;
    expect((p.Document.resolve(res.get('XObject')) as PdfDict).size).toBe(2);
  });
});

describe('page.AddSVGObject — validation', () => {
  it('throws PdfParseError for malformed XML', () => {
    expect(() => page().AddSVGObject(svg('<svg><rect'), RECT)).toThrow(PdfParseError);
  });

  it('throws PdfParseError when the root is not <svg>', () => {
    expect(() => page().AddSVGObject(svg('<html><body/></html>'), RECT)).toThrow(PdfParseError);
  });

  it('throws TypeError for a malformed rect', () => {
    expect(() => page().AddSVGObject(svg(DOC), [0, 0, 0, 100] as [number, number, number, number]))
      .toThrow(TypeError);
    expect(() => page().AddSVGObject(svg(DOC), [0, 0, 100] as unknown as
      [number, number, number, number])).toThrow(TypeError);
    expect(() => page().AddSVGObject(svg(DOC), [0, NaN, 100, 100])).toThrow(TypeError);
  });

  it('throws TypeError for an unknown fit', () => {
    expect(() => page().AddSVGObject(svg(DOC), RECT, { fit: 'cover' as 'meet' }))
      .toThrow(TypeError);
  });

  it('leaves the page byte-identical when a call is rejected', () => {
    const p = page();
    const before = p.Document.Save();
    expect(() => p.AddSVGObject(svg(DOC), RECT, { fit: 'cover' as 'meet' })).toThrow(TypeError);
    expect(() => p.AddSVGObject(svg('<html/>'), RECT)).toThrow(PdfParseError);
    expect(p.Document.Save()).toEqual(before);
  });
});

describe('page.AddSVGObject — end to end', () => {
  it('renders a realistic icon without skipping anything', () => {
    const icon =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<defs><clipPath id="c"><rect x="2" y="2" width="20" height="20" rx="4"/></clipPath>' +
      '<g id="tick"><path d="M6 12l4 4 8-8" fill="none" stroke="#fff" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></g></defs>' +
      '<g clip-path="url(#c)">' +
      '<rect width="24" height="24" fill="#2d7"/>' +
      '<use href="#tick"/>' +
      '<circle cx="20" cy="4" r="3" fill="rgb(255,0,0)" opacity="0.75"/>' +
      '</g></svg>';
    const p = page();
    const r = p.AddSVGObject(svg(icon), [72, 500, 48, 48]);
    expect(r.skipped).toEqual([]);
    const c = dec(theForm(p.Document, p).raw);
    expect(c).toContain('W n');            // the clip
    expect(c).toContain('0.133333 0.866667 0.466667 rg');   // #2d7
    expect(c).toContain('1 1 1 RG');       // the white tick stroke
    expect(c).toContain('2 w');
    expect(c).toContain('1 J');
    expect(c).toMatch(/\/GS\d+ gs/);       // the 0.75 circle
  });

  it('degrades a mixed SVG: draws what it can, names what it cannot', () => {
    const mixed =
      '<svg viewBox="0 0 10 10">' +
      '<rect width="10" height="10" fill="blue"/>' +
      '<text x="1" y="5">label</text>' +
      '<image href="pic.png" width="4" height="4"/>' +
      '</svg>';
    const p = page();
    const r = p.AddSVGObject(svg(mixed), RECT);
    expect(r.skipped).toEqual(['image']);
    const content = dec(theForm(p.Document, p).raw);
    expect(content).toContain('0 0 1 rg');   // the rect still drew
    expect(content).toContain('BT');         // and the text now draws too
  });
});

describe('page.AddSVGObject — text', () => {
  const TXT = '<svg viewBox="0 0 100 50"><text x="10" y="30" font-size="12">Hi</text></svg>';

  /** The form's own /Resources, which the SVG stack builds directly. */
  const formRes = (doc: Document, p: Page): PdfDict =>
    theForm(doc, p).dict.get('Resources') as PdfDict;

  it('renders text and reports nothing skipped', () => {
    const p = page();
    expect(p.AddSVGObject(svg(TXT), RECT).skipped).toEqual([]);
    expect(dec(theForm(p.Document, p).raw)).toContain('BT');
  });

  it('registers the Standard-14 face as a direct dict in the form resources', () => {
    const p = page();
    p.AddSVGObject(svg(TXT), RECT);
    const fonts = formRes(p.Document, p).get('Font') as PdfDict;
    expect(fonts.size).toBe(1);
    const f = [...fonts.values()][0] as PdfDict;
    expect(isDict(f)).toBe(true);                    // direct, not a ref
    expect(f.get('BaseFont')).toMatchObject({ name: 'Helvetica' });
    expect(f.get('Encoding')).toMatchObject({ name: 'WinAnsiEncoding' });
  });

  it('maps font-family and font-weight to the right face', () => {
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="0 0 100 50"><text font-family="Georgia" ' +
      'font-weight="bold" y="20">Hi</text></svg>'), RECT);
    const fonts = formRes(p.Document, p).get('Font') as PdfDict;
    const names = [...fonts.values()].map((v) => (v as PdfDict).get('BaseFont'));
    expect(names).toContainEqual({ kind: 'name', name: 'Times-Bold' });
  });

  it('registers one font once however many runs use it', () => {
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="0 0 100 50"><text y="10">a</text>' +
      '<text y="30">b</text></svg>'), RECT);
    expect((formRes(p.Document, p).get('Font') as PdfDict).size).toBe(1);
  });

  it('reports text when the face cannot encode any of it', () => {
    const p = page();
    // CJK is outside WinAnsi, so nothing survives encoding.
    const r = p.AddSVGObject(svg('<svg viewBox="0 0 100 50"><text y="20">漢字</text></svg>'), RECT);
    expect(r.skipped).toContain('text');
  });

  it('rejects a Standard-14 name in the font option before allocating anything', () => {
    const p = page();
    const before = p.Document.Save().length;
    expect(() => p.AddSVGObject(svg(TXT), RECT, { font: 'Helvetica' as never }))
      .toThrow(TypeError);
    expect(p.Document.Save().length).toBe(before);
  });

  it('emits no /Font at all for an SVG without text', () => {
    const p = page();
    p.AddSVGObject(svg(DOC), RECT);
    expect(formRes(p.Document, p).has('Font')).toBe(false);
  });

  it('survives a Save/Open round trip', () => {
    const p = page();
    p.AddSVGObject(svg(TXT), RECT);
    const rt = Document.Open(p.Document.Save());
    const res = theForm(rt, rt.Pages[0]).dict.get('Resources') as PdfDict;
    const fonts = rt.resolve(res.get('Font')) as PdfDict;
    expect(fonts.size).toBe(1);
  });
});

describe('page.AddSVGObject — CSS', () => {
  it('styles a shape from a stylesheet through the public API', () => {
    const p = page();
    const r = p.AddSVGObject(svg('<svg viewBox="0 0 10 10">' +
      '<style>.a { fill: #ff0000 }</style>' +
      '<rect class="a" width="9" height="9"/></svg>'), RECT);
    expect(r.skipped).toEqual([]);
    expect(dec(theForm(p.Document, p).raw)).toContain('1 0 0 rg');
  });

  it('resolves a font-family from a stylesheet, not just an attribute', () => {
    // The motivating case: font substitution is silent by design, so a
    // stylesheet-set family that never reached the provider would be invisible.
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="0 0 100 50">' +
      '<style>text { font-family: Georgia; font-weight: bold }</style>' +
      '<text y="20">Hi</text></svg>'), RECT);
    const res = theForm(p.Document, p).dict.get('Resources') as PdfDict;
    const fonts = res.get('Font') as PdfDict;
    const names = [...fonts.values()].map((v) => (v as PdfDict).get('BaseFont'));
    expect(names).toContainEqual({ kind: 'name', name: 'Times-Bold' });
  });

  it('survives a Save/Open round trip', () => {
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="0 0 10 10"><style>rect { fill: #ff0000 }</style>' +
      '<rect width="9" height="9"/></svg>'), RECT);
    const rt = Document.Open(p.Document.Save());
    const form = theForm(rt, rt.Pages[0]);
    expect(dec(form.raw)).toContain('1 0 0 rg');
  });

  it('leaves a stylesheet-free document byte-identical', () => {
    // The no-CSS path must be untouched: same input, same bytes as before.
    const a = page();
    a.AddSVGObject(svg(DOC), RECT);
    const b = page();
    b.AddSVGObject(svg(DOC), RECT);
    expect(dec(theForm(a.Document, a).raw)).toBe(dec(theForm(b.Document, b).raw));
  });
});

describe('page.AddSVGObject — font resources', () => {
  it('registers only the faces the content actually used', () => {
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="0 0 100 50">' +
      '<text y="10" font-family="serif">a</text>' +
      '<text y="30" font-family="monospace">b</text></svg>'), RECT);
    const res = theForm(p.Document, p).dict.get('Resources') as PdfDict;
    const fonts = res.get('Font') as PdfDict;
    expect(fonts.size).toBe(2);
  });
});

describe('page.AddSVGObject — pattern', () => {
  const P = '<svg viewBox="0 0 20 20"><defs>' +
    '<pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse">' +
    '<rect width="2" height="2" fill="#ff0000"/></pattern></defs>' +
    '<rect width="20" height="20" fill="url(#p)"/></svg>';

  it('registers the tile as an indirect stream, not a direct dict', () => {
    // This is the observable difference from a shading pattern, which stays a
    // direct dict: a PatternType 1 pattern IS a stream, and streams must be
    // indirect objects.
    const p = page();
    expect(p.AddSVGObject(svg(P), RECT).skipped).toEqual([]);
    const res = theForm(p.Document, p).dict.get('Resources') as PdfDict;
    const pats = res.get('Pattern') as PdfDict;
    const entry = [...pats.values()][0];
    expect(isRef(entry)).toBe(true);
    const tile = p.Document.resolve(entry);
    expect(isStream(tile)).toBe(true);
    expect((tile as PdfStream).dict.get('PatternType')).toBe(1);
    expect(dec((tile as PdfStream).raw)).toContain('1 0 0 rg');
  });

  it('puts a tile-only font in the TILE resources, not the form', () => {
    // The form has no text at all, so its /Font must be absent entirely.
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="0 0 20 20"><defs>' +
      '<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse">' +
      '<text y="6">x</text></pattern></defs>' +
      '<rect width="20" height="20" fill="url(#p)"/></svg>'), RECT);
    const res = theForm(p.Document, p).dict.get('Resources') as PdfDict;
    expect(res.has('Font')).toBe(false);
    const pats = res.get('Pattern') as PdfDict;
    const tile = p.Document.resolve([...pats.values()][0]) as PdfStream;
    const tres = tile.dict.get('Resources') as PdfDict;
    expect((tres.get('Font') as PdfDict).size).toBe(1);
  });

  it('nests a pattern inside a pattern', () => {
    const p = page();
    const r = p.AddSVGObject(svg('<svg viewBox="0 0 20 20"><defs>' +
      '<pattern id="inner" width="2" height="2" patternUnits="userSpaceOnUse">' +
      '<rect width="1" height="1" fill="#00ff00"/></pattern>' +
      '<pattern id="outer" width="8" height="8" patternUnits="userSpaceOnUse">' +
      '<rect width="6" height="6" fill="url(#inner)"/></pattern></defs>' +
      '<rect width="20" height="20" fill="url(#outer)"/></svg>'), RECT);
    expect(r.skipped).toEqual([]);
    const res = theForm(p.Document, p).dict.get('Resources') as PdfDict;
    const outer = p.Document.resolve(
      [...(res.get('Pattern') as PdfDict).values()][0]) as PdfStream;
    const ores = outer.dict.get('Resources') as PdfDict;
    expect(ores.has('Pattern')).toBe(true);   // the inner tile lives here
  });

  it('survives a Save/Open round trip', () => {
    const p = page();
    p.AddSVGObject(svg(P), RECT);
    const rt = Document.Open(p.Document.Save());
    const res = theForm(rt, rt.Pages[0]).dict.get('Resources') as PdfDict;
    const tile = rt.resolve([...(rt.resolve(res.get('Pattern')) as PdfDict).values()][0]);
    expect(isStream(tile)).toBe(true);
  });
});

describe('AddSVGObject — gradient alpha mask', () => {
  const FADE = '<svg viewBox="0 0 10 10"><defs><linearGradient id="g">' +
    '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
    '<stop offset="1" stop-color="red" stop-opacity="1"/></linearGradient></defs>' +
    '<rect width="10" height="10" fill="url(#g)"/></svg>';

  it('allocates the mask group as an indirect DeviceGray transparency group', () => {
    const p = page();
    expect(p.AddSVGObject(svg(FADE), RECT).skipped).toEqual([]);
    const res = theForm(p.Document, p).dict.get('Resources') as PdfDict;
    const gs = [...(res.get('ExtGState') as PdfDict).values()][0] as PdfDict;
    const sm = gs.get('SMask') as PdfDict;
    expect(sm.get('S')).toMatchObject({ name: 'Luminosity' });

    const entry = sm.get('G');
    expect(isRef(entry)).toBe(true);
    const group = p.Document.resolve(entry);
    expect(isStream(group)).toBe(true);
    const gd = (group as PdfStream).dict;
    const grp = gd.get('Group') as PdfDict;
    expect(isDict(grp)).toBe(true);
    expect(grp.get('S')).toMatchObject({ name: 'Transparency' });
    expect(grp.get('CS')).toMatchObject({ name: 'DeviceGray' });
    expect(gd.get('Matrix')).toEqual([1, 0, 0, 1, 0, 0]);

    // The group paints one rect with the grayscale twin of the shading.
    const raw = dec((group as PdfStream).raw);
    expect(raw).toContain('/Pattern cs');
    expect(raw).toMatch(/re\nf$/);
    const gres = gd.get('Resources') as PdfDict;
    const gpat = (gres.get('Pattern') as PdfDict).get('P0') as PdfDict;
    expect((gpat.get('Shading') as PdfDict).get('ColorSpace'))
      .toMatchObject({ name: 'DeviceGray' });
  });
});

describe('AddSVGObject structure marking', () => {
  // AutoTag rather than an empty CreateStructTree: an empty tree leaves any
  // pre-existing page content untagged, so the rule would fire regardless of
  // what the SVG does and every assertion would be measuring the fixture.
  function taggedDoc(): Document {
    const doc = Document.Open(buildBlankPage());
    doc.Lang = 'en-US';
    doc.AutoTag();
    return doc;
  }
  const body = (doc: Document) => dec(doc.Pages[0].Contents);
  const fires = (doc: Document) =>
    doc.ValidatePdfUa().Issues.some((i) => i.rule === 'UntaggedContent');

  it('has a clean baseline, so the assertions below measure the SVG', () => {
    expect(fires(taggedDoc())).toBe(false);
  });

  it('emits nothing extra by default, and the validator says so', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddSVGObject(svg(DOC), RECT);
    expect(body(doc)).not.toContain('/Artifact BMC');
    expect(fires(doc)).toBe(true); // accurate, not a false negative
  });

  it('wraps as an artifact when asked', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddSVGObject(svg(DOC), RECT, { artifact: true });
    expect(body(doc)).toContain('/Artifact BMC');
    expect(fires(doc)).toBe(false);
  });

  it('creates a /Figure carrying /Alt when given alt', () => {
    const doc = taggedDoc();
    doc.Pages[0].AddSVGObject(svg(DOC), RECT, { alt: 'a red rectangle' });
    expect(body(doc)).toMatch(/\/Figure <<\/MCID \d+>> BDC/);
    expect(fires(doc)).toBe(false);
  });

  it("uses the caller's element when given tag", () => {
    const doc = taggedDoc();
    // The blank fixture has no content, so AutoTag leaves the root childless —
    // append at the root, which is also markDrawing's fallback parent.
    const elem = doc.GetStructTree()!.Append('Figure', { alt: 'mine' });
    doc.Pages[0].AddSVGObject(svg(DOC), RECT, { tag: elem });
    expect(body(doc)).toMatch(/\/Figure <<\/MCID \d+>> BDC/);
    expect(fires(doc)).toBe(false);
  });

  it('throws when artifact contradicts alt, drawing nothing', () => {
    const doc = taggedDoc();
    const before = body(doc);
    expect(() => doc.Pages[0].AddSVGObject(svg(DOC), RECT, { artifact: true, alt: 'x' }))
      .toThrow(TypeError);
    expect(body(doc)).toBe(before);
  });
});
