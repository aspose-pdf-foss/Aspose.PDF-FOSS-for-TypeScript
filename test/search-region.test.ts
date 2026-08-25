import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { Rect } from '../src/text.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

/** Two occurrences of "secret" on one 300x300 page: one high, one low. */
const twoSecrets = () => buildSimpleTextPdf(
  'BT /F1 10 Tf 20 250 Td (secret) Tj ET BT /F1 10 Tf 20 50 Td (secret) Tj ET',
);

const pageOf = (bytes: Uint8Array) => Document.Open(bytes).Pages[0];

const TOP: Rect = [0, 200, 300, 300];

describe('searchText region scoping', () => {
  it('finds both occurrences with no region', () => {
    expect(pageOf(twoSecrets()).Search('secret')).toHaveLength(2);
  });

  it('finds only the occurrence inside the region', () => {
    const hits = pageOf(twoSecrets()).Search('secret', { region: TOP });
    expect(hits).toHaveLength(1);
    // The surviving match is the high one.
    expect(hits[0].quads[0][1]).toBeGreaterThan(200);
  });

  it('returns [] for a region covering no text', () => {
    expect(pageOf(twoSecrets()).Search('secret', { region: [0, 120, 300, 180] })).toHaveLength(0);
  });

  it('omitting region gives exactly the unscoped result', () => {
    // Compared on text and geometry, not by deep-equality of the whole match:
    // `hits` carry TextFont instances that visitContent builds fresh per call,
    // so two identical searches are never deep-equal.
    const page = pageOf(twoSecrets());
    const shape = (find: string) => page.Search(find, {}).map((m) => [m.text, m.quads]);
    expect(shape('secret')).toEqual(page.Search('secret').map((m) => [m.text, m.quads]));
  });

  it('scopes a RegExp too', () => {
    expect(pageOf(twoSecrets()).Search(/s.cret/, { region: TOP })).toHaveLength(1);
  });

  it('decides a straddling glyph by its CENTROID, not by overlap', () => {
    // One 10pt run on baseline 200, so its quad spans y 200..210 and its
    // glyphs' centroids sit at y=205. A region starting at 206 overlaps the
    // quad but excludes the centroid; an intersection rule would include it.
    const page = pageOf(buildSimpleTextPdf('BT /F1 10 Tf 20 200 Td (edge) Tj ET'));
    expect(page.Search('edge', { region: [0, 206, 300, 300] })).toHaveLength(0);
    expect(page.Search('edge', { region: [0, 204, 300, 300] })).toHaveLength(1);
  });

  it('does NOT find a match straddling the region boundary', () => {
    // Filtering happens before line assembly, so a region that cuts through a
    // word leaves only the glyphs inside it and the whole word is no longer
    // present to match. This is correct, and it is the behaviour someone will
    // later mistake for a bug — hence asserted rather than left implicit.
    const page = pageOf(buildSimpleTextPdf('BT /F1 10 Tf 20 250 Td (secret) Tj ET'));
    const cut: Rect = [0, 200, 35, 300];        // keeps roughly "sec"
    expect(page.Search('secret', { region: cut })).toHaveLength(0);
    // Proof the glyphs were not simply all excluded: the prefix IS found.
    expect(page.Search('sec', { region: cut })).toHaveLength(1);
  });
});

describe('region scoping through the consumers', () => {
  it('RedactText redacts only the in-region occurrence', () => {
    const doc = Document.Open(twoSecrets());
    const n = doc.Pages[0].RedactText('secret', { region: TOP });
    expect(n).toBe(1);
    // The out-of-region occurrence survives; the redacted one is gone.
    const after = Document.Open(doc.Save()).Pages[0].GetText();
    expect(after.match(/secret/g) ?? []).toHaveLength(1);
  });

  it('MarkRedactText marks only the in-region occurrence', () => {
    const doc = Document.Open(twoSecrets());
    expect(doc.Pages[0].MarkRedactText('secret', { region: TOP })).toBe(1);
    const marks = doc.Pages[0].Annotations.filter((a) => a.Subtype === 'Redact');
    expect(marks).toHaveLength(1);
  });

  it('ReplaceText replaces only the in-region occurrence', () => {
    const doc = Document.Open(twoSecrets());
    expect(doc.Pages[0].ReplaceText('secret', 'public', { region: TOP })).toBe(1);
    const after = Document.Open(doc.Save()).Pages[0].GetText();
    expect(after).toContain('public');
    expect(after.match(/secret/g) ?? []).toHaveLength(1);
  });

  it('leaves the consumers unchanged when no region is given', () => {
    const doc = Document.Open(twoSecrets());
    expect(doc.Pages[0].RedactText('secret')).toBe(2);
  });
});
