import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildTabOracleDocx, TAB_ORACLE_CASES } from './helpers/build-tab-oracle.js';

// v9j3.1: where Word 2010 puts the character after each kind of tab stop, read
// through COM by scripts/gen-tab-oracle.ps1. Courier New against our Courier:
// one 600-unit advance, so every case — right, centre and decimal included —
// is metric-exact.
const DIR = join(__dirname, 'fixtures', 'docx');
const word = JSON.parse(readFileSync(join(DIR, 'tab-oracle.json'), 'utf8')) as
  { word: string; rows: { char: string; x: number; font: string }[] };

describe('tab stops land where Word puts them (v9j3.1 oracle)', () => {
  it('the vendored document is the one the builder writes', () => {
    expect(Buffer.compare(readFileSync(join(DIR, 'tab-oracle.docx')), Buffer.from(buildTabOracleDocx()))).toBe(0);
  });

  it('Word measured every case, in the face the fixture states', () => {
    expect(word.rows.map((r) => r.char)).toEqual(TAB_ORACLE_CASES.map((c) => c.marker));
    for (const r of word.rows) expect(r.font).toBe('Courier New');
  });

  const d = Document.New();
  d.AddDocx(readFileSync(join(DIR, 'tab-oracle.docx')));
  const doc = Document.Open(d.Save());
  const at = new Map<string, number>();
  for (const p of doc.Pages) visitContent(doc, p, { glyph: (g: GlyphEvent) => { if (!at.has(g.text)) at.set(g.text, g.quad[0]); } });
  for (const c of TAB_ORACLE_CASES) {
    it(c.id, () => {
      const w = word.rows.find((r) => r.char === c.marker)!;
      // 0.5pt: Word lays out in twips (1/20pt); every case here is exact.
      expect(Math.abs(at.get(c.marker)! - w.x)).toBeLessThan(0.5);
    });
  }
});
