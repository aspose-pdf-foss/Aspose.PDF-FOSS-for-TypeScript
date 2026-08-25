import { describe, it, expect } from 'vitest';
import { buildOoxmlPackage } from '../src/ooxml.js';
import { unzip, entry, textOf } from './helpers/unzip.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const XML = 'application/xml';

describe('buildOoxmlPackage', () => {
  it('declares every part in [Content_Types].xml', () => {
    const zip = buildOoxmlPackage(
      [{ path: 'word/document.xml', bytes: bytes('<a/>'), contentType: 'application/x-main' }],
      [{ source: '', id: 'rId1', type: 'http://x/officeDocument', target: 'word/document.xml' }],
    );
    const ct = textOf(unzip(zip), '[Content_Types].xml');
    expect(ct).toContain('PartName="/word/document.xml"');
    expect(ct).toContain('ContentType="application/x-main"');
  });

  // The extension default covers .rels; listing one as an override is a
  // conformance error a lenient reader hides.
  it('covers .rels by extension default, not by an override', () => {
    const zip = buildOoxmlPackage(
      [{ path: 'word/document.xml', bytes: bytes('<a/>'), contentType: XML }],
      [{ source: '', id: 'rId1', type: 'http://x/od', target: 'word/document.xml' }],
    );
    const ct = textOf(unzip(zip), '[Content_Types].xml');
    expect(ct).toContain('Extension="rels"');
    expect(ct).not.toContain('PartName="/_rels/.rels"');
  });

  it('writes the package-root relationships to _rels/.rels', () => {
    const zip = buildOoxmlPackage(
      [{ path: 'word/document.xml', bytes: bytes('<a/>'), contentType: XML }],
      [{ source: '', id: 'rId1', type: 'http://x/od', target: 'word/document.xml' }],
    );
    const rels = textOf(unzip(zip), '_rels/.rels');
    expect(rels).toContain('Id="rId1"');
    expect(rels).toContain('Target="word/document.xml"');
  });

  // A target is relative to its SOURCE part's directory. Getting this wrong
  // yields a package whose parts all exist and whose links all dangle.
  it('writes a part relationship beside its source, targeted relatively', () => {
    const zip = buildOoxmlPackage(
      [
        { path: 'word/document.xml', bytes: bytes('<a/>'), contentType: XML },
        { path: 'word/styles.xml', bytes: bytes('<b/>'), contentType: XML },
      ],
      [
        { source: '', id: 'rId1', type: 'http://x/od', target: 'word/document.xml' },
        { source: 'word/document.xml', id: 'rId1', type: 'http://x/styles', target: 'styles.xml' },
      ],
    );
    const rels = textOf(unzip(zip), 'word/_rels/document.xml.rels');
    expect(rels).toContain('Target="styles.xml"');
    // The part it resolves to exists.
    expect(entry(unzip(zip), 'word/styles.xml')).toBeDefined();
  });

  it('marks an external relationship as external', () => {
    const zip = buildOoxmlPackage(
      [{ path: 'word/document.xml', bytes: bytes('<a/>'), contentType: XML }],
      [
        { source: '', id: 'rId1', type: 'http://x/od', target: 'word/document.xml' },
        {
          source: 'word/document.xml', id: 'rId2', type: 'http://x/hyperlink',
          target: 'https://example.com/a&b', external: true,
        },
      ],
    );
    const rels = textOf(unzip(zip), 'word/_rels/document.xml.rels');
    expect(rels).toContain('TargetMode="External"');
    expect(rels).toContain('https://example.com/a&amp;b');   // escaped
  });

  it('stores a part marked store, and deflates the rest', () => {
    const zip = buildOoxmlPackage(
      [
        { path: 'word/document.xml', bytes: bytes('<a/>'), contentType: XML },
        { path: 'word/media/i.jpg', bytes: bytes('x'.repeat(200)), contentType: 'image/jpeg', store: true },
      ],
      [{ source: '', id: 'rId1', type: 'http://x/od', target: 'word/document.xml' }],
    );
    const es = unzip(zip);
    expect(entry(es, 'word/media/i.jpg')!.method).toBe('store');
    expect(entry(es, '[Content_Types].xml')!.method).toBe('deflate');
  });

  it('rejects a part with no content type', () => {
    expect(() => buildOoxmlPackage(
      [{ path: 'word/document.xml', bytes: bytes('<a/>'), contentType: '' }], [],
    )).toThrow();
  });
});
