import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildInheritedPgPdf } from './helpers/build-inherited-pg-pdf.js';

/** A Sect holding H1 "AAA" then P "bbb", both tagged, on one page.
 *
 *  `AddText(text, x, y, opts)` takes POSITIONAL coordinates — it is not an
 *  options-object API (`test/struct-write.test.ts:121`). */
function twoKids() {
  const doc = Document.Open(buildStampTarget());
  doc.Lang = 'en-US';
  const page = doc.Pages[0];
  const root = doc.CreateStructTree();
  const sect = root.Append('Sect');
  const h = sect.Append('H1');
  const p = sect.Append('P');
  page.AddText('AAA', 72, 700, { tag: h });
  page.AddText('bbb', 72, 600, { tag: p });
  return { doc, page, root, sect, h, p };
}

describe('StructElement.MoveTo: mechanics', () => {
  it('moves a child to a new parent and updates /P', () => {
    const { doc, root, sect, p } = twoKids();
    const other = root.Append('Sect');

    p.MoveTo(other);

    expect(sect.Children.map((c) => c.Type)).toEqual(['H1']);
    expect(other.Children.map((c) => c.Type)).toEqual(['P']);
    // /P must follow, or Parent and the real container disagree.
    expect(doc.GetStructTree()!.Children[1].Children[0].Parent!.Dict)
      .toBe(other.Dict);
  });

  it('inserts at the given index among element children', () => {
    const { root, h } = twoKids();
    const other = root.Append('Sect');
    const x = other.Append('Span');
    const y = other.Append('Span');
    x.SetType('Code');    // tell the two apart
    y.SetType('Quote');

    h.MoveTo(other, 1);
    expect(other.Children.map((c) => c.Type)).toEqual(['Code', 'H1', 'Quote']);
  });

  it('appends when no index is given', () => {
    const { root, h } = twoKids();
    const other = root.Append('Sect');
    other.Append('Span');
    h.MoveTo(other);
    expect(other.Children.map((c) => c.Type)).toEqual(['Span', 'H1']);
  });

  it('moves to the tree root', () => {
    const { doc, root, sect, p } = twoKids();
    p.MoveTo(root, 0);
    expect(root.Children.map((c) => c.Type)).toEqual(['P', 'Sect']);
    expect(sect.Children.map((c) => c.Type)).toEqual(['H1']);
    // Round-trips.
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['P', 'Sect']);
  });

  it('reorders within the same parent', () => {
    const { sect, p } = twoKids();
    expect(sect.Children.map((c) => c.Type)).toEqual(['H1', 'P']);
    p.MoveTo(sect, 0);
    expect(sect.Children.map((c) => c.Type)).toEqual(['P', 'H1']);
  });

  it('leaves the /ParentTree resolving every MCID', () => {
    const { doc, root, p } = twoKids();
    const before = [root.ElementFor(0, 0)!.Type, root.ElementFor(0, 1)!.Type];
    expect(before).toEqual(['H1', 'P']);

    p.MoveTo(root, 0);

    const re = doc.GetStructTree()!;
    expect([re.ElementFor(0, 0)!.Type, re.ElementFor(0, 1)!.Type]).toEqual(['H1', 'P']);
  });
});

describe('StructElement.MoveTo: what order actually changes', () => {
  // MEASURED, and the issue's acceptance criterion says otherwise:
  // `extractStructured` sorts fragments by baseline and x and never touches the
  // structure tree, so a move provably cannot reorder GetStructuredText.
  // Asserted BOTH ways so the correction reads as a decision.
  it('changes GetText and ToMarkdown, and NOT GetStructuredText', () => {
    const { doc, page, sect, p } = twoKids();
    expect(sect.GetText()).toBe('AAA\nbbb');
    expect(doc.ToMarkdown()).toBe('# AAA\n\nbbb\n');
    const geometric = page.GetStructuredText().map((b) => b.text);

    p.MoveTo(sect, 0);

    expect(sect.GetText()).toBe('bbb\nAAA');
    expect(doc.ToMarkdown()).toBe('bbb\n\n# AAA\n');
    expect(page.GetStructuredText().map((b) => b.text)).toEqual(geometric);
  });
});

describe('StructElement.MoveTo: refusals', () => {
  it('refuses a move into the element itself', () => {
    const { sect } = twoKids();
    expect(() => sect.MoveTo(sect)).toThrow(RangeError);
  });

  // The one that matters: a cycle makes the tree unwalkable, so every consumer
  // that recurses would hang rather than report anything.
  it('refuses a move into its own descendant, and writes nothing', () => {
    const { doc, sect, h } = twoKids();
    const before = doc.Save();
    expect(() => sect.MoveTo(h)).toThrow(RangeError);
    expect(Buffer.from(doc.Save())).toEqual(Buffer.from(before));
    // The tree is intact: sect still holds both kids.
    expect(sect.Children.map((c) => c.Type)).toEqual(['H1', 'P']);
  });

  it('refuses a destination in another document', () => {
    const { p } = twoKids();
    const otherDoc = Document.Open(buildStampTarget());
    const otherRoot = otherDoc.CreateStructTree();
    expect(() => p.MoveTo(otherRoot)).toThrow(RangeError);
  });

  it('refuses an out-of-range index', () => {
    const { root, p } = twoKids();
    const other = root.Append('Sect');
    expect(() => p.MoveTo(other, 1)).toThrow(RangeError);   // empty: only 0 is valid
    expect(() => p.MoveTo(other, -1)).toThrow(RangeError);
  });

  it('refuses a non-integer index', () => {
    const { root, p } = twoKids();
    expect(() => p.MoveTo(root, 1.5)).toThrow(TypeError);
  });
});

describe('StructElement.MoveTo: an inherited /Pg', () => {
  // MEASURED, and it is the issue's own safety claim made true: "the element
  // keeps its content items and its /Pg" holds only when it HAS one.
  // StructElement.Page walks UP, and ContentItems resolves a bare-integer MCID
  // against that inherited page — so without materialization this move silently
  // re-points the MCID to page 2 while the /ParentTree still maps it under
  // page 1's key.
  it('keeps the MCID on its original page when moved across pages', () => {
    const doc = Document.Open(buildInheritedPgPdf());
    const root = doc.GetStructTree()!;
    const [sect, other] = root.Children;
    const p = sect.Children[0];

    expect(p.Dict.has('Pg')).toBe(false);          // inherits it
    expect(p.Page!.Number).toBe(1);
    expect(p.ContentItems[0].page!.Number).toBe(1);

    p.MoveTo(other);

    expect(p.Page!.Number).toBe(1);                 // unchanged
    expect(p.ContentItems[0].page!.Number).toBe(1);
    // The /ParentTree still resolves it, under page 1's key.
    expect(root.ElementFor(0, 0)!.Type).toBe('P');
  });

  it('materializes /Pg onto the element', () => {
    const doc = Document.Open(buildInheritedPgPdf());
    const root = doc.GetStructTree()!;
    const [sect, other] = root.Children;
    const p = sect.Children[0];
    p.MoveTo(other);
    expect(p.Dict.has('Pg')).toBe(true);
  });

  // An element with no bare-integer kids has nothing to protect, so it gets no
  // /Pg. Without the guard the move would write one onto every element it
  // touched, changing documents that did not need changing.
  //
  // The element that reaches the guard is the SPAN inside `other`: it has no
  // /Pg of its own AND no bare-integer kid. `other` itself never gets there —
  // it owns a /Pg, so the earlier has('Pg') test skips it first.
  it('leaves an element with no bare-integer kids alone', () => {
    const doc = Document.Open(buildInheritedPgPdf());
    const root = doc.GetStructTree()!;
    const [sect, other] = root.Children;
    const span = other.Children[0];
    expect(span.Type).toBe('Span');
    expect(span.Dict.has('Pg')).toBe(false);

    other.MoveTo(sect);

    expect(span.Dict.has('Pg')).toBe(false);        // still nothing to protect
    expect(other.Dict.has('Pg')).toBe(true);        // its own, untouched
  });
});

describe('StructElement.ReorderChildren', () => {
  it('permutes the element children', () => {
    const { sect, h, p } = twoKids();
    sect.ReorderChildren([p, h]);
    expect(sect.Children.map((c) => c.Type)).toEqual(['P', 'H1']);
    expect(sect.GetText()).toBe('bbb\nAAA');
  });

  // /K interleaves element kids with content-item kids. A /P carrying its own
  // text beside a /Link child is the everyday inline shape, and its text must
  // not move relative to anything — only the elements permute, in the slots
  // they already occupy.
  it('leaves content-item kids at their original indices', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const para = root.Append('P');
    // INTERLEAVED, and that is load-bearing: the parent's own MCID must sit
    // BETWEEN the two element kids. Appended last it stays at the same index
    // under a build that rebuilds /K as "elements first, content items after",
    // and the case measures nothing.
    const a = para.Append('Span');
    para.NextMcid(page);
    const b = para.Append('Span');
    a.SetType('Code');
    b.SetType('Quote');

    /** Index of the sole bare-integer kid in /K. */
    const mcidSlot = (): number => {
      const k = doc.resolve(para.Dict.get('K'));
      return (k as unknown[]).findIndex((x) => typeof doc.resolve(x as never) === 'number');
    };

    const before = mcidSlot();
    expect(before).toBe(1);          // between the two Spans

    para.ReorderChildren([b, a]);

    expect(mcidSlot()).toBe(before);
    expect(para.Children.map((c) => c.Type)).toEqual(['Quote', 'Code']);
  });

  it('refuses an order that is not exactly this element\'s children', () => {
    const { root, sect, h, p } = twoKids();
    const stranger = root.Append('Span');
    expect(() => sect.ReorderChildren([h])).toThrow(RangeError);          // too few
    expect(() => sect.ReorderChildren([h, p, h])).toThrow(RangeError);    // too many
    expect(() => sect.ReorderChildren([h, h])).toThrow(RangeError);       // duplicate
    expect(() => sect.ReorderChildren([h, stranger])).toThrow(RangeError); // not a child
  });

  it('writes nothing when it refuses', () => {
    const { doc, sect, h } = twoKids();
    const before = doc.Save();
    expect(() => sect.ReorderChildren([h])).toThrow(RangeError);
    expect(Buffer.from(doc.Save())).toEqual(Buffer.from(before));
  });

  it('accepts the current order as a no-op', () => {
    const { sect, h, p } = twoKids();
    sect.ReorderChildren([h, p]);
    expect(sect.Children.map((c) => c.Type)).toEqual(['H1', 'P']);
  });
});
