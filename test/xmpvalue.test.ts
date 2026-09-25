import { describe, it, expect } from 'vitest';
import { XmpValue, findXmpValue } from '../src/xmpvalue.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS, type RdfValue } from '../src/xmprdf.js';

const s = (value: string): RdfValue => ({ kind: 'simple', value });
const alt = (...items: [string, string][]): RdfValue =>
  ({ kind: 'array', form: 'Alt', items: items.map(([lang, v]) => ({ lang, value: s(v) })) });
const v = (raw: RdfValue) => new XmpValue(raw);

describe('XmpValue.asText', () => {
  it('reads a simple value and refuses a URI, a struct and a Seq', () => {
    expect(v(s('hi')).asText()).toBe('hi');
    expect(v({ kind: 'simple', value: 'http://x', uri: true }).asText()).toBeUndefined();
    expect(v({ kind: 'struct', fields: [] }).asText()).toBeUndefined();
    expect(v({ kind: 'array', form: 'Seq', items: [{ value: s('a') }] }).asText()).toBeUndefined();
  });

  it('picks from an Alt: exact tag, then RFC 4647 match, then x-default, then first', () => {
    const t = alt(['en', 'Colour'], ['x-default', 'Default'], ['de-DE', 'Farbe'], ['en-US', 'Color']);
    expect(v(t).asText('en-US')).toBe('Color');       // exact beats the earlier range match
    expect(v(t).asText('de')).toBe('Farbe');          // range 'de' matches tag 'de-DE'
    expect(v(t).asText('fr')).toBe('Default');
    expect(v(t).asText()).toBe('Default');
    expect(v(alt(['en', 'A'], ['de', 'B'])).asText()).toBe('A');
    expect(v(alt()).asText()).toBeUndefined();
  });

  it('prefers an exact tag over an EARLIER item the range also matches', () => {
    // Range 'en' matches tag 'en-GB' under RFC 4647, and 'en-GB' comes first:
    // a range-only pick answers the British spelling for a caller who asked
    // for plain 'en'.
    expect(v(alt(['en-GB', 'Colour'], ['en', 'Color'])).asText('en')).toBe('Color');
  });
});

describe('XmpValue scalar converters', () => {
  it('asBool reads True/False case-insensitively and nothing else', () => {
    expect(v(s('True')).asBool()).toBe(true);
    expect(v(s('false')).asBool()).toBe(false);
    expect(v(s('1')).asBool()).toBeUndefined();
    expect(v(s(' True')).asBool()).toBeUndefined();
  });

  it('asInt is strict and safe-integer only', () => {
    expect(v(s('-42')).asInt()).toBe(-42);
    expect(v(s('+7')).asInt()).toBe(7);
    expect(v(s('12abc')).asInt()).toBeUndefined();
    expect(v(s('1.5')).asInt()).toBeUndefined();
    expect(v(s('9007199254740993')).asInt()).toBeUndefined();
  });

  it('asReal takes decimals, no exponent, NaN or Infinity', () => {
    expect(v(s('3.25')).asReal()).toBe(3.25);
    expect(v(s('-.5')).asReal()).toBe(-0.5);
    expect(v(s('7')).asReal()).toBe(7);
    expect(v(s('1e3')).asReal()).toBeUndefined();
    expect(v(s('NaN')).asReal()).toBeUndefined();
    expect(v(s('Infinity')).asReal()).toBeUndefined();
    expect(v(s('')).asReal()).toBeUndefined();
  });

  it('asDate keeps the ISO text beside the instant', () => {
    expect(v(s('2024-06-03T14:30:45+02:00')).asDate())
      .toEqual({ iso: '2024-06-03T14:30:45+02:00', date: new Date(Date.UTC(2024, 5, 3, 12, 30, 45)) });
    expect(v(s('D:20240603')).asDate()).toBeUndefined();
  });

  it('asUri reads only an rdf:resource value', () => {
    expect(v({ kind: 'simple', value: 'http://x', uri: true }).asUri()).toBe('http://x');
    expect(v(s('http://x')).asUri()).toBeUndefined();
  });

  it('asArray wraps the items of any container, and nothing else', () => {
    const bag: RdfValue = { kind: 'array', form: 'Bag', items: [{ value: s('a') }, { value: s('b') }] };
    expect(v(bag).asArray()!.map((x) => x.asText())).toEqual(['a', 'b']);
    expect(v(s('a')).asArray()).toBeUndefined();
  });
});

describe('findXmpValue', () => {
  it('finds a top-level property by namespace URI and name', () => {
    const packet = { properties: [{ ns: 'urn:a', name: 'p', value: s('x') }], prefixes: new Map() };
    expect(findXmpValue(packet, 'urn:a', 'p')!.asText()).toBe('x');
    expect(findXmpValue(packet, 'urn:b', 'p')).toBeUndefined();
  });
});

describe('doc.GetXmpValue', () => {
  const ACME = 'http://acme.example/ns/1.0/';
  const seed = (d: Document, body: string) => {
    const text = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
      + `<rdf:Description rdf:about="" xmlns:acme="${ACME}">${body}</rdf:Description></rdf:RDF></x:xmpmeta>`;
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode(text) }));
  };
  const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };

  it('reads typed values from the document packet', () => {
    const d = doc1();
    seed(d, '<acme:Count>12</acme:Count><acme:Ok>True</acme:Ok>');
    expect(d.GetXmpValue(ACME, 'Count')!.asInt()).toBe(12);
    expect(d.GetXmpValue(ACME, 'Ok')!.asBool()).toBe(true);
    expect(d.GetXmpValue(ACME, 'Missing')).toBeUndefined();
  });

  it('is undefined with no packet, and for a packet that will not parse', () => {
    const d = doc1();
    expect(d.GetXmpValue(ACME, 'Count')).toBeUndefined();
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')]]);
    d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode('<not xml') }));
    expect(d.GetXmpValue(ACME, 'Count')).toBeUndefined();
  });
});
