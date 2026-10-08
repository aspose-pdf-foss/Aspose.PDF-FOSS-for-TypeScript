// m2fp.4: writes test/fixtures/docx/disagreements.json — per corpus file, the
// JSON paths where Word's and LibreOffice's readings of it differ. Run after
// scripts/gen-docx-corpus.ps1; test/docx-corpus.test.ts asserts this file
// EXACTLY, so a regenerated truth that moves a disagreement reddens the build.
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTruth, readerDisagreements } from '../test/helpers/docx-truth.js';

const DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'docx');
const out: Record<string, string[]> = {};
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.docx') && !x.endsWith('-oracle.docx')).sort()) {
  const base = join(DIR, f.replace(/\.docx$/, ''));
  if (!existsSync(`${base}.word.json`) || !existsSync(`${base}.lo.json`)) { out[f] = []; continue; }
  out[f] = readerDisagreements(readTruth(`${base}.word.json`), readTruth(`${base}.lo.json`)).sort();
}
writeFileSync(join(DIR, 'disagreements.json'), JSON.stringify(out, null, 2) + '\n');
for (const [f, d] of Object.entries(out)) console.log(f, d.length);
