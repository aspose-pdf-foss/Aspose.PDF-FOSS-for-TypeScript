import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readDocx } from '../src/wmlread.js';
import type { WmlParagraph, WmlText } from '../src/wmlbody.js';
import { buildWmlOracleDocx } from './helpers/build-wml-oracle.js';

// Microsoft Word's COMPUTED formatting for a document we authored
// (test/fixtures/docx/PROVENANCE.md). Word, not our reading of ECMA-376, is the
// oracle here; a disagreement is fixed in src/, never in the JSON.
interface OracleWord {
  text: string; bold: boolean; italic: boolean; size: number; name: string; nameAscii: string;
  color: number; underline: boolean; strike: boolean; highlight: number; shading: number;
}
interface OraclePara { text: string; listString: string | null; outlineLevel: number; words: OracleWord[] }
const DIR = join(__dirname, 'fixtures', 'docx');
const oracle = JSON.parse(readFileSync(join(DIR, 'wml-oracle.json'), 'utf8')) as { word: string; paragraphs: OraclePara[] };
const bytes = new Uint8Array(readFileSync(join(DIR, 'wml-oracle.docx')));

const WD_AUTO = -16777216;
const bgr = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const to255 = (rgb: number[] | undefined): number[] | undefined => rgb?.map((c) => Math.round(c * 255));
const WD_HIGHLIGHT: Record<number, number[] | undefined> = { 0: undefined, 7: [255, 255, 0] };
const textOf = (p: WmlParagraph): string => p.inlines.map((i) => (i.kind === 'text' ? i.text : '')).join('');

describe('the WordprocessingML model agrees with Microsoft Word', () => {
  it('reads the vendored oracle document, which the builder still reproduces', () => {
    expect(createHash('sha256').update(bytes).digest('hex'))
      .toBe(createHash('sha256').update(buildWmlOracleDocx()).digest('hex'));
  });

  const paras = readDocx(bytes).blocks.filter((b): b is WmlParagraph => b.kind === 'paragraph');

  it('has Word\'s paragraphs and their text', () => {
    expect(paras.map(textOf)).toEqual(oracle.paragraphs.map((p) => p.text));
  });

  it('agrees on every list label and heading level', () => {
    const ours = paras.map((p) => [p.list?.label ?? '', p.heading ?? 10]);
    const word = oracle.paragraphs.map((p) => [p.listString ?? '', p.outlineLevel]);
    expect(ours).toEqual(word);
  });

  it('agrees on every word\'s formatting', () => {
    const mismatches: string[] = [];
    oracle.paragraphs.forEach((op, i) => {
      for (const w of op.words) {
        const run = paras[i]?.inlines.find((x): x is WmlText => x.kind === 'text' && x.text.split(/\s+/).includes(w.text));
        if (!run) { mismatches.push(`${i}:${w.text}: no run`); continue; }
        const got = run.props;
        const face = w.name.startsWith('+') ? w.nameAscii : w.name;
        const want: Record<string, unknown> = {
          bold: w.bold, italic: w.italic, underline: w.underline, strike: w.strike, sizePt: w.size,
          color: w.color === WD_AUTO ? undefined : bgr(w.color),
          highlight: w.highlight !== 0 ? WD_HIGHLIGHT[w.highlight] : w.shading === WD_AUTO ? undefined : bgr(w.shading),
        };
        if (!face.startsWith('+')) want.font = face;
        const have: Record<string, unknown> = {
          bold: got.bold, italic: got.italic, underline: got.underline, strike: got.strike, sizePt: got.sizePt,
          color: to255(got.color), highlight: to255(got.highlight),
        };
        if ('font' in want) have.font = got.font;
        for (const k of Object.keys(want))
          if (JSON.stringify(want[k]) !== JSON.stringify(have[k])) mismatches.push(`${i}:${w.text}.${k}: Word ${JSON.stringify(want[k])}, ours ${JSON.stringify(have[k])}`);
      }
    });
    expect(mismatches).toEqual([]);
  });
});
