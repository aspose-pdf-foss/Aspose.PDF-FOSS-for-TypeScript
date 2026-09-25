import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS, parseRdfPacket } from '../src/xmprdf.js';
import { repairShape } from '../src/pdfavaluetypes.js';
import { XmpTypeRegistry } from '../src/xmptypes.js';
import { inflateStream } from '../src/flate.js';
import { isStream } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const NS = 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/"';
const text = (inner: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
  + `<rdf:Description rdf:about="" ${NS}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`;
const DC = 'http://purl.org/dc/elements/1.1/';
const stream = (inner: string) => {
  const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
  return { kind: 'stream' as const, dict, raw: enc(text(inner)) };
};
const withXmp = (inner: string) => {
  const d = Document.New();
  d.AddPage(PageFormat.A4);
  d.catalog().set('Metadata', d.allocObject(stream(inner)));
  return d;
};
const r = XmpTypeRegistry.forEra('2005');
const S = (value: string) => ({ kind: 'simple' as const, value });

describe('repairShape', () => {
  it('wraps a simple value as the Lang Alt x-default item', () => {
    expect(repairShape(S('R'), 'lang alt', r)).toEqual({ kind: 'array', form: 'Alt', items: [{ value: S('R'), lang: 'x-default' }] });
  });
  it('wraps a simple value as a one-item array of the expected form', () => {
    expect(repairShape(S('Ann'), 'bag propername', r)).toEqual({ kind: 'array', form: 'Bag', items: [{ value: S('Ann') }] });
  });
  it('swaps Bag and Seq, keeping item order', () => {
    const bag = { kind: 'array' as const, form: 'Bag' as const, items: [{ value: S('a') }, { value: S('b') }] };
    expect(repairShape(bag, 'seq propername', r)).toEqual({ ...bag, form: 'Seq' });
  });
  it('turns a one-item Seq into an Alt, but not a two-item one', () => {
    const one = { kind: 'array' as const, form: 'Seq' as const, items: [{ value: S('a') }] };
    expect(repairShape(one, 'alt text', r)).toEqual({ ...one, form: 'Alt' });
    expect(repairShape({ ...one, items: [...one.items, { value: S('b') }] }, 'alt text', r)).toBeUndefined();
  });
  it('declines what it cannot make valid', () => {
    expect(repairShape(S('abc'), 'integer', r)).toBeUndefined();
    expect(repairShape(S('abc'), 'seq integer', r)).toBeUndefined();   // the item itself fails
  });
});

describe('ConvertToPdfA xmpValueTypes pass', () => {
  it('repairs shapes, keeps the text, and passes the rule', () => {
    const d = withXmp('<dc:rights>All rights</dc:rights><dc:contributor><rdf:Seq><rdf:li>A</rdf:li></rdf:Seq></dc:contributor>');
    const report = d.ConvertToPdfA('2b');
    expect(report.applied.filter((a) => a.rule === 'XmpValueType')).toHaveLength(2);
    expect(report.unresolved.map((i) => i.rule)).not.toContain('XmpValueType');
    expect(d.GetXmpValue(DC, 'rights')!.asText()).toBe('All rights');
    expect(d.GetXmpValue(DC, 'contributor')!.raw).toMatchObject({ kind: 'array', form: 'Bag' });
  });

  it('leaves an unrepairable value as written and reports it', () => {
    const d = withXmp('<tiff:ImageWidth>wide</tiff:ImageWidth>');
    const report = d.ConvertToPdfA('2b');
    expect(report.unresolved.map((i) => i.rule)).toContain('XmpValueType');
    expect(d.GetXmpValue('http://ns.adobe.com/tiff/1.0/', 'ImageWidth')!.asText()).toBe('wide');
  });

  it('repairs an object-level packet in its own stream', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    d.Pages[0].Dict.set('Metadata', d.allocObject(stream('<dc:rights>R</dc:rights>')));
    d.ConvertToPdfA('2b');
    const md = d.resolve(d.Pages[0].Dict.get('Metadata'));
    expect(isStream(md)).toBe(true);
    const packet = parseRdfPacket(inflateStream(md as never));
    expect(packet.properties.find((p) => p.name === 'rights')!.value).toMatchObject({ kind: 'array', form: 'Alt' });
  });

  it('keeps the object-level stream\'s other dict entries, dropping only the encoding', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    const s = stream('<dc:rights>R</dc:rights>');
    s.dict.set('Foo', name('Bar'));
    d.Pages[0].Dict.set('Metadata', d.allocObject(s));
    d.ConvertToPdfA('2b');
    const md = d.resolve(d.Pages[0].Dict.get('Metadata'));
    expect(isStream(md)).toBe(true);
    const dict = (md as { dict: PdfDict }).dict;
    expect(dict.get('Foo')).toEqual(name('Bar'));
    expect(dict.get('Type')).toEqual(name('Metadata'));
    expect(dict.has('Filter')).toBe(false);
  });

  it('is declined by preserve: [\'xmpValueTypes\']', () => {
    const d = withXmp('<dc:rights>R</dc:rights>');
    const report = d.ConvertToPdfA('2b', { preserve: ['xmpValueTypes'] });
    expect(report.unresolved.map((i) => i.rule)).toContain('XmpValueType');
    expect(d.GetXmpValue(DC, 'rights')!.raw).toEqual(S('R'));
  });

  it('does nothing to a packet that will not parse', () => {
    const d = Document.New();
    d.AddPage(PageFormat.A4);
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.Pages[0].Dict.set('Metadata', d.allocObject({ kind: 'stream', dict, raw: enc('<x:xmpmeta') }));
    expect(() => d.ConvertToPdfA('2b')).not.toThrow();
  });
});
