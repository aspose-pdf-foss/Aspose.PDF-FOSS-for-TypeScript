import { describe, it, expect } from 'vitest';
import { writeDocx } from '../src/docxpackage.js';
import { unzip, entry, textOf } from './helpers/unzip.js';

describe('writeDocx', () => {
  it('writes the three parts a conformant .docx needs', () => {
    const es = unzip(writeDocx(''));
    for (const p of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ]) expect(entry(es, p), p).toBeDefined();
  });

  // A relationships part with no relationships is legal and says nothing, and
  // emitting one would need a DOCX special case inside the format-neutral
  // layer. 8yt9.2's first image or hyperlink brings it into being through the
  // same path every other .rels uses.
  it('writes no document.xml.rels until something needs one', () => {
    expect(entry(unzip(writeDocx('')), 'word/_rels/document.xml.rels')).toBeUndefined();
  });

  it('starts with the ZIP signature, so the file is recognisable', () => {
    expect(Array.from(writeDocx('').slice(0, 2))).toEqual([0x50, 0x4b]);
  });

  it('declares the WordprocessingML namespace and an XML declaration', () => {
    const doc = textOf(unzip(writeDocx('')), 'word/document.xml');
    expect(doc.startsWith('<?xml version="1.0"')).toBe(true);
    expect(doc).toContain(
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"');
    expect(doc).toContain('<w:body>');
    expect(doc).toContain('</w:document>');
  });

  it('places the caller body inside w:body', () => {
    const doc = textOf(unzip(writeDocx('<w:p/>')), 'word/document.xml');
    expect(doc).toContain('<w:body><w:p/></w:body>');
  });

  // Every relationship must resolve to a part that exists, or the package has
  // links that dangle while every part is present.
  it('resolves every relationship to a part in the package', () => {
    const es = unzip(writeDocx(''));
    const paths = new Set(es.map((e) => e.path));
    const root = textOf(es, '_rels/.rels');
    for (const m of root.matchAll(/Target="([^"]+)"/g)) {
      expect(paths.has(m[1]), m[1]).toBe(true);
    }
  });

  it('declares every non-rels part in [Content_Types].xml', () => {
    const es = unzip(writeDocx(''));
    const ct = textOf(es, '[Content_Types].xml');
    for (const e of es) {
      if (e.path === '[Content_Types].xml' || e.path.endsWith('.rels')) continue;
      expect(ct, e.path).toContain(`PartName="/${e.path}"`);
    }
  });

  it('is byte-reproducible', () => {
    expect(Buffer.from(writeDocx('<w:p/>'))).toEqual(Buffer.from(writeDocx('<w:p/>')));
  });
});
