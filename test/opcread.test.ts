import { describe, it, expect } from 'vitest';
import { openOpc, OFFICE_DOCUMENT, STYLES, IMAGE, HYPERLINK } from '../src/opcread.js';
import { writeZip } from '../src/zip.js';
import { LoadLimits } from '../src/loadlimits.js';
import { PdfParseError, ResourceLimitError } from '../src/errors.js';
import { enc, dec } from './helpers/zip-bytes.js';

const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const RELS_CT = 'application/vnd.openxmlformats-package.relationships+xml';

/** A [Content_Types].xml with the two usual Defaults plus `extra`. */
const CT = (extra = ''): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${CT_NS}">`
  + `<Default Extension="rels" ContentType="${RELS_CT}"/>`
  + `<Default Extension="xml" ContentType="application/xml"/>${extra}</Types>`;
const RELS = (...items: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}">${items.join('')}</Relationships>`;
const rel = (id: string, type: string, target: string, mode?: string): string =>
  `<Relationship Id="${id}" Type="${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`;
/** A zip of the given files, in insertion order. */
function pkg(files: Record<string, string | Uint8Array>): Uint8Array {
  return writeZip(Object.entries(files).map(([path, v]) =>
    ({ path, bytes: typeof v === 'string' ? enc(v) : v })));
}
const limit = (n: number) => LoadLimits.defaults.with({ maxContainerItems: n });

describe('openOpc: content types', () => {
  it('answers an Override before the Default for its extension', () => {
    const p = openOpc(pkg({
      '[Content_Types].xml': CT('<Override PartName="/word/document.xml" ContentType="application/x-main"/>'),
      'word/document.xml': '<d/>', 'word/other.xml': '<o/>',
    }));
    expect(p.contentType('word/document.xml')).toBe('application/x-main');
    expect(p.contentType('word/other.xml')).toBe('application/xml');
  });

  it('matches Override part names and Default extensions ASCII-case-insensitively', () => {
    const p = openOpc(pkg({
      '[Content_Types].xml': CT('<Override PartName="/Word/Document.XML" ContentType="application/x-main"/>'
        + '<Default Extension="PNG" ContentType="image/png"/>'),
      'word/document.xml': '<d/>', 'word/media/a.png': 'x',
    }));
    expect(p.contentType('word/document.xml')).toBe('application/x-main');
    expect(p.contentType('word/media/a.Png')).toBe('image/png');
  });

  it('percent-decodes an Override PartName', () => {
    const p = openOpc(pkg({
      '[Content_Types].xml': CT('<Override PartName="/word/m%C3%A9dia.xml" ContentType="application/x-m"/>'),
      'word/média.xml': '<m/>',
    }));
    expect(p.contentType('word/média.xml')).toBe('application/x-m');
  });

  it('answers undefined for a part with no Override and no matching Default', () => {
    const p = openOpc(pkg({ '[Content_Types].xml': CT(), 'a.bin': 'x', 'noext': 'y' }));
    expect(p.contentType('a.bin')).toBeUndefined();
    expect(p.contentType('noext')).toBeUndefined();
  });

  it('takes the extension from the last segment only', () => {
    const p = openOpc(pkg({ '[Content_Types].xml': CT(), 'dir.xml/file': 'x' }));
    expect(p.contentType('dir.xml/file')).toBeUndefined();
  });

  it('parses a content-types file that starts with a UTF-8 BOM', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(CT())]);
    const p = openOpc(pkg({ '[Content_Types].xml': bom, 'a.xml': '<a/>' }));
    expect(p.contentType('a.xml')).toBe('application/xml');
  });

  it('finds a content-types file stored under a different case', () => {
    const p = openOpc(pkg({ '[content_types].XML': CT(), 'a.xml': '<a/>' }));
    expect(p.contentType('a.xml')).toBe('application/xml');
  });
});

describe('openOpc: part lookup', () => {
  const p = () => openOpc(pkg({ '[Content_Types].xml': CT(), 'word/Document.xml': '<d/>' }));

  it('finds a part by exact name and by case-folded name', () => {
    expect(p().has('word/Document.xml')).toBe(true);
    expect(p().has('WORD/document.XML')).toBe(true);
    expect(dec(p().read('word/document.xml'))).toBe('<d/>');
  });

  it('refuses reading an absent part as a caller error', () => {
    expect(p().has('word/missing.xml')).toBe(false);
    expect(() => p().read('word/missing.xml')).toThrow(RangeError);
  });

  it('exposes the underlying archive', () => {
    expect(p().zip.entries.map((e) => e.path)).toContain('word/Document.xml');
  });
});

describe('openOpc: damage', () => {
  it('refuses a zip with no [Content_Types].xml', () => {
    expect(() => openOpc(pkg({ 'a.xml': '<a/>' }))).toThrow(/Content_Types/);
    expect(() => openOpc(pkg({ 'a.xml': '<a/>' }))).toThrow(PdfParseError);
  });

  it('refuses a content-types file that is not well-formed', () => {
    expect(() => openOpc(pkg({ '[Content_Types].xml': '<Types><Default' }))).toThrow(PdfParseError);
  });

  it('refuses a content-types file whose root is not Types', () => {
    expect(() => openOpc(pkg({ '[Content_Types].xml': '<Other/>' }))).toThrow(PdfParseError);
  });

  it('refuses two entry names that differ only by case', () => {
    expect(() => openOpc(pkg({ '[Content_Types].xml': CT(), 'a.xml': '1', 'A.xml': '2' })))
      .toThrow(/differ only by case/);
  });

  it('refuses a duplicate Override PartName, compared case-insensitively', () => {
    const ct = CT('<Override PartName="/a.xml" ContentType="x/1"/><Override PartName="/A.XML" ContentType="x/2"/>');
    expect(() => openOpc(pkg({ '[Content_Types].xml': ct }))).toThrow(PdfParseError);
  });

  it('refuses a duplicate Default Extension, compared case-insensitively', () => {
    expect(() => openOpc(pkg({ '[Content_Types].xml': CT('<Default Extension="XML" ContentType="x/2"/>') })))
      .toThrow(PdfParseError);
  });

  it('refuses a Default or Override missing a required attribute', () => {
    expect(() => openOpc(pkg({ '[Content_Types].xml': CT('<Default Extension="png"/>') }))).toThrow(PdfParseError);
    expect(() => openOpc(pkg({ '[Content_Types].xml': CT('<Override ContentType="x/y"/>') }))).toThrow(PdfParseError);
  });

  // Final review I1: an Override naming what no part name may be (an encoded
  // separator, or a dot segment) would match a part no conforming reader has.
  it('refuses an Override PartName with an encoded separator or a dot segment', () => {
    for (const name of ['/a%2Fb.xml', '/a%5cb.xml', '/word/../x.xml', '/word/%2e%2e/x.xml', '/./x.xml'])
      expect(() => openOpc(pkg({ '[Content_Types].xml': CT(`<Override PartName="${name}" ContentType="x/y"/>`) })), name)
        .toThrow(PdfParseError);
  });

  it('refuses an Override PartName whose percent-encoding is malformed', () => {
    expect(() => openOpc(pkg({ '[Content_Types].xml': CT('<Override PartName="/a%ZZ.xml" ContentType="x/y"/>') })))
      .toThrow(PdfParseError);
  });
});

describe('openOpc: limits', () => {
  // Two zip entries, so zipread's own entry count stays under the bound.
  it('counts content-type entries against maxContainerItems as they are produced', () => {
    const three = pkg({ '[Content_Types].xml': CT('<Default Extension="png" ContentType="image/png"/>'), 'a.xml': '<a/>' });
    expect(() => openOpc(three, limit(2))).toThrow(ResourceLimitError);
    expect(() => openOpc(three, limit(3))).not.toThrow();
  });
});


const MAIN_RELS = RELS(
  rel('rId3', IMAGE, 'media/a.png'),
  rel('rId1', STYLES, 'styles.xml'),
  rel('rId9', HYPERLINK, 'https://example.com/x?y=1#z', 'External'),
);
const docPkg = (mainRels: string = MAIN_RELS, extra: Record<string, string> = {}) => pkg({
  '[Content_Types].xml': CT('<Default Extension="png" ContentType="image/png"/>'),
  '_rels/.rels': RELS(rel('rId1', OFFICE_DOCUMENT, 'word/document.xml')),
  'word/document.xml': '<d/>',
  'word/_rels/document.xml.rels': mainRels,
  'word/styles.xml': '<s/>',
  'word/media/a.png': 'png',
  ...extra,
});

describe('openOpc: relationships', () => {
  it('reads the root relationships and resolves the main document', () => {
    const [main] = openOpc(docPkg()).byType('', OFFICE_DOCUMENT);
    expect(main).toEqual({ id: 'rId1', type: OFFICE_DOCUMENT, target: 'word/document.xml', external: false, part: 'word/document.xml' });
  });

  it('returns relationships in FILE order, not Id order', () => {
    expect(openOpc(docPkg()).relationships('word/document.xml').map((r) => r.id)).toEqual(['rId3', 'rId1', 'rId9']);
  });

  it('resolves internal targets relative to the source part', () => {
    const p = openOpc(docPkg());
    expect(p.relationship('word/document.xml', 'rId1')?.part).toBe('word/styles.xml');
    expect(p.byType('word/document.xml', IMAGE)[0].part).toBe('word/media/a.png');
    expect(p.has(p.byType('word/document.xml', IMAGE)[0].part!)).toBe(true);
  });

  it('keeps an external target verbatim and resolves nothing', () => {
    const link = openOpc(docPkg()).relationship('word/document.xml', 'rId9')!;
    expect(link).toEqual({ id: 'rId9', type: HYPERLINK, target: 'https://example.com/x?y=1#z', external: true });
    expect('part' in link).toBe(false);
  });

  it('treats an explicit TargetMode="Internal" as internal', () => {
    const p = openOpc(docPkg(RELS(rel('r', STYLES, 'styles.xml', 'Internal'))));
    expect(p.relationship('word/document.xml', 'r')).toMatchObject({ external: false, part: 'word/styles.xml' });
  });

  it('answers [] for a source with no .rels, and undefined for an unknown Id', () => {
    const p = openOpc(docPkg());
    expect(p.relationships('word/styles.xml')).toEqual([]);
    expect(p.relationship('word/document.xml', 'rIdNope')).toBeUndefined();
    expect(p.byType('word/document.xml', 'urn:none')).toEqual([]);
  });

  it('finds a .rels stored under a different case', () => {
    const p = openOpc(pkg({
      '[Content_Types].xml': CT(), '_RELS/.RELS': RELS(rel('rId1', OFFICE_DOCUMENT, 'word/document.xml')),
      'word/document.xml': '<d/>',
    }));
    expect(p.byType('', OFFICE_DOCUMENT)[0].part).toBe('word/document.xml');
  });

  it('answers a source named in another case as the package spells it, from one cache entry', () => {
    const p = openOpc(pkg({
      '[Content_Types].xml': CT(), '_rels/.rels': RELS(rel('rId1', OFFICE_DOCUMENT, 'word/document.xml')),
      'word/document.xml': '<d/>', 'word/_rels/document.xml.rels': RELS(rel('rS', STYLES, 'styles.xml')),
      'word/styles.xml': '<s/>',
    }));
    const lower = p.relationships('word/document.xml');
    const upper = p.relationships('WORD/Document.xml');
    expect(upper).toBe(lower);                       // parsed once, not per spelling
    expect(upper[0].part).toBe('word/styles.xml');   // not 'WORD/styles.xml'
  });

  it('keeps a backslash in a target literal, so it names no part rather than a translated one', () => {
    const p = openOpc(pkg({
      '[Content_Types].xml': CT(), '_rels/.rels': RELS(rel('rId1', OFFICE_DOCUMENT, 'word/document.xml')),
      'word/document.xml': '<d/>', 'word/_rels/document.xml.rels': RELS(rel('rI', IMAGE, 'media\\a.png')),
      'word/media/a.png': 'x',
    }));
    const r = p.relationship('word/document.xml', 'rI')!;
    expect(r.part).toBe('word/media\\a.png');
    expect(p.has(r.part!)).toBe(false);
  });

  it('does not parse a source until it is asked about', () => {
    // The broken .rels belongs to a part nobody queries; opening and using the
    // rest of the package must not touch it.
    const p = openOpc(docPkg(MAIN_RELS, { 'word/_rels/styles.xml.rels': '<Relationships><broken' }));
    expect(p.relationships('word/document.xml')).toHaveLength(3);
  });
});

describe('openOpc: relationship damage', () => {
  const broken = (rels: string) => openOpc(docPkg(rels));
  const bad = (rels: string) => expect(() => broken(rels).relationships('word/document.xml')).toThrow(PdfParseError);

  it('refuses a .rels that is not well-formed, or whose root is not Relationships', () => {
    bad('<Relationships><Relationship');
    bad('<Other/>');
  });

  it('refuses a relationship missing Id, Type or Target', () => {
    bad(RELS('<Relationship Type="t" Target="a"/>'));
    bad(RELS('<Relationship Id="r" Target="a"/>'));
    bad(RELS('<Relationship Id="r" Type="t"/>'));
  });

  it('refuses an unknown TargetMode', () => bad(RELS(rel('r', STYLES, 'a', 'Sideways'))));

  it('refuses a duplicate Id within one source', () =>
    bad(RELS(rel('r', STYLES, 'a.xml'), rel('r', IMAGE, 'b.png'))));

  it('caches the failure, and every other source stays usable', () => {
    const p = broken('<Relationships><broken');
    expect(() => p.relationships('word/document.xml')).toThrow(PdfParseError);
    expect(() => p.relationship('word/document.xml', 'rId1')).toThrow(PdfParseError);
    expect(p.byType('', OFFICE_DOCUMENT)).toHaveLength(1);
  });

  // A re-parse would throw an EQUAL error, so only identity can see the cache.
  it('throws the SAME error instance on a second query (the failure is cached)', () => {
    const p = broken('<Relationships><broken');
    const caught = (): unknown => { try { p.relationships('word/document.xml'); } catch (e) { return e; } return undefined; };
    const first = caught();
    expect(first).toBeInstanceOf(PdfParseError);
    expect(caught()).toBe(first);
  });

  it('returns the SAME array on a second query (the parse is cached)', () => {
    const p = openOpc(docPkg());
    expect(p.relationships('word/document.xml')).toBe(p.relationships('word/document.xml'));
  });
});

// Final review I2: m2fp.3 resolves every r:id through relationship(), so a
// linear scan makes a document with N links cost N^2: measured ~1.7 s by scan
// for 15,000 links against a few ms by index. (N stays small enough for writeZip.)
describe('openOpc: relationship lookup cost', () => {
  it('answers an Id lookup by index, not by scanning', () => {
    const N = 20_000;
    const items: string[] = [];
    for (let i = 0; i < N; i++) items.push(rel(`r${i}`, IMAGE, `media/i${i}.png`));
    const p = openOpc(pkg({ '[Content_Types].xml': CT(), 'word/_rels/document.xml.rels': RELS(...items) }));
    p.relationships('word/document.xml');          // parse outside the timed loop
    const t0 = performance.now();
    let hits = 0;
    for (let i = 0; i < N; i++) if (p.relationship('word/document.xml', `r${i}`)?.id === `r${i}`) hits++;
    const ms = performance.now() - t0;
    expect(hits).toBe(N);
    expect(ms).toBeLessThan(150);
  });
});

describe('openOpc: relationship limits', () => {
  it('counts one source\'s relationships against maxContainerItems as they are produced', () => {
    // Two zip entries and a two-entry content-types file, so only the rels hit the bound.
    const bytes = pkg({
      '[Content_Types].xml': CT(),
      '_rels/.rels': RELS(rel('a', STYLES, 'a.xml'), rel('b', STYLES, 'b.xml'), rel('c', STYLES, 'c.xml')),
    });
    expect(() => openOpc(bytes, limit(2)).relationships('')).toThrow(ResourceLimitError);
    expect(openOpc(bytes, limit(3)).relationships('')).toHaveLength(3);
  });
});
