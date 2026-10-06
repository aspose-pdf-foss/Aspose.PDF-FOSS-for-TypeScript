import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, apply, mul, groupLineBlocks, type GlyphEvent } from '../src/text.js';
import { splitShowOp } from '../src/showsplit.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const glyphs = (doc: Document): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (g) => out.push(g) });
  return out;
};

describe('GlyphEvent matrices (u3l5.5)', () => {
  it('carries the start text matrix, the line matrix and the CTM', () => {
    const doc = Document.Open(buildSimpleTextPdf('2 0 0 2 0 0 cm BT /F1 12 Tf 10 100 Td (ab) Tj ET'));
    const [a, b] = glyphs(doc);
    expect(a.ctm).toEqual([2, 0, 0, 2, 0, 0]);
    expect(a.tlm).toEqual([1, 0, 0, 1, 10, 100]);
    expect(a.tm).toEqual([1, 0, 0, 1, 10, 100]);
    // b starts where a's advance ended; its origin through tm x ctm is its quad.
    expect(b.tm[4]).toBeCloseTo(10 + 556 * 12 / 1000, 6);
    const [x, y] = apply(mul(b.tm, b.ctm), 0, 0);
    expect(x).toBeCloseTo(b.quad[0], 6);
    expect(y).toBeCloseTo(b.quad[1], 6);
  });
});

describe('splitShowOp op pieces (u3l5.5)', () => {
  const str = (s: string) => ({ kind: 'string' as const, bytes: new TextEncoder().encode(s) });
  const tm = { operator: 'Tm', operands: [1, 0, 0, 1, 50, 60] };
  it('writes an operator between two halves of a Tj', () => {
    const out = splitShowOp({ operator: 'Tj', operands: [str('ab')] },
      [{ kind: 'bytes', bytes: new TextEncoder().encode('a') }, { kind: 'op', op: tm },
        { kind: 'bytes', bytes: new TextEncoder().encode('b') }], { key: '', size: 0 });
    expect(out.map((o) => o.operator)).toEqual(['Tj', 'Tm', 'Tj']);
  });
  it("keeps a ' line move ahead of an operator at its start", () => {
    const out = splitShowOp({ operator: "'", operands: [str('ab')] },
      [{ kind: 'op', op: tm }, { kind: 'bytes', bytes: new TextEncoder().encode('ab') }], { key: '', size: 0 });
    expect(out.map((o) => o.operator)).toEqual(["'", 'Tm', 'Tj']);
  });
});

describe("adjust: 'reflow' validation (u3l5.5)", () => {
  const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (aXb) Tj ET'));
  it('accepts reflow and refuses onUnreflowable without it', () => {
    expect(() => doc.Pages[0].ReplaceText('Q', 'Y', { adjust: 'reflow' })).not.toThrow();
    expect(() => doc.Pages[0].ReplaceText('Q', 'Y', { onUnreflowable: () => {} })).toThrow(TypeError);
    expect(() => doc.Pages[0].ReplaceText('Q', 'Y', { adjust: 'reflow', onUnreflowable: 1 as never })).toThrow(TypeError);
  });
});

describe('groupLineBlocks (u3l5.5)', () => {
  it("splits on extractStructured's gap and indent rules", () => {
    const q = (x: number, y: number): { quad: [number, number, number, number] } => ({ quad: [x, y, x + 100, y + 12] });
    // 14pt pitch keeps a block; a 40pt drop or a 40pt indent starts one.
    expect(groupLineBlocks([q(20, 200), q(20, 186), q(20, 146), q(60, 132)])).toEqual([0, 0, 1, 2]);
  });
});
