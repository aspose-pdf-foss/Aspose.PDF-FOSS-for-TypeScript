import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodeObjStm } from '../src/objstm.js';
import { PdfStream, PdfObject, name, isDict, isName } from '../src/types.js';
import { PdfParseError } from '../src/errors.js';

/** Build a well-formed /ObjStm payload: "num off num off ..." then the bodies.
 *  Returns the payload text and the /First value that goes with it. */
function objStmPayload(bodies: Array<{ num: number; body: string }>) {
  let offsets = '';
  let data = '';
  for (const { num, body } of bodies) {
    offsets += `${num} ${data.length} `;
    data += `${body} `;
  }
  return { text: offsets + data, first: offsets.length };
}

function objStm(
  bodies: Array<{ num: number; body: string }>,
  over: Partial<{ N: number; First: number; payload: Uint8Array }> = {},
): PdfStream {
  const { text, first } = objStmPayload(bodies);
  const raw = over.payload
    ?? new Uint8Array(deflateSync(Buffer.from(text, 'latin1')));
  return {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('ObjStm')],
      ['N', over.N ?? bodies.length],
      ['First', over.First ?? first],
      ['Filter', name('FlateDecode')],
      ['Length', raw.length],
    ]),
    raw,
  };
}

const THREE = [
  { num: 5, body: '<< /Type /Catalog /Pages 6 0 R >>' },
  { num: 6, body: '<< /Type /Pages /Count 1 /Kids [7 0 R] >>' },
  { num: 7, body: '<< /Type /Page /Parent 6 0 R >>' },
];

describe('decodeObjStm', () => {
  it('decodes an undamaged container and reports no damage', () => {
    const { objects, damage } = decodeObjStm(objStm(THREE), 4);
    expect([...objects.keys()]).toEqual([5, 6, 7]);
    expect(damage).toBeUndefined();
    const cat = objects.get(5);
    expect(isDict(cat) && isName(cat.get('Type')) && (cat.get('Type') as any).name)
      .toBe('Catalog');
  });

  it('keeps the objects a truncated payload did not reach', () => {
    const full = new Uint8Array(deflateSync(
      Buffer.from(objStmPayload(THREE).text, 'latin1')));
    const s = objStm(THREE, { payload: full.subarray(0, Math.floor(full.length * 0.6)) });

    const { objects, damage } = decodeObjStm(s, 4);
    expect(objects.get(5)).toBeTruthy();          // before the damage
    expect(damage).toBeDefined();
    expect(damage!.container).toBe(4);
    expect(damage!.recovered.length).toBeGreaterThan(0);
    expect(damage!.lost.length).toBeGreaterThan(0);
    // Every declared object is accounted for in exactly one of the two lists.
    expect([...damage!.recovered, ...damage!.lost].sort()).toEqual([5, 6, 7]);
  });

  it('reads what the header holds when /N overstates it', () => {
    const { objects, damage } = decodeObjStm(objStm(THREE, { N: 9 }), 4);
    expect([...objects.keys()]).toEqual([5, 6, 7]);
    expect(damage).toBeDefined();
    expect(damage!.detail).toContain('9');
  });

  it('recovers /First from the header end when the declared value is unusable', () => {
    for (const First of [0, 999999]) {
      const { objects, damage } = decodeObjStm(objStm(THREE, { First }), 4);
      expect([...objects.keys()]).toEqual([5, 6, 7]);
      expect(damage).toBeDefined();
    }
  });

  it('drops only the entry that will not parse', () => {
    const bodies = [
      { num: 5, body: '<< /Type /Catalog /Pages 6 0 R >>' },
      { num: 6, body: '<< /Type /Pages /Count' },   // unterminated dict
      { num: 7, body: '<< /Type /Page /Parent 6 0 R >>' },
    ];
    const { objects, damage } = decodeObjStm(objStm(bodies), 4);
    expect([...objects.keys()]).toEqual([5, 7]);
    expect(damage!.lost).toEqual([6]);
  });

  it('stops at the end of the header when /N is absurd', () => {
    // /N is a number in a dict and a 30-byte dict must not be able to demand
    // 2^31 iterations. What bounds the loop is stopping at the first non-pair
    // token, so this dies rather than fails if that `break` is ever weakened.
    const s = objStm(THREE, { N: 2 ** 31 });
    const { objects, damage } = decodeObjStm(s, 4);
    expect([...objects.keys()]).toEqual([5, 6, 7]);
    expect(damage!.detail).toContain('3 of 2147483648');
  });

  it('throws when the container yields nothing to work with', () => {
    const s = objStm(THREE, { payload: Uint8Array.of(0x5a, 0x5a, 0x5a, 0x5a) });
    expect(() => decodeObjStm(s, 4)).toThrow(PdfParseError);
  });
});
