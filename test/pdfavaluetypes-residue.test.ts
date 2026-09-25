import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { name, isStream, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS, parseRdfPacket } from '../src/xmprdf.js';
import { repairProperty, valueTypeIssues } from '../src/pdfavaluetypes.js';
import { XmpTypeRegistry } from '../src/xmptypes.js';
import { writeXmpPacket } from '../src/xmp.js';
import { inflateStream } from '../src/flate.js';
import { repairXmpValueTypes } from '../src/pdfaextfix.js';

// o6uu.13: residue from the o6uu.10 review.

const enc = (s: string) => new TextEncoder().encode(s);
const ACME = 'http://acme.example/ns/1.0/';
const DC = 'http://purl.org/dc/elements/1.1/';
const NS = `xmlns:dc="${DC}" xmlns:acme="${ACME}" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"`
  + ' xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"';
const text = (inner: string, attrs = '') => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + `<rdf:Description rdf:about="" ${NS}${attrs}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const pkt = (inner: string, attrs = '') => parseRdfPacket(enc(text(inner, attrs)));
const prop = (n: string, vt: string) => '<rdf:li rdf:parseType="Resource">'
  + `<pdfaProperty:name>${n}</pdfaProperty:name><pdfaProperty:valueType>${vt}</pdfaProperty:valueType>`
  + '<pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>d</pdfaProperty:description></rdf:li>';
const ext = (props: string) => '<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">'
  + `<pdfaSchema:schema>S</pdfaSchema:schema><pdfaSchema:namespaceURI>${ACME}</pdfaSchema:namespaceURI>`
  + `<pdfaSchema:prefix>acme</pdfaSchema:prefix><pdfaSchema:property><rdf:Seq>${props}</rdf:Seq></pdfaSchema:property>`
  + '</rdf:li></rdf:Bag></pdfaExtension:schemas>';
const r = XmpTypeRegistry.forEra('2005');

describe('repairProperty carries what belonged to the value onto the item', () => {
  it('gives a Lang Alt item the property\'s own language, not x-default', () => {
    const p = pkt('<dc:rights>Rechte</dc:rights>', ' xml:lang="de"').properties.find((q) => q.name === 'rights')!;
    expect(p.lang).toBe('de');
    const fixed = repairProperty(p, 'Lang Alt', r)!;
    expect(fixed.lang).toBeUndefined();
    expect(fixed.value).toEqual({ kind: 'array', form: 'Alt', items: [{ value: { kind: 'simple', value: 'Rechte' }, lang: 'de' }] });
  });

  it('still uses x-default when the property states no language', () => {
    const p = pkt('<dc:rights>R</dc:rights>').properties.find((q) => q.name === 'rights')!;
    expect(repairProperty(p, 'Lang Alt', r)!.value).toMatchObject({ items: [{ lang: 'x-default' }] });
  });

  it('moves a qualified value\'s qualifiers onto the one-item array\'s item', () => {
    const packet = pkt('<acme:Count rdf:parseType="Resource"><rdf:value>5</rdf:value><acme:unit>kg</acme:unit></acme:Count>');
    const p = packet.properties.find((q) => q.name === 'Count')!;
    expect(p.qualifiers).toHaveLength(1);
    const fixed = repairProperty(p, 'Seq Integer', r)!;
    expect(fixed.qualifiers).toBeUndefined();
    expect(fixed.value).toMatchObject({ kind: 'array', form: 'Seq', items: [{ value: { value: '5' }, qualifiers: [{ name: 'unit' }] }] });
    // …and it survives a write.
    const i = packet.properties.indexOf(p);
    packet.properties[i] = fixed;
    const back = parseRdfPacket(enc(writeXmpPacket(packet))).properties.find((q) => q.name === 'Count')!;
    expect(back.qualifiers).toBeUndefined();
    expect(back.value).toMatchObject({ items: [{ qualifiers: [{ name: 'unit' }] }] });
  });

  it('leaves an array-to-array swap\'s property untouched apart from its form', () => {
    const p = pkt('<dc:contributor><rdf:Seq><rdf:li>A</rdf:li></rdf:Seq></dc:contributor>').properties[0];
    expect(repairProperty(p, 'Bag ProperName', r)!.value).toMatchObject({ form: 'Bag' });
  });
});

describe('a name from Object.prototype in an extension-only namespace', () => {
  it('resolves the DESCRIBED type, and nothing through the prototype', () => {
    const issues = (inner: string) => valueTypeIssues([{ packet: pkt(inner), main: true }], 2).map((i) => i.message);
    const described = ext(prop('constructor', 'Integer') + prop('__proto__', 'Integer'));
    expect(issues(`<acme:constructor>abc</acme:constructor>${described}`)).toHaveLength(1);
    expect(issues(`<acme:constructor>12</acme:constructor><acme:__proto__>7</acme:__proto__>${described}`)).toEqual([]);
    expect(issues(`<acme:toString>abc</acme:toString>${ext(prop('constructor', 'Integer'))}`)).toEqual([]);
  });
});

describe('one stream that is both the catalog\'s and a page\'s /Metadata', () => {
  const shared = (inner: string) => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    const ref = d.allocObject({ kind: 'stream', dict, raw: enc(text(inner)) });
    d.catalog().set('Metadata', ref);
    d.Pages[0].Dict.set('Metadata', ref);
    return d;
  };
  const pagePacket = (d: Document) => {
    const md = d.resolve(d.Pages[0].Dict.get('Metadata'));
    expect(isStream(md)).toBe(true);
    return parseRdfPacket(inflateStream(md as never));
  };

  // Called directly: inside ConvertToPdfA the identification pass rewrites the
  // catalog packet first, which already splits the two, so an end-to-end case
  // cannot see the in-place write.
  it('is repaired for both by repairXmpValueTypes', () => {
    const d = shared('<dc:rights>R</dc:rights>');
    expect(repairXmpValueTypes(d, 2)).toHaveLength(1);
    expect(d.catalog().get('Metadata')).toEqual(d.Pages[0].Dict.get('Metadata'));
    expect(pagePacket(d).properties.find((p) => p.name === 'rights')!.value).toMatchObject({ kind: 'array', form: 'Alt' });
  });

  it('is repaired for both, so the value-type rule passes after conversion', () => {
    const d = shared('<dc:rights>R</dc:rights>');
    const report = d.ConvertToPdfA('2b');
    expect(report.unresolved.map((i) => i.rule)).not.toContain('XmpValueType');
    expect(pagePacket(d).properties.find((p) => p.name === 'rights')!.value).toMatchObject({ kind: 'array', form: 'Alt' });
  });

  // Part 1, where an object-level packet may NOT borrow the catalog's
  // descriptions, so it must carry its own. (At parts 2-3 the catalog's
  // description covers it and the page packet needs none.)
  it('is described for both, so the extension-schema rule passes after conversion', () => {
    const d = shared('<acme:Batch>B1</acme:Batch>');
    const report = d.ConvertToPdfA('1b');
    expect(report.unresolved.map((i) => i.rule)).not.toContain('XmpPropertyNotDescribed');
    expect(pagePacket(d).properties.some((p) => p.name === 'schemas')).toBe(true);
  });

  it('does not repeat in a page packet what the catalog describes at parts 2-3', () => {
    const d = shared('<acme:Batch>B1</acme:Batch>');
    const report = d.ConvertToPdfA('2b');
    expect(report.unresolved.map((i) => i.rule)).not.toContain('XmpPropertyNotDescribed');
    expect(pagePacket(d).properties.some((p) => p.name === 'schemas')).toBe(false);
  });
});
