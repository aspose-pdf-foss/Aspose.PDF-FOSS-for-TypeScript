import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { parsePkcs12 } from '../src/pkcs12.js';
import { InvalidPasswordError } from '../src/errors.js';
import { buildPkcs12 } from './helpers/build-pkcs12.js';

/** Whether the `openssl` CLI is available for real-world fixture generation. */
function hasOpenssl(): boolean {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

/**
 * Whether openssl can load its legacy provider. The PBES1 (PKCS#12 KDF)
 * fixtures below are emitted with `-legacy`, which needs that provider —
 * OpenSSL 3.x does not activate it by default and some builds omit the module
 * altogether, so probe before generating or the command errors and the test
 * hard-fails instead of parsing anything.
 */
function hasOpensslLegacy(): boolean {
  try { execFileSync('openssl', ['list', '-providers', '-provider', 'legacy'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

/** Generate a real PKCS#12 with the openssl CLI (PBES1/PBES2 per flags). */
function opensslP12(dir: string, args: string[], pass: string): Uint8Array {
  const key = join(dir, 'k.pem'), cert = join(dir, 'c.pem'), out = join(dir, 'b.p12');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key,
    '-out', cert, '-days', '365', '-nodes', '-subj', '/CN=P12 Test'], { stdio: 'ignore' });
  execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert,
    '-out', out, '-passout', `pass:${pass}`, ...args], { stdio: 'ignore' });
  return new Uint8Array(readFileSync(out));
}

/** The extracted key+cert form a working pair: the key signs, the cert verifies. */
function keyMatchesCert(privateKey: any, certDer: Uint8Array): boolean {
  const cert = new X509Certificate(Buffer.from(certDer));
  const data = Buffer.from('round-trip probe');
  const sig = cryptoSign('sha256', data, privateKey);
  return cryptoVerify('sha256', data, cert.publicKey, sig);
}

describe('parsePkcs12 — node-built fixtures (PBES2 + AES, HMAC-SHA256 MAC)', () => {
  it('extracts the private key and certificate chain', () => {
    const { p12, certificate, privateKey } = buildPkcs12({ passphrase: 'secret' });
    const r = parsePkcs12(p12, 'secret');
    expect(r.certificates.length).toBe(1);
    expect(Buffer.from(r.certificates[0]).equals(Buffer.from(certificate))).toBe(true);
    expect(keyMatchesCert(r.privateKey, r.certificates[0])).toBe(true);
    // The extracted key is the same one used to build the fixture.
    expect(keyMatchesCert(privateKey, certificate)).toBe(true);
  });

  it('extracts an embedded intermediate certificate as part of the chain', () => {
    const { p12, certificate } = buildPkcs12({ passphrase: 'pw', extraCerts: 1 });
    const r = parsePkcs12(p12, 'pw');
    expect(r.certificates.length).toBe(2);
    // The leaf (the one matching the key) is identifiable and present.
    const hasLeaf = r.certificates.some((c) => Buffer.from(c).equals(Buffer.from(certificate)));
    expect(hasLeaf).toBe(true);
  });

  it('throws InvalidPasswordError on the wrong passphrase (MAC check)', () => {
    const { p12 } = buildPkcs12({ passphrase: 'right' });
    expect(() => parsePkcs12(p12, 'wrong')).toThrow(InvalidPasswordError);
  });

  it('parses an empty passphrase', () => {
    const { p12, certificate } = buildPkcs12({ passphrase: '' });
    const r = parsePkcs12(p12, '');
    expect(Buffer.from(r.certificates[0]).equals(Buffer.from(certificate))).toBe(true);
    expect(keyMatchesCert(r.privateKey, r.certificates[0])).toBe(true);
  });
});

describe.runIf(hasOpenssl())('parsePkcs12 — real openssl fixtures', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'p12-')); });

  it('parses the OpenSSL 3 default (PBES2 / PBKDF2-SHA256 / AES-256-CBC)', () => {
    const p12 = opensslP12(dir, [], 'secret');
    const r = parsePkcs12(p12, 'secret');
    expect(r.certificates.length).toBeGreaterThanOrEqual(1);
    expect(new X509Certificate(Buffer.from(r.certificates[0])).subject).toContain('P12 Test');
    expect(keyMatchesCert(r.privateKey, r.certificates[0])).toBe(true);
  });

  it.runIf(hasOpensslLegacy())('parses a legacy PBE-SHA1-3DES fixture (PKCS#12 KDF + PBES1)', () => {
    const p12 = opensslP12(dir,
      ['-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1', '-legacy'], 'secret');
    const r = parsePkcs12(p12, 'secret');
    expect(r.certificates.length).toBeGreaterThanOrEqual(1);
    expect(keyMatchesCert(r.privateKey, r.certificates[0])).toBe(true);
  });

  it('rejects the wrong passphrase on a real fixture', () => {
    const p12 = opensslP12(dir, [], 'secret');
    expect(() => parsePkcs12(p12, 'nope')).toThrow(InvalidPasswordError);
  });
});
