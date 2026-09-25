import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS } from '../src/xmprdf.js';

const custom = { namespace: 'http://acme.example/ns/1.0/', prefix: 'acme', name: 'Batch', value: 'B1' };
const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };
const rulesAt = (d: Document, level: '1b' | '2b' | '3b' | '4') => d.ValidatePdfA(level).Issues.map((i) => i.rule);
const metadataStream = (d: Document, text: string) => {
  const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
  return d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode(text) });
};
const packet = (inner: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + '<rdf:Description rdf:about="" xmlns:acme="http://acme.example/ns/1.0/">'
  + `${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;

describe('ValidatePdfA XmpPropertyNotDescribed', () => {
  it('reports an undescribed custom property at parts 1-3 and never at part 4', () => {
    const d = doc1();
    d.SetXmp({ custom: [custom] });
    for (const level of ['1b', '2b', '3b'] as const) expect(rulesAt(d, level)).toContain('XmpPropertyNotDescribed');
    expect(rulesAt(d, '4')).not.toContain('XmpPropertyNotDescribed');
  });

  it('is resolved by ConvertToPdfA', () => {
    const d = doc1();
    d.SetXmp({ custom: [custom] });
    const report = d.ConvertToPdfA('2b');
    expect(report.unresolved.map((i) => i.rule)).not.toContain('XmpPropertyNotDescribed');
    expect(rulesAt(d, '2b')).not.toContain('XmpPropertyNotDescribed');
  });

  it('checks an object-level metadata stream, which the catalog packet may describe at part 2 only', () => {
    const d = doc1();
    d.SetXmp({ custom: [custom] });
    d.ConvertToPdfA('2b');                        // the catalog packet now describes acme:Batch
    const ref = metadataStream(d, packet('<acme:Batch>X</acme:Batch>'));
    d.Pages[0].Dict.set('Metadata', ref);
    expect(rulesAt(d, '2b')).not.toContain('XmpPropertyNotDescribed');
    const part1 = d.ValidatePdfA('1b').Issues.filter((i) => i.rule === 'XmpPropertyNotDescribed');
    expect(part1.some((i) => i.object?.num === ref.num)).toBe(true);
  });

  it('ignores a metadata stream that will not parse, without throwing', () => {
    const d = doc1();
    d.Pages[0].Dict.set('Metadata', metadataStream(d, '<not xml'));
    expect(() => d.ValidatePdfA('2b')).not.toThrow();
    expect(rulesAt(d, '2b')).not.toContain('XmpPropertyNotDescribed');
  });
});

describe('ConvertToPdfUa on a PDF/A document', () => {
  it('describes pdfuaid so the document stays PDF/A', () => {
    const d = doc1();
    d.ConvertToPdfA('2b');
    d.ConvertToPdfUa();
    expect(d.GetXmp().pdfuaPart).toBe(1);
    expect(rulesAt(d, '2b')).not.toContain('XmpPropertyNotDescribed');
  });

  it('writes no extension schema on a document that claims no PDF/A part 1-3', () => {
    const d = doc1();
    d.ConvertToPdfUa();
    expect(d.GetXmpValue('http://www.aiim.org/pdfa/ns/extension/', 'schemas')).toBeUndefined();
  });
});

describe('final review (o6uu.6)', () => {
  const EXT = 'xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"'
    + ' xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"';
  const described = (ns: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
    + `<rdf:Description rdf:about="" xmlns:acme="http://acme.example/ns/1.0/" ${ns}>`
    + '<acme:Batch>B1</acme:Batch><pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">'
    + '<pdfaSchema:schema>Acme</pdfaSchema:schema><pdfaSchema:namespaceURI>http://acme.example/ns/1.0/</pdfaSchema:namespaceURI>'
    + '<pdfaSchema:prefix>acme</pdfaSchema:prefix><pdfaSchema:property><rdf:Seq><rdf:li rdf:parseType="Resource">'
    + '<pdfaProperty:name>Batch</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType>'
    + '<pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>d</pdfaProperty:description>'
    + '</rdf:li></rdf:Seq></pdfaSchema:property></rdf:li></rdf:Bag></pdfaExtension:schemas></rdf:Description></rdf:RDF></x:xmpmeta>';
  const rulesOf = (d: Document, level: '1b' | '2b') => d.ValidatePdfA(level).Issues.map((i) => i.rule);

  it('does not report the packets conversion itself replaced (part 1, in memory)', () => {
    const d = doc1();
    d.SetXmp({ custom: [custom] });
    const report = d.ConvertToPdfA('1b');
    expect(report.unresolved.map((i) => i.rule)).not.toContain('XmpPropertyNotDescribed');
  });

  it('ignores an orphaned metadata stream, however malformed', () => {
    const d = doc1();
    const bad = described(EXT).replace(/pdfaExtension/g, 'ext');
    d.catalog().set('Metadata', metadataStream(d, bad));
    d.catalog().set('Metadata', metadataStream(d, described(EXT)));   // the malformed one is now unreachable
    expect(rulesOf(d, '2b').filter((r) => r.startsWith('XmpExtension'))).toEqual([]);
  });

  it('checks a /Metadata stream that states no /Type', () => {
    const d = doc1();
    const dict: PdfDict = new Map<string, PdfObject>([['Subtype', name('XML')]]);
    const ref = d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode(packet('<acme:Batch>X</acme:Batch>')) });
    d.Pages[0].Dict.set('Metadata', ref);
    const hits = d.ValidatePdfA('1b').Issues.filter((i) => i.rule === 'XmpPropertyNotDescribed');
    expect(hits.some((i) => i.object?.num === ref.num)).toBe(true);
  });

  it('repairs a description broken only by its prefixes, with nothing missing', () => {
    const d = doc1();
    const ns = 'xmlns:ext="http://www.aiim.org/pdfa/ns/extension/" xmlns:s="http://www.aiim.org/pdfa/ns/schema#"'
      + ' xmlns:p="http://www.aiim.org/pdfa/ns/property#"';
    const text = described(ns).replace(/pdfaExtension:/g, 'ext:').replace(/pdfaSchema:/g, 's:').replace(/pdfaProperty:/g, 'p:');
    d.catalog().set('Metadata', metadataStream(d, text));
    expect(rulesOf(d, '2b').some((r) => r.startsWith('XmpExtension'))).toBe(true);
    const report = d.ConvertToPdfA('2b');
    expect(report.unresolved.map((i) => i.rule).filter((r) => r.startsWith('XmpExtension'))).toEqual([]);
    const reopened = Document.Open(d.Save());
    expect(rulesOf(reopened, '2b').filter((r) => r.startsWith('Xmp'))).toEqual([]);
  });
});
