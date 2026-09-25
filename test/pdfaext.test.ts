import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRdfPacket, RDF_NS } from '../src/xmprdf.js';
import { extensionSchemaIssues, undescribedProperties } from '../src/pdfaext.js';
import type { PdfRef } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const NS = 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:acme="http://acme.example/ns/1.0/"'
  + ' xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/"'
  + ' xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"'
  + ' xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#" xmlns:pdfaType="http://www.aiim.org/pdfa/ns/type#"'
  + ' xmlns:pdfaField="http://www.aiim.org/pdfa/ns/field#"';
const text = (inner: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + `<rdf:Description rdf:about="" ${NS}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const pkt = (inner: string) => parseRdfPacket(enc(text(inner)));
const prop = (name: string, vt = 'Text', cat = 'external') => '<rdf:li rdf:parseType="Resource">'
  + `<pdfaProperty:name>${name}</pdfaProperty:name><pdfaProperty:valueType>${vt}</pdfaProperty:valueType>`
  + `<pdfaProperty:category>${cat}</pdfaProperty:category><pdfaProperty:description>d</pdfaProperty:description></rdf:li>`;
const schema = (props: string, extra = '', ns = 'http://acme.example/ns/1.0/') => '<rdf:li rdf:parseType="Resource">'
  + `<pdfaSchema:schema>Acme</pdfaSchema:schema><pdfaSchema:namespaceURI>${ns}</pdfaSchema:namespaceURI>`
  + `<pdfaSchema:prefix>acme</pdfaSchema:prefix><pdfaSchema:property><rdf:Seq>${props}</rdf:Seq></pdfaSchema:property>${extra}</rdf:li>`;
const container = (schemas: string, form = 'Bag') =>
  `<pdfaExtension:schemas><rdf:${form}>${schemas}</rdf:${form}></pdfaExtension:schemas>`;
const ACME = '<acme:Batch>B1</acme:Batch>';
const issues = (inner: string, part: 1 | 2 | 3 = 2) => extensionSchemaIssues([{ packet: pkt(inner), main: true }], part);
const rules = (inner: string, part: 1 | 2 | 3 = 2) => issues(inner, part).map((i) => i.rule);

describe('XmpPropertyNotDescribed', () => {
  it('reports an undescribed property at parts 1 and 2, with each part\'s clause', () => {
    expect(issues(ACME, 1)).toMatchObject([{ rule: 'XmpPropertyNotDescribed', severity: 'error', clause: 'ISO 19005-1 §6.7.9' }]);
    expect(issues(ACME, 2)).toMatchObject([{ rule: 'XmpPropertyNotDescribed', clause: 'ISO 19005-2 §6.6.2.3.1' }]);
    expect(issues(ACME, 3)[0].clause).toBe('ISO 19005-3 §6.6.2.3.1');
    expect(issues(ACME, 2)[0].message).toContain('acme:Batch');
  });

  it('accepts a described or predefined property', () => {
    expect(rules(ACME + container(schema(prop('Batch'))))).toEqual([]);
    expect(rules('<dc:format>application/pdf</dc:format>')).toEqual([]);
  });

  it('checks by property, not namespace: an unknown dc property is reported', () => {
    expect(rules('<dc:bogus>x</dc:bogus>')).toEqual(['XmpPropertyNotDescribed']);
  });

  it('uses XMP 2004 at part 1 and XMP 2005 at part 2', () => {
    expect(rules('<xmpDM:album>A</xmpDM:album>', 2)).toEqual([]);
    expect(rules('<xmpDM:album>A</xmpDM:album>', 1)).toEqual(['XmpPropertyNotDescribed']);
  });

  it('does not count a property description with no valueType', () => {
    const noType = '<rdf:li rdf:parseType="Resource"><pdfaProperty:name>Batch</pdfaProperty:name>'
      + '<pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>d</pdfaProperty:description></rdf:li>';
    expect(rules(ACME + container(schema(noType)))).toContain('XmpPropertyNotDescribed');
  });

  it('lets the LAST schema entry for a namespace win, as veraPDF\'s map.put does', () => {
    expect(rules(ACME + container(schema(prop('Batch')) + schema(prop('Other'))))).toContain('XmpPropertyNotDescribed');
    expect(rules(ACME + container(schema(prop('Other')) + schema(prop('Batch'))))).toEqual([]);
  });
});

describe('main packet descriptions for object-level packets', () => {
  const ref: PdfRef = { kind: 'ref', num: 9, gen: 0 };
  const run = (part: 1 | 2) => extensionSchemaIssues([
    { packet: pkt(container(schema(prop('Batch')))), main: true },
    { packet: pkt(ACME), main: false, object: ref },
  ], part);

  it('count at parts 2 and 3', () => {
    expect(run(2)).toEqual([]);
  });

  it('do not count at part 1, and the issue names the object', () => {
    expect(run(1)).toMatchObject([{ rule: 'XmpPropertyNotDescribed', object: ref }]);
  });
});

describe('description structure', () => {
  it('requires the container to be a Bag', () => {
    expect(rules(ACME + container(schema(prop('Batch')), 'Seq'))).toEqual(['XmpExtensionContainer']);
  });

  it('requires the prefix pdfaExtension', () => {
    const src = text(ACME + container(schema(prop('Batch')))).replace(/pdfaExtension/g, 'ext');
    const out = extensionSchemaIssues([{ packet: parseRdfPacket(enc(src)), main: true }], 2);
    expect(out.map((i) => i.rule)).toEqual(['XmpExtensionContainer']);
  });

  it('reports a field outside the namespace\'s allowed set', () => {
    expect(rules(ACME + container(schema(prop('Batch'), '<pdfaSchema:bogus>1</pdfaSchema:bogus>'))))
      .toEqual(['XmpExtensionUndefinedField']);
    expect(rules(ACME + container(schema(prop('Batch'), '<acme:Other>1</acme:Other>'))))
      .toEqual(['XmpExtensionUndefinedField']);
  });

  it('requires schema, namespaceURI and prefix, each simple', () => {
    const noSchema = schema(prop('Batch')).replace('<pdfaSchema:schema>Acme</pdfaSchema:schema>', '');
    expect(rules(ACME + container(noSchema))).toEqual(['XmpExtensionField']);
    const structPrefix = schema(prop('Batch')).replace('<pdfaSchema:prefix>acme</pdfaSchema:prefix>',
      '<pdfaSchema:prefix rdf:parseType="Resource"><acme:a>1</acme:a></pdfaSchema:prefix>');
    expect(rules(ACME + container(structPrefix))).toEqual(['XmpExtensionField']);
  });

  it('requires property to be a Seq when present, and allows it absent', () => {
    const bag = schema(prop('Batch')).replace(/rdf:Seq/g, 'rdf:Bag');
    expect(rules(ACME + container(bag))).toEqual(['XmpExtensionField']);
    const none = schema('').replace(/<pdfaSchema:property>.*<\/pdfaSchema:property>/, '');
    expect(rules(container(none))).toEqual([]);
  });

  it('requires each property field and reports a bad category or value type', () => {
    // A bad category is a malformed FIELD, not an unknown type (o6uu.11).
    expect(rules(ACME + container(schema(prop('Batch', 'Text', 'sometimes'))))).toEqual(['XmpExtensionField']);
    expect(rules(ACME + container(schema(prop('Batch', 'Widget'))))).toEqual(['XmpExtensionValueType']);
    const noDesc = prop('Batch').replace('<pdfaProperty:description>d</pdfaProperty:description>', '');
    expect(rules(ACME + container(schema(noDesc)))).toEqual(['XmpExtensionField']);
  });

  it('knows array, lang-alt and choice spellings, and a schema\'s own value types', () => {
    for (const vt of ['Bag ProperName', 'Lang Alt', 'Closed Choice of Text', 'Seq Date'])
      expect(rules(ACME + container(schema(prop('Batch', vt))))).toEqual([]);
    const widget = '<pdfaSchema:valueType><rdf:Seq><rdf:li rdf:parseType="Resource">'
      + '<pdfaType:type>Widget</pdfaType:type><pdfaType:namespaceURI>http://acme.example/w#</pdfaType:namespaceURI>'
      + '<pdfaType:prefix>w</pdfaType:prefix><pdfaType:description>d</pdfaType:description>'
      + '</rdf:li></rdf:Seq></pdfaSchema:valueType>';
    expect(rules(ACME + container(schema(prop('Batch', 'Widget'), widget)))).toEqual([]);
  });

  it('gives an unregistered schema only the base types for its value-type fields', () => {
    // No property array: veraPDF registers no definition for the namespace,
    // so its valueType entries are checked against `new ValidatorsContainer()`.
    const vtWithRef = '<pdfaSchema:valueType><rdf:Seq><rdf:li rdf:parseType="Resource">'
      + '<pdfaType:type>Thing</pdfaType:type><pdfaType:namespaceURI>http://acme.example/t#</pdfaType:namespaceURI>'
      + '<pdfaType:prefix>t</pdfaType:prefix><pdfaType:description>d</pdfaType:description>'
      + '<pdfaType:field><rdf:Seq><rdf:li rdf:parseType="Resource"><pdfaField:name>ref</pdfaField:name>'
      + '<pdfaField:valueType>ResourceRef</pdfaField:valueType><pdfaField:description>d</pdfaField:description>'
      + '</rdf:li></rdf:Seq></pdfaType:field></rdf:li></rdf:Seq></pdfaSchema:valueType>';
    const unregistered = schema('', vtWithRef).replace(/<pdfaSchema:property>.*?<\/pdfaSchema:property>/, '');
    expect(rules(container(unregistered))).toEqual(['XmpExtensionValueType']);
    expect(rules(ACME + container(schema(prop('Batch'), vtWithRef)))).toEqual([]);
  });
});

describe('real packets from other producers', () => {
  const load = (f: string) => parseRdfPacket(readFileSync(`test/fixtures/xmp/${f}`));
  const names = (f: string) => {
    const p = load(f);
    return undescribedProperties(p, 2).map((q) => `${p.prefixes.get(q.ns)}:${q.name}`).sort();
  };

  it('flags exactly the two Acrobat properties veraPDF\'s tables lack', () => {
    // Checked against XMPConstants.java at 60f8f1dc while planning: neither
    // name occurs anywhere in it. The spec expected no issue; it was wrong.
    expect(names('acrobat-tutorial-sample.xmp')).toEqual(['pdf:Trapped', 'xmpMM:OriginalDocumentID']);
  });

  it('flags calibre\'s pdfx and prism identifiers and nothing else', () => {
    expect(names('calibre-identifiers.xmp')).toEqual(['pdfx:doi', 'pdfx:isbn', 'prism:doi', 'prism:isbn']);
  });
});
