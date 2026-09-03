/** Content taller than an empty column renders instead of refusing the
 *  document (zch2.16). Driven from the flow builders, so nothing here needs
 *  the CSS stack. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { image, paragraph } from '../src/flow.js';
import type { FlowElement } from '../src/flowelement.js';
import { placeElements } from '../src/flowplace.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';

/** A w x h PNG of flat grey. The ASPECT is the fixture: the default A4 column
 *  is 451 x 698 pt (aspect 1.548), so an image scaled to the column width
 *  overflows it exactly when h/w exceeds that. */
function png(w: number, h: number): Uint8Array {
  return buildPngRgbWith(w, h, new Array(w * h * 3).fill(128), 0);
}

/** The drawn size of the first image on a page: the `w 0 0 h x y cm` that
 *  precedes its `Do`. Reading the content stream is how this suite asserts
 *  emitted geometry (test/flow.test.ts:298 and elsewhere) — `page.Images` can
 *  say an image is PRESENT but says nothing about how big it was drawn, which
 *  is the whole question here. */
function drawnImageSize(page: { Contents: Uint8Array }): [number, number] {
  const content = new TextDecoder('latin1').decode(page.Contents);
  const m = /([\d.]+) 0 0 ([\d.]+) -?[\d.]+ -?[\d.]+ cm\s*\/\w+ Do/.exec(content);
  if (m === null) throw new Error('no image draw found in the content stream');
  return [Number(m[1]), Number(m[2])];
}

describe('an image taller than an empty column', () => {
  it('renders SCALED instead of refusing the document', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements(image(png(9, 16)));
    const pages = flow.Render();
    expect(pages).toHaveLength(1);
    // Scaled, not clipped and not dropped: exactly as tall as the 698pt column
    // and NARROWER than its 451pt, the 9:16 aspect having been preserved.
    // Asserting only "did not throw" passes for a build that drops the image,
    // and asserting only `page.Images.length` passes for one that clips it.
    const [w, h] = drawnImageSize(pages[0]);
    expect(h).toBeCloseTo(698, 0);
    expect(w).toBeCloseTo(698 * 9 / 16, 0);
    expect(w).toBeLessThan(451);
  });

  it('reports the scale through onCompromise', () => {
    const seen: string[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const els = image(png(9, 16));
    els[0].onCompromise = (how) => { seen.push(how); };
    flow.AddElements(els);
    flow.Render();
    expect(seen).toEqual(['scaled']);
  });

  it('does NOT shrink an image that merely does not fit what is LEFT', () => {
    // The rule Decision 2 exists for. A 3:4 image fits a column on its own, so
    // one arriving near a column foot must move to the next column at FULL
    // size. A build that shrinks at every place() passes every single-element
    // fixture and fails only this one.
    const seen: string[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph('filler '.repeat(400));   // most of column 1
    const els = image(png(6, 8));
    els[0].onCompromise = (how) => { seen.push(how); };
    flow.AddElements(els);
    const pages = flow.Render();
    expect(seen).toEqual([]);                    // never compromised
    expect(pages.length).toBeGreaterThan(1);     // it moved instead
  });
});

describe('content that cannot be scaled', () => {
  it('OVERFLOWS the column instead of refusing the document', () => {
    const seen: string[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    // One line at 900pt cannot fit a 698pt column and cannot be scaled.
    const els = paragraph('W', { fontSize: 900 });
    els[0].onCompromise = (how) => { seen.push(how); };
    flow.AddElements(els);
    const pages = flow.Render();
    expect(seen).toEqual(['overflow']);
    expect(pages).toHaveLength(1);
    expect(pages[0].GetText()).toContain('W');   // drawn, not dropped
  });

  it('keeps rendering the content AFTER an overflowing element', () => {
    // The overflow must not take the document with it.
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements(paragraph('W', { fontSize: 900 }));
    flow.AddParagraph('AFTERWARDS');
    const text = flow.Render().map((p) => p.GetText()).join(' ');
    expect(text).toContain('AFTERWARDS');
  });
});

describe('the shrink is accepted only when it actually FITS', () => {
  /** An element that never fits and whose `shrinkToFit` LIES — it hands back
   *  another element exactly like itself.
   *
   *  No element in `src/` can do this: `ImageElement`'s clamp guarantees the
   *  replacement fits, and it is the only implementor. So the re-measure
   *  guard is a TERMINATION PROOF with no reachable fixture, and this is what
   *  makes it one — remove the guard and the engine asks the same element for
   *  a shrink at the same column start forever. Measured: with the guard
   *  dropped this case hangs, and nothing else in the suite moves. */
  function liar(): FlowElement {
    const el: FlowElement = {
      measure: () => ({ usedHeight: 0, fits: false }),
      place: () => ({ usedHeight: 0, remainder: el, drew: false }),
      shrinkToFit: () => liar(),
    };
    return el;
  }

  it('terminates rather than re-offering a replacement that still does not fit', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([liar()]);
    flow.AddParagraph('AFTERWARDS');
    // The liar draws nothing and is dropped; the render still completes and
    // the content after it survives.
    const text = flow.Render().map((p) => p.GetText()).join(' ');
    expect(text).toContain('AFTERWARDS');
  });

  it('terminates in placeElements too', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const res = placeElements(doc, page, [liar()], [50, 50, 400, 300]);
    expect(res.remainder).toHaveLength(1);
  });
});

describe('placeElements with over-tall content', () => {
  it('scales an image too tall for the rect, and leaves NO remainder', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = image(png(9, 16));
    const seen: string[] = [];
    els[0].onCompromise = (how) => { seen.push(how); };
    const res = placeElements(doc, page, els, [50, 50, 400, 300]);
    expect(seen).toEqual(['scaled']);
    expect(res.remainder).toHaveLength(0);
    expect(res.usedHeight).toBeLessThanOrEqual(300 + 1e-9);
  });

  it('does NOT overflow the caller’s rect for content it cannot scale', () => {
    // Decision 5: one rect has a real answer Render does not — `remainder` —
    // so an unscalable element is handed back rather than drawn outside the
    // box the caller asked for.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const res = placeElements(doc, page, paragraph('W', { fontSize: 900 }),
      [50, 50, 400, 300]);
    expect(res.remainder).toHaveLength(1);
    expect(res.usedHeight).toBe(0);
  });

  it('does NOT shrink an element that merely does not fit what is LEFT', () => {
    // The rect-level twin of Decision 2: after a paragraph has been placed,
    // the element is no longer first into the rect, so it is handed back
    // rather than squeezed into the gap.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = image(png(6, 8));
    const seen: string[] = [];
    els[0].onCompromise = (how) => { seen.push(how); };
    const res = placeElements(doc, page, [...paragraph('filler'), ...els],
      [50, 50, 400, 60]);
    expect(seen).toEqual([]);
    expect(res.remainder).toHaveLength(1);
  });
});
