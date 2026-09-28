import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { parseSfnt, SfntFont } from '../src/sfnt.js';
import { CffFont } from '../src/cff.js';
import { shrinkCff } from '../src/fontshrink.js';
import { assembleSfnt } from '../src/subset.js';
import { decodeStream } from '../src/filters.js';
import { isDict, isStream, isArray } from '../src/types.js';
import { buildCffOttoPdf, CffOttoOptions } from './helpers/build-optimize-pdf.js';

const OTF = new Uint8Array(readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.otf', import.meta.url)));

/** The same face with its CFF re-assembled CID-keyed (CID = GID) — the shape a
 *  CJK .otf takes. Built through the library's own CID assembler; the render
 *  comparison below is what holds it to account. */
function cidKeyedOtf(): Uint8Array {
  const f = parseSfnt(OTF);
  const all = new Set(Array.from({ length: f.numGlyphs }, (_, g) => g));
  const cff = shrinkCff(f.table('CFF ')!, all).bytes;
  const tables = [...f.tables.keys()].map((tag) => ({ tag, data: tag === 'CFF ' ? cff : f.table(tag)!.slice() }));
  return assembleSfnt(tables, 0x4f54544f);
}

/** The saved document's only /FontFile3, parsed as the sfnt it is. */
function program(pdf: Uint8Array): SfntFont {
  const doc = Document.Open(pdf);
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font'));
  let font = isDict(fonts) ? doc.resolve(fonts.get('F1')) : undefined;
  const desc = isDict(font) ? doc.resolve(font.get('DescendantFonts')) : undefined;
  if (isArray(desc)) font = doc.resolve(desc[0]);
  const fd = isDict(font) ? doc.resolve(font.get('FontDescriptor')) : undefined;
  const ff = isDict(fd) ? doc.resolve(fd.get('FontFile3')) : undefined;
  if (!isStream(ff)) throw new Error('no /FontFile3');
  return parseSfnt(decodeStream(ff));
}

function optimizeAndCompare(o: CffOttoOptions): { pdf: Uint8Array; saved: Uint8Array; report: ReturnType<Document['Optimize']> } {
  const pdf = buildCffOttoPdf(o);
  const before = Document.Open(pdf).Pages[0].ToImage();
  const doc = Document.Open(pdf);
  const report = doc.Optimize();
  const saved = doc.Save();
  expect(Document.Open(saved).Pages[0].ToImage()).toEqual(before);
  return { pdf, saved, report };
}

const hexCid = (f: SfntFont, ch: string): string =>
  f.cmapSubtable(3, 1)!.get(ch.charCodeAt(0))!.toString(16).padStart(4, '0');

describe('Optimize — OpenType-CFF (/FontFile3 /OpenType) whole-embed', () => {
  it('subsets a name-keyed .otf under a simple /TrueType dict and renders identically', () => {
    const { pdf, saved, report } = optimizeAndCompare({ otto: OTF, content: '(AVA)' });
    expect(report.skipped).toEqual([]);
    expect(report.fonts).toHaveLength(1);
    expect(report.fonts[0].gidsKept).toBe(3);                 // .notdef, A, V
    expect(report.fonts[0].bytesSaved).toBeGreaterThan(10_000);
    expect(saved.length).toBeLessThan(pdf.length);
  });

  it('keeps the wrapper valid: same GIDs, cmap, names; used outlines kept, unused blanked', () => {
    const { saved } = optimizeAndCompare({ otto: OTF, content: '(AVA)' });
    const orig = parseSfnt(OTF);
    const out = program(saved);
    expect(out.outlines).toBe('cff');
    // parseSfnt reads outlines off the CFF table, so it cannot see a wrong tag.
    expect(String.fromCharCode(...out.raw.subarray(0, 4))).toBe('OTTO');
    expect(out.numGlyphs).toBe(orig.numGlyphs);
    expect(out.cmapSubtable(3, 1)).toEqual(orig.cmapSubtable(3, 1));
    expect(out.table('hmtx')).toEqual(orig.table('hmtx'));
    const o = new CffFont(orig.table('CFF ')!), n = new CffFont(out.table('CFF ')!);
    expect(n.isCID).toBe(false);
    expect(n.charsetNames()).toEqual(o.charsetNames());
    const A = orig.cmapSubtable(3, 1)!.get(0x41)!, B = orig.cmapSubtable(3, 1)!.get(0x42)!;
    expect(n.glyphPath(A)).toEqual(o.glyphPath(A));
    expect(o.glyphPath(B).length).toBeGreaterThan(0);
    expect(n.glyphPath(B)).toEqual([]);
  });

  it('subsets the same program under a simple /Type1 dict', () => {
    const { report } = optimizeAndCompare({ otto: OTF, subtype: 'Type1', content: '(AVA)' });
    expect(report.skipped).toEqual([]);
    expect(report.fonts[0].gidsKept).toBe(3);
  });

  it('subsets a CID-keyed .otf under a Type0 and keeps it CID-keyed', () => {
    const otto = cidKeyedOtf();
    const f = parseSfnt(otto);
    const { saved, report } = optimizeAndCompare({
      otto, subtype: 'Type0', content: `<${hexCid(f, 'A')}${hexCid(f, 'V')}${hexCid(f, 'A')}>`,
    });
    expect(report.skipped).toEqual([]);
    expect(report.fonts[0].gidsKept).toBe(3);
    const out = program(saved);
    const cff = new CffFont(out.table('CFF ')!);
    expect(cff.isCID).toBe(true);
    const B = f.cmapSubtable(3, 1)!.get(0x42)!;
    expect(cff.glyphPath(B)).toEqual([]);
  });

  it('keeps a tiny program whole when the rewrite would not be smaller', () => {
    const doc = Document.Open(buildCffOttoPdf());
    const report = doc.Optimize();
    expect(report.fonts).toEqual([]);
    expect(report.skipped[0].reason).toBe('shrunk program would not be smaller');
  });
});
