import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { verifySignedData } from '../src/cms.js';

const signerOf = (t: TestSigner): { certificate: Uint8Array; privateKey: any } =>
  ({ certificate: t.certificate, privateKey: t.privateKey });

/** Verify the FIRST signature of `bytes` against its own recorded /ByteRange.
 *
 *  This is the external anchor the epic rests on: the digest is over BYTES
 *  rather than over our parse, so it cannot pass merely because our reader and
 *  our writer agree with each other. A check that the file still opens passes
 *  with the feature completely broken. */
function verifyFirstSignature(bytes: Uint8Array): {
  digestMatches: boolean; signatureValid: boolean; coversWholeFile: boolean;
} {
  const sig = Document.Open(bytes).Signatures[0];
  const [, a, b, c] = sig.byteRange!;
  const covered = new Uint8Array(a + c);
  covered.set(bytes.subarray(0, a), 0);
  covered.set(bytes.subarray(b, b + c), a);
  const digest = new Uint8Array(createHash('sha256').update(covered).digest());
  const r = verifySignedData(sig.contents!.subarray(0, sig.cmsLength!), digest);
  return { ...r, coversWholeFile: sig.coversWholeFile };
}

/** Sign a fresh two-page document and return the signed byte image. */
async function signedDocument(): Promise<Uint8Array> {
  const doc = Document.Open(buildClassicPdf(2));
  await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'first' });
  return doc.Save();
}

describe('explicit incremental save of an untouched protected input', () => {
  it('returns the signed byte image, keeping the signature over the whole file', async () => {
    const signed = await signedDocument();
    const out = Document.Open(signed).Save({ incremental: true });
    expect(out.length).toBe(signed.length);
    expect(out).toEqual(signed);
    expect(verifyFirstSignature(out)).toMatchObject({ digestMatches: true, coversWholeFile: true });
  });

  it('recognizes a nested signature with an inherited value and no SigFlags', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    const field = doc.Form.AddSignatureField({ page: 1, rect: [0, 0, 40, 20], name: 'Review.Approval' });
    // Structural fixture. Signature validity is tested separately above.
    const parent = doc.resolve(field.Dict.get('Parent'));
    if (!(parent instanceof Map)) throw new Error('expected parent field');
    parent.set('V', new Map([['ByteRange', [0, 12, 20, 24]]]));
    doc.Form.Dict!.delete('SigFlags');
    const base = doc.Save();
    const out = await Document.Open(base).SaveAsync({ incremental: true });
    expect(out.length).toBe(base.length);
    expect(out).toEqual(base);
  });

  it.each([1, 2])('honors only the AppendOnly bit for an empty signature field (flags %i)', (flags) => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Form.AddSignatureField({ page: 1, rect: [0, 0, 40, 20], name: 'Approval' });
    doc.Form.Dict!.set('SigFlags', flags);
    const base = doc.Save();
    const out = Document.Open(base).Save({ incremental: true });
    if (flags === 2) {
      expect(out.length).toBe(base.length);
      expect(out).toEqual(base);
    } else {
      expect(out.length).toBeGreaterThan(base.length);
    }
  });

  it('keeps the ordinary unsigned behavior for an unfilled byte-range placeholder', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const field = doc.Form.AddSignatureField({ page: 1, rect: [0, 0, 40, 20], name: 'Approval' });
    field.Dict.set('V', new Map([['ByteRange', [0, 0, 0, 0]]]));
    const base = doc.Save();
    expect(Document.Open(base).Save({ incremental: true }).length).toBeGreaterThan(base.length);
  });

  it('writes an edit that only removes the trailer Info reference', async () => {
    const initial = Document.Open(buildClassicPdf(1));
    initial.SetMetadata({ title: 'Recorded before signing' });
    await initial.Sign(signerOf(buildSigner({ type: 'rsa' })));
    const base = initial.Save();
    const reopened = Document.Open(base);
    expect(reopened.trailer.delete('Info')).toBe(true);
    const out = reopened.Save({ incremental: true });
    expect(out.length).toBeGreaterThan(base.length);
    expect(Document.Open(out).trailer.has('Info')).toBe(false);
  });
});

describe('an earlier signature survives an incremental edit', () => {
  it('still validates over its own byte range after the edit', async () => {
    const signed = await signedDocument();
    const doc = Document.Open(signed);
    doc.Pages[0].Dict.set('Rotate', 90);
    const out = doc.Save({ incremental: true });

    const v = verifyFirstSignature(out);
    expect(v.digestMatches).toBe(true);
    expect(v.signatureValid).toBe(true);
  });

  it('keeps the signed bytes as a byte-identical prefix', async () => {
    const signed = await signedDocument();
    const doc = Document.Open(signed);
    doc.Pages[0].Dict.set('Rotate', 90);
    const out = doc.Save({ incremental: true });

    expect(out.subarray(0, signed.length)).toEqual(signed);
    expect(out.length).toBeGreaterThan(signed.length);
  });

  it('actually applies the edit past the signed prefix', async () => {
    const signed = await signedDocument();
    const doc = Document.Open(signed);
    doc.Pages[0].Dict.set('Rotate', 90);
    const out = doc.Save({ incremental: true });

    const appended = new TextDecoder('latin1').decode(out.subarray(signed.length));
    expect(appended).toContain('/Rotate 90');
  });

  // Correct, and pinned so that a later change cannot silently widen the range:
  // the signature covers ITS revision, not the one appended after it.
  it('reports that the signature no longer covers the whole file', async () => {
    const signed = await signedDocument();
    const doc = Document.Open(signed);
    doc.Pages[0].Dict.set('Rotate', 90);
    const out = doc.Save({ incremental: true });

    expect(Document.Open(signed).Signatures[0].coversWholeFile).toBe(true);
    expect(verifyFirstSignature(out).coversWholeFile).toBe(false);
  });

  it('survives a second incremental edit chained onto the first', async () => {
    const signed = await signedDocument();
    const first = (() => {
      const d = Document.Open(signed);
      d.Pages[0].Dict.set('Rotate', 90);
      return d.Save({ incremental: true });
    })();
    const second = (() => {
      const d = Document.Open(first);
      d.Pages[1].Dict.set('Rotate', 180);
      return d.Save({ incremental: true });
    })();

    expect(second.subarray(0, signed.length)).toEqual(signed);
    const v = verifyFirstSignature(second);
    expect(v.digestMatches).toBe(true);
    expect(v.signatureValid).toBe(true);
  });
});

// The live model is BEHIND the signed bytes for the signature object:
// fillSignature patches bytes, never the model, so the live /Sig carries a
// /Contents of length 0 while the signed bytes carry the real CMS. An
// incremental save would therefore diff the empty one against the real one and
// append the empty version, destroying the signature it exists to protect.
// Measured before the guard: an untracked edit was silently lost (the signed
// bytes came back verbatim), and a tracked one appended onto the UNSIGNED
// original, yielding a file whose signature read back isSigned: false.
describe('incremental save refuses a document signed in this session', () => {
  it('refuses after an untracked edit', async () => {
    const doc = Document.Open(buildClassicPdf(2));
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'first' });
    doc.Pages[0].Dict.set('Rotate', 90);
    expect(() => doc.Save({ incremental: true }))
      .toThrow(/cannot save incrementally after signing/);
  });

  it('refuses after a tracked edit', async () => {
    const doc = Document.Open(buildClassicPdf(2));
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'first' });
    doc.SetMetadata({ title: 'edited' });
    expect(() => doc.Save({ incremental: true }))
      .toThrow(/cannot save incrementally after signing/);
  });

  it('refuses even with no edit at all, because the model is already behind', async () => {
    const doc = Document.Open(buildClassicPdf(2));
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'first' });
    expect(() => doc.Save({ incremental: true }))
      .toThrow(/cannot save incrementally after signing/);
  });

  it('leaves a plain Save() untouched, still returning the signed bytes', async () => {
    const doc = Document.Open(buildClassicPdf(2));
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'first' });
    const a = doc.Save();
    const b = doc.Save();
    expect(b).toEqual(a);
    expect(verifyFirstSignature(a).digestMatches).toBe(true);
  });
});
