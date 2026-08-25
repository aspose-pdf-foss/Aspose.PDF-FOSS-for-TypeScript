import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import type { StructElement } from '../src/struct.js';
import { TocTagger } from '../src/tocstruct.js';
import { measureTOC } from '../src/toc.js';
import { visitContent } from '../src/text.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

/** A letter-size document with `n` pages; page 1 is the TOC page. */
function docWith(n: number): Document {
  const doc = Document.Open(buildBlankPage());
  while (doc.Pages.length < n) doc.AddPage();
  return doc;
}

/** Structure types of an element's child elements, in order. */
const childTypes = (e: StructElement): string[] => e.Children.map((c) => c.Type);

describe('TocTagger — subtree shape', () => {
  it('builds TOCI > Reference > Link per row under one /TOC', () => {
    const doc = docWith(3);
    const t = new TocTagger(doc, { links: true });
    const a = t.beginRow(1);
    const b = t.beginRow(1);
    expect(a.Type).toBe('Link');
    expect(b.Type).toBe('Link');
    expect(t.toc.Type).toBe('TOC');
    expect(childTypes(t.toc)).toEqual(['TOCI', 'TOCI']);
    expect(childTypes(t.toc.Children[0])).toEqual(['Reference']);
    expect(childTypes(t.toc.Children[0].Children[0])).toEqual(['Link']);
  });

  it('omits the /Link when links are off', () => {
    const doc = docWith(3);
    const t = new TocTagger(doc, { links: false });
    const content = t.beginRow(1);
    expect(content.Type).toBe('Reference');
    expect(childTypes(t.toc.Children[0])).toEqual(['Reference']);
    expect(childTypes(content)).toEqual([]);
  });

  it('attaches the /TOC at the struct tree root by default', () => {
    const doc = docWith(2);
    const t = new TocTagger(doc, { links: true });
    t.beginRow(1);
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['TOC']);
    expect(t.toc.Parent).toBeUndefined();   // its parent IS the root
  });

  it('attaches under a caller-supplied structParent', () => {
    const doc = docWith(2);
    const sect = doc.CreateStructTree().Append('Sect');
    const t = new TocTagger(doc, { links: true, structParent: sect });
    t.beginRow(1);
    expect(childTypes(sect)).toEqual(['TOC']);
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Sect']);
  });

  it('reuses a structParent that is itself a /TOC', () => {
    const doc = docWith(2);
    const first = new TocTagger(doc, { links: true });
    first.beginRow(1);
    const second = new TocTagger(doc, { links: true, structParent: first.toc });
    second.beginRow(1);
    expect(second.toc.Ref!.num).toBe(first.toc.Ref!.num);
    expect(childTypes(first.toc)).toEqual(['TOCI', 'TOCI']);
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['TOC']);
  });
});

describe('TocTagger — level nesting', () => {
  it('nests a deeper row in a child /TOC under the previous TOCI', () => {
    const doc = docWith(4);
    const t = new TocTagger(doc, { links: true });
    t.beginRow(1); t.beginRow(2); t.beginRow(2); t.beginRow(1);
    // root TOC: TOCI(A) [with nested TOC], TOCI(B)
    expect(childTypes(t.toc)).toEqual(['TOCI', 'TOCI']);
    const a = t.toc.Children[0];
    expect(childTypes(a)).toEqual(['Reference', 'TOC']);
    expect(childTypes(a.Children[1])).toEqual(['TOCI', 'TOCI']);
    expect(childTypes(t.toc.Children[1])).toEqual(['Reference']);
  });

  it('clamps a level jump to one level deeper (1 -> 3 lands at depth 2)', () => {
    const doc = docWith(3);
    const t = new TocTagger(doc, { links: true });
    t.beginRow(1); t.beginRow(3);
    const a = t.toc.Children[0];
    expect(childTypes(a)).toEqual(['Reference', 'TOC']);
    expect(childTypes(a.Children[1])).toEqual(['TOCI']);
    // and no third level was opened
    expect(childTypes(a.Children[1].Children[0])).toEqual(['Reference']);
  });

  it('clamps a first row that starts deep to depth 1', () => {
    const doc = docWith(2);
    const t = new TocTagger(doc, { links: true });
    t.beginRow(3);
    expect(childTypes(t.toc)).toEqual(['TOCI']);
    expect(childTypes(t.toc.Children[0])).toEqual(['Reference']);
  });

  it('does not reuse a stale deeper TOCI after popping back', () => {
    const doc = docWith(5);
    const t = new TocTagger(doc, { links: true });
    t.beginRow(1); t.beginRow(2); t.beginRow(1); t.beginRow(2);
    const [a, b] = t.toc.Children;
    expect(childTypes(a.Children[1])).toEqual(['TOCI']);   // A's sub-TOC: one row
    expect(childTypes(b)).toEqual(['Reference', 'TOC']);   // B opened its own
    expect(childTypes(b.Children[1])).toEqual(['TOCI']);
  });
});

describe('TocTagger — depth across a continuation call (issue 1gg0.16)', () => {
  /** The nested /TOC under `toc`'s first /TOCI (`TOCI > Reference, TOC`). */
  const subToc = (toc: StructElement): StructElement => toc.Children[0].Children[1];

  it('resumes the reused /TOC at the depth the previous call left open', () => {
    const doc = docWith(4);
    const first = new TocTagger(doc, { links: true });
    first.beginRow(1); first.beginRow(2);
    const second = new TocTagger(doc, { links: true, structParent: first.toc });
    second.beginRow(2);
    // The continuation row joined the open depth-2 TOC instead of landing back
    // at depth 1 beside it.
    expect(childTypes(first.toc)).toEqual(['TOCI']);
    expect(childTypes(subToc(first.toc))).toEqual(['TOCI', 'TOCI']);
  });

  it('recovers the whole spine, not just one level', () => {
    const doc = docWith(5);
    const first = new TocTagger(doc, { links: true });
    first.beginRow(1); first.beginRow(2); first.beginRow(3);
    const second = new TocTagger(doc, { links: true, structParent: first.toc });
    second.beginRow(3);
    const depth3 = subToc(subToc(first.toc));
    expect(childTypes(depth3)).toEqual(['TOCI', 'TOCI']);
  });

  it('lets a continuation descend one level below where the previous call ended', () => {
    // Proves the recovered lastTOCI is wired up, not merely the stack: descending
    // needs a /TOCI at the open depth to hang the child /TOC from.
    const doc = docWith(4);
    const first = new TocTagger(doc, { links: true });
    first.beginRow(1); first.beginRow(2);
    const second = new TocTagger(doc, { links: true, structParent: first.toc });
    second.beginRow(3);
    expect(childTypes(subToc(subToc(first.toc)))).toEqual(['TOCI']);
  });

  it('still pops back to depth 1 when the continuation starts shallow', () => {
    const doc = docWith(4);
    const first = new TocTagger(doc, { links: true });
    first.beginRow(1); first.beginRow(2);
    const second = new TocTagger(doc, { links: true, structParent: first.toc });
    second.beginRow(1);
    expect(childTypes(first.toc)).toEqual(['TOCI', 'TOCI']);
    expect(childTypes(subToc(first.toc))).toEqual(['TOCI']);  // the old sub-TOC is closed
  });

  it('stops on a cyclic /K instead of descending forever', () => {
    // structParent only has to be a /TOC in this document's tree, so a reused
    // /TOC can come from an opened file whose /K closes a loop. Forge one: the
    // depth-2 row's /TOCI claims the root /TOC as its nested child.
    const doc = docWith(4);
    const first = new TocTagger(doc, { links: true });
    first.beginRow(1); first.beginRow(2);
    const k = subToc(first.toc).Children[0].Dict.get('K');
    if (!Array.isArray(k)) throw new Error('expected the /TOCI to carry a /K array');
    k.push(first.toc.Ref!);
    const second = new TocTagger(doc, { links: true, structParent: first.toc });
    second.beginRow(2);
    expect(childTypes(subToc(first.toc))).toEqual(['TOCI', 'TOCI']);
  });

  it('starts fresh under a non-/TOC structParent', () => {
    // A /Sect parent is nesting, not continuation: nothing to resume.
    const doc = docWith(4);
    const sect = doc.CreateStructTree().Append('Sect');
    const first = new TocTagger(doc, { links: true, structParent: sect });
    first.beginRow(1); first.beginRow(2);
    const second = new TocTagger(doc, { links: true, structParent: sect });
    second.beginRow(2);
    expect(childTypes(sect)).toEqual(['TOC', 'TOC']);
    expect(childTypes(sect.Children[1])).toEqual(['TOCI']);
  });
});

describe('TOC tagging options — validation', () => {
  const RECT: [number, number, number, number] = [72, 400, 400, 300];
  const ENTRIES = [{ title: 'One', page: 1 }];

  it('defaults to untagged', () => {
    const doc = docWith(2);
    const L = measureTOC(doc, ENTRIES, RECT);
    expect(L.tagged).toBe(false);
    expect(L.structParent).toBeUndefined();
  });

  it('rejects a non-boolean tagged', () => {
    const doc = docWith(2);
    expect(() => measureTOC(doc, ENTRIES, RECT, { tagged: 'yes' as any })).toThrow(TypeError);
  });

  it('rejects structParent without tagged', () => {
    const doc = docWith(2);
    const sect = doc.CreateStructTree().Append('Sect');
    expect(() => measureTOC(doc, ENTRIES, RECT, { structParent: sect })).toThrow(TypeError);
  });

  it('rejects a structParent from another document', () => {
    const doc = docWith(2);
    const other = docWith(2);
    const foreign = other.CreateStructTree().Append('Sect');
    expect(() => measureTOC(doc, ENTRIES, RECT, { tagged: true, structParent: foreign }))
      .toThrow(TypeError);
  });

  it('rejects a structParent with no indirect ref', () => {
    const doc = docWith(2);
    const sect = doc.CreateStructTree().Append('Sect');
    const refless = Object.create(Object.getPrototypeOf(sect),
      Object.getOwnPropertyDescriptors(sect));
    Object.defineProperty(refless, 'Ref', { value: undefined });
    expect(() => measureTOC(doc, ENTRIES, RECT, { tagged: true, structParent: refless }))
      .toThrow(TypeError);
  });

  it('accepts a well-formed structParent', () => {
    const doc = docWith(2);
    const sect = doc.CreateStructTree().Append('Sect');
    const L = measureTOC(doc, ENTRIES, RECT, { tagged: true, structParent: sect });
    expect(L.tagged).toBe(true);
    expect(L.structParent).toBe(sect);
  });
});

describe('page.AddTOC — tagged output', () => {
  const RECT: [number, number, number, number] = [72, 400, 400, 300];

  /** Glyph runs drawn inside an /Artifact scope, concatenated. */
  function artifactText(doc: Document, page: import('../src/page.js').Page): string {
    const out: string[] = [];
    visitContent(doc, page, { glyph: (e) => { if (e.artifact) out.push(e.text); } });
    return out.join('');
  }

  it('adds no structure by default', () => {
    const doc = docWith(3);
    const r = doc.Pages[0].AddTOC([{ title: 'One', page: 2 }], RECT);
    expect(r.struct).toBeUndefined();
    expect(doc.GetStructTree()).toBeNull();
    expect(doc.IsTagged).toBe(false);
    const content = new TextDecoder('latin1').decode(doc.Pages[0].Contents);
    expect(content).not.toContain('BDC');
    expect(content).not.toContain('BMC');
  });

  it('emits one TOCI per entry with the row text under its /Link', () => {
    const doc = docWith(4);
    const r = doc.Pages[0].AddTOC(
      [{ title: 'Alpha', page: 2 }, { title: 'Beta', page: 3 }], RECT, { tagged: true });
    expect(r.struct!.Type).toBe('TOC');
    expect(doc.IsTagged).toBe(true);
    const tocis = r.struct!.Children;
    expect(tocis.map((c) => c.Type)).toEqual(['TOCI', 'TOCI']);
    const link = tocis[0].Children[0].Children[0];
    expect(link.Type).toBe('Link');
    // GetText joins each marked-content run with '\n': title line, then label.
    expect(link.GetText()).toBe('Alpha\n2');
    expect(tocis[1].Children[0].Children[0].GetText()).toBe('Beta\n3');
  });

  it('puts every line of a wrapped title under the same /Link', () => {
    const doc = docWith(3);
    const title = 'A rather long chapter title that will not fit on one line at all';
    const r = doc.Pages[0].AddTOC([{ title, page: 2 }], [72, 400, 200, 300], { tagged: true });
    const link = r.struct!.Children[0].Children[0].Children[0];
    const text = link.GetText();
    expect(text.split('\n').length).toBeGreaterThan(2);       // >1 title line + label
    expect(text.split('\n').join(' ')).toContain('A rather long');
    expect(text.endsWith('\n2')).toBe(true);
    expect(r.struct!.Children).toHaveLength(1);               // still one entry
  });

  it('marks the dot leader as an artifact, outside the structure', () => {
    const doc = docWith(3);
    const r = doc.Pages[0].AddTOC([{ title: 'Alpha', page: 2 }], RECT, { tagged: true });
    expect(artifactText(doc, doc.Pages[0])).toContain('..');
    expect(r.struct!.GetText()).not.toContain('..');
  });

  it('attaches the link annotation as an OBJR under the /Link', () => {
    const doc = docWith(3);
    const r = doc.Pages[0].AddTOC([{ title: 'Alpha', page: 2 }], RECT, { tagged: true });
    const link = r.struct!.Children[0].Children[0].Children[0];
    const kids = doc.resolve(link.Dict.get('K')) as any[];
    const objr = kids.map((k) => doc.resolve(k))
      .find((k: any) => k instanceof Map &&
        (doc.resolve(k.get('Type')) as any)?.name === 'OBJR') as Map<string, any> | undefined;
    expect(objr).toBeDefined();
    const annot = doc.Pages[0].Annotations[0];
    expect(doc.resolve(objr!.get('Obj'))).toBe(annot.Dict);
    expect(doc.resolve(annot.Dict.get('StructParent'))).toEqual(expect.any(Number));
  });

  it('drops the /Link when links are off', () => {
    const doc = docWith(3);
    const r = doc.Pages[0].AddTOC(
      [{ title: 'Alpha', page: 2 }], RECT, { tagged: true, links: false });
    const reference = r.struct!.Children[0].Children[0];
    expect(reference.Type).toBe('Reference');
    expect(reference.Children).toEqual([]);
    expect(reference.GetText()).toBe('Alpha\n2');
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });

  it('nests a level-2 row under the previous entry', () => {
    const doc = docWith(4);
    const r = doc.Pages[0].AddTOC(
      [{ title: 'Alpha', page: 2 }, { title: 'Alpha.1', page: 3, level: 2 }],
      RECT, { tagged: true });
    const alpha = r.struct!.Children[0];
    expect(alpha.Children.map((c) => c.Type)).toEqual(['Reference', 'TOC']);
    expect(alpha.Children[1].Children[0].GetText()).toBe('Alpha.1\n3');
  });

  it('creates no structure when nothing is drawn', () => {
    const doc = docWith(2);
    const r = doc.Pages[0].AddTOC([], RECT, { tagged: true });
    expect(r.struct).toBeUndefined();
    expect(doc.GetStructTree()).toBeNull();
  });

  it('round-trips through Save', () => {
    const doc = docWith(3);
    doc.Pages[0].AddTOC([{ title: 'Alpha', page: 2 }], RECT, { tagged: true });
    const re = Document.Open(doc.Save());
    const toc = re.GetStructTree()!.Children[0];
    expect(toc.Type).toBe('TOC');
    expect(toc.Children[0].Children[0].Children[0].GetText()).toBe('Alpha\n2');
  });
});

describe('AddTOC tagging — pagination and atomicity', () => {
  const RECT: [number, number, number, number] = [72, 400, 400, 300];
  const SHORT: [number, number, number, number] = [72, 600, 400, 40];

  it('keeps one /TOC across a manual pagination loop', () => {
    const doc = docWith(12);
    const entries = Array.from({ length: 8 }, (_, i) => ({ title: `Row ${i}`, page: i + 2 }));
    let r = doc.Pages[0].AddTOC(entries, SHORT, { tagged: true });
    expect(r.remainder?.length).toBeGreaterThan(0);
    let guard = 0;
    while (r.remainder?.length) {
      if (++guard > 20) throw new Error('pagination did not advance');
      r = doc.AddPage().page.AddTOC(r.remainder, SHORT,
        { tagged: true, structParent: r.struct });
    }
    const tops = doc.GetStructTree()!.Children;
    expect(tops.map((c) => c.Type)).toEqual(['TOC']);
    expect(tops[0].Children).toHaveLength(8);
  });

  it('keeps a subtree together when the page breaks inside it', () => {
    const doc = docWith(6);
    // SHORT fits two default-leading rows, so the break falls between the second
    // and third level-2 rows — mid-subtree.
    const entries = [
      { title: 'Chapter', page: 2 },
      { title: 'One', page: 3, level: 2 },
      { title: 'Two', page: 4, level: 2 },
      { title: 'Three', page: 5, level: 2 },
    ];
    let r = doc.Pages[0].AddTOC(entries, SHORT, { tagged: true });
    expect(r.remainder?.length).toBe(2);
    r = doc.AddPage().page.AddTOC(r.remainder!, SHORT, { tagged: true, structParent: r.struct });
    expect(r.remainder).toBeUndefined();
    const toc = doc.GetStructTree()!.Children[0];
    expect(childTypes(toc)).toEqual(['TOCI']);              // one chapter, not four
    const sub = toc.Children[0].Children[1];
    expect(childTypes(sub)).toEqual(['TOCI', 'TOCI', 'TOCI']);
    // The row that landed on page 2 reads back its own text, so its MCIDs are
    // wired to the continuation page's content.
    expect(sub.Children[2].Children[0].Children[0].GetText()).toBe('Three\n5');
  });

  it('spans pages with MCR content refs under autoPaginate', () => {
    const doc = docWith(12);
    const entries = Array.from({ length: 8 }, (_, i) => ({ title: `Row ${i}`, page: i + 2 }));
    const r = doc.Pages[0].AddTOC(entries, SHORT, { tagged: true, autoPaginate: true });
    expect(r.pages.length).toBeGreaterThan(1);
    expect(r.struct!.Children).toHaveLength(8);
    // Every page drawn onto gets its own /StructParents key.
    const keys = r.pages.map((p) => doc.resolve(p.Dict.get('StructParents')));
    expect(new Set(keys).size).toBe(r.pages.length);
    // A row on a later page reads back its text, which only works if the MCR
    // carries the right /Pg.
    const last = r.struct!.Children[7].Children[0].Children[0];
    expect(last.GetText()).toBe('Row 7\n9');
  });

  it('leaves the document byte-identical when a tagged call throws', () => {
    const doc = docWith(3);
    doc.Pages[0].AddText('existing', 72, 720);
    const before = doc.Save();
    const foreign = docWith(2).CreateStructTree().Append('Sect');
    expect(() => doc.Pages[0].AddTOC([{ title: 'Alpha', page: 2 }], RECT,
      { tagged: true, structParent: foreign })).toThrow(TypeError);
    expect(() => doc.Pages[0].AddTOC([{ title: 'Alpha', page: 99 }], RECT,
      { tagged: true })).toThrow(RangeError);
    // Same idiom as the existing "TOC atomicity" suite in test/toc.test.ts.
    expect(doc.Save()).toEqual(before);
    expect(doc.GetStructTree()).toBeNull();
  });
});

describe('AddTOC tagging — PDF/UA', () => {
  it('reports no structure-type issues for a tagged TOC', () => {
    const doc = docWith(4);
    doc.Lang = 'en-US';
    doc.SetMetadata({ title: 'Tagged TOC' });
    doc.Pages[0].AddTOC(
      [{ title: 'Alpha', page: 2 }, { title: 'Alpha.1', page: 3, level: 2 }],
      [72, 400, 400, 300], { tagged: true });
    const rules = doc.ValidatePdfUa().Issues.map((i) => i.rule);
    expect(rules).not.toContain('StandardType');
    expect(rules).not.toContain('NaturalLanguage');
  });
});
