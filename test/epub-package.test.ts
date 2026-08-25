import { describe, it, expect } from 'vitest';
import { writeEpub, type EpubPart, type EpubMetadata } from '../src/epub.js';
import { parseXml } from '../src/xml.js';
import { unzip, entry, textOf } from './helpers/unzip.js';

const utf8 = (s: string) => new TextEncoder().encode(s);

const META: EpubMetadata = {
  identifier: 'urn:uuid:test', title: 'T', language: 'und',
};

/** A minimal valid package: one nav document and one content document. */
function parts(): EpubPart[] {
  return [
    {
      path: 'nav.xhtml', bytes: utf8('<html/>'), mediaType: 'application/xhtml+xml',
      id: 'nav', properties: 'nav',
    },
    {
      path: 'content.xhtml', bytes: utf8('<html/>'),
      mediaType: 'application/xhtml+xml', id: 'c1', spine: true,
    },
  ];
}

describe('writeEpub', () => {
  it('puts a STORED mimetype first, at the sniffable offset', () => {
    // The one rule a "are all the parts present" test cannot see: a reader
    // identifies an EPUB by reading the media type at byte 38 without
    // inflating anything -- 30 bytes of local header plus the 8-byte name.
    const bytes = writeEpub(parts(), META);
    const zip = unzip(bytes);
    expect(zip[0].path).toBe('mimetype');
    expect(zip[0].method).toBe('store');
    const at38 = new TextDecoder().decode(bytes.slice(38, 38 + 20));
    expect(at38).toBe('application/epub+zip');
  });

  it('points container.xml at an OPF that exists', () => {
    const zip = unzip(writeEpub(parts(), META));
    const container = textOf(zip, 'META-INF/container.xml');
    const full = /full-path="([^"]+)"/.exec(container)?.[1];
    expect(full).toBe('EPUB/package.opf');
    expect(entry(zip, full!)).toBeDefined();
  });

  it('resolves every manifest href to a part', () => {
    const zip = unzip(writeEpub(parts(), META));
    const opf = textOf(zip, 'EPUB/package.opf');
    const hrefs = [...opf.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(2);
    for (const h of hrefs) expect(entry(zip, `EPUB/${h}`)).toBeDefined();
  });

  it('resolves every spine idref to a manifest item', () => {
    const zip = unzip(writeEpub(parts(), META));
    const opf = textOf(zip, 'EPUB/package.opf');
    const ids = new Set([...opf.matchAll(/<item [^>]*id="([^"]+)"/g)].map((m) => m[1]));
    const refs = [...opf.matchAll(/idref="([^"]+)"/g)].map((m) => m[1]);
    expect(refs).toEqual(['c1']);
    for (const r of refs) expect(ids.has(r)).toBe(true);
  });

  it('marks exactly one manifest item as the nav document', () => {
    const opf = textOf(unzip(writeEpub(parts(), META)), 'EPUB/package.opf');
    expect([...opf.matchAll(/properties="nav"/g)]).toHaveLength(1);
  });

  it('emits an OPF and a container that parse as XML', () => {
    const zip = unzip(writeEpub(parts(), META));
    expect(() => parseXml(entry(zip, 'EPUB/package.opf')!.bytes)).not.toThrow();
    expect(() => parseXml(entry(zip, 'META-INF/container.xml')!.bytes)).not.toThrow();
  });

  it('escapes metadata that would otherwise break the OPF', () => {
    const opf = textOf(unzip(writeEpub(parts(), {
      ...META, title: 'A & B <c>',
    })), 'EPUB/package.opf');
    expect(opf).toContain('A &amp; B &lt;c&gt;');
    expect(() => parseXml(new TextEncoder().encode(opf))).not.toThrow();
  });

  it('omits dc:creator when there is no author', () => {
    const opf = textOf(unzip(writeEpub(parts(), META)), 'EPUB/package.opf');
    expect(opf).not.toContain('dc:creator');
  });

  it('rejects a duplicate manifest id', () => {
    const dup = parts();
    dup[1].id = 'nav';
    expect(() => writeEpub(dup, META)).toThrow(TypeError);
  });

  it('is byte-reproducible', () => {
    expect(writeEpub(parts(), META)).toEqual(writeEpub(parts(), META));
  });
});
