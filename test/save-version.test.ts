import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { verifyLinearization } from '../src/linearize.js';
import { PageFormat } from '../src/pageformat.js';
import { isRef, name } from '../src/types.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';
import { buildSigner } from './helpers/build-signer.js';

function opened(version: string): Document {
  const bytes = buildClassicPdf(2);
  bytes.set(new TextEncoder().encode(version), 5);
  return Document.Open(bytes);
}

const headerOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 8));

describe('effective PDF version on a full save', () => {
  it.each(['1.4', '2.0'])('round-trips a header-only PDF %s', (version) => {
    const doc = opened(version);
    const bytes = doc.Save();
    expect(headerOf(bytes)).toBe(`%PDF-${version}`);
    const reopened = Document.Open(bytes);
    expect(reopened.headerVersion()).toBe(version);
    expect(reopened.Pages[0].GetText()).toContain('Page 1');
    expect(reopened.catalog().has('Version')).toBe(false);
  });

  it('keeps 2.0 with asynchronous compressed output', async () => {
    const bytes = await opened('2.0').SaveAsync({ compressed: true });
    expect(headerOf(bytes)).toBe('%PDF-2.0');
    expect(Document.Open(bytes).headerVersion()).toBe('2.0');
  });

  it('keeps 2.0 when linearizing', () => {
    const bytes = opened('2.0').Save({ linearized: true });
    expect(headerOf(bytes)).toBe('%PDF-2.0');
    expect(verifyLinearization(bytes)).toMatchObject({ linearized: true, errors: [] });
  });

  it('raises a 1.1 input to the linearization minimum', () => {
    const doc = opened('1.1');
    const bytes = doc.Save({ linearized: true });
    expect(headerOf(bytes)).toBe('%PDF-1.2');
    expect(verifyLinearization(bytes)).toMatchObject({ linearized: true, errors: [] });
    expect(headerOf(doc.Save())).toBe('%PDF-1.1');
  });

  it('honors a catalog version referenced indirectly', () => {
    const doc = opened('1.4');
    doc.catalog().set('Version', doc.allocObject(name('2.0')));
    const bytes = doc.Save();
    expect(headerOf(bytes)).toBe('%PDF-2.0');
    expect(Document.Open(bytes).headerVersion()).toBe('2.0');
  });

  it('defaults to 1.7 for newly authored documents', () => {
    expect(headerOf(Document.New(PageFormat.A4).Save())).toBe('%PDF-1.7');
  });

  it.each(['1.4', '2.0'])('carries %s through page derivatives', (version) => {
    const doc = opened(version);
    const derivatives = [
      ...doc.Split(), doc.ExtractPages([2]), doc.NUp(2, 1), doc.Booklet(), Document.Merge(doc),
    ];
    for (const derivative of derivatives) expect(headerOf(derivative.Save())).toBe(`%PDF-${version}`);
    expect(doc.catalog().has('Version')).toBe(false);
  });

  it('keeps the highest source version when combining pages', () => {
    const low = opened('1.4');
    low.catalog().set('Version', name('1.4'));
    const high = opened('2.0');
    expect(headerOf(Document.Merge(low, high).Save())).toBe('%PDF-2.0');
    expect(headerOf(Document.Merge(high, low).Save())).toBe('%PDF-2.0');
    expect(headerOf(low.Save())).toBe('%PDF-1.4');
    low.AddPage(high.Pages[0]);
    const bytes = low.Save();
    expect(headerOf(bytes)).toBe('%PDF-2.0');
    expect(Document.Open(bytes).headerVersion()).toBe('2.0');
  });

  it('keeps 2.0 when placing pages side by side', () => {
    const compared = opened('1.4').CompareSideBySide(opened('2.0'));
    expect(headerOf(compared.document.Save())).toBe('%PDF-2.0');
  });

  it('declares an imported 2.0 page version in an incremental catalog update', () => {
    const original = buildClassicPdf(2);
    original.set(new TextEncoder().encode('1.4'), 5);
    const doc = Document.Open(original);
    doc.Append(opened('2.0'));
    const bytes = doc.Save({ incremental: true });
    expect(bytes.subarray(0, original.length)).toEqual(original);
    const reopened = Document.Open(bytes);
    expect(reopened.headerVersion()).toBe('2.0');
    expect(reopened.Pages).toHaveLength(4);
  });

  it('raises a lower catalog override for the compressed output copy', () => {
    const doc = opened('1.4');
    const prior = name('1.4');
    const versionRef = doc.allocObject(prior);
    doc.catalog().set('Version', versionRef);
    const bytes = doc.Save({ compressed: true });
    expect(headerOf(bytes)).toBe('%PDF-1.5');
    const reopened = Document.Open(bytes);
    expect(reopened.headerVersion()).toBe('1.5');
    expect([...reopened.objectEntries()].map(([, object]) => object)).not.toContainEqual(prior);
    expect(doc.catalog().get('Version')).toEqual(versionRef);
    expect(headerOf(doc.Save())).toBe('%PDF-1.4');
  });

  it('keeps an equivalent indirect catalog version in Brotli output', () => {
    const doc = opened('2.0');
    doc.catalog().set('Version', doc.allocObject(name('2.0')));
    const bytes = doc.Save({ streamFilter: 'BrotliDecode' });
    const reopened = Document.Open(bytes);
    expect(isRef(reopened.catalog().get('Version'))).toBe(true);
    expect(reopened.headerVersion()).toBe('2.0');
  });

  it.each([
    ['rc4', '1.4'], ['aes128', '1.6'], ['aes256', '2.0'],
  ] as const)('declares the version required for %s encryption', (algorithm, expected) => {
    const doc = opened('1.3');
    const bytes = doc.Save({ encrypt: { algorithm, userPassword: 'fixture password' } });
    expect(headerOf(bytes)).toBe(`%PDF-${expected}`);
    const reopened = Document.Open(bytes, { password: 'fixture password' });
    expect(reopened.Pages[0].GetText()).toContain('Page 1');
    expect(headerOf(reopened.Save())).toBe(`%PDF-${expected}`);
  });

  it('honors an explicit PDF/A-1 conversion from a 2.0 input', () => {
    const doc = Document.Open(buildPdfaPdf({ headerVersion: '2.0' }, 1));
    doc.ConvertToPdfA('1b');
    const bytes = doc.Save();
    expect(headerOf(bytes)).toBe('%PDF-1.4');
    expect(Document.Open(bytes).ValidatePdfA('1b').Errors.map((issue) => issue.rule)).not.toContain('Version');
  });

  it('chooses the retained version before building a full-rewrite signature', async () => {
    const doc = opened('2.0');
    doc.SetMetadata({ title: 'Edited prior to signing' });
    await doc.Sign(buildSigner({ type: 'ec' }));
    const bytes = doc.Save();
    expect(headerOf(bytes)).toBe('%PDF-2.0');
    expect(await Document.Open(bytes).VerifySignatures()).toMatchObject([{
      integrity: 'valid', signature: 'valid', structureFindings: [],
    }]);
  });

  it.each([
    ['1.2', 'Sign', '1.3'], ['1.4', 'Certify', '1.5'],
  ] as const)('raises %s for full-rewrite %s', async (input, sign, expected) => {
    const doc = opened(input);
    doc.Pages[0].Rotate = 90;
    await doc[sign](buildSigner({ type: 'ec' }));
    const bytes = doc.Save();
    expect(headerOf(bytes)).toBe(`%PDF-${expected}`);
    const reopened = Document.Open(bytes);
    expect(reopened.headerVersion()).toBe(expected);
    expect(await reopened.VerifySignatures()).toMatchObject([{ integrity: 'valid', signature: 'valid' }]);
  });
});
