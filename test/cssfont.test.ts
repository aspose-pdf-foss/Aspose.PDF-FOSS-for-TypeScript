import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { documentFamilyResolver } from '../src/cssfont.js';
import { buildNamedFont } from './helpers/build-sfnt.js';

function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-cssfont-'));
  for (const [rel, bytes] of Object.entries(files)) writeFileSync(join(dir, rel), bytes);
  return dir;
}

describe('the generic families', () => {
  it('maps serif to Times, sans-serif to Helvetica, monospace to Courier', () => {
    const r = documentFamilyResolver(Document.New());
    expect(r(['serif']).regular).toBe('Times-Roman');
    expect(r(['sans-serif']).regular).toBe('Helvetica');
    expect(r(['monospace']).regular).toBe('Courier');
  });

  it('fills all four faces of the generic family', () => {
    // Emphasis is relative to the FAMILY, so a generic must resolve to four
    // faces rather than to one face repeated.
    const r = documentFamilyResolver(Document.New());
    expect(r(['serif'])).toEqual({
      regular: 'Times-Roman', bold: 'Times-Bold',
      italic: 'Times-Italic', boldItalic: 'Times-BoldItalic',
    });
  });

  it('is case-insensitive, as CSS keywords are', () => {
    const r = documentFamilyResolver(Document.New());
    expect(r(['Monospace']).regular).toBe('Courier');
  });

  it('accepts the ui- and system-ui aliases', () => {
    const r = documentFamilyResolver(Document.New());
    expect(r(['ui-serif']).regular).toBe('Times-Roman');
    expect(r(['ui-monospace']).regular).toBe('Courier');
    expect(r(['system-ui']).regular).toBe('Helvetica');
  });

  it('takes the FIRST generic in the list', () => {
    const r = documentFamilyResolver(Document.New());
    expect(r(['monospace', 'serif']).regular).toBe('Courier');
  });
});

describe('the fallback rule', () => {
  it('falls back to sans-serif for a named family that resolves to nothing', () => {
    // font-family: Garamond alone admits no principled answer; a name-to-class
    // table can never be complete, so the rule is stated rather than guessed.
    const r = documentFamilyResolver(Document.New());
    expect(r(['Garamond']).regular).toBe('Helvetica');
  });

  it("uses the list's own generic rather than the default when there is one", () => {
    // The distinguishing case: the default is Helvetica, so a list ending in
    // `serif` must give Times or the fallback is swallowing the generic.
    const r = documentFamilyResolver(Document.New());
    expect(r(['Garamond', 'serif']).regular).toBe('Times-Roman');
  });

  it('falls back for an empty list', () => {
    expect(documentFamilyResolver(Document.New())([]).regular).toBe('Helvetica');
  });
});

describe('registered families', () => {
  it('prefers a registered family over the generic', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = documentFamilyResolver(doc)(['Alpha Sans', 'serif']);
    // An EmbeddedFont, not the string 'Times-Roman'.
    expect(typeof fam.regular).not.toBe('string');
  });

  it('walks the family CHAIN, taking the first that resolves', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = documentFamilyResolver(doc)(['Missing Face', 'Alpha Sans', 'serif']);
    expect(typeof fam.regular).not.toBe('string');
  });

  it('fills an unstated slot from regular rather than leaving it undefined', () => {
    // LoadFontFamily leaves a slot undefined when no face plays that role;
    // mdstyle.resolveFamily is the ONE owner of the fill rule, so a one-face
    // family still comes back with four faces.
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Solo Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = documentFamilyResolver(doc)(['Solo Sans']);
    expect(fam.bold).toBe(fam.regular);
    expect(fam.boldItalic).toBe(fam.regular);
  });

  it('falls through to the generic when no named family resolves', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) }));
    expect(documentFamilyResolver(doc)(['Beta Serif', 'monospace']).regular).toBe('Courier');
  });
});

describe('memoization', () => {
  it('returns the SAME resolved family for a repeated list', () => {
    // buildBoxes asks once per element, so a document of 500 paragraphs asks
    // 500 times for the same list.
    const r = documentFamilyResolver(Document.New());
    expect(r(['serif'])).toBe(r(['serif']));
  });

  it('does not confuse two different lists', () => {
    const r = documentFamilyResolver(Document.New());
    expect(r(['serif']).regular).toBe('Times-Roman');
    expect(r(['monospace']).regular).toBe('Courier');
    expect(r(['serif']).regular).toBe('Times-Roman');
  });

  it('does not confuse a two-family chain with one two-word family', () => {
    // The reason the key joins on NUL rather than a space: under a space
    // ['Alpha', 'Sans'] and ['Alpha Sans'] key IDENTICALLY, and they are
    // different requests.
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const r = documentFamilyResolver(doc);
    // 'Alpha Sans' is installed; neither 'Alpha' nor 'Sans' is, so the chain
    // falls through to the default while the single family resolves.
    expect(typeof r(['Alpha Sans']).regular).not.toBe('string');
    expect(r(['Alpha', 'Sans']).regular).toBe('Helvetica');
  });

  it('hands one document the same resolver twice', () => {
    // Repeated AddHtml on one document must share a warm memo.
    const doc = Document.New();
    expect(documentFamilyResolver(doc)).toBe(documentFamilyResolver(doc));
  });

  it('gives two documents different resolvers', () => {
    // A resolver closes over its document's registered folders, so sharing one
    // across documents would leak one document's fonts into another.
    expect(documentFamilyResolver(Document.New()))
      .not.toBe(documentFamilyResolver(Document.New()));
  });
});
