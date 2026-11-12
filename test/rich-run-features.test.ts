import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { measureTextBlock } from '../src/stamp.js';
import type { TextRun } from '../src/textdecor.js';
import {
  buildOtFontFor, buildGsub, buildGpos, singleSubstDelta,
  ligatureLookup, markBaseLookup,
} from './helpers/build-sfnt.js';

function setup(bytes = buildOtFontFor({
  cmap: [[0x41, 5], [0x31, 6], [0x66, 10], [0x69, 11], [0x20, 3]],
  gsub: buildGsub([
    singleSubstDelta('smcp', 5, 7), singleSubstDelta('onum', 6, 7),
    ligatureLookup('liga', 10, [11], 20),
  ]),
}), shape = true) {
  const doc = Document.New();
  return { doc, page: doc.AddPage(PageFormat.A4).page, font: doc.AddFont(bytes, { shape }) };
}
const body = (page: ReturnType<typeof setup>['page']) => new TextDecoder().decode(page.Contents);
const box: [number, number, number, number] = [20, 20, 200, 100];

describe('feature-selected rich spans', () => {
  it.each([false, true])('preserves alternate/nominal Unicode collisions in either order: %s', (reverse) => {
    const { doc, page, font } = setup(buildOtFontFor({
      cmap: [[0x41, 5], [0x42, 12]],
      gsub: buildGsub([singleSubstDelta('smcp', 5, 7)]),
    }));
    const runs: TextRun[] = [
      { text: 'A', features: { smcp: true } }, { text: 'B', shape: false },
    ];
    if (reverse) runs.reverse();
    page.AddTextBlock(runs, box, { font });
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toBe(reverse ? 'BA' : 'AB');
    expect([...font.usedGids]).toEqual([12]); // both characters draw the same outline.
    const saved = doc.Save();
    expect(doc.Save()).toEqual(saved); // encoding aliases remain stable across saves.
  });

  it('selects alternates independently and embeds their Unicode after saving', () => {
    const { doc, page, font } = setup();
    page.AddTextBlock([
      { text: 'A', features: { smcp: true } }, { text: 'A' },
    ], box, { font });
    expect(body(page)).toContain('<000c> Tj\n<0005> Tj');
    expect(font.usedGids.has(12)).toBe(true);
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toBe('AA');
  });

  it('merges maps by tag, allowing empty inheritance and explicit cancellation', () => {
    const { page, font } = setup();
    const features = Object.freeze({ onum: true, liga: true });
    page.AddTextBlock([
      { text: '1fi', features: { liga: false } },
      { text: '1fi', features: {} },
      { text: '1', features: { onum: false } },
    ], box, { font, features });
    expect(body(page)).toContain('<000d000a000b> Tj\n<000d0014> Tj\n<0006> Tj');
  });

  it('lets a run enable shaping or override a shaped block and font default', () => {
    const { page, font } = setup();
    page.AddTextBlock([
      { text: 'fi', shape: false }, { text: 'fi' },
      { text: 'A', shape: true, features: { smcp: true } },
    ], box, { font });
    expect(body(page)).toContain('(\\000\\n\\000\\013) Tj');
    expect(body(page)).toContain('<0014> Tj');
    expect(body(page)).toContain('<000c> Tj');
    const other = setup(undefined, false);
    other.page.AddTextBlock([{ text: 'fi', shape: true }], box, { font: other.font });
    expect(body(other.page)).toContain('<0014> Tj');
  });

  it('preserves feature settings in a continuation and keeps measuring pure', () => {
    const { doc, page, font } = setup();
    const features = Object.freeze({ liga: false });
    const runs: TextRun[] = [{ text: 'fi fi', features }];
    const before = doc.Save();
    const measured = measureTextBlock(runs, 52, 14.4, { font, fontSize: 12 });
    expect(measured.remainder).toEqual([{ text: 'fi', features }]);
    expect(font.usedGids.size).toBe(0);
    expect(font.toUnicode.size).toBe(0);
    expect(doc.Save()).toEqual(before);
    const rest = page.AddTextBlock(runs, [20, 20, 52, 14.4], { font, fontSize: 12 });
    expect(rest).toEqual(measured.remainder);
    page.AddTextBlock(rest!, box, { font });
    expect(body(page).match(/<000a000b> Tj/g)).toHaveLength(2);
  });

  it('keeps string and rich measurement pure when shaping is explicitly disabled', () => {
    const { doc, font } = setup();
    const before = doc.Save();
    measureTextBlock('fi', 100, 100, { font, shape: false, features: { liga: false } });
    measureTextBlock([{ text: 'fi', shape: false }], 100, 100, { font });
    expect(font.usedGids.size).toBe(0);
    expect(doc.Save()).toEqual(before);
  });

  it('rejects a malformed later map before recording glyphs or changing the PDF', () => {
    const { doc, page, font } = setup();
    const before = doc.Save();
    expect(() => page.AddTextBlock([
      { text: 'A' }, { text: 'A', features: { wrong: true } },
    ], box, { font })).toThrow(TypeError);
    expect(font.usedGids.size).toBe(0);
    expect(doc.Save()).toEqual(before);
  });

  it('rejects tabs when a later run shapes through its own font default', () => {
    const { doc, page, font } = setup();
    const before = doc.Save();
    expect(() => page.AddTextBlock([
      { text: 'first\t' }, { text: 'A', font },
    ], box, { tabStops: [{ position: 50 }] })).toThrow(/tabStops.*shap/i);
    expect(doc.Save()).toEqual(before);
  });

  it('allows tabs when all runs disable the font or block shaping default', () => {
    const { page, font } = setup();
    expect(() => page.AddTextBlock([{ text: 'A\tA', shape: false }], box,
      { font, shape: true, tabStops: [] })).not.toThrow();
  });

  it('does not report a shaped run consuming a joiner, but reports unshaped loss', () => {
    const { page, font } = setup();
    const reports: { lost: string; all: boolean }[] = [];
    page.AddTextBlock([{ text: 'A\u200d', font }], box,
      { onUndrawable: (u) => reports.push(u) });
    expect(reports).toEqual([]);
    page.AddTextBlock([{ text: 'A\u200d', font, shape: false }], box,
      { onUndrawable: (u) => reports.push(u) });
    expect(reports).toEqual([{ lost: '\u200d', all: false }]);
  });

  it('reorders a single RTL span while keeping hard boundaries between runs', () => {
    const { page, font } = setup(buildOtFontFor({
      cmap: [[0x0628, 40]],
      gsub: buildGsub([singleSubstDelta('init', 40, 1), singleSubstDelta('fina', 40, 3)]),
    }));
    page.AddTextBlock([
      { text: 'بب', dir: 'rtl', script: 'arab' },
      { text: 'ب', dir: 'rtl', script: 'arab' },
    ], box, { font });
    expect(body(page)).toContain('<002b0029> Tj\n<0028> Tj');
  });
});

describe('shaped span geometry', () => {
  it.each([false, true])('offers a whole contextual token before splitting it: rich=%s', (rich) => {
    const { page, font } = setup(buildOtFontFor({
      cmap: [[0x7532, 5], [0x4e59, 10], [0x4e19, 11], [0x4e01, 12], [0x20, 3]],
      gsub: buildGsub([ligatureLookup('ss01', 5, [3, 10, 11, 12], 4)]),
    }));
    const opts = { font, fontSize: 10, features: { ss01: true } };
    const rect: [number, number, number, number] = [20, 20, 20, 12];
    const rest = rich ? page.AddTextBlock([{ text: '甲 乙丙丁' }], rect, opts)
      : page.AddTextBlock('甲 乙丙丁', rect, opts);
    expect(rest).toBeNull();
    expect(body(page)).toContain('<0004> Tj');
  });

  it('packs using the emitted span when GSUB crosses a space', () => {
    const { page, font } = setup(buildOtFontFor({
      cmap: [[0x41, 5], [0x42, 6], [0x20, 3]],
      gsub: buildGsub([ligatureLookup('ss01', 5, [3, 6], 4)]),
    }));
    const rest = page.AddTextBlock([{ text: 'A B', features: { ss01: true } }],
      [20, 20, 10, 12], { font, fontSize: 10 });
    expect(rest).toBeNull(); // 4pt selected glyph fits; 5 + 3 + 6 does not.
    expect(body(page)).toContain('<0004> Tj');
  });

  it('uses the selected advance for decorations and links', () => {
    const { page, font } = setup();
    page.AddTextBlock([{ text: 'A', features: { smcp: true }, underline: true, link: 'https://example.com' }],
      box, { font, fontSize: 10 });
    const rect = page.Annotations.find((a) => a.Subtype === 'Link')!.Rect!;
    expect(rect[2] - rect[0]).toBeCloseTo(12); // alternate gid12 = 1200 units.
    const rule = [...body(page).matchAll(/([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re f/g)][0];
    expect(Number(rule[3])).toBeCloseTo(12);
  });

  it('composes a mark offset with run rise and restores the following baseline', () => {
    const { doc, page, font } = setup(buildOtFontFor({
      cmap: [[0x41, 5], [0x42, 6], [0x301, 7]],
      gpos: buildGpos([markBaseLookup('mark', 7, { x: 0, y: 0 }, 5, { x: 250, y: 300 })]),
    }));
    page.AddTextBlock([
      { text: 'A\u0301', rise: 4 }, { text: 'B', font: 'Helvetica' },
    ], box, { font, fontSize: 10 });
    const c = body(page);
    expect(c).toContain('7 Ts'); // 4pt run rise + 300 * 10 / 1000.
    expect(c).toMatch(/7 Ts[\s\S]*4 Ts[\s\S]*0 Ts[\s\S]*\(B\) Tj/);
    const fragments = Document.Open(doc.Save()).Pages[0].GetTextFragments();
    expect(fragments.map((f) => f.text)).toContain('B');
    const b = fragments.find((f) => f.text === 'B')!;
    expect(b.quad[0]).toBeCloseTo(25); // base advance 5pt; mark advances zero.
  });
});
