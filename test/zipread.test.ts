import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openZip } from '../src/zipread.js';
import { writeZip } from '../src/zip.js';
import { PdfParseError, UnsupportedFeatureError } from '../src/errors.js';
import { enc, dec, layout, put16, put32 } from './helpers/zip-bytes.js';

describe('openZip reads what writeZip writes', () => {
  const zip = writeZip([
    { path: 'a.txt', bytes: enc('alpha '.repeat(100)) },
    { path: 'raw.bin', bytes: new Uint8Array([0, 1, 2, 255]), method: 'store' },
    { path: 'empty.txt', bytes: new Uint8Array(0) },
    { path: 'dir/', bytes: new Uint8Array(0), method: 'store' },
    { path: 'dir/café.txt', bytes: enc('ünïcode') },
  ]);

  it('lists every entry in central-directory order', () => {
    const z = openZip(zip);
    expect(z.entries.map((e) => e.path))
      .toEqual(['a.txt', 'raw.bin', 'empty.txt', 'dir/', 'dir/café.txt']);
    expect(z.entries[0]).toMatchObject({ method: 8, size: 600, encrypted: false });
    expect(z.entries[1]).toMatchObject({ method: 0, size: 4, compressedSize: 4 });
  });

  it('reads deflated, stored, empty and UTF-8-named entries back', () => {
    const z = openZip(zip);
    expect(dec(z.read('a.txt'))).toBe('alpha '.repeat(100));
    expect(Array.from(z.read('raw.bin'))).toEqual([0, 1, 2, 255]);
    expect(z.read('empty.txt').length).toBe(0);
    expect(dec(z.read('dir/café.txt'))).toBe('ünïcode');
  });

  it('reads a directory entry as empty bytes', () => {
    expect(openZip(zip).read('dir/').length).toBe(0);
  });

  it('answers has() and refuses an unknown path as a caller error', () => {
    const z = openZip(zip);
    expect(z.has('a.txt')).toBe(true);
    expect(z.has('nope')).toBe(false);
    expect(() => z.read('nope')).toThrow(RangeError);
  });

  it('opens an archive holding no entries at all', () => {
    expect(openZip(writeZip([])).entries).toEqual([]);
  });
});

describe('entry names', () => {
  it('decodes a name without bit 11 as CP437', () => {
    const zip = writeZip([{ path: 'x.txt', bytes: enc('1') }]);
    const { central, local } = layout(zip);
    // 0x82 is é and 0xE1 is ß in CP437 (APPNOTE Appendix D); patch both headers,
    // since the local name must equal the central one byte for byte.
    for (const at of [central[0] + 46, local[0] + 30]) zip[at] = 0x82;
    const z = openZip(zip);
    expect(z.entries[0].path).toBe('é.txt');
    expect(dec(z.read('é.txt'))).toBe('1');
    zip[central[0] + 46] = 0xe1; zip[local[0] + 30] = 0xe1;
    expect(openZip(zip).entries[0].path).toBe('ß.txt');
  });

  it('maps all 128 high CP437 bytes to 128 distinct single characters', () => {
    const zip = writeZip([{ path: 'x', bytes: enc('1') }]);
    const { central, local } = layout(zip);
    const seen = new Set<string>();
    for (let b = 0x80; b <= 0xff; b++) {
      zip[central[0] + 46] = b; zip[local[0] + 30] = b;
      const name = openZip(zip).entries[0].path;
      expect(name.length).toBe(1);
      seen.add(name);
    }
    expect(seen.size).toBe(128);
  });

  it('returns traversal, absolute and drive-letter names verbatim', () => {
    const paths = ['../../evil.txt', '/etc/passwd', 'C:\\x.txt'];
    // writeZip refuses these, so write safe names of the same length and patch.
    const zip = writeZip(paths.map((p, i) => ({ path: `n${i}`.padEnd(p.length, '_'), bytes: enc(p) })));
    const { central, local } = layout(zip);
    paths.forEach((p, i) => {
      const bytes = enc(p);
      zip.set(bytes, central[i] + 46);
      zip.set(bytes, local[i] + 30);
    });
    const z = openZip(zip);
    expect(z.entries.map((e) => e.path)).toEqual(paths);
    paths.forEach((p) => expect(dec(z.read(p))).toBe(p));
  });

  it('touches no filesystem: the module imports no fs', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'zipread.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"](node:)?fs(\/promises)?['"]/);
  });
});

const two = (): Uint8Array => writeZip([
  { path: 'a.txt', bytes: enc('alpha') },
  { path: 'b.txt', bytes: enc('bravo') },
]);

/** Append an archive comment and fix the end record to own it. */
function withComment(zip: Uint8Array, comment: Uint8Array): Uint8Array {
  const out = new Uint8Array(zip.length + comment.length);
  out.set(zip); out.set(comment, zip.length);
  put16(out, zip.length - 22 + 20, comment.length);
  return out;
}

describe('an empty deflated entry', () => {
  it('reads method 8 with no data at all as empty, as Python zipfile does', () => {
    const zip = writeZip([{ path: 'e', bytes: new Uint8Array(0), method: 'store' }]);
    const { central, local } = layout(zip);
    put16(zip, central[0] + 10, 8); put16(zip, local[0] + 8, 8);
    expect(openZip(zip).read('e').length).toBe(0);
  });

  it('still refuses method 8 with no data that declares a size', () => {
    const zip = writeZip([{ path: 'e', bytes: new Uint8Array(0), method: 'store' }]);
    const { central, local } = layout(zip);
    put16(zip, central[0] + 10, 8); put16(zip, local[0] + 8, 8);
    put32(zip, central[0] + 24, 5); put32(zip, local[0] + 22, 5);
    expect(() => openZip(zip).read('e')).toThrow(PdfParseError);
  });
});

describe('finding the end record', () => {
  it('refuses a buffer too short to hold one, as damage', () => {
    for (let n = 0; n < 22; n++) expect(() => openZip(new Uint8Array(n))).toThrow(PdfParseError);
  });

  it('names an OLE compound file, which is what an encrypted .docx is', () => {
    const ole = new Uint8Array(600);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => openZip(ole)).toThrow(/OLE compound file/);
  });

  it('prefers the record whose comment ends exactly at the end, over a fake inside the comment', () => {
    const fake = new Uint8Array(22);
    put32(fake, 0, 0x06054b50);
    put16(fake, 8, 1); put16(fake, 10, 1);
    put32(fake, 12, 46); put32(fake, 16, 0xdead);
    put16(fake, 20, 5);                         // its own comment would overrun
    const z = openZip(withComment(two(), fake));
    expect(dec(z.read('b.txt'))).toBe('bravo');
  });

  it('reads past trailing junk the end record does not own', () => {
    const zip = two();
    const junk = new Uint8Array(zip.length + 10);
    junk.set(zip);
    expect(dec(openZip(junk).read('a.txt'))).toBe('alpha');
  });

  it('refuses an archive with a stub prepended, as damage rather than wrong bytes', () => {
    const zip = two();
    const stubbed = new Uint8Array(zip.length + 64);
    stubbed.set(zip, 64);                       // offsets in it now point 64 bytes early
    expect(() => {
      const z = openZip(stubbed);
      z.entries.forEach((e) => z.read(e.path));
    }).toThrow(PdfParseError);
  });
});

describe('what refuses the whole archive', () => {
  it('refuses a ZIP64 locator before the end record', () => {
    const zip = two();
    put32(zip, layout(zip).eocd - 20, 0x07064b50);
    expect(() => openZip(zip)).toThrow(UnsupportedFeatureError);
  });

  it('refuses a 32-bit sentinel for the directory offset or size', () => {
    for (const field of [12, 16]) {
      const zip = two();
      put32(zip, layout(zip).eocd + field, 0xffffffff);
      expect(() => openZip(zip)).toThrow(UnsupportedFeatureError);
    }
  });

  it('refuses a multi-disk archive', () => {
    const zip = two();
    put16(zip, layout(zip).eocd + 4, 1);
    expect(() => openZip(zip)).toThrow(UnsupportedFeatureError);
  });

  it('reads a single-disk end record whose two counts disagree as damage, not as multi-disk', () => {
    const zip = two();
    put16(zip, layout(zip).eocd + 8, 1);          // entries on this disk 1, total 2
    expect(() => openZip(zip)).toThrow(PdfParseError);
  });

  it('reads a declared count that disagrees with the directory as damage', () => {
    for (const n of [1, 3]) {
      const zip = two();
      const { eocd } = layout(zip);
      put16(zip, eocd + 8, n); put16(zip, eocd + 10, n);
      expect(() => openZip(zip)).toThrow(/declares/);
    }
  });

  it('refuses a directory size that runs past the end record', () => {
    const zip = two();
    const { eocd } = layout(zip);
    put32(zip, eocd + 12, zip.length);
    expect(() => openZip(zip)).toThrow(PdfParseError);
  });

  it('refuses a directory record whose name runs past the directory', () => {
    const zip = two();
    const { central } = layout(zip);
    put16(zip, central[1] + 28, 500);
    expect(() => openZip(zip)).toThrow(PdfParseError);
  });

  it('refuses a duplicate name, the shape in which two readers pick different bytes', () => {
    const zip = two();
    const { central, local } = layout(zip);
    zip[central[1] + 46] = 0x61; zip[local[1] + 30] = 0x61;   // b.txt -> a.txt
    expect(() => openZip(zip)).toThrow(/duplicate/);
  });
});

/** Apply `patch` to b.txt, then assert its read throws `err` and a.txt still reads. */
function refusesOnlyB(patch: (zip: Uint8Array, l: ReturnType<typeof layout>) => void,
  err: typeof PdfParseError | typeof UnsupportedFeatureError, msg?: RegExp): void {
  const zip = two();
  patch(zip, layout(zip));
  const z = openZip(zip);
  expect(() => z.read('b.txt')).toThrow(err);
  if (msg) expect(() => z.read('b.txt')).toThrow(msg);
  expect(dec(z.read('a.txt'))).toBe('alpha');
}

describe('what refuses one entry and leaves the rest readable', () => {
  it('an encrypted entry', () =>
    refusesOnlyB((z, l) => put16(z, l.central[1] + 8, 1), UnsupportedFeatureError, /encrypted/));

  it('a compression method other than stored or deflate', () =>
    refusesOnlyB((z, l) => put16(z, l.central[1] + 10, 12), UnsupportedFeatureError, /method 12/));

  it('a per-entry ZIP64 sentinel', () =>
    refusesOnlyB((z, l) => put32(z, l.central[1] + 20, 0xffffffff), UnsupportedFeatureError, /ZIP64/));

  it('a missing local header', () =>
    refusesOnlyB((z, l) => put32(z, l.local[1], 0), PdfParseError, /local header/));

  it('a local-header offset past the end of the buffer', () =>
    refusesOnlyB((z, l) => put32(z, l.central[1] + 42, z.length + 100), PdfParseError));

  it('a compressed size running past the end of the archive, named as such', () =>
    // Without its own check a truncated entry still fails — as a size or deflate
    // error, which misdescribes a truncated archive.
    // Both headers lie alike, so the local/central comparison passes it through.
    refusesOnlyB((z, l) => { put32(z, l.central[1] + 20, z.length); put32(z, l.local[1] + 18, z.length); },
      PdfParseError, /runs past the end/));

  it('a local header naming a different file', () =>
    refusesOnlyB((z, l) => { z[l.local[1] + 30] = 0x7a; }, PdfParseError, /different file/));

  it('a CRC-32 that does not match', () =>
    refusesOnlyB((z, l) => { put32(z, l.central[1] + 16, 0x12345678); put32(z, l.local[1] + 14, 0x12345678); },
      PdfParseError, /CRC/));

  it('corrupt deflate data, wrapped as damage rather than a zlib error', () =>
    refusesOnlyB((z, l) => { z[l.local[1] + 30 + 5] = 0xff; }, PdfParseError, /corrupt deflate|CRC|decodes to/));

  it('a stored entry whose declared size disagrees with its bytes', () => {
    const zip = writeZip([
      { path: 'a.txt', bytes: enc('alpha') },
      { path: 'b.txt', bytes: enc('bravo'), method: 'store' },
    ]);
    const l = layout(zip);
    put32(zip, l.central[1] + 24, 6); put32(zip, l.local[1] + 22, 6);
    const z = openZip(zip);
    expect(() => z.read('b.txt')).toThrow(/declares 6/);
    expect(dec(z.read('a.txt'))).toBe('alpha');
  });
});

describe('the central directory is the authority for sizes', () => {
  it('reads a data-descriptor entry whose local header carries zeros', () => {
    const zip = two();
    const { central, local } = layout(zip);
    put16(zip, central[1] + 8, 0x0008); put16(zip, local[1] + 6, 0x0008);
    put32(zip, local[1] + 14, 0); put32(zip, local[1] + 18, 0); put32(zip, local[1] + 22, 0);
    expect(dec(openZip(zip).read('b.txt'))).toBe('bravo');
  });
});

describe('ZIP-confusion shapes found in final review', () => {
  it('refuses a gap between the central directory and the end record', () => {
    // Python's zipfile reads the directory at eocd - cdSize and shifts every
    // offset; we read at the stated offset. With a gap the two disagree.
    const zip = two();
    const { eocd } = layout(zip);
    const gapped = new Uint8Array(zip.length + 16);
    gapped.set(zip.subarray(0, eocd));
    gapped.set(zip.subarray(eocd), eocd + 16);
    expect(() => openZip(gapped)).toThrow(PdfParseError);
  });

  it('keeps a leading BOM in a UTF-8 name, as every other reader does', () => {
    const zip = writeZip([{ path: '\uFEFFword/document.xml', bytes: enc('x') }]);
    expect(openZip(zip).entries[0].path).toBe('\uFEFFword/document.xml');
  });

  it('refuses a local header whose method disagrees with the central record', () => {
    refusesOnlyB((z, l) => put16(z, l.local[1] + 8, 0), PdfParseError, /local header/);
  });

  it('refuses a local header whose sizes or CRC disagree, when no data descriptor excuses it', () => {
    for (const field of [14, 18, 22]) {
      // 0x7777 cannot collide: deflated `bravo` is itself 7 bytes.
      refusesOnlyB((z, l) => put32(z, l.local[1] + field, 0x7777), PdfParseError, /local header/);
    }
  });
});
