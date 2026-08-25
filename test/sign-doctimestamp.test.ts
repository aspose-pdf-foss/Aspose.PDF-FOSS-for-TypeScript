import { describe, it, expect } from 'vitest';
import { byteRangeContent, buildDocTimeStampDict } from '../src/signature.js';
import { isName } from '../src/types.js';
import { Document } from '../src/document.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { buildTimeStampToken, parseTstInfo } from '../src/rfc3161.js';
import type { CmsSigner } from '../src/cms.js';
import { buildOcspResponse } from './helpers/build-revocation.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}
function testTsa(t: TestSigner): (req: Uint8Array) => Promise<Uint8Array> {
  const signer: CmsSigner = { certificate: t.certificate, privateKey: t.privateKey };
  return (req) => buildTimeStampToken(req, signer);
}

describe('signature.ts doc-timestamp helpers', () => {
  it('byteRangeContent concatenates the two /ByteRange segments', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Hole at [3, 6): first segment [0,3), second segment [6, 6+3)=[6,9).
    const out = byteRangeContent(bytes, [0, 3, 6, 3]);
    expect(Array.from(out)).toEqual([0, 1, 2, 6, 7, 8]);
  });

  it('buildDocTimeStampDict carries the /DocTimeStamp value-dict keys', () => {
    const d = buildDocTimeStampDict();
    const type = d.get('Type'); const filter = d.get('Filter'); const sf = d.get('SubFilter');
    expect(isName(type) && type.name).toBe('DocTimeStamp');
    expect(isName(filter) && filter.name).toBe('Adobe.PPKLite');
    expect(isName(sf) && sf.name).toBe('ETSI.RFC3161');
    expect(d.has('ByteRange')).toBe(false);
    expect(d.has('Contents')).toBe(false);
  });
});

describe('Document.AddDocumentTimestamp — authoring + read model', () => {
  it('appends a /DocTimeStamp via incremental update and lists it separately', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'dts' });
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'signed' });
    const signedBytes = doc.Save();

    const doc2 = Document.Open(signedBytes);
    await doc2.AddDocumentTimestamp(testTsa(buildSigner({ type: 'rsa', commonName: 'Test TSA' })));
    const out = doc2.Save();

    // Incremental append: the signed revision is preserved byte-for-byte.
    expect(out.subarray(0, signedBytes.length)).toEqual(signedBytes);

    const re = Document.Open(out);
    // Real signatures exclude the timestamp; DocumentTimestamps lists only it.
    expect(re.Signatures).toHaveLength(1);
    expect(re.Signatures[0].isDocTimeStamp).toBe(false);
    expect(re.DocumentTimestamps).toHaveLength(1);
    const dts = re.DocumentTimestamps[0];
    expect(dts.isDocTimeStamp).toBe(true);
    expect(dts.subFilter).toBe('ETSI.RFC3161');
    expect(dts.name).toBe('Timestamp1');
    // The /Contents is a parseable RFC 3161 token whose imprint is over the doc.
    const token = dts.contents!.subarray(0, dts.cmsLength);
    expect(() => parseTstInfo(token)).not.toThrow();
  });
});

describe('Document.VerifyDocumentTimestamps', () => {
  async function timestamped(): Promise<Uint8Array> {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'dts-verify' });
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'signed' });
    const doc2 = Document.Open(doc.Save());
    await doc2.AddDocumentTimestamp(testTsa(buildSigner({ type: 'rsa', commonName: 'Test TSA' })));
    return doc2.Save();
  }

  it('verifies the document timestamp (imprint + TSA signature)', async () => {
    const out = await timestamped();
    const reports = await Document.Open(out).VerifyDocumentTimestamps();
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.name).toBe('Timestamp1');
    expect(r.timestamp.valid).toBe(true);
    expect(r.timestamp.imprintMatches).toBe(true);
    expect(r.timestamp.tokenSignatureValid).toBe(true);
    expect(r.timestamp.time).toBeInstanceOf(Date);
    expect(r.coversWholeFile).toBe(true);
    expect(r.signerCert?.subject).toContain('Test TSA');
  });

  it('flips imprintMatches when the timestamped range is corrupted', async () => {
    const out = await timestamped();
    const dts = Document.Open(out).DocumentTimestamps[0];
    out[Math.floor(dts.byteRange![1] / 2)] ^= 0xff; // corrupt the covered range
    const r = (await Document.Open(out).VerifyDocumentTimestamps())[0];
    expect(r.timestamp.imprintMatches).toBe(false);
    expect(r.timestamp.valid).toBe(false);
  });
});

describe('padesLevel classification', () => {
  it('classifies B-B / B-T / B-LT / B-LTA up the ladder', async () => {
    const s = buildSigner({ type: 'rsa' });
    const tsa = buildSigner({ type: 'rsa', commonName: 'Test TSA' });

    // B-B: bare signature, no timestamp, no DSS.
    const bDoc = Document.Open(buildClassicPdf(1));
    bDoc.SetMetadata({ title: 'b-b' });
    await bDoc.Sign(signerOf(s), { reason: 'plain' });
    const bBytes = bDoc.Save();
    expect((await Document.Open(bBytes).VerifySignatures())[0].padesLevel).toBe('B-B');

    // B-T: signature carries an embedded RFC 3161 signature-timestamp.
    const tDoc = Document.Open(buildClassicPdf(1));
    tDoc.SetMetadata({ title: 'b-t' });
    await tDoc.Sign(signerOf(s), { timestamp: testTsa(tsa), placeholderBytes: 16384 });
    const tBytes = tDoc.Save();
    expect((await Document.Open(tBytes).VerifySignatures())[0].padesLevel).toBe('B-T');

    // B-LT: add /DSS validation data over the B-T signature.
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });
    const ltDoc = Document.Open(tBytes);
    await ltDoc.AddValidationData({ getOCSP: () => ocsp });
    const ltBytes = ltDoc.Save();
    expect((await Document.Open(ltBytes).VerifySignatures())[0].padesLevel).toBe('B-LT');

    // B-LTA: add a document timestamp on top of the B-LT document.
    const ltaDoc = Document.Open(ltBytes);
    await ltaDoc.AddDocumentTimestamp(testTsa(tsa));
    const ltaBytes = ltaDoc.Save();
    expect((await Document.Open(ltaBytes).VerifySignatures())[0].padesLevel).toBe('B-LTA');
  });
});
