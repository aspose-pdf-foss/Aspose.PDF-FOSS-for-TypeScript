import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { decodePng } from './helpers/decode-png.js';
import { buildOcgRenderPdf } from './helpers/build-ocg-render-pdf.js';
import { flattenOcOps, type OcFlattenOptions } from '../src/ocflatten.js';
import { parseContentStream, serializeContentStream, type ContentOp } from '../src/content.js';
import { inflateStream } from '../src/flate.js';
import { isArray, isDict, isStream, type PdfObject } from '../src/types.js';

/**
 * `doc.FlattenLayers()` (q1g2.6).
 *
 * Every other issue in this epic makes a CONSUMER ask the resolver a question.
 * This one takes the question away: the hidden spans are deleted from the
 * content streams they sit in, and `/OCProperties` goes with them, so the
 * result is an ordinary PDF that renders exactly as the configuration rendered.
 *
 * **The rule a "no ink anywhere" assertion cannot see:** the hidden content
 * must be GONE from the bytes rather than merely unreferenced. Deleting
 * `/OCProperties` alone — which is what `ConvertToPdfA('1b')` did on its own —
 * makes every hidden group unconditionally VISIBLE, which renders MORE than the
 * document showed. Both directions are asserted.
 */

/** Probe points, device space (y grows down on a 200x200 page). */
const IN_HIDDEN: [number, number] = [35, 165];      // the 10,10..60,60 rect
const IN_VISIBLE: [number, number] = [125, 65];     // the 100,100..150,150 rect
const IN_ANNOT: [number, number] = [140, 170];      // /Rect [120 10 160 50], cyan
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

const pixels = (bytes: Uint8Array) => {
  const png = decodePng(Document.Open(bytes).Pages[0].ToImage());
  return (p: [number, number]) => png.at(p[0], p[1]);
};

/** A hidden red block and a visible blue block, each in its own MC section. */
const TWO_LAYERS =
  '/OC /OCHid BDC 1 0 0 rg 10 10 50 50 re f EMC\n'
  + '/OC /OCVis BDC 0 0 1 rg 100 100 50 50 re f EMC\n';

/** Every content stream of a saved document, decoded and concatenated. */
function allContent(bytes: Uint8Array): string {
  const doc = Document.Open(bytes);
  const parts: string[] = [];
  for (const page of doc.Pages) {
    const c = doc.resolve(page.Dict.get('Contents'));
    const entries = isArray(c) ? c : [page.Dict.get('Contents')];
    for (const e of entries) {
      const s = doc.resolve(e);
      if (isStream(s)) parts.push(new TextDecoder().decode(inflateStream(s)));
    }
  }
  return parts.join('\n');
}

/** A resolved sub-dictionary of a resource dict. */
function sub(doc: Document, res: Map<string, PdfObject> | undefined, key: string) {
  const d = doc.resolve(res?.get(key));
  return isDict(d) ? d : undefined;
}

/** The one annotation's `/AP /N` appearance stream. */
function apStream(doc: Document) {
  const ap = doc.resolve(doc.Pages[0].Annotations[0].Dict.get('AP'));
  const n = doc.resolve(isDict(ap) ? ap.get('N') : undefined);
  if (!isStream(n)) throw new Error('no /AP /N appearance stream');
  return n;
}

function flattened(src: Uint8Array): { saved: Uint8Array; report: ReturnType<Document['FlattenLayers']> } {
  const doc = Document.Open(src);
  const report = doc.FlattenLayers();
  return { saved: doc.Save(), report };
}

describe('Document.FlattenLayers — what it keeps', () => {
  it('renders identically to the same document with its layers honoured', () => {
    // The acceptance criterion, and the one assertion that says the deletion is
    // placed exactly where the renderer places its suppression: a flatten that
    // cut one op too many or too few moves a pixel.
    const before = Document.Open(buildOcgRenderPdf(TWO_LAYERS)).Pages[0].ToImage();
    const { saved } = flattened(buildOcgRenderPdf(TWO_LAYERS));
    const after = Document.Open(saved).Pages[0].ToImage();
    expect(Buffer.from(after)).toEqual(Buffer.from(before));
  });

  it('paints the visible block and not the hidden one', () => {
    // The control that stops a byte comparison of two blank pages from passing.
    const { saved } = flattened(buildOcgRenderPdf(TWO_LAYERS));
    const at = pixels(saved);
    expect(at(IN_VISIBLE)).toEqual(BLUE);
    expect(at(IN_HIDDEN)).toEqual(WHITE);
  });

  it('keeps a layer the configuration turns back ON', () => {
    // Flattening is against the CONFIGURATION, not against "anything optional":
    // with /OFF empty both blocks are shown, so both must survive.
    const { saved, report } = flattened(buildOcgRenderPdf(TWO_LAYERS, { off: [] }));
    const at = pixels(saved);
    expect(at(IN_HIDDEN)).toEqual([255, 0, 0, 255]);
    expect(at(IN_VISIBLE)).toEqual(BLUE);
    expect(report).toMatchObject({ hiddenSections: 0, unwrappedSections: 2 });
  });
});

describe('Document.FlattenLayers — what it takes away', () => {
  it('deletes the hidden ops rather than merely unreferencing them', () => {
    // Delete /OCProperties alone and the red block is still in the stream — and
    // now unconditionally visible. This is the assertion that separates the two.
    const { saved } = flattened(buildOcgRenderPdf(TWO_LAYERS));
    const content = allContent(saved);
    expect(content).not.toContain('1 0 0 rg');
    expect(content).toContain('0 0 1 rg');
  });

  it('removes every /OC wrapper, /Properties entry and /OCProperties', () => {
    const { saved } = flattened(buildOcgRenderPdf(TWO_LAYERS));
    const content = allContent(saved);
    expect(content).not.toContain('BDC');
    expect(content).not.toContain('EMC');

    const doc = Document.Open(saved);
    expect(doc.catalog().has('OCProperties')).toBe(false);
    expect(doc.OptionalContent.Layers).toEqual([]);
    expect(doc.Pages[0].Resources?.has('Properties')).toBe(false);
    // The group objects were reachable only through those two, so the
    // mark-sweep drops them: no /Type /OCG survives anywhere in the file.
    expect(new TextDecoder().decode(saved)).not.toContain('/OCG');
  });

  it('reports the pages it changed', () => {
    const { report } = flattened(buildOcgRenderPdf(TWO_LAYERS));
    expect(report.pagesChanged).toBe(1);
    expect(report.hiddenSections).toBe(1);
    expect(report.unwrappedSections).toBe(1);
  });

  it('does nothing to a document that declares no optional content', () => {
    // And creates nothing: a walker reaching for `Default` would write
    // /OCProperties into every document it touched.
    const src = buildOcgRenderPdf(TWO_LAYERS, { noOcProperties: true });
    const doc = Document.Open(src);
    const report = doc.FlattenLayers();
    expect(report).toMatchObject({
      pagesChanged: 0, hiddenSections: 0, unwrappedSections: 0, unresolved: 0,
    });
    expect(doc.catalog().has('OCProperties')).toBe(false);
    expect(allContent(doc.Save())).toContain('BDC');
  });

  it('refuses a signed document rather than invalidating the signature', () => {
    const doc = Document.Open(buildOcgRenderPdf(TWO_LAYERS));
    const sig: Map<string, PdfObject> = new Map([['FT', { kind: 'name', name: 'Sig' }]]);
    doc.catalog().set('AcroForm', new Map<string, PdfObject>([['Fields', [sig]]]));
    expect(() => doc.FlattenLayers()).toThrow(UnsupportedFeatureError);
  });
});

describe('Document.FlattenLayers — XObjects and annotations', () => {
  // The form draws green at 0,0..40,40 of its BBox; the content places it with
  // a `cm`, and the image is magenta.
  const DRAW_BOTH = '/Fm0 Do\nq 100 0 0 100 50 50 cm /Im0 Do Q\n';
  const FORM_AT: [number, number] = [20, 180];   // inside the form's 40x40 square
  const IMAGE_AT: [number, number] = [100, 100]; // inside the image's placement

  it('drops the draw, the resource entry and the object of a hidden XObject', () => {
    const { saved, report } = flattened(
      buildOcgRenderPdf(DRAW_BOTH, { formOc: '7 0 R', imageOc: '7 0 R' }));
    const at = pixels(saved);
    expect(at(FORM_AT)).toEqual(WHITE);
    expect(at(IMAGE_AT)).toEqual(WHITE);
    expect(report).toMatchObject({ hiddenDraws: 2, removedXObjects: 2 });

    const doc = Document.Open(saved);
    const xo = doc.resolve(doc.Pages[0].Resources?.get('XObject'));
    // Left in /Resources, the hidden form's own ink survives `Save()`'s
    // mark-sweep and a reader gets the hidden content back.
    expect(isDict(xo) ? [...xo.keys()] : []).toEqual([]);
    expect(allContent(saved)).not.toContain('Do');
    expect(new TextDecoder().decode(saved)).not.toContain('0 1 0 rg');
  });

  it('keeps a visible XObject and merely takes its /OC key away', () => {
    const { saved, report } = flattened(
      buildOcgRenderPdf(DRAW_BOTH, { formOc: '6 0 R', imageOc: '6 0 R' }));
    const at = pixels(saved);
    expect(at(FORM_AT)).toEqual([0, 255, 0, 255]);
    expect(at(IMAGE_AT)).toEqual([255, 0, 255, 255]);
    expect(report).toMatchObject({ hiddenDraws: 0, removedXObjects: 0 });

    const doc = Document.Open(saved);
    const xo = doc.resolve(doc.Pages[0].Resources?.get('XObject'));
    const fm = isDict(xo) ? doc.resolve(xo.get('Fm0')) : undefined;
    expect(isStream(fm) && fm.dict.has('OC')).toBe(false);
  });

  it('removes a hidden annotation and un-layers a visible one', () => {
    const hidden = flattened(buildOcgRenderPdf(TWO_LAYERS, { annotOc: '7 0 R' }));
    expect(hidden.report.hiddenAnnotations).toBe(1);
    const hd = Document.Open(hidden.saved);
    expect(hd.Pages[0].Annotations).toHaveLength(0);

    const shown = flattened(buildOcgRenderPdf(TWO_LAYERS, { annotOc: '6 0 R' }));
    expect(shown.report.hiddenAnnotations).toBe(0);
    const sd = Document.Open(shown.saved);
    expect(sd.Pages[0].Annotations).toHaveLength(1);
    expect(sd.Pages[0].Annotations[0].Dict.has('OC')).toBe(false);
  });

  it('flattens a hidden /OC section inside an annotation appearance stream', () => {
    // An appearance is a content stream like any other and reaches the
    // interpreter, so a `/OC` left standing inside one becomes VISIBLE the
    // moment /OCProperties goes — the document renders MORE than it showed.
    //
    // **Note the fixture this needed.** The builder's stock appearance carries
    // no marked content at all, so an assertion that the walk merely left the
    // /AP intact passes with appearance streams excluded from the scope set
    // outright — measured, that mutation was GREEN until `apOc` existed.
    const src = buildOcgRenderPdf('', { annotOc: '6 0 R', apOc: 'ApHid' });
    const at = pixels(src);
    expect(at(IN_ANNOT)).toEqual(WHITE);      // hidden before the flatten…

    const { saved } = flattened(src);
    expect(pixels(saved)(IN_ANNOT)).toEqual(WHITE);   // …and after it
    const doc = Document.Open(saved);
    const ap = apStream(doc);
    const body = new TextDecoder().decode(inflateStream(ap));
    expect(body).not.toContain('0 1 1 rg');
    expect(body).not.toContain('BDC');
  });

  it('unwraps a visible /OC section inside an annotation appearance stream', () => {
    // The control: the same walk must KEEP the ink when the section is shown,
    // so "reached it" is not satisfied by deleting appearances wholesale.
    const { saved } = flattened(
      buildOcgRenderPdf('', { annotOc: '6 0 R', apOc: 'ApVis' }));
    expect(pixels(saved)(IN_ANNOT)).toEqual([0, 255, 255, 255]);
    const body = new TextDecoder().decode(inflateStream(apStream(Document.Open(saved))));
    expect(body).toContain('0 1 1 rg');
    expect(body).not.toContain('BDC');
  });
});

describe('Document.FlattenLayers — the scopes it reaches', () => {
  // A hidden section inside a NESTED content stream is the case a page-content
  // walk cannot see, and the one that breaks the guarantee in the WORST
  // direction: /OCProperties goes, the section is left standing, and the ink
  // the document hid becomes unconditionally visible.
  //
  // **Note these needed fixtures built for them.** Every earlier case marks
  // content in the page stream alone, so excluding form XObjects or tiling
  // patterns from the scope walk outright was GREEN — measured — until
  // `formOcSection` and `patternOc` existed.

  it('flattens a hidden /OC section inside a form XObject', () => {
    const src = buildOcgRenderPdf('/Fm0 Do\n', { formOcSection: 'FmHid' });
    const FORM_AT: [number, number] = [20, 180];
    expect(pixels(src)(FORM_AT)).toEqual(WHITE);           // hidden before…
    const { saved } = flattened(src);
    expect(pixels(saved)(FORM_AT)).toEqual(WHITE);         // …and after
    const doc = Document.Open(saved);
    const fm = doc.resolve(sub(doc, doc.Pages[0].Resources, 'XObject')?.get('Fm0'));
    const body = new TextDecoder().decode(inflateStream(fm as never));
    expect(body).not.toContain('0 1 0 rg');
    expect(body).not.toContain('BDC');
  });

  it('keeps a visible /OC section inside a form XObject', () => {
    const { saved } = flattened(
      buildOcgRenderPdf('/Fm0 Do\n', { formOcSection: 'FmVis' }));
    expect(pixels(saved)([20, 180])).toEqual([0, 255, 0, 255]);
  });

  it('flattens a hidden /OC section inside a tiling pattern', () => {
    const src = buildOcgRenderPdf(
      '/Pattern cs /P0 scn 10 10 50 50 re f\n', { patternOc: 'PatHid' });
    expect(pixels(src)(IN_HIDDEN)).toEqual(WHITE);
    const { saved } = flattened(src);
    expect(pixels(saved)(IN_HIDDEN)).toEqual(WHITE);
    const doc = Document.Open(saved);
    const pat = doc.resolve(sub(doc, doc.Pages[0].Resources, 'Pattern')?.get('P0'));
    const body = new TextDecoder().decode(inflateStream(pat as never));
    expect(body).not.toContain('1 0 0 rg');
    expect(body).not.toContain('BDC');
  });

  it('keeps a visible /OC section inside a tiling pattern', () => {
    const { saved } = flattened(buildOcgRenderPdf(
      '/Pattern cs /P0 scn 10 10 50 50 re f\n', { patternOc: 'PatVis' }));
    expect(pixels(saved)(IN_HIDDEN)).toEqual([255, 0, 0, 255]);
  });

  it('flattens a hidden /OC section inside a Type 3 glyph procedure', () => {
    const GLYPH = 'BT /T3 1 Tf 10 150 Td (a) Tj ET\n';
    const AT: [number, number] = [30, 30];                // the 40x40 glyph box
    const src = buildOcgRenderPdf(GLYPH, { charProcOc: 'T3Hid' });
    expect(pixels(src)(AT)).toEqual(WHITE);
    const { saved } = flattened(src);
    expect(pixels(saved)(AT)).toEqual(WHITE);
    // Targeted at the glyph procedure, not the whole file: `/Fm0` paints the
    // same green and is never drawn by this fixture, so a whole-file search
    // finds it and says nothing about the charproc.
    const doc = Document.Open(saved);
    const font = doc.resolve(sub(doc, doc.Pages[0].Resources, 'Font')?.get('T3'));
    const procs = doc.resolve(isDict(font) ? font.get('CharProcs') : undefined);
    const proc = doc.resolve(isDict(procs) ? procs.get('sq') : undefined);
    const body = new TextDecoder().decode(inflateStream(proc as never));
    expect(body).not.toContain('0 1 0 rg');
    expect(body).not.toContain('BDC');
  });

  it('keeps a visible /OC section inside a Type 3 glyph procedure', () => {
    const { saved } = flattened(buildOcgRenderPdf(
      'BT /T3 1 Tf 10 150 Td (a) Tj ET\n', { charProcOc: 'T3Vis' }));
    expect(pixels(saved)([30, 30])).toEqual([0, 255, 0, 255]);
  });

  it('flattens a hidden /OC section inside a soft-mask group', () => {
    // The group paints the luminosity mask, so a section left standing there
    // turns a fully masked-away fill into a fully painted one.
    const MASKED = '/GS0 gs 0 0 1 rg 100 100 50 50 re f\n';
    const src = buildOcgRenderPdf(MASKED, { smaskOc: 'SmHid' });
    expect(pixels(src)(IN_VISIBLE)).toEqual(WHITE);
    const { saved } = flattened(src);
    expect(pixels(saved)(IN_VISIBLE)).toEqual(WHITE);
    expect(new TextDecoder().decode(saved)).not.toContain('1 g 0 0 200 200 re f');
  });

  it('keeps a visible /OC section inside a soft-mask group', () => {
    const { saved } = flattened(buildOcgRenderPdf(
      '/GS0 gs 0 0 1 rg 100 100 50 50 re f\n', { smaskOc: 'SmVis' }));
    expect(pixels(saved)(IN_VISIBLE)).toEqual(BLUE);
  });

  it('treats a page /Contents ARRAY as one marked-content scope', () => {
    // 32000-1 7.8.2: the concatenation is interpreted as a single stream, and
    // `Page.Contents` joins them, so the renderer already hides all of this. A
    // per-stream walk deletes to the end of the first member and leaves the
    // second member's ink — the very ink this exists to remove — standing.
    const src = buildOcgRenderPdf(
      '/OC /OCHid BDC 1 0 0 rg 10 10 50 50 re f\n',
      { content2: '0 0 1 rg 100 100 50 50 re f EMC\n' });
    const at = pixels(src);
    expect(at(IN_HIDDEN)).toEqual(WHITE);
    expect(at(IN_VISIBLE)).toEqual(WHITE);       // hidden by the open section

    const { saved, report } = flattened(src);
    const after = pixels(saved);
    expect(after(IN_HIDDEN)).toEqual(WHITE);
    expect(after(IN_VISIBLE)).toEqual(WHITE);
    expect(report.hiddenSections).toBe(1);
    const content = allContent(saved);
    expect(content).not.toContain('0 0 1 rg');
    expect(content).not.toContain('EMC');
  });
});

describe('Document.FlattenLayers — what it refuses to decide', () => {
  it('leaves an inline-dictionary /OC operand exactly as written', () => {
    // An inline dict cannot hold an indirect reference (content streams have
    // none), so it names no group we can resolve. Hiding its content would be
    // the one error that loses ink, and removing the wrapper would claim we had
    // decided about it — so both stay, and the report says so.
    const content = '/OC << /Type /OCMD >> BDC 1 0 0 rg 10 10 50 50 re f EMC\n';
    const { saved, report } = flattened(buildOcgRenderPdf(content));
    expect(report.unresolved).toBe(1);
    expect(pixels(saved)(IN_HIDDEN)).toEqual([255, 0, 0, 255]);
    const out = allContent(saved);
    expect(out).toContain('BDC');
    expect(out).toContain('1 0 0 rg');
  });

  it('leaves an /OC naming no /Properties entry exactly as written', () => {
    const content = '/OC /NoSuchKey BDC 1 0 0 rg 10 10 50 50 re f EMC\n';
    const { saved, report } = flattened(buildOcgRenderPdf(content));
    expect(report.unresolved).toBe(1);
    expect(pixels(saved)(IN_HIDDEN)).toEqual([255, 0, 0, 255]);
    expect(allContent(saved)).toContain('BDC');
  });
});

describe('Document.FlattenLayers — PDF/A', () => {
  it('makes ConvertToPdfA(\'1b\') keep only what was shown', () => {
    // ISO 19005-1 prohibits optional content outright, so the converter deletes
    // /OCProperties — which on its own turns every hidden group unconditionally
    // VISIBLE. Flattening first is what makes the conversion honest.
    const naive = Document.Open(buildOcgRenderPdf(TWO_LAYERS));
    naive.ConvertToPdfA('1b');
    expect(pixels(naive.Save())(IN_HIDDEN)).toEqual([255, 0, 0, 255]);

    const doc = Document.Open(buildOcgRenderPdf(TWO_LAYERS));
    doc.FlattenLayers();
    doc.ConvertToPdfA('1b');
    const at = pixels(doc.Save());
    expect(at(IN_HIDDEN)).toEqual(WHITE);
    expect(at(IN_VISIBLE)).toEqual(BLUE);
  });
});

// ---------------------------------------------------------------------------
// The pure half.
// ---------------------------------------------------------------------------

const ops = (src: string): ContentOp[] => parseContentStream(new TextEncoder().encode(src));
const text = (list: ContentOp[]): string => new TextDecoder().decode(serializeContentStream(list));

/** `/H` hides, `/V` shows; nothing else resolves. */
const OPTS: OcFlattenOptions = {
  properties: new Map<string, PdfObject>([['H', true], ['V', false]]),
  hidden: (raw) => raw === true,
  hiddenXObject: (nm) => nm === 'Hid',
};

describe('flattenOcOps', () => {
  it('deletes a hidden span, unwraps a visible one and leaves other tags alone', () => {
    const r = flattenOcOps([ops(
      '/OC /H BDC 1 0 0 rg EMC /OC /V BDC 0 0 1 rg EMC /P << /MCID 0 >> BDC 2 w EMC',
    )], OPTS);
    expect(text(r.streams[0])).toBe('0 0 1 rg\n/P << /MCID 0 >> BDC\n2 w\nEMC');
    expect(r).toMatchObject({ hiddenSections: 1, unwrappedSections: 1, unresolved: 0 });
  });

  it('takes a nested section with the hidden one that encloses it', () => {
    // The rule a single-level fixture cannot see: a VISIBLE section inside a
    // hidden one is still hidden, so its content goes and its wrapper is never
    // classified — it is not reported as unwrapped.
    const r = flattenOcOps([ops(
      '/OC /H BDC 1 0 0 rg /OC /V BDC 0 1 0 rg EMC 2 w EMC 3 w',
    )], OPTS);
    expect(text(r.streams[0])).toBe('3 w');
    expect(r).toMatchObject({ hiddenSections: 1, unwrappedSections: 0 });
  });

  it('keeps the content of a hidden section nested inside a visible one out', () => {
    const r = flattenOcOps([ops(
      '/OC /V BDC 1 w /OC /H BDC 0 1 0 rg EMC 2 w EMC',
    )], OPTS);
    expect(text(r.streams[0])).toBe('1 w\n2 w');
    expect(r).toMatchObject({ hiddenSections: 1, unwrappedSections: 1 });
  });

  it('carries the nesting state ACROSS the streams of one group', () => {
    // 32000-1 7.8.2: a page's /Contents array is interpreted as a SINGLE
    // stream, so a BDC in one member and its EMC in the next is a legal page.
    // A per-stream walk deletes to the end of the first stream and leaves the
    // rest of the span — the ink this exists to remove — standing.
    const r = flattenOcOps([ops('1 w /OC /H BDC 1 0 0 rg'), ops('0 1 0 rg EMC 2 w')], OPTS);
    expect(text(r.streams[0])).toBe('1 w');
    expect(text(r.streams[1])).toBe('2 w');
    expect(r.changed).toEqual([true, true]);
    expect(r.hiddenSections).toBe(1);
  });

  it('reports each stream that lost ops, and only those', () => {
    const r = flattenOcOps([ops('1 w'), ops('/OC /H BDC 2 w EMC')], OPTS);
    expect(r.changed).toEqual([false, true]);
  });

  it('drops the Do of a hidden XObject and records both sides', () => {
    const r = flattenOcOps([ops('/Vis Do /Hid Do /OC /H BDC /Buried Do EMC')], OPTS);
    expect(text(r.streams[0])).toBe('/Vis Do');
    expect([...r.invoked]).toEqual(['Vis']);
    expect([...r.removedDraws].sort()).toEqual(['Buried', 'Hid']);
    expect(r.hiddenDraws).toBe(1);
  });

  it('tolerates an unbalanced EMC rather than losing the rest of the stream', () => {
    const r = flattenOcOps([ops('1 w EMC 2 w')], OPTS);
    expect(text(r.streams[0])).toBe('1 w\nEMC\n2 w');
    expect(r.changed).toEqual([false]);
  });

  it('deletes to the end of the group for an unclosed hidden section', () => {
    const r = flattenOcOps([ops('1 w /OC /H BDC 2 w')], OPTS);
    expect(text(r.streams[0])).toBe('1 w');
  });
});
