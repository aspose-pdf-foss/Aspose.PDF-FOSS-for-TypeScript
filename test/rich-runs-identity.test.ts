import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { createTable } from '../src/tableauthor.js';
import { buildUnicodeTtf } from './helpers/build-sfnt.js';

/** The bytes a page emitted, hashed.
 *
 *  This suite is a REGRESSION FENCE for gl6o.3.1, not a feature test. The
 *  rich-run refactor rebuilds the wrapping engine and the block emitter
 *  underneath every existing caller; nothing else in the suite would notice a
 *  half-point drift in a table cell or one dropped `Tw`. These hashes were
 *  generated from the implementation BEFORE that refactor. If one changes, the
 *  output moved — either fix the change or, if the move is genuinely intended,
 *  say so in the commit message and re-record deliberately. */
const sha = (page: { Contents: Uint8Array }): string =>
  createHash('sha256').update(page.Contents).digest('hex').slice(0, 16);

const LOREM = 'The quick brown fox jumps over the lazy dog, and then it does so again '
  + 'because one sentence is not enough to force a wrap in a narrow column.';

/** Each case builds a document and returns the page whose bytes are hashed. */
const CASES: Record<string, () => { Contents: Uint8Array }> = {
  'textblock-plain': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(LOREM, [50, 500, 200, 200]);
    return page;
  },
  'textblock-justified': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(LOREM, [50, 500, 200, 200], { align: 'justify' });
    return page;
  },
  'textblock-decorated': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(LOREM, [50, 500, 200, 200], {
      underline: true, strikethrough: { thickness: 2 }, background: [0.9, 0.9, 1],
    });
    return page;
  },
  'textblock-rotated-centered': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(LOREM, [50, 500, 200, 200], {
      rotate: 30, align: 'center', valign: 'center', opacity: 0.5,
    });
    return page;
  },
  // buildUnicodeTtf's cmap covers exactly 'A' and '中', so the text has to be
  // built from those: LOREM through this font encodes to nothing and would hash
  // an empty page, which no refactor could ever move.
  'textblock-embedded': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const font = doc.AddFont(buildUnicodeTtf());
    page.AddTextBlock('A中A AA 中中A A中 '.repeat(12), [50, 500, 200, 200],
      { font, align: 'justify' });
    return page;
  },
  'flow-paragraph-heading-list': () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2 });
    flow.AddHeading(1, 'A Heading That Is Long Enough To Wrap Across Lines');
    flow.AddParagraph(LOREM, { align: 'justify' });
    flow.AddList(['first item', { text: 'second item', items: ['nested one', 'nested two'] }],
      { ordered: true });
    flow.AddParagraph(LOREM);
    return flow.Render()[0];
  },
  // gl6o.3.2 rewrites the list flattener (FlowListItem.blocks) and the
  // marker-drawing path (a shared marker holder). These three cases are what
  // would move if either went wrong: a deep nest exercises the per-depth
  // cumulative indent, per-item styles exercise resolveItemOptions' fast path,
  // and a paginating item exercises the body-only continuation that must NOT
  // redraw its marker.
  'flow-list-deep-nested': () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddList([
      { text: 'level one alpha', items: [
        { text: 'level two alpha', items: ['level three alpha', 'level three beta'] },
        'level two beta',
      ] },
      { text: 'level one beta', items: ['level two gamma'] },
    ]);
    return flow.Render()[0];
  },
  'flow-list-styled-items': () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddList([
      'plain item',
      { text: 'bold item', font: 'Helvetica-Bold' },
      { text: 'big item', fontSize: 16, color: [0.2, 0.3, 0.9] },
      { text: 'decorated item', underline: true, background: [0.95, 0.95, 0.8] },
    ], { ordered: true, start: 3, itemSpacing: 4 });
    return flow.Render()[0];
  },
  'flow-list-item-paginates': () => {
    const doc = Document.New();
    // A short column forces one item's body to split; the marker must be drawn
    // once, on the first fragment only.
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2, marginTop: 700 });
    flow.AddList([LOREM, LOREM]);
    return flow.Render()[0];
  },
  'table-cell': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable();
    t.addRow(['short', LOREM]);
    t.addRow(['another', 'cell text']);
    page.AddTable(t, 72, 720, { width: 300 });
    return page;
  },
  'floating-box': () => {
    const doc = Document.New();
    const box = doc.NewFloatingBox({ width: 150 });
    box.AddParagraph(LOREM);
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph(LOREM);
    flow.AddFloatBox(box, 'left');
    flow.AddParagraph(LOREM);
    return flow.Render()[0];
  },
};

/** Recorded from the implementation as it stood before the rich-run refactor. */
const EXPECTED: Record<string, string> = {
  'textblock-plain': 'e364d0909b2e867d',
  'textblock-justified': 'e00710eda9ba3106',
  'textblock-decorated': '89d009c15eed6b92',
  'textblock-rotated-centered': 'b48b6ac782eb694b',
  'textblock-embedded': '421115b7e4d7dee7',
  'flow-paragraph-heading-list': '89fefef5a2cde576',
  'flow-list-deep-nested': 'c6d076809ae92bc4',
  'flow-list-styled-items': '3a416e783d4f79e4',
  'flow-list-item-paginates': 'd8a04fd80c8c8bed',
  'table-cell': 'b052417b5ba87992',
  'floating-box': 'f8f2c0e310936917',
};

describe('byte identity across the rich-run refactor', () => {
  it('covers every string call site the refactor passes through', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [name, build] of Object.entries(CASES)) {
    it(`${name} emits unchanged bytes`, () => {
      expect(sha(build())).toBe(EXPECTED[name]);
    });
  }
});

/** The fence between the link feature (gl6o.3.3) and every existing rich-run
 *  caller. The BDC/EMC split in `buildRunBlockBody` must fire ONLY for a run
 *  carrying a link inside a tagged block; the hashes above already cover the
 *  untagged case byte for byte, and this states the rule directly so a failure
 *  names the cause rather than a hash. */
describe('the link split does not leak', () => {
  it('emits no marked content for a run list carrying no link', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(
      [{ text: 'plain ' }, { text: 'bold', font: 'Helvetica-Bold' }, { text: ' tail' }],
      [50, 500, 300, 200], { fontSize: 12 },
    );
    const body = Buffer.from(doc.Save()).toString('latin1');
    expect(body).not.toContain('BDC');
    expect(body).not.toContain('EMC');
  });

  it('emits no marked content for a linked run in an untagged block', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(
      [{ text: 'go ' }, { text: 'there', link: 'https://example.com' }],
      [50, 500, 300, 200], { fontSize: 12 },
    );
    const body = Buffer.from(doc.Save()).toString('latin1');
    expect(body).not.toContain('BDC');
  });
});
