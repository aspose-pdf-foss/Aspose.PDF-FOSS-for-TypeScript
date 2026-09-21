import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ibzo.3's rule, enforced over the whole source tree: EVERY catch clause in
// src/ calls rethrowLimit on its binding before anything else.
//
// Why every one and not the ones "on a decode path": a catch that keeps going
// past damage — a per-object parse, a salvage, an image that degrades to
// nothing — is exactly where a ResourceLimitError would be swallowed, and the
// set of catches a decode can reach is not something anyone can keep in their
// head. Swallowed, the bound refuses nothing: a refused zip bomb renders as a
// blank image and nobody is told. A catch no limit can reach pays one
// instanceof test for the certainty.
//
// The scan is deliberately textual rather than an AST walk: it must be cheap,
// and a false positive here is a red build naming the line, not a silent pass.

const SRC = join(__dirname, '..', 'src');
const CATCH = /\bcatch\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*(?::\s*[\w$]+)?\s*\))?\s*\{/g;

interface Site { file: string; line: number; text: string }

function offenders(): Site[] {
  const out: Site[] = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith('.ts'))) {
    if (f === 'errors.ts') continue;
    const src = readFileSync(join(SRC, f), 'utf8');
    for (const m of src.matchAll(CATCH)) {
      const lineStart = src.lastIndexOf('\n', m.index!) + 1;
      const head = src.slice(lineStart, m.index).trim();
      if (head.startsWith('//') || head.startsWith('*') || head.startsWith('/*')) continue;
      const before = src.slice(lineStart, m.index);
      if ((before.match(/'/g) ?? []).length % 2 === 1 || (before.match(/`/g) ?? []).length % 2 === 1) continue;
      const binding = m[1];
      const rest = src.slice(m.index! + m[0].length);
      const ok = binding !== undefined && new RegExp(`^\\s*rethrowLimit\\(\\s*${binding}\\s*\\)`).test(rest);
      if (!ok) {
        const line = src.slice(0, m.index).split('\n').length;
        out.push({ file: f, line, text: src.slice(lineStart, src.indexOf('\n', m.index!)).trim() });
      }
    }
  }
  return out;
}

describe('every catch in src/ rethrows a ResourceLimitError first', () => {
  it('has no offender', () => {
    const bad = offenders().map((s) => `src/${s.file}:${s.line}  ${s.text}`);
    expect(bad, `add \`rethrowLimit(e)\` as the first statement:\n${bad.join('\n')}`).toEqual([]);
  });

  it('actually finds catch clauses, so a broken pattern cannot pass by matching nothing', () => {
    // The sweep this repo records under k738 printed nothing on any tree for a
    // regex that parsed zero edges. Asserting a floor is what stops that.
    let seen = 0;
    for (const f of readdirSync(SRC).filter((n) => n.endsWith('.ts'))) {
      seen += [...readFileSync(join(SRC, f), 'utf8').matchAll(CATCH)].length;
    }
    expect(seen).toBeGreaterThan(150);
  });
});
