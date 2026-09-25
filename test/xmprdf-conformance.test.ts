import { describe, it, expect } from 'vitest';
import { parseRdfPacket, serializeRdfPacket, RDF_NS, type RdfPacket, type RdfProperty } from '../src/xmprdf.js';
import { parseXml } from '../src/xml.js';
import { PdfParseError } from '../src/errors.js';
import { editXmpPacket } from '../src/xmp.js';

// XML-conformance residue from the o6uu.1 review (o6uu.5).

const enc = (s: string) => new TextEncoder().encode(s);
const DC = 'http://purl.org/dc/elements/1.1/';
const EX = 'http://example.com/ns/';
const NS = `xmlns:dc="${DC}" xmlns:ex="${EX}"`;
const wrap = (body: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">${body}</rdf:RDF></x:xmpmeta>`;
const desc = (inner: string, attrs = '') => `<rdf:Description rdf:about="" ${NS}${attrs}>${inner}</rdf:Description>`;
const parse = (s: string) => parseRdfPacket(enc(s));
const props = (inner: string, attrs = '') => parse(wrap(desc(inner, attrs))).properties;
const simple = (value: string) => ({ kind: 'simple' as const, value });
const roundTrip = (p: RdfPacket) => parse(serializeRdfPacket(p));
const packet = (properties: RdfProperty[]): RdfPacket => ({ properties, prefixes: new Map() });

describe('1. line endings and attribute whitespace', () => {
  it('writes a CR in a value so a conforming reader returns it', () => {
    const p = packet([{ ns: DC, name: 'format', value: simple('a\r\nb\rc') }]);
    const text = serializeRdfPacket(p);
    expect(text).not.toMatch(/\r/);
    expect(roundTrip(p).properties).toEqual(p.properties);
  });

  it('writes tab, LF and CR in an attribute value as character references', () => {
    const p = packet([{ ns: DC, name: 'source', value: { kind: 'simple', value: 'u\tv\nw\rx', uri: true } }]);
    const text = serializeRdfPacket(p);
    expect(text).toContain('rdf:resource="u&#x9;v&#xA;w&#xD;x"');
    expect(roundTrip(p).properties).toEqual(p.properties);
  });

  it('normalizes CRLF and a bare CR in element text to LF on read', () => {
    expect(props('<dc:format>a\r\nb\rc</dc:format>')[0].value).toEqual(simple('a\nb\nc'));
  });

  it('normalizes a literal tab, LF or CR in an attribute value to a space on read', () => {
    expect(props('', ' dc:format="a\tb\nc\r\nd"')[0].value).toEqual(simple('a b c d'));
  });

  it('keeps a character reference to CR as a CR', () => {
    expect(props('<dc:format>a&#xD;b</dc:format>')[0].value).toEqual(simple('a\rb'));
  });

  it('leaves parseXml without the option byte-for-byte as it was', () => {
    const n = parseXml(enc('<a b="x\ty">p\r\nq</a>'));
    expect(n.attrs.get('b')).toBe('x\ty');
    expect(n.text).toBe('p\r\nq');
    const m = parseXml(enc('<a b="x\ty">p\r\nq</a>'), undefined, { normalize: true });
    expect(m.attrs.get('b')).toBe('x y');
    expect(m.text).toBe('p\nq');
  });
});

describe('2. xml:lang inheritance', () => {
  it('gives an Alt item the language stated on the rdf:Alt', () => {
    const [p] = props('<dc:title><rdf:Alt xml:lang="en"><rdf:li>Hi</rdf:li></rdf:Alt></dc:title>');
    expect(p.value).toEqual({ kind: 'array', form: 'Alt', items: [{ value: simple('Hi'), lang: 'en' }] });
  });

  it('gives a simple property the language stated on its rdf:Description', () => {
    expect(props('<dc:format>x</dc:format>', ' xml:lang="de"')).toEqual([{ ns: DC, name: 'format', value: simple('x'), lang: 'de' }]);
  });

  it('gives a property attribute the language in force', () => {
    expect(props('', ' xml:lang="de" dc:format="x"')).toEqual([{ ns: DC, name: 'format', value: simple('x'), lang: 'de' }]);
  });

  it('lets an inner xml:lang override, and xml:lang="" cancel', () => {
    const [p] = props('<dc:subject><rdf:Bag xml:lang="en"><rdf:li xml:lang="fr">a</rdf:li>'
      + '<rdf:li xml:lang="">b</rdf:li><rdf:li>c</rdf:li></rdf:Bag></dc:subject>');
    expect(p.value).toEqual({ kind: 'array', form: 'Bag', items: [
      { value: simple('a'), lang: 'fr' }, { value: simple('b') }, { value: simple('c'), lang: 'en' }] });
  });

  it('does not give a URI value an inherited language', () => {
    expect(props('<dc:source rdf:resource="http://x"/>', ' xml:lang="de"'))
      .toEqual([{ ns: DC, name: 'source', value: { kind: 'simple', value: 'http://x', uri: true } }]);
  });

  it('reads a stated empty xml:lang as no language', () => {
    expect(props('<dc:format xml:lang="">x</dc:format>')).toEqual([{ ns: DC, name: 'format', value: simple('x') }]);
  });

  it('reads a stated empty xml:lang on a node holding an array as no language', () => {
    // A literal reads the language in force; a non-literal node reads its OWN,
    // which is a separate path — so the empty-means-none rule needs its own case.
    const [p] = props('<dc:subject xml:lang=""><rdf:Bag><rdf:li>a</rdf:li></rdf:Bag></dc:subject>');
    expect('lang' in p).toBe(false);
  });

  it('refuses a property attribute on an array node', () => {
    expect(() => props('<dc:subject><rdf:Bag ex:a="1"><rdf:li>a</rdf:li></rdf:Bag></dc:subject>')).toThrow(PdfParseError);
  });

  it('refuses an rdf:* attribute on an array node', () => {
    expect(() => props('<dc:subject><rdf:Bag rdf:about="x"><rdf:li>a</rdf:li></rdf:Bag></dc:subject>')).toThrow(PdfParseError);
  });

  it('round-trips a language on a node holding an array whose items state none', () => {
    const p = packet([{ ns: DC, name: 'subject', lang: 'en',
      value: { kind: 'array', form: 'Bag', items: [{ value: simple('a') }, { value: simple('b'), lang: 'en' }] } }]);
    expect(roundTrip(p).properties).toEqual(p.properties);
  });

  it('round-trips a language on a qualified item whose qualifiers state none', () => {
    const p = packet([{ ns: DC, name: 'title', value: { kind: 'array', form: 'Alt', items: [
      { value: simple('Hi'), lang: 'en', qualifiers: [{ ns: EX, name: 'q', value: simple('v') }] }] } }]);
    expect(roundTrip(p).properties).toEqual(p.properties);
  });

  it('writes no extra xml:lang for a model with no nested language', () => {
    const p = packet([{ ns: DC, name: 'title', value: { kind: 'array', form: 'Alt',
      items: [{ value: simple('Hi'), lang: 'x-default' }] } }]);
    expect(serializeRdfPacket(p)).not.toContain('xml:lang=""');
  });
});

describe('3. rdf:about', () => {
  it('refuses two Descriptions stating different non-empty rdf:about values', () => {
    const s = wrap(`<rdf:Description rdf:about="uuid:a" ${NS}><dc:format>x</dc:format></rdf:Description>`
      + `<rdf:Description rdf:about="uuid:b" ${NS}><dc:type>y</dc:type></rdf:Description>`);
    expect(() => parse(s)).toThrow(/rdf:about/);
  });

  it('merges a Description with an empty or absent rdf:about into a stated one', () => {
    const s = wrap(`<rdf:Description rdf:about="uuid:a" ${NS}><dc:format>x</dc:format></rdf:Description>`
      + `<rdf:Description rdf:about="" ${NS}><dc:type>y</dc:type></rdf:Description>`
      + `<rdf:Description ${NS}><dc:source>z</dc:source></rdf:Description>`);
    const p = parse(s);
    expect(p.about).toBe('uuid:a');
    expect(p.properties.map((q) => q.name)).toEqual(['format', 'type', 'source']);
  });

  it('carries a non-empty rdf:about through a write, and leaves it absent when empty', () => {
    const p = parse(wrap(`<rdf:Description rdf:about="uuid:a" ${NS}><dc:format>x</dc:format></rdf:Description>`));
    expect(serializeRdfPacket(p)).toContain('rdf:about="uuid:a"');
    expect(roundTrip(p).about).toBe('uuid:a');
    expect('about' in parse(wrap(desc('<dc:format>x</dc:format>')))).toBe(false);
  });
});

describe('3. rdf:about through SetXmp', () => {
  it('survives an edit of the packet', () => {
    const src = enc(wrap(`<rdf:Description rdf:about="uuid:a" ${NS}><dc:format>x</dc:format></rdf:Description>`));
    expect(parse(editXmpPacket(src, { title: 'T' })!).about).toBe('uuid:a');
  });
});

describe('5. a prefix bound to the empty namespace', () => {
  it('says so rather than calling it unbound', () => {
    expect(() => props('<ns0:format xmlns:ns0="">x</ns0:format>')).toThrow(/bound to the empty namespace/);
  });
});
