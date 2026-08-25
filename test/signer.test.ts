import { describe, it, expect } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import { buildSigner } from './helpers/build-signer.js';
import { buildPkcs12 } from './helpers/build-pkcs12.js';
import { resolveSigner } from '../src/signer.js';
import { buildSignedData, verifySignedData } from '../src/cms.js';
import { signData } from '../src/sigalg.js';

const digestOf = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());

/** Resolve a signer, sign a digest through CMS, and verify it round-trips. */
async function roundTrip(signer: any, payload = 'payload'): Promise<boolean> {
  const cms = await buildSignedData(digestOf(payload), await resolveSigner(signer));
  const r = verifySignedData(cms, digestOf(payload));
  return r.signatureValid && r.digestMatches;
}

describe('resolveSigner', () => {
  it('resolves a PEM key + certificate chain', async () => {
    const s = buildSigner({ type: 'rsa', commonName: 'Pem User' });
    const keyPem = s.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const certPem = new X509Certificate(Buffer.from(s.certificate)).toString();

    const resolved = await resolveSigner({ pem: { key: keyPem, certificates: [certPem] } });
    expect(resolved.privateKey).toBeDefined();
    expect(Buffer.from(resolved.certificate).equals(Buffer.from(s.certificate))).toBe(true);
    expect(await roundTrip({ pem: { key: keyPem, certificates: [certPem] } })).toBe(true);
  });

  it('decrypts an encrypted PEM key with its passphrase', async () => {
    const s = buildSigner({ type: 'rsa' });
    const keyPem = s.privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'pw' }) as string;
    const certPem = new X509Certificate(Buffer.from(s.certificate)).toString();
    const resolved = await resolveSigner({ pem: { key: keyPem, passphrase: 'pw', certificates: [certPem] } });
    expect(resolved.privateKey).toBeDefined();
  });

  it('resolves a PKCS#12 blob to key + chain', async () => {
    const { p12, certificate } = buildPkcs12({ passphrase: 'secret', extraCerts: 1 });
    const resolved = await resolveSigner({ pkcs12: p12, passphrase: 'secret' });
    expect(Buffer.from(resolved.certificate).equals(Buffer.from(certificate))).toBe(true);
    expect(resolved.chain?.length).toBe(1);
    expect(await roundTrip({ pkcs12: p12, passphrase: 'secret' })).toBe(true);
  });

  it('resolves an external callback signer (no private key)', async () => {
    const s = buildSigner({ type: 'ec', namedCurve: 'P-256' });
    const certPem = new X509Certificate(Buffer.from(s.certificate)).toString();
    const ext = {
      certificates: [certPem],
      sign: (data: Uint8Array, alg: any) => signData(data, s.privateKey, alg.scheme, alg.digest),
    };
    const resolved = await resolveSigner(ext);
    expect(resolved.privateKey).toBeUndefined();
    expect(resolved.sign).toBeDefined();
    expect(resolved.signatureScheme).toBe('ecdsa'); // detected from the certificate
    expect(await roundTrip(ext)).toBe(true);
  });

  it('passes a pre-resolved CmsSigner through unchanged', async () => {
    const s = buildSigner({ type: 'rsa' });
    const resolved = await resolveSigner({ certificate: s.certificate, privateKey: s.privateKey });
    expect(resolved.privateKey).toBe(s.privateKey);
    expect(await roundTrip({ certificate: s.certificate, privateKey: s.privateKey })).toBe(true);
  });

  it('rejects a PKCS#12 blob with the wrong passphrase', async () => {
    const { p12 } = buildPkcs12({ passphrase: 'right' });
    await expect(resolveSigner({ pkcs12: p12, passphrase: 'wrong' })).rejects.toThrow();
  });
});
