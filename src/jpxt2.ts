// EBCOT Tier-2 — ISO/IEC 15444-1 Annex B. Parses packet headers (bit-stuffed),
// iterates packets in the signalled progression order across layers/resolutions/
// components, and assembles each code-block's coded byte segment for Tier-1.
// Baseline scope: a single tile with a single (maximal) precinct per resolution.

import { Codestream } from './jpx.js';

/** Packet-header bit reader — the OpenJPEG `bio` model. MSB-first with the
 *  JPEG-2000 bit-stuffing rule: after a 0xFF byte the next byte carries 7 bits. */
export class Bio {
  bp: number;
  private buf = 0;
  private ct = 0;
  constructor(private data: Uint8Array, start: number, private end: number) { this.bp = start; }
  private bytein(): void {
    this.buf = (this.buf << 8) & 0xffff;
    this.ct = this.buf === 0xff00 ? 7 : 8;
    if (this.bp >= this.end) this.buf += 0xff;
    else this.buf += this.data[this.bp++];
  }
  getbit(): number {
    if (this.ct === 0) this.bytein();
    this.ct--;
    return (this.buf >> this.ct) & 1;
  }
  read(n: number): number { let v = 0; for (let i = n - 1; i >= 0; i--) v += this.getbit() << i; return v; }
  /** Byte-align at the end of a packet header; `bp` then points at the body. */
  inalign(): void { if ((this.buf & 0xff) === 0xff) this.bytein(); this.ct = 0; }
}

/** Quad tag-tree (Annex B.10.2). Node state (value + final flag) persists across
 *  calls so successive layers continue refining the same bounds. */
export class TagTree {
  private levels: { w: number; h: number; value: Int32Array; final: Uint8Array }[] = [];
  constructor(w: number, h: number) {
    let lw = w, lh = h;
    for (;;) {
      this.levels.push({ w: lw, h: lh, value: new Int32Array(lw * lh), final: new Uint8Array(lw * lh) });
      if (lw === 1 && lh === 1) break;
      lw = Math.ceil(lw / 2); lh = Math.ceil(lh / 2);
    }
  }
  /** Refine leaf (i,j) up to `threshold`; returns its current lower-bound value. */
  decode(bio: Bio, i: number, j: number, threshold: number): number {
    const path: { l: number; x: number; y: number }[] = [];
    let x = j, y = i;
    for (let l = 0; l < this.levels.length; l++) { path.push({ l, x, y }); x >>= 1; y >>= 1; }
    let lower = 0;
    for (let s = path.length - 1; s >= 0; s--) {
      const { l, x: nx, y: ny } = path[s];
      const lvl = this.levels[l];
      const idx = ny * lvl.w + nx;
      if (lvl.value[idx] < lower) lvl.value[idx] = lower;
      while (!lvl.final[idx] && lvl.value[idx] < threshold) {
        if (bio.getbit()) lvl.final[idx] = 1;
        else lvl.value[idx]++;
      }
      lower = lvl.value[idx];
    }
    return lower;
  }
}

export interface CodeBlockCoded {
  x0: number; y0: number; x1: number; y1: number;
  sbType: 'LL' | 'HL' | 'LH' | 'HH';
  segment: Uint8Array;
  passes: number;
  zeroBitPlanes: number;
  lblock: number;
  included: boolean;
  // per-packet scratch:
  _len: number;
}
export interface SubbandCoded { type: 'LL' | 'HL' | 'LH' | 'HH'; x0: number; y0: number; x1: number; y1: number; blocks: CodeBlockCoded[]; cols: number; inclTree: TagTree; zbpTree: TagTree }
export interface ResolutionCoded { level: number; x0: number; y0: number; x1: number; y1: number; subbands: SubbandCoded[] }

function partition(sb: SubbandCoded, cbW: number, cbH: number): void {
  const cols = Math.max(1, Math.ceil((sb.x1 - sb.x0) / cbW));
  const rows = Math.max(1, Math.ceil((sb.y1 - sb.y0) / cbH));
  sb.cols = cols;
  sb.inclTree = new TagTree(cols, rows);
  sb.zbpTree = new TagTree(cols, rows);
  for (let by = sb.y0; by < sb.y1; by += cbH) for (let bx = sb.x0; bx < sb.x1; bx += cbW) {
    sb.blocks.push({ x0: bx, y0: by, x1: Math.min(bx + cbW, sb.x1), y1: Math.min(by + cbH, sb.y1), sbType: sb.type, segment: new Uint8Array(0), passes: 0, zeroBitPlanes: 0, lblock: 3, included: false, _len: 0 });
  }
}

/** Build the resolution/subband/code-block geometry for one component. */
function buildComponent(cs: Codestream): ResolutionCoded[] {
  const cw = cs.xsiz - cs.xosiz, ch = cs.ysiz - cs.yosiz;
  const N = cs.cod.levels;
  const res: ResolutionCoded[] = [];
  for (let r = 0; r <= N; r++) {
    const rw = Math.ceil(cw / (1 << (N - r))), rh = Math.ceil(ch / (1 << (N - r)));
    const mk = (type: SubbandCoded['type'], x1: number, y1: number): SubbandCoded =>
      ({ type, x0: 0, y0: 0, x1, y1, blocks: [], cols: 1, inclTree: new TagTree(1, 1), zbpTree: new TagTree(1, 1) });
    let subbands: SubbandCoded[];
    if (r === 0) {
      subbands = [mk('LL', rw, rh)];
    } else {
      const lw = Math.ceil(rw / 2), hw = Math.floor(rw / 2);
      const lh = Math.ceil(rh / 2), hh = Math.floor(rh / 2);
      subbands = [mk('HL', hw, lh), mk('LH', lw, hh), mk('HH', hw, hh)];
    }
    for (const sb of subbands) partition(sb, cs.cod.cbW, cs.cod.cbH);
    res.push({ level: r, x0: 0, y0: 0, x1: rw, y1: rh, subbands });
  }
  return res;
}

function readPassCount(bio: Bio): number {
  if (bio.getbit() === 0) return 1;
  if (bio.getbit() === 0) return 2;
  const b = bio.read(2);
  if (b < 3) return 3 + b;
  const c = bio.read(5);
  if (c < 31) return 6 + c;
  return 37 + bio.read(7);
}

/** Decode all packets of the tile into per-component resolution geometry with
 *  each code-block's coded segment, total pass count, and zero-bit-planes filled. */
export function decodeTier2(cs: Codestream): ResolutionCoded[][] {
  const nc = cs.comps.length;
  const comps: ResolutionCoded[][] = [];
  for (let c = 0; c < nc; c++) comps.push(buildComponent(cs));

  const tile = cs.tileData;
  let bytePos = 0;
  const nl = cs.cod.layers;
  const nr = cs.cod.levels + 1;

  const readPacket = (res: ResolutionCoded, layer: number): void => {
    const bio = new Bio(tile, bytePos, tile.length);
    const contrib: { cb: CodeBlockCoded; len: number }[] = [];
    if (bio.getbit() === 1) { // non-empty packet
      for (const sb of res.subbands) {
        sb.blocks.forEach((cb, bi) => {
          const col = bi % sb.cols, row = (bi / sb.cols) | 0;
          let include: boolean;
          if (!cb.included) {
            include = sb.inclTree.decode(bio, row, col, layer + 1) <= layer;
            if (include) {
              cb.included = true;
              let t = 1, zbp = 0;
              for (;;) { const v = sb.zbpTree.decode(bio, row, col, t); if (v < t) { zbp = v; break; } t++; if (t > 64) { zbp = v; break; } }
              cb.zeroBitPlanes = zbp;
            }
          } else {
            include = bio.getbit() === 1;
          }
          if (!include) return;
          const passes = readPassCount(bio);
          while (bio.getbit() === 1) cb.lblock++;
          const lenBits = cb.lblock + Math.floor(Math.log2(passes));
          const len = bio.read(lenBits);
          cb.passes += passes;
          contrib.push({ cb, len });
        });
      }
    }
    bio.inalign();
    let body = bio.bp;
    for (const { cb, len } of contrib) {
      const chunk = tile.subarray(body, body + len);
      const merged = new Uint8Array(cb.segment.length + chunk.length);
      merged.set(cb.segment, 0); merged.set(chunk, cb.segment.length);
      cb.segment = merged;
      body += len;
    }
    bytePos = body;
  };

  const emit = (c: number, r: number, l: number) => readPacket(comps[c][r], l);

  switch (cs.cod.progression) {
    case 0: for (let l = 0; l < nl; l++) for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) emit(c, r, l); break; // LRCP
    case 1: for (let r = 0; r < nr; r++) for (let l = 0; l < nl; l++) for (let c = 0; c < nc; c++) emit(c, r, l); break; // RLCP
    case 2: for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) for (let l = 0; l < nl; l++) emit(c, r, l); break; // RPCL (1 precinct)
    case 3: for (let c = 0; c < nc; c++) for (let r = 0; r < nr; r++) for (let l = 0; l < nl; l++) emit(c, r, l); break; // PCRL (1 precinct)
    case 4: for (let c = 0; c < nc; c++) for (let r = 0; r < nr; r++) for (let l = 0; l < nl; l++) emit(c, r, l); break; // CPRL
  }
  return comps;
}
