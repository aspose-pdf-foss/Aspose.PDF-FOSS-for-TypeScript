import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { StructElement } from '../src/struct.js';

describe('link marked content', () => {
  it('wraps a linked run in its own /Span BDC ... EMC', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const root = doc.CreateStructTree();
    const p = root.Append('P');
    page.AddTextBlock(
      [{ text: 'go to ' }, { text: 'the site', link: 'https://example.com' }],
      [50, 500, 300, 200], { tag: p },
    );
    const body = Buffer.from(doc.Save()).toString('latin1');
    // The paragraph's own sequence, and a nested one for the link.
    expect(body).toContain('/P <</MCID 0>> BDC');
    expect(body).toContain('/Span <</MCID 1>> BDC');
  });

  // The load-bearing one. Measured, not assumed: dropping the `link !==
  // undefined` half of the guard in stamp.ts leaves BOTH the rich-runs-identity
  // hashes and the untagged cases below green — every one of them is untagged,
  // so nothing they emit can see a tagged-only leak. This case is the only
  // thing in the suite that goes red.
  it('emits no /Span when no run carries a link', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const root = doc.CreateStructTree();
    const p = root.Append('P');
    page.AddTextBlock([{ text: 'plain' }, { text: 'bold' }], [50, 500, 300, 200], { tag: p });
    const body = Buffer.from(doc.Save()).toString('latin1');
    expect(body).not.toContain('/Span');
  });

  it('emits no /Span for a linked run in an UNTAGGED block', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(
      [{ text: 'the site', link: 'https://example.com' }], [50, 500, 300, 200],
    );
    const body = Buffer.from(doc.Save()).toString('latin1');
    expect(body).not.toContain('BDC');
    // The annotation is still placed.
    expect(page.Annotations.filter((a) => a.Subtype === 'Link').length).toBe(1);
  });
});

/** Collect every element of `type` in the tree. The tree is cyclic (kids link
 *  back to parents), so it must be walked rather than serialized. */
const collect = (doc: Document, type: string): StructElement[] => {
  const out: StructElement[] = [];
  const walk = (e: StructElement): void => {
    if (e.Type === type) out.push(e);
    for (const k of e.Children) walk(k);
  };
  for (const k of doc.GetStructTree()!.Children) walk(k);
  return out;
};

describe('/Link structure', () => {
  it('creates a /Link under the tagged element, holding the annotation', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const p = doc.CreateStructTree().Append('P');
    page.AddTextBlock(
      [{ text: 'go to ' }, { text: 'the site', link: 'https://example.com' }],
      [50, 500, 300, 200], { tag: p },
    );
    const links = collect(doc, 'Link');
    expect(links.length).toBe(1);
    // The annotation is named by an /OBJR under the /Link.
    const annot = page.Annotations.filter((a) => a.Subtype === 'Link')[0];
    expect(annot.Dict.get('StructParent')).toBeDefined();
  });

  it('gives a wrapped link ONE /Link element with several MCIDs', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const p = doc.CreateStructTree().Append('P');
    page.AddTextBlock(
      [{ text: 'lead in ' },
       { text: 'a very long link label that must wrap across two lines here',
         link: 'https://example.com' }],
      [50, 300, 120, 300], { fontSize: 12, tag: p },
    );
    // Several rects; one element per rect would be WRONG — the run is one link.
    expect(page.Annotations.filter((a) => a.Subtype === 'Link').length).toBeGreaterThan(1);
    expect(collect(doc, 'Link').length).toBe(1);
  });

  it('creates no /Link element for an untagged block', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock([{ text: 'x', link: 'https://example.com' }], [50, 500, 300, 200]);
    expect(doc.GetStructTree()).toBeNull();
  });
});
