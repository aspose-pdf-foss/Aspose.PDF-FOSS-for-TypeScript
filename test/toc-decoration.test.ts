import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import type { Page } from '../src/page.js';
import type { TOCOptions, TOCEntry } from '../src/toc.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);
const rects = (page: Page) => (decoded(page).match(/re f/g) ?? []).length;

const RECT: [number, number, number, number] = [72, 400, 300, 300];

function tocPage(entries: TOCEntry[], opts?: TOCOptions): Page {
  const page = Document.Open(buildBlankPage()).Pages[0];
  page.AddTOC(entries, RECT, opts);
  return page;
}

describe('TOC row decoration', () => {
  it('an undecorated TOC emits no rects', () => {
    expect(rects(tocPage([{ title: 'One', page: 1 }]))).toBe(0);
  });

  it('forwards a call-level underline to every row', () => {
    // A row is three separate stamps (title, dot leader, page number) and each
    // is decorated on its own, so a single-line row yields three rules — an
    // underline broken only by the leaderGap blanks.
    const one = rects(tocPage([{ title: 'One', page: 1 }], { underline: true }));
    expect(one).toBe(3);
    const two = rects(tocPage(
      [{ title: 'One', page: 1 }, { title: 'Two', page: 1 }], { underline: true }));
    expect(two).toBe(2 * one);
  });

  it('lets a per-entry style override the call default', () => {
    const both = rects(tocPage(
      [{ title: 'One', page: 1 }, { title: 'Two', page: 1 }], { underline: true }));
    const one = rects(tocPage(
      [{ title: 'One', page: 1 }, { title: 'Two', page: 1, style: { underline: false } }],
      { underline: true }));
    expect(one).toBe(both / 2);
  });

  it('forwards a background', () => {
    expect(decoded(tocPage([{ title: 'One', page: 1 }], { background: [1, 0, 1] })))
      .toContain('1 0 1 rg');
  });
});
