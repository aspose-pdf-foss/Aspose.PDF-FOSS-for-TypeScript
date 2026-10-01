import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { indexFolder } from '../src/fontsource.js';
import { parseSfnt } from '../src/sfnt.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { asCff2, buildNamedFont } from './helpers/build-sfnt.js';

// dmin.6: dmin.3 declined CFF2, and dmin.5 made SfntFont refuse it by name. A
// CFF2 face still read perfectly well through the partial `name`/`head`/`OS/2`
// read, so it was INDEXED — and when style matching chose it, the load failed
// and the lookup answered `undefined` with a usable sibling sitting beside it.

function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-cff2-'));
  for (const [rel, bytes] of Object.entries(files)) writeFileSync(join(dir, rel), bytes);
  return dir;
}

describe('a CFF2-outlined face is kept out of the font index', () => {
  it('the fixture is what it claims: names readable, outlines refused as CFF2', () => {
    const f = asCff2(buildNamedFont({ family: 'Gamma Sans' }));
    expect(() => parseSfnt(f)).toThrow(UnsupportedFeatureError);
  });

  it('is absent from indexFolder while its usable sibling is present', () => {
    const dir = folderWith({
      'var.otf': asCff2(buildNamedFont({ family: 'Gamma Sans' })),
      'bold.ttf': buildNamedFont({ family: 'Gamma Sans', subfamily: 'Bold', bold: true, weight: 700 }),
    });
    const faces = indexFolder(dir);
    expect(faces.map((f) => f.path.endsWith('var.otf'))).toEqual([false]);
    expect(faces).toHaveLength(1);
  });

  it('LoadFontByName resolves to the usable face rather than to nothing', () => {
    // The CFF2 face is the REGULAR one, so it is exactly what style matching
    // prefers for a plain request: before, that choice failed to parse and the
    // lookup returned undefined.
    const dir = folderWith({
      'var.otf': asCff2(buildNamedFont({ family: 'Gamma Sans' })),
      'bold.ttf': buildNamedFont({ family: 'Gamma Sans', subfamily: 'Bold', bold: true, weight: 700 }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const font = doc.LoadFontByName('Gamma Sans');
    expect(font).toBeDefined();
    expect(font!.sfnt.outlines).toBe('glyf');
  });

  it('is absent from the render substitute index too', () => {
    const dir = folderWith({
      'var.otf': asCff2(buildNamedFont({ family: 'Gamma Serif' })),
      'plain.ttf': buildNamedFont({ family: 'Delta Serif' }),
    });
    const doc = Document.New();
    doc.RegisterRenderFontFolder(dir);
    expect(doc.renderFontFaces().map((f) => f.names.family)).toEqual(['Delta Serif']);
  });

  it('keeps a font carrying CFF2 BESIDE a readable outline table', () => {
    // Only a face with nothing we can draw is excluded. A glyf face that also
    // carries a CFF2 table still loads through glyf.
    // Re-tag an unused table (post) as CFF2, leaving glyf in place.
    const out = buildNamedFont({ family: 'Epsilon Sans' });
    const v = new DataView(out.buffer);
    for (let i = 0; i < v.getUint16(4); i++) {
      const rec = 12 + i * 16;
      if (String.fromCharCode(...out.subarray(rec, rec + 4)) === 'post') out.set([0x43, 0x46, 0x46, 0x32], rec);
    }
    const dir = folderWith({ 'both.ttf': out });
    expect(indexFolder(dir).map((f) => f.names.family)).toEqual(['Epsilon Sans']);
  });

  it('keeps a font carrying CFF2 BESIDE a CFF table', () => {
    // The other readable outline table: an OpenType-CFF face that also ships
    // CFF2 draws through 'CFF '. Indexing reads names only, so re-tagging
    // glyf -> 'CFF ' and post -> CFF2 is enough to state that directory.
    const out = buildNamedFont({ family: 'Zeta Sans' });
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < v.getUint16(4); i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(...out.subarray(rec, rec + 4));
      if (tag === 'glyf') out.set([0x43, 0x46, 0x46, 0x20], rec);
      if (tag === 'post') out.set([0x43, 0x46, 0x46, 0x32], rec);
    }
    expect(indexFolder(folderWith({ 'z.otf': out })).map((f) => f.names.family)).toEqual(['Zeta Sans']);
  });
});
