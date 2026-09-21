import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

/** `kk3q` — the Markdown half of `rfba`. A quote, list or code block nested
 *  past what the column can indent scales its indent down to the 12pt floor
 *  (`e1bp`) and renders; these cases pin that it now SAYS so, and that the two
 *  older placement-time compromises reach Markdown through the same channel.
 *
 *  Every case asserts on the strings a caller actually receives, which are
 *  `describeNotRendered`'s spelling of the HTML records: `squeezed`,
 *  `overflow`, `image:scaled-to-fit`. */

const quoted = (depth: number, body: string): string => '> '.repeat(depth) + body;

const count = (skipped: string[], s: string): number =>
  skipped.filter((x) => x === s).length;

describe('AddMarkdown reports a squeeze (kk3q)', () => {
  it('reports ONCE for one paragraph however many quote levels squeezed it', () => {
    // Quote depth 26 exhausts a default A4 column (e1bp); forty is well past
    // it, so a dozen or more levels scale their indent. They all forward to the
    // one paragraph, whose callback is one-shot.
    const { skipped } = Document.New().AddMarkdown(quoted(40, 'xyz'));
    expect(count(skipped, 'squeezed')).toBe(1);
  });

  it('reports one record per block squeezed, not one per document', () => {
    const { skipped } = Document.New().AddMarkdown(
      `${quoted(40, 'a')}\n${'>'.repeat(40)}\n${quoted(40, 'b')}`);
    expect(count(skipped, 'squeezed')).toBe(2);
  });

  it('reports nothing for nesting the column can afford', () => {
    expect(Document.New().AddMarkdown(quoted(3, 'xyz')).skipped).toEqual([]);
  });

  it('reports a squeeze from nested lists', () => {
    // Each level a sub-list of the last: the item bodies are ListItemElements
    // and the nesting is ListBlockElements, so both decorators take part.
    const src = Array.from({ length: 70 }, (_, i) => `${'  '.repeat(i)}- item${i}`).join('\n');
    const { skipped } = Document.New().AddMarkdown(src);
    expect(count(skipped, 'squeezed')).toBeGreaterThan(0);
  });

  it("reports a list item's body AND its further block, each once", () => {
    // The nested-list case above cannot tell the two list decorators apart —
    // either alone satisfies "at least one". Here the first paragraph is the
    // item BODY (ListItemElement) and the second a further BLOCK
    // (ListBlockElement): two elements, two records, one from each.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const r = page.AddMarkdown('- a\n\n  b', [20, 20, 16, 700]);
    expect(count(r.skipped, 'squeezed')).toBe(2);
  });

  it("reports a code block squeezed by its OWN padding", () => {
    // No quote, no list: a rect too narrow for the block's horizontal padding.
    // 16pt of padding a side cannot fit a 30pt rect above the 12pt floor.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const r = page.AddMarkdown('```\nx\n```', [20, 20, 30, 700], { style: { code: { padding: 16 } } });
    expect(count(r.skipped, 'squeezed')).toBe(1);
  });

  it('reports no squeeze for content that draws nothing', () => {
    // All-Cyrillic in a Standard-14 face encodes to nothing: its loss is the
    // `text` record, and a squeeze around nothing is not a squeeze.
    const { skipped } = Document.New().AddMarkdown(quoted(40, 'При'));
    expect(count(skipped, 'squeezed')).toBe(0);
    expect(skipped).toContain('text');
  });

  it('reports through page.AddMarkdown, which places before it returns', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const r = page.AddMarkdown(quoted(40, 'xyz'), [20, 20, 400, 750]);
    expect(count(r.skipped, 'squeezed')).toBe(1);
  });

  it('reaches a Flow caller through onSkipped, since AddMarkdown returns before Render', () => {
    const late: string[] = [];
    const flow = Document.New().NewFlow();
    const { skipped } = flow.AddMarkdown(quoted(40, 'xyz'), { onSkipped: (s) => { late.push(s); } });
    // Nothing is placed yet, so nothing placement-time can be in the return.
    expect(skipped).toEqual([]);
    flow.Render();
    expect(late).toEqual(['squeezed']);
  });

  it('still calls onSkipped from doc.AddMarkdown, beside folding it in', () => {
    const late: string[] = [];
    const { skipped } = Document.New().AddMarkdown(quoted(40, 'xyz'), { onSkipped: (s) => { late.push(s); } });
    expect(late).toEqual(['squeezed']);
    expect(count(skipped, 'squeezed')).toBe(1);
  });

  it('refuses a non-function onSkipped before anything is allocated', () => {
    // The two placing entry points wrap the caller's sink in their own, so a
    // bad value would otherwise only throw once placement fired it — after the
    // pages were already in the document.
    const bad = { onSkipped: 42 as unknown as (s: string) => void };
    const doc = Document.New();
    expect(() => doc.AddMarkdown(quoted(40, 'xyz'), bad)).toThrow(TypeError);
    expect(doc.Pages).toHaveLength(0);
    const { page } = doc.AddPage(PageFormat.A4);
    expect(() => page.AddMarkdown('x', [20, 20, 400, 700], bad)).toThrow(TypeError);
    expect(() => doc.NewFlow().AddMarkdown('x', bad)).toThrow(TypeError);
  });

  it('reports an element drawn past the column bottom as overflow', () => {
    // The zch2.16 compromise reaches Markdown through the same callback: a
    // single glyph taller than an empty A4 column cannot be split or scaled.
    const { skipped } = Document.New().AddMarkdown('W', { style: { fontSize: 900 } });
    expect(count(skipped, 'overflow')).toBe(1);
  });
});
