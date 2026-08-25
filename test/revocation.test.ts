import { describe, it, expect } from 'vitest';
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
