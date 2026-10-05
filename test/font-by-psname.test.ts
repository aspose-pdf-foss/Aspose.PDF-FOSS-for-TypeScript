import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Document } from '../src/document.js';
import { readFontNames } from '../src/fontnames.js';

const DIR = fileURLToPath(new URL('./fixtures/fonts/', import.meta.url));
const OTF = new Uint8Array(readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.otf', import.meta.url)));

describe('Document.fontByPostScriptName', () => {
  it('finds a registered face by its exact PostScript name', () => {
    expect(readFontNames(OTF)?.postScriptName).toBe('NimbusSans-Regular');   // fixture precondition
    const doc = Document.New();
    doc.RegisterFontFolder(DIR);
    const f = doc.fontByPostScriptName('NimbusSans-Regular');
    expect(f).toBeDefined();
    expect(doc.fontByPostScriptName('NimbusSans-Regular')).toBe(f);   // one handle, one embedding
  });

  it('does not accept a family-only or differently cased name', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(DIR);
    expect(doc.fontByPostScriptName('NimbusSans')).toBeUndefined();
    expect(doc.fontByPostScriptName('nimbussans-regular')).toBeUndefined();
  });

  it('finds nothing when no folder is registered', () => {
    expect(Document.New().fontByPostScriptName('NimbusSans-Regular')).toBeUndefined();
  });
});
