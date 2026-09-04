import { describe, it, expect } from 'vitest';
import {
  parseIccProfile, iccTag, readXyzTag, readCurveTag, evalCurve,
  type IccCurve, type IccProfile,
} from '../src/icc.js';
import { srgbIcc } from '../src/srgb.js';
import { PdfParseError } from '../src/errors.js';

/**
 * The ICC profile container (85l8.7.1).
 *
 * Verified against the sRGB profile already vendored in `srgb.ts` — the HP/
 * Microsoft IEC 61966-2.1 profile, freely distributable, 3144 bytes. No new
 * fixture, no generator and no oracle are needed for this half, which is why
 * it is worth landing on its own.
 */
describe('parseIccProfile — header', () => {
  const p = parseIccProfile(srgbIcc());

  it('reads the four-character signature fields', () => {
    expect(p.header.cmm).toBe('Lino');
    expect(p.header.deviceClass).toBe('mntr');
    expect(p.header.dataColorSpace).toBe('RGB ');
    expect(p.header.pcs).toBe('XYZ ');
    expect(p.header.platform).toBe('MSFT');
  });

  // Space-padded to four characters, never trimmed: 'RGB ' and 'Lab ' are
  // four-byte signatures and a trimmed one would not compare equal to the
  // constants 85l8.7.2 matches on.
  it('keeps the trailing space of a padded signature', () => {
    expect(p.header.dataColorSpace).toHaveLength(4);
    expect(p.header.pcs).toHaveLength(4);
  });

  // Byte 8 is major; byte 9 packs minor in its high nibble and bugfix in its
  // low one. Reading byte 9 raw gives 16 for this profile rather than 1.0.
  it('unpacks the version nibbles', () => {
    expect(p.header.version).toEqual({ major: 2, minor: 1, bugfix: 0 });
  });

  it('reads the declared size and the rendering intent', () => {
    expect(p.header.size).toBe(3144);
    expect(p.header.renderingIntent).toBe(0);
  });

  it('keeps the bytes it was given, for the tag readers', () => {
    expect(p.bytes.length).toBe(3144);
  });
});

describe('parseIccProfile — refusals', () => {
  it('refuses a buffer too short to hold a header', () => {
    expect(() => parseIccProfile(new Uint8Array(127))).toThrow(PdfParseError);
  });

  // The 'acsp' signature at byte 36 is what makes a buffer an ICC profile at
  // all. Without this check any 128 bytes parse into a confident header of
  // nonsense.
  it('refuses a buffer whose acsp signature is absent', () => {
    const bad = srgbIcc();
    bad[36] = 0x78;
    expect(() => parseIccProfile(bad)).toThrow(/acsp/);
  });
});

describe('parseIccProfile — tag table', () => {
  const p = parseIccProfile(srgbIcc());

  it('reads every tag the profile declares', () => {
    expect(p.tags).toHaveLength(17);
    expect(p.tags.map((t) => t.signature)).toContain('rXYZ');
    expect(p.tags.map((t) => t.signature)).toContain('rTRC');
  });

  it('records each tag offset and size', () => {
    expect(iccTag(p, 'rXYZ')).toEqual({ signature: 'rXYZ', offset: 536, size: 20 });
  });

  /**
   * The hazard this fixture happens to carry, and the reason to assert it.
   * `rTRC`, `gTRC` and `bTRC` all point at offset 1084 with the same length —
   * three tags SHARING one block of data, which ICC permits and real profiles
   * use to avoid storing an identical curve three times. A reader that assumed
   * tags partition the file, or that consumed bytes as it walked, would report
   * two of the three wrongly.
   */
  it('allows several tags to share one data block', () => {
    const r = iccTag(p, 'rTRC');
    const g = iccTag(p, 'gTRC');
    const b = iccTag(p, 'bTRC');
    expect(r).toEqual({ signature: 'rTRC', offset: 1084, size: 2060 });
    expect(g?.offset).toBe(r?.offset);
    expect(b?.offset).toBe(r?.offset);
  });

  it('returns undefined for a tag the profile does not carry', () => {
    expect(iccTag(p, 'B2A0')).toBeUndefined();
  });

  // The signature comes from the file, so the lookup must not consult
  // Object.prototype — the hazard `predefcmap.ts` already records for a name a
  // document chooses.
  it('does not find a tag named for an Object property', () => {
    expect(iccTag(p, 'constructor')).toBeUndefined();
  });
});

describe('parseIccProfile — tag table refusals', () => {
  it('refuses a tag count the buffer cannot hold', () => {
    const bad = srgbIcc();
    // Tag count lives at byte 128; 0xffff entries need far more than 3144 bytes.
    bad[128] = 0; bad[129] = 0; bad[130] = 0xff; bad[131] = 0xff;
    expect(() => parseIccProfile(bad)).toThrow(PdfParseError);
  });

  /**
   * A tag whose data runs past the end of the buffer. Left unchecked this is
   * not a wrong colour but an out-of-bounds read in every later tag reader, so
   * it is refused here, once, rather than guarded at each of them.
   */
  it('refuses a tag whose data leaves the buffer', () => {
    const bad = srgbIcc();
    // First tag entry sits at 132: signature, offset, size. Push its size past
    // the end of the profile.
    bad[140] = 0xff; bad[141] = 0xff; bad[142] = 0xff; bad[143] = 0xff;
    expect(() => parseIccProfile(bad)).toThrow(/out of bounds|leaves/i);
  });
});

/**
 * The `XYZ ` tag type, and the one assertion here that is anchored OUTSIDE our
 * own reader.
 *
 * s15Fixed16 is a signed 16.16 fixed-point number, so a reader that divides by
 * the wrong power of two, or treats the value as unsigned, produces plausible
 * small numbers rather than an obvious fault. The check that catches it is
 * that the three COLORANT columns must sum to the profile's PCS illuminant,
 * D50 — a published constant (0.9642, 1.0000, 0.8249) that no part of this
 * code produces.
 */
describe('readXyzTag', () => {
  const p = parseIccProfile(srgbIcc());
  const xyz = (s: string): [number, number, number] => {
    const t = iccTag(p, s);
    if (!t) throw new Error(`no ${s} tag`);
    return readXyzTag(p, t);
  };

  it('reads s15Fixed16 triples', () => {
    const [x, y, z] = xyz('rXYZ');
    expect(x).toBeCloseTo(0.436066, 5);
    expect(y).toBeCloseTo(0.222488, 5);
    expect(z).toBeCloseTo(0.013916, 5);
  });

  // The external anchor. Sum the red, green and blue colorants and you must
  // get the D50 white the ICC PCS is defined against, whatever this reader
  // does internally.
  it('gives colorants that sum to the D50 illuminant', () => {
    const r = xyz('rXYZ'), g = xyz('gXYZ'), b = xyz('bXYZ');
    expect(r[0] + g[0] + b[0]).toBeCloseTo(0.9642, 3);
    expect(r[1] + g[1] + b[1]).toBeCloseTo(1.0000, 3);
    expect(r[2] + g[2] + b[2]).toBeCloseTo(0.8249, 3);
  });

  /**
   * And the value this profile actually stores for its media white point is
   * D65, not the D50 the sum above lands on. That is a known quirk of this
   * particular file; the parser reports what the file says and does not
   * correct it. Asserted so the discrepancy reads as recorded rather than as a
   * bug in the reader.
   */
  it('reports the D65 white point this profile really declares', () => {
    const [x, y, z] = xyz('wtpt');
    expect(x).toBeCloseTo(0.9504, 3);
    expect(y).toBeCloseTo(1.0000, 3);
    expect(z).toBeCloseTo(1.0890, 3);
  });

  it('refuses a tag that is not an XYZ type', () => {
    const t = iccTag(p, 'desc');
    if (!t) throw new Error('no desc tag');
    expect(() => readXyzTag(p, t)).toThrow(PdfParseError);
  });
});

/**
 * The `curv` tag type. Its COUNT field selects between three different
 * meanings, and confusing them is silent:
 *
 *   0 entries — the identity, drawn as a straight line;
 *   1 entry   — a gamma, as u8Fixed8 (so 0x0100 is gamma 1.0, not 256);
 *   n entries — a sampled table of n uint16 values.
 *
 * Reading the 1-entry form as a one-element table gives a curve that returns a
 * constant, which renders as a flat wash rather than an error.
 */
describe('readCurveTag', () => {
  const p = parseIccProfile(srgbIcc());
  const trc = (): IccCurve => {
    const t = iccTag(p, 'rTRC');
    if (!t) throw new Error('no rTRC tag');
    return readCurveTag(p, t);
  };

  it('reads a sampled table and its length', () => {
    const c = trc();
    expect(c.kind).toBe('table');
    if (c.kind !== 'table') throw new Error('not a table');
    expect(c.table).toHaveLength(1024);
    expect(c.table[0]).toBe(0);
    expect(c.table[1023]).toBe(65535);
  });

  // A TRC is a transfer function, so it must not go backwards. This is a
  // property of the DATA rather than of the reader, which is what makes it a
  // useful check on the reader: an off-by-one or a byte-order slip produces a
  // sequence that is not monotonic.
  it('reads a table that is monotonic non-decreasing', () => {
    const c = trc();
    if (c.kind !== 'table') throw new Error('not a table');
    for (let i = 1; i < c.table.length; i++) {
      expect(c.table[i]).toBeGreaterThanOrEqual(c.table[i - 1] as number);
    }
  });

  it('reads a zero-entry curve as the identity', () => {
    const bytes = new Uint8Array(12);
    bytes.set(new TextEncoder().encode('curv'), 0);
    // count stays 0
    const fake: IccProfile = { header: p.header, tags: [], bytes };
    expect(readCurveTag(fake, { signature: 'x', offset: 0, size: 12 }))
      .toEqual({ kind: 'identity' });
  });

  // u8Fixed8: 0x0100 is 1.0. Read as a plain integer it is 256, and every
  // value raised to the power 256 collapses to zero.
  it('reads a one-entry curve as a u8Fixed8 gamma', () => {
    const bytes = new Uint8Array(14);
    bytes.set(new TextEncoder().encode('curv'), 0);
    bytes[11] = 1;              // count = 1
    bytes[12] = 0x02; bytes[13] = 0x33;   // 0x0233 = 2.199…
    const fake: IccProfile = { header: p.header, tags: [], bytes };
    const c = readCurveTag(fake, { signature: 'x', offset: 0, size: 14 });
    expect(c.kind).toBe('gamma');
    if (c.kind !== 'gamma') throw new Error('not a gamma');
    expect(c.gamma).toBeCloseTo(2.199, 3);
  });

  it('refuses a curve whose entries do not fit its tag', () => {
    const bytes = new Uint8Array(14);
    bytes.set(new TextEncoder().encode('curv'), 0);
    bytes[10] = 0xff; bytes[11] = 0xff;   // count = 65535
    const fake: IccProfile = { header: p.header, tags: [], bytes };
    expect(() => readCurveTag(fake, { signature: 'x', offset: 0, size: 14 }))
      .toThrow(PdfParseError);
  });
});

describe('evalCurve', () => {
  it('passes a value straight through the identity', () => {
    expect(evalCurve({ kind: 'identity' }, 0.25)).toBe(0.25);
  });

  it('raises to the gamma', () => {
    expect(evalCurve({ kind: 'gamma', gamma: 2 }, 0.5)).toBeCloseTo(0.25, 6);
  });

  // Interpolated, not nearest: a 1024-entry table sampled at 256 input steps
  // would otherwise quantise the output visibly.
  it('interpolates between table entries', () => {
    const table = Uint16Array.from([0, 65535]);
    expect(evalCurve({ kind: 'table', table }, 0.5)).toBeCloseTo(0.5, 4);
  });

  it('clamps an input outside 0..1', () => {
    const table = Uint16Array.from([0, 65535]);
    expect(evalCurve({ kind: 'table', table }, -1)).toBe(0);
    expect(evalCurve({ kind: 'table', table }, 2)).toBe(1);
  });
});
