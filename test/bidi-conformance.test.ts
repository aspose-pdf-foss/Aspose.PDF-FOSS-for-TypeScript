import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { paragraphLevel, resolveLevels, reorder } from '../src/bidi.js';

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, 'fixtures/unicode/BidiCharacterTest.txt'), 'utf8');
const DIR = { 0: 'ltr', 1: 'rtl', 2: 'auto' } as const;

interface Row { line: number; codes: number[]; dir: 'ltr' | 'rtl' | 'auto'; paraLevel: number; levels: (number | null)[]; order: number[]; }
const rows: Row[] = [];
text.split('\n').forEach((raw, idx) => {
  const line = raw.split('#')[0].trim();
  if (!line) return;
  const f = line.split(';');
  if (f.length < 5) return;
  const codes = f[0].trim().split(/\s+/).map((h) => parseInt(h, 16));
  const levels = f[3].trim().split(/\s+/).map((s) => (s === 'x' ? null : Number(s)));
  const order = f[4].trim() ? f[4].trim().split(/\s+/).map(Number) : [];
  rows.push({ line: idx + 1, codes, dir: DIR[Number(f[1]) as 0 | 1 | 2], paraLevel: Number(f[2]), levels, order });
});

describe('UAX #9 conformance (BidiCharacterTest.txt)', () => {
  it('loads the full test file', () => { expect(rows.length).toBeGreaterThan(90000); });

  it('every row: paragraph level, levels, and reorder match', () => {
    const failures: string[] = [];
    for (const r of rows) {
      const pl = paragraphLevel(r.codes, r.dir);
      if (pl !== r.paraLevel) { failures.push(`L${r.line}: paraLevel ${pl}!=${r.paraLevel}`); if (failures.length > 20) break; continue; }
      const { levels, removed } = resolveLevels(r.codes, pl as 0 | 1);
      for (let i = 0; i < r.codes.length; i++) {
        const exp = r.levels[i];
        if (exp === null) { if (!removed[i]) failures.push(`L${r.line}[${i}]: expected removed, got ${levels[i]}`); }
        else if (removed[i] || levels[i] !== exp) failures.push(`L${r.line}[${i}]: level ${removed[i] ? 'x' : levels[i]}!=${exp}`);
      }
      const ord = reorder(r.codes, levels, removed, pl as 0 | 1);
      if (ord.join(',') !== r.order.join(',')) failures.push(`L${r.line}: reorder ${ord.join(' ')} != ${r.order.join(' ')}`);
      if (failures.length > 20) break;
    }
    expect(failures.slice(0, 20).join('\n')).toBe('');
  });
});
