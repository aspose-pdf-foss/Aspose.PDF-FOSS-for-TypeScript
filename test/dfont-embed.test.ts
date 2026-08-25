import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseSfnt } from '../src/sfnt.js';
import { buildDfont } from './helpers/build-dfont.js';
import { buildNamedFont } from './helpers/build-sfnt.js';

/** A real font inside the suitcase, so the embed path has glyphs to draw and
 *  the extracted face is proved to be a working font rather than merely a
 *  parseable one. */
const LIBERATION = new Uint8Array(readFileSync('fonts/LiberationSans-Regular.ttf'));

describe('parseSfnt — .dfont', () => {
  it('reads a face out of a suitcase', () => {
    const f = parseSfnt(buildDfont({ faces: [LIBERATION] }));
    expect(f.numGlyphs).toBe(parseSfnt(LIBERATION).numGlyphs);
    expect(f.postScriptName).toBe(parseSfnt(LIBERATION).postScriptName);
  });

  it('selects a face with faceIndex, as it does for a collection', () => {
    const d = buildDfont({
      faces: [buildNamedFont({ family: 'Alpha Sans' }), buildNamedFont({ family: 'Beta Sans' })],
    });
    expect(parseSfnt(d, 0).postScriptName).toBe('AlphaSans');
    expect(parseSfnt(d, 1).postScriptName).toBe('BetaSans');
  });

  it('throws for a face that is not there', () => {
    // A .dfont is a CONTAINER, so this behaves as a .ttc does. Contrast a bare
    // sfnt, where faceIndex is meaningless rather than erroneous.
    const d = buildDfont({ faces: [buildNamedFont({ family: 'Solo Sans' })] });
    expect(() => parseSfnt(d, 3)).toThrow(/asked for index 3/);
    expect(() => parseSfnt(LIBERATION, 3)).not.toThrow();
  });
});

describe('Document.AddFontFile — .dfont', () => {
  it('embeds a face from a suitcase and keeps the text extractable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-dfont-'));
    const path = join(dir, 'Suitcase.dfont');
    writeFileSync(path, buildDfont({ faces: [LIBERATION] }));

    const doc = Document.New();
    const font = doc.AddFontFile(path);
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddText('Hamburg', 72, 700, { font, fontSize: 24 });
    const out = doc.Save();

    const reopened = Document.Open(out);
    expect(reopened.Pages[0].GetText()).toContain('Hamburg');
  });
});
