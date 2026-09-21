import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent } from '../src/text.js';
import { buildTextStatePdf } from './helpers/build-text-state-pdf.js';

/** What a glyph event says about WHERE and HOW a glyph was drawn — its text,
 *  its quad, its size and its font — with the content address left out, since
 *  inserting a `q` … `Q` block shifts every later op index. */
function placed(content: string, formContent?: string) {
  const doc = Document.Open(buildTextStatePdf(content, formContent));
  const out: { text: string; quad: number[]; fontSize: number; font: string }[] = [];
  visitContent(doc, doc.Pages[0], {
    glyph: (e) => {
      out.push({ text: e.text, quad: e.quad.map((v) => Math.round(v * 1000) / 1000), fontSize: e.fontSize, font: e.font.name ?? '' });
    },
  });
  return out;
}

/** Each case sets ONE text state parameter where it must be undone by `Q`, and
 *  then shows text laid out so that parameter would move a glyph if it leaked.
 *  `before` runs first and outside the `q`, so the restored value is a real one
 *  rather than the initial state; `show` is the text object that follows. */
const CASES: { op: string; before: string; set: string; show: string }[] = [
  // Tc spaces every glyph, so the second glyph's x moves.
  { op: 'Tc', before: '', set: '5 Tc', show: 'BT /F1 12 Tf 72 700 Td (ab) Tj ET' },
  // Tw spaces only code 32, so the glyph after the space moves.
  { op: 'Tw', before: '', set: '9 Tw', show: 'BT /F1 12 Tf 72 700 Td (a b) Tj ET' },
  // Tz scales the advance, so the second glyph's x moves.
  { op: 'Tz', before: '', set: '200 Tz', show: 'BT /F1 12 Tf 72 700 Td (ab) Tj ET' },
  // TL is what T* moves by, so the second line's y moves.
  { op: 'TL', before: '14 TL', set: '40 TL', show: 'BT /F1 12 Tf 72 700 Td (a) Tj T* (b) Tj ET' },
  // Ts raises the baseline, so every glyph's y moves.
  { op: 'Ts', before: '', set: '6 Ts', show: 'BT /F1 12 Tf 72 700 Td (a) Tj ET' },
  // Tf outside a text object is text state too (9.3.1 names Tf and Tfs), so a
  // text object that sets no font draws in the one in force before the q.
  { op: 'Tf', before: '/F1 12 Tf', set: '/F2 24 Tf', show: 'BT 72 700 Td (ab) Tj ET' },
];

describe('visitContent text state across q/Q (g5x6)', () => {
  for (const c of CASES) {
    it(`restores ${c.op} at Q`, () => {
      const baseline = placed(`${c.before}\n${c.show}`);
      const scoped = placed(`${c.before}\nq ${c.set} Q\n${c.show}`);
      expect(baseline.length).toBeGreaterThan(0);
      expect(scoped).toEqual(baseline);
    });

    it(`the ${c.op} fixture discriminates: unscoped, the setting moves a glyph`, () => {
      // Without this, two identical wrong answers — a fixture whose layout the
      // parameter cannot touch — would satisfy the case above on their own.
      const baseline = placed(`${c.before}\n${c.show}`);
      const leaked = placed(`${c.before}\n${c.set}\n${c.show}`);
      expect(leaked).not.toEqual(baseline);
    });
  }

  it('keeps a setting made INSIDE the q for the text shown there', () => {
    // The other half of scoping: q/Q must bound the change, not discard it.
    const inside = placed('q 6 Ts BT /F1 12 Tf 72 700 Td (a) Tj ET Q');
    const plain = placed('BT /F1 12 Tf 72 700 Td (a) Tj ET');
    expect(inside[0].quad[1]).toBeCloseTo(plain[0].quad[1] + 6, 3);
  });

  it('restores through nested q/Q, one level at a time', () => {
    const out = placed([
      '1 Ts',
      'q 2 Ts q 3 Ts BT /F1 12 Tf 72 700 Td (a) Tj ET Q',
      'BT /F1 12 Tf 72 700 Td (b) Tj ET Q',
      'BT /F1 12 Tf 72 700 Td (c) Tj ET',
    ].join('\n'));
    const plain = placed('BT /F1 12 Tf 72 700 Td (a) Tj ET')[0].quad[1];
    expect(out.map((g) => Math.round(g.quad[1] - plain))).toEqual([3, 2, 1]);
  });
});

describe('visitContent text state inherited by a Form XObject (mih4)', () => {
  // 8.10.1: a form's content is drawn in the graphics state in force at its Do,
  // and 9.3.1 makes the text state part of it. So text a form shows must land
  // exactly where the SAME text shown on the page at that point would. The
  // g5x6 companions above already prove each setting moves a glyph.
  for (const c of CASES) {
    it(`inherits ${c.op} at Do`, () => {
      const onPage = placed(`${c.before}\n${c.set}\n${c.show}`);
      const inForm = placed(`${c.before}\n${c.set}\n/Fm0 Do`, c.show);
      expect(onPage.length).toBeGreaterThan(0);
      expect(inForm).toEqual(onPage);
    });
  }

  it('does not leak a setting made inside the form back out to the page', () => {
    // The child starts from a COPY: sharing the object would let the form's own
    // Ts raise every glyph the page shows after the Do.
    const show = 'BT /F1 12 Tf 72 700 Td (a) Tj ET';
    expect(placed(`/Fm0 Do\n${show}`, '6 Ts')).toEqual(placed(show));
  });

  it('restores the INHERITED value at a Q inside the form', () => {
    const show = 'BT /F1 12 Tf 72 700 Td (a) Tj ET';
    expect(placed('3 Ts\n/Fm0 Do', `q 9 Ts Q ${show}`)).toEqual(placed(`3 Ts\n${show}`));
  });
});
