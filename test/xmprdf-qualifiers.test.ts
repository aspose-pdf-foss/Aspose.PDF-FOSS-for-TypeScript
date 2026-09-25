import { describe, it, expect } from 'vitest';
import { parseRdfPacket, serializeRdfPacket, RDF_NS, type RdfProperty } from '../src/xmprdf.js';
import { PdfParseError } from '../src/errors.js';

// o6uu.2: the rdf:value + qualifier forms and rdf:resource URI values.

const enc = (s: string) => new TextEncoder().encode(s);
const DC = 'http://purl.org/dc/elements/1.1/';
const MM = 'http://ns.adobe.com/xap/1.0/mm/';
const REF = 'http://ns.adobe.com/xap/1.0/sType/ResourceRef#';
const IDQ = 'http://ns.adobe.com/xmp/Identifier/qual/1.0/';
const Q = 'http://example.com/q/';
const NS = `xmlns:dc="${DC}" xmlns:xmpMM="${MM}" xmlns:stRef="${REF}" xmlns:xmpidq="${IDQ}" xmlns:q="${Q}"`;
const props = (inner: string) => parseRdfPacket(enc(
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + `<rdf:Description rdf:about="" ${NS}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`)).properties;
const simple = (value: string) => ({ kind: 'simple' as const, value });
const uri = (value: string) => ({ kind: 'simple' as const, value, uri: true as const });
const scheme = (s: string) => ({ ns: IDQ, name: 'Scheme', value: simple(s) });
const write = (properties: RdfProperty[]) => serializeRdfPacket({ properties, prefixes: new Map() });
const back = (properties: RdfProperty[]) => parseRdfPacket(enc(write(properties))).properties;

describe('parseRdfPacket: qualifiers', () => {
  it('reads parseType="Resource" with rdf:value as a qualified value, qualifier first or last', () => {
    for (const body of [
      '<dc:identifier rdf:parseType="Resource"><xmpidq:Scheme>isbn</xmpidq:Scheme><rdf:value>978</rdf:value></dc:identifier>',
      '<dc:identifier rdf:parseType="Resource"><rdf:value>978</rdf:value><xmpidq:Scheme>isbn</xmpidq:Scheme></dc:identifier>',
    ]) {
      expect(props(body)[0]).toEqual({ ns: DC, name: 'identifier', value: simple('978'), qualifiers: [scheme('isbn')] });
    }
  });

  it('reads the nested rdf:Description form, with rdf:value as element or attribute', () => {
    const want = { ns: DC, name: 'identifier', value: simple('978'), qualifiers: [scheme('isbn')] };
    expect(props('<dc:identifier><rdf:Description xmpidq:Scheme="isbn"><rdf:value>978</rdf:value>'
      + '</rdf:Description></dc:identifier>')[0]).toEqual(want);
    expect(props('<dc:identifier><rdf:Description rdf:value="978" xmpidq:Scheme="isbn"/></dc:identifier>')[0])
      .toEqual(want);
  });

  it('reads the abbreviated attribute form', () => {
    expect(props('<dc:identifier rdf:value="978" xmpidq:Scheme="isbn"/>')[0])
      .toEqual({ ns: DC, name: 'identifier', value: simple('978'), qualifiers: [scheme('isbn')] });
  });

  it('qualifies a list item and a struct field', () => {
    const [bag, st] = props(
      '<dc:subject><rdf:Bag><rdf:li rdf:parseType="Resource"><rdf:value>a</rdf:value><q:w>1</q:w></rdf:li></rdf:Bag></dc:subject>'
      + '<xmpMM:DerivedFrom rdf:parseType="Resource"><stRef:documentID rdf:value="d" q:w="2"/></xmpMM:DerivedFrom>');
    expect(bag.value).toEqual({ kind: 'array', form: 'Bag',
      items: [{ value: simple('a'), qualifiers: [{ ns: Q, name: 'w', value: simple('1') }] }] });
    expect(st.value).toEqual({ kind: 'struct', fields: [
      { ns: REF, name: 'documentID', value: simple('d'), qualifiers: [{ ns: Q, name: 'w', value: simple('2') }] }] });
  });

  it('reads a qualifier that is itself qualified', () => {
    expect(props('<dc:identifier rdf:parseType="Resource"><rdf:value>978</rdf:value>'
      + '<xmpidq:Scheme rdf:value="isbn" q:w="deep"/></dc:identifier>')[0].qualifiers)
      .toEqual([{ ...scheme('isbn'), qualifiers: [{ ns: Q, name: 'w', value: simple('deep') }] }]);
  });

  it('takes xml:lang from the outer element or from rdf:value, and refuses a conflict', () => {
    const outer = props('<dc:rights xml:lang="en" rdf:parseType="Resource"><rdf:value>r</rdf:value><q:w>1</q:w></dc:rights>')[0];
    const inner = props('<dc:rights rdf:parseType="Resource"><rdf:value xml:lang="en">r</rdf:value><q:w>1</q:w></dc:rights>')[0];
    expect(outer.lang).toBe('en');
    expect(inner.lang).toBe('en');
    expect(inner.value).toEqual(outer.value);
    // xml:lang is INHERITED (o6uu.5): on the outer element it reaches the
    // qualifier as well; on rdf:value it reaches the value alone.
    expect(outer.qualifiers![0].lang).toBe('en');
    expect(inner.qualifiers![0].lang).toBeUndefined();
    expect(() => props('<dc:rights xml:lang="en" rdf:parseType="Resource"><rdf:value xml:lang="de">r</rdf:value></dc:rights>'))
      .toThrow(/conflicting xml:lang/);
  });

  it('reads an rdf:value with no qualifiers as a plain value', () => {
    expect(props('<dc:format rdf:parseType="Resource"><rdf:value>f</rdf:value></dc:format>')[0])
      .toEqual({ ns: DC, name: 'format', value: simple('f') });
  });

  it('refuses two rdf:values and a qualified rdf:value', () => {
    expect(() => props('<dc:format rdf:parseType="Resource"><rdf:value>a</rdf:value><rdf:value>b</rdf:value></dc:format>'))
      .toThrow(/more than one rdf:value/);
    expect(() => props('<dc:format rdf:value="a" rdf:parseType="Resource"><rdf:value>b</rdf:value></dc:format>'))
      .toThrow(/more than one rdf:value/);
    expect(() => props('<dc:format rdf:parseType="Resource"><rdf:value rdf:value="a" q:w="1"/></dc:format>'))
      .toThrow(/rdf:value may not itself be qualified/);
  });
});

describe('parseRdfPacket: rdf:resource URI values', () => {
  it('flags rdf:resource on a property, an rdf:li, a struct field and rdf:value', () => {
    const [p, seq, st, qv] = props(
      '<dc:source rdf:resource="http://e/0"/>'
      + '<dc:type><rdf:Seq><rdf:li rdf:resource="http://e/1"/></rdf:Seq></dc:type>'
      + '<xmpMM:DerivedFrom rdf:parseType="Resource"><stRef:filePath rdf:resource="http://e/2"/></xmpMM:DerivedFrom>'
      + '<dc:relation rdf:parseType="Resource"><rdf:value rdf:resource="http://e/3"/><q:w>1</q:w></dc:relation>');
    expect(p.value).toEqual(uri('http://e/0'));
    expect(seq.value).toEqual({ kind: 'array', form: 'Seq', items: [{ value: uri('http://e/1') }] });
    expect(st.value).toEqual({ kind: 'struct', fields: [{ ns: REF, name: 'filePath', value: uri('http://e/2') }] });
    expect(qv.value).toEqual(uri('http://e/3'));
  });

  it('refuses rdf:resource beside rdf:value', () => {
    expect(() => props('<dc:source rdf:resource="http://e/1" rdf:value="x"/>')).toThrow(PdfParseError);
  });
});

describe('serializeRdfPacket: qualifiers and URIs', () => {
  const model: RdfProperty[] = [
    { ns: 'http://ns.adobe.com/xap/1.0/', name: 'Identifier', value: { kind: 'array', form: 'Bag', items: [
      { value: simple('978'), qualifiers: [scheme('isbn')] },
      { value: uri('https://e.com/b'), qualifiers: [{ ...scheme('uri'),
        qualifiers: [{ ns: Q, name: 'deep', value: simple('x') }] }] }] } },
    { ns: DC, name: 'rights', value: simple('r'), lang: 'en', qualifiers: [{ ns: Q, name: 'w', value: simple('1') }] },
    { ns: DC, name: 'source', value: uri('http://e.com/a?x=1&y=2') },
    { ns: MM, name: 'DerivedFrom', value: { kind: 'struct', fields: [
      { ns: REF, name: 'filePath', value: uri('file:///a'), qualifiers: [{ ns: Q, name: 'w', value: simple('2') }] }] } },
    { ns: DC, name: 'relation', value: { kind: 'array', form: 'Seq', items: [{ value: simple('s') }] },
      qualifiers: [{ ns: Q, name: 'w', value: simple('3') }] },
  ];

  it('round-trips qualified values, nested qualifiers and URIs', () => {
    expect(back(model)).toEqual(model);
  });

  it('keeps rdf:resource an attribute, writes rdf:value first, and xml:lang on the outer element', () => {
    const s = write(model);
    expect(s).toContain('<dc:source rdf:resource="http://e.com/a?x=1&amp;y=2"/>');
    expect(s).toContain('<rdf:value rdf:resource="https://e.com/b"/>');
    expect(s).not.toContain('>http://e.com/a?x=1&amp;y=2<');
    // The qualifier states no language under an element that does, so it
    // cancels the inherited one — or it would read back as 'en' (o6uu.5).
    expect(s).toMatch(/<dc:rights xml:lang="en" rdf:parseType="Resource">\s*<rdf:value>r<\/rdf:value>\s*<ns\d+:w xml:lang="">1<\/ns\d+:w>/);
  });

  it('writes an empty qualifier list as no qualifiers', () => {
    expect(write([{ ns: DC, name: 'format', value: simple('f'), qualifiers: [] }])).not.toContain('rdf:value');
  });

  it('refuses a qualifier it cannot write', () => {
    expect(() => write([{ ns: DC, name: 'format', value: simple('f'),
      qualifiers: [{ ns: RDF_NS, name: 'value', value: simple('x') }] }])).toThrow(TypeError);
    expect(() => write([{ ns: DC, name: 'source', value: { kind: 'simple', value: 'a\u0001', uri: true } }]))
      .toThrow(TypeError);
  });
});
