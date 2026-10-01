import { describe, it, expect } from 'vitest';
import { openZip } from '../src/zipread.js';
import { writeZip } from '../src/zip.js';
import { LoadLimits } from '../src/loadlimits.js';
import { PdfParseError, ResourceLimitError } from '../src/errors.js';
import { enc, layout, put16, put32 } from './helpers/zip-bytes.js';

const limitOf = (f: () => unknown): string | undefined => {
  try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e.limit; throw e; }
  return undefined;
};

const five = (): Uint8Array =>
  writeZip([0, 1, 2, 3, 4].map((i) => ({ path: `f${i}`, bytes: enc(String(i)) })));

describe('entry count against maxContainerItems', () => {
  it('admits exactly the limit and refuses one more', () => {
    expect(openZip(five(), LoadLimits.defaults.with({ maxContainerItems: 5 })).entries.length).toBe(5);
    expect(limitOf(() => openZip(five(), LoadLimits.defaults.with({ maxContainerItems: 4 }))))
      .toBe('maxContainerItems');
  });

  it('counts records as produced, never the declared count', () => {
    const zip = five();
    const { eocd } = layout(zip);
    put16(zip, eocd + 8, 60_000); put16(zip, eocd + 10, 60_000);
    // Declared 60,000 against a limit of 10: a declaration-based check would
    // refuse on the limit; counting as produced finds five and calls it damage.
    expect(() => openZip(zip, LoadLimits.defaults.with({ maxContainerItems: 10 })))
      .toThrow(PdfParseError);
  });
});

describe('bombs', () => {
  const bomb = (declared?: number): Uint8Array => {
    const zip = writeZip([{ path: 'bomb', bytes: new Uint8Array(4 * 1024 * 1024) }]);
    if (declared !== undefined) {
      // Both headers lie alike; a lie in one alone is refused as a mismatch.
      const { central, local } = layout(zip);
      put32(zip, central[0] + 24, declared); put32(zip, local[0] + 22, declared);
    }
    return zip;
  };

  it('refuses an honestly declared bomb from its declaration', () => {
    const z = openZip(bomb(), LoadLimits.defaults.with({ maxDecodedStreamBytes: 1024 * 1024 }));
    expect(limitOf(() => z.read('bomb'))).toBe('maxDecodedStreamBytes');
  });

  it('reads a bomb declaring SMALL as damage at the declared length', () => {
    expect(() => openZip(bomb(1000)).read('bomb')).toThrow(/more than the 1000 bytes it declares/);
  });

  it('refuses a declaration past the bounds before inflating corrupt data behind it', () => {
    const zip = writeZip([{ path: 'x', bytes: enc('abc') }]);
    const { central, local } = layout(zip);
    put32(zip, central[0] + 24, 50_000); put32(zip, local[0] + 22, 50_000);
    zip[local[0] + 30 + 1] = 0xff;              // corrupt the data too
    const z = openZip(zip, LoadLimits.defaults.with({ maxDecodedStreamBytes: 10_000 }));
    expect(limitOf(() => z.read('x'))).toBe('maxDecodedStreamBytes');
  });
});

describe('a stored entry', () => {
  it('is refused from its declaration, before its bytes are copied', () => {
    // A 3-byte payload declaring 50,000: refused on the declaration, where a
    // copy-then-compare would copy the 3 bytes and call the mismatch damage.
    const zip = writeZip([{ path: 's', bytes: enc('abc'), method: 'store' }]);
    const { central, local } = layout(zip);
    put32(zip, central[0] + 24, 50_000); put32(zip, local[0] + 22, 50_000);
    const z = openZip(zip, LoadLimits.defaults.with({ maxDecodedStreamBytes: 10_000 }));
    expect(limitOf(() => z.read('s'))).toBe('maxDecodedStreamBytes');
  });
});

describe('one running total per archive', () => {
  const three = (): Uint8Array => writeZip([
    { path: 'a', bytes: new Uint8Array(600) },
    { path: 'b', bytes: new Uint8Array(600), method: 'store' },
    { path: 'c', bytes: new Uint8Array(600) },
  ]);
  const small = LoadLimits.defaults.with({ maxTotalDecodedBytes: 1500 });

  it('charges deflated and stored entries alike to one total', () => {
    const z = openZip(three(), small);
    z.read('a'); z.read('b');
    expect(limitOf(() => z.read('c'))).toBe('maxTotalDecodedBytes');
  });

  it('charges a second read of one entry again', () => {
    const z = openZip(three(), small);
    z.read('a'); z.read('a');
    expect(limitOf(() => z.read('b'))).toBe('maxTotalDecodedBytes');
  });

  it('gives each opened archive its own total', () => {
    openZip(three(), small).read('a');
    const z = openZip(three(), small);
    z.read('a'); z.read('b');
    expect(limitOf(() => z.read('c'))).toBe('maxTotalDecodedBytes');
  });
});
