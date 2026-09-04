import { PdfParseError } from './errors.js';

/**
 * The ICC profile container: header and tag table (85l8.7.1).
 *
 * A pure leaf importing nothing but `errors.js` — bytes in, structure out. It
 * knows nothing of transforms, colour conversion or PDF: `icclut.ts` builds
 * the pipeline elements on top of it and `icctransform.ts` composes them.
 *
 * Every integer here is BIG-endian; ICC is a big-endian format throughout.
 *
 * A parser reports what the file says and never corrects it. The sRGB profile
 * this is verified against declares a D65 media white point where the ICC
 * spec would want D50 — a known quirk of that particular file, and none of
 * this module's business.
 */

/** The `major.minor.bugfix` a profile declares. */
export interface IccVersion { major: number; minor: number; bugfix: number }

export interface IccHeader {
  /** The profile's own size field, in bytes. */
  size: number;
  /** Preferred CMM, four characters, e.g. `'Lino'`. */
  cmm: string;
  version: IccVersion;
  /** `'mntr'`, `'prtr'`, `'scnr'`, … */
  deviceClass: string;
  /** `'RGB '`, `'CMYK'`, … — four characters, space padded and NOT trimmed. */
  dataColorSpace: string;
  /** `'XYZ '` or `'Lab '`. */
  pcs: string;
  /** `'MSFT'`, `'APPL'`, … */
  platform: string;
  /** 0 perceptual, 1 media-relative, 2 saturation, 3 ICC-absolute. */
  renderingIntent: number;
}

export interface IccTag {
  /** Four characters, e.g. `'rXYZ'`. */
  signature: string;
  /** Byte offset from the start of the profile. */
  offset: number;
  /** Size of the tag's data, in bytes. */
  size: number;
}

export interface IccProfile {
  header: IccHeader;
  tags: readonly IccTag[];
  /** The bytes the profile was parsed from; the tag readers index into these. */
  bytes: Uint8Array;
}

/** The ICC header is a fixed 128 bytes, and the tag count follows it. */
const HEADER_SIZE = 128;

/** Exported for `icclut.ts`, which reads tag data this module deliberately
 *  does not interpret. Both stay internal to the library — neither is
 *  re-exported from `index.ts`. */
export const u32 = (b: Uint8Array, o: number): number =>
  ((b[o] as number) << 24 | (b[o + 1] as number) << 16
    | (b[o + 2] as number) << 8 | (b[o + 3] as number)) >>> 0;

/** Four bytes as characters, space padding INCLUDED — `'RGB '` is a signature,
 *  not a word, and trimming it would stop it comparing equal to the constants
 *  callers match on. */
export const sig = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o] as number, b[o + 1] as number,
    b[o + 2] as number, b[o + 3] as number);

export function parseIccProfile(bytes: Uint8Array): IccProfile {
  if (bytes.length < HEADER_SIZE) {
    throw new PdfParseError(
      `ICC profile is ${bytes.length} bytes, too short for a ${HEADER_SIZE}-byte header`);
  }
  // Byte 36 is what makes a buffer an ICC profile at all. Without this test
  // any 128 bytes yield a confident header of nonsense.
  const signature = sig(bytes, 36);
  if (signature !== 'acsp') {
    throw new PdfParseError(
      `ICC profile signature is ${JSON.stringify(signature)}, expected "acsp"`);
  }
  // Byte 9 packs minor in its high nibble and bugfix in its low one; read raw
  // it reports 16 where the profile says 1.0.
  const version: IccVersion = {
    major: bytes[8] as number,
    minor: ((bytes[9] as number) >> 4) & 0x0f,
    bugfix: (bytes[9] as number) & 0x0f,
  };
  const header: IccHeader = {
    size: u32(bytes, 0),
    cmm: sig(bytes, 4),
    version,
    deviceClass: sig(bytes, 12),
    dataColorSpace: sig(bytes, 16),
    pcs: sig(bytes, 20),
    platform: sig(bytes, 40),
    renderingIntent: u32(bytes, 64),
  };
  // The tag count sits immediately after the 128-byte header, and each entry
  // is 12 bytes: signature, offset, size.
  if (bytes.length < HEADER_SIZE + 4) {
    throw new PdfParseError('ICC profile has no tag count');
  }
  const count = u32(bytes, HEADER_SIZE);
  const tableEnd = HEADER_SIZE + 4 + count * 12;
  if (tableEnd > bytes.length) {
    throw new PdfParseError(
      `ICC profile declares ${count} tags, which need ${tableEnd} bytes of `
      + `${bytes.length}`);
  }
  const tags: IccTag[] = [];
  for (let i = 0; i < count; i++) {
    const o = HEADER_SIZE + 4 + i * 12;
    const tag: IccTag = {
      signature: sig(bytes, o), offset: u32(bytes, o + 4), size: u32(bytes, o + 8),
    };
    // Checked ONCE, here, rather than in every tag reader: a tag running past
    // the buffer is not a wrong colour downstream but an out-of-bounds read.
    if (tag.offset + tag.size > bytes.length) {
      throw new PdfParseError(
        `ICC tag ${JSON.stringify(tag.signature)} is out of bounds: `
        + `${tag.offset}+${tag.size} exceeds ${bytes.length}`);
    }
    tags.push(tag);
  }
  return { header, tags, bytes };
}

/**
 * The tag with this signature, or undefined.
 *
 * A linear scan over an array rather than a Map lookup, and that is
 * deliberate: the signature comes from a file, so a Map keyed by it would have
 * to be probed with `hasOwnProperty` to keep `constructor` from finding
 * `Object.prototype.constructor` — the hazard `predefcmap.ts` records for a
 * CMap name a document chooses. Seventeen tags do not need an index.
 *
 * The FIRST match wins. ICC does not forbid a repeated signature, and a
 * profile carrying one is telling us something we cannot adjudicate; taking
 * the first is the same rule `xref.ts` applies to a duplicated entry.
 */
export function iccTag(p: IccProfile, signature: string): IccTag | undefined {
  return p.tags.find((t) => t.signature === signature);
}

/** A signed 16.16 fixed-point number, ICC's `s15Fixed16Number`. */
function s15Fixed16(b: Uint8Array, o: number): number {
  const raw = ((b[o] as number) << 24 | (b[o + 1] as number) << 16
    | (b[o + 2] as number) << 8 | (b[o + 3] as number));  // signed by <<24
  return raw / 65536;
}

/**
 * An `XYZ ` tag's first triple.
 *
 * The type is checked rather than assumed: every tag reader here takes an
 * `IccTag` the caller looked up by signature, and a profile is free to store
 * something else under a signature we expected. Reading a `desc` as an `XYZ `
 * yields three plausible small numbers.
 *
 * `s15Fixed16` is SIGNED — the `<< 24` is what makes it so. Reading it
 * unsigned, or scaling by the wrong power of two, produces numbers that look
 * like colour and are not; `test/icc.test.ts` anchors the result against the
 * D50 illuminant, which nothing in this file computes.
 */
export function readXyzTag(p: IccProfile, tag: IccTag): [number, number, number] {
  const type = sig(p.bytes, tag.offset);
  if (type !== 'XYZ ') {
    throw new PdfParseError(
      `ICC tag ${JSON.stringify(tag.signature)} is type ${JSON.stringify(type)}, `
      + 'expected "XYZ "');
  }
  if (tag.size < 20) {
    throw new PdfParseError(
      `ICC XYZ tag ${JSON.stringify(tag.signature)} is ${tag.size} bytes, expected 20`);
  }
  // 4 bytes type, 4 reserved, then three s15Fixed16 values.
  return [
    s15Fixed16(p.bytes, tag.offset + 8),
    s15Fixed16(p.bytes, tag.offset + 12),
    s15Fixed16(p.bytes, tag.offset + 16),
  ];
}

/**
 * A `curv` tag, whose COUNT field selects between three different meanings.
 * Confusing them is silent: the one-entry form read as a table gives a curve
 * that returns a constant, which renders as a flat wash rather than failing.
 */
export type IccCurve =
  | { kind: 'identity' }
  | { kind: 'gamma'; gamma: number }
  | { kind: 'table'; table: Uint16Array };

const u16 = (b: Uint8Array, o: number): number =>
  ((b[o] as number) << 8) | (b[o + 1] as number);

/** Read a `curv` tag. */
export function readCurveTag(p: IccProfile, tag: IccTag): IccCurve {
  const b = p.bytes;
  const type = sig(b, tag.offset);
  if (type !== 'curv') {
    throw new PdfParseError(
      `ICC tag ${JSON.stringify(tag.signature)} is type ${JSON.stringify(type)}, `
      + 'expected "curv"');
  }
  if (tag.size < 12) {
    throw new PdfParseError(`ICC curv tag is ${tag.size} bytes, expected at least 12`);
  }
  // 4 bytes type, 4 reserved, 4 count.
  const count = u32(b, tag.offset + 8);
  if (count === 0) return { kind: 'identity' };
  if (12 + count * 2 > tag.size) {
    throw new PdfParseError(
      `ICC curv tag declares ${count} entries, needing ${12 + count * 2} bytes of ${tag.size}`);
  }
  // A single entry is a GAMMA in u8Fixed8, not a one-element table: 0x0100 is
  // 1.0, where reading it as an integer gives 256 and every value raised to
  // that power collapses to zero.
  if (count === 1) return { kind: 'gamma', gamma: u16(b, tag.offset + 12) / 256 };
  const table = new Uint16Array(count);
  for (let i = 0; i < count; i++) table[i] = u16(b, tag.offset + 12 + i * 2);
  return { kind: 'table', table };
}

/** Evaluate a curve at `x` in 0..1, returning 0..1. Input is clamped. */
export function evalCurve(curve: IccCurve, x: number): number {
  const v = x < 0 ? 0 : x > 1 ? 1 : x;
  if (curve.kind === 'identity') return v;
  if (curve.kind === 'gamma') return Math.pow(v, curve.gamma);
  const { table } = curve;
  if (table.length === 0) return v;
  if (table.length === 1) return (table[0] as number) / 65535;
  // INTERPOLATED, not nearest: a 1024-entry table sampled at 256 input steps
  // would otherwise quantise the output visibly.
  const pos = v * (table.length - 1);
  const i = Math.floor(pos);
  if (i >= table.length - 1) return (table[table.length - 1] as number) / 65535;
  const frac = pos - i;
  const lo = table[i] as number;
  const hi = table[i + 1] as number;
  return (lo + (hi - lo) * frac) / 65535;
}
