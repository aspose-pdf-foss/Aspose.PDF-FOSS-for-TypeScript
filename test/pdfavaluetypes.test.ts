import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRdfPacket, RDF_NS } from '../src/xmprdf.js';
import { valueTypeIssues, typeMismatches } from '../src/pdfavaluetypes.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const NS = 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:acme="http://acme.example/ns/1.0/"'
  + ' xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
  + ' xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"'
  + ' xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"';
const text = (inner: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + `<rdf:Description rdf:about="" ${NS}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const pkt = (inner: string) => parseRdfPacket(enc(text(inner)));
const prop = (n: string, vt: string) => '<rdf:li rdf:parseType="Resource">'
  + `<pdfaProperty:name>${n}</pdfaProperty:name><pdfaProperty:valueType>${vt}</pdfaProperty:valueType>`
  + '<pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>d</pdfaProperty:description></rdf:li>';
const schema = (ns: string, props: string) => '<rdf:li rdf:parseType="Resource"><pdfaSchema:schema>S</pdfaSchema:schema>'
  + `<pdfaSchema:namespaceURI>${ns}</pdfaSchema:namespaceURI><pdfaSchema:prefix>p</pdfaSchema:prefix>`
  + `<pdfaSchema:property><rdf:Seq>${props}</rdf:Seq></pdfaSchema:property></rdf:li>`;
const ext = (schemas: string) => `<pdfaExtension:schemas><rdf:Bag>${schemas}</rdf:Bag></pdfaExtension:schemas>`;
const ACME = 'http://acme.example/ns/1.0/';
const DC = 'http://purl.org/dc/elements/1.1/';
const rules = (inner: string, part: 1 | 2 | 3 = 2) => valueTypeIssues([{ packet: pkt(inner), main: true }], part).map((i) => i.rule);

describe('XmpValueType', () => {
  it('reports a mistyped predefined property, citing each part\'s clause', () => {
    const inner = '<dc:rights>All rights</dc:rights>';                    // Lang Alt expected
    const i1 = valueTypeIssues([{ packet: pkt(inner), main: true }], 1);
    expect(i1).toMatchObject([{ rule: 'XmpValueType', severity: 'error', clause: 'ISO 19005-1 §6.7.9' }]);
    expect(i1[0].message).toContain('dc:rights');
    expect(i1[0].message).toContain('Lang Alt');
    expect(valueTypeIssues([{ packet: pkt(inner), main: true }], 3)[0].clause).toBe('ISO 19005-3 §6.6.2.3.1');
  });

  it('passes well-typed predefined properties', () => {
    expect(rules('<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">R</rdf:li></rdf:Alt></dc:rights>'
      + '<tiff:ImageWidth>640</tiff:ImageWidth><xmp:CreateDate>2024-06-03T12:00:00Z</xmp:CreateDate>')).toEqual([]);
  });

  it('does not report an undescribed property — o6uu.6 already does', () => {
    expect(rules('<acme:Batch><rdf:Bag><rdf:li>x</rdf:li></rdf:Bag></acme:Batch>')).toEqual([]);
  });

  it('uses a described type, which outranks the predefined one', () => {
    expect(rules(`<acme:Count>abc</acme:Count>${ext(schema(ACME, prop('Count', 'Integer')))}`)).toEqual(['XmpValueType']);
    expect(rules(`<acme:Count>12</acme:Count>${ext(schema(ACME, prop('Count', 'Integer')))}`)).toEqual([]);
    // dc:rights redefined as Text: plain text now validates.
    expect(rules(`<dc:rights>R</dc:rights>${ext(schema(DC, prop('rights', 'Text')))}`)).toEqual([]);
  });

  it('drops a registration with an unknown type and the first registration wins', () => {
    expect(rules(`<dc:rights>R</dc:rights>${ext(schema(DC, prop('rights', 'Nonsense')))}`)).toEqual(['XmpValueType']);
    expect(rules(`<acme:C>abc</acme:C>${ext(schema(ACME, prop('C', 'Integer') + prop('C', 'Text')))}`)).toEqual(['XmpValueType']);
  });

  // The case above reports under either reading — an unknown type fails to
  // validate anyway. This one separates them: dropped, the registration falls
  // through to the predefined Lang Alt, which the value satisfies.
  it('falls through to the predefined type past an unknown-type registration', () => {
    const alt = '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">R</rdf:li></rdf:Alt></dc:rights>';
    expect(rules(`${alt}${ext(schema(DC, prop('rights', 'Nonsense')))}`)).toEqual([]);
  });

  it('lets an object packet use the catalog packet\'s types at parts 2-3 only', () => {
    const main = pkt(ext(schema(ACME, prop('Count', 'Integer'))));
    const obj = pkt('<acme:Count>abc</acme:Count>');
    expect(typeMismatches(obj, 2, main).map((m) => m.type)).toEqual(['Integer']);
    expect(typeMismatches(obj, 1, main)).toEqual([]);                    // part 1: undescribed, skipped
  });

  it('never resolves a type through Object.prototype', () => {
    expect(rules('<dc:constructor>x</dc:constructor><dc:__proto__>y</dc:__proto__>')).toEqual([]);
  });

  it('finds no type error in the calibre packet', () => {
    const packet = parseRdfPacket(readFileSync('test/fixtures/xmp/calibre-identifiers.xmp'));
    for (const part of [1, 2] as const) expect(valueTypeIssues([{ packet, main: true }], part), `part ${part}`).toEqual([]);
  });

  // The Acrobat packet is not a PDF/A packet, and veraPDF's tables say so:
  // its ResourceRef has no `originalDocumentID`, its ResourceEvent no
  // `changed`, and `dc:creator` is an empty Bag where a Seq is required.
  // Exactly these three, at both eras — and everything else validates.
  it('finds exactly the three type errors veraPDF\'s tables imply in the Acrobat packet', () => {
    const packet = parseRdfPacket(readFileSync('test/fixtures/xmp/acrobat-tutorial-sample.xmp'));
    for (const part of [1, 2] as const) {
      expect(typeMismatches(packet, part).map((m) => `${m.property.name}:${m.type}`).sort(), `part ${part}`)
        .toEqual(['DerivedFrom:resourceref', 'History:seq resourceevent', 'creator:seq propername']);
    }
  });
});

describe('ValidatePdfA wiring', () => {
  const withXmp = (inner: string) => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: enc(text(inner)) }));
    return d;
  };
  const rulesAt = (d: Document, level: '1b' | '2b' | '4') => d.ValidatePdfA(level).Issues.map((i) => i.rule);

  it('reports at parts 1-3 and is silent at part 4', () => {
    const d = withXmp('<dc:rights>R</dc:rights>');
    expect(rulesAt(d, '2b')).toContain('XmpValueType');
    expect(rulesAt(d, '1b')).toContain('XmpValueType');
    expect(rulesAt(d, '4')).not.toContain('XmpValueType');
  });

  it('checks an object-level metadata stream', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.Pages[0].Dict.set('Metadata', d.allocObject({ kind: 'stream', dict, raw: enc(text('<dc:rights>R</dc:rights>')) }));
    expect(d.ValidatePdfA('2b').Issues.find((i) => i.rule === 'XmpValueType')?.object).toBeDefined();
  });

  it('skips a packet that will not parse', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: enc('<x:xmpmeta') }));
    expect(() => d.ValidatePdfA('2b')).not.toThrow();
    expect(rulesAt(d, '2b')).not.toContain('XmpValueType');
  });
});
