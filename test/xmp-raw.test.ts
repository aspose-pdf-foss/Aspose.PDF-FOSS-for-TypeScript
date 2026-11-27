import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { encodeStream, decodeStream } from '../src/filters.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { isStream, name } from '../src/types.js';
import { buildClassicPdf } from './helpers/build-pdf.js';

const packet = Buffer.from('\uFEFF<?xpacket begin=""?>\r\n<example>Ω</example>  \r\n<?xpacket end="w"?>', 'utf16le');
const blank = () => Document.Open(buildClassicPdf(1));

describe('raw catalog XMP', () => {
  it.each([false, true])('returns the decoded bytes of a filtered stream (indirect filter=%s)', indirect => {
    const doc = blank();
    const stream = encodeStream(packet, 'FlateDecode');
    if (indirect) stream.dict.set('Filter', doc.allocObject(name('FlateDecode')));
    doc.catalog().set('Metadata', doc.allocObject(stream));
    const reopened = Document.Open(doc.Save());
    expect(reopened.GetXmpRaw()).toEqual(new Uint8Array(packet));
  });

  it.each([false, true])('owns its bytes at both API boundaries (incremental=%s)', incremental => {
    const doc = blank(), input = Buffer.concat([Buffer.from([42]), packet, Buffer.from([43])]).subarray(1, -1);
    doc.SetXmpRaw(input);
    input.fill(0);
    doc.GetXmpRaw()!.fill(1);
    const reopened = Document.Open(doc.Save({ incremental }));
    expect(reopened.GetXmpRaw()).toEqual(new Uint8Array(packet));
    const stream = reopened.resolve(reopened.catalog().get('Metadata'));
    expect(isStream(stream) && stream.dict.get('Type')).toEqual(name('Metadata'));
    expect(isStream(stream) && stream.dict.get('Subtype')).toEqual(name('XML'));
    expect(isStream(stream) && stream.dict.has('Filter')).toBe(false);
    expect(reopened.trailer.has('Info')).toBe(false);
  });

  it('reads filtered packets under the document decode limit', () => {
    const doc = blank();
    doc.catalog().set('Metadata', doc.allocObject(encodeStream(packet, 'FlateDecode')));
    const reopened = Document.Open(doc.Save(), { limits: LoadLimits.defaults.with({ maxDecodedStreamBytes: packet.length - 1 }) });
    expect(() => reopened.GetXmpRaw()).toThrow(ResourceLimitError);
  });

  it('distinguishes empty and absent packets and rejects non-byte input before mutation', () => {
    const doc = blank();
    expect(doc.GetXmpRaw()).toBeUndefined();
    doc.ClearInfo();
    doc.ClearXmp();
    expect(() => doc.SetXmpRaw('xml' as never)).toThrow(TypeError);
    expect(doc.isModifiedInternal()).toBe(false);
    doc.SetXmpRaw(new Uint8Array());
    expect(Document.Open(doc.Save()).GetXmpRaw()).toEqual(new Uint8Array());
    doc.ClearXmp();
    expect(Document.Open(doc.Save()).GetXmpRaw()).toBeUndefined();
  });

  it.each(['ClearXmp', 'ClearMetadata'] as const)('preserves page metadata through replacement and %s', clear => {
    const doc = blank();
    doc.SetXmpRaw(packet);
    doc.Pages[0].Dict.set('Metadata', doc.catalog().get('Metadata')!);
    doc.SetXmpRaw(new Uint8Array([0xff, 0x80]));
    const shared = Document.Open(doc.Save());
    expect(shared.GetXmpRaw()).toEqual(new Uint8Array([0xff, 0x80]));
    shared.catalog().set('Metadata', shared.Pages[0].Dict.get('Metadata')!);
    shared[clear]();
    const reopened = Document.Open(shared.Save());
    expect(reopened.GetXmpRaw()).toBeUndefined();
    const pageStream = reopened.resolve(reopened.Pages[0].Dict.get('Metadata'));
    expect(isStream(pageStream) && new Uint8Array(decodeStream(pageStream))).toEqual(new Uint8Array(packet));
  });
});

describe('independent metadata stores', () => {
  it.each([false, true])('clears either store across a save (incremental=%s)', incremental => {
    const doc = blank();
    doc.SetMetadata({ title: 'Original', custom: { Code: '42' } });
    const original = doc.Save(), infoOnly = Document.Open(original), xmpOnly = Document.Open(original);
    infoOnly.ClearXmp();
    xmpOnly.ClearInfo();
    const info = Document.Open(infoOnly.Save({ incremental }));
    const xmp = Document.Open(xmpOnly.Save({ incremental }));
    expect(info.GetMetadata()).toEqual({ title: 'Original', custom: { Code: '42' } });
    expect(info.GetXmpRaw()).toBeUndefined();
    expect(xmp.trailer.has('Info')).toBe(false);
    expect(xmp.GetXmpRaw()).toEqual(doc.GetXmpRaw());
    const neither = Document.Open(original);
    neither.ClearMetadata();
    const cleared = Document.Open(neither.Save({ incremental }));
    expect(cleared.trailer.has('Info')).toBe(false);
    expect(cleared.GetXmpRaw()).toBeUndefined();
  });

  it('mirrors raw replacements only on explicit sync, in either direction', () => {
    const doc = blank(), source = blank();
    doc.SetMetadata({ title: 'Info title', custom: { Code: '42' } });
    source.SetXmp({ title: 'Packet title' });
    const raw = source.GetXmpRaw()!;
    doc.SetXmpRaw(raw);
    expect(doc.GetMetadata().title).toBe('Info title');
    expect(doc.GetXmpValue('http://purl.org/dc/elements/1.1/', 'title')?.asText()).toBe('Packet title');
    expect(doc.SyncMetadata('xmpToInfo').changed).toEqual(['title']);
    expect(doc.GetMetadata()).toEqual({ title: 'Packet title', custom: { Code: '42' } });
    expect(doc.GetXmpRaw()).toEqual(raw);
    doc.ClearXmp();
    expect(doc.SyncMetadata('infoToXmp').changed).toEqual(['title']);
    expect(doc.GetXmp().title).toBe('Packet title');
    doc.ClearInfo();
    doc.SyncMetadata('infoToXmp');
    expect(doc.GetXmp().title).toBeUndefined();
    expect(doc.trailer.has('Info')).toBe(false);
  });
});
