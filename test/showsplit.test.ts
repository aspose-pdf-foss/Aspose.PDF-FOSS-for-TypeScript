import { describe, it, expect } from 'vitest';
import { splitShowOp, type ShowPiece } from '../src/showsplit.js';
import type { ContentOp } from '../src/content.js';
import { isName, isString, type PdfObject } from '../src/types.js';

const s = (t: string): PdfObject => ({ kind: 'string', bytes: Uint8Array.from(t, (c) => c.charCodeAt(0)) });
const b = (t: string): ShowPiece => ({ kind: 'bytes', bytes: Uint8Array.from(t, (c) => c.charCodeAt(0)) });
const f = (t: string): ShowPiece => ({ kind: 'foreign', key: 'F9', bytes: Uint8Array.from(t, (c) => c.charCodeAt(0)) });
const R = { key: 'F1', size: 12 };
/** Ops as compact strings: `Tj(ab)`, `Tf F9 12`, `TJ[(a) -50]`. */
const fmt = (ops: ContentOp[]): string[] => ops.map((op) => {
  const arg = (o: PdfObject): string => isString(o) ? `(${String.fromCharCode(...o.bytes)})`
    : isName(o) ? o.name : Array.isArray(o) ? `[${o.map(arg).join(' ')}]` : String(o);
  return op.operator === 'Tf' ? `Tf ${op.operands.map(arg).join(' ')}` : `${op.operator}${op.operands.map(arg).join(' ')}`;
});

describe('splitShowOp', () => {
  it('splits a Tj around a foreign run and restores the font', () => {
    const op: ContentOp = { operator: 'Tj', operands: [s('aXb')] };
    expect(fmt(splitShowOp(op, [b('a'), f('W'), b('b')], R)))
      .toEqual(['Tj(a)', 'Tf F9 12', 'Tj(W)', 'Tf F1 12', 'Tj(b)']);
  });

  it('omits an empty Tj before or after the switch', () => {
    const op: ContentOp = { operator: 'Tj', operands: [s('X')] };
    expect(fmt(splitShowOp(op, [b(''), f('W'), b('')], R))).toEqual(['Tf F9 12', 'Tj(W)', 'Tf F1 12']);
  });

  it('merges adjacent original pieces into one string', () => {
    const op: ContentOp = { operator: 'Tj', operands: [s('ab')] };
    expect(fmt(splitShowOp(op, [b('a'), b('c'), f('W'), b('d'), b('b')], R)))
      .toEqual(['Tj(ac)', 'Tf F9 12', 'Tj(W)', 'Tf F1 12', 'Tj(db)']);
  });

  it('keeps TJ kerns on the side they sat on', () => {
    const op: ContentOp = { operator: 'TJ', operands: [[s('aX'), -50, s('b')]] };
    const pieces: ShowPiece[] = [b('a'), f('W'), { kind: 'kern', value: -50 }, b('b')];
    expect(fmt(splitShowOp(op, pieces, R))).toEqual(['TJ[(a)]', 'Tf F9 12', 'Tj(W)', 'Tf F1 12', 'TJ[-50 (b)]']);
  });

  it("keeps the line move of ' on the first piece, even when it is empty", () => {
    const op: ContentOp = { operator: "'", operands: [s('X')] };
    expect(fmt(splitShowOp(op, [b(''), f('W'), b('b')], R))).toEqual(["'()", 'Tf F9 12', 'Tj(W)', 'Tf F1 12', 'Tj(b)']);
  });

  it('keeps the spacing operands of " on the first piece only', () => {
    const op: ContentOp = { operator: '"', operands: [2, 1, s('aX')] };
    expect(fmt(splitShowOp(op, [b('a'), f('W')], R))).toEqual(['"2 1 (a)', 'Tf F9 12', 'Tj(W)', 'Tf F1 12']);
  });
});
