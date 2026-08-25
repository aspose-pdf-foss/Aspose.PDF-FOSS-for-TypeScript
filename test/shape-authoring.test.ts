import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { Page } from '../src/page.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildOtFontFor, buildGsub, buildGpos, ligatureLookup, pairKernLookup, singleSubstDelta } from './helpers/build-sfnt.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);

function ligFont() {
  const gsub = buildGsub([ligatureLookup('liga', 10, [11], 20)]); // f+i → fi (gid20)
  return buildOtFontFor({ gsub, cmap: [[0x66, 10], [0x69, 11]] });
}

describe('shaped /ToUnicode', () => {
  it('maps a ligature gid back to its source code points', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(ligFont(), { shape: true });
    doc.Pages[0].AddText('fi', 20, 100, { font, fontSize: 12 });
    const round = Document.Open(doc.Save());
    // The single ligature glyph (gid20) maps back to both source code points via
    // the shaped /ToUnicode override ('Original' — the fixture's own text — has no 'fi').
    expect(round.Pages[0].GetText()).toContain('fi');
  });
});

describe('AddText shaped emission', () => {
  it('emits shaped Arabic in RTL visual order with a Tf/TJ|Tj body', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(buildOtFontFor({ cmap: [[0x0627, 30], [0x0628, 31]] }), { shape: true }); // alef, beh
    doc.Pages[0].AddText('اب', 20, 100, { font, fontSize: 12, dir: 'rtl' });
    const body = decoded(doc.Pages[0]);
    expect(body).toMatch(/BT[\s\S]*Tf[\s\S]*(Tj|TJ)[\s\S]*ET/);
    // visual order beh(31=0x1f) then alef(30=0x1e): 001f before 001e
    expect(body).toMatch(/<001f0*1e>|<001f> ?<001e>|001f001e/);
  });

  it('emits a kern advance delta as a TJ number', () => {
    const gsub = buildGsub([ligatureLookup('liga', 10, [11], 20)]);
    const gpos = buildGpos([pairKernLookup('kern', 20, 12, -40)]);
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(buildOtFontFor({ gsub, gpos, cmap: [[0x66, 10], [0x69, 11], [0x6a, 12]] }), { shape: true });
    doc.Pages[0].AddText('fij', 20, 100, { font, fontSize: 12 });
    const body = decoded(doc.Pages[0]);
    expect(body).toContain('TJ');
    expect(body).toMatch(/\[<0014> 40 <000c>\] TJ/);
  });
});

describe('AddTextBlock shaped path', () => {
  it('shapes each wrapped line (ligature gid present + round-trip)', () => {
    const doc = Document.Open(buildStampTarget());
    const gsub = buildGsub([ligatureLookup('liga', 10, [11], 20)]);
    const font = doc.AddFont(buildOtFontFor({ gsub, cmap: [[0x66, 10], [0x69, 11], [0x20, 3]] }), { shape: true });
    // Narrow box forces a wrap between the two 'fi' words.
    doc.Pages[0].AddTextBlock('fi fi', [20, 20, 40, 200], { font, fontSize: 12 });
    const body = decoded(doc.Pages[0]);
    expect(body).toContain('0014'); // ligature gid 20 = 0x14 appears
    const round = Document.Open(doc.Save());
    expect(round.Pages[0].GetText().replace(/\s+/g, ' ')).toContain('fi');
  });
});

describe('acceptance: Arabic joining + rlig', () => {
  it('lam-alef joins (init/fina) then rlig-ligates, RTL order, round-trips', () => {
    // lam 0x0644→gid50, alef 0x0627→gid51.
    // Joining forms apply first (single-glyph slices): lam.init→55, alef.fina→56.
    // Then rlig ligates the joined pair 55+56 → lam-alef ligature gid60.
    const gsub = buildGsub([
      singleSubstDelta('init', 50, 5),      // 50 → 55 (lam.init)
      singleSubstDelta('fina', 51, 5),      // 51 → 56 (alef.fina)
      ligatureLookup('rlig', 55, [56], 60), // lam.init + alef.fina → lam-alef (60)
    ]);
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(buildOtFontFor({ gsub, cmap: [[0x0644, 50], [0x0627, 51]] }), { shape: true });
    doc.Pages[0].AddText('لا', 20, 100, { font, fontSize: 12, dir: 'rtl', script: 'arab' });
    const body = decoded(doc.Pages[0]);
    expect(body).toContain('003c'); // lam-alef ligature gid 60 = 0x3c selected
    const round = Document.Open(doc.Save());
    expect(round.Pages[0].GetText()).toContain('لا'); // /ToUnicode restores both source code points
  });
});

describe('MeasureText reflects shaping', () => {
  it('a ligature narrows the measured width vs the 1:1 path', () => {
    const doc = Document.Open(buildStampTarget());
    const gsub = buildGsub([ligatureLookup('liga', 10, [11], 20)]); // gid20 advance 2000; 10+11 = 1000+1100
    const font = doc.AddFont(buildOtFontFor({ gsub, cmap: [[0x66, 10], [0x69, 11]] }), { shape: true });
    const shaped = doc.Pages[0].MeasureText('fi', 12, font);              // ligature: 2000 units
    const raw = doc.Pages[0].MeasureText('fi', 12, font, { shape: false }); // 1000+1100 = 2100 units
    expect(shaped).toBeCloseTo(2000 * 12 / 1000, 6);
    expect(raw).toBeCloseTo((1000 + 1100) * 12 / 1000, 6);
  });
});

describe('non-shaped path is byte-identical', () => {
  it('shape:false embedded Latin uses the 1:1 path (single Tj, no TJ/Ts)', () => {
    const font0 = buildOtFontFor({ cmap: [[0x41, 1], [0x42, 2]] });
    // Draw with shaping explicitly off, and again with a plain non-shaping font:
    // the appended show-op must be a single Tj with 2-byte codes, no TJ/Ts.
    const a = Document.Open(buildStampTarget());
    const fa = a.AddFont(font0); // shape default false
    a.Pages[0].AddText('AB', 20, 100, { font: fa, fontSize: 12, shape: false });
    const bodyA = decoded(a.Pages[0]);

    const b = Document.Open(buildStampTarget());
    const fb = b.AddFont(font0);
    b.Pages[0].AddText('AB', 20, 100, { font: fb, fontSize: 12 });
    const bodyB = decoded(b.Pages[0]);

    // The 1:1 path serializes 2-byte codes as an octal literal string (not hex),
    // exactly as before the feature — a single Tj, no shaped TJ/Ts ops.
    expect(bodyA).toContain('(\\000\\001\\000\\002) Tj');
    expect(bodyA).not.toContain('TJ');
    expect(bodyA).not.toContain('Ts');
    // shape:false is byte-identical to the plain (no-shape-option) draw.
    expect(bodyA).toBe(bodyB);
  });
});
