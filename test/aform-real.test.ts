import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { parseAfCall } from '../src/afcall.js';

// dates.pdf: authored in Adobe Acrobat 25.1 by a pdf.js maintainer for pdf.js
// commit 57ce4f8f4 (Apache-2.0). See test/fixtures/aform/PROVENANCE.md.
const FILE = new URL('./fixtures/aform/real/dates.pdf', import.meta.url);

function afScripts(doc: Document): string[] {
  return doc.Form.Fields.flatMap((f) => Object.values(f.Actions))
    .filter((a) => a?.type === 'javascript' && /\bAF[A-Za-z_]+\(/.test(a.script))
    .map((a) => (a as { script: string }).script);
}

it('recognises every single-call AF script Acrobat wrote in a real form', () => {
  const scripts = afScripts(Document.Open(readFileSync(FILE)));
  expect(scripts.length).toBe(6);
  expect(scripts.filter((s) => parseAfCall(s) !== undefined).length).toBe(5);
});

it('refuses the one call whose argument is not the documented type', () => {
  // AFTime_Keystroke takes a format INDEX; this file passes a picture string.
  // pdf.js turns it into a no-op; we report it rather than guess.
  const refused = afScripts(Document.Open(readFileSync(FILE))).filter((s) => parseAfCall(s) === undefined);
  expect(refused).toEqual(['AFTime_Keystroke("HH:MM:ss");']);
});

it('runs Recalculate and CheckValues on it without throwing', () => {
  const doc = Document.Open(readFileSync(FILE));
  expect(() => doc.Form.Recalculate()).not.toThrow();
  expect(() => doc.Form.CheckValues()).not.toThrow();
});
