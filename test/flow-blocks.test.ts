import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { rule } from '../src/flowblock.js';

/** A page's content stream as latin1 text, for operator assertions. */
const cs = (page: { Contents: Uint8Array }): string =>
  new TextDecoder('latin1').decode(page.Contents);

describe('rule', () => {
  it('consumes exactly its thickness and paints a filled rect', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = rule({ thickness: 2, color: [0, 0, 0] });
    const res = el.place({ doc, page, x: 20, top: 400, width: 200, availHeight: 300 });
    expect(res.drew).toBe(true);
    expect(res.remainder).toBeNull();
    expect(res.usedHeight).toBeCloseTo(2, 6);
    // The rect sits with its top at the pen: y = 400 - 2.
    expect(cs(page)).toMatch(/20 398 200 2 re/);
  });

  it('defaults to the full region width, and honours an explicit width + align', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = rule({ thickness: 1, width: 50, align: 'center' });
    el.place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300 });
    // centred in [100, 300): 100 + (200 - 50) / 2 = 175
    expect(cs(page)).toMatch(/175 399 50 1 re/);
  });

  it('does not draw when the remaining height is too small, and retries whole', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = rule({ thickness: 4 });
    const res = el.place({ doc, page, x: 20, top: 400, width: 200, availHeight: 2 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBe(el);
    expect(cs(page)).toBe('');
  });

  it('measures the same height it places', () => {
    const [el] = rule({ thickness: 3 });
    expect(el.measure!({ width: 200, availHeight: 300 })).toEqual({ usedHeight: 3, fits: true });
    expect(el.measure!({ width: 200, availHeight: 1 })).toEqual({ usedHeight: 0, fits: false });
  });

  it('validates before building anything', () => {
    expect(() => rule({ thickness: -1 })).toThrow(TypeError);
    expect(() => rule({ thickness: 0 })).toThrow(TypeError);
    expect(() => rule({ width: 0 })).toThrow(TypeError);
    expect(() => rule({ color: [2, 0, 0] })).toThrow(TypeError);
    expect(() => rule({ align: 'middle' as never })).toThrow(TypeError);
    expect(() => rule({ spaceBefore: -1 })).toThrow(TypeError);
  });

  it('Flow.AddRule is chainable and draws through the engine', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    expect(flow.AddParagraph('above').AddRule({ thickness: 1 }).AddParagraph('below')).toBe(flow);
    const page = flow.Render()[0];
    expect(cs(page)).toMatch(/ 1 re\nf\n/);
  });
});

import { codeBlock, preformat } from '../src/flowblock.js';
import { encodeWinAnsi } from '../src/encoding.js';
import { measure } from '../src/metrics.js';

const NBSP = '\u00a0';

describe('preformat', () => {
  it('protects the spaces the engine would eat: a leading run, and any run of 2+', () => {
    expect(preformat('a  b', 4)).toBe(`a${NBSP}${NBSP}b`);
    expect(preformat('  indented', 4)).toBe(`${NBSP}${NBSP}indented`);
  });

  it('leaves a single interior space alone, so copied code has real spaces', () => {
    expect(preformat('return 1;', 4)).toBe('return 1;');
    expect(preformat('    return 1;', 4)).toBe(`${NBSP.repeat(4)}return 1;`);
  });

  it('expands tabs to the next multiple of tabWidth, per line', () => {
    expect(preformat('a\tb', 4)).toBe(`a${NBSP.repeat(3)}b`);        // col 1 -> col 4
    expect(preformat('ab\tc', 4)).toBe(`ab${NBSP.repeat(2)}c`);      // col 2 -> col 4
    expect(preformat('abcd\te', 4)).toBe(`abcd${NBSP.repeat(4)}e`);  // col 4 -> col 8
    // The column counter restarts on each line.
    expect(preformat('ab\n\tc', 4)).toBe(`ab\n${NBSP.repeat(4)}c`);
  });

  // This is the load-bearing fact the whole approach rests on, so it is asserted
  // against the tables rather than assumed from the code that reads them.
  it('U+00A0 encodes to WinAnsi 0xA0 and advances exactly like a space', () => {
    expect(Array.from(encodeWinAnsi(NBSP))).toEqual([0xa0]);
    for (const font of ['Helvetica', 'Courier', 'Times-Roman'] as const) {
      expect(measure(font, encodeWinAnsi(NBSP), 10))
        .toBe(measure(font, encodeWinAnsi(' '), 10));
    }
  });
});

describe('codeBlock', () => {
  it('preserves indentation through a real render', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddCodeBlock('if (x) {\n    return 1;\n}');
    const page = flow.Render()[0];
    // Read the RESULT, not the emitter: extraction is outside the code path
    // that produced it, so a collapsed run of spaces cannot hide here.
    const text = page.GetText();
    // The indent survives...
    expect(text).toContain(`${NBSP.repeat(4)}return`);
    // ...and the space inside the line is a REAL space, so the block copies out
    // as usable code rather than as no-break spaces.
    expect(text).toContain('return 1;');
  });

  it('keeps an interior run of spaces at full width', () => {
    // The engine collapses `a    b` to `a b`; protected, all four survive.
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddCodeBlock('a    b');
    expect(flow.Render()[0].GetText()).toContain(`a${NBSP.repeat(4)}b`);
  });

  it('one source line per emitted line, plus padding', () => {
    const [el] = codeBlock('one\ntwo\nthree', { fontSize: 10, leading: 12, padding: 3 });
    const m = el.measure!({ width: 400, availHeight: 400 });
    expect(m.usedHeight).toBeCloseTo(3 * 12 + 2 * 3, 6);
    expect(m.fits).toBe(true);
  });

  it('paints its background before its text', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = codeBlock('x', { fontSize: 10, leading: 12, padding: 4, background: [0.9, 0.9, 0.9] });
    el.place({ doc, page, x: 20, top: 400, width: 200, availHeight: 300 });
    const s = cs(page);
    const bg = s.indexOf(' re\nf\n');
    const tj = s.indexOf('Tj');
    expect(bg).toBeGreaterThanOrEqual(0);
    expect(tj).toBeGreaterThan(bg); // text composites over the fill
  });

  it('splits between lines when the column runs out', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = codeBlock('one\ntwo\nthree\nfour', { fontSize: 10, leading: 12, padding: 0 });
    const res = el.place({ doc, page, x: 20, top: 400, width: 200, availHeight: 24 });
    expect(res.drew).toBe(true);
    expect(res.usedHeight).toBeCloseTo(24, 6);
    expect(res.remainder).not.toBeNull();
    const rest = res.remainder!.measure!({ width: 200, availHeight: 400 });
    expect(rest.usedHeight).toBeCloseTo(24, 6); // the other two lines
  });

  it('validates before building anything', () => {
    expect(() => codeBlock(5 as never)).toThrow(TypeError);
    expect(() => codeBlock('x', { fontSize: 0 })).toThrow(TypeError);
    expect(() => codeBlock('x', { padding: -1 })).toThrow(TypeError);
    expect(() => codeBlock('x', { tabWidth: 0 })).toThrow(TypeError);
    expect(() => codeBlock('x', { background: [0, 0, 5] })).toThrow(TypeError);
  });

  it('Flow.AddCodeBlock is chainable', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    expect(flow.AddCodeBlock('x')).toBe(flow);
  });
});

import { quote } from '../src/flowblock.js';
import { paragraph } from '../src/flow.js';

describe('quote', () => {
  it('lowers to one element per child, not one container', () => {
    const els = quote([...paragraph('a'), ...paragraph('b'), ...codeBlock('c')]);
    expect(els).toHaveLength(3);
  });

  it('indents its children and narrows their width', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = quote([...paragraph('hello', { fontSize: 10, leading: 12 })], { indent: 20 });
    el.place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300 });
    // A text block positions its first line with `<x> <baseline> Td`.
    expect(cs(page)).toMatch(/120 \d+(\.\d+)? Td/);
  });

  it('paints a bar in the gutter, spanning the element and the gap below it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = quote(
      [...paragraph('a', { fontSize: 10, leading: 12, spaceAfter: 6 }),
        ...paragraph('b', { fontSize: 10, leading: 12 })],
      { indent: 20, bar: { width: 3, color: [0.5, 0.5, 0.5] } },
    );
    els[0].place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300, paragraphSpacing: 4 });
    // 12 used + 6 spaceAfter + 4 paragraphSpacing = 22 tall, top at 400.
    expect(cs(page)).toMatch(/100 378 3 22 re/);
  });

  it("the last child's bar stops at its own bottom", () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = quote([...paragraph('a', { fontSize: 10, leading: 12 })], { indent: 20 });
    els[0].place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300, paragraphSpacing: 4 });
    expect(cs(page)).toMatch(/100 388 3 12 re/);
  });

  it('clamps the bar to the region bottom rather than the margin', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = quote(
      [...paragraph('a', { fontSize: 10, leading: 12, spaceAfter: 50 }),
        ...paragraph('b', { fontSize: 10, leading: 12 })],
      { indent: 20 },
    );
    // Only 12pt of room below the pen: the bar may not extend past 400 - 12.
    els[0].place({ doc, page, x: 100, top: 400, width: 200, availHeight: 12, paragraphSpacing: 4 });
    expect(cs(page)).toMatch(/100 388 3 12 re/);
  });

  it('nests: two bars at two indents', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const inner = quote([...paragraph('deep', { fontSize: 10, leading: 12 })], { indent: 20 });
    const outer = quote(inner, { indent: 20 });
    outer[0].place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300 });
    const s = cs(page);
    expect(s).toMatch(/100 388 3 12 re/); // outer bar at x = 100
    expect(s).toMatch(/120 388 3 12 re/); // inner bar at x = 100 + 20
    expect(s).toMatch(/140 \d+(\.\d+)? Td/); // text at x = 100 + 20 + 20
  });

  it('carries the indent and the bar into a continuation', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const [el] = quote([...paragraph(long, { fontSize: 10, leading: 12 })], { indent: 20 });
    const res = el.place({ doc, page, x: 100, top: 400, width: 200, availHeight: 24 });
    expect(res.drew).toBe(true);
    expect(res.remainder).not.toBeNull();
    const before = cs(page).length;
    res.remainder!.place({ doc, page, x: 100, top: 700, width: 200, availHeight: 300 });
    const after = cs(page).slice(before);
    expect(after).toMatch(/120 \d+(\.\d+)? Td/); // still indented
    expect(after).toMatch(/100 \d+(\.\d+)? 3 /); // still barred
  });

  it('bar: false draws no bar', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = quote([...paragraph('a', { fontSize: 10, leading: 12 })], { bar: false });
    el.place({ doc, page, x: 100, top: 400, width: 200, availHeight: 300 });
    expect(cs(page)).not.toMatch(/ re\nf\n/);
  });

  it('validates before building anything', () => {
    expect(() => quote('nope' as never)).toThrow(TypeError);
    expect(() => quote([{} as never])).toThrow(TypeError);
    expect(() => quote([...paragraph('a')], { indent: -1 })).toThrow(TypeError);
    expect(() => quote([...paragraph('a')], { bar: { width: -1 } })).toThrow(TypeError);
    expect(() => quote([...paragraph('a')], { bar: { color: [0, 0, 2] } })).toThrow(TypeError);
  });

  it('Flow.AddQuote is chainable', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    expect(flow.AddQuote([...paragraph('quoted')])).toBe(flow);
  });
});

import { list } from '../src/flow.js';

describe('list items holding blocks', () => {
  it('lowers an item to its body plus its blocks, all at one indent', () => {
    const els = list([
      { text: 'intro', blocks: [...paragraph('second paragraph'), ...codeBlock('x')] },
      'plain',
    ]);
    expect(els).toHaveLength(4); // body + 2 blocks + the plain item
  });

  it('indents every element of the item equally', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = list([{ text: 'intro', blocks: [...paragraph('more')] }],
      { fontSize: 10, leading: 12, indent: 30 });
    els[0].place({ doc, page, x: 100, top: 400, width: 300, availHeight: 300 });
    const afterBody = cs(page).length;
    els[1].place({ doc, page, x: 100, top: 380, width: 300, availHeight: 300 });
    expect(cs(page).slice(0, afterBody)).toMatch(/130 \d+(\.\d+)? Td/);
    expect(cs(page).slice(afterBody)).toMatch(/130 \d+(\.\d+)? Td/);
  });

  it('draws the marker exactly once across the item, on the first element', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = list([{ text: 'intro', blocks: [...paragraph('more')] }],
      { fontSize: 10, leading: 12, indent: 30, bullet: '*' });
    for (const el of els) el.place({ doc, page, x: 100, top: 400, width: 300, availHeight: 300 });
    const marks = cs(page).match(/\(\*\) Tj/g) ?? [];
    expect(marks).toHaveLength(1);
  });

  // The case a private markerDrawn flag silently gets wrong.
  it('an item with no text draws its marker on its first block', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = list([{ blocks: [...codeBlock('code first')] }],
      { fontSize: 10, indent: 30, bullet: '*' });
    expect(els).toHaveLength(1);
    els[0].place({ doc, page, x: 100, top: 400, width: 300, availHeight: 300 });
    expect(cs(page)).toMatch(/\(\*\) Tj/);
  });

  it('a block that paginates keeps the indent and does not redraw the marker', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = list([{ blocks: [...codeBlock('a\nb\nc\nd', { fontSize: 10, leading: 12, padding: 0 })] }],
      { fontSize: 10, indent: 30, bullet: '*' });
    const res = el.place({ doc, page, x: 100, top: 400, width: 300, availHeight: 24 });
    expect(res.remainder).not.toBeNull();
    const before = cs(page).length;
    res.remainder!.place({ doc, page, x: 100, top: 700, width: 300, availHeight: 300 });
    const after = cs(page).slice(before);
    expect(after).toMatch(/130 \d+(\.\d+)? Td/);
    expect(after).not.toMatch(/\(\*\) Tj/);
  });

  it('a quote nested inside a list item composes both indents', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = list([{ text: 'item', blocks: quote([...paragraph('quoted', { fontSize: 10, leading: 12 })], { indent: 20 }) }],
      { fontSize: 10, leading: 12, indent: 30 });
    els[1].place({ doc, page, x: 100, top: 400, width: 300, availHeight: 300 });
    expect(cs(page)).toMatch(/150 \d+(\.\d+)? Td/); // 100 + 30 (list) + 20 (quote)
  });

  it('rejects an item with neither text nor blocks', () => {
    expect(() => list([{} as never])).toThrow(TypeError);
    expect(() => list([{ blocks: 'nope' as never }])).toThrow(TypeError);
    expect(() => list([{ blocks: [{} as never] }])).toThrow(TypeError);
  });
});

describe('checkbox markers', () => {
  const render = (marker: 'checkbox' | 'checked') => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = list([{ text: 'task', marker }], { fontSize: 10, leading: 12, indent: 30 });
    el.place({ doc, page, x: 100, top: 400, width: 300, availHeight: 300 });
    return cs(page);
  };

  it('draws an unfilled box for an unchecked item and adds a check when checked', () => {
    const un = render('checkbox');
    const on = render('checked');
    expect(un).toMatch(/ re\n/);  // the box outline
    expect(un).toMatch(/S\n/);    // stroked, not filled
    // The check is two extra stroked segments, so the checked form is longer.
    expect(on.length).toBeGreaterThan(un.length);
    expect(on).toMatch(/ l\n/);   // line segments
  });

  it('reserves a wider gutter than a bullet', () => {
    const [box] = list([{ text: 'task', marker: 'checkbox' }], { fontSize: 10, leading: 12 });
    const [dot] = list(['task'], { fontSize: 10, leading: 12 });
    // A wider marker means a wider auto indent, so the body wraps sooner.
    const w = (el: import('../src/flowelement.js').FlowElement) =>
      el.measure!({ width: 60, availHeight: 400 }).usedHeight;
    expect(w(box)).toBeGreaterThanOrEqual(w(dot));
  });

  it('carries the ballot-box character as /Lbl actual text when tagged', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    flow.AddList([{ text: 'done', marker: 'checked' }, { text: 'todo', marker: 'checkbox' }]);
    flow.Render();
    // The tree is cyclic (kids link back to parents), so walk it rather than
    // serializing it.
    const labels: (string | undefined)[] = [];
    const walk = (el: import('../src/struct.js').StructElement): void => {
      if (el.Type === 'Lbl') labels.push(el.ActualText);
      for (const kid of el.Children) walk(kid);
    };
    // The root is a StructTreeRoot, not a StructElement; its Children are.
    for (const kid of doc.GetStructTree()!.Children) walk(kid);
    expect(labels).toEqual(['\u2611', '\u2610']);
  });

  it('rejects an unknown marker name', () => {
    expect(() => list([{ text: 'x', marker: 'star' as never }])).toThrow(TypeError);
  });
});
