import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { readXmp } from '../src/xmp.js';
import { parseRdfPacket, RDF_NS } from '../src/xmprdf.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { buildXmpPdf } from './helpers/build-xmp-pdf.js';

const enc = (s: string) => new TextEncoder().encode(s);
const ID = 'http://www.aiim.org/pdfa/ns/id/';
const packet = (body: string) => `<rdf:RDF xmlns:rdf="${RDF_NS}">${body}</rdf:RDF>`;
const prop = (namespace: string, name: string, value: string, prefix = 'c') => ({ namespace, prefix, name, value });

describe('custom XMP namespaces resolve in XML scope (5n57)', () => {
  it.each([
    ['elements', '<c:Value>A</c:Value>', '<c:Value>B</c:Value>', '', ''],
    ['attributes', '', '', ' c:Value="A"', ' c:Value="B"'],
  ])('keeps sibling Description %s in their own namespaces through SetXmp', (_label, first, second, a, b) => {
    const xml = packet(`<rdf:Description xmlns:c="urn:a"${a}>${first}</rdf:Description>`
      + `<rdf:Description xmlns:c="urn:b"${b}>${second}</rdf:Description>`);
    const doc = Document.Open(buildXmpPdf(xml));
    expect(doc.GetXmp().custom).toEqual([prop('urn:a', 'Value', 'A'), prop('urn:b', 'Value', 'B')]);
    doc.SetXmp({ custom: doc.GetXmp().custom });
    const reopened = Document.Open(doc.Save());
    expect(parseRdfPacket(enc(reopened.GetXmp().raw!)).properties).toEqual([
      { ns: 'urn:a', name: 'Value', value: { kind: 'simple', value: 'A' } },
      { ns: 'urn:b', name: 'Value', value: { kind: 'simple', value: 'B' } },
    ]);
  });

  it('uses a declaration on the property itself and restores its parent scope', () => {
    const xml = packet('<rdf:Description xmlns:c="urn:outer">'
      + '<c:Value xmlns:c="urn:inner">inner</c:Value><c:Other>outer</c:Other></rdf:Description>');
    expect(readXmp(enc(xml)).custom).toEqual([
      prop('urn:inner', 'Value', 'inner'), prop('urn:outer', 'Other', 'outer'),
    ]);
  });

  it('inherits ancestor bindings after a sibling locally rebinds the prefix', () => {
    const xml = `<rdf:RDF xmlns:rdf="${RDF_NS}" xmlns:c="urn:ancestor">`
      + '<rdf:Description xmlns:c="urn:local"><c:Value>local</c:Value></rdf:Description>'
      + '<rdf:Description><c:Value>inherited</c:Value></rdf:Description></rdf:RDF>';
    expect(readXmp(enc(xml)).custom).toEqual([
      prop('urn:local', 'Value', 'local'), prop('urn:ancestor', 'Value', 'inherited'),
    ]);
  });

  it('keeps nested literal fields visible without hoisting or overwriting them on write-back', () => {
    const xml = packet('<rdf:Description xmlns:c="urn:outer">'
      + '<c:Record rdf:parseType="Resource"><c:Value xmlns:c="urn:inner">nested</c:Value>'
      + '<c:Other>outer field</c:Other></c:Record><c:Value>top</c:Value></rdf:Description>');
    const doc = Document.Open(buildXmpPdf(xml));
    expect(doc.GetXmp().custom).toEqual([
      prop('urn:inner', 'Value', 'nested'), prop('urn:outer', 'Other', 'outer field'),
      prop('urn:outer', 'Value', 'top'),
    ]);
    doc.SetXmp({ custom: doc.GetXmp().custom });
    expect(parseRdfPacket(enc(Document.Open(doc.Save()).GetXmp().raw!)).properties).toEqual([
      { ns: 'urn:outer', name: 'Record', value: { kind: 'struct', fields: [
        { ns: 'urn:inner', name: 'Value', value: { kind: 'simple', value: 'nested' } },
        { ns: 'urn:outer', name: 'Other', value: { kind: 'simple', value: 'outer field' } },
      ] } },
      { ns: 'urn:outer', name: 'Value', value: { kind: 'simple', value: 'top' } },
    ]);
  });

  it.each(['elements', 'attributes'])('keeps PDF/A identification separate from a later foreign binding (%s)', (form) => {
    const xml = packet(form === 'elements'
      ? `<rdf:Description xmlns:c="${ID}"><c:part>4</c:part><c:rev>2020</c:rev></rdf:Description>`
        + '<rdf:Description xmlns:c="urn:foreign"><c:part>foreign</c:part></rdf:Description>'
      : `<rdf:Description xmlns:c="${ID}" c:part="4" c:rev="2020"/>`
        + '<rdf:Description xmlns:c="urn:foreign" c:part="foreign"/>');
    const doc = Document.Open(buildXmpPdf(xml));
    expect(doc.GetXmp().custom).toEqual([prop('urn:foreign', 'part', 'foreign')]);
    doc.SetXmp({ custom: doc.GetXmp().custom });
    const reopened = Document.Open(doc.Save());
    expect(reopened.GetXmp().pdfaPart).toBe(4);
    expect(reopened.GetXmp().pdfaRev).toBe(2020);
    expect(reopened.GetXmp().custom).toEqual([prop('urn:foreign', 'part', 'foreign')]);
  });

  it('does not let a later PDF/A binding hide an earlier foreign property', () => {
    const xml = packet('<rdf:Description xmlns:c="urn:foreign"><c:Value>kept</c:Value></rdf:Description>'
      + `<rdf:Description xmlns:c="${ID}"><c:part>4</c:part></rdf:Description>`);
    expect(readXmp(enc(xml)).custom).toEqual([prop('urn:foreign', 'Value', 'kept')]);
  });

  it('does not leak a sibling-only binding into an unbound property', () => {
    const xml = packet('<rdf:Description xmlns:c="urn:a"><c:First>A</c:First></rdf:Description>'
      + '<rdf:Description><c:Unbound>skip</c:Unbound></rdf:Description>');
    expect(readXmp(enc(xml)).custom).toEqual([prop('urn:a', 'First', 'A')]);
  });

  it('reads attributes on an aliased RDF Description in its own scope', () => {
    const xml = packet(`<r:Description xmlns:r="${RDF_NS}" c:Value="A &amp; B" xmlns:c="urn:a"/>`);
    expect(readXmp(enc(xml)).custom).toEqual([prop('urn:a', 'Value', 'A & B')]);
  });

  it('ignores namespace declarations and fake properties inside comments', () => {
    const xml = packet('<rdf:Description xmlns:c="urn:a"><c:Value>A</c:Value>'
      + '<!-- <c:Fake xmlns:c="urn:fake">bad</c:Fake> --></rdf:Description>');
    expect(readXmp(enc(xml)).custom).toEqual([prop('urn:a', 'Value', 'A')]);
  });

  it('does not treat markup inside CDATA as declarations or custom properties', () => {
    const xml = packet('<rdf:Description xmlns:c="urn:a"><c:Value>A</c:Value>'
      + '<c:Text><![CDATA[<c:Fake xmlns:c="urn:fake">bad</c:Fake>]]></c:Text></rdf:Description>');
    expect(readXmp(enc(xml)).custom).toEqual([prop('urn:a', 'Value', 'A')]);
  });

  it('excludes built-in namespace aliases from the custom list', () => {
    const xml = packet('<rdf:Description xmlns:d="http://purl.org/dc/elements/1.1/"'
      + ' xmlns:p="http://ns.adobe.com/pdf/1.3/"><d:format>application/pdf</d:format>'
      + '<p:Producer>P</p:Producer></rdf:Description>');
    expect(readXmp(enc(xml)).custom).toBeUndefined();
  });

  it('retains the legacy literal fallback for a truncated packet', () => {
    const xml = '<rdf:Description xmlns:c="urn:a"><c:Value>&#99999999;</c:Value>';
    expect(readXmp(enc(xml)).custom).toEqual([prop('urn:a', 'Value', '&#99999999;')]);
  });

  it('propagates the document limit even when RDF identification takes its fallback', () => {
    const xml = '<!DOCTYPE rdf:RDF>' + packet('<rdf:Description xmlns:c="urn:a">'
      + '<c:Record rdf:parseType="Resource"><c:Value>A</c:Value></c:Record></rdf:Description>');
    const limits = LoadLimits.defaults.with({ maxNestingDepth: 3 });
    expect(() => readXmp(enc(xml), limits)).toThrow(ResourceLimitError);
    expect(readXmp(enc(xml), limits.with({ maxNestingDepth: 4 })).custom).toEqual([prop('urn:a', 'Value', 'A')]);
  });
});
