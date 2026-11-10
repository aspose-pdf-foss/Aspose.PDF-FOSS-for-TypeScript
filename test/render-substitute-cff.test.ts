import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { name } from '../src/types.js';
import { parseSfnt } from '../src/sfnt.js';
import { CffFont } from '../src/cff.js';
import { buildNonEmbeddedFontPdf, type FontSpec } from './helpers/build-nonembedded-font-pdf.js';

// u5es: a non-embedded font rendered through an INSTALLED OpenType-CFF face
// drew nothing at all -- a page byte-identical to a blank one -- because the
// face's outlines live in its CFF table and the substitute path never read it.

const OTF = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.otf'));
const NIMBUS = parseSfnt(OTF);
const NIMBUS_CFF = new CffFont(NIMBUS.table('CFF ')!);

function cffWidths(): number[] {
  const uni = NIMBUS.cmapSubtable(3, 1)!;
  const out: number[] = [];
  for (let c = 32; c <= 126; c++)
    out.push(Math.round((NIMBUS_CFF.glyphWidth(uni.get(c) ?? 0) ?? 0) * 1000 / NIMBUS_CFF.unitsPerEm));
  return out;
}
const spec = (o: Partial<FontSpec> = {}): FontSpec => ({
  baseFont: 'NimbusSans-Regular', encoding: name('WinAnsiEncoding'), widths: cffWidths(), text: 'Hello World', ...o,
});

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdf4ts-render-cff-'));
  writeFileSync(join(dir, 'NimbusSans-Regular.otf'), OTF);
});

describe('render substitution through an installed OpenType-CFF face', () => {
  it('draws the text, exactly as the same face embedded draws it', () => {
    const blank = Document.Open(buildNonEmbeddedFontPdf([spec({ text: '' })])).Pages[0].ToImage();

    const doc = Document.Open(buildNonEmbeddedFontPdf([spec()]));
    doc.RegisterRenderFontFolder(dir);
    const substituted = doc.Pages[0].ToImage();
    expect(Buffer.compare(substituted, blank)).not.toBe(0);

    // The oracle: the same face EMBEDDED (EmbedFonts' CFF route, g0ky.4),
    // which draws by charset name through a path that already worked.
    const emb = Document.Open(buildNonEmbeddedFontPdf([spec()]));
    emb.RegisterFontFolder(dir);
    expect(emb.EmbedFonts().skipped).toEqual([]);
    const embedded = Document.Open(emb.Save()).Pages[0].ToImage();
    expect(Buffer.compare(substituted, embedded)).toBe(0);
  });

  it('draws text from a non-embedded composite font through the face', () => {
    const t0 = (text: string): FontSpec => ({
      baseFont: 'NimbusSans-Regular', subtype: 'Type0', text,
      toUnicode: '1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
        + '1 beginbfrange <0020> <007E> <0020> endbfrange',
    });
    const blank = Document.Open(buildNonEmbeddedFontPdf([t0('')])).Pages[0].ToImage();
    const doc = Document.Open(buildNonEmbeddedFontPdf([t0('Hello')]));
    doc.RegisterRenderFontFolder(dir);
    expect(Buffer.compare(doc.Pages[0].ToImage(), blank)).not.toBe(0);
  });
});
