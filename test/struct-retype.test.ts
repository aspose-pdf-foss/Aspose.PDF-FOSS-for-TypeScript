import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type MarkedContentEvent } from '../src/text.js';
import { inflateStream } from '../src/flate.js';
import { isStream, isDict } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildNestedMcPdf, buildSharedFormMcPdf } from './helpers/build-nested-mc-pdf.js';

/** The concatenated text of every content stream of a page. */
function pageText(doc: Document, pageIndex = 0): string {
  const c = doc.resolve(doc.Pages[pageIndex].Dict.get('Contents'));
  const entries = isStream(c) ? [c] : (Array.isArray(c) ? c.map((e) => doc.resolve(e)) : []);
  return entries
    .filter(isStream)
    .map((s) => new TextDecoder().decode(inflateStream(s)))
    .join('\n');
}

describe('Append validates the structure type', () => {
  it('rejects an unmapped custom type from the root', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    expect(() => root.Append('Nonsense')).toThrow(RangeError);
  });

  it('rejects an unmapped custom type from an element', () => {
    const doc = Document.Open(buildStampTarget());
    const sect = doc.CreateStructTree().Append('Sect');
    expect(() => sect.Append('Nonsense')).toThrow(RangeError);
  });

  it('accepts a type the RoleMap resolves', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    root.RegisterRole('Subtitle', 'P');
    expect(root.Append('Subtitle').StandardType).toBe('P');
  });

  // formcreate.ts's rule, scaled to one element: a rejected call must leave the
  // document byte-identical. createElement allocates on its first statement, so
  // validating afterwards would strand an object in the map.
  it('leaves the document byte-identical when it rejects', () => {
    const doc = Document.Open(buildStampTarget());
    doc.CreateStructTree().Append('Sect');
    const before = doc.Save();
    expect(() => doc.GetStructTree()!.Append('Nonsense')).toThrow(RangeError);
    expect(Buffer.from(doc.Save())).toEqual(Buffer.from(before));
  });
});

describe('visitContent: the marked event', () => {
  it('reports the tag, MCID and address of a structure content item', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);

    const seen: MarkedContentEvent[] = [];
    visitContent(doc, page, { marked(e) { seen.push(e); } });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].tag).toBe('P');
    expect(seen[0].mcid).toBe(0);
    expect(seen[0].addr.path).toEqual([]);
    expect(typeof seen[0].addr.opIndex).toBe('number');
  });

  // The narrowing is what keeps the event meaning one thing. An /Artifact BDC
  // carries no /MCID, so `marked` and `artifact` provably cannot both fire for
  // one op — no consumer has to disambiguate them.
  it('does not fire for an artifact BDC, which carries no MCID', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.Graphics()
      .BeginArtifact()
      .setFillColor([0, 0, 0]).rect(10, 10, 20, 20).fill()
      .EndMarkedContent()
      .apply();

    const marks: MarkedContentEvent[] = [];
    let artifacts = 0;
    visitContent(doc, page, { marked(e) { marks.push(e); }, artifact() { artifacts++; } });

    expect(artifacts).toBeGreaterThan(0);
    expect(marks).toEqual([]);
  });
});

describe('StructElement.SetType', () => {
  it('writes /S and reports what it retagged', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);

    const r = el.SetType('H2');
    expect(el.Type).toBe('H2');
    expect(r.retagged).toBe(1);
    expect(r.unreachable).toBe(0);
  });

  // MEASURED: nothing in this library reads a BDC tag name — text.ts reads the
  // operand's /MCID and only ever compares the tag against /Artifact. So a test
  // that retags and re-reads `Type` passes with the whole rewrite deleted. The
  // assertion has to be on emitted bytes.
  it('rewrites the BDC tag in the page content stream', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);
    expect(pageText(doc)).toMatch(/\/P\s*<<\s*\/MCID 0/);

    el.SetType('H2');
    const after = pageText(doc);
    expect(after).toMatch(/\/H2\s*<<\s*\/MCID 0/);
    expect(after).not.toMatch(/\/P\s*<<\s*\/MCID 0/);
  });

  it('rejects an unmapped custom type and leaves /S alone', () => {
    const doc = Document.Open(buildStampTarget());
    const el = doc.CreateStructTree().Append('P');
    expect(() => el.SetType('Nonsense')).toThrow(RangeError);
    expect(el.Type).toBe('P');
  });

  it('accepts a type the RoleMap resolves', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    root.RegisterRole('Subtitle', 'P');
    const el = root.Append('P');
    el.SetType('Subtitle');
    expect(el.Type).toBe('Subtitle');
    expect(el.StandardType).toBe('P');
  });

  it('retags nothing, and reports nothing, for an element with no content', () => {
    const doc = Document.Open(buildStampTarget());
    const el = doc.CreateStructTree().Append('P');
    expect(el.SetType('Div')).toEqual({ retagged: 0, unreachable: 0 });
  });

  // The setter is a thin wrapper over SetType so the two cannot drift.
  it('the property setter does the same work and discards the report', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    el.MarkContent(page, [0, 0, 1000, 1000]);
    el.Type = 'H3';
    expect(el.Type).toBe('H3');
    expect(pageText(doc)).toMatch(/\/H3\s*<<\s*\/MCID 0/);
  });

  it('the property setter rejects an unmapped type too', () => {
    const doc = Document.Open(buildStampTarget());
    const el = doc.CreateStructTree().Append('P');
    expect(() => { el.Type = 'Nonsense'; }).toThrow(RangeError);
  });

  it('retypes only this element, never its children', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const parent = doc.CreateStructTree().Append('Sect');
    const child = parent.Append('P');
    child.MarkContent(page, [0, 0, 1000, 1000]);
    parent.SetType('Div');
    expect(child.Type).toBe('P');
    expect(pageText(doc)).toMatch(/\/P\s*<<\s*\/MCID 0/);
  });
});

/** The decoded content of the Form XObject named `nm` in page `pageIndex`. */
function formText(doc: Document, pageIndex: number, nm: string): string {
  const res = doc.resolve(doc.Pages[pageIndex].Dict.get('Resources'));
  if (!isDict(res)) throw new Error('page has no /Resources');
  const xo = doc.resolve(res.get('XObject'));
  if (!isDict(xo)) throw new Error('page has no /XObject');
  const s = doc.resolve(xo.get(nm));
  if (!isStream(s)) throw new Error(`/${nm} is not a stream`);
  return new TextDecoder().decode(inflateStream(s));
}

describe('SetType reaches a BDC inside a Form XObject', () => {
  it('rewrites the tag in the form, not the page', () => {
    const doc = Document.Open(buildNestedMcPdf());
    const el = doc.GetStructTree()!.Children[0];
    expect(el.Type).toBe('P');
    expect(formText(doc, 0, 'Fm0')).toMatch(/\/P\s*<<\s*\/MCID 0/);

    const r = el.SetType('H1');
    expect(r).toEqual({ retagged: 1, unreachable: 0 });

    const form = formText(doc, 0, 'Fm0');
    expect(form).toMatch(/\/H1\s*<<\s*\/MCID 0/);
    expect(form).not.toMatch(/\/P\s*<<\s*\/MCID 0/);
    // The page's own content is untouched: only the form held the BDC.
    expect(pageText(doc)).toMatch(/\/Fm0 Do/);
  });

  it('survives a save/reopen', () => {
    const doc = Document.Open(buildNestedMcPdf());
    doc.GetStructTree()!.Children[0].SetType('H1');
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.Children[0].Type).toBe('H1');
    expect(formText(re, 0, 'Fm0')).toMatch(/\/H1\s*<<\s*\/MCID 0/);
  });

  // The COW this feature forces. A form shared by two pages is cloned for the
  // page being edited; the other page keeps the original. Rewriting in place
  // would silently retag content belonging to a different element.
  it('copies a shared form on write and leaves the other page alone', () => {
    const doc = Document.Open(buildSharedFormMcPdf());
    const [a, b] = doc.GetStructTree()!.Children;
    expect(a.Type).toBe('P');
    expect(b.Type).toBe('P');

    a.SetType('H1');

    expect(formText(doc, 0, 'Fm0')).toMatch(/\/H1\s*<<\s*\/MCID 0/);
    expect(formText(doc, 1, 'Fm0')).toMatch(/\/P\s*<<\s*\/MCID 0/);
    expect(b.Type).toBe('P');
  });
});

describe('SetType fails open', () => {
  // An element whose content item names a page that does not resolve. /S is
  // still written; the item is counted rather than throwing, because a stale
  // tag name is cosmetic and must not cost the caller the retag.
  it('counts an unresolvable content item and still writes /S', () => {
    const doc = Document.Open(buildNestedMcPdf());
    const el = doc.GetStructTree()!.Children[0];
    el.Dict.delete('Pg');          // the item can no longer name a page

    const r = el.SetType('H1');
    expect(el.Type).toBe('H1');
    expect(r.retagged).toBe(0);
    expect(r.unreachable).toBe(1);
  });
});
