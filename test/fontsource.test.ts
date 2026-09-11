import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemFontFolders, indexFolder, peekCmap } from '../src/fontsource.js';
import { buildNamedFont, buildTtc } from './helpers/build-sfnt.js';

describe('systemFontFolders', () => {
  it('names the current platform’s font directories', () => {
    // Asserted by SHAPE, never by contents: a test that checked which folders
    // exist would pass or fail on what the machine happens to have installed,
    // which is the machine-dependence this whole feature is designed to keep
    // out of the default path.
    const dirs = systemFontFolders();
    expect(dirs.length).toBeGreaterThan(0);
    expect(new Set(dirs).size).toBe(dirs.length);      // no duplicates
    for (const d of dirs) expect(typeof d).toBe('string');

    if (process.platform === 'win32') {
      expect(dirs.some((d) => /[\\/]Fonts$/i.test(d))).toBe(true);
    } else if (process.platform === 'darwin') {
      expect(dirs).toContain('/System/Library/Fonts');
      expect(dirs).toContain('/Library/Fonts');
    } else {
      expect(dirs).toContain('/usr/share/fonts');
      expect(dirs.some((d) => d.endsWith('.fonts'))).toBe(true);
    }
  });
});

/** A throwaway folder holding the given files. */
function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-fonts-'));
  for (const [rel, bytes] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, bytes);
  }
  return dir;
}

describe('indexFolder', () => {
  it('finds a font and reports its family', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const faces = indexFolder(dir);
    expect(faces).toHaveLength(1);
    expect(faces[0].names.family).toBe('Alpha Sans');
    expect(faces[0].path).toBe(join(dir, 'a.ttf'));
  });

  it('descends into subdirectories', () => {
    // Linux nests fonts as /usr/share/fonts/truetype/dejavu/..., so a flat
    // readdir finds nothing at all on that platform.
    const dir = folderWith({
      'truetype/vendor/b.ttf': buildNamedFont({ family: 'Beta Sans' }),
    });
    expect(indexFolder(dir).map((f) => f.names.family)).toEqual(['Beta Sans']);
  });

  it('reads a font whose name table sits past a large glyf table', () => {
    // The partial-read scheme's sharp edge: a reader that optimistically
    // grabbed a fixed prefix would find no name here and the font would look
    // simply absent rather than unreadable.
    const dir = folderWith({
      'big.ttf': buildNamedFont({ family: 'Gamma Sans', padGlyf: 200_000 }),
    });
    expect(indexFolder(dir).map((f) => f.names.family)).toEqual(['Gamma Sans']);
  });

  it('skips what it cannot use and keeps going', () => {
    // Each skip is paired with a VALID face in the same folder: a skip test
    // that does not prove the scan continued is worth very little.
    const dir = folderWith({
      'good.ttf': buildNamedFont({ family: 'Delta Sans' }),
      'truncated.ttf': buildNamedFont({ family: 'Nope' }).subarray(0, 40),
      'garbage.otf': new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      'notes.txt': new TextEncoder().encode('not a font'),
    });
    expect(indexFolder(dir).map((f) => f.names.family)).toEqual(['Delta Sans']);
  });

  it('returns an empty list for a folder that does not exist', () => {
    // The normal case for RegisterSystemFonts: no machine has every directory.
    expect(indexFolder(join(tmpdir(), 'pdf4ts-no-such-folder-xyz'))).toEqual([]);
  });

  it('caches by path: a second call does not re-read the folder', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Epsilon Sans' }) });
    const first = indexFolder(dir);
    // A file added after the first scan is deliberately NOT seen -- the cache
    // lives for the process, and stat-polling every file per lookup would cost
    // most of what it saves.
    writeFileSync(join(dir, 'b.ttf'), buildNamedFont({ family: 'Zeta Sans' }));
    const second = indexFolder(dir);
    expect(second).toBe(first);
    expect(second.map((f) => f.names.family)).toEqual(['Epsilon Sans']);
  });
});

describe('indexFolder — collections', () => {
  it('indexes every face of a .ttc as its own record', () => {
    // Until l1my.2 a collection was skipped whole, so a machine whose only
    // copy of a family lived in a .ttc reported it absent. macOS ships most of
    // its system faces this way.
    const dir = folderWith({
      'pair.ttc': buildTtc([
        buildNamedFont({ family: 'Alpha Sans' }),
        buildNamedFont({ family: 'Beta Serif', bold: true }),
      ]),
    });
    const faces = indexFolder(dir);
    expect(faces.map((f) => f.names.family).sort()).toEqual(['Alpha Sans', 'Beta Serif']);
    // Both records name the same FILE and are told apart by their face index.
    expect(new Set(faces.map((f) => f.path)).size).toBe(1);
    expect(faces.map((f) => f.faceIndex).sort()).toEqual([0, 1]);
  });

  it('gives a plain font face index 0', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    expect(indexFolder(dir)[0].faceIndex).toBe(0);
  });

  it('skips a malformed collection without skipping its neighbours', () => {
    const dir = folderWith({
      'good.ttf': buildNamedFont({ family: 'Delta Sans' }),
      'broken.ttc': new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0, 0, 0, 0, 9]),
    });
    expect(indexFolder(dir).map((f) => f.names.family)).toEqual(['Delta Sans']);
  });
});

describe('peekCmap', () => {
  it('reports the code points a face actually covers', () => {
    const dir = folderWith({ 'cjk.ttf': buildNamedFont({
      family: 'Probe CJK', cmap: [[0x41, 1], [0x4e00, 1], [0x4e8c, 1]],
    }) });
    const cov = peekCmap(join(dir, 'cjk.ttf'))!;
    expect(cov.has(0x4e00)).toBe(true);
    expect(cov.has(0x4e8c)).toBe(true);
    expect(cov.has(0x3042)).toBe(false);   // hiragana A, not in this face
  });

  // The reason the walk is extracted rather than copied: a path-only or
  // index-blind read hands back face 0 for every face of a collection.
  it('reads the named face of a collection, not face 0', () => {
    const a = buildNamedFont({ family: 'Coll A', cmap: [[0x41, 1]] });
    const b = buildNamedFont({ family: 'Coll B', cmap: [[0x4e00, 1]] });
    const dir = folderWith({ 'c.ttc': buildTtc([a, b]) });
    expect(peekCmap(join(dir, 'c.ttc'), 0)!.has(0x41)).toBe(true);
    expect(peekCmap(join(dir, 'c.ttc'), 0)!.has(0x4e00)).toBe(false);
    expect(peekCmap(join(dir, 'c.ttc'), 1)!.has(0x4e00)).toBe(true);
  });

  it('returns undefined rather than throwing for a missing or junk file', () => {
    const dir = folderWith({ 'junk.ttf': new Uint8Array([1, 2, 3, 4]) });
    expect(peekCmap(join(dir, 'junk.ttf'))).toBeUndefined();
    expect(peekCmap(join(dir, 'absent.ttf'))).toBeUndefined();
  });

  it('returns undefined for a face index the file does not have', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha' }) });
    expect(peekCmap(join(dir, 'a.ttf'), 3)).toBeUndefined();
  });
});
