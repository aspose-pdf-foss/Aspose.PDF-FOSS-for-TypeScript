import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isAnnotVisible, resolveAppearance, annotFlags } from '../src/annotappearance.js';
import { isDict, PdfDict } from '../src/types.js';
import { buildFlattenTarget, buildFlattenStateTarget } from './helpers/build-flatten-target.js';
import { buildAnnotRenderTarget } from './helpers/build-annot-render-target.js';

/** The i-th entry of page 0's /Annots, resolved to a dict. */
function annotAt(doc: Document, i: number): PdfDict {
  const annots = doc.resolve(doc.Pages[0].Dict.get('Annots')) as unknown[];
  const d = doc.resolve(annots[i] as never);
  if (!isDict(d)) throw new Error(`/Annots[${i}] is not a dict`);
  return d;
}

/** An unfiltered appearance stream's raw content, as text. */
const streamText = (s: { raw: Uint8Array }) => new TextDecoder('latin1').decode(s.raw);

describe('isAnnotVisible', () => {
  it('accepts a normal printable annotation', () => {
    const doc = Document.Open(buildFlattenTarget());
    expect(isAnnotVisible(doc, annotAt(doc, 0))).toBe(true);
  });

  it('rejects a Hidden annotation (/F bit 2)', () => {
    const doc = Document.Open(buildFlattenTarget());
    expect(annotFlags(doc, annotAt(doc, 2))).toBe(2);
    expect(isAnnotVisible(doc, annotAt(doc, 2))).toBe(false);
  });

  it('rejects a NoView annotation (/F bit 6)', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    expect(annotFlags(doc, annotAt(doc, 1))).toBe(32);
    expect(isAnnotVisible(doc, annotAt(doc, 1))).toBe(false);
  });

  it('rejects a /Popup annotation even when it has a usable appearance', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    expect(isAnnotVisible(doc, annotAt(doc, 0))).toBe(false);
    // it *does* have a resolvable appearance — visibility is the only reason to skip
    expect(resolveAppearance(doc, annotAt(doc, 0))).toBeDefined();
  });

  it('treats a missing /F as 0 (visible)', () => {
    const doc = Document.Open(buildFlattenTarget());
    const a = annotAt(doc, 0);
    a.delete('F');
    expect(annotFlags(doc, a)).toBe(0);
    expect(isAnnotVisible(doc, a)).toBe(true);
  });
});

describe('resolveAppearance', () => {
  it('maps an identity-/Matrix /BBox onto /Rect', () => {
    const doc = Document.Open(buildFlattenTarget());
    const ap = resolveAppearance(doc, annotAt(doc, 0))!;
    expect(ap).toBeDefined();
    // /BBox 100x40 -> /Rect [10 20 110 60] (100x40) -> sx=sy=1, translate to origin
    expect(ap.place).toEqual([1, 0, 0, 1, 10, 20]);
  });

  it('accounts for the appearance /Matrix when computing placement', () => {
    const doc = Document.Open(buildFlattenTarget());
    const ap = resolveAppearance(doc, annotAt(doc, 1))!;
    // /BBox 50x20 scaled x2 by /Matrix -> apparent 100x40 -> /Rect 100x40 -> sx=sy=1
    expect(ap.place).toEqual([1, 0, 0, 1, 0, 100]);
  });

  it('returns the un-promoted entry and the resolved stream, without mutating', () => {
    const doc = Document.Open(buildFlattenTarget());
    const before = doc.Pages[0].Dict.get('Annots');
    const ap = resolveAppearance(doc, annotAt(doc, 0))!;
    expect(ap.entry).toEqual({ kind: 'ref', num: 5, gen: 0 });
    expect(streamText(ap.stream)).toContain('0 0 1 rg');
    expect(doc.Pages[0].Dict.get('Annots')).toBe(before);
  });

  it('selects the /N sub-state named by /AS', () => {
    const doc = Document.Open(buildFlattenStateTarget());
    const ap = resolveAppearance(doc, annotAt(doc, 0))!;
    expect(streamText(ap.stream)).toContain('0 1 0 rg');  // the /On (green) state
  });

  it('returns undefined when /AS names a state absent from the /N subdict', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    expect(resolveAppearance(doc, annotAt(doc, 2))).toBeUndefined();
  });

  it('returns undefined when the annotation has no /AP', () => {
    const doc = Document.Open(buildFlattenTarget());
    expect(resolveAppearance(doc, annotAt(doc, 3))).toBeUndefined();
  });

  it('returns undefined when the appearance stream has no /BBox', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    expect(resolveAppearance(doc, annotAt(doc, 3))).toBeUndefined();
  });

  it('returns undefined for a degenerate (zero-extent) /BBox', () => {
    const doc = Document.Open(buildFlattenTarget());
    const a = annotAt(doc, 0);
    const ap = doc.resolve(a.get('AP')) as PdfDict;
    const s = doc.resolve(ap.get('N')) as { dict: PdfDict };
    s.dict.set('BBox', [0, 0, 0, 0]);
    expect(resolveAppearance(doc, a)).toBeUndefined();
  });
});
