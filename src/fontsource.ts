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
import { readCmap } from './sfnt.js';
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

    return eachFace(fd, (table) =>
      namesFromTables({ name: table('name'), head: table('head'), os2: table('OS/2') }))
      .map(({ faceIndex, value }) => ({ faceIndex, names: value }));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * Walk one open file's faces, handing each a `table(tag)` reader over ITS OWN
 * directory, and keep whatever `pick` returns.
 *
 * **Invariant: ONE owner for "where does face N begin".** `peekNames` and
 * `peekCmap` must not disagree about it -- a second walk is how an index and a
 * coverage confirm come to describe different faces of one `.ttc`.
 *
 * Note the Type 1 case is NOT here: it is `peekNames`'s alone, because a Type 1
 * has no table directory at all and no `cmap` for `peekCmap` to want.
 */
function eachFace<T>(
  fd: number,
  pick: (table: (tag: string) => Uint8Array | undefined, faceIndex: number) => T | undefined,
): { faceIndex: number; value: T }[] {
  const faceAt = (dirOffset: number, base: number, faceIndex: number): T | undefined => {
    const head12 = readAt(fd, dirOffset, 12);
    if (head12.length < 12) return undefined;
    const numTables = (head12[4] << 8) | head12[5];
    if (numTables === 0 || numTables > 512) return undefined;
    const dir = parseTableDirectory(readAt(fd, dirOffset, 12 + numTables * 16));
    if (!dir) return undefined;
    const table = (tag: string): Uint8Array | undefined => {
      const r = dir.get(tag);
      if (!r || r.length === 0 || r.length > 4 * 1024 * 1024) return undefined;
      // A collection's table offsets are absolute into the FILE, so with
      // `base` 0 this is the same read whether the face stands alone or
      // shares a container. A `.dfont`'s are relative to its resource, which
      // is the one caller that passes a non-zero base.
      const b = readAt(fd, base + r.offset, r.length);
      return b.length === r.length ? b : undefined;
    };
    return pick(table, faceIndex);
  };

  const out: { faceIndex: number; value: T }[] = [];
  const push = (i: number, v: T | undefined): void => { if (v !== undefined) out.push({ faceIndex: i, value: v }); };

  // A collection is indexed face by face, IN PLACE: reading names needs no
  // extraction, so the partial-read cost model survives one level deeper.
  // `extractTtcFace` runs only when a face is actually loaded.
  const offsets = ttcFaceOffsets(readAt(fd, 0, 4096));
  if (offsets) {
    for (let i = 0; i < offsets.length; i++) push(i, faceAt(offsets[i], 0, i));
    return out;
  }

  // A .dfont carries no signature, so the walk that finds its faces IS the
  // test that this is one -- it therefore runs after the ttcf test, which is
  // a u32 compare. The cost model survives one more format: the 16-byte
  // header, then the map, then only each face's own table ranges.
  const dfont = dfontSfntRanges((o, l) => readAt(fd, o, l), fstatSync(fd).size);
  if (dfont) {
    // A resource's table offsets are relative to the resource, not the file.
    for (let i = 0; i < dfont.length; i++) push(i, faceAt(dfont[i].offset, dfont[i].offset, i));
    return out;
  }

  push(0, faceAt(0, 0, 0));
  return out;
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

/**
 * The Unicode code points one face's `cmap` covers.
 *
 * A SECOND partial read: the table directory, then the `cmap` range, and
 * nothing else -- so confirming a candidate costs roughly what indexing it did
 * rather than reading a 20 MB CJK font. `undefined` for a file that will not
 * open, a face index the file does not have, or a face carrying no `cmap`.
 *
 * It exists because `OS/2.ulUnicodeRange` is the PRODUCER'S CLAIM about its
 * own font and is routinely optimistic: that field selects candidates, and
 * this decides between them. Never throws.
 *
 * **Note a Type 1 face has no `cmap` and so answers `undefined`.** That is
 * correct rather than a gap: such a face can still win on NAME, and a coverage
 * score for a format that states no Unicode mapping would be invented. The
 * consequence is real and deliberate -- a `.pfb` in a render folder is
 * reachable by name and never by coverage.
 */
export function peekCmap(path: string, faceIndex = 0): Set<number> | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const hit = eachFace(fd, (table, i) => (i === faceIndex ? table('cmap') : undefined))[0];
    if (!hit) return undefined;
    // The gids are the FACE's and mean nothing to the caller, which resolves a
    // code point through its own parsed SfntFont at draw time. Coverage alone
    // is the honest contract.
    return new Set(readCmap(hit.value).keys());
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}
