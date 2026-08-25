import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { STD14_DATA } from '../src/std14data.js';

const FACES = [
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats',
] as const;

describe('STD14_DATA', () => {
  it('has all 14 faces', () => {
    expect(Object.keys(STD14_DATA).sort()).toEqual([...FACES].sort());
  });

  it('each blob inflates to a TrueType sfnt', () => {
    for (const face of FACES) {
      const bytes = new Uint8Array(inflateSync(Buffer.from(STD14_DATA[face], 'base64')));
      const tag = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
      expect(tag, face).toBe(0x00010000);   // TrueType outline sfnt version 1.0
    }
  });
});
