import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { Rect } from '../src/text.js';
import { buildAnnotTextPdf } from './helpers/build-annot-text-pdf.js';

const page = () => Document.Open(buildAnnotTextPdf()).Pages[0];

describe('SearchAnnotations', () => {
  it('finds text drawn only inside an /AP appearance stream', () => {
    const hits = page().SearchAnnotations('bravo');
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('bravo');
    expect(hits[0].annot.Subtype).toBe('FreeText');
  });

  it("finds a form field's value, which lives only in its appearance", () => {
    const hits = page().SearchAnnotations('charlie');
    expect(hits).toHaveLength(1);
    expect(hits[0].annot.Subtype).toBe('Widget');
  });

  it('matches a RegExp globally, like Search', () => {
    expect(page().SearchAnnotations(/b.avo/)).toHaveLength(1);
  });

  // Both directions of the split: neither entry point sees the other's text.
  it('does not return page content text', () => {
    expect(page().SearchAnnotations('alpha')).toHaveLength(0);
  });

  it('Search still does not return appearance text', () => {
    expect(page().Search('bravo')).toHaveLength(0);
  });
});

describe('SearchAnnotations geometry', () => {
  it('returns tight glyph boxes, not the annotation /Rect', () => {
    const hits = page().SearchAnnotations('bravo');
    const [x0, y0, x1, y1] = hits[0].quads[0];
    // Inside /Rect [120 95 220 115]...
    expect(x0).toBeGreaterThanOrEqual(120);
    expect(y0).toBeGreaterThanOrEqual(95);
    expect(x1).toBeLessThanOrEqual(220);
    expect(y1).toBeLessThanOrEqual(115);
    // ...and strictly SMALLER than it. Containment alone is satisfied by a
    // /Rect-sized quad, which is the shape this feature exists to avoid.
    expect((x1 - x0) * (y1 - y0)).toBeLessThan(0.5 * (220 - 120) * (115 - 95));
  });

  it('places glyphs where the appearance actually draws them', () => {
    // AP BBox [0 0 100 20] maps onto /Rect [120 95 220 115] 1:1, and the text
    // is drawn at Td 2 5 in 10pt, so the box is x from 122, y 100..110.
    const [x0, y0, , y1] = page().SearchAnnotations('bravo')[0].quads[0];
    expect(x0).toBeCloseTo(122, 1);
    expect(y0).toBeCloseTo(100, 1);
    expect(y1).toBeCloseTo(110, 1);
  });

  it('one quad per line the match spans', () => {
    expect(page().SearchAnnotations('bravo')[0].quads).toHaveLength(1);
  });

  it("re-applies the appearance stream's own /Matrix on top of the placement", () => {
    // /Matrix [1 0 0 1 500 500] with BBox [0 0 100 20] gives a transformed box
    // of [500 500 600 520], which placementMatrix maps onto /Rect [20 60 120 80]
    // as translate(-480,-440). Composing the two gives translate(20,60), so
    // Td 2 5 lands at (22, 65). Code that drops the /Matrix puts it at
    // (-478, -435) — off the page, and nowhere near a plausible answer.
    const hits = page().SearchAnnotations('golf');
    expect(hits).toHaveLength(1);
    const [x0, y0] = hits[0].quads[0];
    expect(x0).toBeCloseTo(22, 1);
    expect(y0).toBeCloseTo(65, 1);
  });
});

describe('per-annotation assembly', () => {
  // The fixture puts the /FreeText's "bravo" on baseline y=100, the same
  // baseline as the page's "alpha", ~77pt to its right. layoutLines groups by
  // baseline (tolerance max(2, 0.5*size) = 5pt here) and inserts exactly one
  // space where the gap exceeds 0.25*size, so ONE shared assembly would produce
  // the literal line "alpha bravo".
  it('never matches across page content and an annotation', () => {
    expect(page().SearchAnnotations('alpha bravo')).toHaveLength(0);
    expect(page().Search('alpha bravo')).toHaveLength(0);
  });

  it('never matches across two annotations', () => {
    // "bravo" and "charlie" are on different baselines, so a shared assembly
    // would join them with a newline rather than a space — assert both spellings
    // so the test cannot pass by accident of the separator.
    expect(page().SearchAnnotations('bravo charlie')).toHaveLength(0);
    expect(page().SearchAnnotations('bravo\ncharlie')).toHaveLength(0);
  });

  it('proves the halves are individually present', () => {
    // Without this, the two assertions above would pass just as well if
    // SearchAnnotations found nothing at all.
    expect(page().SearchAnnotations('bravo')).toHaveLength(1);
    expect(page().SearchAnnotations('charlie')).toHaveLength(1);
    expect(page().Search('alpha')).toHaveLength(1);
  });

  it('returns matches in /Annots order', () => {
    const hits = page().SearchAnnotations(/bravo|charlie|golf/);
    expect(hits.map((h) => h.text)).toEqual(['bravo', 'charlie', 'golf']);
  });
});

describe('which annotations are searched', () => {
  // isAnnotVisible is the shared predicate pagerender.ts and flatten.ts use, so
  // search agrees with ToImage/ToSvg/FlattenAnnotations about what draws.
  it('skips a Hidden annotation (/F 2)', () => {
    expect(page().SearchAnnotations('delta')).toHaveLength(0);
  });

  it('skips a /Popup', () => {
    // A popup is the note window of a parent markup annotation; viewers draw it
    // only while the note is open.
    expect(page().SearchAnnotations('echo')).toHaveLength(0);
  });

  it('proves those two are otherwise findable text', () => {
    // Both carry a well-formed /AP drawing their word, so the two assertions
    // above are about visibility and not about a broken fixture.
    const doc = Document.Open(buildAnnotTextPdf());
    const p = doc.Pages[0];
    const hidden = p.Annotations.find((a) => a.Flags === 2)!;
    hidden.Flags = 0;
    expect(p.SearchAnnotations('delta')).toHaveLength(1);
  });

  it('skips a NoView annotation (/F 32)', () => {
    // The other bit isAnnotVisible tests: displayed on print only. The fixture
    // has no NoView annotation, so set the flag on one that is otherwise found —
    // which also proves the assertion is about the flag and nothing else.
    const doc = Document.Open(buildAnnotTextPdf());
    const p = doc.Pages[0];
    expect(p.SearchAnnotations('bravo')).toHaveLength(1);
    p.Annotations.find((a) => a.Subtype === 'FreeText' && a.Flags === 0)!.Flags = 32;
    expect(p.SearchAnnotations('bravo')).toHaveLength(0);
  });

  it('a malformed appearance costs only itself', () => {
    // Object 15 declares /Filter /NotAFilter, so decodeStream throws on it. It
    // sits BEFORE "golf" in /Annots, so a missing try/catch would drop golf too.
    const p = page();
    expect(p.SearchAnnotations('foxtrot')).toHaveLength(0);
    expect(p.SearchAnnotations('golf')).toHaveLength(1);
  });

  it('returns [] for a page with no /Annots at all', () => {
    const doc = Document.Open(buildAnnotTextPdf());
    doc.Pages[0].Dict.delete('Annots');
    expect(doc.Pages[0].SearchAnnotations('bravo')).toHaveLength(0);
  });
});

describe('SearchAnnotations region scoping', () => {
  // Same rule as searchText and extractTables: a glyph is in or out by its
  // quad's CENTROID, never partly in.
  const BAND: Rect = [0, 190, 300, 230];   // covers "charlie" (baseline 205) only

  it('keeps only annotations whose glyphs fall inside the region', () => {
    const p = page();
    expect(p.SearchAnnotations('charlie', { region: BAND })).toHaveLength(1);
    expect(p.SearchAnnotations('bravo', { region: BAND })).toHaveLength(0);
  });

  it('decides a glyph by its CENTROID, not by overlap', () => {
    // "charlie" is 10pt on baseline 205, so its quads span y 205..215 and the
    // centroids sit at y=210. A region starting at 211 overlaps every quad but
    // excludes every centroid; an intersection rule would keep them all.
    const p = page();
    expect(p.SearchAnnotations('charlie', { region: [0, 211, 300, 300] })).toHaveLength(0);
    expect(p.SearchAnnotations('charlie', { region: [0, 209, 300, 300] })).toHaveLength(1);
  });

  it('does NOT find a match straddling the region boundary', () => {
    // Filtering happens before line assembly, so a region cutting through a word
    // leaves only the glyphs inside it and the whole word is no longer there to
    // match. Correct, and the behaviour someone will later mistake for a bug.
    const cut: Rect = [0, 190, 37, 230];    // keeps roughly "cha"
    const p = page();
    expect(p.SearchAnnotations('charlie', { region: cut })).toHaveLength(0);
    // Proof the glyphs were not simply all excluded: the prefix IS found.
    expect(p.SearchAnnotations('cha', { region: cut })).toHaveLength(1);
  });

  it('omitting region gives exactly the unscoped result', () => {
    const p = page();
    const shape = (hits: { text: string; quads: Rect[] }[]) => hits.map((m) => [m.text, m.quads]);
    expect(shape(p.SearchAnnotations('charlie', {}))).toEqual(shape(p.SearchAnnotations('charlie')));
  });
});

describe('redacting what SearchAnnotations finds', () => {
  it('removes the annotation whose appearance drew the text', () => {
    // The documented route: SearchAnnotations gives the quads, Redact consumes
    // them, and removeCoveredAnnotations takes any annotation whose /Rect they
    // intersect. The whole annotation is the only granularity available without
    // surgery on the /AP stream, and that is the honest answer rather than a gap.
    const doc = Document.Open(buildAnnotTextPdf());
    const p = doc.Pages[0];
    const hits = p.SearchAnnotations('charlie');
    expect(hits).toHaveLength(1);

    p.Redact(hits.flatMap((m) => m.quads));

    const after = Document.Open(doc.Save()).Pages[0];
    expect(after.SearchAnnotations('charlie')).toHaveLength(0);
    // And it took only that one: the /FreeText elsewhere on the page survives.
    expect(after.SearchAnnotations('bravo')).toHaveLength(1);
  });
});
