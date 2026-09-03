/** Text the resolved face cannot encode is REPORTED, not silently dropped
 *  (zch2.14). The Standard-14 fallback has no WinAnsi code for Cyrillic, so
 *  with no registered font folder such a paragraph draws as nothing. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { Undrawable } from '../src/textcoverage.js';
import { describe as describeReport } from '../src/htmlreport.js';

const NONE = 'При';

describe('the Flow builders fire onUndrawable', () => {
  it('reports a paragraph that draws nothing, as all', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph(NONE, { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toEqual([{ lost: 'При', all: true }]);
  });

  it('reports a paragraph that loses only some characters, as NOT all', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph(`alpha ${NONE} omega`, { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toEqual([{ lost: 'При', all: false }]);
  });

  it('says NOTHING for a paragraph the face draws in full', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph('all fine', { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toEqual([]);
  });

  it('fires EXACTLY ONCE for a paragraph, not once per measure', () => {
    // The engine measures speculatively many times per element; a sink fired
    // from measure would report a handful of duplicates for one paragraph.
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph(NONE, { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toHaveLength(1);
  });

  it('reports a heading and a list item', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddHeading(1, NONE, { onUndrawable: (u) => seen.push(u) });
    flow.AddList([NONE], { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toHaveLength(2);
    expect(seen.every((u) => u.all)).toBe(true);
  });

  it('reports a code block', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddCodeBlock(NONE, { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toEqual([{ lost: 'При', all: true }]);
  });
});

describe('a sink that throws', () => {
  it('PROPAGATES rather than being swallowed', () => {
    // resolveImage's documented rule: a throw from a caller's own callback is
    // the caller's bug, not a missing resource. Swallowing it would hide a
    // defect in the one place a caller asked to be told about things.
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    // Note WHERE it throws: the sink fires at BUILD time, inside the builder
    // that AddParagraph delegates to — not during Render().
    expect(() => flow.AddParagraph(NONE, {
      onUndrawable: () => { throw new Error('caller bug'); },
    })).toThrow('caller bug');
  });
});

describe('the page-level calls fire onUndrawable', () => {
  it('reports from AddTextBlock', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(NONE, [50, 50, 300, 300], { onUndrawable: (u) => seen.push(u) });
    expect(seen).toEqual([{ lost: 'При', all: true }]);
  });

  it('reports from AddText', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddText(NONE, 50, 50, { onUndrawable: (u) => seen.push(u) });
    expect(seen).toEqual([{ lost: 'При', all: true }]);
  });
});

describe('AddHtml reports undrawable text', () => {
  it('reports a wholly undrawable paragraph as dropped, naming its element', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml(`<p>${NONE}</p>`);
    const t = skipped.filter((r) => r.construct === 'text');
    expect(t).toHaveLength(1);
    expect(t[0].kind).toBe('dropped');
    expect(t[0].detail).toBe('При');
    expect(t[0].el?.name).toBe('p');
  });

  it('reports a partly undrawable paragraph as DEGRADED', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml(`<p>alpha ${NONE} omega</p>`);
    const t = skipped.filter((r) => r.construct === 'text');
    expect(t).toHaveLength(1);
    expect(t[0].kind).toBe('degraded');
    expect(t[0].detail).toBe('При');
  });

  it('says nothing for a document the fallback face draws in full', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml('<p>all fine</p>');
    expect(skipped.filter((r) => r.construct === 'text')).toEqual([]);
  });

  it('flattens to a loggable string through describeNotRendered', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml(`<p>${NONE}</p>`);
    expect(skipped.map(describeReport)).toContain('text:При');
  });

  it('reports the same records through all three entry points', () => {
    const src = `<p>${NONE}</p>`;
    const viaDoc = Document.New().AddHtml(src).skipped;
    const flowDoc = Document.New();
    const flow = flowDoc.NewFlow({ format: PageFormat.A4 });
    const viaFlow = flow.AddHtml(src).skipped;
    const pageDoc = Document.New();
    const { page } = pageDoc.AddPage(PageFormat.A4);
    const viaPage = page.AddHtml(src, [72, 72, 451, 697]).skipped;
    const names = (rs: { construct: string; kind: string }[]) =>
      rs.map((r) => `${r.construct}/${r.kind}`);
    expect(names(viaFlow)).toEqual(names(viaDoc));
    expect(names(viaPage)).toEqual(names(viaDoc));
  });
});

describe('AddMarkdown reports undrawable text', () => {
  it("reports 'text' when nothing drew", () => {
    const doc = Document.New();
    expect(doc.AddMarkdown(NONE).skipped).toContain('text');
  });

  it("reports 'text:partial' when only some characters were lost", () => {
    const doc = Document.New();
    expect(doc.AddMarkdown(`alpha ${NONE} omega`).skipped).toContain('text:partial');
  });

  it('says nothing for a document the fallback face draws in full', () => {
    const doc = Document.New();
    expect(doc.AddMarkdown('all fine').skipped).toEqual([]);
  });

  it('reports a heading and a fenced code block too', () => {
    const doc = Document.New();
    const { skipped } = doc.AddMarkdown(`# ${NONE}\n\n\`\`\`\n${NONE}\n\`\`\``);
    expect(skipped.filter((s) => s === 'text')).toHaveLength(2);
  });
});

describe('table cells report undrawable text', () => {
  it('reports a cell whose text the face cannot draw, through AddHtml', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml(`<table><tr><td>${NONE}</td><td>ok</td></tr></table>`);
    const t = skipped.filter((r) => r.construct === 'text');
    expect(t).toHaveLength(1);
    expect(t[0].kind).toBe('dropped');
    expect(t[0].detail).toBe('При');
  });

  it('reports a Markdown table cell', () => {
    const doc = Document.New();
    const src = `| a | b |\n| --- | --- |\n| ${NONE} | ok |`;
    expect(doc.AddMarkdown(src, { gfm: true }).skipped).toContain('text');
  });

  it('says nothing for a table the face draws in full', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml('<table><tr><td>ok</td></tr></table>');
    expect(skipped.filter((r) => r.construct === 'text')).toEqual([]);
  });
});
