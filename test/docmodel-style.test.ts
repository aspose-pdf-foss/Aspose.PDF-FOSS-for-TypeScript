import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocModel, type DocNode, type DocText } from '../src/docmodel.js';

const SRC = 'Plain start **bold middle** plain end.';

function model(tagged: boolean): DocNode[] {
  const doc = Document.New();
  const flow = doc.NewFlow(tagged ? { tagged: true } : {});
  flow.AddMarkdown(SRC);
  flow.Render();
  return buildDocModel(doc, doc.Pages);
}

function texts(nodes: DocNode[]): DocText[] {
  const out: DocText[] = [];
  const walk = (n: DocNode): void => {
    if (n.kind === 'text') out.push(n);
    else if (n.kind === 'container') n.children.forEach(walk);
    else if (n.kind === 'list') n.items.forEach((i) => i.blocks.forEach(walk));
    else if (n.kind === 'listItem') n.blocks.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

describe('DocText style', () => {
  for (const tagged of [true, false]) {
    const which = tagged ? 'tagged' : 'untagged';

    it(`carries bold through the ${which} builder`, () => {
      const bold = texts(model(tagged)).filter((t) => t.bold);
      expect(bold.length).toBe(1);
      expect(bold[0].text.trim()).toBe('bold middle');
    });

    it(`omits the flags for plain text (${which})`, () => {
      const plain = texts(model(tagged)).find((t) => t.text.includes('Plain start'))!;
      expect(plain.bold).toBeUndefined();
      expect(plain.italic).toBeUndefined();
    });

    // Splitting a run in three is three more chances to lose the separator
    // spaces at the new edges.
    it(`loses no text to the split (${which})`, () => {
      const joined = texts(model(tagged)).map((t) => t.text).join('');
      expect(joined.replace(/\s+/g, ' ').trim()).toBe('Plain start bold middle plain end.');
    });
  }

  // Until c3t7.8 this asserted the OPPOSITE — that the model extension was
  // invisible to the serializers that did not read it, and the export came back
  // as `Plain start bold middle plain end.` with the emphasis dropped. That
  // property was deliberately retired: all three serializers now read
  // bold/italic/script, so the round trip reproduces its own source exactly.
  it('carries the emphasis into the Markdown export', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true });
    flow.AddMarkdown(SRC);
    flow.Render();
    expect(doc.ToMarkdown()).toBe(`${SRC}\n`);
  });
});
