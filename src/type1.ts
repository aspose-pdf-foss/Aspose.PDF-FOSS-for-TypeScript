import type { Path } from './pagerender.js';
import { PdfParseError } from './errors.js';
import { standardEncodingNames } from './encoding.js';
import { runType1Charstring, Type1Env, Type1Glyph } from './type1charstring.js';
import { readType1Header } from './type1header.js';

const C1 = 52845, C2 = 22719;
const EEXEC_R = 55665, CHARSTRING_R = 4330;

/**
 * A parsed Type 1 font program — the outline source for `/FontFile`.
 *
 * Accepts the three shapes the same bytes arrive in: a bare PFA file, a PFB
 * with `0x80` segment headers, and a PDF `/FontFile` stream body. The stream
 * dict's `/Length1`/`/Length2`/`/Length3` are not needed and not consulted:
 * this finds the clear/encrypted boundary itself, so a document that misstates
 * them still reads.
 *
 * Glyph ids are this parser's own numbering — order of appearance in
 * `/CharStrings`. Type 1 has no glyph-id space; the format is name-keyed
 * throughout, which is why {@link gidForName} rather than a cmap is the route in.
 */
export class Type1Font {
  /** The program as handed in, PFB framing and all. Kept for the same reason
   *  `SfntFont.raw` and `CffFont.raw` are: a consumer that must re-emit the
   *  program — `htmlfontembed.ts` converting it to OpenType-CFF — needs the
   *  bytes, and reaching back to the `/FontFile` stream for them would make it
   *  re-resolve a dict it already has the parsed font for. */
  readonly raw: Uint8Array;
  readonly unitsPerEm: number;
  readonly numGlyphs: number;

  private readonly names: string[] = [];
  private readonly byName = new Map<string, Uint8Array>();
  private readonly nameToGid = new Map<string, number>();
  private readonly subrs: Uint8Array[] = [];
  private readonly encoding?: Map<number, string>;
  private readonly cache = new Map<number, Type1Glyph>();

  constructor(input: Uint8Array) {
    this.raw = input;
    const bytes = stripPfb(input);
    const at = indexOfAscii(bytes, 'eexec');
    if (at < 0) throw new PdfParseError('Type1: no eexec section');

    let p = at + 5;
    while (p < bytes.length && isWhite(bytes[p])) p++;
    const cipher = looksHex(bytes, p) ? hexDecode(bytes, p) : bytes.subarray(p);
    const priv = decrypt(cipher, EEXEC_R, 4);

    const lenIV = readIntAfter(priv, '/lenIV') ?? 4;
    this.readSubrs(priv, lenIV);
    this.readCharStrings(priv, lenIV);
    if (this.names.length === 0) throw new PdfParseError('Type1: no /CharStrings');

    this.numGlyphs = this.names.length;
    const clear = bytes.subarray(0, at);
    // One owner for the cleartext header — see type1header.ts.
    this.unitsPerEm = readType1Header(bytes).unitsPerEm;
    this.encoding = readBuiltinEncoding(clear);
  }

  glyphName(gid: number): string | undefined { return this.names[gid]; }
  gidForName(name: string): number | undefined { return this.nameToGid.get(name); }

  /**
   * The program's own `/Encoding`, `code -> glyph name`, or `undefined` when it
   * declares the predefined `StandardEncoding` — which embeds no array, so the
   * caller decides what "predefined" means rather than being handed a guess.
   *
   * Deliberately not named `builtinEncoding`: `CffFont.builtinEncoding()`
   * returns `code -> gid`, and two same-named methods returning different
   * `Map<number, …>` values is a mix-up nothing would catch.
   */
  builtinEncodingNames(): Map<number, string> | undefined { return this.encoding; }

  glyphPath(gid: number): Path { return this.run(gid)?.path ?? []; }

  /** The advance from `hsbw`/`sbw`, in font units. Not yet consumed by the
   *  render path — PDF `/Widths` drives advances — but read by the AFM
   *  cross-check, and by `imxw.4` when extraction learns Type 1 metrics. */
  glyphWidth(gid: number): number { return this.run(gid)?.width ?? 0; }

  private run(gid: number): Type1Glyph | undefined {
    if (gid < 0 || gid >= this.names.length) return undefined;
    const hit = this.cache.get(gid);
    if (hit) return hit;
    const cs = this.byName.get(this.names[gid]);
    if (!cs) return undefined;
    const env: Type1Env = {
      subrs: this.subrs,
      seacGlyph: (code) => {
        const n = standardEncodingNames[code & 0xff];
        return n ? this.byName.get(n) : undefined;
      },
    };
    const g = runType1Charstring(cs, env);
    this.cache.set(gid, g);
    return g;
  }

  private readSubrs(priv: Uint8Array, lenIV: number): void {
    const start = indexOfAscii(priv, '/Subrs');
    if (start < 0) return;
    const csAt = indexOfAscii(priv, '/CharStrings');
    let p = start + 6;
    for (;;) {
      const dup = indexOfAscii(priv, 'dup ', p);
      if (dup < 0) break;
      if (csAt >= 0 && dup > csAt) break;          // a `dup` in a later dictionary
      let q = dup + 4;
      const idx = readInt(priv, q); if (!idx) break; q = idx.end;
      const len = readInt(priv, q); if (!len) break; q = len.end;
      const data = afterBinaryToken(priv, q, len.value);
      if (!data) break;
      this.subrs[idx.value] = decrypt(data.bytes, CHARSTRING_R, lenIV);
      p = data.end;
    }
  }

  private readCharStrings(priv: Uint8Array, lenIV: number): void {
    let p = indexOfAscii(priv, '/CharStrings');
    if (p < 0) return;
    p = indexOfAscii(priv, 'begin', p);
    if (p < 0) return;
    p += 5;
    while (p < priv.length) {
      while (p < priv.length && priv[p] !== 0x2f) {                 // '/'
        if (matchesAscii(priv, p, 'end')) return;
        p++;
      }
      if (p >= priv.length) return;
      const name = readName(priv, p + 1);
      let q = name.end;
      const len = readInt(priv, q);
      if (!len) { p = q; continue; }
      const data = afterBinaryToken(priv, len.end, len.value);
      if (!data) return;
      if (!this.nameToGid.has(name.value)) {
        this.nameToGid.set(name.value, this.names.length);
        this.names.push(name.value);
        this.byName.set(name.value, decrypt(data.bytes, CHARSTRING_R, lenIV));
      }
      p = data.end;
    }
  }
}

// ---------- byte helpers ----------

const isWhite = (b: number): boolean =>
  b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x00 || b === 0x0c;

function decrypt(data: Uint8Array, r0: number, skip: number): Uint8Array {
  let r = r0;
  const out = new Uint8Array(Math.max(0, data.length - skip));
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    const plain = (c ^ (r >> 8)) & 0xff;
    r = ((c + r) * C1 + C2) & 0xffff;
    if (i >= skip) out[i - skip] = plain;
  }
  return out;
}

/** Drop `0x80`-tagged PFB segment headers, concatenating the payloads. */
function stripPfb(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 6 || bytes[0] !== 0x80) return bytes;
  const parts: Uint8Array[] = [];
  let p = 0;
  while (p + 6 <= bytes.length && bytes[p] === 0x80) {
    const type = bytes[p + 1];
    if (type === 3) break;                         // EOF segment
    const len = bytes[p + 2] | (bytes[p + 3] << 8) | (bytes[p + 4] << 16) | (bytes[p + 5] << 24);
    if (len < 0 || p + 6 + len > bytes.length) break;
    parts.push(bytes.subarray(p + 6, p + 6 + len));
    p += 6 + len;
  }
  if (parts.length === 0) return bytes;
  const n = parts.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

const isHexDigit = (b: number): boolean =>
  (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);

/** The eexec section is hex when its first four non-whitespace bytes are all hex
 *  digits — the Type 1 spec's own test. It works because an encoder writing
 *  binary checks the same thing and re-rolls its random leading bytes. */
function looksHex(b: Uint8Array, p: number): boolean {
  let seen = 0;
  for (let i = p; i < b.length && seen < 4; i++) {
    if (isWhite(b[i])) continue;
    if (!isHexDigit(b[i])) return false;
    seen++;
  }
  return seen === 4;
}

function hexDecode(b: Uint8Array, p: number): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (let i = p; i < b.length; i++) {
    const c = b[i];
    if (isWhite(c)) continue;
    if (!isHexDigit(c)) break;
    const v = c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x57;
    if (hi < 0) hi = v; else { out.push((hi << 4) | v); hi = -1; }
  }
  return Uint8Array.from(out);
}

function matchesAscii(b: Uint8Array, at: number, s: string): boolean {
  if (at + s.length > b.length) return false;
  for (let k = 0; k < s.length; k++) if (b[at + k] !== s.charCodeAt(k)) return false;
  return true;
}

function indexOfAscii(b: Uint8Array, s: string, from = 0): number {
  for (let i = Math.max(0, from); i + s.length <= b.length; i++) if (matchesAscii(b, i, s)) return i;
  return -1;
}

function readInt(b: Uint8Array, at: number): { value: number; end: number } | undefined {
  let p = at;
  while (p < b.length && isWhite(b[p])) p++;
  const start = p;
  if (p < b.length && (b[p] === 0x2d || b[p] === 0x2b)) p++;
  while (p < b.length && b[p] >= 0x30 && b[p] <= 0x39) p++;
  if (p === start || (p === start + 1 && !(b[start] >= 0x30 && b[start] <= 0x39))) return undefined;
  return { value: parseInt(asciiOf(b, start, p), 10), end: p };
}

function readIntAfter(b: Uint8Array, key: string): number | undefined {
  const at = indexOfAscii(b, key);
  return at < 0 ? undefined : readInt(b, at + key.length)?.value;
}

function readName(b: Uint8Array, at: number): { value: string; end: number } {
  let p = at;
  while (p < b.length && !isWhite(b[p]) && b[p] !== 0x2f && b[p] !== 0x28 && b[p] !== 0x7b) p++;
  return { value: asciiOf(b, at, p), end: p };
}

function asciiOf(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]);
  return s;
}

/**
 * Skip the `RD` token (or `-|`, or whatever the font named the procedure) and
 * the single space that follows it, then take `len` bytes.
 *
 * The token is read as "one whitespace-delimited token", not matched against a
 * list: it is a procedure the font defines in its own Private dict and may be
 * called anything. Exactly one blank separates it from the binary — a second
 * one is data.
 */
function afterBinaryToken(b: Uint8Array, at: number, len: number): { bytes: Uint8Array; end: number } | undefined {
  let p = at;
  while (p < b.length && isWhite(b[p])) p++;
  while (p < b.length && !isWhite(b[p])) p++;          // the RD-ish token
  p++;                                                  // exactly one blank
  if (len < 0 || p + len > b.length) return undefined;
  return { bytes: b.subarray(p, p + len), end: p + len };
}

/** `dup <code> /<name> put` entries from the clear portion, or `undefined` when
 *  the program declares the predefined StandardEncoding. */
function readBuiltinEncoding(clear: Uint8Array): Map<number, string> | undefined {
  const at = indexOfAscii(clear, '/Encoding');
  if (at < 0) return undefined;
  const head = asciiOf(clear, at, Math.min(clear.length, at + 64));
  if (/^\/Encoding\s+StandardEncoding/.test(head)) return undefined;
  const map = new Map<number, string>();
  let p = at;
  for (;;) {
    const dup = indexOfAscii(clear, 'dup ', p);
    if (dup < 0) break;
    const code = readInt(clear, dup + 4);
    if (!code) { p = dup + 4; continue; }
    let q = code.end;
    while (q < clear.length && isWhite(clear[q])) q++;
    if (clear[q] !== 0x2f) { p = code.end; continue; }
    const name = readName(clear, q + 1);
    map.set(code.value & 0xff, name.value);
    p = name.end;
  }
  return map.size ? map : undefined;
}
