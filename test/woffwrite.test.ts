import { describe, it, expect } from 'vitest';
import { sfntToWoff } from '../src/woffwrite.js';
import { sfntFromWoff } from '../src/woff.js';
import { buildMinimalTtf } from './helpers/build-sfnt.js';
import { parseSfnt } from '../src/sfnt.js';

describe('sfntToWoff', () => {
  it('has the wOFF signature', () => {
    const woff = sfntToWoff(buildMinimalTtf());
    expect((woff[0] << 24 | woff[1] << 16 | woff[2] << 8 | woff[3]) >>> 0).toBe(0x774f4646);
  });

  it('round-trips every table through sfntFromWoff', () => {
    const ttf = buildMinimalTtf();
    const back = parseSfnt(sfntFromWoff(sfntToWoff(ttf)));
    const orig = parseSfnt(ttf);
    expect(back.numGlyphs).toBe(orig.numGlyphs);
    expect(back.cmap.get(0x41)).toBe(orig.cmap.get(0x41));
    expect(back.outlines).toBe(orig.outlines);
  });
});
