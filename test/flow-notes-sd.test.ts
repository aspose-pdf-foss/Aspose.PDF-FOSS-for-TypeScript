import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { FlowNote } from '../src/flow.js';
import type { StructElement } from '../src/struct.js';
import { isArray, isDict, isRef, type PdfRef } from '../src/types.js';

// mba3: a note link's /SD names the /Note (citation -> note) and the element
// holding the citation (note -> citation), never merely the first structure
// element on the target page.

const fn = (c: string): { footnote: FlowNote } => ({ footnote: { content: c } });
const en = (c: string): { endnote: FlowNote } => ({ endnote: { content: c } });
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

function all(el: { Children: StructElement[] }): StructElement[] {
  return el.Children.flatMap((c) => [c, ...all(c)]);
}

/** Every GoTo link annotation in the document, with its page number and the
 *  object number its /SD names (undefined when it has none). */
function gotoLinks(doc: Document): { page: number; sd: number | undefined }[] {
  const out: { page: number; sd: number | undefined }[] = [];
  doc.Pages.forEach((p, i) => {
    for (const a of p.Annotations) {
      if (a.Subtype !== 'Link') continue;
      const act = doc.resolve(a.Dict.get('A'));
      if (!isDict(act)) continue;
      const sd = act.get('SD');
      const first = isArray(sd) ? sd[0] : undefined;
      out.push({ page: i + 1, sd: isRef(first) ? (first as PdfRef).num : undefined });
    }
  });
  return out;
}

describe('note links name their structure target (mba3)', () => {
  it('a footnote citation targets the /Note, and the note mark targets the citing /P', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true });
    flow.AddParagraph('before');
    flow.AddParagraph([{ text: 'claim' }, { text: '', ...fn('The source.') }]);
    flow.Render();
    const els = all(doc.GetStructTree()!);
    const note = els.find((e) => e.Type === 'Note')!;
    const citing = note.Parent!;
    expect(citing.Type).toBe('P');
    const sds = gotoLinks(doc).map((l) => l.sd);
    expect(sds).toHaveLength(2);
    expect(sds).toContain(note.Ref!.num);
    expect(sds).toContain(citing.Ref!.num);
    // Not the page's first element, which is the /P 'before' (or its /Sect).
    const firstP = els.find((e) => e.Type === 'P')!;
    expect(firstP).not.toBe(citing);
    expect(sds).not.toContain(firstP.Ref!.num);
  });

  it('an endnote on a later page is targeted although the /Note inherits the citation page', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true });
    flow.AddParagraph([{ text: 'x' }, { text: '', ...en('The endnote.') }]);
    flow.AddParagraph(words(1500));
    flow.Render();
    const note = all(doc.GetStructTree()!).find((e) => e.Type === 'Note')!;
    const links = gotoLinks(doc);
    const cite = links.find((l) => l.page === 1)!;
    expect(links.some((l) => l.page > 1)).toBe(true);   // the endnote really is later
    expect(cite.sd).toBe(note.Ref!.num);
  });

  it('an untagged flow still writes no /SD', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'claim' }, { text: '', ...fn('The source.') }]);
    flow.Render();
    const links = gotoLinks(doc);
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.sd === undefined)).toBe(true);
  });
});
