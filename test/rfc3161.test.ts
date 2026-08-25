import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { der } from '../src/asn1.js';
import {
  buildTimeStampRequest, parseTimeStampRequest, buildTimeStampToken,
  extractTimeStampToken, parseTstInfo, verifyTimestampToken,
} from '../src/rfc3161.js';
import type { CmsSigner } from '../src/cms.js';

function tsaOf(t: TestSigner): CmsSigner {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

/** hash(value) with `alg`, as a Uint8Array. */
function imprintOf(value: Uint8Array, alg: 'sha256' | 'sha384' = 'sha256'): Uint8Array {
  return new Uint8Array(createHash(alg).update(value).digest());
}

describe('RFC 3161 — request', () => {
  it('round-trips the message imprint, hash algorithm, and nonce', () => {
    const imprint = imprintOf(new Uint8Array([1, 2, 3]));
    const req = buildTimeStampRequest(imprint, 'sha256', { nonce: 0x1234abcdn });
    const info = parseTimeStampRequest(req);
    expect(info.hashAlg).toBe('sha256');
    expect(info.imprint).toEqual(imprint);
    expect(info.nonce).toBe(0x1234abcdn);
  });

  it('supports SHA-384 imprints', () => {
    const imprint = imprintOf(new Uint8Array([9]), 'sha384');
    const info = parseTimeStampRequest(buildTimeStampRequest(imprint, 'sha384'));
    expect(info.hashAlg).toBe('sha384');
    expect(info.imprint.length).toBe(48);
  });
});

describe('RFC 3161 — token build/parse', () => {
  it('echoes the request imprint and carries genTime/policy/serial', async () => {
    const sigValue = new Uint8Array(randomBytes(64));
    const genTime = new Date(Date.UTC(2026, 5, 24, 12, 0, 0));
    const req = buildTimeStampRequest(imprintOf(sigValue), 'sha256', { nonce: 42n });
    const token = await buildTimeStampToken(req, tsaOf(buildSigner({ type: 'rsa' })), {
      genTime, serialNumber: 7n, policy: '1.2.3.4.5',
    });

    const info = parseTstInfo(token);
    expect(info.imprint).toEqual(imprintOf(sigValue));
    expect(info.genTime.getTime()).toBe(genTime.getTime());
    expect(info.serialNumber).toBe(7n);
    expect(info.policy).toBe('1.2.3.4.5');
    expect(info.nonce).toBe(42n);
  });
});

describe('RFC 3161 — verification', () => {
  it('verifies a well-formed token against the value it timestamps', async () => {
    const sigValue = new Uint8Array(randomBytes(48));
    const req = buildTimeStampRequest(imprintOf(sigValue), 'sha256');
    const token = await buildTimeStampToken(req, tsaOf(buildSigner({ type: 'rsa' })));

    const v = verifyTimestampToken(token, sigValue);
    expect(v.imprintMatches).toBe(true);
    expect(v.tokenSignatureValid).toBe(true);
    expect(v.valid).toBe(true);
    expect(v.time).toBeInstanceOf(Date);
  });

  it('reports an imprint mismatch when the timestamped value differs', async () => {
    const sigValue = new Uint8Array(randomBytes(48));
    const req = buildTimeStampRequest(imprintOf(sigValue), 'sha256');
    const token = await buildTimeStampToken(req, tsaOf(buildSigner()));

    const v = verifyTimestampToken(token, new Uint8Array(randomBytes(48)));
    expect(v.imprintMatches).toBe(false);
    expect(v.valid).toBe(false);
  });

  it("detects tampering with the TSA's signature", async () => {
    const sigValue = new Uint8Array(randomBytes(48));
    const req = buildTimeStampRequest(imprintOf(sigValue), 'sha256');
    const token = await buildTimeStampToken(req, tsaOf(buildSigner()));

    const tampered = Uint8Array.from(token);
    tampered[tampered.length - 1] ^= 0xff; // flip a byte of the TSA signature
    const v = verifyTimestampToken(tampered, sigValue);
    expect(v.imprintMatches).toBe(true);        // imprint still parses intact
    expect(v.tokenSignatureValid).toBe(false);  // but the TSA signature breaks
    expect(v.valid).toBe(false);
  });

  it('works with an EC-keyed TSA', async () => {
    const sigValue = new Uint8Array(randomBytes(48));
    const req = buildTimeStampRequest(imprintOf(sigValue), 'sha256');
    const token = await buildTimeStampToken(req, tsaOf(buildSigner({ type: 'ec' })));
    expect(verifyTimestampToken(token, sigValue).valid).toBe(true);
  });
});

describe('RFC 3161 — response normalization', () => {
  it('passes a bare ContentInfo token through unchanged', async () => {
    const req = buildTimeStampRequest(imprintOf(new Uint8Array([1])), 'sha256');
    const token = await buildTimeStampToken(req, tsaOf(buildSigner()));
    expect(extractTimeStampToken(token)).toEqual(token);
  });

  it('unwraps the token from a TimeStampResp envelope', async () => {
    const req = buildTimeStampRequest(imprintOf(new Uint8Array([1])), 'sha256');
    const token = await buildTimeStampToken(req, tsaOf(buildSigner()));
    // TimeStampResp ::= SEQUENCE { PKIStatusInfo, timeStampToken OPTIONAL }
    const resp = der.sequence(der.sequence(der.integer(0)), token);
    expect(extractTimeStampToken(resp)).toEqual(token);
  });
});
