import { describe, expect, it, vi } from 'vitest';
import { Document, UnsupportedFeatureError } from '../src/index.js';
import { buildEncryptor } from '../src/encrypt.js';
import { PdfParseError } from '../src/errors.js';
import { PageFormat } from '../src/pageformat.js';
import { migratePdf20 } from '../src/pdf20.js';
import { isDict, name, type PdfObject } from '../src/types.js';
import { buildXmp, NS } from '../src/xmp.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner } from './helpers/build-signer.js';

const PDFX = 'http://ns.adobe.com/pdfx/1.3/';
const plain = (info?: Record<string, string>) => Document.Open(buildClassicPdf(1, { info }));
const str = (bytes: number[]) => ({ kind: 'string' as const, bytes: Uint8Array.from(bytes) });
const dict = (entries: [string, PdfObject][]) => new Map<string, PdfObject>(entries);
const header = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 8));

describe('PDF version and file identifiers', () => {
  it('reads the effective version and defaults to the authored version', () => {
    expect(Document.New().Version).toBe('1.7');
    const bytes = buildClassicPdf(1);
    bytes[7] = '4'.charCodeAt(0);
    const doc = Document.Open(bytes);
    expect(doc.Version).toBe('1.4');
    doc.catalog().set('Version', doc.allocObject(name('2.0')));
    expect(doc.Version).toBe('2.0');
    expect(Document.Open(doc.Save({ compressed: true })).Version).toBe('2.0');
  });

  it('returns binary trailer IDs as upper-case hex and handles absent or malformed IDs', () => {
    const doc = plain();
    expect(doc.ID).toBeUndefined();
    doc.trailer.set('ID', [str([0x00, 0xff, 0xa0]), str([0xc1, 0x7e])]);
    const expected = { original: '00FFA0', modified: 'C17E' };
    expect(doc.ID).toEqual(expected);
    expect(Document.Open(doc.Save()).ID).toEqual(expected);
    expect(Document.Open(doc.Save({ compressed: true })).ID).toEqual(expected);
    doc.trailer.set('ID', [str([0x01]), name('invalid')]);
    expect(doc.ID).toBeUndefined();
  });
});

describe('standalone PDF 2.0 migration', () => {
  it('merges Info into XMP, keeps existing XMP, and reports removed entries', () => {
    const doc = plain({ Title: 'Info title', Author: 'Ana', CreationDate: "D:20260501090000+05'00'", 'JobId': 'A-14' });
    doc.installXmpText(buildXmp({ title: 'Existing title', custom: [{ namespace: 'urn:kept', prefix: 'keep', name: 'Flag', value: 'stay' }] }));
    doc.catalog().set('Version', name('1.6'));
    const mark = dict([['Marked', true], ['Suspects', false]]);
    const page = doc.resolve(doc.pageRef(1));
    const res = isDict(page) ? doc.resolve(page.get('Resources')) : undefined;
    if (!isDict(res)) throw new Error('missing fixture resources');
    res.set('ProcSet', [name('PDF')]);
    const font = dict([['Type', name('FontDescriptor')], ['CharSet', str([65])], ['CIDSet', str([1])]]);
    const privateResources = dict([['ProcSet', name('Private')]]);
    const other = dict([['Resources', privateResources]]);
    const perms = dict([['UR3', dict([['Type', name('Sig')], ['ByteRange', [0, 1, 2, 3]], ['Contents', str([9])]])]]);
    doc.catalog().set('MarkInfo', doc.allocObject(mark));
    doc.catalog().set('TestFontDescriptor', doc.allocObject(font));
    doc.catalog().set('Private', doc.allocObject(other));
    doc.catalog().set('Perms', doc.allocObject(perms));
    doc.trailer.set('ID', [str([0x11]), str([0x22])]);

    const report = doc.ConvertToPdf20();
    expect(report).toMatchObject({ previousVersion: '1.6', version: '2.0' });
    expect(report.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'version' }),
      expect.objectContaining({ kind: 'metadata', key: 'Title', action: 'kept-existing' }),
      expect.objectContaining({ kind: 'metadata', key: 'Author', action: 'copied' }),
      expect.objectContaining({ kind: 'metadata', key: 'JobId', action: 'copied' }),
      expect.objectContaining({ kind: 'remove', key: 'ProcSet' }),
      expect.objectContaining({ kind: 'remove', key: 'CIDSet' }),
      expect.objectContaining({ kind: 'remove', key: 'CharSet' }),
      expect.objectContaining({ kind: 'remove', key: 'Suspects' }),
      expect.objectContaining({ kind: 'remove', key: 'UR3' }),
      expect.objectContaining({ kind: 'remove', key: 'Version' }),
    ]));
    expect(doc.Version).toBe('2.0');
    expect(privateResources.has('ProcSet')).toBe(true);
    expect(() => doc.Save({ incremental: true })).toThrow(UnsupportedFeatureError);
    const output = doc.Save();
    expect(header(output)).toBe('%PDF-2.0');
    const reopened = Document.Open(output);
    expect(reopened.ID).toEqual({ original: '11', modified: '22' });
    expect(reopened.Pages[0].GetText()).toContain('Page 1');
    expect(reopened.GetXmp()).toMatchObject({ title: 'Existing title', authors: ['Ana'] });
    expect(reopened.GetXmpValue(NS.xmp, 'CreateDate')?.asText()).toBe('2026-05-01T09:00:00+05:00');
    expect(reopened.GetXmpValue(PDFX, 'JobId')?.asText()).toBe('A-14');
    expect(reopened.GetXmpValue('urn:kept', 'Flag')?.asText()).toBe('stay');
    const info = reopened.resolve(reopened.trailer.get('Info'));
    expect(isDict(info) ? [...info.keys()] : undefined).toEqual(['CreationDate']);
    expect(reopened.catalog().has('Perms')).toBe(false);
    expect(reopened.ConvertToPdf20().changes).toEqual([]);
  });

  it.each([1, 2, 3])('refuses PDF/A-%i before changing any bytes', (pdfaPart) => {
    const doc = plain({ Title: 'Keep this' });
    doc.installXmpText(buildXmp({ pdfaPart }));
    const before = doc.Save();
    expect(() => doc.ConvertToPdf20()).toThrow(/PDF\/A/);
    expect(doc.Save()).toEqual(before);
  });

  it('refuses older print and accessibility claims in Info or XMP', () => {
    const print = plain({ GTS_PDFXVersion: 'PDF/X-3:2003' });
    expect(() => print.ConvertToPdf20()).toThrow(/PDF\/X/);
    const accessible = plain();
    accessible.installXmpText(buildXmp({ pdfuaPart: 1 }));
    expect(() => accessible.ConvertToPdf20()).toThrow(/PDF\/UA/);
  });

  it('keeps compatible PDF/A-4 identification while moving dates out of Info', () => {
    const doc = plain({ ModDate: 'D:20260501090000Z' });
    doc.installXmpText(buildXmp({ pdfaPart: 4, pdfaRev: 2020 }));
    doc.ConvertToPdf20();
    const reopened = Document.Open(doc.Save());
    expect(reopened.GetXmp()).toMatchObject({ pdfaPart: 4, pdfaRev: 2020 });
    expect(reopened.GetXmpValue(NS.xmp, 'ModifyDate')?.asText()).toBe('2026-05-01T09:00:00Z');
    expect(reopened.trailer.has('Info')).toBe(false);
  });

  it('refuses damaged metadata before changing the document', () => {
    const doc = plain({ Title: 'Keep this' });
    doc.installXmpText('<broken/>');
    const before = doc.Save();
    expect(() => doc.ConvertToPdf20()).toThrow(PdfParseError);
    expect(doc.Save()).toEqual(before);
  });

  it('refuses retained legacy encryption and legacy encryption on a migrated save', () => {
    const legacy = plain({ Title: 'Private' }).Save({ encrypt: { algorithm: 'aes128', userPassword: 'fixture' } });
    const encrypted = Document.Open(legacy, { password: 'fixture' });
    expect(() => encrypted.ConvertToPdf20()).toThrow(/encryption/);
    expect(encrypted.GetMetadata().title).toBe('Private');
    const doc = plain();
    doc.ConvertToPdf20();
    expect(() => doc.Save({ encrypt: { algorithm: 'rc4' } })).toThrow(UnsupportedFeatureError);
  });

  it('preserves AES-256 revision 6 encryption and requires reopening before signing', async () => {
    const credentials = { password: 'fixture' };
    const input = plain({ Title: 'Private' }).Save({ encrypt: { userPassword: 'fixture' } });
    const doc = Document.Open(input, credentials);
    doc.ConvertToPdf20();
    await expect(doc.Sign(buildSigner({ type: 'ec' }))).rejects.toThrow(/save.*reopen/i);
    const output = doc.Save();
    const reopened = Document.Open(output, credentials);
    expect(reopened.Version).toBe('2.0');
    expect(reopened.ID).toEqual(doc.ID);
    expect(reopened.GetXmp().title).toBe('Private');
  });

  it('refuses retained AES-256 settings with a legacy crypt filter', () => {
    const doc = plain({ Title: 'Keep this' });
    const { encryptDict } = buildEncryptor({}, new Uint8Array(16));
    const filters = encryptDict.get('CF');
    if (!isDict(filters)) throw new Error('missing fixture crypt filters');
    filters.set('Legacy', dict([['CFM', name('AESV2')]]));
    const before = doc.Save();
    expect(() => migratePdf20(doc, encryptDict)).toThrow(/encryption/);
    expect(doc.Save()).toEqual(before);
  });

  it('refuses an indirect Crypt marker the retained encryption writer cannot honor', () => {
    const doc = plain();
    const stream = doc.allocObject({
      kind: 'stream', dict: dict([['Filter', doc.allocObject(name('Crypt'))]]), raw: Uint8Array.of(42),
    });
    doc.catalog().set('PrivateStream', stream);
    const { encryptDict } = buildEncryptor({}, new Uint8Array(16));
    expect(() => migratePdf20(doc, encryptDict)).toThrow(/encryption filter/);
  });

  it('requires saving and reopening before appending a document timestamp', async () => {
    const doc = plain({ Title: 'Before timestamp' });
    doc.ConvertToPdf20();
    const before = doc.Save();
    const tsa = vi.fn(async () => new Uint8Array());
    await expect(doc.AddDocumentTimestamp(tsa)).rejects.toThrow(/save.*reopen/i);
    await expect(doc.AddValidationData()).rejects.toThrow(/save.*reopen/i);
    expect(tsa).not.toHaveBeenCalled();
    expect(doc.Save()).toEqual(before);
  });

  it('chooses a standalone signature save after an otherwise idempotent migration', async () => {
    const bytes = buildClassicPdf(1);
    bytes.set(new TextEncoder().encode('2.0'), 5);
    const doc = Document.Open(bytes);
    expect(doc.ConvertToPdf20().changes).toEqual([]);
    await doc.Sign(buildSigner({ type: 'ec' }));
    const reopened = Document.Open(doc.Save());
    expect(reopened.Revisions).toHaveLength(1);
    expect(await reopened.VerifySignatures()).toMatchObject([{ integrity: 'valid', signature: 'valid' }]);
  });

  it('prevents a pending timestamp from overwriting the migrated bytes', async () => {
    const doc = plain();
    await expect(doc.AddDocumentTimestamp(async () => {
      expect(() => doc.ConvertToPdf20()).toThrow(/sign|timestamp/i);
      throw new Error('fixture stops before issuing a timestamp');
    })).rejects.toThrow(/fixture stops/);
  });

  it('rechecks retained encryption if migration occurs while signing resolves credentials', async () => {
    const bytes = plain({ Title: 'Private' }).Save({ encrypt: { userPassword: 'fixture' } });
    const doc = Document.Open(bytes, { password: 'fixture' });
    const signing = doc.Sign(buildSigner({ type: 'ec' }));
    doc.ConvertToPdf20();
    await expect(signing).rejects.toThrow(/save.*reopen/i);
    expect(Document.Open(doc.Save(), { password: 'fixture' }).GetXmp().title).toBe('Private');
  });

  it('refuses a signed document and preserves signed bytes', async () => {
    const doc = Document.New(PageFormat.A4);
    await doc.Sign(buildSigner({ type: 'ec' }));
    const bytes = doc.Save();
    expect(() => doc.ConvertToPdf20()).toThrow(/sign/i);
    expect(doc.Save()).toEqual(bytes);
    expect(() => Document.Open(bytes).ConvertToPdf20()).toThrow(/sign/i);
  });
});
