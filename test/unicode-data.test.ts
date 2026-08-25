import { describe, it, expect } from 'vitest';
import { BC, JT, bidiClass, combiningClass, script, joiningType, bracket, mirror, scriptTag, unicodePunctuation, caseFold } from '../src/unicode-data.js';

describe('unicode-data accessors', () => {
  it('bidiClass: Latin L, Hebrew R, Arabic letter AL, digit EN, Arabic-Indic AN, FSI', () => {
    expect(bidiClass(0x0041)).toBe(BC.L);   // A
    expect(bidiClass(0x05D0)).toBe(BC.R);   // Hebrew alef
    expect(bidiClass(0x0627)).toBe(BC.AL);  // Arabic alef
    expect(bidiClass(0x0039)).toBe(BC.EN);  // 9
    expect(bidiClass(0x0661)).toBe(BC.AN);  // Arabic-Indic one
    expect(bidiClass(0x2068)).toBe(BC.FSI); // FSI isolate initiator
  });
  it('combiningClass: base 0, combining acute above 230', () => {
    expect(combiningClass(0x0041)).toBe(0);
    expect(combiningClass(0x0301)).toBe(230); // combining acute
  });
  it('script + tag: Latin ltr latn, Arabic rtl arab', () => {
    expect(scriptTag(script(0x0041))).toEqual({ tag: 'latn', rtl: false });
    expect(scriptTag(script(0x0627))).toEqual({ tag: 'arab', rtl: true });
  });
  it('joiningType: Arabic beh D, alef R, non-joining U, transparent mark T', () => {
    expect(joiningType(0x0628)).toBe(JT.D); // beh
    expect(joiningType(0x0627)).toBe(JT.R); // alef
    expect(joiningType(0x0041)).toBe(JT.U); // A
    expect(joiningType(0x064B)).toBe(JT.T); // fathatan (transparent)
  });
  it('bracket + mirror', () => {
    expect(bracket(0x0028)).toEqual({ type: 0, pair: 0x0029 }); // ( open -> )
    expect(bracket(0x0029)).toEqual({ type: 1, pair: 0x0028 }); // ) close -> (
    expect(bracket(0x0041)).toBeUndefined();
    expect(mirror(0x0028)).toBe(0x0029);
    expect(mirror(0x0041)).toBe(0x0041);
  });
});

/** CommonMark 0.31.2 defines a Unicode punctuation character as general
 *  category Pc, Pd, Pe, Pf, Pi, Po, Ps OR Sc, Sk, Sm, So. The S* half arrived
 *  in 0.31.0; an implementation written against 0.30 omits it and gets emphasis
 *  flanking wrong around `$`, `+` and `©`. */
describe('unicodePunctuation', () => {
  const cp = (s: string) => s.codePointAt(0)!;

  it('accepts every ASCII punctuation character', () => {
    for (const c of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') {
      expect(unicodePunctuation(cp(c)), c).toBe(true);
    }
  });

  it('accepts the P* categories beyond ASCII', () => {
    expect(unicodePunctuation(0x2014)).toBe(true); // Pd em dash
    expect(unicodePunctuation(0x201c)).toBe(true); // Pi left double quote
    expect(unicodePunctuation(0x201d)).toBe(true); // Pf right double quote
    expect(unicodePunctuation(0x3002)).toBe(true); // Po ideographic full stop
    expect(unicodePunctuation(0xff08)).toBe(true); // Ps fullwidth left paren
    expect(unicodePunctuation(0x203f)).toBe(true); // Pc undertie
  });

  it('accepts the S* categories — the 0.31.0 change', () => {
    expect(unicodePunctuation(cp('$'))).toBe(true);   // Sc
    expect(unicodePunctuation(0x00a3)).toBe(true);    // Sc pound
    expect(unicodePunctuation(cp('+'))).toBe(true);   // Sm
    expect(unicodePunctuation(0x00a9)).toBe(true);    // So copyright
    expect(unicodePunctuation(cp('^'))).toBe(true);   // Sk
    expect(unicodePunctuation(0x1f600)).toBe(true);   // So, astral
  });

  it('rejects letters, digits, marks and whitespace', () => {
    for (const c of 'aZ0\u00e9\u4e2d\u3042 \t\n') expect(unicodePunctuation(cp(c)), JSON.stringify(c)).toBe(false);
    expect(unicodePunctuation(0x0301)).toBe(false); // Mn combining acute
    expect(unicodePunctuation(0x00a0)).toBe(false); // Zs no-break space
  });
});

describe('caseFold', () => {
  it('folds where toLowerCase does not', () => {
    // The CommonMark case: [ẞ] must find [SS]: /url.
    expect(caseFold('ẞ')).toBe('ss');
    expect(caseFold('SS')).toBe('ss');
    expect(caseFold('ß')).toBe('ss');
    expect(caseFold('ﬀ')).toBe('ff');
    expect(caseFold('ς')).toBe('σ');   // final sigma folds, does not lowercase
    expect(caseFold('Σ')).toBe('σ');
  });

  it('agrees with toLowerCase everywhere else', () => {
    for (const s of ['ABC', 'Толпой', 'ÉÈ', '中文', '123!', '']) {
      expect(caseFold(s), s).toBe(s.toLowerCase());
    }
  });
});
