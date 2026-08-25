import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDocModel, type DocList, type DocNode, type DocContainer } from '../src/docmodel.js';
import { buildUntaggedHtmlPdf } from './helpers/build-html-fixtures.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildTaggedTablePdf } from './helpers/build-tagged-table-pdf.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';
import {
  buildBulletListPdf, buildNestedListPdf, buildOrderedListPdf,
  buildWrappedItemPdf, buildYearProsePdf,
} from './helpers/build-untagged-list-pdf.js';

/** Every container type in the tree, pre-order — the model's shape in one line. */
function types(nodes: DocNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'container') { out.push(n.type); types(n.children, out); }
    else out.push(n.kind);
  }
  return out;
}

/** All text in the tree, joined. */
function text(nodes: DocNode[]): string {
  return nodes.map((n) => n.kind === 'text' ? n.text
    : n.kind === 'container' ? text(n.children) : '').filter((s) => s).join(' ');
}

function find(nodes: DocNode[], type: string): DocContainer | undefined {
  for (const n of nodes) {
    if (n.kind !== 'container') continue;
    if (n.type === type) return n;
    const hit = find(n.children, type);
    if (hit) return hit;
  }
  return undefined;
}

describe('buildDocModel — untagged', () => {
  it('emits H1 and P containers, not HTML tags', () => {
    const doc = Document.Open(buildUntaggedHtmlPdf());
    const model = buildDocModel(doc, doc.Pages);
    expect(types(model)).toEqual(['H1', 'text', 'P', 'text']);
    expect(text(model)).toBe('Quarterly Report Revenue grew twelve percent this year.');
  });

  it('emits an untagged figure per page image, with no alt', () => {
    const src = 'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';
    const doc = Document.Open(buildTextAndImagePage(src));
    const figures = buildDocModel(doc, doc.Pages).filter((n) => n.kind === 'figure');
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({ alt: '', tagged: false });
    expect((figures[0] as { images: unknown[] }).images).toHaveLength(1);
  });
});

describe('buildDocModel — tagged', () => {
  it('drives the tree from structure types', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const model = buildDocModel(doc, doc.Pages);
    expect(types(model)).toContain('P');
    expect(text(model)).toContain('Page one body');
    expect(text(model)).toContain('Page two body');
  });

  it('marks a /Figure tagged and carries its /Alt', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const model = buildDocModel(doc, doc.Pages);
    const figures: { alt: string; tagged: boolean }[] = [];
    const walk = (ns: DocNode[]): void => {
      for (const n of ns) {
        if (n.kind === 'figure') figures.push(n);
        else if (n.kind === 'container') walk(n.children);
      }
    };
    walk(model);
    expect(figures).toHaveLength(1);
    expect(figures[0]).toMatchObject({ alt: 'A figure', tagged: true });
  });

  it('resolves a RoleMap role to its standard type and keeps /Lang', () => {
    const doc = Document.Open(buildTaggedPdf());
    const model = buildDocModel(doc, doc.Pages);
    expect(types(model)).toContain('H2');
    expect(JSON.stringify(model)).toContain('en-GB');
  });

  it('lets /ActualText replace a subtree', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(text(buildDocModel(doc, doc.Pages))).toContain('Body paragraph actual');
  });

  it('emits a table node carrying the Table model, not markup', () => {
    const doc = Document.Open(buildTaggedTablePdf());
    const model = buildDocModel(doc, doc.Pages);
    const tables: { table: { rowCount: number } }[] = [];
    const walk = (ns: DocNode[]): void => {
      for (const n of ns) {
        if (n.kind === 'table') tables.push(n as never);
        else if (n.kind === 'container') walk(n.children);
      }
    };
    walk(model);
    expect(tables).toHaveLength(1);
    expect(tables[0].table.rowCount).toBeGreaterThan(1);
  });

  it('keeps only the requested page, ancestors intact', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const model = buildDocModel(doc, [doc.Pages[1]]);
    const t = text(model);
    expect(t).toContain('Page two body');
    expect(t).not.toContain('Page one body');
    expect(find(model, 'Sect')).toBeDefined();   // the ancestor survives
  });

  it('leaves no empty container in a page-filtered tree', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const model = buildDocModel(doc, [doc.Pages[1]]);
    const empty: string[] = [];
    const walk = (ns: DocNode[]): void => {
      for (const n of ns) {
        if (n.kind !== 'container') continue;
        if (!n.children.length) empty.push(n.type);
        walk(n.children);
      }
    };
    walk(model);
    expect(empty).toEqual([]);
  });

  // The case above does NOT reach the pruning rule: onPage rejects the other
  // page's elements before the empty check is consulted, so removing the check
  // leaves it green. Measured, not assumed. An element authored with no content
  // at all is what actually exercises it.
  it('prunes a structure element that has no content of its own', () => {
    const doc = Document.New();
    const root = doc.CreateStructTree();
    root.Append('P');                     // authored, never given content
    root.Append('Sect').Append('P');      // and one nested a level down
    expect(buildDocModel(doc, doc.Pages)).toEqual([]);
  });
});

/** Every list in the model, depth-first. */
function lists(nodes: DocNode[], out: DocList[] = []): DocList[] {
  for (const n of nodes) {
    if (n.kind === 'list') { out.push(n); for (const it of n.items) lists(it.blocks, out); }
    else if (n.kind === 'container') lists(n.children, out);
    else if (n.kind === 'listItem') lists(n.blocks, out);
  }
  return out;
}

/** A tagged document rendered from Markdown by our own authoring stack.
 *
 *  `gfm` is on because a task list is a GFM extension: without it `- [ ] todo`
 *  parses as an ordinary item whose text happens to open with a bracket, and the
 *  /Lbl carries a bullet rather than a ballot box. */
function tagged(src: string): Document {
  const doc = Document.New();
  doc.AddMarkdown(src, { tagged: true, gfm: true });
  return Document.Open(doc.Save());
}

describe('docmodel — tagged lists', () => {
  it('reads /L, /LI and /LBody as a list of items', () => {
    const doc = tagged('- alpha\n- beta\n');
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l.ordered).toBe(false);
    expect(l.items).toHaveLength(2);
  });

  it('drops the /Lbl from the content — a marker is evidence, not text', () => {
    const doc = tagged('- alpha\n- beta\n');
    const [l] = lists(buildDocModel(doc, doc.Pages));
    const text = JSON.stringify(l.items[0]);
    expect(text).toContain('alpha');
    expect(text).not.toContain('•');
  });

  it('reads ordered-ness and a start from the /Lbl text', () => {
    const doc = tagged('3. three\n4. four\n');
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l.ordered).toBe(true);
    expect(l.start).toBe(3);
  });

  it('omits start when the list begins at one', () => {
    const doc = tagged('1. one\n2. two\n');
    expect(lists(buildDocModel(doc, doc.Pages))[0].start).toBeUndefined();
  });

  it('nests a sub-list under its parent item', () => {
    const doc = tagged('- outer\n  - inner\n');
    const all = lists(buildDocModel(doc, doc.Pages));
    expect(all).toHaveLength(2);
    expect(all[0].items[0].blocks.some((b) => b.kind === 'list')).toBe(true);
  });

  it('reads a task marker as checked state', () => {
    const doc = tagged('- [ ] todo\n- [x] done\n');
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l.items.map((i) => i.checked)).toEqual([false, true]);
  });

  it('prefers an explicit /ListNumbering over the label text', () => {
    const doc = Document.New();
    doc.AddMarkdown('- alpha\n- beta\n', { tagged: true });
    const l = doc.CreateStructTree().Children[0].Children.find((c) => c.Type === 'L')!;
    l.SetListAttributes({ listNumbering: 'Decimal' });
    const reopened = Document.Open(doc.Save());
    expect(lists(buildDocModel(reopened, reopened.Pages))[0].ordered).toBe(true);
  });
});

function codes(nodes: DocNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'code') out.push(n.text);
    else if (n.kind === 'container') codes(n.children, out);
    else if (n.kind === 'list') for (const it of n.items) codes(it.blocks, out);
  }
  return out;
}

describe('docmodel — tagged code blocks', () => {
  it('collapses /P > /Code to a code node', () => {
    const doc = tagged('```\nconst x = 1;\n```\n');
    expect(codes(buildDocModel(doc, doc.Pages))).toEqual(['const x = 1;']);
  });

  it('restores indentation from the NBSP preformat substituted', () => {
    const doc = tagged('```\nif (x) {\n    return 1;\n}\n```\n');
    const [text] = codes(buildDocModel(doc, doc.Pages));
    expect(text).toBe('if (x) {\n    return 1;\n}');
    expect(text).not.toContain('\u00A0');
  });

  it('keeps a code block inside a list item as the item’s own block', () => {
    const doc = tagged('- item\n\n  ```\n  x\n  ```\n');
    expect(codes(buildDocModel(doc, doc.Pages))).toEqual(['x']);
  });
});

/** The same Markdown rendered WITHOUT a structure tree. */
function untagged(src: string): Document {
  const doc = Document.New();
  doc.AddMarkdown(src, { gfm: true });
  return Document.Open(doc.Save());
}

describe('docmodel — untagged inference', () => {
  // Markers as real text at the left edge: the shape a third-party producer
  // emits, which is what docinfer.ts exists to read. See the helper's own note
  // on why these are not built with AddMarkdown.
  it('recovers a bullet list from page geometry', () => {
    const doc = Document.Open(buildBulletListPdf());
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l).toBeDefined();
    expect(l.ordered).toBe(false);
    expect(l.items).toHaveLength(2);
    expect(text(l.items[0].blocks)).toBe('alpha');
  });

  it('drops the marker from the item text', () => {
    const doc = Document.Open(buildBulletListPdf());
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(JSON.stringify(l)).not.toContain('\u2022');
  });

  it('recovers nesting from the marker indent', () => {
    const doc = Document.Open(buildNestedListPdf());
    const all = lists(buildDocModel(doc, doc.Pages));
    expect(all).toHaveLength(2);
    expect(all[0].items[0].blocks.some((b) => b.kind === 'list')).toBe(true);
    expect(text(all[1].items[0].blocks)).toBe('inner');
  });

  it('recovers an ordered list and its start', () => {
    const doc = Document.Open(buildOrderedListPdf());
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l.ordered).toBe(true);
    expect(l.start).toBe(3);
  });

  it('takes a wrapped continuation as part of its item, not a new block', () => {
    const doc = Document.Open(buildWrappedItemPdf());
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l.items).toHaveLength(1);
    expect(text(l.items[0].blocks)).toBe('a long item that wraps onto a second line');
  });

  it('leaves prose that opens with a year as a paragraph', () => {
    const doc = Document.Open(buildYearProsePdf());
    expect(lists(buildDocModel(doc, doc.Pages))).toEqual([]);
  });

  // These two go through our own renderer, which is legitimate for them: a
  // monospaced face and an ordinal marker are both ordinary text on the page.
  it('recovers a code block from its monospaced face', () => {
    const doc = untagged('```\nif (x) {\n    return 1;\n}\n```\n');
    expect(codes(buildDocModel(doc, doc.Pages))).toEqual(['if (x) {\n    return 1;\n}']);
  });

  it('recovers an ordered list our own renderer drew', () => {
    const doc = untagged('3. three\n4. four\n');
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l.ordered).toBe(true);
    expect(l.start).toBe(3);
    expect(l.items.map((i) => text(i.blocks))).toEqual(['three', 'four']);
  });

  // Our own BULLET lists stay unrecoverable, and that is the renderer's shape
  // rather than a gap here: flow.ts draws the bullet as vector geometry, so the
  // page carries no marker at all. Asserted so the limitation is measured rather
  // than assumed, and so this test fails loudly if flow.ts ever draws text.
  it('cannot recover our own vector-drawn bullets — a recorded limitation', () => {
    const doc = untagged('- alpha\n- beta\n');
    expect(lists(buildDocModel(doc, doc.Pages))).toEqual([]);
  });
});
