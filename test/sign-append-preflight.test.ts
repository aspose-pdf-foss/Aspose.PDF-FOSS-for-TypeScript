import { describe, expect, it } from 'vitest';
import { Document, LoadLimits, PageFormat, ResourceLimitError, UnsupportedFeatureError } from '../src/index.js';
import { ref } from '../src/types.js';
import { readXref } from '../src/xref.js';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { prevChainPdf } from './helpers/build-hostile-pdf.js';
import { buildSigner } from './helpers/build-signer.js';
import { buildEncryptedPdf } from './helpers/encrypt-pdf.js';

const signer = buildSigner({ type: 'ec' });

function signingGraph(doc: Document) {
  return { trailer: doc.trailer, objects: [...doc.objectEntries()] };
}

describe('incremental signing layout preflight', () => {
  it.each(['Sign', 'Certify'] as const)('%s appends under a relaxed xref section limit', async (method) => {
    const sections = LoadLimits.defaults.maxXrefSections! + 1;
    const limits = LoadLimits.defaults.with({ maxXrefSections: sections + 1 });
    const base = prevChainPdf(sections);
    const doc = Document.Open(base, { limits });
    expect(doc.Revisions).toHaveLength(sections);
    await doc[method](signer, { fieldName: 'Approval' });

    const bytes = doc.Save();
    expect(bytes.subarray(0, base.length)).toEqual(base);
    const signed = Document.Open(bytes, { limits });
    expect(signed.Revisions).toHaveLength(sections + 1);
    expect(await signed.VerifySignatures()).toMatchObject([{
      name: 'Approval', signature: 'valid', integrity: 'valid', coversWholeFile: true,
      docMDP: method === 'Certify' ? 'ok' : 'n/a',
    }]);
  });

  it.each(['Sign', 'Certify'] as const)('%s leaves fields and catalog untouched when stored /Root is inline', async (method) => {
    const password = 'fixture password';
    const { bytes } = buildEncryptedPdf(
      { cipher: 'aes128', R: 4, V: 4, length: 128, userPassword: password },
      { pageContents: ['BT ET'] },
    );
    const input = Buffer.from(bytes).toString('latin1')
      .replace('/Root 1 0 R /Encrypt', '/Root << /Type /Catalog /Pages 2 0 R >> /Encrypt');
    const doc = Document.Open(Buffer.from(input, 'latin1'), { password });
    expect(doc.recovery).toBeUndefined();
    doc.trailer.set('Root', ref(1)); // Repair the live trailer only.
    const before = structuredClone(signingGraph(doc));

    await expect(doc[method](signer, { fieldName: 'Refused' })).rejects.toThrow(UnsupportedFeatureError);
    expect(signingGraph(doc)).toEqual(before);
    expect(doc.Signatures).toHaveLength(0);
    expect(await doc.VerifySignatures()).toEqual([]);
  });

  it('preserves existing signed bytes and fields if the current load policy refuses the stored layout', async () => {
    const doc = Document.New(PageFormat.A4);
    await doc.Sign(signer, { fieldName: 'First', encrypt: { userPassword: 'fixture password' } });
    const signed = doc.Save().slice();
    doc.loadLimits = doc.loadLimits.with({ maxXrefSections: 1 });
    const before = structuredClone(signingGraph(doc));

    await expect(doc.Sign(signer, { fieldName: 'Refused' })).rejects.toMatchObject({
      name: 'ResourceLimitError', limit: 'maxXrefSections',
    });
    expect(signingGraph(doc)).toEqual(before);
    expect(doc.Save()).toEqual(signed);
    expect(doc.Signatures.map((field) => field.name)).toEqual(['First']);
  });

  it.each([
    ['maxDecodedStreamBytes', 23], ['maxTotalDecodedBytes', 23],
  ] as const)('checks %s when preflighting a filtered xref stream', async (limit, maximum) => {
    const base = buildXrefStreamPdf(); // The single xref stream decodes to 24 bytes.
    const doc = Document.Open(base);
    doc.loadLimits = doc.loadLimits.with({ [limit]: maximum });
    const before = structuredClone(signingGraph(doc));

    await expect(doc.Sign(signer)).rejects.toMatchObject({ name: 'ResourceLimitError', limit });
    expect(signingGraph(doc)).toEqual(before);
    expect(() => Document.Open(base, { limits: doc.loadLimits })).toThrow(ResourceLimitError);
  });

  it('preserves indirect catalog and info generations from the stored trailer', async () => {
    const base = new TextEncoder().encode(new TextDecoder().decode(buildClassicPdf(1, { info: { Title: 'Draft' } }))
      .replace('1 0 obj', '1 7 obj')
      .replace('5 0 obj', '5 3 obj')
      .replace(/(\d{10}) 00000 n /, '$1 00007 n ')
      .replace(/(\d{10}) 00000 n (?=\ntrailer)/, '$1 00003 n ')
      .replace('/Root 1 0 R /Info 5 0 R', '/Root 1 7 R /Info 5 3 R'));
    const doc = Document.Open(base);
    expect(readXref(base).trailer.get('Root')).toEqual(ref(1, 7));
    expect(readXref(base).trailer.get('Info')).toEqual(ref(5, 3));
    await doc.Certify(signer, { fieldName: 'Approval' });
    const bytes = doc.Save();
    const xref = readXref(bytes);
    expect(xref.trailer.get('Root')).toEqual(ref(1, 7));
    expect(xref.trailer.get('Info')).toEqual(ref(5, 3));
    expect(xref.entries.get(1)).toMatchObject({ type: 'offset', gen: 7 });
    expect(await Document.Open(bytes).VerifySignatures()).toMatchObject([{
      signature: 'valid', integrity: 'valid', docMDP: 'ok',
    }]);
  });

  it('appends to the pending signed revision after adding another signature', async () => {
    const authored = Document.New(PageFormat.A4);
    await authored.Sign(signer, { fieldName: 'Original' });
    const doc = Document.Open(authored.Save());
    await doc.Sign(signer, { fieldName: 'FirstAppend' });
    const first = doc.Save().slice();

    await doc.Sign(signer, { fieldName: 'SecondAppend' });
    const next = doc.Save();
    expect(Buffer.from(next.subarray(0, first.length)).equals(Buffer.from(first))).toBe(true);
    expect(await Document.Open(next).VerifySignatures()).toMatchObject([
      { name: 'Original', integrity: 'valid', signature: 'valid' },
      { name: 'FirstAppend', integrity: 'valid', signature: 'valid' },
      { name: 'SecondAppend', integrity: 'valid', signature: 'valid' },
    ]);
  });

  it('takes the first pending incremental signature as the base for the next one', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Sign(signer, { fieldName: 'First' });
    const first = doc.Save().slice();

    await doc.Sign(signer, { fieldName: 'Second' });
    const next = doc.Save();
    expect(Buffer.from(next.subarray(0, first.length)).equals(Buffer.from(first))).toBe(true);
    expect(await Document.Open(next).VerifySignatures()).toMatchObject([
      { name: 'First', integrity: 'valid', signature: 'valid' },
      { name: 'Second', integrity: 'valid', signature: 'valid' },
    ]);
  });

  it('retains signed bytes when the caller must reopen after a full signing rewrite', async () => {
    const doc = Document.New(PageFormat.A4);
    await doc.Sign(signer, { fieldName: 'First' });
    const first = doc.Save().slice();
    const before = structuredClone(signingGraph(doc));

    await expect(doc.Sign(signer, { fieldName: 'Second' })).rejects.toThrow(/save and reopen/i);
    expect(signingGraph(doc)).toEqual(before);
    expect(doc.Save()).toEqual(first);
    const reopened = Document.Open(first);
    await reopened.Sign(signer, { fieldName: 'Second' });
    expect(await reopened.VerifySignatures()).toMatchObject([
      { name: 'First', integrity: 'valid', signature: 'valid' },
      { name: 'Second', integrity: 'valid', signature: 'valid' },
    ]);
  });

  it('refuses a document timestamp before changing fields when the layout exceeds the limit', async () => {
    const doc = Document.Open(prevChainPdf(2));
    doc.loadLimits = doc.loadLimits.with({ maxXrefSections: 1 });
    const before = structuredClone(signingGraph(doc));
    let calls = 0;
    const timestamp = doc.AddDocumentTimestamp(() => {
      calls++;
      throw new Error('unexpected timestamp request');
    });

    await expect(timestamp).rejects.toMatchObject({
      name: 'ResourceLimitError', limit: 'maxXrefSections',
    });
    expect(calls).toBe(0);
    expect(signingGraph(doc)).toEqual(before);
  });
});
