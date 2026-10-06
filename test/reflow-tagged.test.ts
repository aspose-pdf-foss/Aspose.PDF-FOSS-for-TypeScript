import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';

// The linked paragraph is LAST on the page, so its growth has the page below.
const MD = 'First paragraph stays put.\n\nThe quick brown fox jumps over the lazy dog and then keeps running far away into the [woods](https://example.com) at night.';
function tagged(md = MD) {
  const d = Document.New();
  d.AddMarkdown(md, { tagged: true });
  return Document.Open(d.Save());
}
const rules = (doc: Document) => doc.ValidatePdfUa().Issues.map((i) => i.rule).sort();

describe('reflow in a tagged document (u3l5.5)', () => {
  it('reflows the /P holding the match and keeps every MCID resolving', () => {
    const doc = tagged();
    const issues0 = rules(doc);
    const firstY = doc.Pages[0].Search('First')[0].quads[0];
    doc.Pages[0].ReplaceText('quick', 'remarkably quick', { adjust: 'reflow' });
    expect(doc.Pages[0].Search('First')[0].quads[0]).toEqual(firstY);
    expect(doc.Pages[0].GetText()).toContain('remarkably quick');
    expect(rules(doc)).toEqual(issues0);
    expect(rules(doc)).not.toContain('UntaggedContent');
  });

  it('keeps the link annotation over its word', () => {
    const doc = tagged();
    doc.Pages[0].ReplaceText('quick', 'remarkably quick', { adjust: 'reflow' });
    const w = doc.Pages[0].Search('woods')[0].quads[0];
    const link = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Link')!;
    const r = link.Rect!;
    expect(w[0]).toBeGreaterThanOrEqual(r[0] - 0.01);
    expect(w[2]).toBeLessThanOrEqual(r[2] + 0.01);
  });

  it('uses the structure, not the geometry, to find the paragraph', () => {
    // A heading directly above the paragraph: by geometry the two can merge
    // into one block of uneven pitch (and refuse); by structure the /H1 is not
    // a member, so the /P reflows and the heading does not move.
    const doc = tagged('# Title\n\nThe quick brown fox jumps over the lazy dog and then keeps running far away into the woods.');
    const titleY = doc.Pages[0].Search('Title')[0].quads[0];
    expect(() => doc.Pages[0].ReplaceText('quick', 'remarkably quick', { adjust: 'reflow' })).not.toThrow();
    expect(doc.Pages[0].Search('Title')[0].quads[0]).toEqual(titleY);
  });

  it('refuses text on a tagged page that no structure element owns', () => {
    const doc = tagged();
    doc.Pages[0].AddText('stray words here', 72, 60);   // drawn untagged
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('stray', 'much longer stray', { adjust: 'reflow' })).toThrow(/not-found/);
    expect(doc.Save()).toEqual(before);
  });
});
