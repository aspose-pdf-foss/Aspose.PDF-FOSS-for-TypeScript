import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { readXmp } from '../src/xmp.js';
import { encodeStream } from '../src/filters.js';
import { name, type PdfObject } from '../src/types.js';
import type { PdfALevel } from '../src/pdfavalidate.js';
import { buildXmpPdf } from './helpers/build-xmp-pdf.js';
import { buildPdfaIdPacket as packet } from './helpers/build-pdfa-id-packet.js';

const ID = 'http://www.aiim.org/pdfa/ns/id/';
const enc = (s: string) => new TextEncoder().encode(s);
const identification = (doc: Document, level: PdfALevel) =>
  doc.ValidatePdfA(level).Errors.filter((e) => e.rule === 'PdfaIdentification');

describe('PDF/A identity uses the namespace URI', () => {
  const cases: [string, string, number, string | undefined, number | undefined, PdfALevel][] = [
    ['attribute', packet('a:part="1" a:conformance="B"'), 1, 'B', undefined, '1b'],
    ['element', packet('', '<a:part> 2 </a:part><a:conformance> U </a:conformance>'), 2, 'U', undefined, '2u'],
    ['numeric entities', packet('a:part="&#51;" a:conformance="&#x42;"'), 3, 'B', undefined, '3b'],
    ['element entities', packet('', '<a:part>&#x31;</a:part><a:conformance>&#66;</a:conformance>'), 1, 'B', undefined, '1b'],
    ['default namespace elements', packet('', '<part>2</part><conformance>B</conformance>', `xmlns="${ID}"`), 2, 'B', undefined, '2b'],
    ['PDF/A-4 base', packet('a:part="4" a:rev="&#50;020"'), 4, undefined, 2020, '4'],
    ['PDF/A-4e elements', packet('', '<a:part>4</a:part><a:rev>2020</a:rev><a:conformance>E</a:conformance>'), 4, 'E', 2020, '4e'],
    ['PDF/A-4f attributes', packet('a:part="4" a:rev="2020" a:conformance="F"'), 4, 'F', 2020, '4f'],
    ['entity in namespace URI', packet('a:part="2" a:conformance="B"', '', 'xmlns:a="http://www.aiim.org/pdfa/ns/i&#100;/"'), 2, 'B', undefined, '2b'],
    ['foreign canonical prefix beside genuine ID', packet('pdfaid:part="99" a:part="2" a:conformance="B"', '', `xmlns:pdfaid="urn:foreign" xmlns:a="${ID}"`), 2, 'B', undefined, '2b'],
  ];
  it.each(cases)('reads %s consistently through GetXmp and validation', (_, xml, part, conf, rev, level) => {
    const doc = Document.Open(buildXmpPdf(xml));
    expect(doc.GetXmpValue(ID, 'part')?.asText()?.trim()).toBe(String(part));
    const meta = doc.GetXmp();
    expect(meta.pdfaPart).toBe(part);
    expect(meta.pdfaConformance).toBe(conf);
    expect(meta.pdfaRev).toBe(rev);
    expect(meta.raw).toBe(xml);
    expect(identification(doc, level)).toEqual([]);
    expect(Document.Open(doc.Save()).GetXmp().pdfaPart).toBe(part);
  });

  it.each([
    ['foreign prefix', packet('pdfaid:part="1" pdfaid:conformance="B"', '', 'xmlns:pdfaid="urn:foreign"')],
    ['comment', packet('', '<!-- <pdfaid:part>1</pdfaid:part> -->')],
    ['nested property', packet('', '<t:block rdf:parseType="Resource"><a:part>1</a:part></t:block>', `xmlns:a="${ID}" xmlns:t="urn:test"`)],
    ['unprefixed attribute', packet('part="1" conformance="B"', '', `xmlns="${ID}"`)],
  ])('does not invent a PDF/A claim from a %s', (_, xml) => {
    const doc = Document.Open(buildXmpPdf(xml));
    expect(doc.GetXmp().pdfaPart).toBeUndefined();
    expect(identification(doc, '1b').some((e) => e.message.includes('part'))).toBe(true);
  });
});

describe('PDF/A identity preserves value distinctions and leniency', () => {
  it.each([
    packet('a:part="4" a:rev="2020" a:conformance=""'),
    packet('a:part="4" a:rev="2020"', '<a:conformance/>'),
  ])('keeps empty conformance present at PDF/A-4', (xml) => {
    const doc = Document.Open(buildXmpPdf(xml));
    expect(doc.GetXmp().pdfaConformance).toBe('');
    expect(identification(doc, '4').some((e) => e.message.includes('conformance'))).toBe(true);
  });

  it.each(['', '   ', 'junk'])('preserves NaN for numeric value %j', (value) => {
    const meta = readXmp(enc(packet(`a:part="${value}" a:rev="${value}"`)));
    expect(meta.pdfaPart).toBeNaN();
    expect(meta.pdfaRev).toBeNaN();
  });

  it('validates lexical numbers instead of silently normalizing them', () => {
    const doc = Document.Open(buildXmpPdf(packet('a:part="01" a:conformance="B"')));
    expect(doc.GetXmp().pdfaPart).toBe(1);
    expect(identification(doc, '1b').some((e) => e.message.includes("'01'"))).toBe(true);
  });

  it('decodes entities once', () => {
    const doc = Document.Open(buildXmpPdf(packet('a:part="1" a:conformance="&amp;#66;"')));
    expect(doc.GetXmp().pdfaConformance).toBe('&#66;');
    expect(identification(doc, '1b').some((e) => e.message.includes('conformance'))).toBe(true);
  });

  it('does not classify alternate-prefix PDF/A identity as custom properties that can be erased', () => {
    const doc = Document.Open(buildXmpPdf(packet('a:part="4" a:rev="2020" a:conformance="F"')));
    expect(doc.GetXmp().custom?.some((p) => p.namespace === ID) ?? false).toBe(false);
    doc.SetXmp({ custom: [] });
    expect(doc.GetXmp()).toMatchObject({ pdfaPart: 4, pdfaRev: 2020, pdfaConformance: 'F' });
    expect(identification(doc, '4f')).toEqual([]);
  });

  it('does not overwrite a foreign property when its prefix is later rebound to PDF/A', () => {
    const xml = packet('', '<a:part>7</a:part>', 'xmlns:a="urn:foreign"')
      .replace('</rdf:RDF>', `<rdf:Description xmlns:a="${ID}"><a:part>4</a:part><a:rev>2020</a:rev></rdf:Description></rdf:RDF>`);
    const doc = Document.Open(buildXmpPdf(xml));
    expect(doc.GetXmpValue('urn:foreign', 'part')?.asText()).toBe('7');
    doc.SetXmp({ custom: doc.GetXmp().custom ?? [] });
    expect(doc.GetXmpValue('urn:foreign', 'part')?.asText()).toBe('7');
    expect(doc.GetXmp()).toMatchObject({ pdfaPart: 4, pdfaRev: 2020 });
  });

  it('retains literal-prefix fallback for malformed legacy packets', () => {
    const xml = '<rdf:Description pdfaid:part="2" pdfaid:conformance="B"';
    const doc = Document.Open(buildXmpPdf(xml));
    expect(doc.GetXmp()).toMatchObject({ pdfaPart: 2, pdfaConformance: 'B', raw: xml });
    expect(identification(doc, '2b')).toEqual([]);
  });

  it('keeps unrelated fields and malformed-packet reads lenient', () => {
    const xml = '<x:xmpmeta><pdf:Producer>Producer</pdf:Producer><unclosed>';
    expect(readXmp(enc(xml))).toMatchObject({ producer: 'Producer', raw: xml });
  });

  it('does not parse unrelated custom values while validating PDF/A-4 identification', () => {
    const xml = packet('a:part="4" a:rev="2020"', '<t:bad>&#99999999;</t:bad>',
      `xmlns:a="${ID}" xmlns:t="urn:test"`);
    const doc = Document.Open(buildXmpPdf(xml));
    expect(() => doc.ValidatePdfA('4')).not.toThrow();
    expect(identification(doc, '4')).toEqual([]);
  });
});

describe('namespace-aware PDF/A identity honors document limits', () => {
  const deep = packet('a:part="2" a:conformance="B"',
    '<t:s rdf:parseType="Resource">'.repeat(300) + '<t:v>x</t:v>' + '</t:s>'.repeat(300),
    `xmlns:a="${ID}" xmlns:t="urn:test"`);

  it('propagates XML nesting refusals rather than falling back around a bound', () => {
    const doc = Document.Open(buildXmpPdf(deep));
    expect(() => doc.GetXmp()).toThrow(ResourceLimitError);
    expect(() => doc.ValidatePdfA('2b')).toThrow(ResourceLimitError);
  });

  it.each([LoadLimits.defaults.with({ maxNestingDepth: 2000 }), LoadLimits.unlimited()])
    ('uses an explicitly relaxed policy for reading and editing', (limits) => {
      const doc = Document.Open(buildXmpPdf(deep), { limits });
      expect(doc.GetXmp().pdfaPart).toBe(2);
      expect(identification(doc, '2b')).toEqual([]);
      expect(() => doc.SetXmp({ title: 'Changed' })).not.toThrow();
      expect(doc.GetXmp()).toMatchObject({ pdfaPart: 2, title: 'Changed' });
    });

  it('does not swallow metadata decode-limit refusals', () => {
    const doc = Document.Open(buildXmpPdf(packet('a:part="2" a:conformance="B"')),
      { limits: LoadLimits.defaults.with({ maxDecodedStreamBytes: 10 }) });
    const s = encodeStream(enc(packet('a:part="2" a:conformance="B"')), 'FlateDecode',
      new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]));
    doc.catalog().set('Metadata', doc.allocObject(s));
    expect(() => doc.GetXmp()).toThrow(ResourceLimitError);
    expect(() => doc.ValidatePdfA('2b')).toThrow(ResourceLimitError);
  });
});
