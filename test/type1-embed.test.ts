import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseSfnt } from '../src/sfnt.js';

const REAL_PATH = 'test/fixtures/fonts/NimbusSans-Regular.t1';
const REAL = new Uint8Array(readFileSync(REAL_PATH));

describe('parseSfnt — Type 1', () => {
  it('converts a Type 1 program into a usable font', () => {
    const f = parseSfnt(REAL);
    expect(f.numGlyphs).toBeGreaterThan(100);
    expect(f.unitsPerEm).toBe(1000);
    expect(f.postScriptName).toBe('NimbusSans-Regular');   // NOT 'Embedded'
  });

  it('resolves a code point through the synthesized cmap', () => {
    const f = parseSfnt(REAL);
    const gid = f.cmapLookup(0x41);
    expect(gid).toBeDefined();
    expect(f.advanceWidth(gid!)).toBeGreaterThan(0);
  });

  it('ignores faceIndex rather than rejecting it', () => {
    // A Type 1 holds one face and a caller may not know which kind of file
    // they were handed -- ttc.ts's existing rule for a plain sfnt.
    expect(() => parseSfnt(REAL, 3)).not.toThrow();
  });
});

describe('Document.AddFontFile — Type 1', () => {
  it('embeds a Type 1 as CIDFontType0C and keeps the text extractable', () => {
    const doc = Document.New();
    const font = doc.AddFontFile(REAL_PATH);
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddText('Hamburg', 72, 700, { font, fontSize: 24 });
    const out = doc.Save();

    const text = Buffer.from(out).toString('latin1');
    expect(text).toContain('/CIDFontType0C');
    expect(text).toContain('/FontFile3');
    // The program's own /FontName reaches /BaseFont, behind the subset tag
    // every embedded face carries -- NOT sfntwrite.ts's hardcoded 'Embedded'.
    expect(text).toMatch(/\/BaseFont\s*\/[A-Z]{6}\+NimbusSans-Regular\b/);

    const reopened = Document.Open(out);
    expect(reopened.Pages[0].GetText()).toContain('Hamburg');
  });

  it('accepts the same program wrapped as a PFB', () => {
    // stripPfb runs inside the conversion, so a .pfb and a .pfa of one program
    // must yield the same font. Built by wrapping the real fixture's bytes in
    // a single binary segment.
    const len = REAL.length;
    const pfb = new Uint8Array(6 + len + 2);
    pfb.set([0x80, 0x01, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]);
    pfb.set(REAL, 6);
    pfb.set([0x80, 0x03], 6 + len);

    const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-t1-'));
    const path = join(dir, 'nimbus.pfb');
    writeFileSync(path, pfb);

    const doc = Document.New();
    const font = doc.AddFontFile(path);
    expect(font.sfnt.postScriptName).toBe('NimbusSans-Regular');
    expect(font.sfnt.numGlyphs).toBe(parseSfnt(REAL).numGlyphs);
  });
});
