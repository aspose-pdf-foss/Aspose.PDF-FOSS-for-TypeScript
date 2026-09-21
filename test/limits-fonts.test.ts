import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { LoadLimits, type LimitField, type LoadLimitPatch } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { CffFont } from '../src/cff.js';
import { runType1Charstring } from '../src/type1charstring.js';
import { parseSfnt, readCmap } from '../src/sfnt.js';
import { parseCMap } from '../src/cmap.js';
import { buildSubrFanoutCff } from './helpers/build-cff.js';
import { buildCompositeFanoutTtf } from './helpers/build-sfnt.js';
import { buildType1, t1num } from './helpers/build-type1.js';
import { buildType1Pdf } from './helpers/build-type1-pdf.js';

// ibzo.12: the work of parsing a FONT PROGRAM. Every gap probed was work hidden
// behind a bound that already existed — a depth cap of 10 on subroutine calls,
// of 6 on composite glyphs — or a character map expanding a declared range.

function refusal(f: () => unknown): ResourceLimitError {
  try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e; throw e; }
  throw new Error('completed without reaching a limit');
}
const expectLimit = (e: ResourceLimitError, field: LimitField) => expect(e.limit).toBe(field);
const limits = (patch: LoadLimitPatch) => LoadLimits.defaults.with(patch);

/** Type 1 subrs fanning out like buildSubrFanoutCff's: subr i < levels-1 calls
 *  subr i+1 `k` times, the last draws a line. The glyph is hsbw, a call to subr
 *  0 and endchar — 3 operators, plus k+1 per fan-out instance and 2 per leaf. */
function type1Fanout(k: number, levels: number): { glyph: Uint8Array; subrs: Uint8Array[] } {
  const subrs: Uint8Array[] = [];
  for (let i = 0; i < levels; i++) {
    subrs.push(i === levels - 1
      ? Uint8Array.from([...t1num(1), ...t1num(1), 5, 11])
      : Uint8Array.from([...Array.from({ length: k }, () => [...t1num(i + 1), 10]).flat(), 11]));
  }
  return { glyph: Uint8Array.from([...t1num(0), ...t1num(500), 13, ...t1num(0), 10, 14]), subrs };
}

describe('maxGlyphOperations', () => {
  it('CFF: counts every operator a glyph executes, subroutines included, to the exact operator', () => {
    // k = 2 over 3 levels: 2 + (3 + 6) + 8 = 19 operators.
    const cff = buildSubrFanoutCff(2, 3);
    expect(() => new CffFont(cff, limits({ maxGlyphOperations: 19 })).glyphPath(1)).not.toThrow();
    expectLimit(refusal(() => new CffFont(cff, limits({ maxGlyphOperations: 18 })).glyphPath(1)), 'maxGlyphOperations');
  });

  it('CFF: a fan-out that killed the process (10^9 leaves in under a kilobyte) is refused under the DEFAULTS', () => {
    // Probed before the fix: heap exhausted, exit 134 — a crash no catch sees.
    expectLimit(refusal(() => new CffFont(buildSubrFanoutCff(10, 10)).glyphPath(1)), 'maxGlyphOperations');
  });

  it('CFF: the count is per GLYPH, not per font', () => {
    const font = new CffFont(buildSubrFanoutCff(2, 3), limits({ maxGlyphOperations: 19 }));
    font.glyphPath(1);
    expect(() => font.glyphPath(1)).not.toThrow();
    expect(() => font.glyphWidth(1)).not.toThrow();
  });

  it('Type 1: counts every operator to the exact operator, and refuses the killing fan-out under the defaults', () => {
    // k = 2 over 3 levels: 3 + 3 + 6 + 8 = 20 operators.
    const { glyph, subrs } = type1Fanout(2, 3);
    expect(() => runType1Charstring(glyph, { subrs, limits: limits({ maxGlyphOperations: 20 }) })).not.toThrow();
    expectLimit(refusal(() => runType1Charstring(glyph, { subrs, limits: limits({ maxGlyphOperations: 19 }) })),
      'maxGlyphOperations');
    const big = type1Fanout(10, 10);
    expectLimit(refusal(() => runType1Charstring(big.glyph, { subrs: big.subrs })), 'maxGlyphOperations');
  });

  it('Type 1: an embedded /FontFile renders under the DOCUMENT\'s policy', () => {
    // The glyph program reaches the policy through its own stream's registration
    // (ibzo.3), so no signature between Document and Type1Font had to change.
    const { glyph, subrs } = type1Fanout(10, 10);
    const program = buildType1({
      charstrings: { '.notdef': Uint8Array.from([...t1num(0), ...t1num(500), 13, 14]), A: glyph },
      subrs,
    });
    const pdf = buildType1Pdf(program, { text: 'A', size: 12 });
    expectLimit(refusal(() => Document.Open(pdf).Pages[0].ToImage()), 'maxGlyphOperations');
    const small = type1Fanout(2, 3);
    const okPdf = buildType1Pdf(buildType1({
      charstrings: { '.notdef': Uint8Array.from([...t1num(0), ...t1num(500), 13, 14]), A: small.glyph },
      subrs: small.subrs,
    }), { text: 'A', size: 12 });
    expect(() => Document.Open(okPdf, { limits: limits({ maxGlyphOperations: 20 }) }).Pages[0].ToImage()).not.toThrow();
    expectLimit(refusal(() => Document.Open(okPdf, { limits: limits({ maxGlyphOperations: 19 }) }).Pages[0].ToImage()),
      'maxGlyphOperations');
  });

  it('TrueType: counts composite components visited, to the exact component', () => {
    // k = 2 over 3 levels: 2 + 4 + 8 = 14 components from the top glyph (gid 4).
    const ttf = buildCompositeFanoutTtf(2, 3);
    expect(() => parseSfnt(ttf, 0, limits({ maxGlyphOperations: 14 })).glyphOutline(4)).not.toThrow();
    expectLimit(refusal(() => parseSfnt(ttf, 0, limits({ maxGlyphOperations: 13 })).glyphOutline(4)),
      'maxGlyphOperations');
  });

  it('TrueType: the count resets for each glyph asked, and a 16-way fan-out is refused under the defaults', () => {
    const font = parseSfnt(buildCompositeFanoutTtf(2, 3), 0, limits({ maxGlyphOperations: 14 }));
    font.glyphOutline(4);
    expect(() => font.glyphOutline(4)).not.toThrow();
    // Probed before the fix: 8-way took 10 s and 16-way did not finish in 60.
    expectLimit(refusal(() => parseSfnt(buildCompositeFanoutTtf(16, 6)).glyphOutline(7)), 'maxGlyphOperations');
  });
});

describe('character-map expansion (maxContainerItems)', () => {
  const u16 = (n: number) => [(n >> 8) & 255, n & 255];
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  /** A cmap table holding one (3,10) format 12 subtable of `groups`. */
  const format12 = (groups: [number, number, number][]) => Uint8Array.from([
    ...u16(0), ...u16(1), ...u16(3), ...u16(10), ...u32(12),
    ...u16(12), 0, 0, ...u32(16 + 12 * groups.length), ...u32(0), ...u32(groups.length),
    ...groups.flatMap(([a, b, g]) => [...u32(a), ...u32(b), ...u32(g)])]);

  it('sfnt format 12: refuses one entry past the bound, and admits one at it', () => {
    expect(readCmap(format12([[0, 999, 1]]), limits({ maxContainerItems: 1000 })).size).toBe(1000);
    expectLimit(refusal(() => readCmap(format12([[0, 1000, 1]]), limits({ maxContainerItems: 1000 }))),
      'maxContainerItems');
  });

  it('sfnt format 12: a group reaching 0xFFFFFFFF maps only through U+10FFFF', () => {
    // Before, one such group asked for 2^32 entries and died with "Map maximum
    // size exceeded". Past U+10FFFF is not Unicode, so there is nothing to map.
    const m = readCmap(format12([[0x10fff0, 0xffffffff, 1]]), LoadLimits.unlimited());
    expect(m.size).toBe(16);
  });

  it('sfnt format 4: counts entries WRITTEN, so overlapping segments cannot spin', () => {
    // 200 segments each rewriting 0..0xFFFE: the map never grows past 65,535,
    // and without counting writes this ran 2.1 billion iterations at 32,767.
    const segs = 200;
    const sub = [...u16(4), ...u16(16 + segs * 8), ...u16(0), ...u16(segs * 2), 0, 0, 0, 0, 0, 0,
      ...Array.from({ length: segs }, (_, i) => u16(i === segs - 1 ? 0xffff : 0xfffe)).flat(), 0, 0,
      ...Array.from({ length: segs }, () => u16(0)).flat(),
      ...Array.from({ length: segs }, () => u16(1)).flat(),
      ...Array.from({ length: segs }, () => u16(0)).flat()];
    const cmap = Uint8Array.from([...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...sub]);
    expectLimit(refusal(() => readCmap(cmap)), 'maxContainerItems');
  });

  it('ToUnicode bfrange: refuses one entry past the bound, and admits one at it', () => {
    const cmap = (hi: string) => new TextEncoder().encode(
      `begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <${hi}> <0041> endbfrange endcmap`);
    expect(parseCMap(cmap('03E7'), limits({ maxContainerItems: 1000 })).entries()).toHaveLength(1000);
    expectLimit(refusal(() => parseCMap(cmap('03E8'), limits({ maxContainerItems: 1000 }))), 'maxContainerItems');
  });

  it('ToUnicode bfrange: repeated ranges are counted together, and one running past U+10FFFF stops there', () => {
    const repeated = new TextEncoder().encode(
      'begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange '
      + '1 beginbfrange <0000> <FFFF> <0041> endbfrange '.repeat(20) + 'endcmap');
    expectLimit(refusal(() => parseCMap(repeated)), 'maxContainerItems');
    // Base U+10FFFE: two codes map, the rest have no character. It used to throw
    // RangeError out of the parse.
    const past = new TextEncoder().encode(
      'begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <0010> <DBFFDFFE> endbfrange endcmap');
    expect(parseCMap(past).entries()).toHaveLength(2);
  });
});

describe('the document\'s policy reaches a /ToUnicode', () => {
  it('GetText refuses a /ToUnicode past the DOCUMENT\'s maxContainerItems', async () => {
    const { contentPdf } = await import('./helpers/build-hostile-pdf.js');
    const cmap = 'begincmap 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <00> <FF> <0041> endbfrange endcmap';
    const pdf = contentPdf(['BT /F1 12 Tf 10 10 Td (A) Tj ET'], {
      mediaBox: '[0 0 100 100]',
      resources: '<< /Font << /F1 5 0 R >> >>',
      extraObjects: [
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
        `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
      ],
    });
    expect(() => Document.Open(pdf, { limits: limits({ maxContainerItems: 256 }) }).Pages[0].GetText()).not.toThrow();
    expectLimit(refusal(() => Document.Open(pdf, { limits: limits({ maxContainerItems: 255 }) }).Pages[0].GetText()),
      'maxContainerItems');
  });
});
