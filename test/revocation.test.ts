import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { der } from '../src/asn1.js';
import { buildSigner } from './helpers/build-signer.js';
import { buildOcspResponse, buildCrl } from './helpers/build-revocation.js';
import {
  parseOcspResponse, ocspStatus, verifyOcspSignature,
  parseCrl, crlStatus, verifyCrlSignature, checkRevocation, findIssuer,
} from '../src/revocation.js';

describe('revocation — OCSP', () => {
  it('parses a response and reports a good status', () => {
    const s = buildSigner({ type: 'rsa' });
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });
    const resp = parseOcspResponse(ocsp);
    expect(resp.responseStatus).toBe(0);
    expect(verifyOcspSignature(resp, s.certificate)).toBe(true);
    expect(ocspStatus(resp, s.certificate, s.certificate)).toBe('good');
  });

  it('reports a revoked status', () => {
    const s = buildSigner();
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'revoked' });
    expect(ocspStatus(parseOcspResponse(ocsp), s.certificate, s.certificate)).toBe('revoked');
  });

  it('detects a tampered response signature', () => {
    const s = buildSigner();
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good', tamper: true });
    expect(verifyOcspSignature(parseOcspResponse(ocsp), s.certificate)).toBe(false);
  });

  it('returns unknown when no CertID matches the certificate', () => {
    const s = buildSigner();
    const other = buildSigner();
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });
    expect(ocspStatus(parseOcspResponse(ocsp), other.certificate, other.certificate)).toBe('unknown');
  });

  it('works with an EC responder', () => {
    const s = buildSigner({ type: 'ec' });
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });
    const resp = parseOcspResponse(ocsp);
    expect(verifyOcspSignature(resp, s.certificate)).toBe(true);
    expect(ocspStatus(resp, s.certificate, s.certificate)).toBe('good');
  });

  it('requires the responder key to match the advertised signature algorithm', () => {
    const s = buildSigner({ type: 'ec' });
    const resp = parseOcspResponse(buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' }));
    expect(verifyOcspSignature({ ...resp, signatureAlgorithm: '1.2.840.113549.1.1.11' }, s.certificate)).toBe(false);
  });

  it('matches ResponderID by the public-key hash', () => {
    const s = buildSigner({ type: 'ec' });
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good', responderByKey: true });
    expect(checkRevocation(s.certificate, s.certificate, { ocsp })).toEqual({ status: 'good', source: 'ocsp' });
    const response = parseOcspResponse(ocsp);
    const differentKey = { type: 'key', value: new Uint8Array(20) } as const;
    expect(verifyOcspSignature({ ...response, responderId: differentKey }, s.certificate)).toBe(false);
  });
});

describe('revocation — CRL', () => {
  it('reports good when the serial is absent and verifies the signature', () => {
    const s = buildSigner({ type: 'rsa' });
    const crl = parseCrl(buildCrl({ issuer: s, revokedSerials: [] }));
    expect(verifyCrlSignature(crl, s.certificate)).toBe(true);
    expect(crlStatus(crl, s.certificate)).toBe('good');
  });

  it('reports revoked when the serial is listed', () => {
    const s = buildSigner();
    const serial = 0x0123456789n; // the serial build-signer mints
    const crl = parseCrl(buildCrl({ issuer: s, revokedSerials: [serial] }));
    expect(crlStatus(crl, s.certificate)).toBe('revoked');
  });

  it('detects a tampered CRL signature', () => {
    const s = buildSigner();
    const der = buildCrl({ issuer: s, revokedSerials: [] });
    der[der.length - 1] ^= 0xff;
    expect(verifyCrlSignature(parseCrl(der), s.certificate)).toBe(false);
  });
});

describe('revocation — checkRevocation', () => {
  it('prefers a signature-verified OCSP verdict', () => {
    const s = buildSigner();
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'revoked' });
    expect(checkRevocation(s.certificate, s.certificate, { ocsp })).toEqual({ status: 'revoked', source: 'ocsp' });
  });

  it('falls back to a CRL', () => {
    const s = buildSigner();
    const crl = buildCrl({ issuer: s, revokedSerials: [0x0123456789n] });
    expect(checkRevocation(s.certificate, s.certificate, { crl })).toEqual({ status: 'revoked', source: 'crl' });
  });

  it('is unchecked with no material and unknown when a signature fails', () => {
    const s = buildSigner();
    expect(checkRevocation(s.certificate, s.certificate, {}).status).toBe('unchecked');
    const bad = buildCrl({ issuer: s, revokedSerials: [] });
    bad[bad.length - 1] ^= 0xff;
    expect(checkRevocation(s.certificate, s.certificate, { crl: bad }).status).toBe('unknown');
  });

  it('finds a self-issued certificate as its own issuer', () => {
    const s = buildSigner();
    expect(findIssuer(s.certificate, [s.certificate])).toEqual(s.certificate);
  });
});

describe('independently generated revocation evidence', () => {
  const vectors: Record<string, string> = JSON.parse(readFileSync(new URL('./fixtures/revocation/evidence.json', import.meta.url), 'utf8'));
  const bytes = (name: string) => Buffer.from(vectors[name], 'base64');
  const at = new Date(vectors.at);

  it('selects the cryptographic issuer among certificates with the same subject', () => {
    expect(findIssuer(bytes('leaf'), [bytes('otherIssuer'), bytes('issuer')])).toEqual(bytes('issuer'));
  });

  it.each([
    ['issuerOcsp', 'good'], ['delegateOcsp', 'revoked'], ['freshNoNextOcsp', 'good'],
    ['tlsOnlyOcsp', 'unknown'], ['expiredDelegateOcsp', 'unknown'], ['otherCertOcsp', 'unknown'],
    ['staleOcsp', 'unknown'], ['staleNoNextOcsp', 'unknown'],
  ])('evaluates Go OCSP evidence %s as %s', (vector, status) => {
    const result = checkRevocation(bytes('leaf'), bytes('issuer'), { ocsp: bytes(vector) }, at);
    expect(result).toEqual(status === 'unknown' ? { status } : { status, source: 'ocsp' });
  });

  it.each([
    ['goodCrl', 'good'], ['revokedCrl', 'revoked'], ['staleCrl', 'unknown'], ['scopedCrl', 'unknown'],
  ])('evaluates Go CRL evidence %s as %s', (vector, status) => {
    const result = checkRevocation(bytes('leaf'), bytes('issuer'), { crl: bytes(vector) }, at);
    expect(result).toEqual(status === 'unknown' ? { status } : { status, source: 'crl' });
  });

  it('rejects a valid CRL from a different CA with the same subject name', () => {
    const crl = bytes('wrongIssuerCrl');
    expect(checkRevocation(bytes('leaf'), bytes('otherIssuer'), { crl }, at)).toEqual({ status: 'unknown' });
  });

  it('requires CRL signing usage when the issuer has KeyUsage', () => {
    const crl = bytes('goodCrl');
    expect(findIssuer(bytes('leaf'), [bytes('noCrlIssuer')])).toEqual(bytes('noCrlIssuer'));
    expect(checkRevocation(bytes('leaf'), bytes('noCrlIssuer'), { crl }, at)).toEqual({ status: 'unknown' });
  });

  it('does not infer good for a certificate that expired before the CRL was issued', () => {
    expect(checkRevocation(bytes('expiredLeaf'), bytes('issuer'), { crl: bytes('goodCrl') }, at)).toEqual({ status: 'unknown' });
  });

  it('falls back to a current direct CRL after stale OCSP evidence', () => {
    const material = { ocsp: bytes('staleOcsp'), crl: bytes('revokedCrl') };
    expect(checkRevocation(bytes('leaf'), bytes('issuer'), material, at)).toEqual({ status: 'revoked', source: 'crl' });
  });

  it('rejects trailing bytes and oversized DER at the evidence boundary', () => {
    expect(() => parseOcspResponse(Buffer.concat([bytes('issuerOcsp'), Buffer.of(0)]))).toThrow();
    expect(() => parseOcspResponse(new Uint8Array(512 * 1024 + 1))).toThrow();
    expect(() => parseCrl(new Uint8Array(4 * 1024 * 1024 + 1))).toThrow();
  });

  it('bounds DER nesting before interpreting the response fields', () => {
    let nested = der.sequence();
    for (let i = 0; i < 40; i++) nested = der.sequence(nested);
    expect(() => parseOcspResponse(nested)).toThrow(/structural limits/);
  });
});
