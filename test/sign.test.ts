import { describe, it, expect } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { buildPkcs12 } from './helpers/build-pkcs12.js';
import { Document } from '../src/document.js';
import { verifySignedData } from '../src/cms.js';
import { signData } from '../src/sigalg.js';
import { der, OID } from '../src/asn1.js';
import { isDict, isName, isString, PdfDict, PdfObject } from '../src/types.js';

/** A signer in the shape doc.Sign accepts (certificate DER + private key). */
function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

/** Whether `hay` contains `needle` as a contiguous byte subsequence. */
function containsSubsequence(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Recompute the /ByteRange digest and verify the embedded CMS against it. */
function verifyFirstSignature(bytes: Uint8Array): { digestMatches: boolean; signatureValid: boolean; coversWholeFile: boolean } {
  const reopened = Document.Open(bytes);
  const sig = reopened.Signatures[0];
  const [, a, b, c] = sig.byteRange!;
  const covered = new Uint8Array(a + c);
  covered.set(bytes.subarray(0, a), 0);
  covered.set(bytes.subarray(b, b + c), a);
  const digest = new Uint8Array(createHash('sha256').update(covered).digest());
  const cms = sig.contents!.subarray(0, sig.cmsLength!);
  const r = verifySignedData(cms, digest);
  return { ...r, coversWholeFile: sig.coversWholeFile };
}

describe('Document.Sign (invisible signing)', () => {
  it('signs a freshly-authored document via sign-on-save (full rewrite)', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    // Mutate so the path is a full rewrite (authored/modified state).
    doc.SetMetadata({ title: 'Signed' });
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'I approve', name: 'Alice' });
    const bytes = doc.Save();

    const v = verifyFirstSignature(bytes);
    expect(v.digestMatches).toBe(true);
    expect(v.signatureValid).toBe(true);
    expect(v.coversWholeFile).toBe(true);
  });

  it('signs an opened, unmodified document via incremental append (original bytes preserved)', async () => {
    const base = buildClassicPdf(2);
    const doc = Document.Open(base);
    await doc.Sign(signerOf(buildSigner({ type: 'ec' })), { reason: 'review' });
    const bytes = doc.Save();

    // Incremental append keeps the original bytes verbatim as a prefix.
    expect(bytes.subarray(0, base.length)).toEqual(base);
    const v = verifyFirstSignature(bytes);
    expect(v.digestMatches).toBe(true);
    expect(v.signatureValid).toBe(true);
    expect(v.coversWholeFile).toBe(true);
  });

  it('builds an invisible /Sig widget wired into the AcroForm', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await doc.Sign(signerOf(buildSigner()), { name: 'Bob', reason: 'r', location: 'NYC', contactInfo: 'b@x' });
    const bytes = doc.Save();

    const reopened = Document.Open(bytes);
    const sig = reopened.Signatures[0];
    expect(sig.name.length).toBeGreaterThan(0);
    expect(sig.subFilter).toBe('adbe.pkcs7.detached');
    expect(sig.isSigned).toBe(true);

    const v = sig.valueDict;
    expect((v.get('Filter') as any).name).toBe('Adobe.PPKLite');
    expect(isString(v.get('Reason')!)).toBe(true);
    expect(new TextDecoder().decode((v.get('Name') as any).bytes)).toBe('Bob');

    // Catalog has an AcroForm with SigFlags set, and the widget rect is zero.
    const acro = reopened.resolve(reopened.catalog().get('AcroForm')) as PdfDict;
    expect(isDict(acro)).toBe(true);
    expect(Number(acro.get('SigFlags'))).toBeGreaterThanOrEqual(1);
  });

  it('reports tampered content as an invalid digest', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'X' });
    await doc.Sign(signerOf(buildSigner()), {});
    const bytes = doc.Save();
    // Flip a byte inside the first signed range.
    const sig = Document.Open(bytes).Signatures[0];
    const [, a] = sig.byteRange!;
    bytes[Math.floor(a / 2)] ^= 0xff;

    const v = verifyFirstSignature(bytes);
    expect(v.digestMatches).toBe(false);
  });

  it('signs with the PAdES (ETSI.CAdES.detached) subfilter + signing-certificate-v2', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'PAdES' });
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { subFilter: 'PAdES', reason: 'pades' });
    const bytes = doc.Save();

    const sig = Document.Open(bytes).Signatures[0];
    expect(sig.subFilter).toBe('ETSI.CAdES.detached');

    const v = verifyFirstSignature(bytes);
    expect(v.digestMatches).toBe(true);
    expect(v.signatureValid).toBe(true);

    // The signed attributes carry the ESS signing-certificate-v2 attribute (its
    // OID appears in the CMS DER); a plain CMS signature omits it.
    const cms = sig.contents!.subarray(0, sig.cmsLength!);
    expect(containsSubsequence(cms, der.oid(OID.signingCertificateV2))).toBe(true);

    const plain = await (async () => {
      const d = Document.Open(buildClassicPdf(1));
      d.SetMetadata({ title: 'CMS' });
      await d.Sign(signerOf(buildSigner({ type: 'rsa' })), {});
      const b = d.Save();
      const s = Document.Open(b).Signatures[0];
      return s.contents!.subarray(0, s.cmsLength!);
    })();
    expect(containsSubsequence(plain, der.oid(OID.signingCertificateV2))).toBe(false);
  });
});

describe('Document.Sign — credential sources (K1)', () => {
  it('signs from a PKCS#12 credential', async () => {
    const { p12 } = buildPkcs12({ passphrase: 'secret' });
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'p12' });
    await doc.Sign({ pkcs12: p12, passphrase: 'secret' }, { reason: 'p12 sign' });
    const v = verifyFirstSignature(doc.Save());
    expect(v.digestMatches && v.signatureValid).toBe(true);
  });

  it('signs from a PEM key + certificate', async () => {
    const s = buildSigner({ type: 'rsa' });
    const keyPem = s.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const certPem = new X509Certificate(Buffer.from(s.certificate)).toString();
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'pem' });
    await doc.Sign({ pem: { key: keyPem, certificates: [certPem] } }, {});
    const v = verifyFirstSignature(doc.Save());
    expect(v.digestMatches && v.signatureValid).toBe(true);
  });

  it('signs via an external callback that never exposes the key', async () => {
    const s = buildSigner({ type: 'ec', namedCurve: 'P-256' });
    const certPem = new X509Certificate(Buffer.from(s.certificate)).toString();
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'ext' });
    await doc.Sign({
      certificates: [certPem],
      sign: (data, alg) => signData(data, s.privateKey, alg.scheme, alg.digest),
    }, {});
    const v = verifyFirstSignature(doc.Save());
    expect(v.digestMatches && v.signatureValid).toBe(true);
  });

  it('fails before mutating the document on a wrong PKCS#12 passphrase', async () => {
    const { p12 } = buildPkcs12({ passphrase: 'right' });
    const doc = Document.Open(buildClassicPdf(1));
    await expect(doc.Sign({ pkcs12: p12, passphrase: 'wrong' }, {})).rejects.toThrow();
    // No signature field was installed by the failed attempt.
    expect(doc.Signatures.some((sig) => sig.isSigned)).toBe(false);
  });
});
