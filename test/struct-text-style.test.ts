import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { StructElement } from '../src/struct.js';

/** A tagged flow whose paragraph has a bold phrase in the middle: mdruns.ts
 *  maps `**word**` onto the bold member of the face's family. */
function taggedDoc(): Document {
  const doc = Document.New();
  const flow = doc.NewFlow({ tagged: true });
  flow.AddMarkdown('Plain start **bold middle** plain end.');
  flow.Render();
  return doc;
}

/** Every text node under the tree, depth first. */
function textNodes(el: StructElement): { text: string; bold?: boolean }[] {
  const out: { text: string; bold?: boolean }[] = [];
  for (const n of el.Nodes) {
    if (n instanceof StructElement) out.push(...textNodes(n));
    else out.push({ text: n.text, ...(n.bold ? { bold: true } : {}) });
  }
  return out;
}

const allNodes = (doc: Document) =>
  doc.GetStructTree()!.Children.flatMap((c) => textNodes(c));

describe('StructTextNode style', () => {
  it('splits one own-text run where the style changes', () => {
    const bold = allNodes(taggedDoc()).filter((n) => n.bold);
    expect(bold.length).toBe(1);
    expect(bold[0].text.trim()).toBe('bold middle');
  });

  // The split is three more chances to make the mistake spacedText exists to
  // prevent: concatenating the pieces must reproduce the whole paragraph,
  // separator spaces and all.
  it('keeps the spaces either side of the split', () => {
    const joined = allNodes(taggedDoc()).map((n) => n.text).join('');
    expect(joined.replace(/\s+/g, ' ').trim()).toBe('Plain start bold middle plain end.');
  });

  // The split fires on the DERIVED STYLE, not on the font object. Inline code
  // switches to a monospace face mid-paragraph, so this line draws through TWO
  // distinct font objects that are both plain -- and must still be one run.
  //
  // Measured: a single-face paragraph cannot pin this, because object identity
  // and style comparison agree there whatever the code does. Splitting on the
  // object leaves such a test green and this one red.
  it('does not split between two different faces of the same style', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true });
    flow.AddMarkdown('plain `code` plain');
    flow.Render();
    expect(new Set(doc.Pages[0].GetTextFragments().map((f) => f.fontName)).size).toBe(2);
    expect(allNodes(doc).map((n) => n.text)).toEqual(['plain code plain']);
  });
});
