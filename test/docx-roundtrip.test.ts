import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';

const SRC = '# Report\n\nOpening paragraph with **bold** words.\n\n- first\n- second\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';

const typesOf = (doc: Document): string[] => {
  const out: string[] = [];
  const walk = (els: { Type: string; Children: unknown[] }[]): void => { for (const e of els) { out.push(e.Type); walk(e.Children as never); } };
  walk(doc.GetStructTree()!.Children as never);
  return out;
};

describe('ToDocx -> AddDocx round trip', () => {
  it('keeps the text and the structure types', () => {
    const original = Document.New();
    original.AddMarkdown(SRC, { gfm: true, tagged: true });
    const again = Document.New();
    again.AddDocx(original.ToDocx(), { tagged: true });
    // Markdown draws a bullet as a vector shape with no text, while a DOCX
    // bullet is the glyph U+2022: markers are normalised out of both sides.
    const norm = (d: Document) => d.Pages.map((p) => p.GetText()).join(' ').replace(/•/g, ' ').replace(/\s+/g, ' ').trim();
    expect(norm(again)).toBe(norm(original));
    for (const t of ['H1', 'P', 'L', 'LI', 'Table', 'TR']) expect(typesOf(again)).toContain(t);
    expect(typesOf(again).filter((t) => t === 'TD' || t === 'TH')).toHaveLength(4);
  });
});
