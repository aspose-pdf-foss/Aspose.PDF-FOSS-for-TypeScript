import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildRsaSigner } from './helpers/build-signer.js';
import { buildSignedData, parseSignedData, verifySignedData } from '../src/cms.js';
import { UnsupportedFeatureError } from '../src/errors.js';

const digestOf = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());

describe('CAdES commitment-type attribute', () => {
  it('round-trips a friendly commitment type and keeps the signature valid', async () => {
    const signer = buildRsaSigner();
    const md = digestOf('commit');
    const cms = await buildSignedData(md, signer, { cades: { commitmentType: 'proof-of-origin' } });
    const parsed = parseSignedData(cms);
    expect(parsed.commitmentType).toBe('proof-of-origin');
    // attribute is part of the signed set -> signature must still verify
    expect(verifySignedData(cms, md).signatureValid).toBe(true);
  });

  it('passes a custom dotted OID through verbatim', async () => {
    const signer = buildRsaSigner();
    const cms = await buildSignedData(digestOf('x'), signer, {
      cades: { commitmentType: '1.3.6.1.4.1.99999.7' },
    });
    expect(parseSignedData(cms).commitmentType).toBe('1.3.6.1.4.1.99999.7');
  });

  it('omits the attribute when no cades option is given', async () => {
    const signer = buildRsaSigner();
    const cms = await buildSignedData(digestOf('y'), signer);
    expect(parseSignedData(cms).commitmentType).toBeUndefined();
  });

  it('rejects a commitment type that is neither a known name nor an OID', async () => {
    const signer = buildRsaSigner();
    await expect(buildSignedData(digestOf('z'), signer, {
      cades: { commitmentType: 'not-a-commitment' },
    })).rejects.toThrow(UnsupportedFeatureError);
  });
});

describe('CAdES signer-location attribute', () => {
  it('round-trips country, locality, and a multi-line postal address', async () => {
    const signer = buildRsaSigner();
    const md = digestOf('loc');
    const location = { country: 'DE', locality: 'Berlin', postalAddress: ['Alexanderplatz 1', '10178'] };
    const cms = await buildSignedData(md, signer, { cades: { signerLocation: location } });
    const parsed = parseSignedData(cms);
    expect(parsed.signerLocation).toEqual(location);
    expect(verifySignedData(cms, md).signatureValid).toBe(true);
  });

  it('emits only the present sub-fields', async () => {
    const signer = buildRsaSigner();
    const cms = await buildSignedData(digestOf('c'), signer, {
      cades: { signerLocation: { country: 'FR' } },
    });
    expect(parseSignedData(cms).signerLocation).toEqual({ country: 'FR' });
  });

  it('omits the attribute for an all-empty signer location', async () => {
    const signer = buildRsaSigner();
    const cms = await buildSignedData(digestOf('e'), signer, {
      cades: { signerLocation: { postalAddress: [] } },
    });
    expect(parseSignedData(cms).signerLocation).toBeUndefined();
  });

  it('carries both commitment-type and signer-location together', async () => {
    const signer = buildRsaSigner();
    const md = digestOf('both');
    const cms = await buildSignedData(md, signer, {
      cades: { commitmentType: 'proof-of-approval', signerLocation: { locality: 'Paris' } },
    });
    const parsed = parseSignedData(cms);
    expect(parsed.commitmentType).toBe('proof-of-approval');
    expect(parsed.signerLocation).toEqual({ locality: 'Paris' });
    expect(verifySignedData(cms, md).signatureValid).toBe(true);
  });
});
