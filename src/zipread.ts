/** Reading a ZIP archive (`m2fp.1`), for the DOCX importer's package layer.
 *  Note the direction: `zip.ts` WRITES archives and shares no code with this.
 *
 *  **Invariant:** LAZY. `openZip` reads the central directory and nothing
 *  else; an entry is decoded, charged and CRC-checked when it is READ. A DOCX
 *  pays for the parts its importer opens, and a bomb in an entry nobody reads
 *  costs nothing.
 *
 *  **Invariant:** ONE `InputDecoder` per archive, so every read is charged to
 *  one `maxTotalDecodedBytes` total — an archive cannot do in many entries what
 *  it may not in one. There is no result cache: reading an entry twice decodes
 *  and charges it twice, and what to keep is the caller's decision.
 *
 *  **Invariant:** the entry count is enforced against `maxContainerItems` as
 *  records are PRODUCED from the directory, never from the count the end record
 *  DECLARES. A declaration that disagrees with the directory is damage.
 *
 *  **Invariant:** sizes, CRC and flags come from the CENTRAL directory, never
 *  the local header — which is what makes a data descriptor (flag bit 3) work,
 *  whose local header carries zeros. The local header's OWN name and extra
 *  lengths locate the data, since its extra field legitimately differs from
 *  the central one (libarchive writes 32 bytes locally and 24 centrally).
 *
 *  **Invariant:** two ZIP-confusion shapes are refused as damage, because two
 *  readers would pick different bytes: a DUPLICATE name, and a local header
 *  naming a different file from its central record.
 *
 *  **Invariant:** an unsupported feature refuses the ENTRY at `read()` —
 *  encryption, a method other than stored or deflate, a ZIP64 size — so the
 *  rest of the archive stays readable. Only what hides the directory itself,
 *  a ZIP64 end record or a multi-disk archive, refuses at open.
 *
 *  **Invariant:** names are returned VERBATIM. Nothing here touches a
 *  filesystem, so `../x` is only a string.
 *
 *  A leaf over `inflatebound.js`, `crc32.js`, `loadlimits.js` and `errors.js`. */
import { InputDecoder } from './inflatebound.js';
import { crc32 } from './crc32.js';
import { LoadLimits } from './loadlimits.js';
import { PdfParseError, UnsupportedFeatureError, rethrowLimit } from './errors.js';

/** One entry as the central directory describes it. */
export interface ZipArchiveEntry {
  readonly path: string;
  /** The raw APPNOTE method number: 0 stored, 8 deflate, anything else refused at read. */
  readonly method: number;
  readonly compressedSize: number;
  /** The DECLARED uncompressed size; a read that disagrees is damage. */
  readonly size: number;
  readonly encrypted: boolean;
}

export interface ZipArchive {
  /** In central-directory order. */
  readonly entries: readonly ZipArchiveEntry[];
  has(path: string): boolean;
  /** Decode one entry. `RangeError` for a path the archive does not hold. */
  read(path: string): Uint8Array;
}

interface Entry extends ZipArchiveEntry {
  readonly flags: number;
  readonly crc: number;
  readonly local: number;
  readonly nameBytes: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const EOCD_LEN = 22;
const CEN_LEN = 46;
const LOC_LEN = 30;
const MAX_COMMENT = 0xffff;
const U32_SENTINEL = 0xffffffff;

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number): number =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** CP437's upper half, 0x80..0xFF (APPNOTE Appendix D) — the encoding a name
 *  without flag bit 11 is in. The lower half is ASCII. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' + 'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' + 'áíóúñÑªº¿⌐¬½¼¡«»' + '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐'
  + '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' + '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' + 'αßΓπΣσµτΦΘΩδ∞φε∩' + '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeName(b: Uint8Array, utf8: boolean): string {
  // ignoreBOM KEEPS a leading U+FEFF: stripped, `﻿word/document.xml`
  // reads as `word/document.xml` here and as a different part to every other
  // reader — the confusion shape this module refuses elsewhere.
  if (utf8) return new TextDecoder('utf-8', { ignoreBOM: true }).decode(b);
  let s = '';
  for (const c of b) s += c < 0x80 ? String.fromCharCode(c) : CP437_HIGH[c - 0x80];
  return s;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The end record: prefer one whose comment ends EXACTLY at the end of the
 *  buffer, so a signature inside a comment cannot win; else the one nearest
 *  the end, so trailing junk costs the junk. -1 when there is none. */
function findEocd(b: Uint8Array): number {
  const lowest = Math.max(0, b.length - EOCD_LEN - MAX_COMMENT);
  let nearest = -1;
  for (let i = b.length - EOCD_LEN; i >= lowest; i--) {
    if (u32(b, i) !== EOCD_SIG) continue;
    if (i + EOCD_LEN + u16(b, i + 20) === b.length) return i;
    if (nearest < 0) nearest = i;
  }
  return nearest;
}

function notZip(b: Uint8Array): PdfParseError {
  const ole = b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
  return new PdfParseError(ole
    ? 'not a ZIP archive: this is an OLE compound file, which is how Office stores an ENCRYPTED or a legacy (.doc) document'
    : 'not a ZIP archive: no end-of-central-directory record');
}

export function openZip(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults): ZipArchive {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw notZip(bytes);

  const disk = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const onDisk = u16(bytes, eocd + 8);
  const total = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  // A count of 0xFFFF alone is NOT treated as ZIP64: `writeZip` writes exactly
  // that for 65,535 entries. The locator, or a 32-bit sentinel, is the signal.
  if ((eocd >= 20 && u32(bytes, eocd - 20) === ZIP64_LOCATOR_SIG)
      || cdSize === U32_SENTINEL || cdOffset === U32_SENTINEL)
    throw new UnsupportedFeatureError('ZIP64 archives are not supported');
  if (disk !== 0 || cdDisk !== 0)
    throw new UnsupportedFeatureError('multi-disk ZIP archives are not supported');
  // On a single disk the two counts are one number written twice; disagreeing
  // is damage, not a feature we decline.
  if (onDisk !== total)
    throw new PdfParseError(`ZIP end record counts ${onDisk} entries on this disk and ${total} in all`, eocd);
  // With ZIP64 refused, a sound directory ends EXACTLY at the end record. A gap
  // is where readers diverge: Python's zipfile reads at `eocd - cdSize` and
  // shifts every offset, while this reads at the stated offset.
  if (cdOffset + cdSize !== eocd)
    throw new PdfParseError('ZIP central directory does not end at the end record', cdOffset);

  const entries: Entry[] = [];
  const index = new Map<string, Entry>();
  const end = cdOffset + cdSize;
  let at = cdOffset;
  while (at < end) {
    if (at + CEN_LEN > end || u32(bytes, at) !== CEN_SIG)
      throw new PdfParseError('bad ZIP central directory record', at);
    limits.enforce('maxContainerItems', entries.length + 1, 'ZIP central directory');
    const flags = u16(bytes, at + 8);
    const nameLen = u16(bytes, at + 28);
    const next = at + CEN_LEN + nameLen + u16(bytes, at + 30) + u16(bytes, at + 32);
    if (next > end) throw new PdfParseError('ZIP central directory record runs past the directory', at);
    const nameBytes = bytes.slice(at + CEN_LEN, at + CEN_LEN + nameLen);
    const path = decodeName(nameBytes, (flags & 0x0800) !== 0);
    if (index.has(path)) throw new PdfParseError(`duplicate ZIP entry name ${JSON.stringify(path)}`, at);
    const e: Entry = {
      path,
      method: u16(bytes, at + 10),
      compressedSize: u32(bytes, at + 20),
      size: u32(bytes, at + 24),
      encrypted: (flags & 0x0001) !== 0,
      flags,
      crc: u32(bytes, at + 16),
      local: u32(bytes, at + 42),
      nameBytes,
    };
    entries.push(e);
    index.set(path, e);
    at = next;
  }
  if (entries.length !== total)
    throw new PdfParseError(`ZIP end record declares ${total} entries and the directory holds ${entries.length}`);

  const decoder = new InputDecoder(limits, 'ZIP entry');
  const read = (path: string): Uint8Array => {
    const e = index.get(path);
    if (e === undefined) throw new RangeError(`no ZIP entry ${JSON.stringify(path)}`);
    if (e.encrypted) throw new UnsupportedFeatureError(`ZIP entry ${path} is encrypted`);
    if (e.method !== 0 && e.method !== 8)
      throw new UnsupportedFeatureError(
        `ZIP entry ${path} uses compression method ${e.method}; only stored (0) and deflate (8) are supported`);
    if (e.compressedSize === U32_SENTINEL || e.size === U32_SENTINEL || e.local === U32_SENTINEL)
      throw new UnsupportedFeatureError(`ZIP entry ${path} needs ZIP64`);

    const lo = e.local;
    if (lo + LOC_LEN > bytes.length || u32(bytes, lo) !== LOC_SIG)
      throw new PdfParseError(`ZIP entry ${path}: no local header where the directory points`, lo);
    const nameLen = u16(bytes, lo + 26);
    const extraLen = u16(bytes, lo + 28);
    if (!sameBytes(bytes.subarray(lo + LOC_LEN, lo + LOC_LEN + nameLen), e.nameBytes))
      throw new PdfParseError(`ZIP entry ${path}: local header names a different file`, lo);
    // The third confusion shape: a streaming reader (Java's ZipInputStream,
    // which POI uses on a stream) trusts the LOCAL fields. Unless a data
    // descriptor (bit 3) legitimately zeroes them, they must agree with ours.
    if (u16(bytes, lo + 8) !== e.method || ((e.flags & 0x0008) === 0
        && (u32(bytes, lo + 14) !== e.crc || u32(bytes, lo + 18) !== e.compressedSize
          || u32(bytes, lo + 22) !== e.size)))
      throw new PdfParseError(`ZIP entry ${path}: local header disagrees with the central directory`, lo);
    const dataAt = lo + LOC_LEN + nameLen + extraLen;
    if (dataAt + e.compressedSize > bytes.length)
      throw new PdfParseError(`ZIP entry ${path}: data runs past the end of the archive`, dataAt);
    const data = bytes.subarray(dataAt, dataAt + e.compressedSize);

    let out: Uint8Array;
    try {
      // A deflated entry with NO data at all and nothing declared is empty:
      // zlib calls a zero-byte stream truncated, while Python's zipfile and
      // other readers accept it. A declared size still has to be produced.
      out = e.method === 8
        ? (data.length === 0 && e.size === 0 ? decoder.stored(data, 0) : decoder.inflateRaw(data, e.size))
        : decoder.stored(data, e.size);
    } catch (err) {
      rethrowLimit(err);
      if (err instanceof PdfParseError) throw err;
      throw new PdfParseError(`ZIP entry ${path}: corrupt deflate data (${(err as Error).message})`, dataAt);
    }
    if (out.length !== e.size)
      throw new PdfParseError(`ZIP entry ${path}: decodes to ${out.length} bytes and declares ${e.size}`, dataAt);
    if (crc32(out) !== e.crc) throw new PdfParseError(`ZIP entry ${path}: CRC-32 mismatch`, dataAt);
    return out;
  };

  const publicEntries: readonly ZipArchiveEntry[] = entries.map(
    ({ path, method, compressedSize, size, encrypted }) => ({ path, method, compressedSize, size, encrypted }));
  return { entries: publicEntries, has: (path) => index.has(path), read };
}
