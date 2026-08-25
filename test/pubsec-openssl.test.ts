// Golden: decrypt CMS EnvelopedData produced by the openssl CLI, using keys and
// certificates openssl also generated — bytes and credentials we did not produce,
// so our reader is validated against a fully foreign producer. Gated on the
// openssl CLI. See test/pkcs12.test.ts for the same availability pattern.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { openEnvelopedData } from '../src/cms.js';

function hasOpenssl(): boolean {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const ossl = (args: string[]) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'ignore'] });

/** A recipient key + self-signed cert generated entirely by openssl. */
function opensslRecipient(dir: string, name: string, kind: 'rsa' | 'ec'): { keyPath: string; certPath: string } {
  const keyPath = join(dir, `${name}.key`), certPath = join(dir, `${name}.crt`);
  if (kind === 'rsa') {
    ossl(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '365', '-nodes', '-subj', `/CN=${name}`]);
  } else {
    ossl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
    ossl(['req', '-x509', '-key', keyPath, '-out', certPath, '-days', '365', '-nodes', '-subj', `/CN=${name}`]);
  }
  return { keyPath, certPath };
}

/** openssl cms -encrypt to a recipient cert; returns the DER EnvelopedData. */
function opensslEncrypt(dir: string, name: string, certPath: string, content: Uint8Array, extra: string[]): Uint8Array {
  const inp = join(dir, `${name}.bin`), out = join(dir, `${name}.der`);
  writeFileSync(inp, Buffer.from(content));
  ossl(['cms', '-encrypt', '-binary', '-outform', 'DER',
    '-in', inp, '-out', out, '-aes-128-cbc', '-recip', certPath, ...extra]);
  return new Uint8Array(readFileSync(out));
}

describe.runIf(hasOpenssl())('PubSec — decrypt openssl-produced envelopes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pubsec-'));
  const content = new Uint8Array(24).map((_, i) => i + 1);

  it('decrypts an openssl RSAES-OAEP KeyTrans envelope', () => {
    const { keyPath, certPath } = opensslRecipient(dir, 'rsa', 'rsa');
    const env = opensslEncrypt(dir, 'rsa', certPath, content, ['-keyopt', 'rsa_padding_mode:oaep']);
    const key = createPrivateKey(readFileSync(keyPath));
    const certDer = new Uint8Array(new X509Certificate(readFileSync(certPath)).raw);
    expect([...openEnvelopedData(env, key, certDer)!]).toEqual([...content]);
  });

  it('decrypts an openssl ECDH-ES KeyAgree envelope', () => {
    const { keyPath, certPath } = opensslRecipient(dir, 'ec', 'ec');
    const env = opensslEncrypt(dir, 'ec', certPath, content, []);
    const key = createPrivateKey(readFileSync(keyPath));
    const certDer = new Uint8Array(new X509Certificate(readFileSync(certPath)).raw);
    expect([...openEnvelopedData(env, key, certDer)!]).toEqual([...content]);
  });
});
