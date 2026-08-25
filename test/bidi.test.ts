import { describe, it, expect } from 'vitest';
import { paragraphLevel, resolveLevels, reorder, reorderLine, mirror, itemizeScripts, arabicJoiningForms } from '../src/bidi.js';

const cp = (s: string) => [...s].map((c) => c.codePointAt(0)!);

function levelsOf(codes: number[], para: 0 | 1): number[] {
  const { levels, removed } = resolveLevels(codes, para);
  return [...levels].map((l, i) => (removed[i] ? -1 : l));
}

describe('paragraphLevel (P2/P3)', () => {
  it('auto: first strong Latin -> 0', () => { expect(paragraphLevel(cp('abc'), 'auto')).toBe(0); });
  it('auto: first strong Hebrew -> 1', () => { expect(paragraphLevel(cp('אbc'), 'auto')).toBe(1); });
  it('auto: leading neutrals then Arabic -> 1', () => { expect(paragraphLevel(cp('  ا'), 'auto')).toBe(1); });
  it('auto: digits are not strong -> default 0', () => { expect(paragraphLevel(cp('123'), 'auto')).toBe(0); });
  it('auto: skips an isolate initiator..PDI span', () => {
    // FSI(2068) R-text PDI(2069) then Latin: first strong outside the isolate is L
    expect(paragraphLevel([0x2068, 0x05D0, 0x2069, 0x0041], 'auto')).toBe(0);
  });
  it('explicit dir forces the level', () => {
    expect(paragraphLevel(cp('abc'), 'rtl')).toBe(1);
    expect(paragraphLevel(cp('א'), 'ltr')).toBe(0);
  });
});

describe('resolveLevels', () => {
  it('pure LTR: all level 0', () => { expect(levelsOf(cp('abc'), 0)).toEqual([0, 0, 0]); });
  it('pure RTL Hebrew in LTR paragraph: level 1', () => { expect(levelsOf(cp('אב'), 0)).toEqual([1, 1]); });
  it('W2: EN after AL becomes AN -> level 2 in RTL context', () => {
    // AL(0627) EN(0031): W2 makes the digit AN; I-rules give AN level 2 under R.
    expect(levelsOf([0x0627, 0x0031], 1)).toEqual([1, 2]);
  });
  it('N0: brackets take the embedding direction of their content', () => {
    // Hebrew (paren Hebrew paren) in RTL paragraph -> all level 1.
    expect(levelsOf([0x05D0, 0x0028, 0x05D1, 0x0029], 1)).toEqual([1, 1, 1, 1]);
  });
  it('N1: neutral between two R runs takes R', () => {
    expect(levelsOf([0x05D0, 0x0020, 0x05D1], 0)).toEqual([1, 1, 1]);
  });
  it('X6: RLO override forces R on Latin, RLE/PDF removed', () => {
    // RLO(202E) a b PDF(202C): the Latin becomes level 1; controls removed.
    expect(levelsOf([0x202E, 0x0061, 0x0062, 0x202C], 0)).toEqual([-1, 1, 1, -1]);
  });
  it('isolates: RLI..PDI raises the enclosed run', () => {
    // a RLI(2067) Hebrew PDI(2069) b : Hebrew at odd level; a,b stay at paragraph level.
    const out = levelsOf([0x0061, 0x2067, 0x05D0, 0x2069, 0x0062], 0);
    expect(out[0]).toBe(0); expect(out[2]).toBe(1); expect(out[4]).toBe(0);
  });
});

describe('reorder (L1/L2)', () => {
  it('LTR only: identity order', () => {
    expect(reorderLine(cp('abc'), 'ltr').order).toEqual([0, 1, 2]);
  });
  it('RTL Hebrew word reverses (auto -> RTL paragraph)', () => {
    expect(reorderLine([0x05D0, 0x05D1, 0x05D2], 'auto').order).toEqual([2, 1, 0]);
  });
  it('mixed: Latin kept, Hebrew reversed (LTR paragraph)', () => {
    // a b HEB0 HEB1 -> visual: a b HEB1 HEB0
    expect(reorderLine([0x0061, 0x0062, 0x05D0, 0x05D1], 'ltr').order).toEqual([0, 1, 3, 2]);
  });
  it('L1: trailing whitespace resets to paragraph level', () => {
    expect(reorderLine([0x05D0, 0x0020], 'ltr').order).toEqual([0, 1]);
  });
  it('removed chars are excluded from order', () => {
    expect(reorderLine([0x202D, 0x0061, 0x202C], 'ltr').order).toEqual([1]); // LRO a PDF
  });
  it('reorder accepts precomputed levels', () => {
    const { levels, removed } = resolveLevels([0x05D0, 0x05D1], 0);
    expect(reorder([0x05D0, 0x05D1], levels, removed, 0)).toEqual([1, 0]);
  });
});

describe('mirror', () => {
  it('mirrors a bracket, leaves letters', () => {
    expect(mirror(0x0028)).toBe(0x0029);
    expect(mirror(0x0041)).toBe(0x0041);
  });
});

describe('itemizeScripts', () => {
  it('splits Latin | Arabic and tags each', () => {
    const segs = itemizeScripts([0x0041, 0x0042, 0x0627, 0x0628]); // AB + arabic alef/beh
    expect(segs.map((s) => [s.start, s.end, s.otTag, s.rtl])).toEqual([
      [0, 2, 'latn', false], [2, 4, 'arab', true],
    ]);
  });
  it('folds Common/Inherited into the surrounding run', () => {
    // A, combining acute (Inherited), space (Common), B -> one Latin run
    const segs = itemizeScripts([0x0041, 0x0301, 0x0020, 0x0042]);
    expect(segs.length).toBe(1);
    expect(segs[0].otTag).toBe('latn');
  });
});

describe('arabicJoiningForms', () => {
  it('two dual-joining letters -> init, fina', () => {
    expect(arabicJoiningForms([0x0628, 0x0628], 0, 2)).toEqual(['init', 'fina']);
  });
  it('three dual-joining -> init, medi, fina', () => {
    expect(arabicJoiningForms([0x0628, 0x0628, 0x0628], 0, 3)).toEqual(['init', 'medi', 'fina']);
  });
  it('dual beh then right-joining alef -> init, fina', () => {
    expect(arabicJoiningForms([0x0628, 0x0627], 0, 2)).toEqual(['init', 'fina']);
  });
  it('transparent mark between joiners is skipped (null), letters still join', () => {
    expect(arabicJoiningForms([0x0628, 0x064B, 0x0628], 0, 3)).toEqual(['init', null, 'fina']);
  });
  it('single letter -> isol', () => {
    expect(arabicJoiningForms([0x0628], 0, 1)).toEqual(['isol']);
  });
  it('non-joining (U) letter -> isol', () => {
    expect(arabicJoiningForms([0x0041], 0, 1)).toEqual(['isol']);
  });
});
