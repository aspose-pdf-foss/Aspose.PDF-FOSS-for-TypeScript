import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseMarkdown } from '../src/markdown.js';
import type { MdBlock, MdInline, MdNode } from '../src/mdast.js';

const SOURCE = [
  '# Quarterly Report',
  '',
  'Revenue grew twelve percent this year.',
  '',
  '## Regional breakdown',
  '',
  'The northern region led growth.',
  '',
].join('\n');

function textOf(node: MdNode): string {
  if (node.type === 'text') return node.value;
  const kids = (node as { children?: (MdBlock | MdInline)[] }).children ?? [];
  return kids.map(textOf).join('');
}

/** Headings as [level, text] and paragraphs as text — the block skeleton. */
function skeleton(md: string): string[] {
  const doc = parseMarkdown(md, { gfm: true });
  const out: string[] = [];
  for (const block of doc.children) {
    if (block.type === 'heading') out.push(`h${block.level}:${textOf(block).trim()}`);
    else if (block.type === 'paragraph') out.push(`p:${textOf(block).trim()}`);
  }
  return out;
}

describe('Markdown round trip through PDF', () => {
  // Compares BLOCK STRUCTURE, not ASTs. A round trip through PDF is lossy by
  // construction here: emphasis has no recovery path until a sibling issue adds
  // one, so asserting AST equality would fail for a reason that is not a defect.
  it('recovers headings and paragraphs from a tagged document', () => {
    const doc = Document.New();
    doc.AddMarkdown(SOURCE, { tagged: true });
    const back = Document.Open(doc.Save()).ToMarkdown();

    expect(skeleton(back)).toEqual(skeleton(SOURCE));
  });

  it('recovers the text even from an untagged rendering', () => {
    const doc = Document.New();
    doc.AddMarkdown(SOURCE);
    const back = Document.Open(doc.Save()).ToMarkdown();

    const words = (s: string) => s.replace(/[#*_`]/g, '').split(/\s+/).filter((w) => w);
    for (const w of words(SOURCE)) expect(words(back)).toContain(w);
  });
});

const RICH = [
  '# Release notes',
  '',
  '- alpha',
  '  - nested alpha',
  '- beta',
  '',
  '1. first',
  '2. second',
  '',
  '```',
  'if (x) {',
  '    return 1;',
  '}',
  '```',
  '',
  '> quoted line',
  '',
].join('\n');

/** The same constructs minus the bullet list — see the untagged case below. */
const RICH_ORDERED = [
  '# Release notes',
  '',
  '1. first',
  '2. second',
  '',
  '```',
  'if (x) {',
  '    return 1;',
  '}',
  '```',
  '',
].join('\n');

/** Blocks as coarse shapes: enough to tell a list from a paragraph, ignoring the
 *  inline styling a round trip through PDF legitimately loses. */
function shapes(md: string): string[] {
  const doc = parseMarkdown(md, { gfm: true });
  const walk = (blocks: MdBlock[], out: string[]): string[] => {
    for (const b of blocks) {
      if (b.type === 'heading') out.push(`h${b.level}:${textOf(b).trim()}`);
      else if (b.type === 'paragraph') out.push(`p:${textOf(b).trim()}`);
      else if (b.type === 'code_block') out.push(`code:${b.literal}`);
      else if (b.type === 'block_quote') { out.push('quote{'); walk(b.children, out); out.push('}'); }
      else if (b.type === 'list') {
        out.push(`list:${b.ordered ? 'ordered' : 'bullet'}{`);
        for (const item of b.children) walk(item.children, out);
        out.push('}');
      }
    }
    return out;
  };
  return walk(doc.children, []);
}

describe('Markdown round trip — lists, code and quotes', () => {
  it('recovers them from a tagged document', () => {
    const doc = Document.New();
    doc.AddMarkdown(RICH, { tagged: true, gfm: true });
    const back = Document.Open(doc.Save()).ToMarkdown();

    expect(shapes(back)).toEqual(shapes(RICH));
  });

  // Code is compared EXACTLY, unlike prose: indentation is the whole point of
  // the construct, and a comparison that trims it measures nothing.
  it('preserves code indentation byte for byte', () => {
    const doc = Document.New();
    doc.AddMarkdown(RICH, { tagged: true, gfm: true });
    const back = Document.Open(doc.Save()).ToMarkdown();
    expect(back).toContain('if (x) {\n    return 1;\n}');
  });

  // The untagged counterpart uses ORDERED lists only. A bullet is the one
  // construct our own renderer cannot round-trip untagged: flow.ts draws it as
  // vector geometry (WinAnsi has no ballot-box glyph), so the page carries no
  // marker for docinfer.ts to read. An ordinal is ordinary text and does.
  it('recovers an ordered list, code and a heading from an untagged rendering', () => {
    const doc = Document.New();
    doc.AddMarkdown(RICH_ORDERED, { gfm: true });
    const back = Document.Open(doc.Save()).ToMarkdown();

    expect(shapes(back)).toEqual(shapes(RICH_ORDERED));
  });

  it('preserves code indentation byte for byte, untagged too', () => {
    const doc = Document.New();
    doc.AddMarkdown(RICH_ORDERED, { gfm: true });
    const back = Document.Open(doc.Save()).ToMarkdown();
    expect(back).toContain('if (x) {\n    return 1;\n}');
  });
});
