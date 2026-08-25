import { describe, it, expect } from 'vitest';
import { getStd14Sfnt } from '../src/std14fonts.js';
import type { StdFont } from '../src/metrics.js';

const FACES: StdFont[] = [
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats',
];

describe('getStd14Sfnt', () => {
  it('loads a face with a usable Unicode cmap and outlines', () => {
    const f = getStd14Sfnt('Helvetica');
    expect(f).toBeDefined();
    expect(f!.cmap.size).toBeGreaterThan(0);
    const gid = f!.cmapLookup('H'.codePointAt(0)!);
    expect(gid).toBeDefined();
    expect(f!.glyphOutline(gid!).length).toBeGreaterThan(0);
  });

  it('caches the parsed font (same instance on repeat)', () => {
    expect(getStd14Sfnt('Times-Bold')).toBe(getStd14Sfnt('Times-Bold'));
  });

  it('loads all 14 faces', () => {
    for (const s of FACES) expect(getStd14Sfnt(s), s).toBeDefined();
  });
});
