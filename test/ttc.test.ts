import { describe, it, expect } from 'vitest';
import { ttcFaceOffsets, extractTtcFace } from '../src/ttc.js';
import { parseSfnt } from '../src/sfnt.js';
import { readFontNames } from '../src/fontnames.js';
import { buildNamedFont, buildTtc } from './helpers/build-sfnt.js';
import { PdfParseError } from '../src/errors.js';

const ALPHA = () => buildNamedFont({ family: 'Alpha Sans' });
const BETA = () => buildNamedFont({ family: 'Beta Serif', bold: true });
const PAIR = () => buildTtc([ALPHA(), BETA()]);

/** Does `hay` contain the UTF-16BE bytes of `text`? Name records are stored
 *  that way, so this asks whether a face's own bytes carry a sibling's name. */
function containsUtf16(hay: Uint8Array, text: string): boolean {
  const needle = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    needle[i * 2] = text.charCodeAt(i) >> 8;
    needle[i * 2 + 1] = text.charCodeAt(i) & 0xff;
  }
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe('ttcFaceOffsets', () => {
  it('reports one offset per face', () => {
    const offsets = ttcFaceOffsets(PAIR());
    expect(offsets).toBeDefined();
    expect(offsets).toHaveLength(2);
    expect(offsets![0]).toBeLessThan(offsets![1]);
  });

  it('declines a plain sfnt and garbage', () => {
    expect(ttcFaceOffsets(ALPHA())).toBeUndefined();
    expect(ttcFaceOffsets(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
  });
});

describe('extractTtcFace', () => {
  it('rebuilds each face as a standalone sfnt', () => {
    const ttc = PAIR();
    expect(readFontNames(extractTtcFace(ttc, 0))!.family).toBe('Alpha Sans');
    expect(readFontNames(extractTtcFace(ttc, 1))!.family).toBe('Beta Serif');
  });

  it('produces bytes parseSfnt accepts on their own', () => {
    const face = parseSfnt(extractTtcFace(PAIR(), 1));
    expect(face.postScriptName).toBe('BetaSerif');
    expect(face.numGlyphs).toBe(2);
  });

  it('carries no trace of its sibling', () => {
    // THE point of extracting rather than pointing a face at the collection.
    // SfntFont resolves tables by absolute offset into `raw`, so keeping the
    // whole .ttc as `raw` decodes perfectly -- and fontembed.ts's CFF fallback
    // whole-embeds `font.raw`, which would put every face of a 40 MB system
    // collection into the PDF as one font. Every other assertion in this file
    // passes under that build; only this one fails.
    const ttc = PAIR();
    const face = extractTtcFace(ttc, 0);
    expect(containsUtf16(ttc, 'Beta Serif')).toBe(true);      // control
    expect(containsUtf16(face, 'Alpha Sans')).toBe(true);
    expect(containsUtf16(face, 'Beta Serif')).toBe(false);
    expect(face.length).toBeLessThan(ttc.length);
  });

  it('throws for a face index the collection does not have', () => {
    expect(() => extractTtcFace(PAIR(), 2)).toThrow(PdfParseError);
    expect(() => extractTtcFace(PAIR(), -1)).toThrow(PdfParseError);
  });

  it('throws when handed something that is not a collection', () => {
    expect(() => extractTtcFace(ALPHA(), 0)).toThrow(PdfParseError);
  });
});

describe('parseSfnt — collections', () => {
  it('takes face 0 by default and the named face on request', () => {
    const ttc = PAIR();
    expect(parseSfnt(ttc).postScriptName).toBe('AlphaSans');
    expect(parseSfnt(ttc, 0).postScriptName).toBe('AlphaSans');
    expect(parseSfnt(ttc, 1).postScriptName).toBe('BetaSerif');
  });

  it('leaves a plain sfnt untouched whatever the face index says', () => {
    // A faceIndex on a non-collection is meaningless rather than an error: the
    // caller may not know which kind of file they were handed.
    expect(parseSfnt(ALPHA(), 0).postScriptName).toBe('AlphaSans');
    expect(parseSfnt(ALPHA(), 3).postScriptName).toBe('AlphaSans');
  });
});
