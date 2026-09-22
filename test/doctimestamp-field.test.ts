import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner } from './helpers/build-signer.js';
import { buildTimeStampToken } from '../src/rfc3161.js';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import type { SignatureFieldInit } from '../src/formcreate.js';

const tsaKey = buildSigner({ commonName: 'Test TSA' });
const tsa = (req: Uint8Array) => buildTimeStampToken(req, { certificate: tsaKey.certificate, privateKey: tsaKey.privateKey });
const RECT: [number, number, number, number] = [20, 120, 180, 170];

/** Saved bytes of a document holding one prepared field `T`. */
function prepared(extra: Partial<SignatureFieldInit> = {}): Uint8Array {
  const doc = Document.Open(buildClassicPdf(1));
  doc.Form.AddSignatureField({ page: 1, rect: RECT, name: 'T', ...extra });
  return doc.Save();
}

describe('AddDocumentTimestamp fills a prepared signature field (puep.5)', () => {
  it('fills the field rather than adding a second one, and the timestamp verifies', async () => {
    const base = prepared();
    const doc = Document.Open(base);
    await doc.AddDocumentTimestamp(tsa, { fieldName: 'T' });
    const bytes = doc.Save();
    expect(bytes.subarray(0, base.length)).toEqual(base);   // an incremental append
    const out = Document.Open(bytes);
    expect(out.Form.Fields.map((f) => f.FullName)).toEqual(['T']);
    expect(out.Pages[0].Annotations.length).toBe(1);
    expect(out.DocumentTimestamps.map((t) => [t.name, t.isSigned])).toEqual([['T', true]]);
    expect(out.Signatures).toEqual([]);
    const [r] = await out.VerifyDocumentTimestamps();
    expect(r.timestamp.valid).toBe(true);
    expect(r.coversWholeFile).toBe(true);
  });

  it('keeps the prepared field\'s place on the page', async () => {
    const doc = Document.Open(prepared());
    await doc.AddDocumentTimestamp(tsa, { fieldName: 'T' });
    const out = Document.Open(doc.Save());
    expect(out.resolve(out.Form.Get('T')!.Dict.get('Rect'))).toEqual(RECT);
  });

  it('still creates a new invisible field when the name is new or absent', async () => {
    const doc = Document.Open(prepared());
    await doc.AddDocumentTimestamp(tsa);
    const out = Document.Open(doc.Save());
    expect(out.Form.Fields.map((f) => f.FullName).sort()).toEqual(['T', 'Timestamp1']);
    expect(out.DocumentTimestamps.map((t) => t.name)).toEqual(['Timestamp1']);
  });

  it('refuses an already-signed field, leaving the document unchanged', async () => {
    const doc = Document.Open(prepared());
    await doc.AddDocumentTimestamp(tsa, { fieldName: 'T' });
    const signed = doc.Save();
    const again = Document.Open(signed);
    const before = again.Save();
    await expect(again.AddDocumentTimestamp(tsa, { fieldName: 'T' })).rejects.toThrow(/already signed/);
    expect(again.Save()).toEqual(before);
  });

  it('refuses a name that is not a signature field', async () => {
    const d = Document.Open(buildClassicPdf(1));
    d.Form.AddTextField({ page: 1, rect: RECT, name: 'T' });
    const base = d.Save();
    const doc = Document.Open(base);
    await expect(doc.AddDocumentTimestamp(tsa, { fieldName: 'T' })).rejects.toThrow(/not a signature field/);
    expect(doc.Save()).toEqual(base);
  });

  const constrained: Array<[string, Partial<SignatureFieldInit>]> = [
    ['a seed value', { seedValue: { reasons: ['r'] } }],
    ['a lock', { lock: { action: 'all' } }],
  ];
  for (const [label, extra] of constrained) {
    it(`refuses a field prepared with ${label}, leaving the document unchanged`, async () => {
      const base = prepared(extra);
      const doc = Document.Open(base);
      const err = await doc.AddDocumentTimestamp(tsa, { fieldName: 'T' }).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(UnsupportedFeatureError);
      expect(String(err)).toMatch(/cannot honour/);
      expect(doc.Save()).toEqual(base);
    });
  }
});
