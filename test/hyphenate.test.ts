import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { HYPH_LANGUAGES } from '../src/hyphdata.js';
import { resolveHyphenation, hyphenator, hyphenationLanguages } from '../src/hyphenate.js';

const hy = (o: object) => hyphenator(resolveHyphenation(o));
/** The word with a '-' at each point. */
const show = (o: object, w: string) => {
  const pts = hy(o).points(w);
  let s = '', at = 0;
  for (const p of pts) { s += w.slice(at, p) + '-'; at = p; }
  return s + w.slice(at);
};

describe('resolveHyphenation (v9j3.2)', () => {
  it('lists the nine bundled languages', () => {
    expect(hyphenationLanguages()).toEqual(['en-US', 'en-GB', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl']);
  });

  it('matches a tag by RFC 4647, any case', () => {
    expect(resolveHyphenation({ lang: 'EN-us' }).tag).toBe('en-US');
    expect(resolveHyphenation({ lang: 'en' }).tag).toBe('en-US');
    expect(resolveHyphenation({ lang: 'de-AT' }).tag).toBe('de');
    expect(resolveHyphenation({ lang: 'pt-BR' }).tag).toBe('pt');
  });

  it('falls back to the first table of the same primary language for an unlisted region', () => {
    expect(resolveHyphenation({ lang: 'en-AU' }).tag).toBe('en-US');
    expect(resolveHyphenation({ lang: 'EN-ca' }).tag).toBe('en-US');
    expect(() => resolveHyphenation({ lang: 'ru-RU' })).toThrow(RangeError);
  });

  it('defaults the minimums to the language and minWord to 5', () => {
    expect(resolveHyphenation({ lang: 'en' })).toEqual({ tag: 'en-US', mode: 'auto', minLeft: 2, minRight: 3, minWord: 5 });
  });

  it('takes the fallback lang when none is stated', () => {
    expect(resolveHyphenation({}, 'fr').tag).toBe('fr');
    expect(resolveHyphenation({ lang: 'de' }, 'fr').tag).toBe('de');
  });

  it('refuses the wrong kind of value with TypeError', () => {
    expect(() => resolveHyphenation(null)).toThrow(TypeError);
    expect(() => resolveHyphenation({ lang: 5 })).toThrow(TypeError);
    expect(() => resolveHyphenation({ lang: 'en', minLeft: 1.5 })).toThrow(TypeError);
  });

  it('refuses a value outside the set with RangeError', () => {
    expect(() => resolveHyphenation({ lang: 'ru' })).toThrow(RangeError);
    expect(() => resolveHyphenation({})).toThrow(RangeError);              // auto needs a lang
    expect(() => resolveHyphenation({ lang: 'en', mode: 'full' })).toThrow(RangeError);
    expect(() => resolveHyphenation({ lang: 'en', minWord: 0 })).toThrow(RangeError);
  });

  it('lets manual mode take any lang or none', () => {
    expect(resolveHyphenation({ mode: 'manual' })).toMatchObject({ mode: 'manual', tag: undefined });
    expect(resolveHyphenation({ mode: 'manual', lang: 'ru' }).mode).toBe('manual');
  });
});

describe('hyphenator (v9j3.2)', () => {
  it("reproduces the hyphen package README's published examples", () => {
    // https://github.com/ytiurin/hyphen README — an independent implementation.
    expect(show({ lang: 'en-US' }, 'certain')).toBe('cer-tain');
    expect(show({ lang: 'en-US' }, 'beautiful')).toBe('beau-ti-ful');
    expect(['gewisser', 'König', 'hatte', 'wunderschönen', 'Garten'].map((w) => show({ lang: 'de' }, w)))
      .toEqual(['ge-wis-ser', 'Kö-nig', 'hat-te', 'wun-der-schö-nen', 'Gar-ten']);
  });

  it('returns every bundled exception exactly as listed', () => {
    for (const l of HYPH_LANGUAGES) {
      const exc = inflateRawSync(Buffer.from(l.data, 'base64')).toString('utf8').split('\n---\n')[1];
      for (const e of exc.split(' ').filter(Boolean)) {
        const word = e.replace(/-/g, '');
        const lim = { lang: l.tag, minLeft: 1, minRight: 1, minWord: 1 };
        expect(show(lim, word)).toBe(e);
      }
    }
  });

  it('hyphenates only the letters, matching capitals in lower case', () => {
    expect(show({ lang: 'en' }, '“Beautiful,”')).toBe('“Beau-ti-ful,”');
    // A capital that a pattern needs: matched raw, 'Hyphenation' loses its
    // first break and an all-caps word loses every one.
    expect(show({ lang: 'en' }, 'Hyphenation')).toBe('Hy-phen-ation');
    expect(show({ lang: 'en' }, 'BEAUTIFUL')).toBe('BEAU-TI-FUL');
  });

  it('respects minLeft, minRight and minWord', () => {
    expect(show({ lang: 'en', minLeft: 5 }, 'beautiful')).toBe('beauti-ful');
    expect(show({ lang: 'en', minRight: 4 }, 'beautiful')).toBe('beau-tiful');
    expect(show({ lang: 'en', minWord: 10 }, 'beautiful')).toBe('beautiful');
  });

  it('leaves a word with an inner non-letter to its soft hyphens', () => {
    expect(hy({ lang: 'en' }).points('e-mail1234')).toEqual([]);
  });

  it('honours soft hyphens in both modes, and patterns only in auto', () => {
    const w = 'hy­phenation';
    expect(hy({ mode: 'manual' }).points(w)).toEqual([3]);
    const auto = hy({ lang: 'en' }).points(w);
    expect(auto).toContain(3);
    expect(auto.length).toBeGreaterThan(1);
  });

  it('caches the hyphenator for identical options', () => {
    expect(hy({ lang: 'en' })).toBe(hy({ lang: 'en-US' }));
  });
});
