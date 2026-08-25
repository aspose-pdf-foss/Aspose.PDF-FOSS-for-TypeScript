import { describe, it, expect } from 'vitest';
import { brotliDecompressSync } from 'node:zlib';
import { CMapGeometry } from '../src/cidcmap.js';
import { decodeCMapGeometry, encodeCMapGeometry } from '../src/cmapcodec.js';
import { CMAP_DATA } from '../src/cmapdata.js';

const blob = (name: string) =>
  new Uint8Array(brotliDecompressSync(Buffer.from(CMAP_DATA[name], 'base64')));

describe('cmapcodec', () => {
  it('round-trips codespace ranges of every width', () => {
    const g: CMapGeometry = {
      codespace: [
        { nbytes: 1, lo: 0x00, hi: 0x80 },
        { nbytes: 2, lo: 0x8140, hi: 0x9ffc },
        { nbytes: 3, lo: 0x000000, hi: 0xffffff },
        { nbytes: 4, lo: 0, hi: 0x7fffffff },
      ],
      cidRanges: [],
      notdefRanges: [],
    };
    expect(decodeCMapGeometry(encodeCMapGeometry(g)).codespace).toEqual(g.codespace);
  });

  it('round-trips ranges whose CIDs step backwards', () => {
    // The CID column is delta-encoded from where the previous range ended, so a
    // CMap whose CIDs are not monotonic in code order exercises the zigzag.
    const g: CMapGeometry = {
      codespace: [{ nbytes: 2, lo: 0, hi: 0xffff }],
      cidRanges: [
        { nbytes: 2, lo: 0x0020, hi: 0x007e, cid: 9000 },
        { nbytes: 2, lo: 0x3041, hi: 0x3093, cid: 12 },
        { nbytes: 2, lo: 0x4e00, hi: 0x4e00, cid: 65535 },
      ],
      notdefRanges: [{ nbytes: 2, lo: 0x0000, hi: 0x001f, cid: 1 }],
    };
    const back = decodeCMapGeometry(encodeCMapGeometry(g));
    expect(back.cidRanges).toEqual(g.cidRanges);
    expect(back.notdefRanges).toEqual(g.notdefRanges);
  });

  it('round-trips codes at the top of the 4-byte space', () => {
    const g: CMapGeometry = {
      codespace: [{ nbytes: 4, lo: 0, hi: 0xffffffff }],
      cidRanges: [{ nbytes: 4, lo: 0xfffffff0, hi: 0xffffffff, cid: 7 }],
      notdefRanges: [],
    };
    expect(decodeCMapGeometry(encodeCMapGeometry(g))).toEqual(g);
  });

  it('keeps ranges of different widths apart', () => {
    const g: CMapGeometry = {
      codespace: [],
      cidRanges: [
        { nbytes: 1, lo: 0x20, hi: 0x7e, cid: 231 },
        { nbytes: 2, lo: 0x8140, hi: 0x817e, cid: 633 },
      ],
      notdefRanges: [],
    };
    const back = decodeCMapGeometry(encodeCMapGeometry(g));
    expect(back.cidRanges).toEqual(g.cidRanges);
  });

  it('returns what a truncated blob held, rather than throwing', () => {
    const full = encodeCMapGeometry({
      codespace: [{ nbytes: 2, lo: 0, hi: 0xffff }],
      cidRanges: [{ nbytes: 2, lo: 1, hi: 2, cid: 3 }],
      notdefRanges: [],
    });
    for (let cut = 0; cut < full.length; cut++) {
      expect(() => decodeCMapGeometry(full.subarray(0, cut))).not.toThrow();
    }
  });

  it('re-encodes every bundled CMap to the exact bytes it was built from', () => {
    // The encoder runs only at build time. Feeding each shipped blob back
    // through it is what keeps the two halves of a self-describing-free format
    // from drifting apart: a change to either that the other does not match
    // shows up here rather than as a wrong CID in a CJK document.
    const names = Object.keys(CMAP_DATA);
    expect(names.length).toBe(195);
    for (const name of names) {
      const bytes = blob(name);
      const decoded = decodeCMapGeometry(bytes);
      expect(encodeCMapGeometry(decoded), name).toEqual(bytes);
    }
  });

  it('decodes every bundled CMap to sane, sorted, non-overlapping ranges', () => {
    // 385,860 ranges: collect the violations and assert once, rather than
    // paying for an expect() per range.
    const bad: string[] = [];
    for (const name of Object.keys(CMAP_DATA)) {
      const g = decodeCMapGeometry(blob(name));
      for (const r of [...g.cidRanges, ...g.notdefRanges]) {
        if (r.nbytes < 1 || r.nbytes > 4) bad.push(`${name}: width ${r.nbytes}`);
        if (r.hi < r.lo) bad.push(`${name}: <${r.lo.toString(16)}>..<${r.hi.toString(16)}> reversed`);
      }
      // Within one width the ranges must not overlap, or a binary search that
      // lands on the greatest lo <= code can answer from the wrong range.
      const prev = new Map<number, { lo: number; hi: number }>();
      for (const r of g.cidRanges) {
        const p = prev.get(r.nbytes);
        if (p && r.lo <= p.hi)
          bad.push(`${name}: <${r.lo.toString(16)}> overlaps <${p.lo.toString(16)}>..<${p.hi.toString(16)}>`);
        prev.set(r.nbytes, r);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});
