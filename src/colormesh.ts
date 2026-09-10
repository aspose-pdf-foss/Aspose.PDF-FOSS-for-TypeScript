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

/**
 * One vertex as the shared record walk reports it.
 *
 * **Coordinates are RAW, not decoded**, which is what lets the two consumers
 * share one walk. `respliceMesh` must write them back bit-identically — that is
 * its whole geometry guarantee — while `readMeshVertices` applies `/Decode`'s
 * coordinate half to them. Handing over decoded floats would make the
 * re-spliced output depend on float round-tripping; handing over only raw bits
 * would make the reader re-derive the record layout.
 */
export interface RawVertex {
  /** Type 4's edge flag; 0 for type 5, which has no flag field. */
  flag: number;
  rawX: number;
  rawY: number;
  /** Colour components, already scaled through `/Decode`'s colour half. */
  comps: number[];
}

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
    // ONE record walk, shared with readMeshVertices. Two walks over this record
    // is how the two would come to disagree about the type-4 padding rule.
    const err = walkGouraudVertices(r, layout, (v) => {
      if (layout.type === 4) w.write(v.flag, bpf);
      w.write(v.rawX, bpc);
      w.write(v.rawY, bpc);
      for (const g of recolor(v.comps)) {
        w.write(Math.round((g < 0 ? 0 : g > 1 ? 1 : g) * maxOut), bpp);
      }
      if (layout.type === 4) w.align();
    });
    if (err) return err;
    return trailing(r, w);
  }

  if (layout.type === 6 || layout.type === 7) {
    // ONE record walk, shared with readMeshPatches — the rule walkGouraudVertices
    // already sets for types 4 and 5, and for its reason.
    const err = walkPatches(r, layout, (p) => {
      w.write(p.flag, bpf);
      for (const v of p.raw) w.write(v, bpc);
      for (const tuple of p.comps) {
        for (const g of recolor(tuple)) {
          w.write(Math.round((g < 0 ? 0 : g > 1 ? 1 : g) * maxOut), bpp);
        }
      }
      w.align();
    });
    if (err) return err;
    return trailing(r, w);
  }

  return { kind: 'error', reason: `mesh type ${layout.type} is not supported` };
}

/** One patch record as the shared walk reports it. Coordinates are RAW, for the
 *  reason `RawVertex` records: the re-splicer must write them back
 *  bit-identically while the reader decodes them. */
export interface RawPatch {
  flag: number;
  /** `2 * points` raw coordinates in stream order — x, y, x, y, … */
  raw: number[];
  /** Corner colour tuples, already through `/Decode`'s colour half. */
  comps: number[][];
}

/**
 * The type 6/7 patch record walk, over which both consumers run.
 *
 * 8.7.4.5.7 and 8.7.4.5.8: a flag of 0 states a whole patch — 12 control points
 * for a Coons patch, 16 for a tensor one, and four corner colours; 1, 2 or 3
 * share an edge with the previous patch, so four points and two colours are
 * already known and are ABSENT from the record.
 *
 * **Note the alignment rule is INHERITED rather than newly decided:** each
 * patch is taken to end on a byte boundary, which is what `respliceMesh` has
 * always done and what keeps the reader and the writer agreeing about where the
 * next record starts. It is a no-op for every byte-multiple layout — 8, 16 or
 * 32-bit coordinates with 8-bit components and flags, which is what producers
 * emit — so no fixture here can separate the two readings.
 */
function walkPatches(
  r: BitReader, layout: MeshLayout, onPatch: (p: RawPatch) => void,
): { kind: 'error'; reason: string } | undefined {
  const { bitsPerCoordinate: bpc, bitsPerComponent: bpp, bitsPerFlag: bpf } = layout;
  const n = layout.components;
  const maxIn = 2 ** bpp - 1;
  const full = layout.type === 6 ? 12 : 16;

  while (r.remaining >= bpf) {
    const flag = r.read(bpf);
    const points = flag === 0 ? full : full - 4;
    const corners = flag === 0 ? 4 : 2;
    if (r.remaining < points * 2 * bpc + corners * n * bpp) {
      return { kind: 'error', reason: 'patch data ends mid-record' };
    }
    const raw: number[] = [];
    for (let i = 0; i < points * 2; i++) raw.push(r.read(bpc));
    const comps: number[][] = [];
    for (let i = 0; i < corners; i++) {
      const tuple: number[] = [];
      for (let k = 0; k < n; k++) {
        const lo = layout.colorDecode[k * 2] ?? 0;
        const hi = layout.colorDecode[k * 2 + 1] ?? 1;
        tuple.push(lo + (hi - lo) * (r.read(bpp) / maxIn));
      }
      comps.push(tuple);
    }
    onPatch({ flag, raw, comps });
    r.align();
  }
  return undefined;
}

/**
 * Every patch of a type 6 or 7 mesh, coordinates decoded through `/Decode`'s
 * COORDINATE half — the half `respliceMesh` deliberately never reads.
 *
 * The records are handed back AS STATED, continuation patches still missing the
 * points their flag shares: resolving those is `meshpatch.ts`'s topology rule,
 * and this module holds the bit layout and nothing else.
 */
export function readMeshPatches(
  data: Uint8Array, layout: MeshLayout, coordDecode: number[],
): { kind: 'ok'; patches: MeshPatch[] } | { kind: 'error'; reason: string } {
  if (layout.type !== 6 && layout.type !== 7) {
    return { kind: 'error', reason: `mesh type ${layout.type} is not a patch mesh` };
  }
  const max = 2 ** layout.bitsPerCoordinate - 1;
  const dec = (raw: number, i: number): number => {
    const lo = coordDecode[i * 2];
    const hi = coordDecode[i * 2 + 1];
    return lo === undefined || hi === undefined ? raw : lo + (hi - lo) * (raw / max);
  };
  const patches: MeshPatch[] = [];
  const err = walkPatches(new BitReader(data), layout, (p) => {
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < p.raw.length; i += 2) {
      points.push({ x: dec(p.raw[i], 0), y: dec(p.raw[i + 1], 1) });
    }
    patches.push({ flag: p.flag, points, colors: p.comps });
  });
  if (err) return err;
  return { kind: 'ok', patches };
}

/** A patch record with its coordinates in shading space. */
export interface MeshPatch {
  flag: number;
  points: { x: number; y: number }[];
  colors: number[][];
}

/**
 * The type 4/5 vertex record walk, over which both consumers run.
 *
 * **Invariant:** 32000-1 8.7.4.5.5 pads each type 4 VERTEX to a byte boundary;
 * 8.7.4.5.6 states no such padding for type 5, whose vertices run continuously.
 * Stated ONCE, here — a second copy is how a reader and a writer come to
 * disagree about where the next record starts, which desynchronises everything
 * after the first vertex rather than failing outright.
 */
function walkGouraudVertices(
  r: BitReader, layout: MeshLayout, onVertex: (v: RawVertex) => void,
): { kind: 'error'; reason: string } | undefined {
  const { bitsPerCoordinate: bpc, bitsPerComponent: bpp, bitsPerFlag: bpf } = layout;
  const n = layout.components;
  const maxIn = 2 ** bpp - 1;
  const flagBits = layout.type === 4 ? bpf : 0;
  const perVertex = flagBits + bpc * 2 + bpp * n;

  while (r.remaining >= perVertex) {
    const flag = flagBits > 0 ? r.read(flagBits) : 0;
    const rawX = r.read(bpc);
    const rawY = r.read(bpc);
    const comps: number[] = [];
    for (let k = 0; k < n; k++) {
      const lo = layout.colorDecode[k * 2] ?? 0;
      const hi = layout.colorDecode[k * 2 + 1] ?? 1;
      comps.push(lo + (hi - lo) * (r.read(bpp) / maxIn));
    }
    onVertex({ flag, rawX, rawY, comps });
    if (layout.type === 4) r.align();
  }
  return undefined;
}

/**
 * Every vertex of a type 4 or 5 mesh, coordinates decoded through `/Decode`'s
 * COORDINATE half — the half `respliceMesh` deliberately never reads.
 *
 * `coordDecode` is `[xmin, xmax, ymin, ymax]`; a short or absent array leaves
 * the raw value, which is the honest answer when the shading does not say.
 */
export function readMeshVertices(
  data: Uint8Array, layout: MeshLayout, coordDecode: number[],
): { kind: 'ok'; vertices: MeshVertex[] } | { kind: 'error'; reason: string } {
  if (layout.type !== 4 && layout.type !== 5) {
    return { kind: 'error', reason: `mesh type ${layout.type} is not a Gouraud mesh` };
  }
  const max = 2 ** layout.bitsPerCoordinate - 1;
  const dec = (raw: number, i: number): number => {
    const lo = coordDecode[i * 2];
    const hi = coordDecode[i * 2 + 1];
    return lo === undefined || hi === undefined ? raw : lo + (hi - lo) * (raw / max);
  };
  const vertices: MeshVertex[] = [];
  const err = walkGouraudVertices(new BitReader(data), layout, (v) => {
    vertices.push({ flag: v.flag, x: dec(v.rawX, 0), y: dec(v.rawY, 1), comps: v.comps });
  });
  if (err) return err;
  return { kind: 'ok', vertices };
}

/** A vertex with its coordinates in shading space. */
export interface MeshVertex { flag: number; x: number; y: number; comps: number[] }

/** Whatever is left must be the stream's own final-byte padding, never a whole
 *  byte of a record we failed to read. */
function trailing(r: BitReader, w: BitWriter): MeshResult {
  if (r.remaining >= 8) return { kind: 'error', reason: 'data ends mid-record' };
  return { kind: 'ok', data: w.done() };
}
