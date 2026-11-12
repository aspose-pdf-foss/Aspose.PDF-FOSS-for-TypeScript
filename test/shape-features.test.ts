import { describe, it, expect } from 'vitest';
import { parseSfnt } from '../src/sfnt.js';
import { shapeText, measureShaped } from '../src/shape.js';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import {
  buildOtFontFor, buildGsub, buildGpos, singleSubstDelta,
  ligatureLookup, pairKernLookup,
} from './helpers/build-sfnt.js';

const ligFont = () => buildOtFontFor({
  cmap: [[0x66, 10], [0x69, 11], [0x20, 3]],
  gsub: buildGsub([ligatureLookup('liga', 10, [11], 20)]),
});

describe('OpenType feature selection', () => {
  it('disables standard ligatures without changing defaults or the caller map', () => {
    const sfnt = parseSfnt(ligFont());
    const features = Object.freeze({ liga: false });
    expect(shapeText('fi', sfnt, { features })[0].glyphs.map((g) => g.gid)).toEqual([10, 11]);
    expect(shapeText('fi', sfnt)[0].glyphs.map((g) => g.gid)).toEqual([20]);
  });

  it.each(['onum', 'smcp', 'ss01', 'ss20'])('enables font-provided %s alternates', (tag) => {
    const sfnt = parseSfnt(buildOtFontFor({
      cmap: [[0x41, 5]], gsub: buildGsub([singleSubstDelta(tag, 5, 7)]),
    }));
    expect(shapeText('A', sfnt, { features: { [tag]: true } })[0].glyphs[0].gid).toBe(12);
    expect(shapeText('A', sfnt)[0].glyphs[0].gid).toBe(5);
  });

  it('applies feature lookups in font order rather than map order', () => {
    const sfnt = parseSfnt(buildOtFontFor({
      cmap: [[0x41, 5]],
      gsub: buildGsub([singleSubstDelta('smcp', 5, 1), singleSubstDelta('ss01', 6, 1)]),
    }));
    expect(shapeText('A', sfnt, { features: { ss01: true, smcp: true, xxxx: true } })[0].glyphs[0].gid).toBe(7);
  });

  it('disables GPOS kerning and enables optional GPOS tags', () => {
    const sfnt = parseSfnt(buildOtFontFor({
      cmap: [[0x41, 5], [0x42, 6]],
      gpos: buildGpos([pairKernLookup('kern', 5, 6, -40), pairKernLookup('ss01', 5, 6, -20)]),
    }));
    expect(measureShaped(shapeText('AB', sfnt, { features: { kern: false } }))).toBe(1100);
    expect(measureShaped(shapeText('AB', sfnt, { features: { kern: false, ss01: true } }))).toBe(1080);
  });

  it('suppresses an Arabic form only at its joining position', () => {
    const sfnt = parseSfnt(buildOtFontFor({
      cmap: [[0x0628, 40]],
      gsub: buildGsub([singleSubstDelta('init', 40, 1), singleSubstDelta('medi', 40, 2), singleSubstDelta('fina', 40, 3)]),
    }));
    const r = shapeText('ببب', sfnt, { dir: 'rtl', features: { init: false, fina: true } });
    expect(r[0].glyphs.map((g) => g.gid)).toEqual([43, 42, 40]);
  });

  it.each([null, [], { liga: 1 }, { bad: true }, { 'éabc': true }, { 'ab\nc': true }])(
    'rejects malformed feature maps even for empty text: %j', (features) => {
      const sfnt = parseSfnt(ligFont());
      // Exercise the JavaScript boundary as well as the TypeScript API.
      expect(() => shapeText('', sfnt, { features: features as never })).toThrow(TypeError);
    },
  );
});

describe('feature-selected page authoring', () => {
  it('uses the selected advances in MeasureText and emits the selected glyphs', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(ligFont(), { shape: true });
    const page = doc.Pages[0];
    expect(page.MeasureText('fi', 12, font, { features: { liga: false } })).toBeCloseTo(25.2);
    expect(page.MeasureText('fi', 12, font)).toBeCloseTo(24);
    page.AddText('fi', 20, 100, { font, features: { liga: false } });
    expect(new TextDecoder().decode(page.Contents)).toContain('<000a000b> Tj');
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toContain('fi');
  });

  it('wraps string blocks using the selected ligature width', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(ligFont(), { shape: true });
    // 24 + 3.6 + 24 fits in 52; 25.2 + 3.6 + 25.2 does not.
    const rest = doc.Pages[0].AddTextBlock('fi fi', [20, 20, 52, 14.4], {
      font, fontSize: 12, features: { liga: false },
    });
    expect(rest).toBe('fi');
  });

  it('keeps shape:false byte-identical and rejects invalid maps before mutation', () => {
    const a = Document.Open(buildStampTarget());
    const b = Document.Open(buildStampTarget());
    const fa = a.AddFont(ligFont()), fb = b.AddFont(ligFont());
    a.Pages[0].AddText('fi', 20, 100, { font: fa, features: { liga: false } });
    b.Pages[0].AddText('fi', 20, 100, { font: fb });
    expect(a.Pages[0].Contents).toEqual(b.Pages[0].Contents);
    const before = a.Save();
    expect(() => a.Pages[0].AddText('', 20, 100, { features: { wrong: true } })).toThrow(TypeError);
    expect(a.Save()).toEqual(before);
  });
});
