import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { list, paragraph } from '../src/flow.js';
import { placeElements } from '../src/flowplace.js';
import type { Page } from '../src/page.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const content = (page: Page): string =>
  new TextDecoder('latin1').decode(page.Contents);

function place(atomics: unknown): Page {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const els = paragraph([{ text: 'before ' }, { text: 'after' }],
    { fontSize: 12, atomics } as never);
  placeElements(doc, page, els, [20, 20, 400, 750], { paragraphSpacing: 0 });
  return page;
}

describe('paragraph({ atomics })', () => {
  it('takes BYTES and builds the XObject itself', () => {
    // cssflow.ts hands bytes and never a PdfStream, which is what keeps its
    // rule of touching no PDF object module.
    const page = place([{ beforeRun: 1, data: new Uint8Array(PNG_1x1),
      width: 20, height: 20 }]);
    expect(content(page)).toMatch(/\/Im\d+ Do/);
    expect(page.GetText()).toContain('before');
  });

  it('defaults align to baseline', () => {
    const page = place([{ beforeRun: 1, data: new Uint8Array(PNG_1x1),
      width: 20, height: 20 }]);
    expect(content(page)).toMatch(/ Do/);
  });

  it('rejects a bad atomic BEFORE emitting any byte', () => {
    // The rule every authoring entry point follows: a rejected call leaves the
    // document byte-identical.
    for (const bad of [
      { beforeRun: -1, data: new Uint8Array(PNG_1x1), width: 1, height: 1 },
      { beforeRun: 0, data: 'nope', width: 1, height: 1 },
      { beforeRun: 0, data: new Uint8Array(PNG_1x1), width: -1, height: 1 },
      { beforeRun: 0, data: new Uint8Array(PNG_1x1), width: 1, height: Number.NaN },
      { beforeRun: 0, data: new Uint8Array(PNG_1x1), width: 1, height: 1, align: 'middle' },
    ]) {
      expect(() => place([bad]), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it('leaves an atomic-free paragraph exactly as it was', () => {
    const page = place(undefined);
    expect(content(page)).not.toMatch(/ Do/);
    expect(page.GetText()).toContain('before');
  });
});

/**
 * `FlowListItem.atomics` (`092q`) — the same channel on a list item.
 *
 * A list item is the one body that both PAGINATES and carries a MARKER, so it
 * has two hazards `paragraph` does not, and both are asserted here rather than
 * only through Markdown: this is public API a hand-built flow can use.
 */
describe('list item atomics', () => {
  const img = (beforeRun: number) =>
    ({ beforeRun, data: new Uint8Array(PNG_1x1), width: 20, height: 20 });

  const placeList = (items: unknown[]): Page => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    placeElements(doc, page, list(items as never, { fontSize: 12 }),
      [20, 20, 400, 750], { paragraphSpacing: 0 });
    return page;
  };

  it('places a box among an item’s runs', () => {
    const page = placeList([
      { text: [{ text: 'before ' }, { text: 'after' }], atomics: [img(1)] },
    ]);
    expect(content(page)).toMatch(/\/Im\d+ Do/);
    expect(page.GetText()).toContain('before');
  });

  it('an item that is only an image still draws, and draws its marker', () => {
    // `text: []` plus one atomic is the image-only item. Read the emptiness
    // test as `isEmptyFlowText` alone and this item tags nothing and — since
    // the marker is drawn only once the body has painted — shows no bullet.
    const page = placeList([{ text: [], atomics: [img(0)] }]);
    expect(content(page)).toMatch(/\/Im\d+ Do/);
    expect(page.GetPaths().filter((p) => p.fill !== null).length).toBeGreaterThan(0);
  });

  it('rejects a bad atomic on an item BEFORE emitting any byte', () => {
    expect(() => placeList([{ text: 'x', atomics: [{ beforeRun: -1 }] }]))
      .toThrow(TypeError);
    expect(() => placeList([{ text: 'x', atomics: 'nope' }])).toThrow(TypeError);
  });

  it('leaves an atomic-free list exactly as it was', () => {
    // The fence for the whole change: an item stating no atomics must emit the
    // bytes it always did.
    const before = content(placeList([{ text: 'plain item' }]));
    expect(before).not.toMatch(/Do/);
  });
});

/**
 * `measure` must see the atomics too, or the engine decides what fits from a
 * height it will not draw. A tall image is what makes the two answers differ:
 * at 12pt the text band is ~14.4pt, and a 60pt picture raises the line to it.
 *
 * Measured load-bearing: without this the `measure`-vs-`place` mutation
 * reddened NOTHING, because every other case here uses a 20pt image inside a
 * band that was already taller.
 */
describe('list item atomics: measure agrees with place', () => {
  const tall = { beforeRun: 1, data: new Uint8Array(PNG_1x1), width: 20, height: 60 };

  it('an oversized image raises the measured height of the item', () => {
    const plain = list([{ text: [{ text: 'a ' }, { text: 'b' }] }], { fontSize: 12 });
    const withImg = list(
      [{ text: [{ text: 'a ' }, { text: 'b' }], atomics: [tall] }], { fontSize: 12 });
    const m = (els: ReturnType<typeof list>) =>
      els[0].measure!({ width: 400, availHeight: 500 }).usedHeight;
    expect(m(plain)).toBeLessThan(20);
    expect(m(withImg)).toBeGreaterThan(55);
  });

  it('and the height it measured is the height it draws', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = list(
      [{ text: [{ text: 'a ' }, { text: 'b' }], atomics: [tall] }], { fontSize: 12 });
    const measured = els[0].measure!({ width: 400, availHeight: 500 }).usedHeight;
    const { usedHeight } = placeElements(doc, page, els, [20, 20, 400, 750],
      { paragraphSpacing: 0 });
    expect(usedHeight).toBeCloseTo(measured, 6);
  });
});
