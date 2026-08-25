import { deflateSync, inflateSync } from 'node:zlib';
import {
  PdfObject, PdfDict, PdfRef, PdfStream, isRef, isDict, isArray, isStream, isName, ref, name,
} from './types.js';
import { UnsupportedFeatureError, PdfParseError } from './errors.js';
import { enc, serializeObject, serializeValue } from './serialize.js';
import type { Plan } from './serializer.js';

/** MSB-first bit writer for the linearization hint tables (ISO 32000-1 Annex F.3).
 *  `write(value, bits)` appends the low `bits` bits of `value`, most-significant
 *  first; `finish()` zero-pads the final partial byte. */
export class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private nbits = 0;
  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >>> i) & 1);
      if (++this.nbits === 8) { this.bytes.push(this.cur); this.cur = 0; this.nbits = 0; }
    }
  }
  /** Pad to a byte boundary with zero bits (no-op when already aligned). */
  align(): void {
    if (this.nbits > 0) { this.bytes.push(this.cur << (8 - this.nbits)); this.cur = 0; this.nbits = 0; }
  }
  /** Current length in bytes if `finish()`/`align()` were called now. */
  byteLength(): number {
    return this.bytes.length + (this.nbits > 0 ? 1 : 0);
  }
  finish(): Uint8Array {
    this.align();
    return Uint8Array.from(this.bytes);
  }
}

/** MSB-first bit reader, the read counterpart to {@link BitWriter}. */
export class BitReader {
  constructor(private readonly data: Uint8Array, private bitPos = 0) {}
  read(bits: number): number {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.data[this.bitPos >> 3] ?? 0;
      const bit = (byte >> (7 - (this.bitPos & 7))) & 1;
      v = (v << 1) | bit;
      this.bitPos++;
    }
    return v >>> 0;
  }
  /** Advance to the next byte boundary. */
  align(): void {
    if ((this.bitPos & 7) !== 0) this.bitPos = (this.bitPos & ~7) + 8;
  }
  /** Current read position in bits. */
  position(): number {
    return this.bitPos;
  }
}

/** Minimum number of bits to represent the non-negative integer `v`
 *  (`nbits(0) === 0`, `nbits(1) === 1`, `nbits(255) === 8`). Matches qpdf's
 *  `nbits`. */
function nbits(v: number): number {
  let n = 0;
  while (v > 0) { n++; v >>>= 1; }
  return n;
}

/** Re-run the mark-sweep plan locally (no runtime import of serializer.ts, which
 *  imports this module). Mirrors `planDocument`. */
function planLocal(objects: Map<number, PdfObject>, trailer: PdfDict): Plan {
  const rootRef = trailer.get('Root');
  if (!isRef(rootRef)) throw new PdfParseError('cannot serialize: /Root is not an indirect reference');
  const infoRef = trailer.get('Info');
  const oldToNew = new Map<number, number>();
  const order: number[] = [];
  const queue: number[] = [];
  const enqueue = (num: number): void => {
    if (oldToNew.has(num)) return;
    oldToNew.set(num, oldToNew.size + 1);
    order.push(num);
    queue.push(num);
  };
  enqueue(rootRef.num);
  if (isRef(infoRef)) enqueue(infoRef.num);
  while (queue.length) {
    const obj = objects.get(queue.shift()!);
    if (obj === undefined) continue;
    const refs: PdfRef[] = [];
    refsIn(obj, refs);
    for (const r of refs) if (objects.has(r.num)) enqueue(r.num);
  }
  const objs = order.map((old) => remap(objects.get(old)!, oldToNew));
  return { rootRef, infoRef: isRef(infoRef) ? infoRef : null, oldToNew, objs };
}

/** Deep-copy `o`, rewriting every ref's object number through `map` (gen reset to 0). */
function remap(o: PdfObject, map: Map<number, number>): PdfObject {
  if (isRef(o)) return ref(map.get(o.num) ?? o.num, 0);
  if (isArray(o)) return o.map((v) => remap(v, map));
  if (isDict(o)) {
    const d: PdfDict = new Map();
    for (const [k, v] of o) d.set(k, remap(v, map));
    return d;
  }
  if (isStream(o)) {
    const d: PdfDict = new Map();
    for (const [k, v] of o.dict) d.set(k, remap(v, map));
    return { kind: 'stream', dict: d, raw: o.raw };
  }
  return o;
}

/** Collect every PdfRef contained directly in `o` (dict values, array elements,
 *  stream-dict values). Local copy so `linearize.ts` does not import the
 *  serializer at runtime (which imports this module). */
function refsIn(o: PdfObject, out: PdfRef[]): void {
  if (isRef(o)) out.push(o);
  else if (isArray(o)) for (const v of o) refsIn(v, out);
  else if (isDict(o)) for (const v of o.values()) refsIn(v, out);
  else if (isStream(o)) for (const v of o.dict.values()) refsIn(v, out);
}

/** Partition of the planned object graph into the linearized layout's two
 *  halves, plus the shared-object set that feeds the shared-object hint table.
 *  All numbers are *new* (post-`planDocument`) object numbers. */
export interface LinearizationPartition {
  /** First-page set: catalog, the page-tree nodes on the path to page 1, page 1,
   *  and the transitive closure of page 1's /Contents, /Resources, /Annots.
   *  Ordered catalog → path → page 1 → closure (discovery order). */
  firstPage: number[];
  /** Everything else reachable from /Root (+ /Info), in ascending object number. */
  remainder: number[];
  /** First-page closure objects also referenced from the remainder, in
   *  discovery order. A subset of `firstPage`. */
  shared: number[];
  /** Object number of the first page (the /O entry of the parameter dict). */
  firstPageObjNum: number;
  /** Total number of pages (the /N entry). */
  pageCount: number;
}

/** Partition a planned document into a first-page set, remainder, and the
 *  shared-object set, per ISO 32000-1 Annex F. Pure: reads `plan`, mutates
 *  nothing. Throws {@link UnsupportedFeatureError} when there are no pages. */
export function partitionForLinearization(plan: Plan): LinearizationPartition {
  const { rootRef, oldToNew, objs } = plan;
  const n = objs.length;
  const get = (num: number): PdfObject | undefined =>
    num >= 1 && num <= n ? objs[num - 1] : undefined;
  const asDict = (num: number): PdfDict | undefined => {
    const o = get(num);
    if (isDict(o)) return o;
    if (isStream(o)) return o.dict;
    return undefined;
  };

  const catalogNum = oldToNew.get(rootRef.num)!;
  const catalog = asDict(catalogNum);
  const pagesRef = catalog?.get('Pages');
  if (!isRef(pagesRef)) {
    throw new UnsupportedFeatureError('linearization requires at least one page');
  }

  // Descend the page tree to the first leaf, recording the node numbers on the
  // path (page-tree root → … → page 1). Cycle-guarded.
  const path: number[] = [];
  const seen = new Set<number>();
  let nodeNum = pagesRef.num;
  for (;;) {
    if (seen.has(nodeNum)) {
      throw new UnsupportedFeatureError('linearization requires at least one page');
    }
    seen.add(nodeNum);
    path.push(nodeNum);
    const node = asDict(nodeNum);
    const type = node?.get('Type');
    const kids = node?.get('Kids');
    if ((isName(type) && type.name === 'Page') || !isArray(kids) || kids.length === 0) {
      break; // leaf (explicit /Page, or no /Kids): this is page 1
    }
    const firstKid = kids[0];
    if (!isRef(firstKid)) {
      throw new UnsupportedFeatureError('linearization requires an indirect page tree');
    }
    nodeNum = firstKid.num;
  }
  const firstPageObjNum = path[path.length - 1];
  // The leaf must actually be a page-like dict, not an empty page tree.
  const leaf = asDict(firstPageObjNum);
  const leafType = leaf?.get('Type');
  if (leaf === undefined || (isName(leafType) && leafType.name !== 'Page')) {
    throw new UnsupportedFeatureError('linearization requires at least one page');
  }

  // Transitive closure of page 1's /Contents, /Resources, /Annots.
  const closure = new Set<number>();
  const seeds: PdfRef[] = [];
  for (const key of ['Contents', 'Resources', 'Annots']) {
    const v = leaf!.get(key);
    if (v !== undefined) refsIn(v, seeds);
  }
  const queue = seeds.map((r) => r.num);
  while (queue.length) {
    const num = queue.shift()!;
    if (closure.has(num) || get(num) === undefined) continue;
    closure.add(num);
    const rs: PdfRef[] = [];
    refsIn(get(num)!, rs);
    for (const r of rs) queue.push(r.num);
  }

  // First-page set: catalog, path nodes, then closure (deduped, order-preserving).
  const firstPage: number[] = [];
  const inFirstPage = new Set<number>();
  const addFirst = (num: number): void => {
    if (inFirstPage.has(num)) return;
    inFirstPage.add(num);
    firstPage.push(num);
  };
  addFirst(catalogNum);
  for (const num of path) addFirst(num);
  for (const num of closure) addFirst(num);

  // Remainder: every other reachable object, ascending.
  const remainder: number[] = [];
  for (let num = 1; num <= n; num++) if (!inFirstPage.has(num)) remainder.push(num);

  // Shared objects: first-page *closure* members referenced from the remainder.
  const refdFromRemainder = new Set<number>();
  for (const num of remainder) {
    const rs: PdfRef[] = [];
    refsIn(get(num)!, rs);
    for (const r of rs) refdFromRemainder.add(r.num);
  }
  const shared = [...closure].filter((num) => refdFromRemainder.has(num));

  return { firstPage, remainder, shared, firstPageObjNum, pageCount: countPages(plan) };
}

/** Count page leaves in the planned page tree (cycle-guarded). */
function countPages(plan: Plan): number {
  const { rootRef, oldToNew, objs } = plan;
  const n = objs.length;
  const asDict = (num: number): PdfDict | undefined => {
    const o = num >= 1 && num <= n ? objs[num - 1] : undefined;
    if (isDict(o)) return o;
    if (isStream(o)) return o.dict;
    return undefined;
  };
  const pagesRef = asDict(oldToNew.get(rootRef.num)!)?.get('Pages');
  if (!isRef(pagesRef)) return 0;

  let count = 0;
  const seen = new Set<number>();
  const walk = (num: number): void => {
    if (seen.has(num)) return;
    seen.add(num);
    const node = asDict(num);
    if (node === undefined) return;
    const type = node.get('Type');
    const kids = node.get('Kids');
    if ((isName(type) && type.name === 'Page') || !isArray(kids)) {
      count++;
      return;
    }
    for (const kid of kids) if (isRef(kid)) walk(kid.num);
  };
  walk(pagesRef.num);
  return count;
}

/** Format a byte offset/length as a fixed-width, zero-padded 10-digit token so
 *  backfilling its value never shifts any later byte (qpdf's technique). */
function fw(n: number): string {
  return String(n).padStart(10, '0');
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/** Refs contained in a page dictionary, ignoring `/Parent` (which points up the
 *  page tree, a document-level object, not page content). */
function pageContentRefs(pageDict: PdfDict): PdfRef[] {
  const out: PdfRef[] = [];
  for (const [k, v] of pageDict) if (k !== 'Parent') refsIn(v, out);
  return out;
}

/** The linearized object placement, per ISO 32000-1 Annex F / qpdf's model.
 *  All numbers are *new* (post-`planDocument`) object numbers. */
interface LinearLayout {
  /** Document-level objects (catalog + page-tree internal nodes). */
  part4: number[];
  /** Per-page contiguous object blocks, page object first. `blocks[0]` is the
   *  first-page section (part 6); `blocks[p>0]` is page p's private group
   *  (part 7). `blocks[p].length` is that page's object count. */
  blocks: number[][];
  /** Shared objects used by ≥2 later pages but not the first page (part 8). */
  part8: number[];
  /** Everything else reachable (e.g. `/Info`, outlines) — part 9. */
  part9: number[];
  /** Shared-object hint table entries: all first-page objects (`blocks[0]`)
   *  then part 8, in order. */
  sharedTable: number[];
  /** For each page, the shared-table indices it references; `[0]` is forced
   *  empty (qpdf convention: the first page declares no shared objects). */
  sharedRefs: number[][];
  firstPageObjNum: number;
  pageCount: number;
}

/** Group the planned object graph into the linearized parts (4/6/7/8/9), the
 *  shared-object table, and each page's shared references. Pure. */
function computeLinearLayout(plan: Plan): LinearLayout {
  const { rootRef, oldToNew, objs } = plan;
  const n = objs.length;
  const get = (num: number): PdfObject | undefined =>
    num >= 1 && num <= n ? objs[num - 1] : undefined;
  const asDict = (num: number): PdfDict | undefined => {
    const o = get(num);
    return isDict(o) ? o : isStream(o) ? o.dict : undefined;
  };

  const catalogNum = oldToNew.get(rootRef.num)!;
  const pagesRef = asDict(catalogNum)?.get('Pages');
  if (!isRef(pagesRef)) {
    throw new UnsupportedFeatureError('linearization requires at least one page');
  }

  // Walk the page tree: collect leaves (in order) and internal nodes.
  const leaves: number[] = [];
  const internal: number[] = [];
  const seen = new Set<number>();
  const walk = (num: number): void => {
    if (seen.has(num)) return;
    seen.add(num);
    const node = asDict(num);
    if (node === undefined) return;
    const type = node.get('Type');
    const kids = node.get('Kids');
    if ((isName(type) && type.name === 'Page') || !isArray(kids) || kids.length === 0) {
      leaves.push(num);
      return;
    }
    internal.push(num);
    for (const kid of kids) if (isRef(kid)) walk(kid.num);
  };
  walk(pagesRef.num);
  if (leaves.length === 0) {
    throw new UnsupportedFeatureError('linearization requires at least one page');
  }

  const docLevel = new Set<number>([catalogNum, ...internal]);
  const leafSet = new Set<number>(leaves);

  // Per-page closure: transitive refs from the page dict (minus /Parent), not
  // crossing into document-level nodes or other page objects.
  const closures: number[][] = leaves.map((leafNum) => {
    const dict = asDict(leafNum);
    const result: number[] = [];
    const inClosure = new Set<number>();
    const queue = dict ? pageContentRefs(dict).map((r) => r.num) : [];
    while (queue.length) {
      const num = queue.shift()!;
      if (inClosure.has(num) || docLevel.has(num) || leafSet.has(num) || get(num) === undefined) {
        continue;
      }
      inClosure.add(num);
      result.push(num);
      const rs: PdfRef[] = [];
      refsIn(get(num)!, rs);
      for (const r of rs) queue.push(r.num);
    }
    return result;
  });

  // Which pages use each object.
  const usedBy = new Map<number, Set<number>>();
  closures.forEach((c, p) => {
    for (const obj of c) {
      let s = usedBy.get(obj);
      if (s === undefined) { s = new Set(); usedBy.set(obj, s); }
      s.add(p);
    }
  });
  const isShared = (obj: number): boolean => {
    const s = usedBy.get(obj);
    return s !== undefined && (s.has(0) || s.size >= 2);
  };

  // part 6 = page 0 + its whole closure (every object page 0 touches lives here,
  // even those also used later — those become first-page shared objects).
  const block0 = [leaves[0], ...closures[0]];
  // part 7 = each later page + its private-only objects.
  const blocks: number[][] = [block0];
  const part8: number[] = [];
  const inPart8 = new Set<number>();
  for (let p = 1; p < leaves.length; p++) {
    const priv: number[] = [];
    for (const obj of closures[p]) {
      const users = usedBy.get(obj)!;
      if (users.has(0)) continue;            // belongs to part 6
      if (users.size >= 2) {                 // shared among later pages → part 8
        if (!inPart8.has(obj)) { inPart8.add(obj); part8.push(obj); }
      } else {
        priv.push(obj);                       // private to this page
      }
    }
    blocks.push([leaves[p], ...priv]);
  }

  // part 9 = reachable objects not placed anywhere above.
  const placed = new Set<number>([...docLevel]);
  for (const b of blocks) for (const o of b) placed.add(o);
  for (const o of part8) placed.add(o);
  const part9: number[] = [];
  for (let num = 1; num <= n; num++) if (!placed.has(num)) part9.push(num);

  const part4 = [catalogNum, ...internal];
  const sharedTable = [...block0, ...part8];
  const sharedIndex = new Map<number, number>();
  sharedTable.forEach((obj, i) => sharedIndex.set(obj, i));

  const sharedRefs: number[][] = closures.map((c, p) => {
    if (p === 0) return [];                  // first page: forced empty
    const ids: number[] = [];
    for (const obj of c) if (isShared(obj)) ids.push(sharedIndex.get(obj)!);
    return ids.sort((a, b) => a - b);
  });

  return {
    part4, blocks, part8, part9, sharedTable, sharedRefs,
    firstPageObjNum: leaves[0], pageCount: leaves.length,
  };
}

/** The byte values backfilled into the layout once offsets are known. */
interface Resolved {
  objOffset: number[];       // indexed by lin number; [0] unused
  firstPageXrefOffset: number;
  mainXrefOffset: number;    // /T
  hintOffset: number;        // /H[0]
  hintLength: number;        // /H[1]
  firstPageEnd: number;      // /E
  total: number;             // /L
}

/** Serialize the live object map as a linearized ("Fast Web View") PDF.
 *  Classic xref, plaintext, two cross-reference sections, fixed-width
 *  placeholder backfill per ISO 32000-1 Annex F. */
export function serializeLinearized(
  objects: Map<number, PdfObject>, trailer: PdfDict, ver = '1.7',
): Uint8Array {
  const plan = planLocal(objects, trailer);
  const layout = computeLinearLayout(plan);

  // Linearized layout order:
  //   part4 (document-level) then part6 (first page) -> first-page section;
  //   then part7 (per-page groups) ++ part8 (shared) ++ part9 (other).
  const firstPage = [...layout.part4, ...layout.blocks[0]];
  const remainder = [
    ...layout.blocks.slice(1).flat(), ...layout.part8, ...layout.part9,
  ];

  // Lin numbering: first-page section -> 1..K, hint stream -> K+1, lin dict ->
  // K+2, remainder -> K+3..M. Object 0 is the free head; Size = M+1.
  const k = firstPage.length;
  const hintNum = k + 1;
  const linDictNum = k + 2;
  const r = remainder.length;
  const m = k + 2 + r;
  const size = m + 1;

  const planToLin = new Map<number, number>();
  firstPage.forEach((planNum, i) => planToLin.set(planNum, i + 1));
  remainder.forEach((planNum, j) => planToLin.set(planNum, k + 3 + j));

  // Lin-numbered object bodies (no headers), indexed by lin number. The hint
  // stream (hintNum) is built per-pass inside `emit`, since it embeds offsets.
  const body: Uint8Array[] = new Array(m + 1);
  for (let lin = 1; lin <= k; lin++) {
    body[lin] = serializeObject(remap(plan.objs[firstPage[lin - 1] - 1], planToLin));
  }
  for (let j = 0; j < r; j++) {
    body[k + 3 + j] = serializeObject(remap(plan.objs[remainder[j] - 1], planToLin));
  }

  const rootLin = planToLin.get(plan.rootRef.num)!;            // catalog -> 1
  const infoLin = isRef(plan.infoRef) ? planToLin.get(plan.infoRef.num) : undefined;
  const oLin = planToLin.get(layout.firstPageObjNum)!;          // /O first page object
  const idValue = trailer.get('ID');
  const idStr = idValue !== undefined ? ` /ID ${serializeValue(idValue)}` : '';
  const infoStr = infoLin !== undefined ? ` /Info ${infoLin} 0 R` : '';

  // ---- Primary hint stream (ISO 32000-1 Annex F.3) -----------------------
  // Object span (header + body + "endobj") used as the per-object byte length.
  const span = (lin: number): number =>
    enc(`${lin} 0 obj\n`).length + body[lin].length + '\nendobj\n'.length;

  // Per-page block metadata (block 0 = first page). nobjects/length are intrinsic
  // (independent of absolute position); only first_page_offset varies per pass.
  const P = layout.blocks.length;
  const pageFirstLin: number[] = [];
  const pageNobjects: number[] = [];
  const pageLength: number[] = [];
  for (let p = 0; p < P; p++) {
    const lins = layout.blocks[p].map((n) => planToLin.get(n)!);
    pageFirstLin.push(lins[0]);
    pageNobjects.push(lins.length);
    pageLength.push(lins.reduce((s, l) => s + span(l), 0));
  }
  const page0Lin = planToLin.get(layout.firstPageObjNum)!;
  const part8FirstLin = layout.part8.length ? planToLin.get(layout.part8[0])! : 0;

  const minNobjects = Math.min(...pageNobjects);
  const nbDeltaNobjects = nbits(Math.max(...pageNobjects) - minNobjects);
  const minPageLen = Math.min(...pageLength);
  const nbDeltaPageLen = nbits(Math.max(...pageLength) - minPageLen);

  const nsharedPerPage = layout.sharedRefs.map((ids) => ids.length);
  const nbNshared = nbits(Math.max(0, ...nsharedPerPage));

  const sharedLins = layout.sharedTable.map((n) => planToLin.get(n)!);
  const groupLen = sharedLins.map(span);
  const nsharedTotal = sharedLins.length;
  const nsharedFirstPage = layout.blocks[0].length;
  const minGroupLen = groupLen.length ? Math.min(...groupLen) : 0;
  const nbDeltaGroupLen = nbits((groupLen.length ? Math.max(...groupLen) : 0) - minGroupLen);
  const nbSharedId = nbits(nsharedTotal);

  // Build the RAW (uncompressed) hint-table bits for a given pass, plus /S (the
  // shared table's byte offset within the *decompressed* data). Only
  // first_page_offset and first_shared_offset depend on `res`, both via adj();
  // and adj(off) = off - hintLength is invariant under changes to the hint
  // stream's own byte length (off and hintLength shift together). So these bits
  // — hence the deflated length — are stable across the offset backfill, varying
  // only between the zero-offset first pass and the real second pass.
  const buildHintRaw = (res: Resolved): { raw: Uint8Array; S: number } => {
    const w = new BitWriter();
    // Hint-table offsets follow qpdf's convention: they are file offsets as if
    // the primary hint stream had zero length (every object after the hint
    // stream is shifted back by its byte span). Param-dict offsets stay real.
    const adj = (off: number): number => Math.max(0, off - res.hintLength);
    // Page-offset hint table header (13 fields, Annex F.3 Table F.3).
    w.write(minNobjects, 32);
    w.write(adj(res.objOffset[page0Lin]), 32);       // first_page_offset
    w.write(nbDeltaNobjects, 16);
    w.write(minPageLen, 32);
    w.write(nbDeltaPageLen, 16);
    w.write(0, 32);                                  // min_content_offset
    w.write(0, 16);                                  // nbits_delta_content_offset
    w.write(minPageLen, 32);                         // min_content_length (mirrors page)
    w.write(nbDeltaPageLen, 16);                     // nbits_delta_content_length
    w.write(nbNshared, 16);
    w.write(nbSharedId, 16);
    w.write(0, 16);                                  // nbits_shared_numerator
    w.write(4, 16);                                  // shared_denominator
    // Per-page entries are stored COLUMN-major, and qpdf byte-aligns after every
    // column (write_vector_int flushes; the reader skipToNextByte's to match).
    for (let p = 0; p < P; p++) w.write(pageNobjects[p] - minNobjects, nbDeltaNobjects);
    w.align();
    for (let p = 0; p < P; p++) w.write(pageLength[p] - minPageLen, nbDeltaPageLen);
    w.align();
    for (let p = 0; p < P; p++) w.write(nsharedPerPage[p], nbNshared);
    w.align();
    for (let p = 0; p < P; p++) for (const id of layout.sharedRefs[p]) w.write(id, nbSharedId);
    w.align();                                        // shared_identifiers column
    w.align();                                        // shared_numerators column (0 bits)
    w.align();                                        // delta_content_offset column (0 bits)
    for (let p = 0; p < P; p++) w.write(pageLength[p] - minPageLen, nbDeltaPageLen); // delta_content_length
    w.align();
    const S = w.byteLength();                         // shared table offset within data
    // Shared-object hint table header (7 fields, Table F.5).
    w.write(part8FirstLin, 32);                      // first_shared_obj
    w.write(part8FirstLin ? adj(res.objOffset[part8FirstLin]) : 0, 32); // first_shared_offset
    w.write(nsharedFirstPage, 32);
    w.write(nsharedTotal, 32);
    w.write(0, 16);                                  // nbits_nobjects
    w.write(minGroupLen, 32);
    w.write(nbDeltaGroupLen, 16);
    // Per-entry, COLUMN-major with the same per-column byte alignment (Table F.6).
    for (let i = 0; i < nsharedTotal; i++) w.write(groupLen[i] - minGroupLen, nbDeltaGroupLen);
    w.align();
    for (let i = 0; i < nsharedTotal; i++) w.write(0, 1);   // signature_present (no signatures)
    w.align();
    // nobjects_minus_one column: nbits_nobjects == 0, nothing to write.
    w.align();
    return { raw: w.finish(), S };
  };

  const zero: Resolved = {
    objOffset: new Array(m + 1).fill(0),
    firstPageXrefOffset: 0, mainXrefOffset: 0, hintOffset: 0, hintLength: 0,
    firstPageEnd: 0, total: 0,
  };

  // FlateDecode-compress the hint stream unless that would enlarge it (tiny
  // documents). The deflated length depends on the embedded absolute offsets,
  // which shift with the hint stream's own length — but only between the
  // zero-offset and real passes (adj() is otherwise invariant). To keep the
  // object span identical across the two-pass backfill we pad the deflated data
  // to a fixed length `padTo` (qpdf and zlib ignore the trailing bytes on
  // inflate); the outer emit loop grows `padTo` until it covers both passes.
  const probeRaw = buildHintRaw(zero).raw;
  const probeDeflated = deflateSync(probeRaw);
  // Worth compressing only if it beats raw even after the ` /Filter /FlateDecode`
  // dict overhead (~21 bytes).
  const compress = probeDeflated.length + 24 < probeRaw.length;
  let padTo = probeDeflated.length;
  let maxData = 0;

  // Build the hint stream object for a given pass. With compression the data is
  // deflated then zero-padded to `padTo`; uncompressed, the raw bits are emitted
  // verbatim. Either way the object span is fixed within a single emit loop
  // iteration, so the measure/backfill passes stay byte-consistent.
  const buildHint = (res: Resolved): Uint8Array => {
    const { raw, S } = buildHintRaw(res);
    let data: Uint8Array;
    let dict: PdfDict;
    if (compress) {
      const deflated = deflateSync(raw);
      if (deflated.length > maxData) maxData = deflated.length;
      const len = Math.max(padTo, deflated.length);
      data = new Uint8Array(len);
      data.set(deflated);                       // tail stays zero-padded
      dict = new Map<string, PdfObject>([['Filter', name('FlateDecode')], ['S', S], ['Length', len]]);
    } else {
      data = raw;
      dict = new Map<string, PdfObject>([['S', S], ['Length', raw.length]]);
    }
    return serializeObject({ kind: 'stream', dict, raw: data });
  };

  // /T is the offset of the first entry of the main cross-reference table — i.e.
  // just past its "xref\n0 1\n" preamble — not the offset of the xref keyword
  // (which is what the first-page trailer's /Prev points to).
  const T_PREAMBLE = enc('xref\n0 1\n').length;

  // Linearization parameter dictionary body (placeholders for backfilled fields).
  const linDictBody = (res: Resolved): string =>
    `<< /Linearized 1 /L ${fw(res.total)} /H [ ${fw(res.hintOffset)} ${fw(res.hintLength)} ]` +
    ` /O ${oLin} /E ${fw(res.firstPageEnd)} /N ${layout.pageCount}` +
    ` /T ${fw(res.mainXrefOffset + T_PREAMBLE)} >>`;

  // A classic xref entry (used / free).
  const used = (off: number): string => `${fw(off)} 00000 n \n`;
  const FREE = '0000000000 65535 f \n';

  // First-page xref: one subsection covering lin objects 1..(K+2) = first-page
  // objects, hint stream, and the linearization dict.
  const firstPageXref = (res: Resolved): string => {
    let s = `xref\n1 ${k + 2}\n`;
    for (let lin = 1; lin <= k + 2; lin++) s += used(res.objOffset[lin]);
    s += `trailer\n<< /Size ${size} /Root ${rootLin} 0 R${infoStr}${idStr}` +
      ` /Prev ${fw(res.mainXrefOffset)} >>\nstartxref\n0\n%%EOF\n`;
    return s;
  };

  // Main xref: object 0 (free head) plus the remainder range K+3..M.
  const mainXref = (res: Resolved): string => {
    let s = `xref\n0 1\n${FREE}`;
    if (r > 0) {
      s += `${k + 3} ${r}\n`;
      for (let lin = k + 3; lin <= m; lin++) s += used(res.objOffset[lin]);
    }
    s += `trailer\n<< /Size ${size} /Root ${rootLin} 0 R${infoStr}${idStr} >>\n` +
      `startxref\n${fw(res.firstPageXrefOffset)}\n%%EOF\n`;
    return s;
  };

  // Emit the whole file for a given set of resolved values, recording measured
  // offsets. Positions are value-independent (all backfilled fields are
  // fixed-width), so pass 1 measures and pass 2 writes the real values.
  const emit = (res: Resolved): { bytes: Uint8Array; measured: Resolved } => {
    const chunks: Uint8Array[] = [];
    let pos = 0;
    const push = (b: Uint8Array): void => { chunks.push(b); pos += b.length; };
    const measured: Resolved = {
      objOffset: new Array(m + 1).fill(0),
      firstPageXrefOffset: 0, mainXrefOffset: 0, hintOffset: 0, hintLength: 0,
      firstPageEnd: 0, total: 0,
    };
    const pushObj = (lin: number): void => {
      measured.objOffset[lin] = pos;
      push(enc(`${lin} 0 obj\n`));
      push(body[lin]);
      push(enc('\nendobj\n'));
    };

    push(enc(`%PDF-${ver}\n%\xE2\xE3\xCF\xD3\n`));
    measured.objOffset[linDictNum] = pos;     // linearization dict, physically first
    push(enc(`${linDictNum} 0 obj\n`));
    push(enc(linDictBody(res)));
    push(enc('\nendobj\n'));
    measured.firstPageXrefOffset = pos;
    push(enc(firstPageXref(res)));
    body[hintNum] = buildHint(res);            // primary hint stream (embeds offsets)
    pushObj(hintNum);
    measured.hintOffset = measured.objOffset[hintNum];
    measured.hintLength = pos - measured.hintOffset;
    for (let lin = 1; lin <= k; lin++) pushObj(lin);  // first-page objects
    measured.firstPageEnd = pos;               // /E: end of the first page
    for (let lin = k + 3; lin <= m; lin++) pushObj(lin);  // remainder
    measured.mainXrefOffset = pos;
    push(enc(mainXref(res)));
    measured.total = pos;
    return { bytes: concat(chunks), measured };
  };

  // Two-pass measure/backfill, wrapped in an outer loop that sizes the deflated
  // hint stream's zero-padding. With the hint length fixed by `padTo`, all object
  // positions are value-independent, so pass 1 measures and pass 2 backfills. The
  // deflated length is stable across iterations (adj() is offset-shift invariant),
  // so `padTo` reaches a covering value within two iterations; the cap guards
  // against any residual wobble.
  let bytes: Uint8Array;
  for (let iter = 0; ; iter++) {
    maxData = 0;
    const { measured } = emit(zero);           // pass 1: measure
    bytes = emit(measured).bytes;              // pass 2: backfill
    if (!compress || maxData <= padTo || iter >= 8) break;
    padTo = maxData;                           // grow to cover both passes; retry
  }
  return bytes;
}

export interface LinearizationCheck {
  /** True when the input begins with a /Linearized parameter dictionary. */
  linearized: boolean;
  /** Structural problems found; empty for byte-accurate linearized output. */
  errors: string[];
}

/** Re-parse linearized output and check that every offset/length the
 *  linearization dictionary and the two cross-reference sections claim is
 *  byte-accurate. The in-suite stand-in for `qpdf --check`. */
export function verifyLinearization(bytes: Uint8Array): LinearizationCheck {
  const errors: string[] = [];
  const text = new TextDecoder('latin1').decode(bytes);

  // 1. The first object must be a /Linearized parameter dictionary (≤1024 bytes).
  const head = text.slice(0, 1024);
  const firstObj = /\bobj\b([\s\S]*?)\bendobj\b/.exec(head);
  if (firstObj === null || !/\/Linearized\b/.test(firstObj[1])) {
    return { linearized: false, errors: ['no /Linearized parameter dictionary at start'] };
  }
  const dict = firstObj[1];
  const num = (key: string): number | undefined => {
    const m = new RegExp(`/${key}\\s+(\\d+)`).exec(dict);
    return m ? Number(m[1]) : undefined;
  };
  const L = num('L'), O = num('O'), E = num('E'), T = num('T'), N = num('N');
  const hm = /\/H\s*\[\s*(\d+)\s+(\d+)/.exec(dict);
  const hintOff = hm ? Number(hm[1]) : undefined;
  const hintLen = hm ? Number(hm[2]) : undefined;
  for (const [key, v] of Object.entries({ L, O, E, T, N })) {
    if (v === undefined) errors.push(`linearization dict missing /${key}`);
  }
  if (hintOff === undefined) errors.push('linearization dict missing /H');

  // 2. /L equals the byte length.
  if (L !== undefined && L !== bytes.length) {
    errors.push(`/L ${L} != file length ${bytes.length}`);
  }

  // Parse a classic xref section at `at`: returns offsets map + /Prev.
  const objHeaderAt = (off: number): number | undefined => {
    const m = /^(\d+)\s+\d+\s+obj\b/.exec(text.slice(off, off + 40));
    return m ? Number(m[1]) : undefined;
  };
  const parseXref = (at: number, offsets: Map<number, number>): number | undefined => {
    if (text.slice(at, at + 4) !== 'xref') { errors.push(`no xref keyword at ${at}`); return undefined; }
    let i = at + 4;
    while (i < text.length && /\s/.test(text[i])) i++;
    // Subsections until "trailer".
    while (!text.startsWith('trailer', i)) {
      const sub = /^(\d+)\s+(\d+)\s*\n/.exec(text.slice(i, i + 40));
      if (sub === null) { errors.push(`bad xref subsection header at ${i}`); return undefined; }
      let start = Number(sub[1]);
      const count = Number(sub[2]);
      i += sub[0].length;
      for (let e = 0; e < count; e++, start++, i += 20) {
        const row = text.slice(i, i + 20);
        if (row[17] === 'n') offsets.set(start, Number(row.slice(0, 10)));
      }
    }
    const trailerEnd = text.indexOf('>>', i);
    const prev = /\/Prev\s+(\d+)/.exec(text.slice(i, trailerEnd >= 0 ? trailerEnd : i + 400));
    return prev ? Number(prev[1]) : undefined;
  };

  // 3. The final startxref points to the first-page xref; follow /Prev to main.
  const lastSx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  const offsets = new Map<number, number>();
  if (lastSx === null) {
    errors.push('no trailing startxref/%%EOF');
  } else {
    const firstPageXref = Number(lastSx[1]);
    const prev = parseXref(firstPageXref, offsets);
    if (prev === undefined) errors.push('first-page xref has no /Prev to the main xref');
    else {
      // /Prev locates the main "xref" keyword; /T is the offset of that table's
      // first entry (just past "xref\n<first subsection header>\n").
      const head = /^xref\s+\d+\s+\d+\s*\n/.exec(text.slice(prev, prev + 40));
      const expectedT = head ? prev + head[0].length : undefined;
      if (T !== undefined && expectedT !== undefined && T !== expectedT) {
        errors.push(`/T ${T} != main xref first-entry offset ${expectedT}`);
      }
      parseXref(prev, offsets);
    }
  }

  // 4. Every used xref entry must point at the matching object header.
  for (const [n, off] of offsets) {
    if (objHeaderAt(off) !== n) errors.push(`xref entry ${n} -> ${off} is not object ${n}`);
  }
  // 5. /O resolves to a /Page object.
  if (O !== undefined) {
    const off = offsets.get(O);
    if (off === undefined) errors.push(`/O ${O} has no xref entry`);
    else if (!/\/Type\s*\/Page\b/.test(text.slice(off, off + 200))) {
      errors.push(`/O ${O} is not a /Page object`);
    }
  }
  // Locate the hint stream's binary payload by its declared /Length (indexOf on
  // 'endstream'/'endobj' is unreliable: the data — raw bits or deflate output —
  // can contain those byte sequences).
  const hintStreamAt = hintOff !== undefined ? text.indexOf('stream\n', hintOff) : -1;
  const hintDictText = hintStreamAt >= 0 ? text.slice(hintOff, hintStreamAt) : '';
  const hintLenMatch = /\/Length\s+(\d+)/.exec(hintDictText);
  const hintDataStart = hintStreamAt >= 0 ? hintStreamAt + 'stream\n'.length : -1;
  const hintDataLen = hintLenMatch ? Number(hintLenMatch[1]) : -1;
  const hintFlate = /\/Filter\s*\/FlateDecode\b/.test(hintDictText);

  // 6. /H points at a stream object spanning exactly hintLen bytes.
  if (hintOff !== undefined && hintLen !== undefined) {
    if (objHeaderAt(hintOff) === undefined) errors.push(`/H offset ${hintOff} is not an object`);
    const end = hintDataStart >= 0 && hintDataLen >= 0
      ? text.indexOf('endobj', hintDataStart + hintDataLen) : -1;
    const span = end >= 0 ? end + 'endobj\n'.length - hintOff : -1;
    if (span !== hintLen) errors.push(`/H length ${hintLen} != hint object span ${span}`);
    if (hintStreamAt < 0 || hintStreamAt >= hintOff + hintLen) {
      errors.push('/H object is not a stream');
    }
  }
  // 7. /E points at the start of the next object (or the main xref).
  if (E !== undefined) {
    if (E <= 0 || E > bytes.length) errors.push(`/E ${E} out of range`);
    else if (objHeaderAt(E) === undefined && text.slice(E, E + 4) !== 'xref') {
      errors.push(`/E ${E} is not the end of the first page`);
    }
  }

  // 8. Primary hint stream: re-read the page-offset and shared-object tables
  //    and cross-check every value against the file's actual object positions.
  if (hintOff !== undefined && hintLen !== undefined && O !== undefined
      && E !== undefined && N !== undefined) {
    const sMatch = /\/S\s+(\d+)/.exec(hintDictText);
    let data: Uint8Array | undefined;
    if (sMatch === null) {
      errors.push('hint stream dict missing /S');
    } else if (hintDataStart < 0 || hintDataStart >= hintOff + hintLen || hintDataLen < 0) {
      errors.push('hint stream body not found');
    } else {
      data = bytes.subarray(hintDataStart, hintDataStart + hintDataLen);
      if (hintFlate) {
        try {
          data = new Uint8Array(inflateSync(Buffer.from(data)));
        } catch {
          errors.push('hint stream FlateDecode inflate failed');
          data = undefined;
        }
      }
    }
    if (sMatch !== null && data !== undefined) {
      const S = Number(sMatch[1]);

      // Page-offset hint table header (13 fields).
      const r = new BitReader(data);
      const minNobjects = r.read(32);
      const firstPageOffset = r.read(32);
      const nbDeltaNobjects = r.read(16);
      const minPageLen = r.read(32);
      const nbDeltaPageLen = r.read(16);
      r.read(32);                                    // min_content_offset
      const nbDeltaContentOffset = r.read(16);
      r.read(32);                                    // min_content_length
      const nbDeltaContentLen = r.read(16);
      const nbNshared = r.read(16);
      const nbSharedId = r.read(16);
      const nbSharedNum = r.read(16);
      const sharedDenom = r.read(16);
      // Per-page columns, byte-aligned after each (mirrors the writer).
      const col = (width: number): number[] => {
        const a: number[] = [];
        for (let p = 0; p < N; p++) a.push(r.read(width));
        r.align();
        return a;
      };
      const dNobjects = col(nbDeltaNobjects);
      const dPageLen = col(nbDeltaPageLen);
      const nshared = col(nbNshared);
      for (let p = 0; p < N; p++) for (let j = 0; j < nshared[p]; j++) r.read(nbSharedId);
      r.align();
      for (let p = 0; p < N; p++) for (let j = 0; j < nshared[p]; j++) r.read(nbSharedNum);
      r.align();
      col(nbDeltaContentOffset);                     // delta_content_offset (unused)
      const dContentLen = col(nbDeltaContentLen);

      if (sharedDenom === 0) errors.push('hint shared_denominator is 0');
      // The page-offset table must occupy exactly the bytes before /S.
      if (r.position() !== S * 8) {
        errors.push(`hint page-offset table ends at bit ${r.position()} != /S ${S * 8}`);
      }
      // first_page_offset, un-adjusted by the hint length, must locate /O.
      const oOff = offsets.get(O);
      if (firstPageOffset + hintLen !== oOff) {
        errors.push(`hint first_page_offset ${firstPageOffset} (+H=${firstPageOffset + hintLen}) != /O offset ${oOff}`);
      }
      // Page 0 length must span exactly from the first page object to /E.
      if (oOff !== undefined && minPageLen + dPageLen[0] !== E - oOff) {
        errors.push(`hint page-0 length ${minPageLen + dPageLen[0]} != E-firstPage ${E - oOff}`);
      }
      // Each page's accumulated start offset must hold a /Page object, and
      // content length must mirror page length (qpdf convention).
      let start = firstPageOffset + hintLen;
      for (let p = 0; p < N; p++) {
        if (objHeaderAt(start) === undefined
            || !/\/Type\s*\/Page\b/.test(text.slice(start, start + 400))) {
          errors.push(`hint page ${p} start ${start} is not a /Page object`);
        }
        if (minNobjects + dNobjects[p] < 1) errors.push(`hint page ${p} nobjects < 1`);
        if (dContentLen[p] !== dPageLen[p]) errors.push(`hint page ${p} content length != page length`);
        start += minPageLen + dPageLen[p];
      }

      // Shared-object hint table at /S.
      if (S * 8 >= data.length * 8) {
        errors.push(`hint /S ${S} is beyond the hint data`);
      } else {
        const rs = new BitReader(data, S * 8);
        const firstSharedObj = rs.read(32);
        rs.read(32);                                 // first_shared_offset
        const nsharedFirstPage = rs.read(32);
        const nsharedTotal = rs.read(32);
        const nbNobjects = rs.read(16);
        rs.read(32);                                 // min_group_length
        const nbDeltaGroupLen = rs.read(16);
        if (nsharedTotal < nsharedFirstPage) {
          errors.push(`hint nshared_total ${nsharedTotal} < nshared_first_page ${nsharedFirstPage}`);
        }
        for (let i = 0; i < nsharedTotal; i++) rs.read(nbDeltaGroupLen);  // delta_group_length
        rs.align();
        let sigBits = 0;
        for (let i = 0; i < nsharedTotal; i++) sigBits += rs.read(1);     // signature_present
        rs.align();
        for (let i = 0; i < nsharedTotal; i++) rs.read(nbNobjects);       // nobjects_minus_one
        rs.align();
        if (sigBits !== 0) errors.push('hint shared signatures present (unsupported)');
        if (rs.position() > data.length * 8) errors.push('hint shared-object table overruns the stream');
        // A non-empty part-8 region must name a real first shared object.
        if (nsharedTotal > nsharedFirstPage && objHeaderAt(offsets.get(firstSharedObj) ?? -1) === undefined) {
          errors.push(`hint first_shared_obj ${firstSharedObj} has no xref entry`);
        }
      }
    }
  }

  return { linearized: true, errors };
}
