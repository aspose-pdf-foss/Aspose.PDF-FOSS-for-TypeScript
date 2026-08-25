import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseContentStream } from '../src/content.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import {
  registerShadingPattern, registerExtGState, registerSoftMaskExtGState,
  registerExtGStateIn, registerPatternRefIn, ensureOwnResources,
} from '../src/pagecontent.js';
import { PageGraphics, VectorGraphics } from '../src/graphics.js';
import type { Matrix } from '../src/text.js';
import {
  axialShading, shadingPattern, normalizeStops,
  type GradientStop, type LinearGradient,
} from '../src/gradient.js';
import {
  isDict, isName, isRef, isStream, type PdfDict, type PdfObject, type PdfStream,
} from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { UnsupportedFeatureError } from '../src/errors.js';

/** Concatenate all decoded content of page 1 as a string for assertions. */
function pageContentText(doc: Document): string {
  return new TextDecoder().decode(doc.Pages[0].Contents);
}

describe('PageGraphics', () => {
  it('emits state, path and paint operators wrapped in q/Q', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeColor([0, 0, 1]).setLineWidth(2).rect(50, 50, 200, 100).stroke();
    g.apply();

    const text = pageContentText(doc);
    expect(text).toContain('0 0 1 RG');
    expect(text).toContain('2 w');
    expect(text).toContain('50 50 200 100 re');
    expect(text).toContain('S');
    // existing content ("Original") is preserved
    expect(text).toContain('Original');
    // the drawing body is self-wrapped: a q ... Q surrounds the new ops
    const ops = parseContentStream(doc.Pages[0].Contents).map((o) => o.operator);
    expect(ops).toContain('q');
    expect(ops).toContain('Q');
    expect(ops).toContain('re');
  });

  it('apply() on an empty builder is a no-op and is idempotent', () => {
    const doc = Document.Open(buildStampTarget());
    const before = pageContentText(doc);
    const g = doc.Pages[0].Graphics();
    g.apply();
    expect(pageContentText(doc)).toBe(before);

    g.setFillColor([1, 0, 0]).drawRect(0, 0, 10, 10).fill();
    g.apply();
    const after = pageContentText(doc);
    g.apply(); // second apply must not append again
    expect(pageContentText(doc)).toBe(after);
  });

  it('fill opacity registers a single reusable ExtGState', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setOpacity(0.5).rect(0, 0, 10, 10).fill();
    g.setOpacity(0.5).rect(20, 0, 10, 10).fill();
    g.apply();
    const res = doc.Pages[0].Resources!;
    const ext = res.get('ExtGState') as Map<string, unknown>;
    expect(ext.size).toBe(1); // 0.5 reused, not duplicated
  });

  it('circle is emitted as four bezier curves and a close', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.circle(100, 100, 50).stroke();
    g.apply();
    const ops = parseContentStream(doc.Pages[0].Contents).map((o) => o.operator);
    expect(ops.filter((o) => o === 'c').length).toBe(4);
    expect(ops).toContain('h');
  });

  it('rejects invalid arguments', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    expect(() => g.setLineWidth(Infinity)).toThrow(TypeError);
    expect(() => g.setFillColor([2, 0, 0] as [number, number, number])).toThrow(TypeError);
    expect(() => g.setOpacity(1.5)).toThrow(TypeError);
    expect(() => g.setLineCap(5 as 0)).toThrow(TypeError);
  });

  it('BeginLayer/EndLayer tag content into an optional-content group', () => {
    const doc = Document.Open(buildStampTarget());
    const layer = doc.OptionalContent.AddLayer('Watermark');
    const g = doc.Pages[0].Graphics();
    g.BeginLayer(layer).rect(10, 10, 20, 20).fill().EndLayer();
    g.apply();

    const text = pageContentText(doc);
    // /OC /OCn BDC ... EMC around the drawing
    expect(text).toMatch(/\/OC\s+\/OC\d+\s+BDC/);
    expect(text).toContain('EMC');

    // the resource name in the BDC resolves to the OCG in /Resources /Properties
    const m = text.match(/\/OC\s+\/(OC\d+)\s+BDC/)!;
    const key = m[1];
    const res = doc.Pages[0].Resources!;
    const props = doc.resolve(res.get('Properties')) as Map<string, any>;
    const ref = props.get(key);
    expect(ref.kind).toBe('ref');
    expect(ref.num).toBe(layer.Ref.num);
  });
});

describe('registerShadingPattern', () => {
  const STOPS: GradientStop[] = [
    { offset: 0, color: [1, 0, 0] }, { offset: 1, color: [0, 0, 1] },
  ];
  const LINEAR: LinearGradient = { kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: STOPS };
  const pattern = () => shadingPattern(axialShading(LINEAR, normalizeStops(STOPS)));

  /** Resolve `key` in `d` and assert it is a dict. */
  function subDict(doc: Document, d: PdfDict, key: string): PdfDict {
    const v = doc.resolve(d.get(key));
    if (!isDict(v)) throw new Error(`/${key} is not a dict`);
    return v;
  }

  /** The page's own /Resources. */
  function resources(doc: Document): PdfDict {
    const r = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    if (!isDict(r)) throw new Error('page has no /Resources dict');
    return r;
  }

  it('registers the pattern under the page /Resources /Pattern and returns its key', () => {
    const doc = Document.Open(buildStampTarget());
    const key = registerShadingPattern(doc, doc.Pages[0], pattern());
    expect(key).toBe('P0');

    const pat = subDict(doc, resources(doc), 'Pattern');
    expect(isRef(pat.get('P0'))).toBe(true);       // allocated as an indirect object
    expect(subDict(doc, pat, 'P0').get('PatternType')).toBe(2);
  });

  it('allocates a fresh key per call rather than deduplicating', () => {
    const doc = Document.Open(buildStampTarget());
    expect(registerShadingPattern(doc, doc.Pages[0], pattern())).toBe('P0');
    expect(registerShadingPattern(doc, doc.Pages[0], pattern())).toBe('P1');
  });

  it('does not disturb an existing resource sub-dict', () => {
    const doc = Document.Open(buildStampTarget());
    registerShadingPattern(doc, doc.Pages[0], pattern());
    // buildStampTarget's page has a /Font /F0 the existing content depends on.
    expect(subDict(doc, resources(doc), 'Font').has('F0')).toBe(true);
  });
});

describe('PageGraphics.setFillGradient', () => {
  const RED: [number, number, number] = [1, 0, 0];
  const BLUE: [number, number, number] = [0, 0, 1];
  const ramp = (): GradientStop[] => [{ offset: 0, color: RED }, { offset: 1, color: BLUE }];

  /** The page's own /Resources sub-dict `key`, or undefined when none was made. */
  function pageResource(doc: Document, key: string): PdfDict | undefined {
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    if (!isDict(res)) return undefined;
    const p = doc.resolve(res.get(key));
    return isDict(p) ? p : undefined;
  }

  const patterns = (doc: Document) => pageResource(doc, 'Pattern');

  const nameOf = (v: PdfObject | undefined): string | undefined =>
    (isName(v) ? v.name : undefined);

  /** A named /ExtGState off the page. */
  function extGState(doc: Document, key: string): PdfDict {
    const d = doc.resolve(pageResource(doc, 'ExtGState')?.get(key));
    if (!isDict(d)) throw new Error(`no /ExtGState /${key}`);
    return d;
  }

  /** The Form XObject painting the luminosity mask of the gradient set by the
   *  `gs` under `key`. */
  function maskForm(doc: Document, key: string): PdfStream {
    const smask = doc.resolve(extGState(doc, key).get('SMask'));
    if (!isDict(smask)) throw new Error(`/ExtGState /${key} carries no /SMask`);
    expect(nameOf(smask.get('S'))).toBe('Luminosity');
    const form = doc.resolve(smask.get('G'));
    if (!isStream(form)) throw new Error('/SMask /G is not a form XObject');
    return form;
  }

  /** The grayscale shading that form paints, i.e. the alpha ramp itself. */
  function maskShading(doc: Document, key: string): PdfDict {
    const res = doc.resolve(maskForm(doc, key).dict.get('Resources'));
    const pat = isDict(res) ? doc.resolve(res.get('Pattern')) : undefined;
    const p0 = isDict(pat) ? doc.resolve(pat.get('P0')) : undefined;
    if (!isDict(p0)) throw new Error('mask form has no /Pattern /P0');
    expect(p0.get('PatternType')).toBe(2);
    const sh = doc.resolve(p0.get('Shading'));
    if (!isDict(sh)) throw new Error('mask pattern has no /Shading');
    return sh;
  }

  it('selects a registered shading pattern as the fill colour', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'linear', x1: 10, y1: 20, x2: 110, y2: 20, stops: ramp() })
     .rect(10, 10, 100, 50).fill();
    g.apply();

    const text = pageContentText(doc);
    expect(text).toContain('/Pattern cs');
    expect(text).toContain('/P0 scn');

    const pat = patterns(doc);
    expect(pat).toBeDefined();
    const d = doc.resolve(pat!.get('P0'));
    expect(isDict(d)).toBe(true);
    if (!isDict(d)) return;
    expect(d.get('PatternType')).toBe(2);
    const sh = doc.resolve(d.get('Shading'));
    expect(isDict(sh)).toBe(true);
    if (!isDict(sh)) return;
    expect(sh.get('ShadingType')).toBe(2);
    expect(sh.get('Coords')).toEqual([10, 20, 110, 20]);
  });

  it('collapses a single-stop gradient to a solid fill and allocates no pattern', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
                        stops: [{ offset: 0, color: RED }] });
    g.rect(0, 0, 10, 10).fill();
    g.apply();

    expect(pageContentText(doc)).toContain('1 0 0 rg');
    expect(pageContentText(doc)).not.toContain('/Pattern cs');
    expect(patterns(doc)).toBeUndefined();
  });

  it('collapses a zero-length axis to the last stop colour', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'linear', x1: 50, y1: 50, x2: 50, y2: 50, stops: ramp() });
    g.rect(0, 0, 10, 10).fill();
    g.apply();

    expect(pageContentText(doc)).toContain('0 0 1 rg');     // BLUE, the last stop
    expect(patterns(doc)).toBeUndefined();
  });

  it('folds a uniform stop alpha into an /ExtGState', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
                        stops: [{ offset: 0, color: RED, opacity: 0.5 },
                                { offset: 1, color: BLUE, opacity: 0.5 }] });
    g.rect(0, 0, 10, 10).fill();
    g.apply();

    const text = pageContentText(doc);
    expect(text).toMatch(/\/GS\d+ gs/);
    expect(text).toContain('/Pattern cs');
    // A fill's own alpha must not fade the stroke of the same path.
    expect(extGState(doc, 'GS0').get('ca')).toBe(0.5);
    expect(extGState(doc, 'GS0').has('CA')).toBe(false);
  });

  it('masks varying stop alpha with a luminosity soft mask', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({
      kind: 'linear', x1: 10, y1: 20, x2: 110, y2: 20,
      stops: [{ offset: 0, color: RED, opacity: 0.2 },
              { offset: 1, color: BLUE, opacity: 0.9 }],
    }).rect(10, 10, 100, 50).fill();
    g.apply();

    const text = pageContentText(doc);
    // The mask `gs` must precede the pattern selection and the paint.
    expect(text).toMatch(/\/GS\d+ gs[\s\S]*\/Pattern cs[\s\S]*\/P0 scn/);

    const form = maskForm(doc, 'GS0');
    expect(nameOf(form.dict.get('Subtype'))).toBe('Form');
    const group = doc.resolve(form.dict.get('Group'));
    expect(isDict(group)).toBe(true);
    if (!isDict(group)) return;
    expect(nameOf(group.get('S'))).toBe('Transparency');
    // /DeviceGray: the group's luminosity IS the gray value the twin paints.
    expect(nameOf(group.get('CS'))).toBe('DeviceGray');
    // PageGraphics tracks no paths, so the mask covers the whole page.
    expect(form.dict.get('BBox')).toEqual([0, 0, 300, 200]);
    const body = new TextDecoder().decode(decodeStream(form));
    expect(body).toContain('/Pattern cs');
    expect(body).toContain('/P0 scn');
    expect(body).toContain('0 0 300 200 re');

    // Inside it, the grayscale twin of the colour ramp, on the SAME axis: a mask
    // that does not line up with what it masks is worse than no mask.
    const sh = maskShading(doc, 'GS0');
    expect(sh.get('ShadingType')).toBe(2);
    expect(nameOf(sh.get('ColorSpace'))).toBe('DeviceGray');
    expect(sh.get('Coords')).toEqual([10, 20, 110, 20]);
  });

  it('overrides an earlier setOpacity with the mask, as the uniform case does', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setOpacity(0.5);
    g.setFillGradient({
      kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
      stops: [{ offset: 0, color: RED, opacity: 0.2 },
              { offset: 1, color: BLUE, opacity: 0.9 }],
    });
    g.rect(0, 0, 10, 10).fill();
    g.apply();

    // GS0 is the setOpacity(0.5); the mask state is a second, fully opaque one,
    // so the ramp's own alpha is the only alpha in force.
    const mask = extGState(doc, 'GS1');
    expect(mask.get('ca')).toBe(1);
    expect(mask.get('CA')).toBe(1);
    expect(isDict(doc.resolve(mask.get('SMask')))).toBe(true);
  });

  it("undoes the CTM in the mask group's /Matrix, popping it with restore()", () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.transform(2, 0, 0, 2, 10, 20);
    g.save();
    g.transform(2, 0, 0, 2, 0, 0);      // 4x inside…
    g.restore();                        // …and back to 2x, which is what counts
    g.setFillGradient({
      kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
      stops: [{ offset: 0, color: RED, opacity: 0.2 },
              { offset: 1, color: BLUE, opacity: 0.9 }],
    });
    g.rect(0, 0, 10, 10).fill();
    g.apply();

    // A soft-mask group renders under the CTM in force at its `gs`, while the
    // colour pattern is pinned to the stream's default space. The inverse is
    // what keeps the two on the same ramp.
    expect(maskForm(doc, 'GS0').dict.get('Matrix')).toEqual([0.5, 0, 0, 0.5, -5, -10]);
  });

  it('allocates a fresh mask per call rather than deduplicating', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    const grad = () => ({
      kind: 'linear' as const, x1: 0, y1: 0, x2: 100, y2: 0,
      stops: [{ offset: 0, color: RED, opacity: 0.2 },
              { offset: 1, color: BLUE, opacity: 0.9 }],
    });
    g.setFillGradient(grad()).rect(0, 0, 10, 10).fill();
    g.setFillGradient(grad()).rect(20, 0, 10, 10).fill();
    g.apply();

    const text = pageContentText(doc);
    expect(text).toContain('/GS0 gs');
    expect(text).toContain('/GS1 gs');
  });

  it('selects a registered ShadingType 3 pattern for a radial gradient', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'radial', cx: 50, cy: 60, r: 25, stops: ramp() })
     .rect(10, 10, 100, 50).fill();
    g.apply();

    const text = pageContentText(doc);
    expect(text).toContain('/Pattern cs');
    expect(text).toContain('/P0 scn');

    const d = doc.resolve(patterns(doc)!.get('P0'));
    expect(isDict(d)).toBe(true);
    if (!isDict(d)) return;
    const sh = doc.resolve(d.get('Shading'));
    expect(isDict(sh)).toBe(true);
    if (!isDict(sh)) return;
    expect(sh.get('ShadingType')).toBe(3);
    expect(sh.get('Coords')).toEqual([50, 60, 0, 50, 60, 25]);
  });

  it('collapses a zero-radius radial gradient to the last stop colour', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'radial', cx: 50, cy: 50, r: 0, stops: ramp() });
    g.rect(0, 0, 10, 10).fill();
    g.apply();

    expect(pageContentText(doc)).toContain('0 0 1 rg');     // BLUE, the last stop
    expect(patterns(doc)).toBeUndefined();
  });

  it('masks a radial gradient with a radial twin', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({
      kind: 'radial', cx: 50, cy: 60, r: 25,
      stops: [{ offset: 0, color: RED, opacity: 0.2 },
              { offset: 1, color: BLUE, opacity: 0.9 }],
    }).rect(0, 0, 10, 10).fill();
    g.apply();

    const sh = maskShading(doc, 'GS0');
    expect(sh.get('ShadingType')).toBe(3);
    expect(nameOf(sh.get('ColorSpace'))).toBe('DeviceGray');
    expect(sh.get('Coords')).toEqual([50, 60, 0, 50, 60, 25]);
  });

  it('leaves the document byte-identical when validation rejects', () => {
    const doc = Document.Open(buildStampTarget());
    const before = doc.Save();
    const g = doc.Pages[0].Graphics();
    expect(() => g.setFillGradient({
      kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: [],
    })).toThrow(TypeError);
    expect(doc.Save()).toEqual(before);
  });
});

describe('PageGraphics.setStrokeGradient', () => {
  const RED: [number, number, number] = [1, 0, 0];
  const BLUE: [number, number, number] = [0, 0, 1];
  const ramp = (): GradientStop[] => [{ offset: 0, color: RED }, { offset: 1, color: BLUE }];

  function pageResource(doc: Document, key: string): PdfDict | undefined {
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    if (!isDict(res)) return undefined;
    const p = doc.resolve(res.get(key));
    return isDict(p) ? p : undefined;
  }

  const patterns = (doc: Document) => pageResource(doc, 'Pattern');

  const nameOf = (v: PdfObject | undefined): string | undefined =>
    (isName(v) ? v.name : undefined);

  function extGState(doc: Document, key: string): PdfDict {
    const d = doc.resolve(pageResource(doc, 'ExtGState')?.get(key));
    if (!isDict(d)) throw new Error(`no /ExtGState /${key}`);
    return d;
  }

  it('selects a registered shading pattern as the stroke colour', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'linear', x1: 10, y1: 20, x2: 110, y2: 20, stops: ramp() })
     .setLineWidth(8).drawLine(10, 20, 110, 20).stroke();
    g.apply();

    const text = pageContentText(doc);
    // Upper case: the stroke colour operators, not the fill ones.
    expect(text).toContain('/Pattern CS');
    expect(text).toContain('/P0 SCN');
    expect(text).not.toContain('/Pattern cs');

    const d = doc.resolve(patterns(doc)!.get('P0'));
    expect(isDict(d)).toBe(true);
    if (!isDict(d)) return;
    expect(d.get('PatternType')).toBe(2);
    const sh = doc.resolve(d.get('Shading'));
    expect(isDict(sh)).toBe(true);
    if (!isDict(sh)) return;
    expect(sh.get('ShadingType')).toBe(2);
    expect(sh.get('Coords')).toEqual([10, 20, 110, 20]);
  });

  it('selects a registered ShadingType 3 pattern for a radial gradient', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'radial', cx: 50, cy: 60, r: 25, stops: ramp() })
     .circle(50, 60, 25).stroke();
    g.apply();

    const d = doc.resolve(patterns(doc)!.get('P0'));
    expect(isDict(d)).toBe(true);
    if (!isDict(d)) return;
    const sh = doc.resolve(d.get('Shading'));
    expect(isDict(sh)).toBe(true);
    if (!isDict(sh)) return;
    expect(sh.get('ShadingType')).toBe(3);
    expect(sh.get('Coords')).toEqual([50, 60, 0, 50, 60, 25]);
  });

  it('collapses a single-stop gradient to a solid stroke and allocates no pattern', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
                          stops: [{ offset: 0, color: RED }] });
    g.drawLine(0, 0, 10, 10).stroke();
    g.apply();

    expect(pageContentText(doc)).toContain('1 0 0 RG');
    expect(pageContentText(doc)).not.toContain('/Pattern CS');
    expect(patterns(doc)).toBeUndefined();
  });

  it('collapses a zero-length axis and a zero radius to the last stop colour', () => {
    for (const grad of [
      { kind: 'linear' as const, x1: 50, y1: 50, x2: 50, y2: 50, stops: ramp() },
      { kind: 'radial' as const, cx: 50, cy: 50, r: 0, stops: ramp() },
    ]) {
      const doc = Document.Open(buildStampTarget());
      const g = doc.Pages[0].Graphics();
      g.setStrokeGradient(grad);
      g.drawLine(0, 0, 10, 10).stroke();
      g.apply();

      expect(pageContentText(doc)).toContain('0 0 1 RG');   // BLUE, the last stop
      expect(patterns(doc)).toBeUndefined();
    }
  });

  it('folds a uniform stop alpha into /CA alone, leaving fills opaque', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
                          stops: [{ offset: 0, color: RED, opacity: 0.5 },
                                  { offset: 1, color: BLUE, opacity: 0.5 }] });
    g.drawLine(0, 0, 10, 10).stroke();
    g.apply();

    expect(pageContentText(doc)).toMatch(/\/GS\d+ gs/);
    // A stroke's own alpha must not fade the fill of the same path.
    expect(extGState(doc, 'GS0').get('CA')).toBe(0.5);
    expect(extGState(doc, 'GS0').has('ca')).toBe(false);
  });

  it("takes the single stop's own opacity when it collapses", () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'linear', x1: 50, y1: 50, x2: 50, y2: 50,
                          stops: [{ offset: 0, color: RED, opacity: 0.4 },
                                  { offset: 1, color: BLUE, opacity: 0.25 }] });
    g.drawLine(0, 0, 10, 10).stroke();
    g.apply();

    expect(extGState(doc, 'GS0').get('CA')).toBe(0.25);   // the LAST stop's alpha
    expect(extGState(doc, 'GS0').has('ca')).toBe(false);
  });

  it('keeps gradient coordinates in the default space, ignoring the CTM', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.transform(2, 0, 0, 2, 10, 20);
    g.setStrokeGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: ramp() });
    g.drawLine(0, 0, 10, 10).stroke();
    g.apply();

    // A pattern /Matrix maps pattern space to the stream's DEFAULT space, so the
    // cm above moves the path and not the ramp.
    const d = doc.resolve(patterns(doc)!.get('P0'));
    expect(isDict(d)).toBe(true);
    if (!isDict(d)) return;
    const sh = doc.resolve(d.get('Shading'));
    expect(isDict(sh)).toBe(true);
    if (!isDict(sh)) return;
    expect(sh.get('Coords')).toEqual([0, 0, 100, 0]);
  });

  it('leaves the document byte-identical when validation rejects', () => {
    const doc = Document.Open(buildStampTarget());
    const before = doc.Save();
    const g = doc.Pages[0].Graphics();
    expect(() => g.setStrokeGradient({
      kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: [],
    })).toThrow(TypeError);
    expect(doc.Save()).toEqual(before);
  });

  const varying = (): GradientStop[] =>
    [{ offset: 0, color: RED, opacity: 0.2 }, { offset: 1, color: BLUE, opacity: 0.9 }];
  const varyingGrad = (): LinearGradient =>
    ({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0, stops: varying() });

  it('masks varying stop alpha with a luminosity soft mask', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient({ kind: 'linear', x1: 10, y1: 20, x2: 110, y2: 20, stops: varying() })
     .drawLine(10, 20, 110, 20).stroke();
    g.apply();

    // The mask `gs` must precede the pattern selection and the paint.
    expect(pageContentText(doc)).toMatch(/\/GS\d+ gs[\s\S]*\/Pattern CS[\s\S]*\/P0 SCN/);

    const smask = doc.resolve(extGState(doc, 'GS0').get('SMask'));
    expect(isDict(smask)).toBe(true);
    if (!isDict(smask)) return;
    const form = doc.resolve(smask.get('G'));
    expect(isStream(form)).toBe(true);
    if (!isStream(form)) return;
    const res = doc.resolve(form.dict.get('Resources'));
    const pat = isDict(res) ? doc.resolve(res.get('Pattern')) : undefined;
    const p0 = isDict(pat) ? doc.resolve(pat.get('P0')) : undefined;
    expect(isDict(p0)).toBe(true);
    if (!isDict(p0)) return;
    const sh = doc.resolve(p0.get('Shading'));
    expect(isDict(sh)).toBe(true);
    if (!isDict(sh)) return;
    // The grayscale twin on the SAME axis: a mask that does not line up with
    // what it masks is worse than no mask.
    expect(nameOf(sh.get('ColorSpace'))).toBe('DeviceGray');
    expect(sh.get('Coords')).toEqual([10, 20, 110, 20]);
  });

  it('refuses a second soft mask for the other channel before a paint', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient(varyingGrad());
    // One /ExtGState holds ONE /SMask and it masks both paints, so this would
    // silently paint the fill through the stroke's ramp.
    expect(() => g.setStrokeGradient(varyingGrad())).toThrow(UnsupportedFeatureError);
  });

  it('allows the two-operation split a paint between them makes', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient(varyingGrad());
    g.rect(0, 0, 10, 10).fill();
    expect(() => g.setStrokeGradient(varyingGrad())).not.toThrow();
    g.drawLine(0, 0, 10, 10).stroke();
    g.apply();

    expect(pageContentText(doc)).toContain('/GS0 gs');
    expect(pageContentText(doc)).toContain('/GS1 gs');
  });

  it('allows re-setting the same channel, which paints through neither', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setStrokeGradient(varyingGrad());
    expect(() => g.setStrokeGradient(varyingGrad())).not.toThrow();
  });

  it('pops the claim with restore(), as a real /SMask is popped by Q', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.save();
    g.setFillGradient(varyingGrad());
    g.restore();                                   // the fill mask is out of force
    expect(() => g.setStrokeGradient(varyingGrad())).not.toThrow();
  });

  it('a uniform-alpha gradient claims nothing, since it registers no mask', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.setFillGradient({ kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
                        stops: [{ offset: 0, color: RED, opacity: 0.5 },
                                { offset: 1, color: BLUE, opacity: 0.5 }] });
    expect(() => g.setStrokeGradient(varyingGrad())).not.toThrow();
  });
});

describe('registerExtGState channels', () => {
  const RED: [number, number, number] = [1, 0, 0];
  const BLUE: [number, number, number] = [0, 0, 1];

  /** A named /ExtGState off page 1. */
  function ext(doc: Document, key: string): PdfDict {
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources'));
    const gs = isDict(res) ? doc.resolve(res.get('ExtGState')) : undefined;
    const d = isDict(gs) ? doc.resolve(gs.get(key)) : undefined;
    if (!isDict(d)) throw new Error(`no /ExtGState /${key}`);
    return d;
  }

  it('scopes the alpha to one paint channel', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const f = registerExtGState(doc, page, 0.5, 'fill');
    const s = registerExtGState(doc, page, 0.5, 'stroke');
    const b = registerExtGState(doc, page, 0.5, 'both');

    expect(ext(doc, f).get('ca')).toBe(0.5);
    expect(ext(doc, f).has('CA')).toBe(false);
    expect(ext(doc, s).get('CA')).toBe(0.5);
    expect(ext(doc, s).has('ca')).toBe(false);
    expect(ext(doc, b).get('ca')).toBe(0.5);
    expect(ext(doc, b).get('CA')).toBe(0.5);
    expect(new Set([f, s, b]).size).toBe(3);      // three distinct states
  });

  it('defaults to both channels, leaving existing callers unchanged', () => {
    const doc = Document.Open(buildStampTarget());
    const k = registerExtGState(doc, doc.Pages[0], 0.25);
    expect(ext(doc, k).get('ca')).toBe(0.25);
    expect(ext(doc, k).get('CA')).toBe(0.25);
  });

  it('reuses a state only when the whole channel set matches', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    expect(registerExtGState(doc, page, 0.5, 'fill'))
      .toBe(registerExtGState(doc, page, 0.5, 'fill'));
    // A fill-only 0.5 must NOT satisfy a request for both channels: ca and CA
    // are independent, and reusing it silently drops the stroke half.
    expect(registerExtGState(doc, page, 0.5, 'both'))
      .not.toBe(registerExtGState(doc, page, 0.5, 'fill'));
  });

  it('never reuses a soft-mask state for a plain alpha', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const grad: LinearGradient = {
      kind: 'linear', x1: 0, y1: 0, x2: 100, y2: 0,
      stops: [{ offset: 0, color: RED, opacity: 0 },
              { offset: 1, color: BLUE, opacity: 1 }],
    };
    const identity: Matrix = [1, 0, 0, 1, 0, 0];
    // The mask state carries ca = CA = 1, so an opacity-1 request matches it on
    // both channels — and would silently inherit its /SMask.
    const masked = registerSoftMaskExtGState(
      doc, page,
      shadingPattern(axialShading(grad, normalizeStops(grad.stops), 'alpha')),
      identity);
    expect(registerExtGState(doc, page, 1)).not.toBe(masked);
  });
});

describe('PageGraphics.BeginArtifact', () => {
  it('emits /Artifact BMC and pairs with EndMarkedContent', () => {
    const doc = Document.Open(buildStampTarget());
    const g = doc.Pages[0].Graphics();
    g.BeginArtifact();
    g.setFillColor([0, 0, 0]).rect(10, 10, 50, 20).fill();
    g.EndMarkedContent();
    g.apply();

    const text = pageContentText(doc);
    expect(text).toContain('/Artifact BMC');
    expect(text).toContain('EMC');
    // An artifact carries no MCID — that is what distinguishes it from
    // BeginMarkedContent, whose sequence is /<tag> <</MCID n>> BDC.
    expect(text).not.toContain('/Artifact <<');
    expect(text.indexOf('/Artifact BMC')).toBeLessThan(text.indexOf(' re'));
  });
});

describe('PageGraphics.setMiterLimit', () => {
  const g = () => Document.Open(buildBlankPage()).Pages[0].Graphics();

  it('emits the M operator', () => {
    const doc = Document.Open(buildBlankPage());
    const gr = doc.Pages[0].Graphics();
    gr.setMiterLimit(4).moveTo(0, 0).lineTo(10, 10).stroke();
    gr.apply();
    expect(pageContentText(doc)).toContain('4 M');
  });

  it('rejects a limit below 1 or non-finite', () => {
    expect(() => g().setMiterLimit(0.5)).toThrow(TypeError);
    expect(() => g().setMiterLimit(0)).toThrow(TypeError);
    expect(() => g().setMiterLimit(NaN)).toThrow(TypeError);
    expect(() => g().setMiterLimit('4' as never)).toThrow(TypeError);
    expect(() => g().setMiterLimit(1)).not.toThrow();     // 1 is the legal floor
  });
});

describe('PageGraphics shape primitives', () => {
  /** Path/paint operators of page 1, in order. */
  const opsOf = (doc: Document) =>
    parseContentStream(doc.Pages[0].Contents).map((o) => o.operator);

  /** Draw with `f` on a blank page and return [ops, contentText]. */
  function drawn(f: (g: ReturnType<Document['Pages'][0]['Graphics']>) => void) {
    const doc = Document.Open(buildBlankPage());
    const g = doc.Pages[0].Graphics();
    f(g);
    g.apply();
    return { ops: opsOf(doc), text: pageContentText(doc) };
  }

  describe('polyline / polygon', () => {
    it('polyline is a moveTo followed by lineTos, left open', () => {
      const { ops } = drawn((g) => g.polyline([[0, 0], [10, 0], [10, 10]]).stroke());
      expect(ops.filter((o) => o === 'm')).toEqual(['m']);
      expect(ops.filter((o) => o === 'l')).toEqual(['l', 'l']);
      expect(ops).not.toContain('h');
      expect(ops).toContain('S');
    });

    it('polygon closes the subpath', () => {
      const { ops } = drawn((g) => g.polygon([[0, 0], [10, 0], [10, 10]]).fill());
      expect(ops.filter((o) => o === 'l')).toEqual(['l', 'l']);
      expect(ops).toContain('h');
      expect(ops).toContain('f');
    });

    it('rejects fewer than two points and malformed entries', () => {
      // Matched on message throughout: a missing method throws a TypeError too,
      // so `toThrow(TypeError)` alone would pass before the method exists.
      const g = () => Document.Open(buildBlankPage()).Pages[0].Graphics();
      expect(() => g().polyline([[0, 0]])).toThrow(/points/);
      expect(() => g().polygon([[0, 0]])).toThrow(/points/);
      expect(() => g().polyline([[0, 0], [1] as never])).toThrow(/points/);
      expect(() => g().polygon([[0, 0], [NaN, 1]])).toThrow(/points/);
    });
  });

  describe('roundedRect', () => {
    it('is four corner curves joined by four lines, closed', () => {
      const { ops } = drawn((g) => g.roundedRect(10, 10, 100, 50, 8).stroke());
      expect(ops.filter((o) => o === 'm').length).toBe(1);
      expect(ops.filter((o) => o === 'c').length).toBe(4);
      expect(ops.filter((o) => o === 'l').length).toBe(4);
      expect(ops).toContain('h');
    });

    it('clamps the radius to half the shorter side', () => {
      const big = drawn((g) => g.roundedRect(0, 0, 40, 20, 100).stroke()).text;
      const clamped = drawn((g) => g.roundedRect(0, 0, 40, 20, 10).stroke()).text;
      expect(big).toBe(clamped);
    });

    it('rounds each corner on its own quarter-circle', () => {
      // The corner control points are derived here rather than reused from
      // ellipse(), so they carry their own sign-error risk. Checked against the
      // quarter-circle each corner is meant to be, not against our own output.
      const [x, y, w, h, r] = [10, 20, 100, 60, 12];
      const doc = Document.Open(buildBlankPage());
      const g = doc.Pages[0].Graphics();
      g.roundedRect(x, y, w, h, r).stroke();
      g.apply();

      // Walk the path so each `c` knows the point it starts from.
      const segs: number[][] = [];
      let cur: [number, number] = [0, 0];
      for (const op of parseContentStream(doc.Pages[0].Contents)) {
        const n = op.operands.map(Number);
        if (op.operator === 'm' || op.operator === 'l') cur = [n[0], n[1]];
        else if (op.operator === 'c') { segs.push([...cur, ...n]); cur = [n[4], n[5]]; }
      }
      expect(segs.length).toBe(4);

      // Corner arc centres, in emission order: BR, TR, TL, BL.
      const centres: [number, number][] = [
        [x + w - r, y + r], [x + w - r, y + h - r], [x + r, y + h - r], [x + r, y + r],
      ];
      const mid = (p0: number, p1: number, p2: number, p3: number) =>
        0.125 * p0 + 0.375 * p1 + 0.375 * p2 + 0.125 * p3;   // cubic at t = 0.5
      segs.forEach(([p0x, p0y, c1x, c1y, c2x, c2y, p3x, p3y], i) => {
        const mx = mid(p0x, c1x, c2x, p3x), my = mid(p0y, c1y, c2y, p3y);
        const [ccx, ccy] = centres[i];
        expect(Math.abs(Math.hypot(mx - ccx, my - ccy) - r) / r).toBeLessThan(5e-4);
      });
    });

    it('degenerates to a plain rect at radius 0', () => {
      const { ops } = drawn((g) => g.roundedRect(0, 0, 40, 20, 0).fill());
      expect(ops).toContain('re');
      expect(ops).not.toContain('c');
    });

    it('rejects a negative radius or a non-positive side', () => {
      const g = () => Document.Open(buildBlankPage()).Pages[0].Graphics();
      // Not /roundedRect/: "g(...).roundedRect is not a function" contains it.
      expect(() => g().roundedRect(0, 0, 40, 20, -1)).toThrow(/radius must be/);
      expect(() => g().roundedRect(0, 0, 0, 20, 2)).toThrow(/width and height must be/);
    });
  });

  describe('arc', () => {
    it('starts a subpath when none is open', () => {
      const { ops } = drawn((g) => g.arc(50, 50, 20, 0, Math.PI / 2).stroke());
      expect(ops.filter((o) => o === 'm').length).toBe(1);
      expect(ops.filter((o) => o === 'c').length).toBe(1);   // 90 degrees = one segment
      expect(ops.filter((o) => o === 'l').length).toBe(0);
    });

    it('appends to an open subpath with a connecting line', () => {
      const { ops } = drawn((g) =>
        g.moveTo(0, 0).lineTo(10, 0).arc(50, 50, 20, 0, Math.PI / 2).stroke());
      expect(ops.filter((o) => o === 'm').length).toBe(1);   // no second moveTo
      expect(ops.filter((o) => o === 'l').length).toBe(2);   // the lineTo, plus the connector
      expect(ops.filter((o) => o === 'c').length).toBe(1);
    });

    it('segments a sweep wider than 90 degrees', () => {
      const quarter = drawn((g) => g.arc(0, 0, 10, 0, Math.PI / 2).stroke()).ops;
      const half = drawn((g) => g.arc(0, 0, 10, 0, Math.PI).stroke()).ops;
      const full = drawn((g) => g.arc(0, 0, 10, 0, 2 * Math.PI).stroke()).ops;
      expect(quarter.filter((o) => o === 'c').length).toBe(1);
      expect(half.filter((o) => o === 'c').length).toBe(2);
      expect(full.filter((o) => o === 'c').length).toBe(4);
    });

    it('sweeps clockwise when the end angle is below the start', () => {
      const ccw = drawn((g) => g.arc(0, 0, 10, 0, Math.PI / 2).stroke()).text;
      const cw = drawn((g) => g.arc(0, 0, 10, Math.PI / 2, 0).stroke()).text;
      expect(cw).not.toBe(ccw);
      expect(drawn((g) => g.arc(0, 0, 10, Math.PI / 2, 0).stroke()).ops
        .filter((o) => o === 'c').length).toBe(1);
    });

    it('a paint operator ends the path, so the next arc starts a fresh subpath', () => {
      const { ops } = drawn((g) => {
        g.arc(0, 0, 10, 0, Math.PI / 2).stroke();
        g.arc(50, 50, 10, 0, Math.PI / 2).stroke();
      });
      expect(ops.filter((o) => o === 'm').length).toBe(2);
      expect(ops.filter((o) => o === 'l').length).toBe(0);
    });

    it('rejects a non-positive radius', () => {
      const g = () => Document.Open(buildBlankPage()).Pages[0].Graphics();
      // Not /arc/: "g(...).arc is not a function" contains it.
      expect(() => g().arc(0, 0, 0, 0, 1)).toThrow(/radius must be/);
      expect(() => g().arc(0, 0, -5, 0, 1)).toThrow(/radius must be/);
      expect(() => g().arc(0, 0, 10, NaN, 1)).toThrow(/must be a finite number/);
    });
  });

  describe('arc geometry', () => {
    /** The operands of every `c` in page 1, as [x1,y1,x2,y2,x3,y3]. */
    function curves(doc: Document): number[][] {
      return parseContentStream(doc.Pages[0].Contents)
        .filter((o) => o.operator === 'c')
        .map((o) => o.operands.map(Number));
    }
    /** The start point of the subpath: the operands of the single `m`. */
    function start(doc: Document): [number, number] {
      const m = parseContentStream(doc.Pages[0].Contents).find((o) => o.operator === 'm')!;
      return [Number(m.operands[0]), Number(m.operands[1])];
    }
    const bezier = (p0: number, p1: number, p2: number, p3: number, t: number) => {
      const u = 1 - t;
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    };

    /** Every point sampled along the emitted curves, as a radius from (cx, cy).
     *  Checked against the circle it is meant to approximate — arithmetic
     *  outside this library — rather than against our own emitted numbers, so a
     *  sign error in the control points cannot cancel out. */
    function radii(doc: Document, cx: number, cy: number): number[] {
      const out: number[] = [];
      let [px, py] = start(doc);
      for (const c of curves(doc)) {
        const [x1, y1, x2, y2, x3, y3] = c;
        for (const t of [0.25, 0.5, 0.75, 1]) {
          const x = bezier(px, x1, x2, x3, t);
          const y = bezier(py, y1, y2, y3, t);
          out.push(Math.hypot(x - cx, y - cy));
        }
        [px, py] = [x3, y3];
      }
      return out;
    }

    it('stays on the circle it approximates, counter-clockwise and clockwise', () => {
      // Bounded relatively, not absolutely: a cubic quarter-arc has a known max
      // radial error of ~2.7e-4 * r (0.011pt at r = 40), and that is the method,
      // not a defect. 5e-4 leaves headroom above it while staying orders of
      // magnitude below what any sign or control-point error would produce.
      for (const [a0, a1] of [[0, Math.PI / 2], [0, 2 * Math.PI], [Math.PI, 0], [0.3, 2.2]]) {
        const doc = Document.Open(buildBlankPage());
        const g = doc.Pages[0].Graphics();
        g.arc(120, 90, 40, a0, a1).stroke();
        g.apply();
        for (const r of radii(doc, 120, 90)) expect(Math.abs(r - 40) / 40).toBeLessThan(5e-4);
      }
    });

    it('begins and ends at the requested angles', () => {
      const doc = Document.Open(buildBlankPage());
      const g = doc.Pages[0].Graphics();
      g.arc(0, 0, 10, 0, Math.PI / 2).stroke();
      g.apply();
      expect(start(doc)).toEqual([10, 0]);
      const last = curves(doc).at(-1)!;
      expect(last[4]).toBeCloseTo(0, 6);          // cos(PI/2) * 10
      expect(last[5]).toBeCloseTo(10, 6);         // sin(PI/2) * 10
    });
  });

  it('every new shape composes with fillStroke', () => {
    for (const draw of [
      (g: any) => g.polygon([[0, 0], [10, 0], [5, 8]]),
      (g: any) => g.roundedRect(0, 0, 30, 20, 4),
      (g: any) => g.arc(20, 20, 10, 0, Math.PI),
    ]) {
      const { ops } = drawn((g) => { draw(g); g.fillStroke(); });
      expect(ops).toContain('B');
    }
  });
});

describe('resource-target register* variants', () => {
  it('registers into the dict it is given, not the page', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const detached: PdfDict = new Map();
    const key = registerExtGStateIn(doc, detached, 0.5);

    // The entry landed in the detached dict...
    const gs = doc.resolve(detached.get('ExtGState'));
    expect(isDict(gs)).toBe(true);
    expect((gs as PdfDict).has(key)).toBe(true);
    // ...and the page's own resources gained no ExtGState at all.
    const pageRes = doc.resolve(page.Dict.get('Resources'));
    const pageGs = isDict(pageRes) ? doc.resolve((pageRes as PdfDict).get('ExtGState')) : undefined;
    expect(isDict(pageGs) && (pageGs as PdfDict).has(key)).toBe(false);
  });

  it('gives the page wrapper and the variant the same key', () => {
    // The wrapper is the variant applied to ensureOwnResources, so a page
    // caller cannot tell the refactor happened.
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    expect(registerExtGState(doc, page, 0.5)).toBe('GS0');
    expect(registerExtGStateIn(doc, ensureOwnResources(doc, page), 0.5)).toBe('GS0');
  });

  it('reuses an existing key for the same pattern ref', () => {
    // Cross-page reuse of one tiling pattern depends on this, and so does
    // using the same pattern twice on one page.
    const doc = Document.Open(buildBlankPage());
    const res: PdfDict = new Map();
    const ref = doc.allocObject(new Map<string, PdfObject>([['PatternType', 1]]));
    const a = registerPatternRefIn(doc, res, ref);
    const b = registerPatternRefIn(doc, res, ref);
    expect(b).toBe(a);
    const pat = doc.resolve(res.get('Pattern')) as PdfDict;
    expect([...pat.keys()]).toEqual([a]);
  });
});

describe('VectorGraphics base', () => {
  it('is what PageGraphics extends', () => {
    const doc = Document.Open(buildBlankPage());
    const g = new PageGraphics(doc, doc.Pages[0]);
    expect(g).toBeInstanceOf(VectorGraphics);
  });

  it('keeps apply() and page off the base', () => {
    // The tile callback receives the BASE, so a tile builder cannot splice
    // itself into a page — the method does not exist on what it holds, which
    // makes the mistake unrepresentable rather than refused at runtime.
    expect('apply' in VectorGraphics.prototype).toBe(false);
    expect('page' in VectorGraphics.prototype).toBe(false);
    expect('drawRect' in VectorGraphics.prototype).toBe(true);
    expect('setFillGradient' in VectorGraphics.prototype).toBe(true);
    expect('BeginLayer' in VectorGraphics.prototype).toBe(true);
  });
});
