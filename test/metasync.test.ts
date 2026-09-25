import { describe, it, expect } from 'vitest';
import { planSync, infoSide, xmpSide } from '../src/metasync.js';
import { encodePdfText } from '../src/metadata.js';
import { LoadLimits } from '../src/loadlimits.js';
import { RDF_NS } from '../src/xmprdf.js';
import type { PdfDict, PdfObject } from '../src/types.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const XMPNS = 'http://ns.adobe.com/xap/1.0/';
const PDF = 'http://ns.adobe.com/pdf/1.3/';
const packet = (body: string) => new TextEncoder().encode(
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about=""`
  + ` xmlns:dc="${DC}" xmlns:xmp="${XMPNS}" xmlns:pdf="${PDF}">${body}</rdf:Description></rdf:RDF></x:xmpmeta>`);

describe('planSync infoToXmp', () => {
  it('copies a differing field, deletes one the source lacks, leaves agreement alone', () => {
    const p = planSync({ title: 'New', producer: 'P' }, { title: 'Old', keywords: 'k', producer: 'P' }, 'infoToXmp');
    expect(p.xmp).toEqual({ title: 'New', keywords: null });
    expect(p.changed).toEqual(['title', 'keywords']);
    expect(p.info).toEqual({});
  });

  it('splits /Author into dc:creator and compares the joined form', () => {
    expect(planSync({ author: 'A, B' }, { author: 'A, B' }, 'infoToXmp').changed).toEqual([]);
    expect(planSync({ author: 'A,B' }, {}, 'infoToXmp').xmp).toEqual({ authors: ['A', 'B'] });
    // An /Author of only separators is no author at all.
    expect(planSync({ author: ' , ' }, {}, 'infoToXmp').changed).toEqual([]);
  });

  it('converts a date and treats one instant spelled two ways as agreement', () => {
    expect(planSync({ creationDate: "D:20240603123045+00'00'" },
      { creationDate: '2024-06-03T12:30:45.000Z' }, 'infoToXmp').changed).toEqual([]);
    expect(planSync({ modDate: "D:20240603123045+02'00'" }, {}, 'infoToXmp').xmp)
      .toEqual({ modifyDate: '2024-06-03T12:30:45+02:00' });
  });

  it('skips an unreadable source date and leaves the target alone', () => {
    const p = planSync({ creationDate: 'last Tuesday' }, { creationDate: '2024-06-03' }, 'infoToXmp');
    expect(p.skipped).toEqual(['creationDate']);
    expect(p.changed).toEqual([]);
    expect(p.xmp).toEqual({});
  });

  it('skips an unreadable (null) source value and leaves the target alone', () => {
    const p = planSync({ title: null }, { title: 'X' }, 'infoToXmp');
    expect(p).toEqual({ changed: [], skipped: ['title'], info: {}, xmp: {} });
  });

  it('overwrites an unreadable (null) target with a readable source', () => {
    expect(planSync({ title: 'T' }, { title: null }, 'infoToXmp').xmp).toEqual({ title: 'T' });
  });

  it('lists fields in table order', () => {
    const p = planSync({ modDate: 'D:2024', title: 'T', creator: 'C' }, {}, 'infoToXmp');
    expect(p.changed).toEqual(['title', 'creator', 'modDate']);
  });
});

describe('planSync xmpToInfo', () => {
  it('mirrors every field kind into /Info syntax', () => {
    const p = planSync({ subject: 'gone' },
      { title: 'T', author: 'A, B', creationDate: '2024-06-03T12:30:45-05:30' }, 'xmpToInfo');
    expect(p.info).toEqual({ title: 'T', author: 'A, B', subject: null,
      creationDate: "D:20240603123045-05'30'" });
    expect(p.xmp).toEqual({});
  });

  it('compares dates by instant against an /Info D: string', () => {
    expect(planSync({ modDate: "D:20240603143045+02'00'" }, { modDate: '2024-06-03T12:30:45Z' },
      'xmpToInfo').changed).toEqual([]);
  });
});

describe('infoSide', () => {
  it('decodes string entries and ignores everything else', () => {
    const info: PdfDict = new Map<string, PdfObject>([
      ['Title', { kind: 'string', bytes: encodePdfText('Tïtle') }],
      ['Author', 42],
      ['CreationDate', { kind: 'string', bytes: encodePdfText('D:2024') }],
    ]);
    expect(infoSide(info, (o) => o ?? null)).toEqual({ title: 'Tïtle', author: null, creationDate: 'D:2024' });
    expect(infoSide(undefined, (o) => o ?? null)).toEqual({});
  });
});

describe('xmpSide', () => {
  it('reads raw text from the model: x-default, joined creators, dates as written', () => {
    const side = xmpSide(packet(
      '<dc:title><rdf:Alt><rdf:li xml:lang="de">Titel</rdf:li><rdf:li xml:lang="x-default">Title</rdf:li></rdf:Alt></dc:title>'
      + '<dc:creator><rdf:Seq><rdf:li>A</rdf:li><rdf:li>B</rdf:li></rdf:Seq></dc:creator>'
      + '<dc:description><rdf:Alt><rdf:li xml:lang="en">Only</rdf:li></rdf:Alt></dc:description>'
      + '<xmp:CreateDate>2024-06-03T12:30:45+02:00</xmp:CreateDate><pdf:Producer>P</pdf:Producer>'), LoadLimits.defaults);
    expect(side).toEqual({ title: 'Title', author: 'A, B', subject: 'Only',
      creationDate: '2024-06-03T12:30:45+02:00', producer: 'P' });
  });

  it('falls back to readXmp for a packet that will not parse, rather than reading nothing', () => {
    // Unclosed element: parseRdfPacket throws, readXmp's scan still finds the title.
    const bad = new TextEncoder().encode(
      '<rdf:RDF><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Kept</rdf:li></rdf:Alt></dc:title><oops>');
    expect(xmpSide(bad, LoadLimits.defaults).title).toBe('Kept');
  });

  it('keeps a fallback date as its written text, independent of the local time zone', () => {
    // readXmp parses dates with `new Date(s)`, which reads a zone-less time as
    // LOCAL — so toISOString of it differs by machine. The fallback must hand
    // back the text the packet wrote.
    const bad = new TextEncoder().encode(
      '<rdf:RDF><xmp:CreateDate>2024-06-03T12:30:45</xmp:CreateDate>'
      + '<xmp:ModifyDate>2024-06-03T12:30:45+02:00</xmp:ModifyDate><oops>');
    const side = xmpSide(bad, LoadLimits.defaults);
    expect(side.creationDate).toBe('2024-06-03T12:30:45');
    expect(side.modDate).toBe('2024-06-03T12:30:45+02:00');
  });

  it('reports a present but unreadable property as null, not as absent', () => {
    const side = xmpSide(packet('<dc:title rdf:parseType="Resource"><dc:x>y</dc:x></dc:title>'), LoadLimits.defaults);
    expect(side).toEqual({ title: null });
  });

  it('is empty with no packet', () => {
    expect(xmpSide(undefined, LoadLimits.defaults)).toEqual({});
  });
});
