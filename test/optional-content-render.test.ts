import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { buildOcgRenderPdf } from './helpers/build-ocg-render-pdf.js';

/**
 * Optional content at render time (q1g2.1).
 *
 * `LayerConfig.ResolveVisibility` was already written and already correct, and
 * NOTHING consumed it: the interpreter had no `BDC`/`BMC`/`EMC` case at all, so
 * a switched-off watermark, a "do not print" overlay and a disabled CAD layer
 * were all painted.
 *
 * **The rule that is easy to get backwards:** content inside a hidden section
 * STILL RUNS. Graphics state, transforms and clips apply exactly as in a
 * viewer; only the marks are suppressed. A build that skips the ops instead
 * renders every later element against the wrong clip and CTM.
 */

/** Probe points, device space (y grows down on a 200x200 page). */
const IN_HIDDEN: [number, number] = [35, 165];      // the 10,10..60,60 rect
const IN_VISIBLE: [number, number] = [125, 65];     // the 100,100..150,150 rect

const WHITE: [number, number, number, number] = [255, 255, 255, 255];

const pixels = (bytes: Uint8Array) => {
  const png = decodePng(Document.Open(bytes).Pages[0].ToImage());
  return (p: [number, number]) => png.at(p[0], p[1]);
};

/** A hidden red block and a visible blue block, each in its own MC section. */
const TWO_LAYERS =
  '/OC /OCHid BDC 1 0 0 rg 10 10 50 50 re f EMC\n'
  + '/OC /OCVis BDC 0 0 1 rg 100 100 50 50 re f EMC\n';

describe('optional content at render time', () => {
  it('paints nothing for a hidden layer and everything for a visible one', () => {
    const at = pixels(buildOcgRenderPdf(TWO_LAYERS));
    expect(at(IN_HIDDEN)).toEqual(WHITE);
    expect(at(IN_VISIBLE)).toEqual([0, 0, 255, 255]);
  });

  it('renders a layer that the config turns back ON', () => {
    // The control that stops "suppress every marked section" from passing:
    // the SAME content with /OFF empty must paint both blocks.
    const at = pixels(buildOcgRenderPdf(TWO_LAYERS, { off: [] }));
    expect(at(IN_HIDDEN)).toEqual([255, 0, 0, 255]);
    expect(at(IN_VISIBLE)).toEqual([0, 0, 255, 255]);
  });

  it('renders identically to the same page with the layer REMOVED', () => {
    // The acceptance criterion, and the assertion a "no ink anywhere" test
    // cannot make: hiding and excising must reach the same pixels, which is
    // what says the suppression is placed where a viewer places it rather than
    // merely somewhere upstream of the ink.
    const hidden = Document.Open(buildOcgRenderPdf(TWO_LAYERS)).Pages[0].ToImage();

    const doc = Document.Open(buildOcgRenderPdf(TWO_LAYERS));
    const oc = doc.OptionalContent;
    oc.RemoveLayer(oc.GetLayer('Hidden')!);
    const removed = Document.Open(doc.Save()).Pages[0].ToImage();

    expect(Buffer.from(hidden)).toEqual(Buffer.from(removed));
  });

  it('keeps a clip set inside a hidden section, applying it to what follows', () => {
    // The rule that a "skip the ops" build breaks. `W n` inside the hidden
    // section clips to the LEFT half; the visible blue block that follows spans
    // both halves, so a build that honours the clip paints only its left part.
    const at = pixels(buildOcgRenderPdf(
      '/OC /OCHid BDC 0 0 100 200 re W n EMC\n'
      + '0 0 1 rg 50 50 100 100 re f\n',
    ));
    expect(at([75, 100])).toEqual([0, 0, 255, 255]);   // left of the clip: painted
    expect(at([125, 100])).toEqual(WHITE);             // right of it: clipped away
  });

  it('keeps a clip whose painting operator is itself hidden (W f)', () => {
    // **The case the `W n` one above cannot reach**, and the only thing that
    // covers the `flushClip()` in the hidden gate: `n` is not a painting
    // operator, so it flushes the pending clip outside `element` entirely.
    // `W f` clips AND fills, so the flush lives in the paint path — return
    // before it and this clip is silently dropped.
    // **And the `cm` is what makes it discriminate, measured the hard way.**
    // Without the flush the pending clip is not lost — the NEXT painting
    // operator flushes it — so a fixture that simply paints afterwards passes
    // either way. What it loses is the CTM: `flushClip` applies the clip under
    // whatever `gs.ctm` is current, so a transform in between lands the clip
    // 60pt to the right, and only then do the two builds differ.
    const at = pixels(buildOcgRenderPdf(
      '/OC /OCHid BDC 0 0 100 200 re W f EMC\n'
      + '1 0 0 1 60 0 cm\n'
      + '0 0 1 rg 0 50 100 100 re f\n',
    ));
    expect(at([75, 100])).toEqual([0, 0, 255, 255]);   // left of the clip: painted
    expect(at([125, 100])).toEqual(WHITE);             // right of it: clipped away
    expect(at([20, 100])).toEqual(WHITE);              // the hidden fill itself: absent
  });

  it('keeps a nested visible section hidden inside a hidden one', () => {
    // **The fill BETWEEN the two EMCs is what makes this discriminate.** The
    // stack records WHICH section hid, so the inner EMC must not decrement —
    // but with the two EMCs adjacent nothing is painted in the gap, and a build
    // that decrements on every EMC passes. That fill is still inside the outer
    // hidden section and must not appear.
    const at = pixels(buildOcgRenderPdf(
      '/OC /OCHid BDC\n'
      + '/OC /OCVis BDC 1 0 0 rg 10 10 50 50 re f EMC\n'
      + '1 0 0 rg 10 100 50 50 re f\n'
      + 'EMC\n'
      + '0 0 1 rg 100 100 50 50 re f\n',
    ));
    expect(at(IN_HIDDEN)).toEqual(WHITE);
    expect(at([35, 65])).toEqual(WHITE);               // between the EMCs: still hidden
    expect(at(IN_VISIBLE)).toEqual([0, 0, 255, 255]);  // the section really did close
  });

  it('paints no form XObject drawn inside a hidden section', () => {
    const at = pixels(buildOcgRenderPdf(
      '/OC /OCHid BDC q 1 0 0 1 10 10 cm /Fm0 Do Q EMC\n',
    ));
    expect(at([30, 170])).toEqual(WHITE);              // inside the form's 40x40
  });

  it('draws the form when the same section is visible', () => {
    const at = pixels(buildOcgRenderPdf(
      '/OC /OCVis BDC q 1 0 0 1 10 10 cm /Fm0 Do Q EMC\n',
    ));
    expect(at([30, 170])).toEqual([0, 255, 0, 255]);
  });

  it('leaves an inline-dictionary /OC operand VISIBLE rather than guessing', () => {
    // Not resolvable through /Properties, so we decline to hide it: hiding on a
    // shape we did not resolve is the one error that loses ink.
    const at = pixels(buildOcgRenderPdf(
      '/OC << /Type /OCMD >> BDC 1 0 0 rg 10 10 50 50 re f EMC\n',
    ));
    expect(at(IN_HIDDEN)).toEqual([255, 0, 0, 255]);
  });

  it('renders a document with no /OCProperties at all', () => {
    const at = pixels(buildOcgRenderPdf(TWO_LAYERS, { noOcProperties: true }));
    expect(at(IN_HIDDEN)).toEqual([255, 0, 0, 255]);
    expect(at(IN_VISIBLE)).toEqual([0, 0, 255, 255]);
  });

  it('does not modify the document it renders', () => {
    // `OptionalContent.Default` CREATES /OCProperties and marks the document
    // modified, so reaching the config through it would make rendering a WRITE.
    // A save alone cannot see that — a full rewrite of an untouched model
    // reproduces the same bytes — so this asserts the catalog directly, on a
    // document that has no /OCProperties to begin with.
    const doc = Document.Open(buildOcgRenderPdf(TWO_LAYERS, { noOcProperties: true }));
    doc.Pages[0].ToImage();
    expect(doc.catalog().has('OCProperties')).toBe(false);
  });
});
