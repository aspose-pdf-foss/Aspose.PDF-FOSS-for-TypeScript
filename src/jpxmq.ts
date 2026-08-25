// MQ arithmetic decoder — ISO/IEC 15444-1 Annex C.
// Per-context state is packed by the caller into an Int8Array: cx[i] = index<<1 | mps
// (index = Qe-table row, mps = current more-probable symbol). Callers size cx to the
// number of contexts they use and pre-load initial states.

export interface QeEntry { qe: number; nmps: number; nlps: number; sw: number }

// Table C.2: Qe values, NMPS, NLPS, SWITCH — 47 entries.
export const QE: ReadonlyArray<QeEntry> = [
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

export class MqDecoder {
  private data: Uint8Array;
  private bp: number;
  private end: number;
  private c = 0;
  private a = 0;
  private ct = 0;

  constructor(data: Uint8Array, start: number, end: number) {
    this.data = data;
    this.bp = start;
    this.end = end;
    // INITDEC (C.3.5)
    const b0 = this.bp < this.end ? this.data[this.bp] : 0xff;
    this.c = b0 << 16;
    this.byteIn();
    this.c = (this.c << 7) >>> 0;
    this.ct -= 7;
    this.a = 0x8000;
  }

  // BYTEIN (C.3.4)
  private byteIn(): void {
    const cur = this.bp < this.end ? this.data[this.bp] : 0xff;
    if (cur === 0xff) {
      const b1 = this.bp + 1 < this.end ? this.data[this.bp + 1] : 0xff;
      if (b1 > 0x8f) {
        this.c += 0xff00;
        this.ct = 8;
      } else {
        this.bp++;
        this.c += b1 << 9;
        this.ct = 7;
      }
    } else {
      this.bp++;
      const b = this.bp < this.end ? this.data[this.bp] : 0xff;
      this.c += b << 8;
      this.ct = 8;
    }
  }

  private renormd(): void {
    do {
      if (this.ct === 0) this.byteIn();
      this.a = (this.a << 1) & 0xffffffff;
      this.c = (this.c << 1) >>> 0;
      this.ct--;
    } while ((this.a & 0x8000) === 0);
  }

  /** DECODE (C.3.2). Returns the decoded binary decision for context index `i`. */
  decode(cx: Int8Array, i: number): 0 | 1 {
    let state = cx[i] >> 1;
    let mps = cx[i] & 1;
    const q = QE[state];
    const qe = q.qe;
    this.a -= qe;
    let d: number;
    if (((this.c >>> 16) & 0xffff) < qe) {
      // LPS exchange (C.3.2, LPS_EXCHANGE)
      if (this.a < qe) { d = mps; state = q.nmps; }
      else { d = 1 - mps; if (q.sw === 1) mps = 1 - mps; state = q.nlps; }
      this.a = qe;
      this.renormd();
    } else {
      this.c = (this.c - (qe << 16)) >>> 0;
      if ((this.a & 0x8000) === 0) {
        // MPS exchange (MPS_EXCHANGE)
        if (this.a < qe) { d = 1 - mps; if (q.sw === 1) mps = 1 - mps; state = q.nlps; }
        else { d = mps; state = q.nmps; }
        this.renormd();
      } else {
        d = mps;
      }
    }
    cx[i] = (state << 1) | mps;
    return d as 0 | 1;
  }
}
