import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { editXmpPacket, readXmp } from '../src/xmp.js';
import { parseRdfPacket, RDF_NS, type RdfProperty } from '../src/xmprdf.js';

const enc = (s: string) => new TextEncoder().encode(s);
const DC = 'http://purl.org/dc/elements/1.1/';
const PDF = 'http://ns.adobe.com/pdf/1.3/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const PDFAID = 'http://www.aiim.org/pdfa/ns/id/';
const MM = 'http://ns.adobe.com/xap/1.0/mm/';
const EVT = 'http://ns.adobe.com/xap/1.0/sType/ResourceEvent#';
const ACME = 'http://acme.example/ns/1.0/';
const text = (body: string, extraNs = '') =>
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">`
  + `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about="" xmlns:dc="${DC}" xmlns:pdf="${PDF}"`
  + ` xmlns:xmpMM="${MM}" xmlns:stEvt="${EVT}" xmlns:acme="${ACME}"${extraNs}>${body}</rdf:Description>`
  + `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
const packet = (body: string, extraNs = '') => enc(text(body, extraNs));
const model = (s: string | undefined): RdfProperty[] => parseRdfPacket(enc(s!)).properties;
const find = (s: string | undefined, ns: string, name: string) => model(s).find((p) => p.ns === ns && p.name === name);
const simple = (value: string) => ({ kind: 'simple' as const, value });
const HISTORY = '<xmpMM:History><rdf:Seq><rdf:li rdf:parseType="Resource"><stEvt:action>created</stEvt:action>'
  + '</rdf:li></rdf:Seq></xmpMM:History>';
const TITLES = '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old</rdf:li>'
  + '<rdf:li xml:lang="de-DE">Alt</rdf:li></rdf:Alt></dc:title>';

describe('editXmpPacket: what it leaves alone', () => {
  it('keeps every property it does not own, byte-for-byte in the model', () => {
    const src = packet(HISTORY + '<acme:Info rdf:parseType="Resource"><acme:x>y</acme:x></acme:Info>'
      + '<dc:format>application/pdf</dc:format>');
    const before = parseRdfPacket(src).properties;
    const after = model(editXmpPacket(src, { title: 'New' }));
    expect(after.filter((p) => !(p.ns === DC && p.name === 'title'))).toEqual(before);
  });

  it('leaves a field whose update is undefined untouched', () => {
    const src = packet('<pdf:Producer>P</pdf:Producer>');
    expect(model(editXmpPacket(src, { producer: undefined }))).toEqual(parseRdfPacket(src).properties);
  });
});

describe('editXmpPacket: setting and deleting', () => {
  it('replaces a property in place, keeping its position', () => {
    const out = editXmpPacket(packet('<pdf:Producer>old</pdf:Producer><dc:format>f</dc:format>'), { producer: 'new' });
    expect(model(out).map((p) => p.name)).toEqual(['Producer', 'format']);
    expect(find(out, PDF, 'Producer')?.value).toEqual(simple('new'));
  });

  it('appends a property that was absent', () => {
    const out = editXmpPacket(packet('<dc:format>f</dc:format>'), { keywords: 'k' });
    expect(model(out).map((p) => p.name)).toEqual(['format', 'Keywords']);
  });

  it('deletes on null and leaves the rest', () => {
    const out = editXmpPacket(packet('<pdf:Producer>P</pdf:Producer><dc:format>f</dc:format>'), { producer: null });
    expect(model(out).map((p) => p.name)).toEqual(['format']);
  });

  it("drops a replaced property's qualifiers", () => {
    const out = editXmpPacket(packet('<pdf:Producer rdf:parseType="Resource"><rdf:value>old</rdf:value>'
      + '<acme:q>1</acme:q></pdf:Producer>'), { producer: 'new' });
    expect(find(out, PDF, 'Producer')).toEqual({ ns: PDF, name: 'Producer', value: simple('new') });
  });

  it('writes lists whole and deletes them on an empty list', () => {
    const out = editXmpPacket(packet('<dc:subject><rdf:Bag><rdf:li>old</rdf:li></rdf:Bag></dc:subject>'),
      { authors: ['A', 'B'], subjects: ['x'] });
    expect(find(out, DC, 'creator')?.value).toEqual({ kind: 'array', form: 'Seq',
      items: [{ value: simple('A') }, { value: simple('B') }] });
    expect(find(out, DC, 'subject')?.value).toEqual({ kind: 'array', form: 'Bag', items: [{ value: simple('x') }] });
    expect(find(editXmpPacket(enc(out!), { subjects: [] }), DC, 'subject')).toBeUndefined();
  });

  it('writes dates as ISO strings and numbers as their decimal text', () => {
    const out = editXmpPacket(undefined, {
      createDate: new Date('2024-06-03T12:30:45.000Z'), modifyDate: '2024-06-04T08:00:00+02:00',
      pdfaPart: 2, pdfaConformance: 'B',
    });
    expect(find(out, XMP, 'CreateDate')?.value).toEqual(simple('2024-06-03T12:30:45.000Z'));
    expect(find(out, XMP, 'ModifyDate')?.value).toEqual(simple('2024-06-04T08:00:00+02:00'));
    expect(find(out, PDFAID, 'part')?.value).toEqual(simple('2'));
    expect(find(out, PDFAID, 'conformance')?.value).toEqual(simple('B'));
  });
});

describe('editXmpPacket: language alternatives', () => {
  it('replaces only the x-default item and keeps the others in order', () => {
    const out = editXmpPacket(packet(TITLES), { title: 'Neu' });
    expect(find(out, DC, 'title')?.value).toEqual({ kind: 'array', form: 'Alt', items: [
      { value: simple('Neu'), lang: 'x-default' }, { value: simple('Alt'), lang: 'de-DE' }] });
  });

  it('inserts x-default first when the Alt has none', () => {
    const out = editXmpPacket(packet('<dc:title><rdf:Alt><rdf:li xml:lang="de-DE">Alt</rdf:li></rdf:Alt></dc:title>'),
      { title: 'New' });
    expect(find(out, DC, 'title')?.value).toEqual({ kind: 'array', form: 'Alt', items: [
      { value: simple('New'), lang: 'x-default' }, { value: simple('Alt'), lang: 'de-DE' }] });
  });

  it('replaces a malformed non-Alt value with a one-item Alt', () => {
    const out = editXmpPacket(packet('<dc:title>plain</dc:title>'), { title: 'New' });
    expect(find(out, DC, 'title')?.value).toEqual({ kind: 'array', form: 'Alt',
      items: [{ value: simple('New'), lang: 'x-default' }] });
  });

  it('deletes the whole Alt on null', () => {
    expect(find(editXmpPacket(packet(TITLES), { title: null }), DC, 'title')).toBeUndefined();
  });
});

describe('editXmpPacket: custom', () => {
  const src = packet('<acme:BatchId>1</acme:BatchId><acme:Info rdf:parseType="Resource"><acme:x>y</acme:x></acme:Info>'
    + HISTORY);
  const op = { namespace: ACME, prefix: 'acme', name: 'Operator', value: 'jane' };

  it('replaces exactly the simple literals readXmp reports as custom', () => {
    const out = editXmpPacket(src, { custom: [op] });
    const names = model(out).map((p) => p.name);
    expect(names).not.toContain('BatchId');
    expect(names).toEqual(expect.arrayContaining(['Info', 'History', 'Operator']));
    expect(readXmp(enc(out!)).custom).toEqual(expect.arrayContaining([op]));
  });

  it('leaves a simple property outside custom alone', () => {
    // pdf:Producer is a built-in field, never reported as custom, so replacing
    // custom must not touch it. Without this case "delete what readXmp
    // reports" and "delete every simple literal" agree on every fixture.
    const out = editXmpPacket(packet('<pdf:Producer>P</pdf:Producer><acme:BatchId>1</acme:BatchId>'), { custom: [op] });
    expect(find(out, PDF, 'Producer')?.value).toEqual(simple('P'));
    expect(find(out, ACME, 'BatchId')).toBeUndefined();
  });

  it('removes them on null and keeps structs and arrays', () => {
    const names = model(editXmpPacket(src, { custom: null })).map((p) => p.name);
    expect(names).toEqual(['Info', 'History']);
  });

  it('refuses an invalid custom property before doing anything', () => {
    expect(() => editXmpPacket(src, { title: 'x', custom: [{ ...op, prefix: 'rdf' }] })).toThrow(TypeError);
  });
});

describe('editXmpPacket: starting model', () => {
  it('returns undefined when there was no packet and nothing was added', () => {
    expect(editXmpPacket(undefined, {})).toBeUndefined();
    expect(editXmpPacket(undefined, { title: null })).toBeUndefined();
  });

  it('builds a fresh packet from nothing', () => {
    expect(readXmp(enc(editXmpPacket(undefined, { title: 'T' })!)).title).toBe('T');
  });

  it('still writes a packet whose last property was deleted', () => {
    const out = editXmpPacket(packet('<pdf:Producer>P</pdf:Producer>'), { producer: null });
    expect(out).toBeDefined();
    expect(model(out)).toEqual([]);
  });

  it("falls back to readXmp's fields for a packet that will not parse", () => {
    const broken = enc('<!DOCTYPE x><x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:title><rdf:Alt>'
      + '<rdf:li xml:lang="x-default">Kept</rdf:li></rdf:Alt></dc:title>');
    const out = editXmpPacket(broken, { producer: 'P' });
    const back = readXmp(enc(out!));
    expect(back.title).toBe('Kept');
    expect(back.producer).toBe('P');
  });

  it('edits a UTF-16 packet', () => {
    const s = text(HISTORY);
    const utf16 = new Uint8Array(2 + s.length * 2);
    utf16[0] = 0xff; utf16[1] = 0xfe;
    for (let i = 0; i < s.length; i++) { utf16[2 + 2 * i] = s.charCodeAt(i) & 0xff; utf16[3 + 2 * i] = s.charCodeAt(i) >> 8; }
    const out = editXmpPacket(utf16, { title: 'T' });
    expect(find(out, MM, 'History')).toBeDefined();
    expect(readXmp(enc(out!)).title).toBe('T');
  });
});

describe('editXmpPacket: rulings the plan added', () => {
  it('writes the built-in namespaces under their standard prefixes', () => {
    const src = enc(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
      + `<rdf:Description rdf:about="" xmlns:dcx="${DC}" xmlns:dc="http://not-dc.example/">`
      + '<dcx:format>f</dcx:format><dc:foreign>kept</dc:foreign></rdf:Description></rdf:RDF></x:xmpmeta>');
    const out = editXmpPacket(src, { title: 'New', pdfaPart: 2 });
    expect(readXmp(enc(out!)).title).toBe('New');
    expect(readXmp(enc(out!)).pdfaPart).toBe(2);
    expect(out).toContain(`xmlns:dc="${DC}"`);
    expect(find(out, 'http://not-dc.example/', 'foreign')?.value).toEqual(simple('kept'));
  });

  it('strips characters XML cannot carry from mapped values', () => {
    const out = editXmpPacket(undefined, { title: 'a\u0000b', authors: ['c\u0001d'] });
    expect(readXmp(enc(out!)).title).toBe('ab');
    expect(readXmp(enc(out!)).authors).toEqual(['cd']);
  });
});

describe('editXmpPacket: final-review fixes', () => {
  it('strips characters XML cannot carry from PRESERVED content rather than throwing', () => {
    const src = packet('<acme:bar>a&#x1;b</acme:bar>'
      + '<dc:rights><rdf:Alt><rdf:li xml:lang="e&#x1;n">r</rdf:li></rdf:Alt></dc:rights>');
    const out = editXmpPacket(src, { title: 'T' });
    expect(find(out, ACME, 'bar')?.value).toEqual(simple('ab'));
    expect(find(out, DC, 'rights')?.value).toEqual({ kind: 'array', form: 'Alt', items: [{ value: simple('r'), lang: 'en' }] });
  });

  it('moves the replaced x-default item first, so readXmp reads the new title', () => {
    const src = packet('<dc:title><rdf:Alt><rdf:li xml:lang="en">English</rdf:li>'
      + '<rdf:li xml:lang="x-default">Old</rdf:li></rdf:Alt></dc:title>');
    const out = editXmpPacket(src, { title: 'New' });
    expect(readXmp(enc(out!)).title).toBe('New');
    expect(find(out, DC, 'title')?.value).toEqual({ kind: 'array', form: 'Alt', items: [
      { value: simple('New'), lang: 'x-default' }, { value: simple('English'), lang: 'en' }] });
  });

  it('does not hoist struct fields that readXmp reported as custom back to the top level', () => {
    const adobe = new Uint8Array(readFileSync('test/fixtures/xmp/acrobat-tutorial-sample.xmp'));
    const before = parseRdfPacket(enc(readXmp(adobe).raw!)).properties.map((p) => `${p.ns} ${p.name}`);
    const out = editXmpPacket(adobe, { custom: readXmp(adobe).custom });
    expect(model(out).map((p) => `${p.ns} ${p.name}`)).toEqual(before);
  });
});
