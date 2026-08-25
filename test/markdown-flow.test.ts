import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { markdownElements, type MarkdownFlowOptions } from '../src/mdflow.js';
import { placeElements } from '../src/flowplace.js';
import type { FlowElement } from '../src/flowelement.js';

const cs = (page: { Contents: Uint8Array }): string =>
  new TextDecoder('latin1').decode(page.Contents);

/** Render elements onto a fresh full-page rect and return the page. */
const render = (src: string, options: MarkdownFlowOptions = {}) => {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements, skipped } = markdownElements(src, { gfm: true, ...options });
  placeElements(doc, page, elements, [50, 50, 495, 742]);
  return { doc, page, skipped };
};

/** An element's measured height in a generous box. */
const h = (el: FlowElement): number =>
  el.measure!({ width: 400, availHeight: 500 }).usedHeight;

describe('markdownElements: blocks', () => {
  it('a paragraph becomes one element', () => {
    expect(markdownElements('hello').elements).toHaveLength(1);
  });

  it('headings take their level size and family', () => {
    const { elements } = markdownElements('# One\n\n### Three');
    // Default leading inside a text block is 1.2 * fontSize; sizes 24 and 14.
    expect(h(elements[0])).toBeCloseTo(24 * 1.2, 6);
    expect(h(elements[1])).toBeCloseTo(14 * 1.2, 6);
  });

  it('a thematic break becomes a rule of the styled thickness', () => {
    const { page } = render('a\n\n---\n\nb', { style: { rule: { thickness: 2 } } });
    expect(cs(page)).toMatch(/ 2 re\nf\n/);
  });

  it('a fenced code block preserves indentation, read back through extraction', () => {
    const { page } = render('```\nif (x) {\n    return 1;\n}\n```');
    const text = page.GetText();
    // Spelled with an explicit escape, never a literal: a leading run is
    // protected as U+00A0 while an interior single space is left real, and the
    // two are indistinguishable in source. Extraction is outside the code path
    // that emitted them, so this pins both halves of the preformat rule.
    expect(text).toContain(`${'\u00a0'.repeat(4)}return 1;`);
    expect(text).not.toContain('    return');
  });

  it('a code block drops the single trailing newline the AST carries', () => {
    // The AST literal for a one-line block is "a\n"; emitting it verbatim adds a
    // blank line at the bottom of EVERY code block. Asserted absolutely rather
    // than as a delta between block sizes — a trailing blank line shifts every
    // measurement by the same amount, so deltas cannot see it at all.
    const style = { code: { fontSize: 10, padding: 0 } }; // leading = 1.2 * 10
    const height = (src: string) => h(markdownElements(src, { style }).elements[0]);
    expect(height('```\na\n```')).toBeCloseTo(12, 6);
    expect(height('```\na\nb\n```')).toBeCloseTo(24, 6);
  });

  it('a block quote indents and bars its children', () => {
    const { page } = render('> quoted text\n>\n> second para');
    const s = cs(page);
    expect(s).toMatch(/50 \d+(\.\d+)? 3 \d/);              // a bar at the rect's left edge
    expect(s).toMatch(/(6[6-9]|7[0-2])(\.\d+)? \d+(\.\d+)? Td/); // text indented ~17.6pt
  });

  // Read through GetPaths rather than the content stream: the vector extractor
  // is outside the code path that emitted the bar, so it cannot agree with a
  // bug by construction. cs() above pins the operators; this pins the geometry.
  it('a nested quote composes two indents and two bars', () => {
    const { page } = render('> outer\n>\n> > inner');
    const bars = page.GetPaths().filter((p) => p.fill !== null && p.bbox[2] - p.bbox[0] < 6);
    expect(bars.length).toBeGreaterThanOrEqual(2);
    const xs = [...new Set(bars.map((p) => Math.round(p.bbox[0])))].sort((a, b) => a - b);
    expect(xs.length).toBeGreaterThanOrEqual(2);
    expect(xs[0]).toBe(50);              // the outer bar at the rect edge
    // The inner bar is one quote indent (11 * 1.6 = 17.6pt) further in. Asserted
    // as a range, not a rounded equality: the point is that it composed, and a
    // half-point tolerance on a rounded value is a flake waiting to happen.
    expect(xs[1] - xs[0]).toBeGreaterThan(10);
    expect(xs[1] - xs[0]).toBeLessThan(25);
  });

  it('accepts an already parsed tree, so a caller need not re-parse', async () => {
    const { parseMarkdown } = await import('../src/markdown.js');
    const tree = parseMarkdown('# Title');
    expect(markdownElements(tree).elements).toHaveLength(1);
  });

  it('reports raw HTML without dropping the rest', () => {
    // The table renders as of gl6o.3.3, so it contributes an element and names
    // itself nowhere; raw HTML remains out of scope and still reports.
    const { elements, skipped } = markdownElements(
      'before\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<div>x</div>\n\nafter',
      { gfm: true });
    expect(skipped).toEqual(['html_block']);
    expect(elements).toHaveLength(3); // before, table, after
  });

  it('never throws on any input', () => {
    for (const src of ['', '   ', '#', '```', '> > > >', ' ', '![](']) {
      expect(() => markdownElements(src, { gfm: true })).not.toThrow();
    }
  });

  it('validates its style before building anything', () => {
    expect(() => markdownElements('x', { style: { fontSize: -1 } })).toThrow(TypeError);
  });
});

describe('markdownElements: lists', () => {
  it('a bullet list lowers to one element per item', () => {
    expect(markdownElements('- a\n- b\n- c').elements).toHaveLength(3);
  });

  it('an ordered list carries its start ordinal', () => {
    const { page } = render('5. five\n6. six');
    expect(page.GetText()).toContain('5.');
    expect(page.GetText()).toContain('6.');
  });

  it('a multi-paragraph item lowers to a body plus a block', () => {
    // A loose item: two paragraphs in one list item.
    expect(markdownElements('- first\n\n  second').elements).toHaveLength(2);
  });

  it('a nested list composes indents rather than restarting at the margin', () => {
    const { page } = render('- outer\n  - inner');
    const xs = [...cs(page).matchAll(/\n(\d+(?:\.\d+)?) \d+(?:\.\d+)? Td/g)].map((m) => Number(m[1]));
    expect(xs.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...xs)).toBeGreaterThan(Math.min(...xs));
  });

  it('a code block inside an item still draws the item marker', () => {
    const { page } = render('- item text\n\n  ```\n  code\n  ```');
    expect(page.GetText()).toContain('code');
  });

  it('an item whose first block is a code block draws a marker', () => {
    const { page } = render('-     indented code\n');
    expect(cs(page)).toMatch(/ re\nf\n/); // the vector bullet
  });

  // The AST field no HTML rendering can see, and the reason mdast.ts records it.
  it('a loose list spaces its items more widely than a tight one', () => {
    const height = (src: string) => {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.A4);
      const { elements } = markdownElements(src);
      return placeElements(doc, page, elements, [50, 50, 495, 742]).usedHeight;
    };
    expect(height('- a\n\n- b')).toBeGreaterThan(height('- a\n- b'));
  });

  it('a task list draws checkboxes and distinguishes checked from unchecked', () => {
    const un = render('- [ ] todo').page;
    const on = render('- [x] done').page;
    expect(cs(on).length).toBeGreaterThan(cs(un).length);
  });

  it('an empty item renders nothing and does not throw', () => {
    const { elements } = markdownElements('-\n- b');
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    expect(() => placeElements(doc, page, elements, [50, 50, 495, 742])).not.toThrow();
  });
});

import { buildPngRgb } from './helpers/build-embed-images.js';

/** buildPngRgb() as a base64 data: URI. */
const dataUri = (): string =>
  `data:image/png;base64,${Buffer.from(buildPngRgb()).toString('base64')}`;

describe('markdownElements: images', () => {
  it('a paragraph holding only an image becomes an image block', () => {
    const { elements, skipped } = markdownElements(`![a cat](${dataUri()})`);
    expect(elements).toHaveLength(1);
    expect(skipped).toEqual([]);
    // An image element measures by aspect, not by leading: 2x1 at 400 wide.
    expect(h(elements[0])).toBeCloseTo(200, 6);
  });

  it('resolves a plain destination through the callback', () => {
    const seen: string[] = [];
    const { elements, skipped } = markdownElements('![cat](cat.png "T")', {
      resolveImage: (d, t) => { seen.push(`${d}|${t}`); return buildPngRgb(); },
    });
    expect(seen).toEqual(['cat.png|T']);
    expect(skipped).toEqual([]);
    expect(elements).toHaveLength(1);
  });

  it('an unresolved destination falls back to alt text and reports itself', () => {
    const { elements, skipped } = markdownElements('![a cat](missing.png)');
    expect(skipped).toEqual(['image:missing.png']);
    expect(elements).toHaveLength(1);
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    placeElements(doc, page, elements, [50, 50, 495, 742]);
    expect(page.GetText()).toContain('a cat');
  });

  it('undecodable bytes report and fall back rather than throwing', () => {
    const { skipped } = markdownElements('![alt](x.png)', {
      resolveImage: () => new Uint8Array([1, 2, 3]),
    });
    expect(skipped).toEqual(['image:x.png']);
  });

  it('an image beside other content stays inline: alt text, reported once', () => {
    const { elements, skipped } = markdownElements(`see ![a cat](${dataUri()}) here`);
    expect(elements).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    placeElements(doc, page, elements, [50, 50, 495, 742]);
    expect(page.GetText()).toContain('see a cat here');
  });

  it('surrounding whitespace does not stop the lift', () => {
    expect(markdownElements(`  ![x](${dataUri()})  `).skipped).toEqual([]);
  });

  it('carries the alt text onto the figure', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, tagged: true });
    const { elements } = markdownElements(`![the alt](${dataUri()})`);
    for (const el of elements) (flow as never as { items: unknown[] }).items.push(el);
    flow.Render();
    const alts: (string | undefined)[] = [];
    const walk = (el: import('../src/struct.js').StructElement): void => {
      if (el.Type === 'Figure') alts.push(el.Alt);
      for (const kid of el.Children) walk(kid);
    };
    for (const kid of doc.GetStructTree()!.Children) walk(kid);
    expect(alts).toEqual(['the alt']);
  });
});
