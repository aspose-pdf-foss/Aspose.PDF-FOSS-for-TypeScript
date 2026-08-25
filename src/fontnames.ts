/**
 * An sfnt's naming and style fields, read as cheaply as possible.
 *
 * A pure leaf, imported by `sfnt.ts` (which wants the PostScript name) and by
 * `fontsource.ts` (which wants family names for thousands of files at a time).
 * That second caller is why the module is split three ways: it reads the table
 * directory, then only the byte ranges `name`, `head` and `OS/2` occupy, and
 * never the whole file.
 */

export interface FontNames {
  /** Name ID 1, or '' when the font states none -- see `namesFromTables`. */
  family: string;
  /** Name ID 2 -- 'Regular', 'Bold Italic', ... */
  subfamily: string;
  /** Name ID 16, where the font states one. */
  typographicFamily?: string;
  /** Name ID 17, where the font states one. */
  typographicSubfamily?: string;
  /** Name ID 6. */
  postScriptName?: string;
  /** head.macStyle bit 0. */
  bold: boolean;
  /** head.macStyle bit 1. */
  italic: boolean;
  /** OS/2.usWeightClass; 400 when the table is absent or says 0. */
  weight: number;
}

export interface TableRange { offset: number; length: number }

/** sfnt signatures this module accepts. `ttcf` is a COLLECTION, not a font --
 *  its faces are addressed through an offset table (`l1my.2`) -- and the two
 *  WOFF wrappers must be reconstructed before anything can be read. */
const SFNT_SIGS = new Set([0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */]);

const u16 = (d: Uint8Array, o: number): number => (d[o] << 8) | d[o + 1];
const u32 = (d: Uint8Array, o: number): number =>
  ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

/**
 * Map every table tag to its byte range.
 *
 * `header` need only be long enough to hold the 12-byte offset table plus
 * `numTables` 16-byte entries -- the indexer reads exactly that much and no
 * more. Returns undefined for a non-sfnt or a truncated directory.
 */
export function parseTableDirectory(header: Uint8Array): Map<string, TableRange> | undefined {
  if (header.length < 12) return undefined;
  if (!SFNT_SIGS.has(u32(header, 0))) return undefined;
  const numTables = u16(header, 4);
  if (header.length < 12 + numTables * 16) return undefined;
  const out = new Map<string, TableRange>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(header[rec], header[rec + 1], header[rec + 2], header[rec + 3]);
    out.set(tag, { offset: u32(header, rec + 8), length: u32(header, rec + 12) });
  }
  return out;
}

/** One decoded name record: its text plus whether it came from platform 3. */
interface NameRec { text: string; win: boolean }

/** Decode the name table into nameID -> best record. */
function readNameTable(data: Uint8Array): Map<number, NameRec> {
  const out = new Map<number, NameRec>();
  if (data.length < 6) return out;
  const count = u16(data, 2), stringOffset = u16(data, 4);
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > data.length) break;
    const plat = u16(data, rec);
    const nameID = u16(data, rec + 6);
    const len = u16(data, rec + 8), off = u16(data, rec + 10);
    const start = stringOffset + off;
    if (start + len > data.length) continue;
    const bytes = data.subarray(start, start + len);
    let text: string;
    if (plat === 3) {                       // UTF-16BE
      text = '';
      for (let j = 0; j + 1 < bytes.length; j += 2) {
        text += String.fromCharCode((bytes[j] << 8) | bytes[j + 1]);
      }
    } else {
      text = String.fromCharCode(...bytes); // platform 1 / 0, ASCII
    }
    const prev = out.get(nameID);
    // A font may carry BOTH spellings of one ID. Windows records are what real
    // tooling reads, so preferring them keeps this reader agreeing with every
    // other consumer -- taking whichever came first would agree on some fonts
    // and not others.
    if (!prev || (plat === 3 && !prev.win)) out.set(nameID, { text, win: plat === 3 });
  }
  return out;
}

/**
 * Assemble a `FontNames` from the three tables that carry it.
 *
 * Only a missing `name` table is declined; missing `head` or `OS/2` cost the
 * style fields their defaults, and a missing ID 1 leaves `family` EMPTY rather
 * than declining the font. That last one is deliberate and was a regression
 * when it was not: `sfnt.ts` asks this function for the PostScript name alone,
 * so declining a font that states ID 6 and no ID 1 would drop the name that
 * becomes its `/BaseFont`. A caller matching by family treats an empty one as
 * unusable; a caller wanting ID 6 does not care.
 */
export function namesFromTables(
  t: { name?: Uint8Array; head?: Uint8Array; os2?: Uint8Array },
): FontNames | undefined {
  if (!t.name) return undefined;
  const recs = readNameTable(t.name);
  const family = recs.get(1)?.text ?? '';

  const macStyle = t.head && t.head.length >= 46 ? u16(t.head, 44) : 0;
  const weight = t.os2 && t.os2.length >= 6 ? u16(t.os2, 4) || 400 : 400;

  return {
    family,
    subfamily: recs.get(2)?.text ?? 'Regular',
    typographicFamily: recs.get(16)?.text,
    typographicSubfamily: recs.get(17)?.text,
    postScriptName: recs.get(6)?.text,
    bold: (macStyle & 1) !== 0,
    italic: (macStyle & 2) !== 0,
    weight,
  };
}

/** Read the naming and style fields from a whole sfnt buffer. */
export function readFontNames(bytes: Uint8Array): FontNames | undefined {
  const dir = parseTableDirectory(bytes);
  if (!dir) return undefined;
  const slice = (tag: string): Uint8Array | undefined => {
    const r = dir.get(tag);
    if (!r || r.offset + r.length > bytes.length) return undefined;
    return bytes.subarray(r.offset, r.offset + r.length);
  };
  return namesFromTables({ name: slice('name'), head: slice('head'), os2: slice('OS/2') });
}
