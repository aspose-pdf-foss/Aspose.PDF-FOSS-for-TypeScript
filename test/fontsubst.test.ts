import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PdfObject, PdfStream } from '../src/types.js';
import { inflateStream } from '../src/flate.js';
import { wantedCodepoints, WANTED_CAP, resolveSubstitute } from '../src/fontsubst.js';
import type { FaceRecord } from '../src/fontsource.js';
import { buildType0Pdf, buildSimpleTextPdf, fontDictOf } from './helpers/build-text-pdf.js';

/** The resolve/inflate pair raster.ts hands `wantedCodepoints`. */
const rs = (doc: Document) => (o: PdfObject | undefined): PdfObject => doc.resolve(o);
const inf = (s: PdfStream) => inflateStream(s as Parameters<typeof inflateStream>[0]);

/** A /ToUnicode CMap mapping one CID range to a run of code points.
 *
 *  `test/type0-substitute.test.ts` has its own copy and keeps it. Nine lines of
 *  string building that cannot drift silently -- a wrong CMap fails that file's
 *  own cases immediately -- which is the reasoning CLAUDE.md already records
 *  for `measuringDriverFor` living in two places. */
const bfrange = (loCid: number, hiCid: number, loUni: number) =>
  `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n`
  + `1 begincodespacerange <0000> <FFFF> endcodespacerange\n`
  + `1 beginbfrange <${loCid.toString(16).padStart(4, '0')}> `
  + `<${hiCid.toString(16).padStart(4, '0')}> `
  + `<${loUni.toString(16).padStart(4, '0')}> endbfrange\n`
  + `endcmap end end`;

const SHOW = 'BT /F1 48 Tf 20 100 Td <00410042> Tj ET';

describe('wantedCodepoints', () => {
  it("takes a simple font's set from its encoding", () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 48 Tf 20 100 Td (AB) Tj ET'));
    const got = wantedCodepoints(fontDictOf(doc), rs(doc), inf);
    expect(got.has(0x41)).toBe(true);        // 'A', WinAnsi
    expect(got.has(0x4e00)).toBe(false);     // no CJK from a Latin encoding
  });

  it("takes a composite font's set from /ToUnicode when it has one", () => {
    const doc = Document.Open(buildType0Pdf(SHOW, bfrange(0x41, 0x42, 0x4e00)));
    const got = wantedCodepoints(fontDictOf(doc), rs(doc), inf);
    expect(got.has(0x4e00)).toBe(true);
    expect(got.has(0x4e01)).toBe(true);
  });

  it('probes the collection table for a composite font with no /ToUnicode', () => {
    const doc = Document.Open(buildType0Pdf(SHOW, '',
      { baseFont: 'KozMinPr6N-Regular', ordering: 'Japan1', toUnicode: false }));
    const got = wantedCodepoints(fontDictOf(doc), rs(doc), inf);
    expect(got.size).toBeGreaterThan(32);
    // The sample must reach the HAN IDEOGRAPHS, which is what a Japanese
    // document is mostly made of -- a face scored against a sample with no
    // kanji in it says nothing about whether it can draw Japanese.
    //
    // **Measured, and the band matters: `>= 0x3000` does NOT discriminate.**
    // Japan1's early CIDs already carry halfwidth forms and CJK punctuation,
    // so a step of 1 satisfies that bound while reaching ZERO ideographs. Only
    // 0x4E00..0x9FFF separates the readings: step 1 gives 0 of them, step 61
    // gives 152. The first version of this case used 0x3000 and left the
    // step-1 mutation green.
    //
    // It pins the step being LARGE ENOUGH to escape that block, not the value
    // 61 itself -- any step past about 7 clears it.
    const han = [...got].filter((cp) => cp >= 0x4e00 && cp <= 0x9fff);
    expect(han.length).toBeGreaterThan(16);
  });

  it('never exceeds WANTED_CAP', () => {
    const doc = Document.Open(buildType0Pdf(SHOW, '',
      { ordering: 'Japan1', toUnicode: false }));
    expect(wantedCodepoints(fontDictOf(doc), rs(doc), inf).size)
      .toBeLessThanOrEqual(WANTED_CAP);
  });

  it('returns an empty set for an Identity ordering, which has no characters', () => {
    const doc = Document.Open(buildType0Pdf(SHOW, '', { toUnicode: false }));
    expect(wantedCodepoints(fontDictOf(doc), rs(doc), inf).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------

const face = (family: string, extra: Partial<FaceRecord['names']> = {}, i = 0): FaceRecord => ({
  path: `/fake/${family}.ttf`, faceIndex: i,
  names: { family, subfamily: 'Regular', bold: false, italic: false, weight: 400, ...extra },
});
const style = { bold: false, italic: false };

describe('resolveSubstitute', () => {
  it('returns undefined when no face is registered', () => {
    expect(resolveSubstitute([], { baseFont: 'X', style, wanted: new Set([0x41]), serif: false },
      () => undefined)).toBeUndefined();
  });

  // NAME MUST OUTRANK COVERAGE, and the named face has to cover LESS than its
  // rival or the two rungs agree and the ordering is unfalsifiable.
  it('prefers a family named by /BaseFont over a better-covering rival', () => {
    const named = face('MS Mincho');
    const rival = face('Some Other CJK');
    const cov = new Map([[named.path, new Set([0x4e00])],
                         [rival.path, new Set([0x4e00, 0x4e8c, 0x4e09])]]);
    const hit = resolveSubstitute([rival, named],
      { baseFont: 'MS Mincho', style, wanted: new Set([0x4e00, 0x4e8c, 0x4e09]), serif: false },
      (f) => cov.get(f.path))!;
    expect(hit.face.names.family).toBe('MS Mincho');
    expect(hit.rung).toBe('name');
  });

  // `/BaseFont` is the POSTSCRIPT name (32000-1 9.6.2.1), not the family: MS
  // Mincho states `MS-Mincho`, Arial Bold states `Arial-BoldMT`. Matching only
  // the family misses the everyday non-embedded CJK document, which is what
  // this issue exists for -- found by the end-to-end case failing, not by
  // review, and the plan for this work did not have the rule at all.
  it('matches /BaseFont against the PostScript name, not just the family', () => {
    const f = face('MS Mincho', { postScriptName: 'MS-Mincho' });
    const hit = resolveSubstitute([f],
      { baseFont: 'MS-Mincho', style, wanted: new Set([0x4e00]), serif: false },
      () => new Set<number>())!;                // no coverage: only rung 1 can answer
    expect(hit.face.names.family).toBe('MS Mincho');
    expect(hit.rung).toBe('name');
  });

  it('falls to coverage when /BaseFont names nothing installed', () => {
    const poor = face('Latin Only');
    const rich = face('Wide CJK');
    const cov = new Map([[poor.path, new Set([0x41])],
                         [rich.path, new Set([0x41, 0x4e00, 0x4e8c])]]);
    const hit = resolveSubstitute([poor, rich],
      { baseFont: 'Absent Family', style, wanted: new Set([0x41, 0x4e00, 0x4e8c]), serif: false },
      (f) => cov.get(f.path))!;
    expect(hit.face.names.family).toBe('Wide CJK');
    expect(hit.rung).toBe('coverage');
  });

  // THE CMAP CONFIRM MUST OUTRANK ulUnicodeRange: the liar has to CLAIM the
  // range and not deliver it, or the pre-filter and the confirm agree and the
  // confirm can be deleted with the suite still green.
  it('believes the cmap over a ulUnicodeRange that lies', () => {
    const liar = face('Liar', { unicodeRange: [0, 0x08000000, 0, 0] });   // claims bit 59
    const honest = face('Honest', { unicodeRange: [0, 0x08000000, 0, 0] });
    const cov = new Map([[liar.path, new Set<number>()], [honest.path, new Set([0x4e00])]]);
    const hit = resolveSubstitute([liar, honest],
      { baseFont: '', style, wanted: new Set([0x4e00]), serif: false },
      (f) => cov.get(f.path))!;
    expect(hit.face.names.family).toBe('Honest');
  });

  it('keeps a face that states no ulUnicodeRange at all', () => {
    const silent = face('Silent');                       // no unicodeRange field
    const hit = resolveSubstitute([silent],
      { baseFont: '', style, wanted: new Set([0x4e00]), serif: false },
      () => new Set([0x4e00]))!;
    expect(hit.face.names.family).toBe('Silent');
  });

  // THE SAFETY PROPERTY of RANGE_BITS being deliberately partial: a code point
  // no row covers contributes NO bit, so the face is ADMITTED and the cmap
  // decides. Without this the table would have to be complete before it could
  // be trusted -- an omission would silently refuse a face that can draw.
  //
  // **Measured, and it needs a code point OUTSIDE the table**: U+2E80 (CJK
  // Radicals Supplement) has no row. With a wanted set of only known points,
  // `sawKnown` is always true and `return !sawKnown` is indistinguishable from
  // `return false` -- that mutation survived every other case in this file.
  it('admits a face when no wanted code point maps to a known range bit', () => {
    const f = face('Unclaimed', { unicodeRange: [0, 0, 0, 0] });   // claims nothing
    const hit = resolveSubstitute([f],
      { baseFont: '', style, wanted: new Set([0x2e80]), serif: false },
      () => new Set([0x2e80]))!;
    expect(hit.face.names.family).toBe('Unclaimed');
  });

  it('excludes a face whose stated range cannot hold any wanted code point', () => {
    const latin = face('Latin', { unicodeRange: [0x00000001, 0, 0, 0] });  // bit 0 only
    expect(resolveSubstitute([latin],
      { baseFont: '', style, wanted: new Set([0x4e00]), serif: false },
      () => new Set([0x4e00]))).toBeUndefined();
  });

  // THE SERIF TIE-BREAK needs EQUAL coverage: any difference settles it first
  // and this rule goes unmeasured.
  it("breaks an equal-coverage tie on the descriptor's serif flag", () => {
    const sans = face('Tie Sans', { familyClass: 8 });
    const serif = face('Tie Serif', { familyClass: 2 });
    const both = () => new Set([0x4e00]);
    expect(resolveSubstitute([sans, serif],
      { baseFont: '', style, wanted: new Set([0x4e00]), serif: true }, both)!.face.names.family)
      .toBe('Tie Serif');
    expect(resolveSubstitute([serif, sans],
      { baseFont: '', style, wanted: new Set([0x4e00]), serif: false }, both)!.face.names.family)
      .toBe('Tie Sans');
  });

  it('returns undefined when nothing covers enough, rather than a bad face', () => {
    const f = face('Latin Only');
    expect(resolveSubstitute([f],
      { baseFont: '', style, wanted: new Set([0x4e00, 0x4e8c, 0x4e09, 0x56db]), serif: false },
      () => new Set([0x41]))).toBeUndefined();
  });

  it('returns undefined when the font can emit nothing', () => {
    expect(resolveSubstitute([face('Anything')],
      { baseFont: '', style, wanted: new Set(), serif: false },
      () => new Set([0x41]))).toBeUndefined();
  });
});
