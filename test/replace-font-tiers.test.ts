import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { visitContent } from '../src/text.js';
import type { TextFont } from '../src/font.js';
import { assignRuns, checkReplaceOptions, type Run } from '../src/replacefont.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const LIB = new Uint8Array(readFileSync(new URL('./fixtures/fonts/LiberationSans-Regular.woff2', import.meta.url)));
const helv = (): TextFont => {
  const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (A) Tj ET'));
  let f: TextFont | undefined;
  visitContent(doc, doc.Pages[0], { glyph: (e) => { f ??= e.font; } });
  return f!;
};
const show = (runs: Run[]) => runs.map((r) =>
  r.font === 'original' ? `O:${String.fromCharCode(...r.bytes)}` : `${typeof r.font === 'string' ? r.font : 'E'}:${r.text}`);

describe('checkReplaceOptions', () => {
  it('accepts nothing, and every valid option', () => {
    const lib = Document.New().AddFont(LIB);
    expect(checkReplaceOptions(undefined)).toEqual({});
    expect(() => checkReplaceOptions({ fallbackFonts: ['Helvetica', lib], matchRegisteredFonts: true, onUndrawable: () => {} })).not.toThrow();
  });

  it.each([
    [{ fallbackFonts: 'Helvetica' }, /fallbackFonts must be an array/],
    [{ fallbackFonts: ['Symbol'] }, /neither a Standard-14 authoring face/],
    [{ fallbackFonts: [42] }, /neither a Standard-14 authoring face/],
    [{ matchRegisteredFonts: 'yes' }, /matchRegisteredFonts must be a boolean/],
    [{ onUndrawable: 'log' }, /onUndrawable must be a function/],
  ])('refuses %j', (o, msg) => {
    expect(() => checkReplaceOptions(o as never)).toThrow(TypeError);
    expect(() => checkReplaceOptions(o as never)).toThrow(msg);
  });
});

describe('assignRuns', () => {
  it('keeps what the original font draws as one original run', () => {
    const out: Run[] = [], missing: string[] = [];
    assignRuns('ab', { original: helv(), fallbacks: ['Times-Roman'] }, out, missing);
    expect(show(out)).toEqual(['O:ab']);
    expect(missing).toEqual([]);
  });

  it('switches per character, in runs', () => {
    const lib = Document.New().AddFont(LIB);
    const out: Run[] = [], missing: string[] = [];
    assignRuns('a\u03A9\u03A9b', { original: helv(), fallbacks: [lib] }, out, missing);
    expect(show(out)).toEqual(['O:a', 'E:\u03A9\u03A9', 'O:b']);
  });

  it('tries the registered face before the fallbacks', () => {
    const d = Document.New();
    const first = d.AddFont(LIB), second = d.AddFont(LIB);
    const out: Run[] = [];
    assignRuns('\u03A9', { original: helv(), registered: first, fallbacks: [second] }, out, []);
    expect(out[0].font).toBe(first);
  });

  it('omits and reports a character no tier draws', () => {
    const out: Run[] = [], missing: string[] = [];
    assignRuns('a\u03A9b', { original: helv(), fallbacks: ['Times-Roman'] }, out, missing);
    expect(show(out)).toEqual(['O:ab']);
    expect(missing).toEqual(['\u03A9']);
  });
});
