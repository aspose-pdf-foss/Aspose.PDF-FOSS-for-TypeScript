import { describe, it, expect } from 'vitest';
import { newBitmap, type Bitmap } from '../src/jbig2.js';
import {
  decodeRefinement, refineContext, refineTemplate, typicalPixel, REFINE_REUSED_CONTEXTS,
} from '../src/jbig2refine.js';
import * as F from './helpers/jbig2-refine-vectors.js';

function rows(bm: Bitmap): string[] {
  const o: string[] = [];
  for (let y = 0; y < bm.height; y++) o.push(Array.from(bm.data.subarray(y * bm.width, (y + 1) * bm.width)).join(''));
  return o;
}

function fromRows(r: readonly string[]): Bitmap {
  const bm = newBitmap(r[0].length, r.length);
  for (let y = 0; y < r.length; y++) for (let x = 0; x < r[y].length; x++) bm.data[y * bm.width + x] = r[y][x] === '1' ? 1 : 0;
  return bm;
}

const NOMINAL_AT = [{ x: -1, y: -1 }, { x: -1, y: -1 }];

describe('jbig2 generic refinement', () => {
  // The outside anchor. T.88 §6.3.5.6 publishes the SLTP context as 0x0020 for
  // template 0 and 0x0008 for template 1, and each is the label for "every
  // template pixel 0 except the reference pixel at (0,0)". Asserting that
  // equality pins the template lengths, the coding-before-reference bit order,
  // the position of (0,0) in the reference list, and the fact that the AT
  // pixels are APPENDED rather than sorted in the way jbig2generic.ts sorts
  // them. A round trip through our own encoder cannot see any of that — it
  // agrees with itself whatever order we pick.
  it.each([[0], [1]])('assembles a template-%i context to T.88\'s published SLTP value', (template) => {
    const bm = newBitmap(5, 5);
    const ref = newBitmap(5, 5);
    ref.data[2 * 5 + 2] = 1; // the co-located reference pixel, and nothing else
    const tpl = refineTemplate(template, NOMINAL_AT);
    expect(refineContext(bm, ref, tpl, 2, 2, 0, 0)).toBe(REFINE_REUSED_CONTEXTS[template]);
  });

  it('gives template 0 a 13-bit context and template 1 a 10-bit one', () => {
    const t0 = refineTemplate(0, NOMINAL_AT);
    expect(t0.coding.length + t0.reference.length).toBe(13);
    const t1 = refineTemplate(1, NOMINAL_AT);
    expect(t1.coding.length + t1.reference.length).toBe(10);
  });

  it.each([
    ['t0', F.refine_t0, 0],
    ['t1', F.refine_t1, 1],
  ])('refines a reference bitmap (%s)', (_name, v, template) => {
    const reference = fromRows(v.refRows);
    const out = decodeRefinement(v.bytes, 0, v.bytes.length, {
      width: v.width, height: v.height, reference, dx: 0, dy: 0,
      template, at: NOMINAL_AT, tpgron: false,
    });
    expect(rows(out)).toEqual(v.rows);
    // The vector clears pixels as well as adding them, so the result is not
    // reachable by OR-ing anything onto the reference.
    expect(rows(out)).not.toEqual(v.refRows);
  });

  it('reports a uniform 3x3 reference neighbourhood and nothing else', () => {
    const zeros = newBitmap(5, 5);
    expect(typicalPixel(zeros, 2, 2)).toBe(0);

    const ones = newBitmap(5, 5, 1);
    expect(typicalPixel(ones, 2, 2)).toBe(1);

    const mixed = newBitmap(5, 5);
    mixed.data[1 * 5 + 1] = 1; // one corner of the neighbourhood differs
    expect(typicalPixel(mixed, 2, 2)).toBeUndefined();
  });

  // Out-of-bounds reference pixels read as 0, so the corner of an all-ones
  // reference is NOT typical — its neighbourhood is five 1s and four 0s. Getting
  // this wrong sends the first and last row of every TPGRON region down the
  // typical path when it should be decoded, desynchronising the stream.
  it('does not treat an edge of a uniform reference as typical', () => {
    const ones = newBitmap(5, 5, 1);
    expect(typicalPixel(ones, 0, 0)).toBeUndefined();
    expect(typicalPixel(ones, 4, 4)).toBeUndefined();
  });

  it('refines with TPGRON typical prediction', () => {
    const v = F.refine_tpgron;
    const out = decodeRefinement(v.bytes, 0, v.bytes.length, {
      width: v.width, height: v.height, reference: fromRows(v.refRows), dx: 0, dy: 0,
      template: 0, at: NOMINAL_AT, tpgron: true,
    });
    expect(rows(out)).toEqual(v.rows);
  });
});
