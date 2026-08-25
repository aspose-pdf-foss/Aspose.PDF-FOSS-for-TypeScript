import { deflateRawSync } from 'node:zlib';
import { crc32 } from './crc32.js';

/** One file in an archive. */
export interface ZipEntry {
  /** Archive-relative path, '/'-separated, with no leading slash. */
  path: string;
  bytes: Uint8Array;
  /** Default 'deflate'. Use 'store' for already-compressed data, and for a
   *  payload a reader must be able to find without inflating. */
  method?: 'store' | 'deflate';
}

/** 1980-01-01 00:00:00 in MS-DOS date/time — the zero of the format ZIP
 *  stores, and the only value that needs no clock. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

function u16(n: number): number[] { return [n & 0xff, (n >>> 8) & 0xff]; }
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** Write a ZIP archive.
 *
 *  **Invariant:** the compression method is per ENTRY. EPUB requires its
 *  `mimetype` entry stored uncompressed, so an archive-wide setting would force
 *  a second writer for that format.
 *
 *  **Invariant:** timestamps are a fixed constant, never the clock. Two runs
 *  over one input must give identical bytes, or nothing downstream can be
 *  snapshot-tested and a caller cannot tell a real change from the time of day.
 *
 *  **Invariant:** overflow throws. Past 4 GB or 65535 entries the 32-bit fields
 *  wrap and the archive is silently corrupt; ZIP64 is the feature that would
 *  lift the bound and is deliberately absent. */
export function writeZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES)
    throw new RangeError(`a zip holds at most ${MAX_ENTRIES} entries without ZIP64`);

  const seen = new Set<string>();
  for (const e of entries) {
    if (e.path === '' || e.path.startsWith('/'))
      throw new TypeError(`zip path must be relative and non-empty: ${JSON.stringify(e.path)}`);
    if (e.path.includes('\\'))
      throw new TypeError(`zip path must use '/' separators: ${JSON.stringify(e.path)}`);
    if (seen.has(e.path)) throw new TypeError(`duplicate zip path: ${e.path}`);
    seen.add(e.path);
  }

  const local: number[] = [];
  const central: number[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Array.from(new TextEncoder().encode(e.path));
    const method = e.method ?? 'deflate';
    const raw = method === 'deflate'
      ? new Uint8Array(deflateRawSync(Buffer.from(e.bytes)))
      : e.bytes;
    const sum = crc32(e.bytes);

    if (e.bytes.length > MAX_BYTES || raw.length > MAX_BYTES)
      throw new RangeError(`zip entry ${e.path} exceeds 4 GB; ZIP64 is not supported`);

    // Shared by the local header and the central directory entry, so the two
    // cannot describe the same file differently.
    const header = [
      ...u16(method === 'deflate' ? 20 : 10),  // version needed
      ...u16(0),                               // flags
      ...u16(method === 'deflate' ? 8 : 0),    // method
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(sum), ...u32(raw.length), ...u32(e.bytes.length),
      ...u16(name.length), ...u16(0),          // name length, extra length
    ];
    local.push(...u32(0x04034b50), ...header, ...name, ...raw);

    central.push(
      ...u32(0x02014b50),
      ...u16(20),                              // version made by
      ...header,
      ...u16(0), ...u16(0), ...u16(0),         // comment len, disk, internal attrs
      ...u32(0),                               // external attrs
      ...u32(offset),
      ...name,
    );
    offset = local.length;
  }

  const cdOffset = local.length;
  const eocd = [
    ...u32(0x06054b50),
    ...u16(0), ...u16(0),                      // this disk, cd start disk
    ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length), ...u32(cdOffset),
    ...u16(0),                                 // comment length
  ];
  return Uint8Array.from([...local, ...central, ...eocd]);
}
