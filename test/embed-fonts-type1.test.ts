import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { isDict, isStream, name, type PdfDict, type PdfObject } from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { Type1Font } from '../src/type1.js';
import { buildGlyphSource } from '../src/raster.js';
import { winAnsiEncodingNames } from '../src/encoding.js';
import { buildNonEmbeddedFontPdf, type FontSpec } from './helpers/build-nonembedded-font-pdf.js';

const T1_BYTES = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.t1'));
const T1 = new Type1Font(T1_BYTES);
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdf4ts-embed-type1-'));
  writeFileSync(join(dir, 'NimbusSans-Regular.pfa'), T1_BYTES);
});

/** /Widths 32..126 as the Type 1 charstrings state them, under WinAnsi. */
function t1Widths(): number[] {
  const out: number[] = [];
  for (let c = 32; c <= 126; c++) {
    const gid = T1.gidForName(winAnsiEncodingNames[c]!);
    out.push(gid === undefined ? 0 : Math.round(T1.glyphWidth(gid) * 1000 / T1.unitsPerEm));
  }
  return out;
}
const spec = (o: Partial<FontSpec> = {}): FontSpec => ({
  baseFont: 'NimbusSans-Regular', encoding: name('WinAnsiEncoding'), widths: t1Widths(), text: 'Hello World', ...o,
});
function open(fonts: FontSpec[]): Document {
  const doc = Document.Open(buildNonEmbeddedFontPdf(fonts));
  doc.RegisterFontFolder(dir);
  return doc;
}
function fontOf(doc: Document): PdfDict {
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
  return doc.resolve(fonts.get('F1')) as PdfDict;
}
function fontFile(doc: Document): { dict: PdfDict; bytes: Uint8Array } {
  const fd = doc.resolve(fontOf(doc).get('FontDescriptor')) as PdfDict;
  const ff = doc.resolve(fd.get('FontFile'));
  if (!isStream(ff)) throw new Error('no /FontFile');
  return { dict: ff.dict, bytes: decodeStream(ff) };
}

/** The fixture's three sections: clear text through `eexec` and its line
 *  end, the binary eexec section, and the zeros-and-cleartomark trailer. */
function sections(b: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  const t = new TextDecoder('latin1').decode(b);
  const clear = t.indexOf('eexec') + 6;
  let trailer = t.lastIndexOf('cleartomark');
  while (trailer > clear && /[0\r\n]/.test(t[trailer - 1])) trailer--;
  return [b.subarray(0, clear), b.subarray(clear, trailer), b.subarray(trailer)];
}
/** The fixture re-framed as PFB segments (0x80, type, u32le length). */
function toPfb(b: Uint8Array): Uint8Array {
  const seg = (type: number, data: Uint8Array): Uint8Array => {
    const h = new Uint8Array(6);
    h[0] = 0x80; h[1] = type;
    new DataView(h.buffer).setUint32(2, data.length, true);
    return Buffer.concat([h, data]);
  };
  const [c, e, z] = sections(b);
  return Buffer.concat([seg(1, c), seg(2, e), seg(1, z), Uint8Array.of(0x80, 3)]);
}
/** The fixture as a PFA whose eexec section is written in hex. */
function toHexPfa(b: Uint8Array): Uint8Array {
  const [c, e, z] = sections(b);
  const hex = Buffer.from(e).toString('hex').replace(/(.{64})/g, '$1\n');
  return Buffer.concat([c, Buffer.from(hex + '\n', 'latin1'), z]);
}

describe('EmbedFonts: a registered Type 1 face (g0ky.7)', () => {
  for (const [label, file, bytes] of [['.pfb', 'NimbusSans-Regular.pfb', () => toPfb(T1_BYTES)], ['hex-eexec .pfa', 'NimbusSans-Regular.pfa', () => toHexPfa(T1_BYTES)]] as const) {
    it(`embeds a real ${label} face, whole and subset, with binary eexec`, () => {
      const d = mkdtempSync(join(tmpdir(), 'pdf4ts-embed-type1-fmt-'));
      const input = bytes();
      // The input really is the format named: PFB framing, or hex after eexec.
      if (label === '.pfb') expect(input[0]).toBe(0x80);
      else expect(sections(input)[1][0]).toBeLessThan(0x80);
      writeFileSync(join(d, file), input);
      for (const subset of [false, true]) {
        const doc = Document.Open(buildNonEmbeddedFontPdf([spec()]));
        doc.RegisterFontFolder(d);
        const r = doc.EmbedFonts({ subset });
        expect(r.skipped).toEqual([]);
        const saved = Document.Open(doc.Save());
        expect(saved.Pages[0].GetText()).toBe('Hello World');
        const { dict, bytes: prog } = fontFile(saved);
        const [l1, l2, l3] = ['Length1', 'Length2', 'Length3'].map((k) => dict.get(k) as number);
        expect(l1 + l2 + l3).toBe(prog.length);
        expect(prog[0]).not.toBe(0x80);
        expect(new Type1Font(prog).numGlyphs).toBe(T1.numGlyphs);
      }
    });
  }

  it('embeds the original program as /FontFile with its three lengths', () => {
    const doc = open([spec()]);
    const r = doc.EmbedFonts({ subset: false });
    expect(r.skipped).toEqual([]);
    expect(r.embedded).toMatchObject([{ name: 'NimbusSans-Regular', source: 'registered', postScriptName: 'NimbusSans-Regular' }]);
    const saved = Document.Open(doc.Save());
    expect(saved.Fonts[0]).toMatchObject({ embedded: true, program: 'Type1', subtype: 'Type1' });
    expect(saved.Pages[0].GetText()).toBe('Hello World');
    const { dict, bytes } = fontFile(saved);
    const [l1, l2, l3] = ['Length1', 'Length2', 'Length3'].map((k) => dict.get(k) as number);
    expect(l1 + l2 + l3).toBe(bytes.length);
    expect(new TextDecoder('latin1').decode(bytes.subarray(l1 - 6, l1))).toContain('eexec');
    const reparsed = new Type1Font(bytes);
    expect(reparsed.numGlyphs).toBe(T1.numGlyphs);
  });

  it('subsets by erasing the glyphs not shown, keeping every name', () => {
    const whole = open([spec()]);
    whole.EmbedFonts({ subset: false });
    const sub = open([spec()]);
    sub.EmbedFonts();
    const a = fontFile(Document.Open(whole.Save())).bytes;
    const b = fontFile(Document.Open(sub.Save())).bytes;
    expect(b.length).toBeLessThan(a.length);
    const kept = new Type1Font(b);
    expect(kept.numGlyphs).toBe(T1.numGlyphs);
    expect(kept.glyphWidth(kept.gidForName('H')!)).toBe(T1.glyphWidth(T1.gidForName('H')!));
    expect(kept.glyphWidth(kept.gidForName('Z')!)).toBe(0);
  });

  it('renders through the embedded Type 1 program', () => {
    const doc = open([spec()]);
    doc.EmbedFonts();
    const saved = Document.Open(doc.Save());
    const src = buildGlyphSource(saved, fontOf(saved));
    expect(src.type1).toBeDefined();
    expect(src.substituted).toBe(false);
  });

  it('declines when /Widths disagree with the program', () => {
    const doc = open([spec({ widths: t1Widths().map((w) => w + 50) })]);
    const r = doc.EmbedFonts();
    expect(r.embedded).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['width-mismatch']);
    expect(fontOf(doc).has('FontDescriptor')).toBe(false);
  });

  it('declines a shown code whose glyph name the program lacks', () => {
    const enc = new Map<string, PdfObject>([['Type', name('Encoding')], ['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [72, name('nosuchglyph')]]]);
    const r = open([spec({ encoding: enc })]).EmbedFonts();
    expect(r.skipped.map((s) => [s.reason, s.detail])).toEqual([['usage', 'code 72 names /nosuchglyph, which the Type1 program does not define']]);
  });

  it('writes a descriptor from the Type 1 header for a font that has none', () => {
    const doc = open([spec()]);
    doc.EmbedFonts();
    const fd = doc.resolve(fontOf(doc).get('FontDescriptor'));
    expect(isDict(fd)).toBe(true);
    const d = fd as PdfDict;
    expect((d.get('FontName') as { name: string }).name).toBe('NimbusSans-Regular');
    expect(Array.isArray(d.get('FontBBox'))).toBe(true);
    expect(d.get('Flags')).toBe(32);
  });
});
