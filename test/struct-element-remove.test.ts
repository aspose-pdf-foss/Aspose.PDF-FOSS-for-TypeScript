import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isArray, isStream } from '../src/types.js';
import { EditableContent } from '../src/editcontent.js';
import { inflateStream } from '../src/flate.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildAnnotTarget } from './helpers/build-annot-target.js';
import { buildDanglingMcidPdf } from './helpers/build-dangling-mcid-pdf.js';

/** The operator sequence of EVERY content stream of page 0, concatenated.
 *
 *  Not just stream 0: `AddText` and `PageGraphics.apply()` each splice a FRESH
 *  stream onto /Contents, so a fixture built through the authoring API puts its
 *  marked content in a later one. 32000-1 7.8.2 makes the division between a
 *  page's streams arbitrary anyway. */
function ops(doc: Document): string[] {
  const ec = new EditableContent(doc, doc.Pages[0]);
  const out: string[] = [];
  for (let i = 0; i < ec.streamCount; i++) out.push(...ec.topOps(i).map((o) => o.operator));
  return out;
}

/** The decoded text of page 0's content streams. */
function pageText(doc: Document): string {
  const c = doc.resolve(doc.Pages[0].Dict.get('Contents'));
  const entries = isStream(c) ? [c] : (Array.isArray(c) ? c.map((e) => doc.resolve(e)) : []);
  return entries.filter(isStream)
    .map((s) => new TextDecoder().decode(inflateStream(s))).join('\n');
}

describe('StructElement.Remove: the object graph', () => {
  it('detaches from the root /K and reports one element', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const el = root.Append('P');
    expect(root.Children).toHaveLength(1);

    const r = el.Remove();
    expect(r.elements).toBe(1);
    expect(doc.GetStructTree()!.Children).toHaveLength(0);
  });

  it('detaches from a parent element /K', () => {
    const doc = Document.Open(buildStampTarget());
    const sect = doc.CreateStructTree().Append('Sect');
    const p = sect.Append('P');
    sect.Append('P');
    expect(sect.Children).toHaveLength(2);

    p.Remove();
    expect(sect.Children).toHaveLength(1);
  });

  it('removes the whole subtree and counts every element', () => {
    const doc = Document.Open(buildStampTarget());
    const sect = doc.CreateStructTree().Append('Sect');
    const p = sect.Append('P');
    p.Append('Span');
    p.Append('Span');

    expect(sect.Remove().elements).toBe(4);   // Sect + P + 2 Spans
    expect(doc.GetStructTree()!.Children).toHaveLength(0);
  });

  it('releases the /ParentTree slot so ElementFor stops resolving', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const el = root.Append('P');
    const mcid = el.MarkContent(page, [0, 0, 1000, 1000]);
    expect(mcid).toBe(0);
    expect(root.ElementFor(0, mcid)).toBeDefined();

    expect(el.Remove().mcids).toBe(1);
    expect(doc.GetStructTree()!.ElementFor(0, mcid)).toBeUndefined();
  });

  it('survives a save and reopen', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const el = root.Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);
    el.Remove();

    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.Children).toHaveLength(0);
    expect(re.GetStructTree()!.ElementFor(0, 0)).toBeUndefined();
  });

  // Removing the same element twice must be a no-op, not a throw: after the
  // first call it is in no /K and there is nothing left to find.
  it('is idempotent', () => {
    const doc = Document.Open(buildStampTarget());
    const el = doc.CreateStructTree().Append('P');
    expect(el.Remove().elements).toBe(1);
    expect(el.Remove()).toEqual({ elements: 0, mcids: 0, annotations: 0, unreachable: 0 });
  });
});

describe('StructElement.Remove: annotations survive', () => {
  it('unwires an OBJR but keeps the annotation in /Annots', () => {
    const doc = Document.Open(buildAnnotTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const link = root.Append('Link');
    const annot = page.AddLink({
      rect: [72, 700, 200, 720],
      action: { type: 'uri', uri: 'https://example.com' },
    });
    link.AddAnnotation(annot);
    expect(annot.Dict.has('StructParent')).toBe(true);

    const r = link.Remove();
    expect(r.annotations).toBe(1);

    // The annotation itself is untouched apart from losing its /StructParent.
    expect(annot.Dict.has('StructParent')).toBe(false);
    const annots = doc.resolve(page.Dict.get('Annots'));
    expect(isArray(annots) && annots.some((a) => doc.resolve(a) === annot.Dict)).toBe(true);
  });
});

describe('StructElement.Remove: untagging the content', () => {
  // The acceptance criterion "the page renders identically". A RENDER
  // comparison cannot check it — dropping the ink between BDC and EMC still
  // renders something. The op list is what can.
  it('deletes exactly the BDC and EMC, keeping every op between them', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const el = root.Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);

    const before = ops(doc);
    expect(before).toContain('BDC');
    expect(before).toContain('EMC');

    el.Remove();

    const after = ops(doc);
    const expected = before.filter((o) => o !== 'BDC' && o !== 'EMC');
    expect(after).toEqual(expected);
    // Ink survives.
    expect(pageText(doc)).toContain('Tj');
  });

  it('leaves no MCID behind, so the content is genuinely untagged', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);
    el.Remove();
    expect(pageText(doc)).not.toContain('MCID');
  });
});

describe('StructElement.Remove: cases a one-element page cannot see', () => {
  /** A page with TWO marked sequences, SIDE BY SIDE in ONE content stream,
   *  each under its own element.
   *
   *  Built through `PageGraphics` rather than `MarkContent`, and that is
   *  load-bearing: `AddText` splices a FRESH content stream per call, so two
   *  `MarkContent` calls land in two different streams and the shared-stream
   *  rule this fixture exists for is never exercised. One `apply()` emits one
   *  stream holding both sequences. */
  function twoSequences() {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const a = root.Append('P');
    const b = root.Append('P');
    const ma = a.NextMcid(page);
    const mb = b.NextMcid(page);
    page.Graphics()
      .BeginMarkedContent('P', ma)
      .setFillColor([0, 0, 0]).rect(10, 700, 20, 20).fill()
      .EndMarkedContent()
      .BeginMarkedContent('P', mb)
      .setFillColor([1, 0, 0]).rect(10, 600, 20, 20).fill()
      .EndMarkedContent()
      .apply();
    return { doc, page, root, a, b, ma, mb };
  }

  // Task 2's release could not tell nulling a slot from splicing the page's
  // whole pair, because one element on a page makes them identical. With two,
  // splicing the pair takes the SURVIVOR's mapping with it.
  it('releases one slot without disturbing the other element on the page', () => {
    const { doc, root, a, ma, mb } = twoSequences();
    expect(ma).toBeGreaterThanOrEqual(0);
    expect(mb).toBeGreaterThanOrEqual(0);
    expect(mb).not.toBe(ma);

    a.Remove();

    const re = doc.GetStructTree()!;
    expect(re.ElementFor(0, ma)).toBeUndefined();
    expect(re.ElementFor(0, mb)).toBeDefined();     // the survivor still resolves
    expect(root.Children).toHaveLength(1);
  });

  // Ascending deletion shifts the second pair's indices and takes the wrong
  // ops. The surviving sequence must still be balanced and still carry its own
  // MCID.
  it('deletes the right pair when two sequences share a stream', () => {
    const { doc, a, mb } = twoSequences();
    a.Remove();

    const seq = ops(doc);
    expect(seq.filter((o) => o === 'BDC')).toHaveLength(1);
    expect(seq.filter((o) => o === 'EMC')).toHaveLength(1);
    expect(seq.indexOf('BDC')).toBeLessThan(seq.indexOf('EMC'));
    expect(pageText(doc)).toContain(`/MCID ${mb}`);
  });

  // A child's BDC nests INSIDE its parent's, so the first EMC after the
  // parent's BDC is the CHILD's. Taking it leaves the parent unterminated.
  //
  // MEASURED, and the obvious fixture cannot see this: with the two EMCs
  // ADJACENT, a first-EMC build pairs both sequences with the child's index
  // and then deletes that index twice — which removes the parent's EMC as
  // collateral and produces exactly the right answer by luck. The third fill,
  // sitting BETWEEN the child's EMC and the parent's, is what makes the second
  // delete land on ink instead: the mutation then loses a fill and strands an
  // EMC. Without it the case passes whatever the pairing does.
  it('pairs a nested sequence with its own EMC', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const root = doc.CreateStructTree();
    const parent = root.Append('P');
    const child = parent.Append('Span');
    const mp = parent.NextMcid(page);
    const mc = child.NextMcid(page);
    page.Graphics()
      .BeginMarkedContent('P', mp)
      .setFillColor([0, 0, 0]).rect(10, 10, 20, 20).fill()
      .BeginMarkedContent('Span', mc)
      .setFillColor([1, 0, 0]).rect(40, 10, 20, 20).fill()
      .EndMarkedContent()
      .setFillColor([0, 0, 1]).rect(70, 10, 20, 20).fill()   // between the EMCs
      .EndMarkedContent()
      .apply();

    expect(parent.Remove().elements).toBe(2);

    const seq = ops(doc);
    expect(seq).not.toContain('BDC');
    expect(seq).not.toContain('EMC');
    // All three fills survive: no ink was deleted.
    expect(seq.filter((o) => o === 'f')).toHaveLength(3);
  });
});

const untagged = (doc: Document): boolean =>
  doc.ValidatePdfUa().Issues.some((i) => i.rule === 'UntaggedContent');

describe('UntaggedContent sees an MCID that resolves to nothing', () => {
  // MEASURED: the rule tested `e.mcid === undefined`, so content whose BDC is
  // still in the stream read as tagged however broken the mapping. Widening it
  // reddens NOTHING in the pre-existing suite, because every MCID this library
  // authors resolves — which is exactly why this hand-built fixture exists.
  it('reports a dangling MCID', () => {
    expect(untagged(Document.Open(buildDanglingMcidPdf(true)))).toBe(true);
  });

  // The control. Without it the case above passes for a build that reports
  // every tagged page.
  it('stays silent when the same page is wired correctly', () => {
    expect(untagged(Document.Open(buildDanglingMcidPdf(false)))).toBe(false);
  });

  it('reports the page a removed element left behind', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Lang = 'en-US';
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);
    expect(untagged(doc)).toBe(false);
    el.Remove();
    expect(untagged(doc)).toBe(true);
  });
});
