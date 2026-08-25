import { describe, it, expect } from 'vitest';
import {
  getPredefinedCMap, isPredefinedCMapName, predefinedCMapInfo, predefinedCMapNames,
} from '../src/predefcmap.js';

const bytes = (...b: number[]) => Uint8Array.from(b);
/** A UCS-2 code as the two big-endian bytes a show string carries. */
const ucs2 = (cp: number) => bytes(cp >> 8, cp & 0xff);

const cidOf = (cmap: string, code: Uint8Array): number => {
  const m = getPredefinedCMap(cmap)!;
  const run = m.decode(code);
  expect(run.length, `${cmap}: expected one code`).toBe(1);
  return run[0].cid;
};

describe('the bundled predefined CMap collections', () => {
  it('ships every collection a PDF may name', () => {
    const names = predefinedCMapNames();
    expect(names.length).toBe(195);
    for (const n of [
      'UniJIS-UCS2-H', '90ms-RKSJ-H', 'Ext-RKSJ-H',        // Adobe-Japan1
      'UniGB-UCS2-H', 'GBK-EUC-H', 'GB-EUC-H',             // Adobe-GB1
      'UniCNS-UCS2-H', 'B5pc-H', 'ETen-B5-H',              // Adobe-CNS1
      'UniKS-UCS2-H', 'KSCms-UHC-H', 'KSC-EUC-H',          // Adobe-Korea1
      'UniAKR-UTF16-H',                                     // Adobe-KR
      'Identity-H', 'Identity-V',                           // Adobe-Identity
      '90pv-RKSJ-H',                                        // Adobe-Japan2 era
    ]) {
      expect(isPredefinedCMapName(n), n).toBe(true);
    }
  });

  it('reports each collection ordering without inflating the ranges', () => {
    expect(predefinedCMapInfo('UniJIS-UCS2-H')?.ordering).toBe('Japan1');
    expect(predefinedCMapInfo('UniGB-UCS2-H')?.ordering).toBe('GB1');
    expect(predefinedCMapInfo('UniCNS-UCS2-H')?.ordering).toBe('CNS1');
    expect(predefinedCMapInfo('UniKS-UCS2-H')?.ordering).toBe('Korea1');
    expect(predefinedCMapInfo('UniAKR-UTF16-H')?.ordering).toBe('KR');
    expect(predefinedCMapInfo('Identity-H')?.ordering).toBe('Identity');
  });

  it('reports /WMode and the usecmap parent', () => {
    expect(predefinedCMapInfo('UniJIS-UCS2-H')?.wmode).toBe(0);
    expect(predefinedCMapInfo('UniJIS-UCS2-V')?.wmode).toBe(1);
    expect(predefinedCMapInfo('UniJIS-UCS2-V')?.usecmap).toBe('UniJIS-UCS2-H');
    expect(predefinedCMapInfo('UniJIS-UCS2-H')?.usecmap).toBeUndefined();
    expect(predefinedCMapInfo('Identity-V')?.wmode).toBe(1);
  });

  it('answers nothing for a name that is not predefined', () => {
    expect(isPredefinedCMapName('NoSuch-H')).toBe(false);
    expect(getPredefinedCMap('NoSuch-H')).toBeUndefined();
    expect(predefinedCMapInfo('NoSuch-H')).toBeUndefined();
  });

  it('does not mistake an inherited Object property for a CMap', () => {
    // The name comes out of the document, so /Encoding /constructor must not
    // find Object.prototype.constructor and be treated as a CMap that exists.
    for (const n of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(isPredefinedCMapName(n), n).toBe(false);
      expect(getPredefinedCMap(n), n).toBeUndefined();
    }
  });

  it('returns the same instance on a second load', () => {
    expect(getPredefinedCMap('UniJIS-UCS2-H')).toBe(getPredefinedCMap('UniJIS-UCS2-H'));
  });
});

describe('code to CID, per collection', () => {
  // Ground truth read out of the Adobe CMap resources themselves, so these
  // assert what the format says rather than what our encoder happened to store.
  it('maps Japanese through Adobe-Japan1', () => {
    // UniJIS-UCS2-H: <3041> <3093> 842, so U+3042 HIRAGANA A is CID 843.
    expect(cidOf('UniJIS-UCS2-H', ucs2(0x3042))).toBe(843);
    expect(cidOf('UniJIS-UCS2-H', ucs2(0x3041))).toBe(842);
    // <2010> <2010> 662
    expect(cidOf('UniJIS-UCS2-H', ucs2(0x2010))).toBe(662);
  });

  it('maps Simplified Chinese through Adobe-GB1', () => {
    expect(cidOf('UniGB-UCS2-H', ucs2(0x4e00))).toBe(4162); // <4e00> <4e00> 4162
  });

  it('maps Traditional Chinese through Adobe-CNS1', () => {
    expect(cidOf('UniCNS-UCS2-H', ucs2(0x4e00))).toBe(595); // <4e00> <4e00> 595
  });

  it('maps Korean through Adobe-Korea1', () => {
    expect(cidOf('UniKS-UCS2-H', ucs2(0xac00))).toBe(1086); // <ac00> <ac01> 1086
    expect(cidOf('UniKS-UCS2-H', ucs2(0xac01))).toBe(1087);
  });

  it('maps a code that nothing covers to CID 0', () => {
    expect(cidOf('UniGB-UCS2-H', ucs2(0xe000))).toBe(0);
  });
});

describe('Identity-H and Identity-V', () => {
  it('map every two-byte code to the same CID', () => {
    for (const cp of [0x0000, 0x0001, 0x00ff, 0x0100, 0x1234, 0xfffe, 0xffff]) {
      expect(cidOf('Identity-H', ucs2(cp)), cp.toString(16)).toBe(cp);
      expect(cidOf('Identity-V', ucs2(cp)), cp.toString(16)).toBe(cp);
    }
  });

  it('take codes two bytes at a time', () => {
    const run = getPredefinedCMap('Identity-H')!.decode(bytes(0x00, 0x41, 0x30, 0x42));
    expect(run.map((u) => u.len)).toEqual([2, 2]);
    expect(run.map((u) => u.cid)).toEqual([0x0041, 0x3042]);
  });
});

describe('the mixed-width legacy encodings', () => {
  it('reads 90ms-RKSJ-H one byte or two, as Shift-JIS requires', () => {
    // <20> <7d> 231 | <829f> <82f1> 842 | <a0> <df> 326
    const run = getPredefinedCMap('90ms-RKSJ-H')!.decode(bytes(0x41, 0x82, 0xa0, 0xb1));
    expect(run.map((u) => u.len)).toEqual([1, 2, 1]);
    expect(run.map((u) => u.cid)).toEqual([
      231 + (0x41 - 0x20),  // 'A'
      843,                   // あ — the same CID UniJIS-UCS2-H gives U+3042
      326 + (0xb1 - 0xa0),  // ｱ half-width katakana
    ]);
  });

  it('agrees with UniJIS-UCS2-H on the CID for the same character', () => {
    // Two encodings of Adobe-Japan1 must land on one CID, or the same text
    // renders as different glyphs depending on which CMap the producer chose.
    expect(cidOf('90ms-RKSJ-H', bytes(0x82, 0xa0)))
      .toBe(cidOf('UniJIS-UCS2-H', ucs2(0x3042)));
  });

  it('rejects a Shift-JIS lead byte with an out-of-range trail', () => {
    // 0x8200 is inside <8140>..<9FFC> as an integer but not byte by byte.
    const run = getPredefinedCMap('90ms-RKSJ-H')!.decode(bytes(0x82, 0x00));
    expect(run[0].matched).toBe(false);
    expect(run[0].cid).toBe(0);
  });

  it('maps control codes through B5pc-H\'s notdefrange without interpolating', () => {
    // <00> <1f> 1 — one substitute for all 32 codes.
    expect(cidOf('B5pc-H', bytes(0x00))).toBe(1);
    expect(cidOf('B5pc-H', bytes(0x1f))).toBe(1);
  });
});

describe('vertical CMaps and the usecmap chain', () => {
  it('inherits the parent codespace, so a vertical CMap decodes at all', () => {
    // UniJIS-UCS2-V declares no begincodespacerange whatsoever.
    const run = getPredefinedCMap('UniJIS-UCS2-V')!.decode(ucs2(0x3042));
    expect(run.length).toBe(1);
    expect(run[0].len).toBe(2);
    expect(run[0].matched).toBe(true);
  });

  it('overrides the codes it restates and inherits the rest', () => {
    // UniJIS-UCS2-V restates <2010> as 7893; UniJIS-UCS2-H has it as 662.
    expect(cidOf('UniJIS-UCS2-V', ucs2(0x2010))).toBe(7893);
    expect(cidOf('UniJIS-UCS2-H', ucs2(0x2010))).toBe(662);
    // U+3042 is not restated, so it must come through from the parent.
    expect(cidOf('UniJIS-UCS2-V', ucs2(0x3042))).toBe(843);
  });

  it('resolves the one chain in the corpus that is two links long', () => {
    // ETenms-B5-V -> ETenms-B5-H -> ETen-B5-H. Only the root declares a
    // codespace, and each link restates a disjoint handful of codes, so all
    // three levels have to be consulted to decode one Big5 string.
    expect(predefinedCMapInfo('ETenms-B5-V')?.usecmap).toBe('ETenms-B5-H');
    expect(predefinedCMapInfo('ETenms-B5-H')?.usecmap).toBe('ETen-B5-H');
    expect(predefinedCMapInfo('ETen-B5-H')?.usecmap).toBeUndefined();

    expect(cidOf('ETenms-B5-V', bytes(0xa1, 0x5d))).toBe(130); // its own
    expect(cidOf('ETenms-B5-V', bytes(0x20))).toBe(1);          // the middle link's
    expect(cidOf('ETenms-B5-V', bytes(0xa4, 0x40))).toBe(595);  // the root's
  });

  it('gives every vertical CMap a working codespace', () => {
    // The inheritance bug this guards is silent: the CMap loads, reports its
    // ranges, and decodes every show string to nothing.
    const vertical = predefinedCMapNames().filter((n) => predefinedCMapInfo(n)!.wmode === 1);
    expect(vertical.length).toBeGreaterThan(50);
    for (const name of vertical) {
      expect(getPredefinedCMap(name)!.codespaces, name).not.toEqual([]);
    }
  });
});

/** The `nbytes` big-endian bytes of `code`. */
const codeBytes = (code: number, nbytes: number): Uint8Array =>
  Uint8Array.from({ length: nbytes }, (_, k) => Math.floor(code / 2 ** (8 * (nbytes - 1 - k))) & 0xff);

describe('every bundled CMap', () => {
  it('loads and reports the ordering its side-table entry claims', () => {
    for (const name of predefinedCMapNames()) {
      const cmap = getPredefinedCMap(name);
      expect(cmap, name).toBeDefined();
      expect(cmap!.ordering, name).toBe(predefinedCMapInfo(name)!.ordering);
      expect(cmap!.wmode, name).toBe(predefinedCMapInfo(name)!.wmode);
    }
  });

  it('accepts the first code of each of its codespace ranges, at that width', () => {
    // Probing at a fixed two bytes would pass every CMap here by accident and
    // quietly exempt the UTF-8 and UTF-32 CMaps, whose codes run 1 to 4 bytes.
    for (const name of predefinedCMapNames()) {
      const cmap = getPredefinedCMap(name)!;
      for (const cs of cmap.codespaces) {
        const u = cmap.next(codeBytes(cs.lo, cs.nbytes), 0);
        expect(u.matched, `${name} <${cs.lo.toString(16)}> width ${cs.nbytes}`).toBe(true);
        expect(u.len, `${name} <${cs.lo.toString(16)}>`).toBe(cs.nbytes);
      }
    }
  });

  it('maps at least one code to a real CID', () => {
    for (const name of predefinedCMapNames()) {
      const cmap = getPredefinedCMap(name)!;
      let mapped = 0;
      for (const cs of cmap.codespaces) {
        // Walk the range at a stride, so a sparse 4-byte space still gets hit.
        const step = Math.max(1, Math.floor((cs.hi - cs.lo) / 4096));
        for (let code = cs.lo; code <= cs.hi && !mapped; code += step) {
          const b = codeBytes(code, cs.nbytes);
          const u = cmap.next(b, 0);
          if (u.matched && u.len === cs.nbytes) mapped = cmap.cid(u.code, u.len);
        }
        if (mapped) break;
      }
      expect(mapped, `${name} maps nothing`).toBeGreaterThan(0);
    }
  });
});
