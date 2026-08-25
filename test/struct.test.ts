import { describe, it, expect } from 'vitest';
import { Document, visitContent, StructTreeRoot, StructElement } from '../src/index.js';
import type { GlyphEvent } from '../src/index.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';

describe('tagged-pdf fixture', () => {
  it('opens and exposes one page', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(doc.Pages.length).toBe(1);
  });
});

describe('marked-content MCID tracking', () => {
  it('tags glyphs with their enclosing MCID', () => {
    const doc = Document.Open(buildTaggedPdf());
    const page = doc.Pages[0];
    const byMcid = new Map<number | undefined, string>();
    visitContent(doc, page, {
      glyph: (e: GlyphEvent) => {
        byMcid.set(e.mcid, (byMcid.get(e.mcid) ?? '') + e.text);
      },
    });
    expect(byMcid.get(0)).toBe('Hello Heading');
    expect(byMcid.get(1)).toBe('Body paragraph');
  });
});

describe('struct tree navigation', () => {
  it('reports tagged + document language', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(doc.IsTagged).toBe(true);
    expect(doc.Lang).toBe('en-US');
  });

  it('returns null for an untagged document', () => {
    const doc = Document.Open(buildFormPdf());
    expect(doc.GetStructTree()).toBeNull();
    expect(doc.IsTagged).toBe(false);
  });

  it('walks the element tree, excluding content items from Children', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    expect(tree).toBeInstanceOf(StructTreeRoot);
    expect(tree.Children.length).toBe(1);
    const docElem = tree.Children[0];
    expect(docElem.Type).toBe('Document');
    expect(docElem.Children.map((c) => c.Type)).toEqual(['MyHead', 'P', 'Figure']);
    expect(docElem.Children[0]).toBeInstanceOf(StructElement);
    // Figure's only /K entry is an OBJR, not a struct element.
    expect(docElem.Children[2].Children.length).toBe(0);
    // Parent navigation.
    expect(docElem.Children[0].Parent?.Type).toBe('Document');
  });
});

describe('role map resolution', () => {
  it('resolves a custom role through a chain to a standard type', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const h = tree.Children[0].Children[0]; // S = MyHead
    expect(h.Type).toBe('MyHead');
    expect(h.StandardType).toBe('H2'); // MyHead -> SubHead -> H2
    expect(h.IsStandardType).toBe(true);
  });

  it('passes a standard type through unchanged', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const p = tree.Children[0].Children[1];
    expect(p.StandardType).toBe('P');
  });

  it('terminates on a cyclic role map', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    expect(tree.ResolveRole('Loop1')).toBe('Loop1'); // Loop1<->Loop2 cycle, guarded
  });
});

describe('element metadata + content items', () => {
  it('reads title, alt, actual text, and language inheritance', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const [h, p, fig] = tree.Children[0].Children;
    expect(h.Title).toBe('Heading One');
    expect(h.Lang).toBe('en-GB');
    expect(h.EffectiveLang).toBe('en-GB');
    expect(p.Lang).toBeUndefined();
    expect(p.EffectiveLang).toBe('en-US');   // inherited from catalog /Lang
    expect(p.ActualText).toBe('Body paragraph actual');
    expect(fig.Alt).toBe('A descriptive figure');
  });

  it('associates elements with their page', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const h = tree.Children[0].Children[0];
    expect(h.Page?.Number).toBe(1);
  });

  it('exposes content items (mcid + objr)', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const [h, , fig] = tree.Children[0].Children;
    expect(h.ContentItems).toEqual([{ kind: 'mcid', page: h.Page, mcid: 0 }]);
    const objr = fig.ContentItems[0];
    expect(objr.kind).toBe('objr');
  });

  it('looks up elements through the ParentTree', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    expect(tree.ElementFor(0, 0)?.Type).toBe('MyHead');
    expect(tree.ElementFor(0, 1)?.Type).toBe('P');
    expect(tree.ElementForObject(1)?.Type).toBe('Figure');
  });
});

describe('reading-order text', () => {
  it('extracts text per element from its MCIDs', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    const [h, p] = tree.Children[0].Children;
    expect(h.GetText()).toBe('Hello Heading');
    expect(p.GetText()).toBe('Body paragraph');
  });

  it('walks the whole tree in reading order', () => {
    const tree = Document.Open(buildTaggedPdf()).GetStructTree()!;
    expect(tree.GetText()).toBe('Hello Heading\nBody paragraph');
  });
});

describe('GetBBox glyph-union', () => {
  it('GetBBox unions the glyph quads behind an element', () => {
    const doc = Document.Open(buildTaggedPdf());
    const root = doc.GetStructTree()!;
    const docElem = root.Children[0];         // Document
    const heading = docElem.Children[0];      // H1 (MyHead), /K 0
    const bbox = heading.GetBBox();
    expect(bbox).toBeDefined();
    const [x0, y0, x1, y1] = bbox!;
    expect(x0).toBeCloseTo(50, 0);            // Td x origin
    expect(y0).toBeGreaterThan(340);          // baseline ~350
    expect(x1).toBeGreaterThan(x0);           // non-empty width
    expect(y1).toBeGreaterThan(y0);           // non-empty height
  });

  it('GetBBox returns undefined for an element with no glyphs', () => {
    const doc = Document.Open(buildTaggedPdf());
    const root = doc.GetStructTree()!;
    const figure = root.Children[0].Children[2];   // Figure: OBJR only, no glyphs
    expect(figure.GetBBox()).toBeUndefined();
  });
});

describe('GetText skip predicate', () => {
  it('omits the subtree of any element for which the predicate returns true', () => {
    const doc = Document.Open(buildTaggedPdf());
    const docElem = doc.GetStructTree()!.Children[0];   // Document → [H1, P, Figure]
    expect(docElem.GetText()).toBe('Hello Heading\nBody paragraph');
    expect(docElem.GetText((e) => e.StandardType === 'P')).toBe('Hello Heading');
  });
});

describe('public exports', () => {
  it('exposes the structure types from the package root', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.StructTreeRoot).toBe('function');
    expect(typeof mod.StructElement).toBe('function');
  });
});

describe('StructElement.Nodes', () => {
  it('returns child elements and text runs in /K order, with each text run\'s page', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const root = doc.GetStructTree()!;
    const document = root.Children[0];          // Document (obj 8)
    const sect = document.Children[0];          // Sect (obj 13), spans both pages
    const nodes = sect.Nodes;
    expect(nodes).toHaveLength(2);              // P on page 1, P on page 2
    expect(nodes.every((n) => n instanceof StructElement)).toBe(true);

    const p1 = sect.Children[0];
    const textNodes = p1.Nodes;
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0]).toMatchObject({ kind: 'text', text: 'Page one body' });
    expect((textNodes[0] as { page: unknown }).page).toBe(doc.Pages[0]);
  });

  it('skips OBJR kids', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const root = doc.GetStructTree()!;
    const figure = root.Children[0].Children[1]; // Figure (obj 14), /K is an OBJR
    expect(figure.Nodes).toEqual([]);
  });
});
