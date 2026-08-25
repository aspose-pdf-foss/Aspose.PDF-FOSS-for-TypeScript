/**
 * Finding font files on disk, and reading just enough of each to know what
 * family it is.
 *
 * The only module in this feature that touches the filesystem. Its shape is
 * driven by cost: a system font directory holds thousands of faces and a CJK
 * font runs to tens of megabytes, so an index that read whole files would turn
 * one lookup into hundreds of megabytes of I/O.
 */
import { openSync, readSync, closeSync, readdirSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseTableDirectory, namesFromTables, type FontNames } from './fontnames.js';
import { ttcFaceOffsets } from './ttc.js';
import { isType1, readType1Header } from './type1header.js';
import { dfontSfntRanges } from './dfont.js';

/** A face found on disk. */
export interface FaceRecord {
  /** Path of the file this face was read from. */
  path: string;
  /** Which face of that file: always 0 for a plain font, 0..n-1 for a
   *  collection, whose faces all share one path. */
  faceIndex: number;
  names: FontNames;
}

/**
 * The platform's font directories, in search order.
 *
 * Returned whether or not they exist -- no machine has every directory named
 * here, and `indexFolder` skips what is absent rather than treating it as an
 * error.
 */
export function systemFontFolders(): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    const win = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';
    const local = process.env.LOCALAPPDATA;
    const dirs = [join(win, 'Fonts')];
    if (local) dirs.push(join(local, 'Microsoft', 'Windows', 'Fonts'));
    return dirs;
  }
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library', 'Fonts')];
  }
  return [
    '/usr/share/fonts', '/usr/local/share/fonts',
    join(home, '.local', 'share', 'fonts'), join(home, '.fonts'),
  ];
}

/** Extensions worth opening. A cheap filter, not a trusted claim -- the magic
 *  is checked afterwards. `.pfb`/`.pfa` are Type 1 and `.dfont` is a Macintosh
 *  resource-fork suitcase; both are different containers entirely, and
 *  `peekNames` branches on what it finds. */
const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.otc', '.pfb', '.pfa', '.dfont']);

/**
 * Recursion bound for the folder walk.
 *
 * Real layouts nest three or four deep; 8 is far past any of them. Note what
 * actually prevents a symlinked cycle is that the walk does NOT follow
 * symlinks -- `Dirent.isDirectory()` is false for one -- and this bound is
 * defence behind that, for directories nobody in this project controls.
 */
const MAX_DEPTH = 8;

/** Read exactly `length` bytes at `offset`, or as many as the file holds. */
function readAt(fd: number, offset: number, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, offset + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/**
 * The naming fields of every face in the file at `path`, read through PARTIAL
 * file reads.
 *
 * Per face: twelve bytes of header, then the table directory, then only the
 * ranges the `name`, `head` and `OS/2` tables occupy -- a few kilobytes rather
 * than the whole file. A plain font yields one entry, a collection one per
 * face; an unreadable or unrecognised file yields none. This never throws,
 * because one corrupt file in a system font directory must not break every
 * lookup on the machine.
 */
function peekNames(path: string): { faceIndex: number; names: FontNames }[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');

    // A Type 1's cleartext header lives at the very start of the file, ahead of
    // the eexec section, so indexing one reads a PREFIX and touches no glyph
    // data -- the same partial-read property the sfnt path has. 8 KB is far
    // past any real header.
    const head = readAt(fd, 0, 8192);
    if (isType1(head)) {
      const h = readType1Header(head);
      if (h.familyName === undefined) return [];
      return [{
        faceIndex: 0,
        names: {
          family: h.familyName,
          // /Weight is the word fontmatch.ts's weightFromSubfamily already
          // parses, and `weight` stays at 400 so deriveStyle's corroboration --
          // which fires exactly at 400 -- turns 'Bold' into 700. head.macStyle
          // has no counterpart here, so `bold` stays false and the /Weight
          // string is the positive evidence, which is how fontmatch.ts OR-s.
          subfamily: h.weight ?? 'Regular',
          typographicFamily: undefined,
          typographicSubfamily: undefined,
          postScriptName: h.fontName,
          bold: false,
          italic: h.italicAngle !== 0,
          weight: 400,
        },
      }];
    }

    /**
     * The naming fields of the face whose directory begins at `dirOffset`.
     *
     * `base` is added to each table offset. It is 0 for a bare sfnt and for a
     * collection, whose table offsets are absolute into the FILE — and it is
     * the resource's own start for a `.dfont`, whose are relative to it.
     */
    const faceAt = (dirOffset: number, base = 0): FontNames | undefined => {
      const head12 = readAt(fd!, dirOffset, 12);
      if (head12.length < 12) return undefined;
      const numTables = (head12[4] << 8) | head12[5];
      if (numTables === 0 || numTables > 512) return undefined;
      const dir = parseTableDirectory(readAt(fd!, dirOffset, 12 + numTables * 16));
      if (!dir) return undefined;
      const table = (tag: string): Uint8Array | undefined => {
        const r = dir.get(tag);
        if (!r || r.length === 0 || r.length > 4 * 1024 * 1024) return undefined;
        // A collection's table offsets are absolute into the FILE, so with
        // `base` 0 this is the same read whether the face stands alone or
        // shares a container. A `.dfont`'s are relative to its resource, which
        // is the one caller that passes a non-zero base.
        const b = readAt(fd!, base + r.offset, r.length);
        return b.length === r.length ? b : undefined;
      };
      return namesFromTables({ name: table('name'), head: table('head'), os2: table('OS/2') });
    };

    // A collection is indexed face by face, IN PLACE: reading names needs no
    // extraction, so the partial-read cost model survives one level deeper.
    // `extractTtcFace` runs only when a face is actually loaded.
    const offsets = ttcFaceOffsets(readAt(fd, 0, 4096));
    if (offsets) {
      const out: { faceIndex: number; names: FontNames }[] = [];
      for (let i = 0; i < offsets.length; i++) {
        const names = faceAt(offsets[i]);
        if (names) out.push({ faceIndex: i, names });
      }
      return out;
    }

    // A .dfont carries no signature, so the walk that finds its faces IS the
    // test that this is one -- it therefore runs after the ttcf test, which is
    // a u32 compare. The cost model survives one more format: the 16-byte
    // header, then the map, then only each face's name/head/OS2 ranges.
    const dfont = dfontSfntRanges((o, l) => readAt(fd!, o, l), fstatSync(fd).size);
    if (dfont) {
      const out: { faceIndex: number; names: FontNames }[] = [];
      for (let i = 0; i < dfont.length; i++) {
        // A resource's table offsets are relative to the resource, not the file.
        const names = faceAt(dfont[i].offset, dfont[i].offset);
        if (names) out.push({ faceIndex: i, names });
      }
      return out;
    }

    const names = faceAt(0);
    return names ? [{ faceIndex: 0, names }] : [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * Every candidate file under `dir`, depth-bounded, not following symlinks.
 *
 * Three cases, and the middle one is why this changed in `l1my.4`: a known font
 * extension is opened as it always was; a file with NO extension at all is
 * opened too, because a font checked into a repo or unpacked from an archive
 * routinely loses one and `peekNames` already judges by magic; anything else is
 * opened only under `sniff`.
 *
 * Note a DOTFILE is not extensionless — `.DS_Store` has its dot at index 0, so
 * it falls to the extension test and is skipped by default, which is the answer
 * we want.
 */
function* walk(dir: string, depth: number, sniff: boolean): Generator<string> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { yield* walk(full, depth + 1, sniff); continue; }
    if (!e.isFile()) continue;
    const dot = e.name.lastIndexOf('.');
    if (dot < 0) { yield full; continue; }
    if (FONT_EXT.has(e.name.slice(dot).toLowerCase())) { yield full; continue; }
    if (sniff) yield full;
  }
}

/** Indexed folders, keyed by the path as given AND by whether the scan sniffed.
 *  Process-wide by design: a second Document pays nothing for a folder the
 *  first one scanned.
 *
 *  The flag is part of the key because two documents may want one folder
 *  scanned both ways, and a path-only key would hand the narrow index to the
 *  sniffing caller — or the wide one to a caller who declined the cost. That
 *  costs a second scan of a folder somebody wanted both ways, which is rare. */
const cache = new Map<string, FaceRecord[]>();

/**
 * Every face found under `dir`, recursively.
 *
 * Cached for the process lifetime, so a font file ADDED to the folder later is
 * not seen -- documented rather than engineered around, since stat-polling
 * every file on every lookup would cost most of what the cache saves.
 * Never throws: a missing folder yields an empty list.
 *
 * A face stating no family (name ID 1) is skipped: it cannot be matched by
 * name, which is the only thing this index exists for.
 */
export function indexFolder(dir: string, sniff = false): FaceRecord[] {
  const key = `${sniff ? 'S' : 'N'}:${dir}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out: FaceRecord[] = [];
  for (const path of walk(dir, 0, sniff)) {
    for (const { faceIndex, names } of peekNames(path)) {
      if (names.family !== '') out.push({ path, faceIndex, names });
    }
  }
  cache.set(key, out);
  return out;
}
