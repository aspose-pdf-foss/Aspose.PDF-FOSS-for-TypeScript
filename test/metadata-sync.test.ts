import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { encodePdfText, decodePdfText } from '../src/metadata.js';
import { name, isString, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS } from '../src/xmprdf.js';
import { buildSigner } from './helpers/build-signer.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };
/** Write an /Info entry behind the mirror, so the two sides disagree. */
const setInfo = (d: Document, key: string, v: string) =>
  d.ensureInfo().set(key, { kind: 'string', bytes: encodePdfText(v) });

describe('SyncMetadata infoToXmp', () => {
  it('makes XMP agree with /Info, deleting what /Info lacks', () => {
    const d = doc1();
    d.SetXmp({ title: 'Old', keywords: 'k' });
    setInfo(d, 'Title', 'New');
    d.ensureInfo().delete('Keywords');
    setInfo(d, 'CreationDate', "D:20240603123045+02'00'");
    const r = d.SyncMetadata('infoToXmp');
    expect(r).toEqual({ changed: ['title', 'keywords', 'creationDate'], skipped: [] });
    const x = d.GetXmp();
    expect(x.title).toBe('New');
    expect(x.keywords).toBeUndefined();
    expect(d.GetXmpValue(XMP, 'CreateDate')!.asText()).toBe('2024-06-03T12:30:45+02:00');
  });

  it('replaces only the x-default title and keeps translations and foreign schemas', () => {
    const d = doc1();
    // Seeded raw so the translation is real — SetXmp writes x-default only.
    const text = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about=""`
      + ` xmlns:dc="${DC}" xmlns:acme="http://acme.example/ns/1.0/"><dc:title><rdf:Alt>`
      + '<rdf:li xml:lang="x-default">Old</rdf:li><rdf:li xml:lang="de-DE">Alt</rdf:li></rdf:Alt></dc:title>'
      + '<acme:Batch>B1</acme:Batch></rdf:Description></rdf:RDF></x:xmpmeta>';
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode(text) }));
    setInfo(d, 'Title', 'New');
    expect(d.SyncMetadata('infoToXmp').changed).toEqual(['title']);
    expect(d.GetXmpValue(DC, 'title')!.asText()).toBe('New');
    expect(d.GetXmpValue(DC, 'title')!.asText('de')).toBe('Alt');
    expect(d.GetXmpValue('http://acme.example/ns/1.0/', 'Batch')!.asText()).toBe('B1');
  });

  it('never creates /Info', () => {
    const d = doc1();
    d.SetXmp({ title: 'T' });
    d.trailer.delete('Info');
    const r = d.SyncMetadata('infoToXmp');
    expect(r.changed).toEqual(['title']);
    expect(d.trailer.has('Info')).toBe(false);
  });

  it('reports an unreadable /Info date as skipped and leaves XMP alone', () => {
    const d = doc1();
    d.SetXmp({ createDate: '2024-06-03' });
    setInfo(d, 'CreationDate', 'yesterday');
    expect(d.SyncMetadata('infoToXmp').skipped).toEqual(['creationDate']);
    expect(d.GetXmpValue(XMP, 'CreateDate')!.asText()).toBe('2024-06-03');
  });
});

describe('SyncMetadata with an unreadable source value', () => {
  it('leaves XMP alone when the /Info entry is not a string', () => {
    const d = doc1();
    d.SetMetadata({ title: 'X' });
    d.ensureInfo().set('Title', name('NotAString'));
    expect(d.SyncMetadata('infoToXmp')).toEqual({ changed: [], skipped: ['title'] });
    expect(d.GetXmp().title).toBe('X');
  });
});

describe('SyncMetadata xmpToInfo', () => {
  it('makes /Info agree with XMP, converting dates', () => {
    const d = doc1();
    d.SetXmp({ modifyDate: '2024-06-03T12:30:45-05:30' });
    setInfo(d, 'Subject', 'stale');            // /Info only: XMP has no dc:description
    setInfo(d, 'ModDate', 'D:1999');
    const r = d.SyncMetadata('xmpToInfo');
    expect(r.changed).toEqual(['subject', 'modDate']);
    const m = d.GetMetadata();
    expect(m.subject).toBeUndefined();
    expect(m.modDate).toEqual(new Date(Date.UTC(2024, 5, 3, 18, 0, 45)));
  });

  it('does not create /Info when XMP has nothing to write', () => {
    const d = doc1();
    expect(d.SyncMetadata('xmpToInfo')).toEqual({ changed: [], skipped: [] });
    expect(d.trailer.has('Info')).toBe(false);
  });
});

describe('SyncMetadata no-op', () => {
  it('writes nothing and marks nothing when our own SetMetadata output already agrees', async () => {
    // SetMetadata(Date) writes D:…+00'00' into /Info and …T…:….000Z into XMP:
    // one instant spelled two ways. A sync must see agreement — and must not
    // markModified(), or a later Sign() silently turns into a full rewrite.
    // A save alone cannot see that, so the fixture signs and checks the base
    // survives as a byte-identical prefix.
    const d0 = doc1();
    d0.SetMetadata({ title: 'T', author: 'A, B', creationDate: new Date(Date.UTC(2024, 5, 3, 12, 30, 45)) });
    const base = d0.Save();
    for (const dir of ['infoToXmp', 'xmpToInfo'] as const) {
      const d = Document.Open(base);
      expect(d.SyncMetadata(dir)).toEqual({ changed: [], skipped: [] });
      const s = buildSigner();
      await d.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
      expect(d.Save().subarray(0, base.length)).toEqual(base);
    }
  });

  it('treats our own unspaced /Author as agreeing with its dc:creator in both directions', () => {
    // SetMetadata writes /Author "A,B" verbatim and dc:creator [A, B]; the
    // xmpToInfo compare must canonicalize the /Info side as infoToXmp does,
    // or it rewrites /Author to "A, B" and marks the document modified.
    const d = doc1();
    d.SetMetadata({ author: 'A,B' });
    expect(d.SyncMetadata('xmpToInfo')).toEqual({ changed: [], skipped: [] });
    expect(d.SyncMetadata('infoToXmp')).toEqual({ changed: [], skipped: [] });
  });

  it('refuses an unknown direction before doing anything', () => {
    const d = doc1();
    expect(() => d.SyncMetadata('both' as never)).toThrow(RangeError);
  });
});

describe('SyncMetadata and PDF/A', () => {
  it('clears XmpInfoConsistency after /Info is edited behind the mirror', () => {
    const d = doc1();
    d.ConvertToPdfA('2b');
    d.SetMetadata({ title: 'Report' });
    setInfo(d, 'Title', 'Changed');
    const rule = (x: ReturnType<Document['ValidatePdfA']>) => x.Issues.map((i) => i.rule);
    expect(rule(d.ValidatePdfA('2b'))).toContain('XmpInfoConsistency');
    d.SyncMetadata('infoToXmp');
    expect(rule(d.ValidatePdfA('2b'))).not.toContain('XmpInfoConsistency');
  });
});

// o6uu.9: an XMP date with no zone designator is read as UTC (isoInstant's
// rule), so beside an /Info date carrying an offset it names a DIFFERENT
// instant and either direction rewrites the other side. Pinned as a decision:
// XMP gives a zone-less time no other reading, and guessing the /Info offset
// for it would make the answer depend on which side we happened to read.
describe('SyncMetadata with a zone-less XMP date', () => {
  const setup = () => {
    const d = doc1();
    d.SetXmpValue(XMP, 'CreateDate', '2024-06-03T12:00:00');
    setInfo(d, 'CreationDate', "D:20240603120000+02'00'");
    return d;
  };
  const infoText = (d: Document, key: string) => {
    const v = d.ensureInfo().get(key);
    return isString(v) ? decodePdfText(v.bytes) : undefined;
  };

  it('infoToXmp rewrites the XMP date with /Info\'s offset', () => {
    const d = setup();
    expect(d.SyncMetadata('infoToXmp').changed).toContain('creationDate');
    expect(d.GetXmpValue(XMP, 'CreateDate')!.asText()).toBe('2024-06-03T12:00:00+02:00');
  });

  it('xmpToInfo rewrites the /Info date without an offset', () => {
    const d = setup();
    expect(d.SyncMetadata('xmpToInfo').changed).toContain('creationDate');
    expect(infoText(d, 'CreationDate')).toBe('D:20240603120000');
  });

  it('treats a zone-less date and a +00:00 one as the same instant', () => {
    const d = doc1();
    d.SetXmpValue(XMP, 'CreateDate', '2024-06-03T12:00:00');
    setInfo(d, 'CreationDate', "D:20240603120000+00'00'");
    expect(d.SyncMetadata('infoToXmp').changed).not.toContain('creationDate');
  });
});
