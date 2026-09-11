import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { buildNamedFont, buildTtc } from './helpers/build-sfnt.js';
import { buildType0Pdf, fontDictOf } from './helpers/build-text-pdf.js';
import { decodePng } from './helpers/decode-png.js';
import { buildGlyphSource } from '../src/raster.js';

const NO_NAMES = { family: '', subfamily: 'Regular', bold: false, italic: false, weight: 400 };

function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-renderfonts-'));
  for (const [rel, bytes] of Object.entries(files)) writeFileSync(join(dir, rel), bytes);
  return dir;
}

describe('render font sources', () => {
  it('indexes a registered render folder', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Render Alpha' }) });
    const doc = Document.New();
    doc.RegisterRenderFontFolder(dir);
    expect(doc.renderFontFaces().map((f) => f.names.family)).toContain('Render Alpha');
  });

  it('is EMPTY with nothing registered, which is what keeps rendering opt-in', () => {
    expect(Document.New().renderFontFaces()).toEqual([]);
  });

  // The lists are SEPARATE: an authoring folder must not change any render.
  it('does not draw on the authoring folder list', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Authoring Only' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.renderFontFaces()).toEqual([]);
  });

  it('does not let a render folder reach LoadFontByName', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Render Only' }) });
    const doc = Document.New();
    doc.RegisterRenderFontFolder(dir);
    expect(doc.LoadFontByName('Render Only')).toBeUndefined();
  });

  it('re-registering a held path does not move it or grow the list', () => {
    const a = folderWith({ 'a.ttf': buildNamedFont({ family: 'First' }) });
    const b = folderWith({ 'b.ttf': buildNamedFont({ family: 'Second' }) });
    const doc = Document.New();
    doc.RegisterRenderFontFolder(a);
    doc.RegisterRenderFontFolder(b);
    doc.RegisterRenderFontFolder(a);
    expect(doc.renderFontFaces().map((f) => f.names.family)).toEqual(['First', 'Second']);
  });

  it('returns the SAME parsed face for one path and index', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Memo' }) });
    const doc = Document.New();
    doc.RegisterRenderFontFolder(dir);
    const face = doc.renderFontFaces()[0];
    expect(doc.loadRenderFace(face)).toBe(doc.loadRenderFace(face));
  });

  // The memo key is `path#faceIndex`, and pinning it needs TWO faces of ONE
  // file loaded in ONE document -- a path-only key is still populated
  // CORRECTLY by the first call, so a fixture that loads a single face (even
  // from a collection) passes either way. The plan for this work predicted the
  // end-to-end .ttc render case would cover it; measured, that case leaves the
  // mutation green and only this one reddens.
  it('keys the parsed-face memo by path AND index, not path alone', () => {
    const a = buildNamedFont({ family: 'Coll A', cmap: [[0x41, 1]] });
    const b = buildNamedFont({ family: 'Coll B', cmap: [[0x4e00, 1]] });
    const dir = folderWith({ 'c.ttc': buildTtc([a, b]) });
    const doc = Document.New();
    doc.RegisterRenderFontFolder(dir);
    const [r0, r1] = doc.renderFontFaces();

    const f0 = doc.loadRenderFace(r0)!;
    const f1 = doc.loadRenderFace(r1)!;
    expect(f1).not.toBe(f0);
    // Face 0 covers U+0041 and face 1 covers U+4E00. Under a path-only key the
    // second call hands back face 0, so every glyph of the second face is
    // silently drawn from the first.
    expect(f0.cmapLookup(0x41)).toBeDefined();
    expect(f0.cmapLookup(0x4e00)).toBeUndefined();
    expect(f1.cmapLookup(0x4e00)).toBeDefined();
  });

  it('returns undefined for a face it cannot read, rather than throwing', () => {
    const dir = folderWith({ 'junk.ttf': new Uint8Array([1, 2, 3, 4]) });
    const junk = { path: join(dir, 'junk.ttf'), faceIndex: 0, names: NO_NAMES };
    expect(() => Document.New().loadRenderFace(junk)).not.toThrow();
    expect(Document.New().loadRenderFace(junk)).toBeUndefined();
  });
});

/** Ink pixels in a rendered page — `test/type0-substitute.test.ts`'s rule,
 *  repeated rather than exported: nine lines, and a shared one would make two
 *  test files depend on each other's internals. */
function inkCount(bytes: Uint8Array): number {
  const png = decodePng(bytes);
  let n = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r, g, b] = png.at(x, y);
      if (r !== 255 || g !== 255 || b !== 255) n++;
    }
  }
  return n;
}

/** A /ToUnicode CMap mapping one CID range to a run of code points. */
const bfrange = (loCid: number, hiCid: number, loUni: number) =>
  `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n`
  + `1 begincodespacerange <0000> <FFFF> endcodespacerange\n`
  + `1 beginbfrange <${loCid.toString(16).padStart(4, '0')}> `
  + `<${hiCid.toString(16).padStart(4, '0')}> `
  + `<${loUni.toString(16).padStart(4, '0')}> endbfrange\n`
  + `endcmap end end`;

describe('acceptance: a non-embedded CJK font draws real glyphs', () => {
  /** CIDs 0x41..0x44 mean U+4E00..U+4E03; the face below covers exactly those. */
  const cjkPdf = (baseFont?: string) => buildType0Pdf(
    'BT /F1 48 Tf 20 100 Td <0041004200430044> Tj ET',
    bfrange(0x41, 0x44, 0x4e00), { baseFont });
  const CJK: [number, number][] = [[0x4e00, 1], [0x4e01, 1], [0x4e02, 1], [0x4e03, 1]];
  const minchoFace = () => buildNamedFont({
    family: 'MS Mincho', postScriptName: 'MS-Mincho', cmap: CJK,
    unicodeRange: [0, 0x08000000, 0, 0],     // bit 59 (word 1, position 27), CJK Unified Ideographs
  });

  it('renders differently with a render folder than without', () => {
    const dir = folderWith({ 'mincho.ttf': minchoFace() });

    const bare = Document.Open(cjkPdf());
    const withFolder = Document.Open(cjkPdf());
    withFolder.RegisterRenderFontFolder(dir);

    const a = inkCount(bare.Pages[0].ToImage());
    const b = inkCount(withFolder.Pages[0].ToImage());

    // The face's glyph is a FILLED box; the placeholder is a HAIRLINE box, so
    // the resolved render must carry substantially more ink. An assertion that
    // the two merely DIFFER would also pass for two broken renders, and one
    // that ink appears passes on the unfixed build — see lqcs.1.
    expect(b).toBeGreaterThan(a * 2);
  });

  it('renders identically to the bundled path with no folder registered', () => {
    const a = Document.Open(cjkPdf()).Pages[0].ToImage();
    const b = Document.Open(cjkPdf()).Pages[0].ToImage();
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });

  it('leaves ToSvg untouched, which it structurally must', () => {
    const dir = folderWith({ 'mincho.ttf': minchoFace() });
    const bare = Document.Open(cjkPdf());
    const withFolder = Document.Open(cjkPdf());
    withFolder.RegisterRenderFontFolder(dir);
    // SvgSink.glyphRun emits <text> with a CSS family stack and never resolves
    // a glyph program, so no font directory can change one byte of it.
    expect(withFolder.Pages[0].ToSvg()).toBe(bare.Pages[0].ToSvg());
  });

  // This is the case that finally pins loadRenderFace's path#faceIndex key.
  it('draws from the named face of a collection, not face 0', () => {
    const latin = buildNamedFont({ family: 'Coll Latin', cmap: [[0x41, 1]] });
    const dir = folderWith({ 'c.ttc': buildTtc([latin, minchoFace()]) });
    const doc = Document.Open(cjkPdf());
    doc.RegisterRenderFontFolder(dir);
    const src = buildGlyphSource(doc, fontDictOf(doc));
    expect(src.substituteFamily).toBe('MS Mincho');
    expect(src.sfnt!.cmapLookup(0x4e00)).toBeDefined();   // face 1's cmap, not face 0's
  });
});

// ---------------------------------------------------------------------------

describe('AddRenderFont: a face supplied as bytes', () => {
  const CJK: [number, number][] = [[0x4e00, 1], [0x4e01, 1], [0x4e02, 1], [0x4e03, 1]];
  const minchoBytes = () => buildNamedFont({
    family: 'MS Mincho', postScriptName: 'MS-Mincho', cmap: CJK,
    unicodeRange: [0, 0x08000000, 0, 0],
  });
  const cjkPdf = (baseFont?: string) => buildType0Pdf(
    'BT /F1 48 Tf 20 100 Td <0041004200430044> Tj ET',
    bfrange(0x41, 0x44, 0x4e00), { baseFont });

  it('appears among the render faces with no folder registered', () => {
    const doc = Document.New();
    doc.AddRenderFont(minchoBytes());
    expect(doc.renderFontFaces().map((f) => f.names.family)).toEqual(['MS Mincho']);
  });

  it('resolves by /BaseFont name', () => {
    const doc = Document.Open(cjkPdf('MS-Mincho'));
    doc.AddRenderFont(minchoBytes());
    expect(buildGlyphSource(doc, fontDictOf(doc)).substituteFamily).toBe('MS Mincho');
  });

  // This is what proves renderFaceCoverage does NOT fall through to the
  // filesystem: the face has no file, and the only rung that can answer is
  // coverage, which needs its cmap read out of the buffer we hold.
  it('resolves by COVERAGE, with no file anywhere to read', () => {
    const doc = Document.Open(cjkPdf('SomethingNobodyHas'));
    doc.AddRenderFont(minchoBytes());
    expect(buildGlyphSource(doc, fontDictOf(doc)).substituteFamily).toBe('MS Mincho');
  });

  it('draws real glyphs rather than placeholder boxes', () => {
    const bare = inkCount(Document.Open(cjkPdf()).Pages[0].ToImage());
    const withBytes = Document.Open(cjkPdf());
    withBytes.AddRenderFont(minchoBytes());
    const drawn = inkCount(withBytes.Pages[0].ToImage());
    expect(drawn).not.toBe(bare);
    expect(drawn).toBeGreaterThan(bare * 2);
  });

  it('coexists with a registered folder, bytes first', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Folder Face' }) });
    const doc = Document.New();
    doc.RegisterRenderFontFolder(dir);
    doc.AddRenderFont(minchoBytes());
    expect(doc.renderFontFaces().map((f) => f.names.family))
      .toEqual(['MS Mincho', 'Folder Face']);
  });

  it('picks the named face of a collection supplied as bytes', () => {
    const latin = buildNamedFont({ family: 'Coll Latin', cmap: [[0x41, 1]] });
    const doc = Document.New();
    doc.AddRenderFont(buildTtc([latin, minchoBytes()]), { faceIndex: 1 });
    expect(doc.renderFontFaces().map((f) => f.names.family)).toEqual(['MS Mincho']);
  });

  // A caller handing explicit bytes NAMED this font and wants to be told --
  // unlike LoadFontByName, which is a search and answers undefined.
  it('throws on bytes it cannot read', () => {
    expect(() => Document.New().AddRenderFont(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });

  it('parses the face once, sharing it with the loader', () => {
    const doc = Document.New();
    doc.AddRenderFont(minchoBytes());
    const face = doc.renderFontFaces()[0];
    expect(doc.loadRenderFace(face)).toBe(doc.loadRenderFace(face));
    expect(doc.loadRenderFace(face)!.cmapLookup(0x4e00)).toBeDefined();
  });
});
