// Test-only JBIG2 Huffman encoder: an MSB-first bit writer and a value encoder
// over the table model. Not shipped, not imported by src/.
//
// NOTE ON WHAT THIS CAN AND CANNOT PROVE. `encodeValue` reads the SAME table
// data `HuffmanTable.decode` reads, so a typo in one of T.88's tables cancels
// out between the two halves and no fixture built here can see it. That is
// deliberate and it is not a gap: the tables themselves are anchored separately
// by utax.6's three checks (Annex B's printed prefix codes, Kraft equality,
// range contiguity). What these fixtures pin is the WALK — height classes,
// BMSIZE, the byte alignment, the collective bitmap and its slicing — which no
// property of a table can reach.
//
// The encoder is written against the line model rather than against `decode()`,
// so the two directions are independent code even though they share the data.
import { HuffmanLineKind, type HuffmanTable } from '../../src/jbig2huffman.js';

/** MSB-first bit writer with an explicit `align()`, mirroring HuffmanReader. */
export class BitWriter {
  private readonly bits: number[] = [];

  bit(b: number): void { this.bits.push(b & 1); }

  /** Write `v` in `n` bits, MSB first. Division rather than `>>`, because a
   *  range line writes 32 bits and the shift wraps negative at bit 32 — the
   *  same hazard HuffmanReader.bits avoids on the way in. */
  write(v: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) % 2);
  }

  align(): void { while (this.bits.length % 8 !== 0) this.bits.push(0); }

  /** Append whole bytes. Only legal on a byte boundary — a collective bitmap
   *  follows an align, and silently mis-aligning it would be the very bug the
   *  fixtures exist to catch. */
  bytes(data: Uint8Array): void {
    if (this.bits.length % 8 !== 0) throw new Error('BitWriter.bytes: not byte-aligned');
    for (const b of data) this.write(b, 8);
  }

  /** How many bits have been written — so a fixture can assert its own shape. */
  get length(): number { return this.bits.length; }

  toBytes(): Uint8Array {
    const padded = [...this.bits];
    while (padded.length % 8 !== 0) padded.push(0);
    const out = new Uint8Array(padded.length / 8);
    for (let i = 0; i < padded.length; i++) if (padded[i]) out[i >> 3] |= 0x80 >> (i & 7);
    return out;
  }
}

/** Emit `value` through `table`: the line's prefix code, then its offset.
 *  `null` selects the table's OOB line. */
export function encodeValue(w: BitWriter, table: HuffmanTable, value: number | null): void {
  const lines = table.lines.filter((l) => l.prefixLen > 0);
  if (value === null) {
    const oob = lines.find((l) => l.kind === HuffmanLineKind.OutOfBand);
    if (!oob) throw new Error('encodeValue: table has no OOB line');
    w.write(oob.code, oob.prefixLen);
    return;
  }
  const normal = lines.find((l) => l.kind === HuffmanLineKind.Normal
    && value >= l.rangeLow && value < l.rangeLow + 2 ** l.rangeLen);
  if (normal) {
    w.write(normal.code, normal.prefixLen);
    w.write(value - normal.rangeLow, normal.rangeLen);
    return;
  }
  const lower = lines.find((l) => l.kind === HuffmanLineKind.Lower);
  if (lower && value <= lower.rangeLow) {
    w.write(lower.code, lower.prefixLen);
    w.write(lower.rangeLow - value, 32); // SUBTRACTS, mirroring the decoder
    return;
  }
  const upper = lines.find((l) => l.kind === HuffmanLineKind.Upper);
  if (upper && value >= upper.rangeLow) {
    w.write(upper.code, upper.prefixLen);
    w.write(value - upper.rangeLow, 32);
    return;
  }
  throw new Error(`encodeValue: ${value} is outside the table's range`);
}
