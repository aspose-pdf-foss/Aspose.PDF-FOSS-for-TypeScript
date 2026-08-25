import { describe, it, expect } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import { buildRsaSigner, buildSigner } from './helpers/build-signer.js';
import { buildSignedData, parseSignedData, verifySignedData, buildEnvelopedData, openEnvelopedData } from '../src/cms.js';
import { signData, SigAlg } from '../src/sigalg.js';
import { parse, readOid, OID } from '../src/asn1.js';

const digestOf = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());

describe('build-signer fixture', () => {
  it('produces a self-signed cert node:crypto can parse', () => {
    const signer = buildRsaSigner('Alice');
    const cert = new X509Certificate(Buffer.from(signer.certificate));
    expect(cert.subject).toContain('Alice');
  });
});

describe('buildSignedData / parseSignedData', () => {
  it('embeds the message digest and signer certificate', async () => {
    const signer = buildRsaSigner();
    const md = digestOf('hello world');
    const cms = await buildSignedData(md, signer);
    const parsed = parseSignedData(cms);
    expect(Buffer.from(parsed.messageDigest).toString('hex')).toBe(Buffer.from(md).toString('hex'));
    expect(parsed.digestAlgorithm).toBe('sha256');
    expect(parsed.certificates.length).toBe(1);
  });
});

describe('verifySignedData', () => {
  it('accepts a correct message digest', async () => {
    const signer = buildRsaSigner();
    const md = digestOf('the quick brown fox');
    const cms = await buildSignedData(md, signer);
    const r = verifySignedData(cms, md);
    expect(r.signatureValid).toBe(true);
    expect(r.digestMatches).toBe(true);
  });
  it('rejects a tampered message digest', async () => {
    const signer = buildRsaSigner();
    const cms = await buildSignedData(digestOf('original'), signer);
    const r = verifySignedData(cms, digestOf('tampered'));
    expect(r.digestMatches).toBe(false);
  });
  it('reports an invalid signature when the signature bytes are corrupted', async () => {
    const signer = buildRsaSigner();
    const md = digestOf('payload');
    const cms = await buildSignedData(md, signer);
    cms[cms.length - 1] ^= 0xff; // flip a byte inside the signature OCTET STRING
    const r = verifySignedData(cms, md);
    expect(r.signatureValid).toBe(false);
  });
  it('round-trips with a sha512 digest algorithm', async () => {
    const signer = buildRsaSigner();
    const md = new Uint8Array(createHash('sha512').update('x').digest());
    const cms = await buildSignedData(md, { ...signer, digestAlgorithm: 'sha512' });
    expect(parseSignedData(cms).digestAlgorithm).toBe('sha512');
    const r = verifySignedData(cms, md);
    expect(r.signatureValid && r.digestMatches).toBe(true);
  });
});

describe('algorithm coverage (A3)', () => {
  it('ECDSA P-256 round-trips', async () => {
    const signer = buildSigner({ type: 'ec', namedCurve: 'P-256' });
    const md = digestOf('ecdsa payload');
    const cms = await buildSignedData(md, signer);
    expect(parseSignedData(cms).signatureAlgorithm).toBe('ecdsaWithSHA256');
    const r = verifySignedData(cms, md);
    expect(r.signatureValid && r.digestMatches).toBe(true);
  });
  it('RSA-PSS round-trips', async () => {
    const md = digestOf('pss payload');
    const cms = await buildSignedData(md, { ...buildRsaSigner(), signatureScheme: 'rsa-pss' });
    expect(parseSignedData(cms).signatureAlgorithm).toBe('rsaPss');
    const r = verifySignedData(cms, md);
    expect(r.signatureValid && r.digestMatches).toBe(true);
  });
  it('Ed25519 round-trips (digest sha512)', async () => {
    const signer = buildSigner({ type: 'ed25519' });
    const md = new Uint8Array(createHash('sha512').update('ed payload').digest());
    const cms = await buildSignedData(md, { ...signer, digestAlgorithm: 'sha512' });
    expect(parseSignedData(cms).signatureAlgorithm).toBe('ed25519');
    const r = verifySignedData(cms, md);
    expect(r.signatureValid && r.digestMatches).toBe(true);
  });
  it('detects a corrupted ECDSA signature', async () => {
    const signer = buildSigner({ type: 'ec', namedCurve: 'P-384' });
    const md = digestOf('p384');
    const cms = await buildSignedData(md, { ...signer, digestAlgorithm: 'sha384' });
    cms[cms.length - 1] ^= 0xff;
    expect(verifySignedData(cms, md).signatureValid).toBe(false);
  });
});

describe('external sign callback (K1)', () => {
  it('signs via a callback without exposing a private key', async () => {
    const signer = buildRsaSigner();
    const md = digestOf('external payload');
    let seen: SigAlg | undefined;
    const cms = await buildSignedData(md, {
      certificate: signer.certificate,
      signatureScheme: 'rsa',
      sign: (data, alg) => { seen = alg; return signData(data, signer.privateKey, alg.scheme, alg.digest); },
    });
    expect(seen).toEqual({ scheme: 'rsa', digest: 'sha256' });
    const r = verifySignedData(cms, md);
    expect(r.signatureValid && r.digestMatches).toBe(true);
  });

  it('awaits an asynchronous callback (HSM/KMS shape)', async () => {
    const signer = buildSigner({ type: 'ec', namedCurve: 'P-256' });
    const md = digestOf('async payload');
    const cms = await buildSignedData(md, {
      certificate: signer.certificate,
      signatureScheme: 'ecdsa',
      sign: async (data, alg) => signData(data, signer.privateKey, alg.scheme, alg.digest),
    });
    const r = verifySignedData(cms, md);
    expect(r.signatureValid && r.digestMatches).toBe(true);
  });
});

describe('CMS EnvelopedData', () => {
  const content = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 0xde, 0xad, 0xbe, 0xef]); // 24 bytes

  it('round-trips content for the matching recipient', () => {
    const a = buildRsaSigner('Recipient A');
    const env = buildEnvelopedData([a.certificate], content);
    const out = openEnvelopedData(env, a.privateKey, a.certificate);
    expect(out).not.toBeUndefined();
    expect([...out!]).toEqual([...content]);
  });

  it('returns undefined for a non-recipient key/cert', () => {
    const a = buildRsaSigner('Recipient A');
    const b = buildRsaSigner('Stranger B');
    const env = buildEnvelopedData([a.certificate], content);
    expect(openEnvelopedData(env, b.privateKey, b.certificate)).toBeUndefined();
  });

  it('supports multiple recipients, each recovering the same content', () => {
    const a = buildRsaSigner('Recipient A');
    const b = buildRsaSigner('Recipient B');
    const env = buildEnvelopedData([a.certificate, b.certificate], content);
    expect([...openEnvelopedData(env, a.privateKey, a.certificate)!]).toEqual([...content]);
    expect([...openEnvelopedData(env, b.privateKey, b.certificate)!]).toEqual([...content]);
  });

  it('round-trips with RSAES-OAEP (sha256) key transport', () => {
    const a = buildRsaSigner('OAEP Recipient');
    const env = buildEnvelopedData([a.certificate], content, { keyWrap: 'oaep', oaepHash: 'sha256' });
    // The envelope actually carries the OAEP keyEncryptionAlgorithm (not pkcs1):
    // ContentInfo -> [0] EnvelopedData -> recipientInfos SET -> ktri -> alg -> OID.
    const ed = parse(env).children[1].children[0];
    const ktri = ed.children[1].children[0];
    expect(readOid(ktri.children[2].children[0])).toBe(OID.rsaesOaep);
    const out = openEnvelopedData(env, a.privateKey, a.certificate);
    expect(out).not.toBeUndefined();
    expect([...out!]).toEqual([...content]);
  });

  it('round-trips for an EC (ECDH-ES) recipient — P-256', () => {
    const a = buildSigner({ type: 'ec', namedCurve: 'P-256' });
    const env = buildEnvelopedData([a.certificate], content);
    const out = openEnvelopedData(env, a.privateKey, a.certificate);
    expect(out).not.toBeUndefined();
    expect([...out!]).toEqual([...content]);
  });

  it('round-trips for an EC recipient — P-384', () => {
    const a = buildSigner({ type: 'ec', namedCurve: 'P-384' });
    const env = buildEnvelopedData([a.certificate], content);
    expect([...openEnvelopedData(env, a.privateKey, a.certificate)!]).toEqual([...content]);
  });

  it('mixes RSA and EC recipients in one envelope', () => {
    const rsa = buildRsaSigner('RSA One');
    const ec = buildSigner({ type: 'ec', namedCurve: 'P-256' });
    const env = buildEnvelopedData([rsa.certificate, ec.certificate], content);
    expect([...openEnvelopedData(env, rsa.privateKey, rsa.certificate)!]).toEqual([...content]);
    expect([...openEnvelopedData(env, ec.privateKey, ec.certificate)!]).toEqual([...content]);
  });

  it('returns undefined for a non-matching EC recipient', () => {
    const a = buildSigner({ type: 'ec', namedCurve: 'P-256', commonName: 'EC A' });
    const b = buildSigner({ type: 'ec', namedCurve: 'P-256', commonName: 'EC Stranger' });
    const env = buildEnvelopedData([a.certificate], content);
    expect(openEnvelopedData(env, b.privateKey, b.certificate)).toBeUndefined();
  });
});
