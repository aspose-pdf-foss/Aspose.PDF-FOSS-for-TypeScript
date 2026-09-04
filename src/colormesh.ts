/**
 * Re-splice a mesh shading's bit-packed vertex data to one colour component.
 *
 * Pure bit arithmetic: no PDF objects, no colour spaces, no `Document`. The
 * colour rule arrives as a callback, so this module never learns what a
 * colour space is and `colorshading.ts` stays the one owner of "what is the
 * luma of this colour" -- the split `docxtable.ts` makes against `docxflow.ts`.
 */

export interface MeshLayout {
  /** `/ShadingType`, 4 to 7. */
  type: number;
  bitsPerCoordinate: number;
  bitsPerComponent: number;
  bitsPerFlag: number;
  /** Colour components in the SOURCE space. */
  components: number;
  /** `/Decode`'s colour half: `[min, max]` per source component. */
  colorDecode: number[];
}

export type MeshResult =
  | { kind: 'ok'; data: Uint8Array }
  | { kind: 'error'; reason: string };

/** Reads MSB-first, and by multiplication rather than `<<`: a coordinate may be
 *  32 bits wide, where a shift would wrap negative. */
class BitReader {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  get remaining(): number { return this.data.length * 8 - this.pos; }

  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.pos >> 3] ?? 0;
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }

  /** Advance to the next byte boundary, discarding the padding bits. */
  align(): void { this.pos = (this.pos + 7) & ~7; }
}

class BitWriter {
  private readonly bytes: number[] = [];
  private bit = 0;

  write(v: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) {
      if (this.bit === 0) this.bytes.push(0);
      const b = Math.floor(v / 2 ** i) % 2;
      if (b) this.bytes[this.bytes.length - 1] |= 1 << (7 - this.bit);
      this.bit = (this.bit + 1) & 7;
    }
  }

  /** Pad the current byte with zeros, as 32000-1 requires of the padding a
   *  reader is told to ignore. */
  align(): void { this.bit = 0; }

  done(): Uint8Array { return Uint8Array.from(this.bytes); }
}

/**
 * Copy `data` verbatim except for each colour tuple, which is replaced by the
 * components `recolor` returns -- one for a gray target, three or four for the
 * others. The tuple's WIDTH therefore changes, which is why the caller must
 * rewrite `/Decode`'s colour half to match.
 *
 * Coordinates are copied as raw bit patterns and never pass through a float, so
 * the geometry of the output is bit-identical to the input's.
 */
export function respliceMesh(
  data: Uint8Array, layout: MeshLayout, recolor: (comps: number[]) => number[],
): MeshResult {
  const { bitsPerCoordinate: bpc, bitsPerComponent: bpp, bitsPerFlag: bpf } = layout;
  const n = layout.components;
  const r = new BitReader(data);
  const w = new BitWriter();

  const maxIn = 2 ** bpp - 1;
  const maxOut = 2 ** bpp - 1;

  /** One colour tuple: read n components, write however many `recolor` gives. */
  const color = (): void => {
    const comps: number[] = [];
    for (let k = 0; k < n; k++) {
      const lo = layout.colorDecode[k * 2] ?? 0;
      const hi = layout.colorDecode[k * 2 + 1] ?? 1;
      comps.push(lo + (hi - lo) * (r.read(bpp) / maxIn));
    }
    for (const g of recolor(comps)) {
      w.write(Math.round((g < 0 ? 0 : g > 1 ? 1 : g) * maxOut), bpp);
    }
  };

  const copy = (bits: number): void => w.write(r.read(bits), bits);

  /** One vertex: coordinate pair, then colour. */
  const vertex = (): void => { copy(bpc); copy(bpc); color(); };

  if (layout.type === 4 || layout.type === 5) {
    // 32000-1 8.7.4.5.5 pads each type 4 VERTEX to a byte boundary; 8.7.4.5.6
    // states no such padding for type 5, whose vertices run continuously.
    const flag = layout.type === 4 ? bpf : 0;
    const perVertex = flag + bpc * 2 + bpp * n;
    while (r.remaining >= perVertex) {
      if (flag > 0) copy(flag);
      vertex();
      if (layout.type === 4) { r.align(); w.align(); }
    }
    return trailing(r, w);
  }

  if (layout.type === 6 || layout.type === 7) {
    // 8.7.4.5.7 and 8.7.4.5.8. A flag of 0 states a whole patch; 1, 2 or 3
    // share an edge with the previous one, so four control points and two
    // corner colours are already known and are absent from the record.
    const full = layout.type === 6 ? 12 : 16;
    while (r.remaining >= bpf) {
      const f = r.read(bpf);
      const points = f === 0 ? full : full - 4;
      const corners = f === 0 ? 4 : 2;
      if (r.remaining < points * 2 * bpc + corners * n * bpp) {
        return { kind: 'error', reason: 'patch data ends mid-record' };
      }
      w.write(f, bpf);
      for (let i = 0; i < points * 2; i++) copy(bpc);
      for (let i = 0; i < corners; i++) color();
      r.align();
      w.align();
    }
    return trailing(r, w);
  }

  return { kind: 'error', reason: `mesh type ${layout.type} is not supported` };
}

/** Whatever is left must be the stream's own final-byte padding, never a whole
 *  byte of a record we failed to read. */
function trailing(r: BitReader, w: BitWriter): MeshResult {
  if (r.remaining >= 8) return { kind: 'error', reason: 'data ends mid-record' };
  return { kind: 'ok', data: w.done() };
}
