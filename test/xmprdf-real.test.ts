import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRdfPacket, serializeRdfPacket, type RdfPacket } from '../src/xmprdf.js';
import { Document } from '../src/document.js';

const enc = (s: string) => new TextEncoder().encode(s);
const DC = 'http://purl.org/dc/elements/1.1/';
const PDFX = 'http://ns.adobe.com/pdfx/1.3/';
const packetOf = (path: string) => enc(Document.Open(readFileSync(path)).GetXmp().raw!);
const roundTrip = (p: RdfPacket) => parseRdfPacket(enc(serializeRdfPacket(p))).properties;

describe('xmprdf over real packets', () => {
  it('IRS f1040 (LiveCycle): language alternative, Seq, and a U+2182-encoded name', () => {
    const p = parseRdfPacket(packetOf('test/fixtures/xfa/irs-f1040.pdf'));
    const title = p.properties.find((x) => x.ns === DC && x.name === 'title');
    expect(title?.value).toEqual({ kind: 'array', form: 'Alt',
      items: [{ value: { kind: 'simple', value: '2025 Form 1040' }, lang: 'x-default' }] });
    const odd = p.properties.find((x) => x.ns === PDFX && x.name === 'Form\u21820020fields');
    expect(odd?.value).toEqual({ kind: 'simple', value: 'fillable' });
    expect(roundTrip(p)).toEqual(p.properties);
    expect(serializeRdfPacket(p)).toContain(`xmlns:pdfx="${PDFX}"`);
  });

  it('IRS fw9 (LiveCycle) round-trips its data model', () => {
    const p = parseRdfPacket(packetOf('test/fixtures/xfa/irs-fw9.pdf'));
    expect(p.properties.length).toBeGreaterThan(10);
    expect(roundTrip(p)).toEqual(p.properties);
  });

  it('Ghostscript PDF/X-4: seven Descriptions and the attribute form merge in order', () => {
    const p = parseRdfPacket(packetOf('test/fixtures/pdfx/ghostscript-x4.pdf'));
    expect(p.properties.map((x) => x.name)).toEqual([
      'Producer', 'Trapped', 'ModifyDate', 'CreateDate', 'MetadataDate', 'CreatorTool',
      'DocumentID', 'RenditionClass', 'VersionID', 'format', 'title', 'GTS_PDFXVersion',
    ]);
    expect(roundTrip(p)).toEqual(p.properties);
  });
});

describe('xmprdf over an Adobe XMP Core packet (acceptance)', () => {
  const MM = 'http://ns.adobe.com/xap/1.0/mm/';
  const EVT = 'http://ns.adobe.com/xap/1.0/sType/ResourceEvent#';
  const REF = 'http://ns.adobe.com/xap/1.0/sType/ResourceRef#';
  const p = parseRdfPacket(readFileSync('test/fixtures/xmp/acrobat-tutorial-sample.xmp'));
  const get = (ns: string, name: string) => p.properties.find((x) => x.ns === ns && x.name === name)?.value;

  it('reads History as a Seq of three structs, in order', () => {
    const h = get(MM, 'History');
    if (h?.kind !== 'array') throw new Error('History is not an array');
    expect(h.form).toBe('Seq');
    expect(h.items.map((it) => it.value.kind === 'struct'
      ? it.value.fields.find((f) => f.ns === EVT && f.name === 'action')?.value : it.value)).toEqual([
      { kind: 'simple', value: 'converted' },
      { kind: 'simple', value: 'fullyTagged' },
      { kind: 'simple', value: 'Downgraded' },
    ]);
  });

  it('reads the title as a language alternative, entity resolved', () => {
    expect(get(DC, 'title')).toEqual({ kind: 'array', form: 'Alt',
      items: [{ value: { kind: 'simple', value: 'Tutorial: Edit & sign PDF' }, lang: 'x-default' }] });
  });

  it('reads DerivedFrom as a struct and an empty Bag as an empty array', () => {
    const d = get(MM, 'DerivedFrom');
    if (d?.kind !== 'struct') throw new Error('DerivedFrom is not a struct');
    expect(d.fields.map((f) => f.name)).toEqual(['instanceID', 'documentID', 'originalDocumentID', 'renditionClass']);
    expect(d.fields.every((f) => f.ns === REF)).toBe(true);
    expect(get(DC, 'creator')).toEqual({ kind: 'array', form: 'Bag', items: [] });
  });

  it('parse -> serialize -> parse preserves the data model', () => {
    expect(roundTrip(p)).toEqual(p.properties);
  });
});

describe('xmprdf over a calibre packet: qualified identifiers (o6uu.2 acceptance)', () => {
  const XMP = 'http://ns.adobe.com/xap/1.0/';
  const IDQ = 'http://ns.adobe.com/xmp/Identifier/qual/1.0/';
  const p = parseRdfPacket(readFileSync('test/fixtures/xmp/calibre-identifiers.xmp'));

  it('reads xmp:Identifier as a Bag of values qualified by xmpidq:Scheme, qualifier written first', () => {
    const id = p.properties.find((x) => x.ns === XMP && x.name === 'Identifier');
    expect(id?.value).toEqual({ kind: 'array', form: 'Bag', items: [
      ['isbn', '9780306406157'], ['doi', '10.1000/182'], ['uri', 'https://example.com/book'],
    ].map(([scheme, value]) => ({
      value: { kind: 'simple', value },
      qualifiers: [{ ns: IDQ, name: 'Scheme', value: { kind: 'simple', value: scheme } }],
    })) });
  });

  it('parse -> serialize -> parse preserves the qualified identifiers', () => {
    expect(roundTrip(p)).toEqual(p.properties);
  });
});
