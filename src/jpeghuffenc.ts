export interface HuffCode { code: number; len: number }

/** A Huffman table in DHT wire form plus its symbol→code map. */
export interface HuffTable {
  /** Count of codes of each length 1..16 (index 0 = length 1). */
  bits: number[];
  /** Symbols, ordered by code length then assignment order. */
  vals: number[];
  enc: Map<number, HuffCode>;
}

/** MSB-first bit writer with JPEG's mandatory `FF00` byte stuffing. */
export class BitWriter {
  readonly bytes: number[] = [];
  private buf = 0;
  private cnt = 0;

  put(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.buf = (this.buf << 1) | ((code >> i) & 1);
      if (++this.cnt === 8) { this.emit(this.buf); this.buf = 0; this.cnt = 0; }
    }
  }

  /** Pad the final partial byte with 1-bits. */
  flush(): void {
    if (this.cnt === 0) return;
    const pad = 8 - this.cnt;
    this.emit(((this.buf << pad) | ((1 << pad) - 1)) & 0xff);
    this.buf = 0; this.cnt = 0;
  }

  private emit(b: number): void {
    b &= 0xff;
    this.bytes.push(b);
    if (b === 0xff) this.bytes.push(0x00); // a raw FF would read as a marker
  }
}

/** Assign canonical codes to a (bits, vals) spec — the DHT wire format. */
export function buildHuffTable(bits: number[], vals: number[]): HuffTable {
  const enc = new Map<number, HuffCode>();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) enc.set(vals[k++], { code: code++, len });
    code <<= 1;
  }
  return { bits: [...bits], vals: [...vals], enc };
}

// ---- Annex K.3 standard tables ------------------------------------------------
// Transmitted verbatim in DHT, so a transcription slip costs compression ratio,
// never correctness.

const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

export const STD_DC_LUMA = buildHuffTable(
  [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], DC_VALS,
);

export const STD_DC_CHROMA = buildHuffTable(
  [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], DC_VALS,
);

export const STD_AC_LUMA = buildHuffTable(
  [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
    0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
    0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
);

export const STD_AC_CHROMA = buildHuffTable(
  [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41,
    0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1,
    0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44,
    0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
    0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a,
    0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
    0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
  ],
);

const MAX_CLEN = 32;

/**
 * Build a length-limited optimal Huffman table from symbol frequencies, per
 * Annex K.2. `freq` is length 257: 0..255 are symbol counts, 256 is reserved.
 * The caller's array is not mutated.
 *
 * Index 256 is a phantom symbol given count 1 so that it, and never a real
 * symbol, receives the all-ones codeword a decoder reserves as a sentinel. It is
 * dropped from `bits` before the table is returned.
 */
export function buildOptimalHuffTable(freq: Int32Array): HuffTable {
  const f = new Int32Array(257);
  f.set(freq.subarray(0, 257));
  f[256] = 1; // phantom: reserves the all-ones codeword

  const codesize = new Int32Array(257);
  const others = new Int32Array(257).fill(-1);

  // Repeatedly merge the two least-frequent live nodes, tracking each merged
  // chain through `others` so every member's code length grows together.
  for (;;) {
    let c1 = -1, v = Infinity;
    for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v) { v = f[i]; c1 = i; }
    let c2 = -1; v = Infinity;
    for (let i = 0; i <= 256; i++) if (f[i] && f[i] <= v && i !== c1) { v = f[i]; c2 = i; }
    if (c2 < 0) break;

    f[c1] += f[c2];
    f[c2] = 0;

    codesize[c1]++;
    while (others[c1] >= 0) { c1 = others[c1]; codesize[c1]++; }
    others[c1] = c2;
    codesize[c2]++;
    while (others[c2] >= 0) { c2 = others[c2]; codesize[c2]++; }
  }

  // Histogram of code lengths. Index i holds the count of i-bit codes.
  const bits = new Int32Array(MAX_CLEN + 1);
  for (let i = 0; i <= 256; i++) if (codesize[i]) bits[codesize[i]]++;

  // Fold codes longer than 16 bits back under the limit by repeatedly promoting
  // a shorter code into a longer slot — the Annex K.2 length-limiting procedure.
  let i = MAX_CLEN;
  for (; i > 16; i--) {
    while (bits[i] > 0) {
      let j = i - 2;
      while (bits[j] === 0) j--;
      bits[i] -= 2;
      bits[i - 1]++;
      bits[j + 1] += 2;
      bits[j]--;
    }
  }
  // Drop the phantom, which now owns the longest code.
  while (bits[i] === 0) i--;
  bits[i]--;

  const outBits: number[] = [];
  for (let n = 1; n <= 16; n++) outBits.push(bits[n]);

  // Symbols ordered by code length, then by symbol value.
  const vals: number[] = [];
  for (let len = 1; len <= MAX_CLEN; len++)
    for (let s = 0; s <= 255; s++) if (codesize[s] === len) vals.push(s);

  return buildHuffTable(outBits, vals);
}
