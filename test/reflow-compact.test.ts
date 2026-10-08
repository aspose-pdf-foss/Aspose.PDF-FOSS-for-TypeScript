// r9u0: repeated reflows must not accumulate dead text-positioning operators.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseContentStream, serializeContentStream, type ContentOp } from '../src/content.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { dropDeadPositioning } from '../src/textedit.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const serializeContentOps = (o: ContentOp[]) => new TextDecoder('latin1').decode(serializeContentStream(o));

const LONG = 'Documentation of internationalization requirements demonstrates extraordinary responsibility and considerable organizational flexibility throughout implementation';
const SEQ = ['Documentation', 'Documentation and analysis', 'Docs', 'Documentation of this', 'D', 'Documentation again here', 'Doc'];
/** sha256 (16 hex) of every drawn glyph's text@origin after each step, recorded
 *  BEFORE r9u0 — a FENCE that compaction moves no glyph. */
const POSITIONS = ['9f7bb907f0fc5097', '1e188c3c7b28436f', '9c83bece26670cd0', 'a335c755ffede3e2', '8615897e19794607', '6b70160e68d6e84a'];

const positions = (doc: Document) => {
  const gs: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (g) => gs.push(g) });
  const s = gs.filter((g) => g.text.trim()).map((g) => `${g.text}@${g.quad[0].toFixed(3)},${g.quad[1].toFixed(3)}`);
  return createHash('sha256').update(s.join('|')).digest('hex').slice(0, 16);
};
const count = (doc: Document, operator: string) =>
  parseContentStream(doc.Pages[0].Contents).filter((o) => o.operator === operator).length;

describe('reflow writes no superseded positioning (r9u0)', () => {
  it('six reflows in a row keep the stream bounded and every glyph where it was', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock(LONG, [72, 400, 200, 300], { fontSize: 12 });
    let doc = Document.Open(d.Save());
    for (let i = 1; i < SEQ.length; i++) {
      doc.Pages[0].ReplaceText(SEQ[i - 1], SEQ[i], { adjust: 'reflow' });
      doc = Document.Open(doc.Save());
      expect(positions(doc)).toBe(POSITIONS[i - 1]);
      // Six lines, at most two positioned runs each: one Tm per run.
      expect(count(doc, 'Tm')).toBeLessThanOrEqual(12);
      // A TJ holding only kerns draws nothing; none may be left.
      for (const o of parseContentStream(doc.Pages[0].Contents)) {
        if (o.operator === 'TJ') expect((o.operands[0] as unknown[]).some((x) => typeof x !== 'number')).toBe(true);
      }
    }
  });
});

describe('only a stream the reflow wrote a Tm into is compacted', () => {
  // A producer's own dead `Td` before a `Tm`: kept unless the reflow touched it.
  const S = 'BT /F1 12 Tf 0 -14 Td 1 0 0 1 20 280 Tm (alpha beta gamma) Tj 0 -14 Td (delta epsilon) Tj ET';
  it('a plain ReplaceText, and adjust: shiftRest, leave it in place', () => {
    for (const adjust of [undefined, 'shiftRest'] as const) {
      const doc = Document.Open(buildSimpleTextPdf(S));
      doc.Pages[0].ReplaceText('beta', 'BETA', adjust ? { adjust } : {});
      expect(new TextDecoder('latin1').decode(doc.Pages[0].Contents)).toMatch(/-14 Td\s+1 0 0 1 20 280 Tm/);
    }
  });
  it('a reflow drops it (non-vacuous control)', () => {
    const doc = Document.Open(buildSimpleTextPdf(S));
    doc.Pages[0].ReplaceText('beta', 'betabetabetabeta', { adjust: 'reflow' });
    expect(new TextDecoder('latin1').decode(doc.Pages[0].Contents)).not.toMatch(/-14 Td\s+1 0 0 1 20 280 Tm/);
  });
});

describe('dropDeadPositioning', () => {
  const ops = (s: string) => parseContentStream(new TextEncoder().encode(s));
  const text = (s: string) => serializeContentOps(dropDeadPositioning(ops(s)));
  it('drops what a later Tm supersedes, a string-less TJ included', () => {
    expect(text('BT 1 0 0 1 9 9 Tm 0 -14 Td [5] TJ T* 1 0 0 1 20 20 Tm (a) Tj ET'))
      .toBe(text('BT 1 0 0 1 20 20 Tm (a) Tj ET'));
  });
  it('drops positioning right before ET', () => {
    expect(text('BT (a) Tj 1 0 0 1 9 9 Tm 0 -14 Td ET')).toBe(text('BT (a) Tj ET'));
  });
  // Compared against the UNTOUCHED serialization: comparing text(s) with
  // text(s) put both sides through the pass and could never fail.
  const raw = (s: string) => serializeContentOps(ops(s));
  it('keeps a TD, which also sets the leading', () => {
    const s = 'BT 0 -14 TD 1 0 0 1 20 20 Tm (a) Tj T* (b) Tj ET';
    expect(text(s)).toBe(raw(s));
  });
  it('keeps positioning a show op reads, and anything between that is not positioning', () => {
    const s = 'BT 0 -14 Td (a) Tj 1 0 0 rg 1 0 0 1 20 20 Tm (b) Tj ET';
    expect(text(s)).toBe(raw(s));
  });
  it('renders identically', () => {
    const s = 'BT /F1 12 Tf 1 0 0 1 9 9 Tm 0 -14 Td [500] TJ 1 0 0 1 20 200 Tm (alpha) Tj 0 -14 Td 1 0 0 1 20 150 Tm (beta) Tj 1 0 0 1 5 5 Tm ET';
    const kept = serializeContentOps(dropDeadPositioning(ops(s)));
    expect(kept.length).toBeLessThan(s.length);                     // non-vacuous
    const draw = (c: string) => Buffer.from(Document.Open(buildSimpleTextPdf(c)).Pages[0].ToImage({ scale: 1 }));
    expect(Buffer.compare(draw(kept), draw(s))).toBe(0);
  });
});
