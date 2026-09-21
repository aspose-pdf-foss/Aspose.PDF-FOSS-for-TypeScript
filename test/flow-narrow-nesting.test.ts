import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { list, paragraph, quote } from '../src/flow.js';
import { MIN_CONTENT_WIDTH, insetScale } from '../src/flowelement.js';

/** `e1bp`. Every decorator that indents — a quote, a list item, a list item's
 *  further blocks, a code block's padding, a CSS box's margins and insets —
 *  used to subtract its inset with no floor, so deep nesting drove the content
 *  width to zero. Two failure modes came out of that one cause, and they are
 *  DIFFERENT, which is why both halves are asserted here:
 *
 *   - Markdown THREW `TypeError: rect width and height must be positive` from
 *     inside `stamp.ts`, at quote depth 26 and list depth 49 on a default A4
 *     flow — a bare painter error rather than a degraded render.
 *   - HTML rendered a BLANK PAGE and said nothing, from depth 8: a
 *     `<blockquote>` carries a 40px margin on BOTH sides, so each level eats
 *     60pt of a 451pt column, and `BoxElement` reads a non-positive width as
 *     "nothing to draw".
 *
 *  Every case asserts the text is EXTRACTABLE, never merely that nothing threw
 *  — the HTML half passed a does-not-throw assertion with the defect in place. */

const textOf = (doc: Document): string =>
  doc.Pages.map((p) => p.GetText()).join('\n');

/** The one fragment on page 1 whose text is `t`, so a positional assertion
 *  names what it is measuring rather than indexing draw order. */
function fragment(doc: Document, t: string): { quad: readonly number[] } {
  const hits = doc.Pages[0].GetTextFragments().filter((f) => f.text === t);
  expect(hits, `fragments for ${JSON.stringify(t)}`).toHaveLength(1);
  return hits[0];
}

describe('insetScale (e1bp)', () => {
  it('gives the whole inset when the width can afford it', () => {
    expect(insetScale(100, 20)).toBe(1);
    // Exactly affordable: the content lands ON the floor, which is allowed.
    expect(insetScale(100, 100 - MIN_CONTENT_WIDTH)).toBe(1);
  });

  it('scales the inset down to whatever room is left above the floor', () => {
    // 30 wanted, only 18 available: half of it fits.
    expect(insetScale(MIN_CONTENT_WIDTH + 18, 36)).toBeCloseTo(0.5, 12);
  });

  it('gives NO inset at all once the width is at or below the floor', () => {
    // A decorator must never make an already-narrow box narrower — that is
    // what keeps a positive width positive however deep the nesting goes.
    expect(insetScale(MIN_CONTENT_WIDTH, 20)).toBe(0);
    expect(insetScale(MIN_CONTENT_WIDTH / 2, 20)).toBe(0);
    expect(insetScale(0.5, 20)).toBe(0);
  });

  it('is 1 for a zero or negative inset, so nothing divides by zero', () => {
    expect(insetScale(4, 0)).toBe(1);
    expect(insetScale(4, -3)).toBe(1);
  });

  it('never leaves less than the floor, at any depth, from any start', () => {
    // The property the whole fix rests on: applying the rule repeatedly
    // converges rather than reaching zero.
    for (const start of [451.28, 100, 20, 12, 3]) {
      let w = start;
      for (let i = 0; i < 500; i++) w -= 17.6 * insetScale(w, 17.6);
      expect(w).toBeGreaterThan(0);
      expect(w).toBeGreaterThanOrEqual(Math.min(start, MIN_CONTENT_WIDTH) - 1e-9);
    }
  });
});

describe('a clamped decorator measures what it places (e1bp)', () => {
  it('a quote reports the same height it then draws', () => {
    // MEASURED: nothing in the end-to-end cases sees `measure` drift from
    // `place` — the engine consults a quote's `measure` only for the
    // keep-with-next lookahead and the empty-column degrade, neither of which
    // those documents reach. Asserted directly for that reason, since the two
    // reading one indent is this fix's whole reason for having an `indentFor`.
    //
    // The fixture has to DISCRIMINATE, and two earlier ones did not: with a
    // 500pt indent the unclamped width is -460 against a clamped 12, and with
    // an unbreakable word, or one word per line either way, the LINE COUNT is
    // the same at both widths — so the heights agree whatever the code does.
    // What separates them is text small enough that the clamped width fits the
    // whole line and the unclamped one does not: 38pt of indent in a 40pt
    // region leaves 2pt unclamped against 12pt clamped, and 'i i i i' at 3pt
    // is one line at 12 and four at 2.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.custom(200, 400));
    const [el] = quote(paragraph('i i i i', { fontSize: 3, leading: 4 }), { indent: 38 });
    const m = el.measure?.({ width: 40, availHeight: 300 });
    const r = el.place({ doc, page, x: 80, top: 320, width: 40, availHeight: 300 });
    expect(r.usedHeight).toBeCloseTo(4, 6);        // one line, not four
    expect(m?.usedHeight).toBeCloseTo(r.usedHeight, 6);
  });

  it('a list item reports the same height it then draws, text or blocks', () => {
    // The same rule at the other two sites, with the same fixture shape. Both
    // are asserted because each has its own `indentFor` call in its own
    // `measure`, and one site reading `this.indent` is invisible to the other.
    const body = { fontSize: 3, leading: 4 } as const;
    for (const [what, items] of [
      ['text', ['i i i i']],
      ['blocks', [{ blocks: paragraph('i i i i', body) }]],
    ] as [string, Parameters<typeof list>[0]][]) {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.custom(200, 400));
      const [el] = list(items, { indent: 38, ...body });
      const m = el.measure?.({ width: 40, availHeight: 300 });
      const r = el.place({ doc, page, x: 80, top: 320, width: 40, availHeight: 300 });
      expect(r.usedHeight, what).toBeCloseTo(4, 6);
      expect(m?.usedHeight, what).toBeCloseTo(r.usedHeight, 6);
    }
  });
});

describe('Markdown that nests past the column width still renders (e1bp)', () => {
  it('draws a quote nested far past the point the indent exhausts the column', () => {
    // 26 is where it threw; 100 is well past the point every level is clamped
    // to no indent at all.
    for (const depth of [25, 26, 40, 100]) {
      const doc = Document.New();
      doc.AddMarkdown('>'.repeat(depth) + ' xyz');
      expect(textOf(doc), `quote depth ${depth}`).toContain('xyz');
    }
  });

  it('draws every item of a list nested past the column width', () => {
    for (const depth of [48, 49, 80]) {
      const doc = Document.New();
      const src = Array.from({ length: depth }, (_, i) => '  '.repeat(i) + `- i${i}`).join('\n');
      doc.AddMarkdown(src);
      const text = textOf(doc);
      // The deepest items are the ones the clamp carries, so assert the LAST
      // one rather than a count: a case that only counts lines passes on a
      // build that drops the tail and wraps the head instead.
      expect(text, `list depth ${depth}`).toContain(`i${depth - 1}`);
      expect(text).toContain('i0');
    }
  });

  it('draws a code block inside quotes that have exhausted the column', () => {
    // The code block subtracts its own padding from what the quotes left, so
    // it is the one element that can be squeezed by TWO rules at once.
    for (const depth of [25, 26, 60]) {
      const doc = Document.New();
      const p = '>'.repeat(depth) + ' ';
      doc.AddMarkdown(`${p}\`\`\`\n${p}zq\n${p}\`\`\``);
      expect(textOf(doc), `code at quote depth ${depth}`).toContain('zq');
    }
  });

  it('draws a code block whose own padding exceeds its column', () => {
    // MEASURED: the Markdown default padding is about half the body size, which
    // is under the floor, so the quote cases above leave the code block's OWN
    // clamp unmeasured however deep they nest — `insetScale(12, 11)` is already
    // 0 by the time it is asked. Only a caller-stated padding wider than the
    // column reaches it, and unclamped that yields a negative width, which
    // `place` reads as "did not fit" and the engine then discards in silence.
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.custom(200, 400), marginLeft: 80, marginRight: 80 });
    flow.AddCodeBlock('zc', { padding: 30 });   // 60pt of padding in a 40pt column
    flow.Render();
    expect(textOf(doc)).toContain('zc');
    // And it starts where the SCALED padding puts it: 60pt wanted, 28 left
    // above the floor, so 30 becomes 14 and the text begins at 80 + 14. An
    // exact x rather than a bound, because the text draws either way — built
    // from the stated padding while the width comes from the scaled one, the
    // rect simply starts 16pt further right and runs past the column.
    const [frag] = doc.Pages[0].GetTextFragments();
    expect(frag.quad[0]).toBeCloseTo(80 + 30 * ((40 - MIN_CONTENT_WIDTH) / 60), 3);
  });

  it('draws a list item whose stated indent exceeds its column, marker included', () => {
    // MEASURED: the nested-Markdown case above does NOT reach
    // `ListItemElement`'s own clamp — a sub-list rides in its parent item's
    // `blocks`, so the `ListBlockElement` wrappers have already squeezed the
    // width by the time the innermost item is placed. Removing the item's
    // clamp left the whole file green. A stated indent wider than the column
    // is what reaches it, and it is a hand-built flow rather than Markdown
    // because the rule belongs to the engine, not to the mapper.
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.custom(200, 400), marginLeft: 80, marginRight: 80 });
    flow.AddList(['zl'], { indent: 500, ordered: true });   // 500pt into a 40pt column
    flow.Render();
    // 500pt wanted, 28 left above the floor, so the body starts at 80 + 28 —
    // and the marker, which reads the SAME clamped indent, sits in the gutter
    // just left of it. Drawn against the stated indent it lands 500pt right of
    // the list, well off a 200pt page.
    const body = fragment(doc, 'zl');
    const marker = fragment(doc, '1.');
    expect(body.quad[0]).toBeCloseTo(80 + (40 - MIN_CONTENT_WIDTH), 3);
    expect(marker.quad[0]).toBeGreaterThanOrEqual(80);
    expect(marker.quad[2]).toBeLessThanOrEqual(body.quad[0]);
  });

  it("draws an item whose first content is a BLOCK at the same clamped indent", () => {
    // The fourth site, and the one no Markdown document reaches: a marker is
    // drawn by whichever of an item's elements draws FIRST, and an item with
    // text always draws that first — so `ListBlockElement`'s own marker call is
    // only reached by an item whose leading content is a block. Measured: the
    // marker mutation stayed green until this case existed.
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.custom(200, 400), marginLeft: 80, marginRight: 80 });
    flow.AddList([{ blocks: paragraph('zb') }], { indent: 500, ordered: true });
    flow.Render();
    const body = fragment(doc, 'zb');
    const marker = fragment(doc, '1.');
    expect(body.quad[0]).toBeCloseTo(80 + (40 - MIN_CONTENT_WIDTH), 3);
    expect(marker.quad[0]).toBeGreaterThanOrEqual(80);
    expect(marker.quad[2]).toBeLessThanOrEqual(body.quad[0]);
    // NOTE the body's GLYPHS run past the column here — 'zb' at the flow's
    // default 12pt is wider than the 12pt floor. That is not a defect of the
    // clamp: a word wider than its box overflows in any column, and a floored
    // box only makes it likelier. What the clamp owns is the BOX.
    expect(body.quad[2]).toBeGreaterThan(120);
  });

  it('draws a table inside quotes that have exhausted the column', () => {
    for (const depth of [25, 26, 60]) {
      const doc = Document.New();
      const p = '>'.repeat(depth) + ' ';
      doc.AddMarkdown(`${p}| h |\n${p}| - |\n${p}| zt |`);
      expect(textOf(doc), `table at quote depth ${depth}`).toContain('zt');
    }
  });
});

describe('HTML that nests past the column width still renders (e1bp)', () => {
  it('draws text inside deeply nested blockquotes', () => {
    // 7 was the last depth that rendered; 8 onwards came out blank.
    for (const depth of [7, 8, 20, 100]) {
      const doc = Document.New();
      doc.AddHtml('<blockquote>'.repeat(depth) + 'xyz' + '</blockquote>'.repeat(depth));
      expect(textOf(doc), `blockquote depth ${depth}`).toContain('xyz');
    }
  });

  it('draws text inside divs whose padding exhausts the column', () => {
    for (const depth of [6, 8, 30]) {
      const doc = Document.New();
      const open = '<div style="padding-left:40px;padding-right:40px">'.repeat(depth);
      doc.AddHtml(open + 'xyz' + '</div>'.repeat(depth));
      expect(textOf(doc), `padded div depth ${depth}`).toContain('xyz');
    }
  });

  it('reports no OVERFLOW for a document it can now draw', () => {
    // Before the fix these drew nothing and were reported `overflow`/degraded
    // by the engine's last-resort branch. Drawing them is what removes the
    // record, so its absence is the sharper statement that the content landed.
    // What they DO report is the squeeze itself — see the next describe.
    const doc = Document.New();
    const r = doc.AddHtml('<blockquote>'.repeat(20) + 'xyz' + '</blockquote>'.repeat(20));
    expect(r.skipped.filter((s) => s.construct === 'overflow')).toEqual([]);
    expect(textOf(doc)).toContain('xyz');
  });
});

describe('a squeezed box is reported (rfba)', () => {
  const squeezed = (html: string) =>
    Document.New().AddHtml(html).skipped.filter((s) => s.construct === 'squeezed');

  it('reports ONCE for one paragraph however many levels squeezed it', () => {
    // Every BoxElement above the floor scales its insets, and each of them
    // would fire. They all forward to the ONE inner element, whose callback is
    // one-shot — so twenty levels are one record, not twelve.
    const r = squeezed('<blockquote>'.repeat(20) + 'xyz' + '</blockquote>'.repeat(20));
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe('degraded');
    // Attributed to the INNERMOST element — the one whose content was squeezed
    // — not to `<html>`, which is what an unconditional assignment would give.
    expect(r[0].el?.name).toBe('blockquote');
  });

  it('reports one record per element squeezed, not one per document', () => {
    const r = squeezed('<blockquote>'.repeat(20) + '<p>a</p><p>b</p>' + '</blockquote>'.repeat(20));
    expect(r.map((s) => s.el?.name)).toEqual(['p', 'p']);
  });

  it('reports no squeeze for content that draws nothing', () => {
    // An all-Cyrillic paragraph in a Standard-14 fallback face encodes to
    // nothing, so its box never paints: its loss is the `text` record, and a
    // squeeze around nothing is not a squeeze. Pins that the report comes from
    // `place()` once something draws — never from `measure()`, which the engine
    // asks of this box and which knows nothing about whether it will draw.
    const r = Document.New().AddHtml(
      '<blockquote>'.repeat(20) + '<p>При</p>' + '</blockquote>'.repeat(20));
    expect(r.skipped.filter((s) => s.construct === 'squeezed')).toEqual([]);
    expect(r.skipped.some((s) => s.construct === 'text')).toBe(true);
  });

  it('reports nothing for nesting the column can afford', () => {
    // The floor is the only trigger: a document laid out as specified must not
    // carry a record, or every nested quote in every document would.
    expect(squeezed('<blockquote>'.repeat(3) + 'xyz' + '</blockquote>'.repeat(3))).toEqual([]);
  });

  it('reports a squeeze from nested lists too', () => {
    const open = '<ul><li>'.repeat(20), close = '</li></ul>'.repeat(20);
    const r = squeezed(open + 'deep' + close);
    expect(r.length).toBeGreaterThan(0);
  });

  it('reports through page.AddHtml as well as doc.AddHtml', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const r = page.AddHtml('<blockquote>'.repeat(20) + 'xyz' + '</blockquote>'.repeat(20), [20, 20, 400, 750]);
    expect(r.skipped.filter((s) => s.construct === 'squeezed')).toHaveLength(1);
  });
});
