import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/index.js';
import { parseRdfPacket, type RdfProperty } from '../src/xmprdf.js';
import { buildXmpPdf } from './helpers/build-xmp-pdf.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';
import { buildBlankPage } from './helpers/build-annot-target.js';

const enc = (s: string) => new TextEncoder().encode(s);
const DC = 'http://purl.org/dc/elements/1.1/';
const MM = 'http://ns.adobe.com/xap/1.0/mm/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const EXT = 'http://www.aiim.org/pdfa/ns/extension/';
const ACME = 'http://acme.example/ns/1.0/';
const reopen = (doc: Document) => Document.Open(doc.Save());
const modelOf = (doc: Document): RdfProperty[] => parseRdfPacket(enc(doc.GetXmp().raw!)).properties;
const get = (props: RdfProperty[], ns: string, name: string) => props.find((p) => p.ns === ns && p.name === name);
const without = (props: RdfProperty[], ns: string, name: string) =>
  props.filter((p) => !(p.ns === ns && p.name === name));
const adobe = readFileSync('test/fixtures/xmp/acrobat-tutorial-sample.xmp', 'utf8');
const calibre = readFileSync('test/fixtures/xmp/calibre-identifiers.xmp', 'utf8');

const EXTENSION = '<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"'
  + ' xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">'
  + '<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">'
  + '<pdfaSchema:schema>Acme batch schema</pdfaSchema:schema>'
  + `<pdfaSchema:namespaceURI>${ACME}</pdfaSchema:namespaceURI>`
  + '<pdfaSchema:prefix>acme</pdfaSchema:prefix>'
  + '<pdfaSchema:property><rdf:Seq><rdf:li rdf:parseType="Resource">'
  + '<pdfaProperty:name>BatchId</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType>'
  + '<pdfaProperty:category>external</pdfaProperty:category>'
  + '<pdfaProperty:description>Batch identifier</pdfaProperty:description>'
  + '</rdf:li></rdf:Seq></pdfaSchema:property></rdf:li></rdf:Bag></pdfaExtension:schemas></rdf:Description>'
  + `<rdf:Description rdf:about="" xmlns:acme="${ACME}"><acme:BatchId>B-4711</acme:BatchId></rdf:Description>`;

describe('SetXmp / SetMetadata preserve what they do not own (o6uu.3)', () => {
  it('keeps the Adobe History packet intact when the title is set (acceptance)', () => {
    const doc = Document.Open(buildXmpPdf(adobe));
    const before = modelOf(doc);
    doc.SetXmp({ title: 'Renamed' });
    const after = reopen(doc);
    expect(without(modelOf(after), DC, 'title')).toEqual(without(before, DC, 'title'));
    expect(after.GetXmp().title).toBe('Renamed');
    expect(get(modelOf(after), MM, 'History')).toEqual(get(before, MM, 'History'));
  });

  it("keeps calibre's qualified identifiers through SetMetadata", () => {
    const doc = Document.Open(buildXmpPdf(calibre));
    const before = get(modelOf(doc), XMP, 'Identifier');
    doc.SetMetadata({ title: 'Renamed' });
    expect(get(modelOf(reopen(doc)), XMP, 'Identifier')).toEqual(before);
  });

  it('keeps a non-default language of the title', () => {
    const doc = Document.Open(buildXmpPdf(adobe.replace('<rdf:li xml:lang="x-default">',
      '<rdf:li xml:lang="de-DE">Anleitung</rdf:li><rdf:li xml:lang="x-default">')));
    doc.SetMetadata({ title: 'Renamed' });
    const title = get(modelOf(reopen(doc)), DC, 'title');
    expect(title?.value.kind === 'array' && title.value.items.map((it) => it.lang)).toEqual(['x-default', 'de-DE']);
    expect(reopen(doc).GetXmp().title).toBe('Renamed');
  });

  it('keeps a PDF/A extension schema through a metadata edit, and the document still validates (acceptance)', () => {
    const doc = Document.Open(buildPdfaPdf({ xmpExtra: EXTENSION }, 2));
    expect(doc.ValidatePdfA('2b').Passed).toBe(true);
    const schemas = get(modelOf(doc), EXT, 'schemas');
    expect(schemas).toBeDefined();
    doc.SetMetadata({ title: 'Edited' });
    const after = reopen(doc);
    expect(get(modelOf(after), EXT, 'schemas')).toEqual(schemas);
    expect(get(modelOf(after), ACME, 'BatchId')?.value).toEqual({ kind: 'simple', value: 'B-4711' });
    expect(after.ValidatePdfA('2b').Passed).toBe(true);
  });

  it('keeps History through ConvertToPdfA', () => {
    const doc = Document.Open(buildXmpPdf(adobe));
    const history = get(modelOf(doc), MM, 'History');
    doc.ConvertToPdfA('2b');
    expect(get(modelOf(reopen(doc)), MM, 'History')).toEqual(history);
  });

  it('leaves the document unchanged when custom is rejected', () => {
    const doc = Document.Open(buildXmpPdf(adobe));
    const before = doc.Save();
    expect(() => doc.SetXmp({ title: 'x', custom: [{ namespace: ACME, prefix: 'rdf', name: 'a', value: 'b' }] }))
      .toThrow(TypeError);
    expect(doc.Save()).toEqual(before);
  });

  it('SetMetadata survives preserved foreign content carrying a character XML cannot write', () => {
    const doc = Document.Open(buildXmpPdf(adobe.replace('<pdf:Trapped>False</pdf:Trapped>',
      '<pdf:Trapped>False</pdf:Trapped><dc:source>a&#x1;b</dc:source>')));
    doc.SetMetadata({ title: 'T' });
    expect(reopen(doc).GetXmp().title).toBe('T');
    expect(() => doc.ConvertToPdfA('2b')).not.toThrow();
  });

  it('writes no packet for a pure delete on a document without one', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetXmp({ title: null });
    expect(reopen(doc).GetXmp().raw).toBeUndefined();
  });

  it('survives an /Info title carrying NUL', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetMetadata({ title: 'a\u0000b' });
    expect(reopen(doc).GetXmp().title).toBe('ab');
  });
});
