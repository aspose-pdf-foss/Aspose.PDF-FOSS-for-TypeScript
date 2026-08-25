import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import type { Page } from '../src/page.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);

/** A page with NO /Contents key at all. `buildBlankPage` ships an empty but
 *  *present* content stream, which appendContent still wraps in q/Q — so it is
 *  not the "nothing to splice against" case, and a stamp body cannot be read
 *  back from it in isolation. */
function pageWithNoContents(): Page {
  const page = Document.Open(buildBlankPage()).Pages[0];
  page.Dict.delete('Contents');
  return page;
}

/** Byte offsets of the text object, for ordering checks. */
const btAt = (c: string) => c.indexOf('BT');
const etAt = (c: string) => c.lastIndexOf('ET');

describe('AddText decoration', () => {
  // On a page that already has content, indexOf('BT') would find the *existing*
  // text object, so this ordering check needs a stream holding only the stamp.
  it('draws the background before BT and the rules after ET', () => {
    const page = pageWithNoContents();
    page.AddText('Hi', 100, 100, {
      underline: true, strikethrough: true, background: [1, 1, 0],
    });
    const c = decoded(page);
    const bgAt = c.indexOf('1 1 0 rg');
    expect(bgAt).toBeGreaterThan(-1);
    expect(bgAt).toBeLessThan(btAt(c));
    // Two rules, both after ET.
    const rules = [...c.matchAll(/re f/g)].map((m) => m.index!);
    expect(rules.filter((i) => i > etAt(c))).toHaveLength(2);
  });

  it('keeps decoration inside the stamp\'s outer q/Q', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 100, { underline: true });
    const c = decoded(page);
    expect(c.startsWith('q')).toBe(true);
    expect(c.trimEnd().endsWith('Q')).toBe(true);
  });

  it('rotates the rules with the text (same matrix as Tm)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 100, { rotate: 90, underline: true });
    const c = decoded(page);
    const tm = /([-\d. ]+) Tm/.exec(c)![1].trim();
    expect(c).toContain(`${tm} cm`);
  });

  it('an explicit style overrides colour and thickness', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddText('Hi', 10, 10, { underline: { color: [1, 0, 0], thickness: 2, offset: -4 } });
    const c = decoded(page);
    expect(c).toContain('1 0 0 rg');
    expect(c).toContain('0 -5 '); // offset -4 - thickness/2
  });

  it('rejects a bad decoration before touching the page', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const before = decoded(page);
    expect(() => page.AddText('Hi', 10, 10, { underline: { thickness: -1 } }))
      .toThrow(TypeError);
    expect(decoded(page)).toBe(before);
  });
});

describe('AddText behind', () => {
  it('places the stamp before existing content', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Under', 10, 10, { behind: true });
    const c = decoded(page);
    expect(c.indexOf('Under')).toBeLessThan(c.indexOf('Original'));
  });

  it('defaults to drawing on top', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Over', 10, 10);
    const c = decoded(page);
    expect(c.indexOf('Over')).toBeGreaterThan(c.indexOf('Original'));
  });

  it('is a plain draw on a page with no content to sink beneath', () => {
    const a = pageWithNoContents();
    a.AddText('Hi', 10, 10, { behind: true });
    const b = pageWithNoContents();
    b.AddText('Hi', 10, 10);
    expect(decoded(a)).toBe(decoded(b));
  });
});

describe('undecorated output is unchanged', () => {
  it('AddText emits the pre-change byte sequence', () => {
    const page = pageWithNoContents();
    page.AddText('Hi', 100, 100);
    expect(decoded(page)).toBe(
      'q\nBT\n/F0 12 Tf\n0 0 0 rg\n1 0 0 1 100 100 Tm\n(Hi) Tj\nET\nQ');
  });
});

describe('AddTextBlock decoration', () => {
  it('emits one underline per laid line', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddTextBlock('one two three four five six seven eight',
      [50, 500, 80, 200], { fontSize: 10, underline: true });
    const c = decoded(page);
    const lines = (c.match(/Tj/g) ?? []).length;
    expect(lines).toBeGreaterThan(1);
    expect((c.match(/re f/g) ?? []).length).toBe(lines);
  });

  it('a justified line is decorated to the full box width', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddTextBlock('alpha beta gamma delta epsilon zeta eta theta',
      [50, 500, 120, 200], { fontSize: 10, align: 'justify', underline: true });
    const c = decoded(page);
    // At least one rule spans the full 120pt box (a Tw-justified line).
    expect(c).toMatch(/ 120 [\d.]+ re f/);
  });

  it('background sits under the whole block, rules over it', () => {
    const page = pageWithNoContents();
    page.AddTextBlock('hello world', [50, 500, 200, 100],
      { fontSize: 10, background: [0, 1, 0], underline: true });
    const c = decoded(page);
    expect(c.indexOf('0 1 0 rg')).toBeLessThan(c.indexOf('BT'));
    expect(c.lastIndexOf('re f')).toBeGreaterThan(c.lastIndexOf('ET'));
  });

  it('honours behind', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddTextBlock('Under', [10, 10, 200, 50], { behind: true });
    const c = decoded(page);
    expect(c.indexOf('Under')).toBeLessThan(c.indexOf('Original'));
  });

  it('places the background rect where GetPaths reads it back', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddTextBlock('hi', [50, 500, 200, 100],
      { fontSize: 10, valign: 'top', leading: 12, background: [0, 1, 0] });
    const paths = page.GetPaths().filter((p) => p.fill !== null);
    expect(paths).toHaveLength(1);
    const [x0, y0, , y1] = paths[0].bbox;
    // First baseline = rect top (600) - fontSize (10) = 590.
    // Helvetica ascent .718 / descent -.207 at 10pt.
    expect(x0).toBeCloseTo(50, 3);
    expect(y0).toBeCloseTo(590 - 2.07, 3);
    expect(y1).toBeCloseTo(590 + 7.18, 3);
  });
});

describe('undecorated block output is unchanged', () => {
  it('AddTextBlock emits the pre-change byte sequence', () => {
    const page = pageWithNoContents();
    page.AddTextBlock('hi', [50, 500, 200, 100], { fontSize: 10, leading: 12 });
    expect(decoded(page)).toBe(
      'q\nBT\n/F0 10 Tf\n0 0 0 rg\n50 590 Td\n(hi) Tj\nET\nQ');
  });
});
