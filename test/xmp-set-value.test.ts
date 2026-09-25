import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS } from '../src/xmprdf.js';
import { buildSigner } from './helpers/build-signer.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const PDF = 'http://ns.adobe.com/pdf/1.3/';
const MM = 'http://ns.adobe.com/xap/1.0/mm/';
const ACME = 'http://acme.example/ns/1.0/';
const OTHER = 'http://other.example/ns/';
const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };
const withXmp = (body: string, ns = '') => {
  const d = doc1();
  const text = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about=""`
    + ` xmlns:dc="${DC}" xmlns:xmpMM="${MM}" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"${ns}>`
    + `${body}</rdf:Description></rdf:RDF></x:xmpmeta>`;
  const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
  d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode(text) }));
  return d;
};
const HISTORY = '<xmpMM:History><rdf:Seq><rdf:li rdf:parseType="Resource"><stEvt:action>created</stEvt:action>'
  + '</rdf:li></rdf:Seq></xmpMM:History>';

describe('SetXmpValue writes and reads back', () => {
  it('writes each shape to a document with no packet yet', () => {
    const d = doc1();
    d.SetXmpValue(ACME, 'Count', 12);
    d.SetXmpValue(ACME, 'Ok', true);
    d.SetXmpValue(ACME, 'Tags', { bag: ['a', 'b'] });
    d.SetXmpValue(ACME, 'Home', { uri: 'http://acme.example/' });
    d.SetXmpValue(ACME, 'Where', { struct: [{ namespace: ACME, name: 'City', value: 'Oslo' }] });
    expect(d.GetXmpValue(ACME, 'Count')!.asInt()).toBe(12);
    expect(d.GetXmpValue(ACME, 'Ok')!.asBool()).toBe(true);
    expect(d.GetXmpValue(ACME, 'Tags')!.asArray()!.map((v) => v.asText())).toEqual(['a', 'b']);
    expect(d.GetXmpValue(ACME, 'Home')!.asUri()).toBe('http://acme.example/');
    expect(d.GetXmpValue(ACME, 'Where')!.raw).toEqual({ kind: 'struct', fields: [{ ns: ACME, name: 'City', value: { kind: 'simple', value: 'Oslo' } }] });
  });

  it('replaces an existing property and keeps everything it does not name', () => {
    const d = withXmp(HISTORY + '<dc:format>application/pdf</dc:format>');
    d.SetXmpValue(DC, 'format', 'text/plain');
    expect(d.GetXmpValue(DC, 'format')!.asText()).toBe('text/plain');
    expect(d.GetXmpValue(MM, 'History')!.asArray()).toHaveLength(1);
  });

  it('writes title translations, x-default first, and mirrors x-default to /Title', () => {
    const d = doc1();
    d.SetXmpValue(DC, 'title', { lang: { de: 'Bericht', 'x-default': 'Report' } });
    expect(d.GetXmpValue(DC, 'title')!.asText('de')).toBe('Bericht');
    expect(d.GetMetadata().title).toBe('Report');
    expect(d.GetXmp().title).toBe('Report');
  });

  it('deletes with null, and deleting an absent property marks nothing modified', async () => {
    const d0 = withXmp('<dc:format>application/pdf</dc:format>');
    d0.SetXmpValue(DC, 'format', null);
    expect(d0.GetXmpValue(DC, 'format')).toBeUndefined();
    const base = doc1().Save();
    const d = Document.Open(base);
    d.SetXmpValue(ACME, 'Absent', null);
    const s = buildSigner();
    await d.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    expect(d.Save().subarray(0, base.length)).toEqual(base);
  });
});

describe('prefixes', () => {
  it('the caller\'s prefix wins over a foreign namespace that held it', () => {
    const d = withXmp('<acme:Old><rdf:Bag><rdf:li>o</rdf:li></rdf:Bag></acme:Old>', ` xmlns:acme="${OTHER}"`);
    d.SetXmpValue(ACME, 'Batch', 'B1', { prefix: 'acme' });
    expect(d.GetXmp().custom?.find((c) => c.namespace === ACME)?.prefix).toBe('acme');
  });

  it('without a prefix, the packet\'s own binding stands', () => {
    const d = withXmp('<acme:Old>o</acme:Old>', ` xmlns:acme="${ACME}"`);
    d.SetXmpValue(ACME, 'Batch', 'B1');
    expect(d.GetXmp().custom?.find((c) => c.name === 'Batch')?.prefix).toBe('acme');
  });
});

describe('the eight mirrored properties', () => {
  it('update /Info through the sync rules', () => {
    const d = doc1();
    d.SetXmpValue(DC, 'creator', { seq: ['A', 'B'] });
    d.SetXmpValue(DC, 'description', 'About');
    d.SetXmpValue(PDF, 'Keywords', 'k1, k2');
    d.SetXmpValue(XMP, 'CreatorTool', 'Tool');
    d.SetXmpValue(PDF, 'Producer', 'Prod');
    const at = new Date(Date.UTC(2024, 5, 3, 12, 30, 45));
    d.SetXmpValue(XMP, 'CreateDate', at);
    d.SetXmpValue(XMP, 'ModifyDate', '2024-06-03T14:30:45+02:00');
    const m = d.GetMetadata();
    expect(m).toMatchObject({ author: 'A, B', subject: 'About', keywords: 'k1, k2', creator: 'Tool', producer: 'Prod' });
    expect(m.creationDate).toEqual(at);
    expect(m.modDate).toEqual(at);
  });

  it('deletes the /Info key when the value cannot be represented there', () => {
    const d = doc1();
    d.SetMetadata({ title: 'Old' });
    d.SetXmpValue(DC, 'title', { struct: [{ namespace: ACME, name: 'x', value: 'y' }] });
    expect(d.GetMetadata().title).toBeUndefined();
  });

  it('deletes /Info alongside the property', () => {
    const d = doc1();
    d.SetMetadata({ producer: 'P' });
    d.SetXmpValue(PDF, 'Producer', null);
    expect(d.GetMetadata().producer).toBeUndefined();
  });

  it('leave /Info alone for a non-mirrored property', () => {
    const d = doc1();
    d.SetXmpValue(DC, 'coverage', 'Europe');
    expect(d.trailer.has('Info')).toBe(false);
  });
});

describe('all-or-nothing', () => {
  it('a rejected value leaves the saved bytes identical', () => {
    const d = withXmp('<dc:format>application/pdf</dc:format>');
    d.SetMetadata({ title: 'T' });
    const before = d.Save();
    expect(() => d.SetXmpValue(DC, 'title', Number.NaN)).toThrow(TypeError);
    expect(() => d.SetXmpValue(ACME, 'P', 'v', { prefix: 'dc' })).toThrow(RangeError);
    expect(d.Save()).toEqual(before);
  });

  it('a ResourceLimitError leaves /Info untouched', () => {
    const deep = '<acme:a rdf:parseType="Resource">'.repeat(300) + '<acme:v>x</acme:v>' + '</acme:a>'.repeat(300);
    const d = withXmp(deep, ` xmlns:acme="${ACME}"`);
    expect(() => d.SetXmpValue(PDF, 'Producer', 'P')).toThrow(ResourceLimitError);
    expect(d.GetMetadata().producer).toBeUndefined();
    const loose = Document.Open(d.Save(), { limits: LoadLimits.defaults.with({ maxNestingDepth: 2000 }) });
    loose.SetXmpValue(PDF, 'Producer', 'P');
    expect(loose.GetMetadata().producer).toBe('P');
  });
});
