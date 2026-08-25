// Dev-only JBIG2 codec (encoder + reference decoder) shared by the fixture
// minting scripts. NOT shipped, NOT imported by src/ or tests. The encoder is
// the counterpart of src/jpxmq.ts + src/jbig2*.ts; every minting script
// round-trips its output through the decoder here before writing fixtures.

export const QE = [
  { qe: 0x5601, nmps: 1, nlps: 1, sw: 1 }, { qe: 0x3401, nmps: 2, nlps: 6, sw: 0 },
  { qe: 0x1801, nmps: 3, nlps: 9, sw: 0 }, { qe: 0x0ac1, nmps: 4, nlps: 12, sw: 0 },
  { qe: 0x0521, nmps: 5, nlps: 29, sw: 0 }, { qe: 0x0221, nmps: 38, nlps: 33, sw: 0 },
  { qe: 0x5601, nmps: 7, nlps: 6, sw: 1 }, { qe: 0x5401, nmps: 8, nlps: 14, sw: 0 },
  { qe: 0x4801, nmps: 9, nlps: 14, sw: 0 }, { qe: 0x3801, nmps: 10, nlps: 14, sw: 0 },
  { qe: 0x3001, nmps: 11, nlps: 17, sw: 0 }, { qe: 0x2401, nmps: 12, nlps: 18, sw: 0 },
  { qe: 0x1c01, nmps: 13, nlps: 20, sw: 0 }, { qe: 0x1601, nmps: 29, nlps: 21, sw: 0 },
  { qe: 0x5601, nmps: 15, nlps: 14, sw: 1 }, { qe: 0x5401, nmps: 16, nlps: 14, sw: 0 },
  { qe: 0x5101, nmps: 17, nlps: 15, sw: 0 }, { qe: 0x4801, nmps: 18, nlps: 16, sw: 0 },
  { qe: 0x3801, nmps: 19, nlps: 17, sw: 0 }, { qe: 0x3401, nmps: 20, nlps: 18, sw: 0 },
  { qe: 0x3001, nmps: 21, nlps: 19, sw: 0 }, { qe: 0x2801, nmps: 22, nlps: 19, sw: 0 },
  { qe: 0x2401, nmps: 23, nlps: 20, sw: 0 }, { qe: 0x2201, nmps: 24, nlps: 21, sw: 0 },
  { qe: 0x1c01, nmps: 25, nlps: 22, sw: 0 }, { qe: 0x1801, nmps: 26, nlps: 23, sw: 0 },
  { qe: 0x1601, nmps: 27, nlps: 24, sw: 0 }, { qe: 0x1401, nmps: 28, nlps: 25, sw: 0 },
  { qe: 0x1201, nmps: 29, nlps: 26, sw: 0 }, { qe: 0x1101, nmps: 30, nlps: 27, sw: 0 },
  { qe: 0x0ac1, nmps: 31, nlps: 28, sw: 0 }, { qe: 0x09c1, nmps: 32, nlps: 29, sw: 0 },
  { qe: 0x08a1, nmps: 33, nlps: 30, sw: 0 }, { qe: 0x0521, nmps: 34, nlps: 31, sw: 0 },
  { qe: 0x0441, nmps: 35, nlps: 32, sw: 0 }, { qe: 0x02a1, nmps: 36, nlps: 33, sw: 0 },
  { qe: 0x0221, nmps: 37, nlps: 34, sw: 0 }, { qe: 0x0141, nmps: 38, nlps: 35, sw: 0 },
  { qe: 0x0111, nmps: 39, nlps: 36, sw: 0 }, { qe: 0x0085, nmps: 40, nlps: 37, sw: 0 },
  { qe: 0x0049, nmps: 41, nlps: 38, sw: 0 }, { qe: 0x0025, nmps: 42, nlps: 39, sw: 0 },
  { qe: 0x0015, nmps: 43, nlps: 40, sw: 0 }, { qe: 0x0009, nmps: 44, nlps: 41, sw: 0 },
  { qe: 0x0005, nmps: 45, nlps: 42, sw: 0 }, { qe: 0x0001, nmps: 45, nlps: 43, sw: 0 },
  { qe: 0x5601, nmps: 46, nlps: 46, sw: 0 },
];

export class MqEncoder {
  constructor() { this.out = []; this.dummy = 0; this.a = 0x8000; this.c = 0; this.ct = 12; this.bp = -1; }
  _getB() { return this.bp < 0 ? this.dummy : this.out[this.bp]; }
  _setB(v) { if (this.bp < 0) this.dummy = v & 0xff; else this.out[this.bp] = v & 0xff; }
  _incB() { if (this.bp < 0) this.dummy = (this.dummy + 1) & 0xff; else this.out[this.bp] = (this.out[this.bp] + 1) & 0xff; }
  byteout() {
    if (this._getB() === 0xff) {
      this.bp++; this._setB((this.c >>> 20) & 0xff); this.c &= 0xfffff; this.ct = 7;
    } else if ((this.c & 0x8000000) === 0) {
      this.bp++; this._setB((this.c >>> 19) & 0xff); this.c &= 0x7ffff; this.ct = 8;
    } else {
      this._incB();
      if (this._getB() === 0xff) {
        this.c &= 0x7ffffff; this.bp++; this._setB((this.c >>> 20) & 0xff); this.c &= 0xfffff; this.ct = 7;
      } else {
        this.bp++; this._setB((this.c >>> 19) & 0xff); this.c &= 0x7ffff; this.ct = 8;
      }
    }
  }
  renorme() {
    do {
      if (this.ct === 0) this.byteout();
      this.a = (this.a << 1) & 0xffff; this.c = (this.c << 1) >>> 0; this.ct--;
    } while ((this.a & 0x8000) === 0);
  }
  encode(cx, i, d) {
    let state = cx[i] >> 1, mps = cx[i] & 1;
    const q = QE[state];
    if (mps === d) {
      this.a -= q.qe;
      if ((this.a & 0x8000) === 0) {
        if (this.a < q.qe) this.a = q.qe; else this.c = (this.c + q.qe) >>> 0;
        state = q.nmps; this.renorme();
      } else { this.c = (this.c + q.qe) >>> 0; }
    } else {
      this.a -= q.qe;
      if (this.a < q.qe) this.c = (this.c + q.qe) >>> 0; else this.a = q.qe;
      if (q.sw) mps = 1 - mps;
      state = q.nlps; this.renorme();
    }
    cx[i] = (state << 1) | mps;
  }
  setbits() {
    const tempc = (this.c + this.a) >>> 0;
    this.c = (this.c | 0xffff) >>> 0;
    if (this.c >>> 0 >= tempc) this.c = (this.c - 0x8000) >>> 0;
  }
  flush() {
    this.setbits();
    this.c = (this.c << this.ct) >>> 0; this.byteout();
    this.c = (this.c << this.ct) >>> 0; this.byteout();
    if (this._getB() !== 0xff) this.bp++;
    return Uint8Array.from(this.out.slice(0, Math.max(0, this.bp)));
  }
}

export class MqDecoder {
  constructor(data, start, end) {
    this.data = data; this.bp = start; this.end = end; this.c = 0; this.a = 0; this.ct = 0;
    const b0 = this.bp < this.end ? this.data[this.bp] : 0xff;
    this.c = b0 << 16; this.byteIn(); this.c = (this.c << 7) >>> 0; this.ct -= 7; this.a = 0x8000;
  }
  byteIn() {
    const cur = this.bp < this.end ? this.data[this.bp] : 0xff;
    if (cur === 0xff) {
      const b1 = this.bp + 1 < this.end ? this.data[this.bp + 1] : 0xff;
      if (b1 > 0x8f) { this.c += 0xff00; this.ct = 8; }
      else { this.bp++; this.c += b1 << 9; this.ct = 7; }
    } else { this.bp++; const b = this.bp < this.end ? this.data[this.bp] : 0xff; this.c += b << 8; this.ct = 8; }
  }
  renormd() {
    do { if (this.ct === 0) this.byteIn(); this.a = (this.a << 1) & 0xffffffff; this.c = (this.c << 1) >>> 0; this.ct--; } while ((this.a & 0x8000) === 0);
  }
  decode(cx, i) {
    let state = cx[i] >> 1, mps = cx[i] & 1;
    const q = QE[state]; const qe = q.qe; this.a -= qe; let d;
    if (((this.c >>> 16) & 0xffff) < qe) {
      if (this.a < qe) { d = mps; state = q.nmps; } else { d = 1 - mps; if (q.sw === 1) mps = 1 - mps; state = q.nlps; }
      this.a = qe; this.renormd();
    } else {
      this.c = (this.c - (qe << 16)) >>> 0;
      if ((this.a & 0x8000) === 0) {
        if (this.a < qe) { d = 1 - mps; if (q.sw === 1) mps = 1 - mps; state = q.nlps; } else { d = mps; state = q.nmps; }
        this.renormd();
      } else { d = mps; }
    }
    cx[i] = (state << 1) | mps; return d;
  }
}

// ---- Integer (IAx) + IAID ----------------------------------------------------
export function encodeInt(enc, cx, value) {
  let prev = 1;
  const bit = (d) => { enc.encode(cx, prev, d); prev = prev < 256 ? (prev << 1) | d : ((((prev << 1) | d) & 511) | 256); };
  let s, v;
  if (value === null) { s = 1; v = 0; } else if (value < 0) { s = 1; v = -value; } else { s = 0; v = value; }
  bit(s);
  let n, offset;
  if (v <= 3) { bit(0); n = 2; offset = 0; }
  else if (v <= 19) { bit(1); bit(0); n = 4; offset = 4; }
  else if (v <= 83) { bit(1); bit(1); bit(0); n = 6; offset = 20; }
  else if (v <= 339) { bit(1); bit(1); bit(1); bit(0); n = 8; offset = 84; }
  else if (v <= 4435) { bit(1); bit(1); bit(1); bit(1); bit(0); n = 12; offset = 340; }
  else { bit(1); bit(1); bit(1); bit(1); bit(1); n = 16; offset = 4436; }
  const mag = v - offset;
  for (let i = n - 1; i >= 0; i--) bit((mag >> i) & 1);
}
export function decodeInt(dec, cx) {
  let prev = 1;
  const bit = () => { const d = dec.decode(cx, prev); prev = prev < 256 ? (prev << 1) | d : ((((prev << 1) | d) & 511) | 256); return d; };
  const s = bit();
  let n, offset;
  if (!bit()) { n = 2; offset = 0; } else if (!bit()) { n = 4; offset = 4; }
  else if (!bit()) { n = 6; offset = 20; } else if (!bit()) { n = 8; offset = 84; }
  else if (!bit()) { n = 12; offset = 340; } else { n = 16; offset = 4436; }
  let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bit();
  v = (v >>> 0) + offset;
  if (s === 0) return v; if (v > 0) return -v; return null;
}
export function encodeIaid(enc, cx, symCodeLen, value) {
  let prev = 1;
  for (let i = symCodeLen - 1; i >= 0; i--) { const d = (value >> i) & 1; enc.encode(cx, prev, d); prev = (prev << 1) | d; }
}
export function decodeIaid(dec, cx, symCodeLen) {
  let prev = 1;
  for (let i = 0; i < symCodeLen; i++) { const d = dec.decode(cx, prev); prev = (prev << 1) | d; }
  return prev - (1 << symCodeLen);
}

// ---- Generic region (arithmetic) ---------------------------------------------
export const CODING_TEMPLATES = [
  [[-1,-2],[0,-2],[1,-2],[-2,-1],[-1,-1],[0,-1],[1,-1],[2,-1],[-4,0],[-3,0],[-2,0],[-1,0]],
  [[-1,-2],[0,-2],[1,-2],[2,-2],[-2,-1],[-1,-1],[0,-1],[1,-1],[2,-1],[-3,0],[-2,0],[-1,0]],
  [[-1,-2],[0,-2],[1,-2],[-2,-1],[-1,-1],[0,-1],[1,-1],[-2,0],[-1,0]],
  [[-3,-1],[-2,-1],[-1,-1],[0,-1],[1,-1],[-4,0],[-3,0],[-2,0],[-1,0]],
];
export const REUSED_CONTEXTS = [0x9b25, 0x0795, 0x00e5, 0x0195];
export function buildTemplate(template, at) {
  const t = CODING_TEMPLATES[template].map((p) => [p[0], p[1]]).concat(at.map((a) => [a.x, a.y]));
  t.sort((p, q) => (p[1] - q[1]) || (p[0] - q[0]));
  return t;
}
const gpx = (bm, w, h, x, y) => (x < 0 || x >= w || y < 0 || y >= h) ? 0 : bm[y * w + x];

/** `skip`, when given, is a w*h Uint8Array: a set cell is neither encoded nor
 *  decoded and reads back as 0 (T.88 6.6.5.1, HENABLESKIP). Mirrors
 *  src/jbig2generic.ts — the pixel consumes no arithmetic decision at all, so
 *  encoder and decoder must agree cell for cell or the stream desynchronises. */
export function encodeGeneric(enc, cx, bm, w, h, template, at, tpgdon, skip) {
  const tpl = buildTemplate(template, at);
  let ltp = 0;
  for (let y = 0; y < h; y++) {
    if (tpgdon) {
      let same = y > 0;
      if (same) for (let x = 0; x < w; x++) if (bm[y * w + x] !== bm[(y - 1) * w + x]) { same = false; break; }
      enc.encode(cx, REUSED_CONTEXTS[template], ltp ^ (same ? 1 : 0));
      ltp = same ? 1 : 0;
      if (ltp) continue;
    }
    for (let x = 0; x < w; x++) {
      if (skip && skip[y * w + x]) continue;
      let ctx = 0;
      for (const [dx, dy] of tpl) ctx = (ctx << 1) | gpx(bm, w, h, x + dx, y + dy);
      enc.encode(cx, ctx, bm[y * w + x]);
    }
  }
}
export function decodeGeneric(dec, cx, w, h, template, at, tpgdon, skip) {
  const bm = new Uint8Array(w * h);
  const tpl = buildTemplate(template, at);
  let ltp = 0;
  for (let y = 0; y < h; y++) {
    if (tpgdon) {
      ltp ^= dec.decode(cx, REUSED_CONTEXTS[template]);
      if (ltp) { if (y > 0) bm.copyWithin(y * w, (y - 1) * w, y * w); continue; }
    }
    for (let x = 0; x < w; x++) {
      if (skip && skip[y * w + x]) continue;
      let ctx = 0;
      for (const [dx, dy] of tpl) ctx = (ctx << 1) | gpx(bm, w, h, x + dx, y + dy);
      bm[y * w + x] = dec.decode(cx, ctx);
    }
  }
  return bm;
}

// ---- Generic refinement region (arithmetic) ----------------------------------
// Mirrors src/jbig2refine.ts. AT pixels are APPENDED, never sorted in.
export const REFINE_CODING = [
  [[0, -1], [1, -1], [-1, 0]],
  [[-1, -1], [0, -1], [1, -1], [-1, 0]],
];
export const REFINE_REFERENCE = [
  [[0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
  [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1], [1, 1]],
];
export const REFINE_REUSED_CONTEXTS = [0x0020, 0x0008];

export function refineTemplate(template, at) {
  const t = template === 0 ? 0 : 1;
  const coding = REFINE_CODING[t].map((p) => [p[0], p[1]]);
  const reference = REFINE_REFERENCE[t].map((p) => [p[0], p[1]]);
  if (t === 0) {
    coding.push([at[0].x, at[0].y]);
    reference.push([at[1].x, at[1].y]);
  }
  return { coding, reference };
}
function refineCtx(bm, w, h, ref, rw, rh, tpl, x, y, dx, dy) {
  let ctx = 0;
  for (const [ox, oy] of tpl.coding) ctx = (ctx << 1) | gpx(bm, w, h, x + ox, y + oy);
  for (const [ox, oy] of tpl.reference) ctx = (ctx << 1) | gpx(ref, rw, rh, x - dx + ox, y - dy + oy);
  return ctx;
}
function refineTypical(ref, rw, rh, rx, ry) {
  const first = gpx(ref, rw, rh, rx - 1, ry - 1);
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (gpx(ref, rw, rh, rx + ox, ry + oy) !== first) return undefined;
  return first;
}
/** Returns `{ ltpRows }` — how many rows took the TPGRON typical path. The
 *  minting script asserts that directly rather than comparing encoded sizes:
 *  for a small, highly predictable image the MQ coder already spends almost
 *  nothing on a blank row, so the SLTP decisions cost more than the typical
 *  path saves and a size comparison reports failure on a perfectly good
 *  vector. (Measured.) */
export function encodeRefinement(enc, cx, bm, w, h, ref, rw, rh, dx, dy, template, at, tpgron) {
  const tpl = refineTemplate(template, at);
  const sltp = REFINE_REUSED_CONTEXTS[template === 0 ? 0 : 1];
  let ltp = 0, ltpRows = 0;
  for (let y = 0; y < h; y++) {
    if (tpgron) {
      // Set LTP for a row where every pixel is typical, so the row costs one
      // decision instead of w of them — which is the point of the mode, and
      // makes the vector actually exercise the typical path.
      let allTypical = true;
      for (let x = 0; x < w; x++) {
        const t = refineTypical(ref, rw, rh, x - dx, y - dy);
        if (t === undefined || t !== bm[y * w + x]) { allTypical = false; break; }
      }
      const want = allTypical ? 1 : 0;
      enc.encode(cx, sltp, ltp ^ want);
      ltp = want;
      if (ltp) ltpRows++;
    }
    for (let x = 0; x < w; x++) {
      if (ltp) {
        const t = refineTypical(ref, rw, rh, x - dx, y - dy);
        if (t !== undefined) continue;
      }
      enc.encode(cx, refineCtx(bm, w, h, ref, rw, rh, tpl, x, y, dx, dy), bm[y * w + x]);
    }
  }
  return { ltpRows };
}
export function decodeRefinement(dec, cx, w, h, ref, rw, rh, dx, dy, template, at, tpgron) {
  const bm = new Uint8Array(w * h);
  const tpl = refineTemplate(template, at);
  const sltp = REFINE_REUSED_CONTEXTS[template === 0 ? 0 : 1];
  let ltp = 0;
  for (let y = 0; y < h; y++) {
    if (tpgron) ltp ^= dec.decode(cx, sltp);
    for (let x = 0; x < w; x++) {
      if (ltp) {
        const t = refineTypical(ref, rw, rh, x - dx, y - dy);
        if (t !== undefined) { bm[y * w + x] = t; continue; }
      }
      bm[y * w + x] = dec.decode(cx, refineCtx(bm, w, h, ref, rw, rh, tpl, x, y, dx, dy));
    }
  }
  return bm;
}

// ---- Symbol dictionary (arithmetic) ------------------------------------------
export function encodeSymbolDict(enc, syms, template, at) {
  const IADH = new Int8Array(512), IADW = new Int8Array(512), IAEX = new Int8Array(512);
  const cxGB = new Int8Array(1 << 16);
  const byH = [...syms].sort((a, b) => a.h - b.h);
  const classes = [];
  for (const s of byH) {
    const last = classes[classes.length - 1];
    if (last && last.h === s.h) last.items.push(s); else classes.push({ h: s.h, items: [s] });
  }
  let hcHeight = 0;
  for (const cls of classes) {
    encodeInt(enc, IADH, cls.h - hcHeight); hcHeight = cls.h;
    let symWidth = 0;
    for (const s of cls.items) {
      encodeInt(enc, IADW, s.w - symWidth); symWidth = s.w;
      encodeGeneric(enc, cxGB, s.data, s.w, s.h, template, at, false);
    }
    encodeInt(enc, IADW, null);
  }
  encodeInt(enc, IAEX, 0);
  encodeInt(enc, IAEX, syms.length);
}
/** Symbol dictionary with SDREFAGG set (T.88 §6.5.8.2). Each new symbol carries
 *  a REFAGGNINST; 1 refines an existing symbol (offsets RDX/RDY PLAIN, no
 *  half-delta), more than 1 decodes an aggregate text region over the
 *  dictionary's current symbols, sharing this stream and these contexts. */
export function encodeSymbolDictRefagg(enc, inputSyms, newSyms, rTemplate, rAt) {
  const IADH = new Int8Array(512), IADW = new Int8Array(512), IAEX = new Int8Array(512);
  const IAAI = new Int8Array(512);
  const symCodeLen = Math.max(1, Math.ceil(Math.log2(Math.max(1, inputSyms.length + newSyms.length))));
  // ONE context bundle for the dictionary and for any aggregate text region it
  // decodes, mirroring src/jbig2ints.ts's ArithIntSource. T.88 6.5.8.2.1 has the
  // aggregate use the DICTIONARY's statistics, so IAID/IARDX/IARDY are shared —
  // which only a dictionary MIXING the two REFAGG paths can observe.
  const ctx = newTextCtx(symCodeLen);
  const all = [...inputSyms];
  const classes = [];
  for (const s of newSyms) {
    const last = classes[classes.length - 1];
    if (last && last.h === s.h) last.items.push(s); else classes.push({ h: s.h, items: [s] });
  }
  let hcHeight = 0;
  for (const cls of classes) {
    encodeInt(enc, IADH, cls.h - hcHeight); hcHeight = cls.h;
    let symWidth = 0;
    for (const s of cls.items) {
      encodeInt(enc, IADW, s.w - symWidth); symWidth = s.w;
      if (s.agg) {
        encodeInt(enc, IAAI, s.agg.strips.reduce((n, st) => n + st.syms.length, 0));
        encodeTextRegion(enc, s.agg.strips, symCodeLen, 1, s.agg.initialDt ?? 0, true, rTemplate, rAt, ctx);
      } else {
        encodeInt(enc, IAAI, 1);
        encodeIaid(enc, ctx.IAID, symCodeLen, s.refId);
        encodeInt(enc, ctx.IARDX, s.rdx); encodeInt(enc, ctx.IARDY, s.rdy);
        const ref = all[s.refId];
        encodeRefinement(enc, ctx.cxGR, s.data, s.w, s.h, ref.data, ref.w, ref.h, s.rdx, s.rdy, rTemplate, rAt, false);
      }
      all.push(s);
    }
    encodeInt(enc, IADW, null);
  }
  // Export run: skip the inputs, export the new ones.
  encodeInt(enc, IAEX, inputSyms.length);
  encodeInt(enc, IAEX, newSyms.length);
}
export function decodeSymbolDict(dec, numNewSyms, template, at) {
  const IADH = new Int8Array(512), IADW = new Int8Array(512), IAEX = new Int8Array(512);
  const cxGB = new Int8Array(1 << 16);
  const newSyms = [];
  let hcHeight = 0;
  while (newSyms.length < numNewSyms) {
    hcHeight += decodeInt(dec, IADH);
    let symWidth = 0;
    for (;;) {
      const dw = decodeInt(dec, IADW);
      if (dw === null) break;
      symWidth += dw;
      const data = decodeGeneric(dec, cxGB, symWidth, hcHeight, template, at, false);
      newSyms.push({ w: symWidth, h: hcHeight, data });
    }
  }
  const exported = []; let exFlag = false, i = 0;
  while (i < newSyms.length) {
    const run = decodeInt(dec, IAEX);
    if (exFlag) for (let k = 0; k < run; k++) exported.push(newSyms[i + k]);
    i += run; exFlag = !exFlag;
  }
  return exported;
}

// ---- Text region (arithmetic) ------------------------------------------------
function trCombine(reg, w, h, sym, x, y) {
  for (let sy = 0; sy < sym.h; sy++) { const dy = y + sy; if (dy < 0 || dy >= h) continue;
    for (let sx = 0; sx < sym.w; sx++) { const dx = x + sx; if (dx < 0 || dx >= w) continue;
      reg[dy * w + dx] |= sym.data[sy * sym.w + sx]; } }
}
function placeNonTransposed(reg, w, h, sym, curS, T, refCorner) {
  const WI = sym.w, HI = sym.h;
  if (refCorner === 2 || refCorner === 3) curS += WI - 1;
  const x = (refCorner === 3 || refCorner === 2) ? curS - WI + 1 : curS;
  const y = (refCorner === 1 || refCorner === 3) ? T : T - HI + 1;
  trCombine(reg, w, h, sym, x, y);
  if (refCorner === 0 || refCorner === 1) curS += WI - 1;
  return curS;
}
/** The eleven contexts a text region uses, mirroring src/jbig2arith.ts's
 *  TextIntCtx. A symbol dictionary with REFAGGNINST > 1 shares its own bundle
 *  with the aggregate text region it decodes. */
export function newTextCtx(symCodeLen) {
  return {
    IADT: new Int8Array(512), IAFS: new Int8Array(512), IADS: new Int8Array(512),
    IAIT: new Int8Array(512), IARI: new Int8Array(512), IARDW: new Int8Array(512),
    IARDH: new Int8Array(512), IARDX: new Int8Array(512), IARDY: new Int8Array(512),
    IAID: new Int8Array(1 << (symCodeLen + 1)), cxGR: new Int8Array(1 << 13),
  };
}
export function encodeTextRegion(enc, strips, symCodeLen, sbStrips, initialDt, refine, rTemplate, rAt, ctxIn) {
  const ctx = ctxIn ?? newTextCtx(symCodeLen);
  const numInstances = strips.reduce((n, s) => n + s.syms.length, 0);
  encodeInt(enc, ctx.IADT, initialDt);
  let inst = 0;
  for (const strip of strips) {
    encodeInt(enc, ctx.IADT, strip.dt); encodeInt(enc, ctx.IAFS, strip.dfs);
    let first = true;
    for (const sym of strip.syms) {
      if (!first) encodeInt(enc, ctx.IADS, sym.ids);
      first = false;
      if (sbStrips !== 1) encodeInt(enc, ctx.IAIT, sym.curt);
      encodeIaid(enc, ctx.IAID, symCodeLen, sym.id);
      if (refine) {
        const r = sym.refine;
        encodeInt(enc, ctx.IARI, r ? 1 : 0);
        if (r) {
          encodeInt(enc, ctx.IARDW, r.rdw); encodeInt(enc, ctx.IARDH, r.rdh);
          encodeInt(enc, ctx.IARDX, r.rdx); encodeInt(enc, ctx.IARDY, r.rdy);
          encodeRefinement(enc, ctx.cxGR, r.target, r.w, r.h, r.ref, r.refW, r.refH,
            (r.rdw >> 1) + r.rdx, (r.rdh >> 1) + r.rdy, rTemplate, rAt, false);
        }
      }
      inst++;
      if (inst >= numInstances) return;
    }
    encodeInt(enc, ctx.IADS, null);
  }
}
export function decodeTextRegion(dec, w, h, numInstances, symbols, symCodeLen, sbStrips, refCorner, dsOffset, defPixel, refine, rTemplate, rAt, ctxIn) {
  const ctx = ctxIn ?? newTextCtx(symCodeLen);
  const reg = new Uint8Array(w * h); if (defPixel) reg.fill(1);
  let stripT = -(decodeInt(dec, ctx.IADT) ?? 0) * sbStrips;
  let firstS = 0, inst = 0;
  while (inst < numInstances) {
    stripT += (decodeInt(dec, ctx.IADT) ?? 0) * sbStrips;
    firstS += decodeInt(dec, ctx.IAFS) ?? 0;
    let curS = firstS, first = true;
    for (;;) {
      if (!first) { const ds = decodeInt(dec, ctx.IADS); if (ds === null) break; curS += ds + dsOffset; }
      first = false;
      const curT = stripT + (sbStrips === 1 ? 0 : (decodeInt(dec, ctx.IAIT) ?? 0));
      const id = decodeIaid(dec, ctx.IAID, symCodeLen);
      let sym = symbols[id];
      if (refine) {
        const ri = decodeInt(dec, ctx.IARI) ?? 0;
        if (ri !== 0 && sym) {
          const rdw = decodeInt(dec, ctx.IARDW) ?? 0;
          const rdh = decodeInt(dec, ctx.IARDH) ?? 0;
          const rdx = decodeInt(dec, ctx.IARDX) ?? 0;
          const rdy = decodeInt(dec, ctx.IARDY) ?? 0;
          const rw = sym.w + rdw, rh = sym.h + rdh;
          const data = decodeRefinement(dec, ctx.cxGR, rw, rh, sym.data, sym.w, sym.h,
            (rdw >> 1) + rdx, (rdh >> 1) + rdy, rTemplate, rAt, false);
          sym = { w: rw, h: rh, data };
        }
      }
      curS = placeNonTransposed(reg, w, h, sym, curS, curT, refCorner);
      inst++;
      if (inst >= numInstances) break;
    }
  }
  return reg;
}

// ---- Halftone: pattern dictionary + grayscale planes -------------------------
// Mirrors src/jbig2halftone.ts. There is deliberately NO reference
// decodeHalftoneRegion here: the expected output is the KNOWN value grid the
// encoder was handed, so the check that matters happens in
// test/jbig2-halftone.test.ts between this encoder and the independently
// written .ts decoder — two implementations rather than one file agreeing with
// itself. Same decision utax.5 made for REFAGG.
function halftoneAt(template, at1) {
  const at = [at1, { x: -3, y: -1 }, { x: 2, y: -2 }, { x: -2, y: -2 }];
  return template === 0 ? at : at.slice(0, 1);
}
export function patternDictAt(patternWidth, template) { return halftoneAt(template, { x: -patternWidth, y: 0 }); }
export function grayscaleAt(template) { return halftoneAt(template, { x: template <= 1 ? 3 : 2, y: -1 }); }

/** T.88 6.7.5: a pattern dictionary is ONE bitmap (GRAYMAX+1)*HDPW wide, sliced
 *  into patterns by the decoder. `patterns` are flat HDPW*HDPH arrays. */
export function collectiveBitmap(patterns, hdpw, hdph) {
  const width = patterns.length * hdpw;
  const data = new Uint8Array(width * hdph);
  patterns.forEach((p, i) => {
    for (let y = 0; y < hdph; y++) for (let x = 0; x < hdpw; x++) data[y * width + i * hdpw + x] = p[y * hdpw + x];
  });
  return { data, width, height: hdph };
}
export function encodePatternDict(enc, cx, patterns, hdpw, hdph, template) {
  const c = collectiveBitmap(patterns, hdpw, hdph);
  encodeGeneric(enc, cx, c.data, c.width, c.height, template, patternDictAt(hdpw, template), false);
}

/** T.88 6.6.5.2, the encoder's copy of the placement rule. It must agree with
 *  src/jbig2halftone.ts's cellOrigin cell for cell or a skip vector's stream
 *  desynchronises — which makes the skip fixture a genuine two-implementation
 *  check on this arithmetic, unlike the plain one. */
export function cellOrigin(g, mg, ng) {
  return {
    x: (g.gridX + mg * g.vectorY + ng * g.vectorX) >> 8,
    y: (g.gridY + mg * g.vectorX - ng * g.vectorY) >> 8,
  };
}
/** HSKIP (T.88 6.6.5.1): cells whose whole stamp misses the region. */
export function halftoneSkip(s) {
  const skip = new Uint8Array(s.gridWidth * s.gridHeight);
  for (let mg = 0; mg < s.gridHeight; mg++) {
    for (let ng = 0; ng < s.gridWidth; ng++) {
      const { x, y } = cellOrigin(s, mg, ng);
      if (x + s.patternWidth <= 0 || x >= s.width || y + s.patternHeight <= 0 || y >= s.height) {
        skip[mg * s.gridWidth + ng] = 1;
      }
    }
  }
  return skip;
}

/** Annex C.5 in the encoding direction: gray = v ^ (v >> 1), so plane j carries
 *  b_j ^ b_{j+1} and the decoder's downward fold recovers b_j. Planes are
 *  emitted MSB FIRST, all sharing one arithmetic coder and one context set. */
export function encodeGrayscale(enc, cx, values, w, h, bpp, template, skip) {
  const at = grayscaleAt(template);
  for (let j = bpp - 1; j >= 0; j--) {
    const plane = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) plane[i] = ((values[i] ^ (values[i] >> 1)) >> j) & 1;
    encodeGeneric(enc, cx, plane, w, h, template, at, false, skip);
  }
}

// ---- packing (matches src/jbig2.ts packBitmap) -------------------------------
export function packInvert(bm, w, h) {
  const rowBytes = (w + 7) >> 3;
  const out = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bm[y * w + x]) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  for (let i = 0; i < out.length; i++) out[i] = ~out[i] & 0xff;
  return out;
}
