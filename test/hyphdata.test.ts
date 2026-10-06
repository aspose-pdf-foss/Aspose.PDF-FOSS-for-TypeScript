import { describe, it, expect } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { HYPH_LANGUAGES } from '../src/hyphdata.js';

describe('hyphdata (v9j3.2)', () => {
  it('bundles exactly the nine starter languages, in order', () => {
    expect(HYPH_LANGUAGES.map((l) => l.tag)).toEqual(['en-US', 'en-GB', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl']);
  });

  it('carries each source licence and positive hyphenmins', () => {
    for (const l of HYPH_LANGUAGES) {
      expect(l.licence).toMatch(/copyright/i);
      expect(l.left).toBeGreaterThan(0);
      expect(l.right).toBeGreaterThan(0);
    }
    expect(HYPH_LANGUAGES.find((l) => l.tag === 'en-US')!.right).toBe(3);
  });

  it('decodes to Liang patterns and an exception list', () => {
    for (const l of HYPH_LANGUAGES) {
      const [pats, exc] = inflateRawSync(Buffer.from(l.data, 'base64')).toString('utf8').split('\n---\n');
      expect(pats.split(' ').length).toBeGreaterThan(100);
      expect(pats).toMatch(/\d/);
      expect(exc).toBeDefined();
    }
    const en = inflateRawSync(Buffer.from(HYPH_LANGUAGES[0].data, 'base64')).toString('utf8');
    expect(en.split('\n---\n')[1]).toMatch(/-/);   // en-US ships exceptions
  });
});
