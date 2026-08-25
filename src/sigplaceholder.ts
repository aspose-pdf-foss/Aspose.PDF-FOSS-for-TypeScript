import { PdfDict } from './types.js';
import { serializeDict } from './serialize.js';
import { PdfParseError } from './errors.js';

/** Shared signature `/Contents` placeholder + `/ByteRange` machinery, used by
 *  both write paths: the incremental-update writer (`incremental.ts`) and the
 *  sign-on-save full-rewrite serializer (`serializer.ts`).
 *
 *  The mechanism is identical in both: serialize the signature value dictionary
 *  with a fixed-size `/Contents <00…00>` hex placeholder and a fixed-width
 *  `/ByteRange` whose three computed numbers are patched in place once the final
 *  byte offsets are known. The `<`/`>` delimiters are inside the signed range;
 *  only the hex digits are excluded, so the digest never changes when the CMS is
 *  dropped into the placeholder with {@link fillSignature}. */

/** Decimal field width reserved for each computed `/ByteRange` number (bytes). */
export const BYTE_RANGE_FIELD = 10;
/** Default reserved capacity for the detached CMS, in bytes. */
export const DEFAULT_PLACEHOLDER_BYTES = 8192;

/** A serialized signature dictionary body with reserved, not-yet-filled slots. */
export interface SignaturePlaceholder {
  /** The dict body `<< …entries… /ByteRange [0 …] /Contents <0…0> >>` (ASCII). */
  body: string;
  /** Offsets (within `body`) of the three reserved `/ByteRange` number slots. */
  slotOffsets: [number, number, number];
  /** Offset (within `body`) of the first hex digit of the `/Contents` value. */
  hexStart: number;
}

/** Where the signed content lives after layout, and the range it must digest. */
export interface SignatureLayout {
  /** The full byte image: `/ByteRange` filled, `/Contents` zero-filled. */
  bytes: Uint8Array;
  /** `[0, a, b, c]` — the two ranges covering everything but the `/Contents` hex. */
  byteRange: [number, number, number, number];
  /** Byte offset of the first hex digit inside the `/Contents <…>` placeholder. */
  contentsOffset: number;
  /** Number of reserved hex digits (`2 * placeholderBytes`). */
  contentsLength: number;
}

/** Serialize `sigDict` with a `/ByteRange` placeholder (three fixed-width slots)
 *  and a zero-filled `/Contents` hex run of `placeholderBytes` capacity, plus the
 *  offsets to patch once final positions are known. Caller-supplied `/ByteRange`
 *  or `/Contents` entries are ignored — this owns them. */
export function buildSigDictPlaceholder(sigDict: PdfDict, placeholderBytes: number): SignaturePlaceholder {
  const dict: PdfDict = new Map(sigDict);
  dict.delete('ByteRange');
  dict.delete('Contents');

  // serializeDict yields "<< …entries… >>"; reopen it to append our fields.
  const head = serializeDict(dict).slice(0, -2); // drop trailing ">>", keep "<< … "
  const field = ' '.repeat(BYTE_RANGE_FIELD);

  let s = `${head}/ByteRange [0 `;
  const slot0 = s.length; s += field + ' ';
  const slot1 = s.length; s += field + ' ';
  const slot2 = s.length; s += field;
  s += '] /Contents <';
  const hexStart = s.length;
  s += '0'.repeat(placeholderBytes * 2);
  s += '> >>';

  return { body: s, slotOffsets: [slot0, slot1, slot2], hexStart };
}

/** Compute the `/ByteRange` from final offsets, patch the three reserved slots in
 *  place (no length change), and return the layout. `bodyStart` is the absolute
 *  offset where the placeholder `body` begins in `bytes`. */
export function finalizePlaceholder(
  bytes: Uint8Array, bodyStart: number, ph: SignaturePlaceholder, placeholderBytes: number,
): SignatureLayout {
  const contentsOffset = bodyStart + ph.hexStart;
  const contentsLength = placeholderBytes * 2;
  const byteRange: [number, number, number, number] = [
    0,
    contentsOffset,                    // range 1: [0, firstHexDigit) — includes '<'
    contentsOffset + contentsLength,   // range 2 start: the '>' position
    bytes.length - (contentsOffset + contentsLength),
  ];
  writeField(bytes, bodyStart + ph.slotOffsets[0], byteRange[1]);
  writeField(bytes, bodyStart + ph.slotOffsets[1], byteRange[2]);
  writeField(bytes, bodyStart + ph.slotOffsets[2], byteRange[3]);
  return { bytes, byteRange, contentsOffset, contentsLength };
}

/** Hex-encode `der` into the `/Contents` placeholder, zero-padding the remainder.
 *  Mutates `bytes` in place; offsets are unchanged. Throws if `der` exceeds the
 *  reserved capacity. */
export function fillSignature(
  bytes: Uint8Array, where: Pick<SignatureLayout, 'contentsOffset' | 'contentsLength'>, der: Uint8Array,
): void {
  const capacity = where.contentsLength / 2;
  if (der.length > capacity)
    throw new PdfParseError(`signature too large: ${der.length} bytes exceeds reserved ${capacity}`);
  const hex = '0123456789abcdef';
  let p = where.contentsOffset;
  for (const b of der) {
    bytes[p++] = hex.charCodeAt(b >> 4);
    bytes[p++] = hex.charCodeAt(b & 0xf);
  }
  const end = where.contentsOffset + where.contentsLength;
  while (p < end) bytes[p++] = 0x30; // '0'
}

/** Render `value` left-justified into a `BYTE_RANGE_FIELD`-wide slot at `at`,
 *  padding with trailing spaces (legal array whitespace) so length is fixed. */
function writeField(bytes: Uint8Array, at: number, value: number): void {
  const text = String(value);
  if (text.length > BYTE_RANGE_FIELD)
    throw new PdfParseError(`/ByteRange value ${value} exceeds ${BYTE_RANGE_FIELD}-digit field`);
  let p = at;
  for (const ch of text) bytes[p++] = ch.charCodeAt(0);
  const end = at + BYTE_RANGE_FIELD;
  while (p < end) bytes[p++] = 0x20; // space
}
