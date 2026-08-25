import { describe, it, expect } from 'vitest';
import { buildSigner, issueCert } from './helpers/build-signer.js';
import { verifyCertChain } from '../src/chain.js';

describe('certificate chain validation', () => {
  it('trusts a self-signed certificate that is its own anchor', () => {
    const s = buildSigner();
    expect(verifyCertChain(s.certificate, [s.certificate], { trustAnchors: [s.certificate] }).status).toBe('trusted');
  });

  it('trusts a leaf that chains to a trusted root', () => {
    const root = issueCert({ ca: true, commonName: 'Test Root' });
    const leaf = issueCert({ issuer: root, digitalSignature: true, commonName: 'Test Leaf' });
    const r = verifyCertChain(leaf.certificate, [leaf.certificate, root.certificate], { trustAnchors: [root.certificate] });
    expect(r.status).toBe('trusted');
  });

  it('distrusts a leaf chaining to an unknown root', () => {
    const root = issueCert({ ca: true, commonName: 'Test Root' });
    const other = issueCert({ ca: true, commonName: 'Other Root' });
    const leaf = issueCert({ issuer: root, digitalSignature: true, commonName: 'Test Leaf' });
    const r = verifyCertChain(leaf.certificate, [leaf.certificate, root.certificate], { trustAnchors: [other.certificate] });
    expect(r.status).toBe('untrusted');
  });

  it('distrusts an incomplete chain (missing intermediate)', () => {
    const root = issueCert({ ca: true, commonName: 'Root' });
    const inter = issueCert({ issuer: root, ca: true, commonName: 'Intermediate' });
    const leaf = issueCert({ issuer: inter, digitalSignature: true, commonName: 'Leaf' });
    // The intermediate is absent from the pool, so the path cannot be built.
    const r = verifyCertChain(leaf.certificate, [leaf.certificate], { trustAnchors: [root.certificate] });
    expect(r.status).toBe('untrusted');
  });

  it('distrusts an expired certificate', () => {
    const s = issueCert({ digitalSignature: true, notAfter: new Date(Date.UTC(2021, 0, 1)) });
    const r = verifyCertChain(s.certificate, [s.certificate], { trustAnchors: [s.certificate] });
    expect(r.status).toBe('untrusted');
    // ...but trusted at a time within its validity window.
    expect(verifyCertChain(s.certificate, [s.certificate], {
      trustAnchors: [s.certificate], at: new Date(Date.UTC(2020, 6, 1)),
    }).status).toBe('trusted');
  });

  it('distrusts a signer whose key usage forbids signing', () => {
    // A CA cert (keyUsage = keyCertSign only) used as a leaf signer.
    const ca = issueCert({ ca: true, commonName: 'CA-as-signer' });
    const r = verifyCertChain(ca.certificate, [ca.certificate], { trustAnchors: [ca.certificate] });
    expect(r.status).toBe('untrusted');
  });

  it('builds a three-level path to the root', () => {
    const root = issueCert({ ca: true, commonName: 'Root' });
    const inter = issueCert({ issuer: root, ca: true, commonName: 'Intermediate' });
    const leaf = issueCert({ issuer: inter, digitalSignature: true, commonName: 'Leaf' });
    const r = verifyCertChain(leaf.certificate, [leaf.certificate, inter.certificate], { trustAnchors: [root.certificate] });
    expect(r.status).toBe('trusted');
    expect(r.path.length).toBe(3); // leaf, intermediate, root
  });
});
