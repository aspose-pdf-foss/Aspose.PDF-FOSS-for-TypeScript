import { PdfParseError } from './errors.js';

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/** ASCIIHexDecode: hex digit pairs, whitespace skipped, '>' ends data.
 *  An odd trailing nibble is treated as if followed by '0'. */
export function asciiHexDecode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === 0x3e) break; // '>'
    if (WS.has(c)) continue;
    let v: number;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) v = c - 0x41 + 10;
    else if (c >= 0x61 && c <= 0x66) v = c - 0x61 + 10;
    else throw new PdfParseError(`ASCIIHexDecode: bad hex digit 0x${c.toString(16)}`);
    if (hi < 0) hi = v;
    else { out.push((hi << 4) | v); hi = -1; }
  }
  if (hi >= 0) out.push(hi << 4); // odd trailing nibble padded with 0
  return Uint8Array.from(out);
}

/** ASCII85Decode: base-85, whitespace skipped, optional '<~' prefix, 'z' => four
 *  zero bytes, '~>' (or end) ends data. A partial final group of n chars yields
 *  n-1 bytes. */
export function ascii85Decode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const group: number[] = [];
  let i = 0;
  if (input.length >= 2 && input[0] === 0x3c && input[1] === 0x7e) i = 2; // <~
  const flush = () => {
    let n = 0;
    for (const g of group) n = (n * 85 + g) >>> 0;
    out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    group.length = 0;
  };
  for (; i < input.length; i++) {
    const c = input[i];
    if (c === 0x7e) break; // '~' (of '~>')
    if (WS.has(c)) continue;
    if (c === 0x7a) { // 'z'
      if (group.length !== 0) throw new PdfParseError('ASCII85Decode: z inside group');
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) throw new PdfParseError(`ASCII85Decode: bad char 0x${c.toString(16)}`);
    group.push(c - 0x21);
    if (group.length === 5) flush();
  }
  if (group.length === 1) throw new PdfParseError('ASCII85Decode: dangling single char');
  if (group.length > 0) {
    const cnt = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const g of group) n = (n * 85 + g) >>> 0;
    const b = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    for (let k = 0; k < cnt - 1; k++) out.push(b[k]);
  }
  return Uint8Array.from(out);
}

/** RunLengthDecode (PackBits): length 0..127 => copy len+1 literals;
 *  129..255 => repeat next byte 257-len times; 128 => EOD. */
export function runLengthDecode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const len = input[i++];
    if (len === 128) break;
    if (len < 128) {
      for (let k = 0; k <= len && i < input.length; k++) out.push(input[i++]);
    } else {
      const b = input[i++];
      for (let k = 0; k < 257 - len; k++) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

/** ASCII85Encode: 4 bytes -> 5 base-85 chars in 0x21..0x75; an all-zero 4-byte
 *  group emits 'z'; a partial final group of k bytes (1..3) emits k+1 chars
 *  (pad the group with zero bytes, drop the trailing chars). Terminated by '~>'.
 *  No '<~' prefix and no line wrapping. Inverse of ascii85Decode. */
export function ascii85Encode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = input.length;
  const group = (b0: number, b1: number, b2: number, b3: number, count: number) => {
    let val = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
    const c = [0, 0, 0, 0, 0];
    for (let k = 4; k >= 0; k--) { c[k] = val % 85; val = Math.floor(val / 85); }
    for (let k = 0; k < count; k++) out.push(c[k] + 0x21);
  };
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    if (input[i] === 0 && input[i + 1] === 0 && input[i + 2] === 0 && input[i + 3] === 0) {
      out.push(0x7a); // 'z'
    } else {
      group(input[i], input[i + 1], input[i + 2], input[i + 3], 5);
    }
  }
  const rem = n - i;
  if (rem > 0) {
    // Partial final group: pad missing bytes with 0, emit rem+1 chars (never 'z').
    group(input[i], rem > 1 ? input[i + 1] : 0, rem > 2 ? input[i + 2] : 0, 0, rem + 1);
  }
  out.push(0x7e, 0x3e); // '~>'
  return Uint8Array.from(out);
}

const HEX = '0123456789ABCDEF';

/** ASCIIHexEncode: each byte -> two uppercase hex digits, terminated by '>'. */
export function asciiHexEncode(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length * 2 + 1);
  let j = 0;
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    out[j++] = HEX.charCodeAt(b >> 4);
    out[j++] = HEX.charCodeAt(b & 0x0f);
  }
  out[j] = 0x3e; // '>'
  return out;
}

/** RunLengthEncode (PackBits): the inverse of runLengthDecode. A run of 2..128
 *  identical bytes -> (257-n, byte); a literal span of 1..128 bytes ->
 *  (n-1, bytes...); terminated by the EOD byte 128. Runs of length 2 are encoded
 *  as runs. */
export function runLengthEncode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    // Length of the identical-byte run starting at i, capped at 128.
    let runLen = 1;
    while (i + runLen < n && input[i + runLen] === input[i] && runLen < 128) runLen++;
    if (runLen >= 2) {
      out.push(257 - runLen, input[i]);
      i += runLen;
    } else {
      // Accumulate literals until a >=2 run begins or 128 is reached.
      const start = i;
      let litLen = 0;
      while (i < n && litLen < 128) {
        if (i + 1 < n && input[i + 1] === input[i]) break; // defer to run encoding
        i++; litLen++;
      }
      out.push(litLen - 1);
      for (let k = start; k < start + litLen; k++) out.push(input[k]);
    }
  }
  out.push(128); // EOD
  return Uint8Array.from(out);
}
