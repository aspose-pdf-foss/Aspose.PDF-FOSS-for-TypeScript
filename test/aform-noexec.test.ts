// test/aform-noexec.test.ts
import { it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

// 6t2v.2: the library never executes JavaScript. This fails the build if any
// src module reaches for an evaluator.
it('src/ contains no JavaScript evaluator', () => {
  const dir = new URL('../src/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(300);
  const hits = files.filter((f) => {
    const src = readFileSync(new URL(f, dir), 'utf8');
    return /\beval\s*\(|\bnew\s+Function\s*\(|(?<![.\w])Function\s*\(|['"]node:vm['"]/.test(src);
  });
  expect(hits).toEqual([]);
});
