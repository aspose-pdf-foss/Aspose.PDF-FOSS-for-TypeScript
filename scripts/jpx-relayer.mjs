// OFFLINE, dev-only. Re-layers a single-quality-layer JPEG 2000 codestream into an
// N-layer one by redistributing each code-block's already-coded passes and bytes
// across N packets. NOT a runtime dependency — nothing in src/ imports this.
//
// The layer boundaries are ARBITRARY, not rate-distortion-optimal: a transcoder
// cannot know where pass boundaries fall inside an MQ codeword segment. That is
// sound for a fully-decoded stream — total passes and total bytes are preserved,
// so decoding every layer is bit-identical to the source — but it means a
// TRUNCATED prefix of the output decodes to noise, not to a coarser image.
// Assert nothing about intermediate layers.
//
// The bit writer, tag-tree encoder and pass-count coder below are the exact
// inverses of Bio, TagTree and readPassCount in src/jpxt2.ts.

/** Packet-header bit writer — MSB-first with JPEG-2000 0xFF bit-stuffing.
 *  Inverse of Bio (src/jpxt2.ts:10). */
export class BioWriter {
  constructor() { this.bytes = []; this.buf = 0; this.ct = 8; }
  byteout() {
    this.buf = (this.buf << 8) & 0xffff;
    this.ct = this.buf === 0xff00 ? 7 : 8;
    this.bytes.push((this.buf >> 8) & 0xff);
  }
  putbit(b) {
    if (this.ct === 0) this.byteout();
    this.ct--;
    this.buf |= b << this.ct;
  }
  write(v, n) { for (let i = n - 1; i >= 0; i--) this.putbit((v >> i) & 1); }
  /** Byte-align and return the header bytes. Mirrors Bio.inalign(). */
  flush() {
    this.byteout();
    if (this.ct === 7) this.byteout(); // emit the stuffing byte after an 0xFF
    return Uint8Array.from(this.bytes);
  }
}

/** Pass-count coder — inverse of readPassCount (src/jpxt2.ts:112). */
export function writePassCount(bw, n) {
  if (n === 1) { bw.putbit(0); return; }
  bw.putbit(1);
  if (n === 2) { bw.putbit(0); return; }
  bw.putbit(1);
  if (n <= 5) { bw.write(n - 3, 2); return; }
  bw.write(3, 2);
  if (n <= 36) { bw.write(n - 6, 5); return; }
  bw.write(31, 5);
  bw.write(n - 37, 7);
}

/** Quad tag-tree encoder — inverse of TagTree (src/jpxt2.ts:33).
 *  Set every leaf, call build() to derive internal nodes, then encode() leaves
 *  at rising thresholds. Node state persists across calls, as on the decode side. */
export class TagTreeEnc {
  constructor(w, h) {
    this.levels = [];
    let lw = w, lh = h;
    for (;;) {
      this.levels.push({
        w: lw, h: lh,
        value: new Int32Array(lw * lh),
        low: new Int32Array(lw * lh),
        known: new Uint8Array(lw * lh),
      });
      if (lw === 1 && lh === 1) break;
      lw = Math.ceil(lw / 2); lh = Math.ceil(lh / 2);
    }
  }
  setLeaf(i, j, v) { const l0 = this.levels[0]; l0.value[i * l0.w + j] = v; }
  /** Internal node value = min over its children (the tag-tree invariant). */
  build() {
    for (let l = 1; l < this.levels.length; l++) {
      const p = this.levels[l], c = this.levels[l - 1];
      p.value.fill(0x7fffffff);
      for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
        const pi = (y >> 1) * p.w + (x >> 1);
        if (c.value[y * c.w + x] < p.value[pi]) p.value[pi] = c.value[y * c.w + x];
      }
    }
  }
  encode(bw, i, j, threshold) {
    const path = [];
    let x = j, y = i;
    for (let l = 0; l < this.levels.length; l++) { path.push({ l, x, y }); x >>= 1; y >>= 1; }
    let low = 0;
    for (let s = path.length - 1; s >= 0; s--) {
      const { l, x: nx, y: ny } = path[s];
      const lvl = this.levels[l];
      const idx = ny * lvl.w + nx;
      if (low > lvl.low[idx]) lvl.low[idx] = low; else low = lvl.low[idx];
      while (low < threshold) {
        if (low >= lvl.value[idx]) {
          if (!lvl.known[idx]) { bw.putbit(1); lvl.known[idx] = 1; }
          break;
        }
        bw.putbit(0);
        low++;
      }
      lvl.low[idx] = low;
    }
  }
}

// ---------- codestream parse ----------

const u16 = (b, p) => (b[p] << 8) | b[p + 1];
const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

function concat(arrs) {
  let total = 0; for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/** Walk the main header. Mirrors parseCodestream (src/jpx.ts:55) but keeps the
 *  marker byte offsets, which the rewrite stage needs. */
function parseHeader(buf) {
  if (!(buf.length >= 2 && buf[0] === 0xff && buf[1] === 0x4f)) throw new Error('relayer: missing SOC marker (pass a bare codestream, not a JP2 box)');
  let p = 2, codPos = -1, sotPos = -1, sodEnd = -1, psot = 0;
  let siz = null, cod = null, tileData = null;
  while (p + 2 <= buf.length) {
    const markerPos = p;
    const m = u16(buf, p); p += 2;
    if (m === 0xffd9) break; // EOC
    if (m === 0xff93) { // SOD
      sodEnd = p;
      let end = buf.length;
      if (psot > 0 && sotPos >= 0) end = Math.min(buf.length, sotPos + psot);
      else { for (let i = p; i + 1 < buf.length; i++) if (buf[i] === 0xff && buf[i + 1] === 0xd9) { end = i; break; } }
      tileData = buf.subarray(p, end);
      break;
    }
    if (p + 2 > buf.length) break;
    const len = u16(buf, p);
    const seg = buf.subarray(p + 2, p + len);
    p += len;
    if (m === 0xff51) { // SIZ
      siz = { xsiz: u32(seg, 2), ysiz: u32(seg, 6), xosiz: u32(seg, 10), yosiz: u32(seg, 14), comps: u16(seg, 34) };
    } else if (m === 0xff52) { // COD
      codPos = markerPos;
      // Scod bit 0 = custom precincts, bit 1 = SOP, bit 2 = EPH. All three would
      // change the packet layout this transcoder rewrites.
      if (seg[0] & 0x07) throw new Error('relayer: precinct partitions / SOP / EPH unsupported');
      cod = { progression: seg[1], layers: u16(seg, 2), levels: seg[5], cbW: 1 << (seg[6] + 2), cbH: 1 << (seg[7] + 2) };
    } else if (m === 0xff90) { // SOT
      sotPos = markerPos; psot = u32(seg, 2);
    }
  }
  if (!siz || !cod || !tileData) throw new Error('relayer: missing SIZ/COD/tile data');
  if (sotPos < 0 || sodEnd < 0) throw new Error('relayer: missing SOT/SOD');
  return { siz, cod, tileData, codPos, sotPos, sodEnd };
}

/** Resolution/subband/code-block geometry. Mirrors buildComponent (src/jpxt2.ts:90). */
function buildComponent(siz, cod) {
  const cw = siz.xsiz - siz.xosiz, ch = siz.ysiz - siz.yosiz;
  const N = cod.levels;
  const res = [];
  for (let r = 0; r <= N; r++) {
    const rw = Math.ceil(cw / (1 << (N - r))), rh = Math.ceil(ch / (1 << (N - r)));
    const mk = (type, x1, y1) => ({ type, x1, y1, blocks: [], cols: 1, rows: 1 });
    let subbands;
    if (r === 0) subbands = [mk('LL', rw, rh)];
    else {
      const lw = Math.ceil(rw / 2), hw = Math.floor(rw / 2);
      const lh = Math.ceil(rh / 2), hh = Math.floor(rh / 2);
      subbands = [mk('HL', hw, lh), mk('LH', lw, hh), mk('HH', hw, hh)];
    }
    for (const sb of subbands) {
      sb.cols = Math.max(1, Math.ceil(sb.x1 / cod.cbW));
      sb.rows = Math.max(1, Math.ceil(sb.y1 / cod.cbH));
      for (let by = 0; by < sb.y1; by += cod.cbH) for (let bx = 0; bx < sb.x1; bx += cod.cbW) {
        sb.blocks.push({ segment: new Uint8Array(0), passes: 0, zeroBitPlanes: 0, lblock: 3, included: false });
      }
    }
    res.push({ subbands });
  }
  return res;
}

/** Packet iteration order. Mirrors the switch at src/jpxt2.ts:177. */
function forEachPacket(cod, nc, nr, nl, fn) {
  switch (cod.progression) {
    case 0: for (let l = 0; l < nl; l++) for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) fn(c, r, l); break; // LRCP
    case 1: for (let r = 0; r < nr; r++) for (let l = 0; l < nl; l++) for (let c = 0; c < nc; c++) fn(c, r, l); break; // RLCP
    case 2: for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) for (let l = 0; l < nl; l++) fn(c, r, l); break; // RPCL
    case 3: case 4: for (let c = 0; c < nc; c++) for (let r = 0; r < nr; r++) for (let l = 0; l < nl; l++) fn(c, r, l); break; // PCRL, CPRL
    default: throw new Error('relayer: unknown progression order ' + cod.progression);
  }
}

function readPassCount(bio) {
  if (bio.getbit() === 0) return 1;
  if (bio.getbit() === 0) return 2;
  const b = bio.read(2);
  if (b < 3) return 3 + b;
  const c = bio.read(5);
  if (c < 31) return 6 + c;
  return 37 + bio.read(7);
}

/** Parse every packet, recovering each code-block's total passes, zero bit-planes
 *  and coded segment. Mirrors readPacket (src/jpxt2.ts:134). */
function parseTier2(siz, cod, tile, Bio, TagTree) {
  const nc = siz.comps, nr = cod.levels + 1;
  const comps = [];
  for (let c = 0; c < nc; c++) {
    const comp = buildComponent(siz, cod);
    for (const res of comp) for (const sb of res.subbands) {
      sb.inclTree = new TagTree(sb.cols, sb.rows);
      sb.zbpTree = new TagTree(sb.cols, sb.rows);
    }
    comps.push(comp);
  }
  let bytePos = 0;
  const readPacket = (res, layer) => {
    const bio = new Bio(tile, bytePos, tile.length);
    const contrib = [];
    if (bio.getbit() === 1) {
      for (const sb of res.subbands) {
        sb.blocks.forEach((cb, bi) => {
          const col = bi % sb.cols, row = (bi / sb.cols) | 0;
          let include;
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
          const len = bio.read(cb.lblock + Math.floor(Math.log2(passes)));
          cb.passes += passes;
          contrib.push({ cb, len });
        });
      }
    }
    bio.inalign();
    let body = bio.bp;
    for (const { cb, len } of contrib) {
      const chunk = tile.subarray(body, body + len);
      cb.segment = concat([cb.segment, chunk]);
      body += len;
    }
    bytePos = body;
  };
  forEachPacket(cod, nc, nr, cod.layers, (c, r, l) => readPacket(comps[c][r], l));
  return comps;
}

// ---------- re-layer ----------

/** Spread a code-block's passes and bytes over nLayers.
 *  Every contributing layer gets at least one pass AND at least one byte, so no
 *  packet ever signals a zero-length contribution. The cut points are arbitrary
 *  (see the file header); only the reassembled total carries meaning. */
function splitBlock(cb, nLayers) {
  const P = cb.passes, S = cb.segment.length;
  const plan = [];
  for (let i = 0; i < nLayers; i++) plan.push({ passes: 0, bytes: new Uint8Array(0) });
  if (P === 0 || S === 0) return plan;
  const L = Math.min(nLayers, P, S);
  const basePass = Math.floor(P / L), remPass = P % L;
  const baseByte = Math.floor(S / L), remByte = S % L;
  let off = 0;
  for (let i = 0; i < L; i++) {
    const nb = baseByte + (i < remByte ? 1 : 0);
    plan[i] = { passes: basePass + (i < remPass ? 1 : 0), bytes: cb.segment.subarray(off, off + nb) };
    off += nb;
  }
  return plan;
}

/** Re-emit every packet, now over nLayers. Inverse of parseTier2. */
function emitTier2(siz, cod, comps, nLayers) {
  const nc = siz.comps, nr = cod.levels + 1;
  for (const comp of comps) for (const res of comp) for (const sb of res.subbands) {
    sb.incEnc = new TagTreeEnc(sb.cols, sb.rows);
    sb.zbpEnc = new TagTreeEnc(sb.cols, sb.rows);
    sb.blocks.forEach((cb, bi) => {
      cb.plan = splitBlock(cb, nLayers);
      let first = cb.plan.findIndex((p) => p.passes > 0);
      if (first < 0) first = nLayers; // never included: value >= nLayers
      cb.encIncluded = false;
      cb.encLblock = 3;
      const row = (bi / sb.cols) | 0, col = bi % sb.cols;
      sb.incEnc.setLeaf(row, col, first);
      sb.zbpEnc.setLeaf(row, col, cb.zeroBitPlanes);
    });
    sb.incEnc.build();
    sb.zbpEnc.build();
  }

  const out = [];
  const writePacket = (res, layer) => {
    let any = false;
    for (const sb of res.subbands) for (const cb of sb.blocks) if (cb.plan[layer].passes > 0) { any = true; break; }
    const bw = new BioWriter();
    if (!any) { bw.putbit(0); out.push(bw.flush()); return; }
    bw.putbit(1);
    const bodies = [];
    for (const sb of res.subbands) {
      sb.blocks.forEach((cb, bi) => {
        const row = (bi / sb.cols) | 0, col = bi % sb.cols;
        const part = cb.plan[layer];
        if (!cb.encIncluded) {
          sb.incEnc.encode(bw, row, col, layer + 1);
          if (part.passes === 0) return;
          cb.encIncluded = true;
          for (let t = 1; t <= cb.zeroBitPlanes + 1; t++) sb.zbpEnc.encode(bw, row, col, t);
        } else {
          bw.putbit(part.passes > 0 ? 1 : 0);
          if (part.passes === 0) return;
        }
        writePassCount(bw, part.passes);
        const len = part.bytes.length;
        const extra = Math.floor(Math.log2(part.passes));
        const need = len === 0 ? 1 : Math.floor(Math.log2(len)) + 1;
        let k = 0;
        while (cb.encLblock + k + extra < need) k++;
        for (let i = 0; i < k; i++) bw.putbit(1); // lblock growth
        bw.putbit(0);
        cb.encLblock += k;
        bw.write(len, cb.encLblock + extra);
        bodies.push(part.bytes);
      });
    }
    out.push(bw.flush(), ...bodies);
  };
  forEachPacket(cod, nc, nr, nLayers, (c, r, l) => writePacket(comps[c][r], l));
  return concat(out);
}

/** Re-layer a bare single-layer J2K codestream into an nLayers one.
 *  Bio and TagTree are injected so this file stays free of src/ imports. */
export function relayerWith(j2k, nLayers, Bio, TagTree) {
  if (!Number.isInteger(nLayers) || nLayers < 2) throw new Error('relayer: nLayers must be an integer >= 2');
  const h = parseHeader(j2k);
  if (h.cod.layers !== 1) throw new Error('relayer: source already has ' + h.cod.layers + ' layers');
  const comps = parseTier2(h.siz, h.cod, h.tileData, Bio, TagTree);
  const tile = emitTier2(h.siz, h.cod, comps, nLayers);

  const head = j2k.slice(0, h.sodEnd); // SOC .. SOD marker inclusive (a copy)
  head[h.codPos + 6] = (nLayers >>> 8) & 0xff; // COD SGcod layer count (u16)
  head[h.codPos + 7] = nLayers & 0xff;
  const psot = (h.sodEnd - h.sotPos) + tile.length; // SOT marker .. end of tile-part
  head[h.sotPos + 6] = (psot >>> 24) & 0xff;
  head[h.sotPos + 7] = (psot >>> 16) & 0xff;
  head[h.sotPos + 8] = (psot >>> 8) & 0xff;
  head[h.sotPos + 9] = psot & 0xff;
  return concat([head, tile, Uint8Array.from([0xff, 0xd9])]);
}

/** Bio reader — a copy of src/jpxt2.ts:10, so scripts/ stays standalone. */
class BioReader {
  constructor(data, start, end) { this.data = data; this.bp = start; this.end = end; this.buf = 0; this.ct = 0; }
  bytein() {
    this.buf = (this.buf << 8) & 0xffff;
    this.ct = this.buf === 0xff00 ? 7 : 8;
    if (this.bp >= this.end) this.buf += 0xff;
    else this.buf += this.data[this.bp++];
  }
  getbit() { if (this.ct === 0) this.bytein(); this.ct--; return (this.buf >> this.ct) & 1; }
  read(n) { let v = 0; for (let i = n - 1; i >= 0; i--) v += this.getbit() << i; return v; }
  inalign() { if ((this.buf & 0xff) === 0xff) this.bytein(); this.ct = 0; }
}

/** Tag-tree decoder — a copy of src/jpxt2.ts:33. */
class TagTreeDec {
  constructor(w, h) {
    this.levels = [];
    let lw = w, lh = h;
    for (;;) {
      this.levels.push({ w: lw, h: lh, value: new Int32Array(lw * lh), final: new Uint8Array(lw * lh) });
      if (lw === 1 && lh === 1) break;
      lw = Math.ceil(lw / 2); lh = Math.ceil(lh / 2);
    }
  }
  decode(bio, i, j, threshold) {
    const path = [];
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

export function relayer(j2k, nLayers) { return relayerWith(j2k, nLayers, BioReader, TagTreeDec); }
