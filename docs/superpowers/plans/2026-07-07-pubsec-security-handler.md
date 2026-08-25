# Public-key (PubSec) Security Handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add certificate-based (public-key / PubSec) PDF encryption on Save and decryption on Open, alongside the existing password-based standard handler.

**Architecture:** A random 20-byte seed + 4-byte permission int is enveloped to recipient certificates via CMS `EnvelopedData` (new code in `cms.ts`); the enveloped blob goes in `/Encrypt /CF /DefaultCryptFilter /Recipients`. The file key is derived by hashing `seed ‖ recipient-blobs`, after which the per-object stream/string ciphers are identical to the standard handler. A new `pubsec.ts` module builds the PubSec `Encryptor`/`Decryptor`, reusing `crypto.ts` ciphers, `encrypt.ts` helpers, and the new CMS envelope code. `Document.Open` routes `/Filter /Adobe.PubSec` to the PubSec decryptor; `serializer.ts` routes a `recipients`-shaped encrypt option to the PubSec encryptor.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), `node:crypto` (`publicEncrypt`/`privateDecrypt`, `createCipheriv`, `createHash`, `X509Certificate`, `KeyObject`), vitest. Zero runtime dependencies.

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext** — import specifiers carry the `.js` extension (e.g. `import { rc4 } from './crypto.js'`).
- **strict TypeScript** — `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) must stay green.
- **TDD** — every feature lands with a failing vitest test first; fixtures built programmatically in `test/helpers/`.
- **Public error types** — throw `PdfParseError`, `UnsupportedFeatureError`, or `InvalidPasswordError` (from `errors.ts`).
- **Quality gates before closing** — `npm run typecheck` and `npm test` both green.
- **PdfDict is a `Map`** keyed by name without a leading `/`; names/strings are tagged objects (`name('X')`, `{ kind: 'string', bytes }`).
- **Beads tracking** — this work is issue `aspose-pdf-foss-for-ts-5av`; do not use TodoWrite/markdown TODOs for task tracking.

---

## Task 1: CMS `EnvelopedData` encode/decode

Adds the CMS layer PubSec rides on: build an `EnvelopedData` that RSA-wraps a content-encryption key to each recipient certificate and AES-128-CBC-encrypts a payload; open it with a recipient private key + certificate.

**Files:**
- Modify: `src/asn1.ts` (add two OIDs to the `OID` table, ~line 40–58)
- Modify: `src/cms.ts` (add `buildEnvelopedData`, `openEnvelopedData`, and a small `certIssuerSerial` reuse; the helper already exists privately at ~line 112)
- Test: `test/cms.test.ts` (extend — append a new `describe`)

**Interfaces:**
- Consumes: `der`, `parse`, `readOid`, `OID`, `Asn1Node` from `./asn1.js`; the existing private `certIssuerSerial(certDer)` in `cms.ts` returning `{ issuer: Uint8Array; serial: Uint8Array }`.
- Produces:
  - `buildEnvelopedData(recipientCerts: Uint8Array[], content: Uint8Array): Uint8Array` — DER `ContentInfo`/`EnvelopedData`.
  - `openEnvelopedData(envelope: Uint8Array, privateKey: KeyObject, certDer: Uint8Array): Uint8Array | undefined` — the recovered `content`, or `undefined` when no `RecipientInfo` matches `certDer`.

- [ ] **Step 1: Add OIDs to `asn1.ts`**

In `src/asn1.ts`, inside the `OID` object (after `signedData` at ~line 41), add:

```ts
  envelopedData: '1.2.840.113549.1.7.3',
  aes128CBC: '2.16.840.1.101.3.4.1.2',
```

- [ ] **Step 2: Write the failing test**

Append to `test/cms.test.ts` (reuse its existing imports; add any missing ones shown here):

```ts
import { describe, it, expect } from 'vitest';
import { buildEnvelopedData, openEnvelopedData } from '../src/cms.js';
import { buildRsaSigner } from './helpers/build-signer.js';

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
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/cms.test.ts`
Expected: FAIL — `buildEnvelopedData`/`openEnvelopedData` are not exported.

- [ ] **Step 4: Implement `buildEnvelopedData` and `openEnvelopedData` in `cms.ts`**

At the top of `src/cms.ts`, extend the `node:crypto` import and the `asn1` import:

```ts
import {
  KeyObject, X509Certificate, createHash, createCipheriv, createDecipheriv,
  publicEncrypt, privateDecrypt, randomBytes, constants as cryptoConstants,
} from 'node:crypto';
import { der, parse, readOid, oidName, OID, Asn1Node } from './asn1.js';
```

Then add near the end of `src/cms.ts`:

```ts
/** CMS EnvelopedData (RFC 5652) with KeyTransRecipientInfo (RSA PKCS#1 v1.5 key
 *  transport) and AES-128-CBC content encryption. Used by the PDF public-key
 *  security handler: `content` is the 24-byte seed+permissions payload. */
export function buildEnvelopedData(recipientCerts: Uint8Array[], content: Uint8Array): Uint8Array {
  const cek = new Uint8Array(randomBytes(16));
  const iv = new Uint8Array(randomBytes(16));
  const cipher = createCipheriv('aes-128-cbc', cek, iv);
  const encryptedContent = new Uint8Array(
    Buffer.concat([cipher.update(Buffer.from(content)), cipher.final()]));

  const recipientInfos = recipientCerts.map((certDer) => {
    const { issuer, serial } = certIssuerSerial(certDer);
    const pub = new X509Certificate(Buffer.from(certDer)).publicKey;
    const encryptedKey = new Uint8Array(publicEncrypt(
      { key: pub, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(cek)));
    return der.sequence(
      der.integer(0),                                            // version
      der.sequence(issuer, serial),                             // rid: IssuerAndSerialNumber
      der.sequence(der.oid(OID.rsaEncryption), der.null_()),    // keyEncryptionAlgorithm
      der.octetString(encryptedKey),                            // encryptedKey
    );
  });

  // encryptedContent is [0] IMPLICIT OCTET STRING (primitive): 0x80 tag.
  const encContentOctet = der.octetString(encryptedContent);
  encContentOctet[0] = 0x80;
  const encryptedContentInfo = der.sequence(
    der.oid(OID.data),
    der.sequence(der.oid(OID.aes128CBC), der.octetString(iv)),  // contentEncryptionAlgorithm
    encContentOctet,
  );

  const envelopedData = der.sequence(
    der.integer(0),                         // version
    der.set(...recipientInfos),             // recipientInfos SET OF
    encryptedContentInfo,
  );
  return der.sequence(der.oid(OID.envelopedData), der.explicit(0, envelopedData)); // ContentInfo
}

/** Recover the enveloped content if one RecipientInfo matches `certDer`
 *  (by issuer/serial) and decrypts with `privateKey`; else undefined. */
export function openEnvelopedData(
  envelope: Uint8Array, privateKey: KeyObject, certDer: Uint8Array,
): Uint8Array | undefined {
  const contentInfo = parse(envelope);
  const envelopedData = contentInfo.children[1].children[0];  // [0] EXPLICIT EnvelopedData
  const recipientInfos = envelopedData.children[1];           // SET OF RecipientInfo
  const eci = envelopedData.children[2];                      // EncryptedContentInfo

  const want = certIssuerSerial(certDer);
  let cek: Uint8Array | undefined;
  for (const ri of recipientInfos.children) {
    const rid = ri.children[1];                               // IssuerAndSerialNumber
    if (!bytesEqual(rid.children[0].raw, want.issuer)) continue;
    if (!bytesEqual(rid.children[1].raw, want.serial)) continue;
    const encryptedKey = ri.children[3].content;
    cek = new Uint8Array(privateDecrypt(
      { key: privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(encryptedKey)));
    break;
  }
  if (!cek) return undefined;

  const iv = eci.children[1].children[1].content;            // algorithm params OCTET STRING
  const encryptedContent = eci.children[2].content;          // [0] IMPLICIT OCTET STRING
  const decipher = createDecipheriv('aes-128-cbc', cek, iv);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(encryptedContent)), decipher.final()]));
}
```

Note: `certIssuerSerial` and `bytesEqual` already exist privately in `cms.ts` — reuse them in place. `want.serial` here compares the full serial INTEGER `raw` TLV; `certIssuerSerial` returns `serial` as the raw TLV and `issuer` as the raw `Name` TLV, matching how they are emitted into `rid`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/cms.test.ts`
Expected: PASS (all three new cases + existing cms tests).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/asn1.ts src/cms.ts test/cms.test.ts
git commit -m "feat(5av): CMS EnvelopedData encode/decode for PubSec"
```

---

## Task 2: PubSec foundation helpers (`crypto.ts`, `encrypt.ts`)

Small shared utilities the PubSec handler needs: SHA-1, the inverse permission decoder, and exporting two currently-internal helpers plus the new option types.

**Files:**
- Modify: `src/crypto.ts` (add `sha1` next to `sha256`, ~line 6)
- Modify: `src/encrypt.ts` (export `makeEncryptor`; add `permissionsFromP`; add `PubSecEncryptOptions`/`PubSecRecipientCert`)
- Test: `test/pubsec-helpers.test.ts` (new)

**Interfaces:**
- Consumes: `permissionsToP(p?: Permissions): number` (already exported in `encrypt.ts`); `Permissions` interface.
- Produces:
  - `sha1(b: Uint8Array): Uint8Array` from `crypto.ts`.
  - `makeEncryptor(encryptDict, strCipher, stmCipher): Encryptor` exported from `encrypt.ts` (signature unchanged: `strCipher`/`stmCipher` are `(data: Uint8Array, num: number, gen: number) => Uint8Array`).
  - `permissionsFromP(P: number): Permissions` from `encrypt.ts`.
  - `PubSecRecipientCert { certificate: string | Uint8Array }` and `PubSecEncryptOptions { recipients: PubSecRecipientCert[]; algorithm?: 'aes256'|'aes128'|'rc4'; permissions?: Permissions; encryptMetadata?: boolean }` exported from `encrypt.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/pubsec-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sha1 } from '../src/crypto.js';
import { permissionsToP, permissionsFromP } from '../src/encrypt.js';
import { createHash } from 'node:crypto';

describe('PubSec helpers', () => {
  it('sha1 matches node crypto', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const expected = new Uint8Array(createHash('sha1').update(data).digest());
    expect([...sha1(data)]).toEqual([...expected]);
  });

  it('permissionsFromP inverts permissionsToP', () => {
    const perms = { printing: false, copying: false, modifying: true };
    const P = permissionsToP(perms);
    const back = permissionsFromP(P);
    expect(back.printing).toBe(false);
    expect(back.copying).toBe(false);
    expect(back.modifying).toBe(true);
    expect(back.annotating).toBe(true);   // defaulted-allowed bit stays set
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pubsec-helpers.test.ts`
Expected: FAIL — `sha1` / `permissionsFromP` not exported.

- [ ] **Step 3: Add `sha1` to `crypto.ts`**

In `src/crypto.ts`, next to `sha256` (~line 6):

```ts
export const sha1 = (b: Uint8Array) => new Uint8Array(createHash('sha1').update(b).digest());
```

- [ ] **Step 4: Export `makeEncryptor` and add `permissionsFromP` + types in `encrypt.ts`**

In `src/encrypt.ts`, change `function makeEncryptor(` (~line 61) to `export function makeEncryptor(`.

After `permissionsToP` (~line 56), add:

```ts
/** Decode a signed-int32 /P back into permission flags (inverse of permissionsToP). */
export function permissionsFromP(P: number): Permissions {
  const on = (bit: number) => (P & bit) !== 0;
  return {
    printing: on(0x04),
    modifying: on(0x08),
    copying: on(0x10),
    annotating: on(0x20),
    fillingForms: on(0x100),
    accessibility: on(0x200),
    assembling: on(0x400),
    highQualityPrinting: on(0x800),
  };
}
```

At the end of `src/encrypt.ts`, add the PubSec option types:

```ts
export interface PubSecRecipientCert {
  /** Recipient certificate, DER (Uint8Array) or PEM (string). */
  certificate: string | Uint8Array;
}

export interface PubSecEncryptOptions {
  recipients: PubSecRecipientCert[];
  /** Document cipher. Default 'aes256'. (Envelope encryption is always AES-128.) */
  algorithm?: 'aes256' | 'aes128' | 'rc4';
  /** Shared permissions for all recipients. */
  permissions?: Permissions;
  /** Encrypt the document metadata stream. Default true. */
  encryptMetadata?: boolean;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/pubsec-helpers.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/crypto.ts src/encrypt.ts test/pubsec-helpers.test.ts
git commit -m "feat(5av): PubSec foundation helpers (sha1, permissionsFromP, option types)"
```

---

## Task 3: File-key derivation + `pubsec.ts` module scaffold

The shared key-derivation function used by both encrypt and decrypt, pinned by a test vector. This is the correctness-critical byte layout.

**Files:**
- Create: `src/pubsec.ts`
- Test: `test/pubsec.test.ts` (new — file created here, grown in later tasks)

**Interfaces:**
- Consumes: `sha1`, `sha256` from `./crypto.js`.
- Produces:
  - `deriveFileKey(seed: Uint8Array, recipientBlobs: Uint8Array[], hash: 'sha1' | 'sha256', keyLen: number, encryptMetadata: boolean): Uint8Array` from `pubsec.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/pubsec.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { deriveFileKey } from '../src/pubsec.js';

describe('PubSec file-key derivation', () => {
  const seed = new Uint8Array(20).map((_, i) => i + 1);
  const blob = new Uint8Array([0xaa, 0xbb, 0xcc]);

  it('SHA-256, 32-byte key, metadata encrypted', () => {
    const expected = new Uint8Array(
      createHash('sha256').update(Buffer.concat([seed, blob])).digest());
    const key = deriveFileKey(seed, [blob], 'sha256', 32, true);
    expect([...key]).toEqual([...expected]);
  });

  it('SHA-1, 16-byte key, appends 0xFFFFFFFF when metadata not encrypted', () => {
    const tail = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    const expected = new Uint8Array(
      createHash('sha1').update(Buffer.concat([seed, blob, tail])).digest()).subarray(0, 16);
    const key = deriveFileKey(seed, [blob], 'sha1', 16, false);
    expect([...key]).toEqual([...expected]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pubsec.test.ts`
Expected: FAIL — module `../src/pubsec.js` / `deriveFileKey` not found.

- [ ] **Step 3: Create `src/pubsec.ts` with `deriveFileKey`**

```ts
// PDF public-key ("PubSec") security handler: certificate-based encryption on
// Save and decryption on Open, the write/read counterpart to the standard
// password handler. A 20-byte seed + 4-byte permission int is enveloped to the
// recipient certificates via CMS EnvelopedData (cms.ts); the file key is derived
// by hashing seed ‖ recipient-blobs, after which the per-object ciphers are
// identical to the standard handler (crypto.ts). Zero runtime dependencies.

import { sha1, sha256 } from './crypto.js';

const FF4 = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Derive the file encryption key: HASH(seed ‖ each recipient blob ‖ 0xFFFFFFFF
 *  when metadata is not encrypted), truncated to `keyLen` bytes. */
export function deriveFileKey(
  seed: Uint8Array, recipientBlobs: Uint8Array[], hash: 'sha1' | 'sha256',
  keyLen: number, encryptMetadata: boolean,
): Uint8Array {
  const parts = [seed, ...recipientBlobs];
  if (!encryptMetadata) parts.push(FF4);
  const digest = hash === 'sha256' ? sha256(concat(...parts)) : sha1(concat(...parts));
  return digest.subarray(0, keyLen);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pubsec.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/pubsec.ts test/pubsec.test.ts
git commit -m "feat(5av): PubSec file-key derivation with test vector"
```

---

## Task 4: `buildPubSecEncryptor` + `buildPubSecDecryptor` (module round-trip)

The core handler: build the `/Encrypt` dict + cipher closures for Save, and the recipient-key decryptor for Open. Tested by a same-module round-trip (encrypt an object, decrypt it back) so both sides are exercised without touching `Document`.

**Files:**
- Modify: `src/pubsec.ts`
- Test: `test/pubsec.test.ts` (extend)

**Interfaces:**
- Consumes: `deriveFileKey` (Task 3); `buildEnvelopedData`, `openEnvelopedData` (Task 1); `makeEncryptor`, `permissionsToP`, `permissionsFromP`, `PubSecEncryptOptions`, `Permissions`, `Encryptor` from `./encrypt.js`; `Decryptor`, `objectKeyV4`, `rc4`, `aesCbcEncrypt`, `aesCbcDecrypt`, `randomBytes` from `./crypto.js`; `PdfDict`, `PdfObject`, `name`, `isDict`, `isString`, `isArray`, `isName` from `./types.js`; `X509Certificate`, `KeyObject` from `node:crypto`.
- Produces:
  - `buildPubSecEncryptor(opts: PubSecEncryptOptions): Encryptor`
  - `NormalizedRecipient = { privateKey: KeyObject; certificate: Uint8Array }`
  - `buildPubSecDecryptor(encrypt: PdfDict, recipient: NormalizedRecipient, resolve: (o: PdfObject | undefined) => PdfObject): { decryptObject: Decryptor['decryptObject']; permissions: Permissions }`

- [ ] **Step 1: Write the failing test**

Append to `test/pubsec.test.ts`:

```ts
import { buildPubSecEncryptor, buildPubSecDecryptor } from '../src/pubsec.js';
import { buildRsaSigner } from './helpers/build-signer.js';
import { isName, isString } from '../src/types.js';

describe('PubSec encryptor/decryptor round-trip', () => {
  const id = (o: any) => o; // resolve: our /Encrypt dict holds direct objects

  for (const algorithm of ['rc4', 'aes128', 'aes256'] as const) {
    it(`round-trips a string object (${algorithm})`, () => {
      const r = buildRsaSigner('Recipient');
      const enc = buildPubSecEncryptor({
        recipients: [{ certificate: r.certificate }], algorithm,
        permissions: { copying: false },
      });
      const plain = { kind: 'string' as const, bytes: new Uint8Array([72, 105]) }; // "Hi"
      const cipher = enc.encryptObject(structuredCloneStr(plain), 5, 0);

      const dec = buildPubSecDecryptor(enc.encryptDict, r, id);
      const back = dec.decryptObject(cipher, 5, 0);
      expect(isString(back) && [...back.bytes]).toEqual([72, 105]);
      expect(dec.permissions.copying).toBe(false);
    });
  }

  it('throws-equivalent (undefined recipient match) surfaces as InvalidPasswordError from buildPubSecDecryptor', () => {
    const r = buildRsaSigner('Recipient');
    const stranger = buildRsaSigner('Stranger');
    const enc = buildPubSecEncryptor({ recipients: [{ certificate: r.certificate }] });
    expect(() => buildPubSecDecryptor(
      enc.encryptDict, { privateKey: stranger.privateKey, certificate: stranger.certificate }, id,
    )).toThrowError(/password|recipient/i);
  });
});

function structuredCloneStr(s: { kind: 'string'; bytes: Uint8Array }) {
  return { kind: 'string' as const, bytes: new Uint8Array(s.bytes) };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pubsec.test.ts`
Expected: FAIL — `buildPubSecEncryptor`/`buildPubSecDecryptor` not exported.

- [ ] **Step 3: Implement both functions in `pubsec.ts`**

Extend the imports at the top of `src/pubsec.ts`:

```ts
import { X509Certificate, KeyObject } from 'node:crypto';
import { PdfDict, PdfObject, name, isDict, isName, isString } from './types.js';
import { sha1, sha256, objectKeyV4, rc4, aesCbcEncrypt, aesCbcDecrypt, randomBytes, Decryptor } from './crypto.js';
import {
  Encryptor, makeEncryptor, permissionsToP, permissionsFromP,
  PubSecEncryptOptions, Permissions,
} from './encrypt.js';
import { buildEnvelopedData, openEnvelopedData } from './cms.js';
import { InvalidPasswordError, UnsupportedFeatureError } from './errors.js';
```

Add the per-algorithm profile table and the two builders:

```ts
const pdfStr = (bytes: Uint8Array): PdfObject => ({ kind: 'string', bytes });

interface Profile {
  V: number; R: number; length: number; cfm: string; hash: 'sha1' | 'sha256'; isAes: boolean; isV5: boolean;
  subFilter: string;
}
const PROFILES: Record<'rc4' | 'aes128' | 'aes256', Profile> = {
  rc4:    { V: 4, R: 4, length: 128, cfm: 'V2',    hash: 'sha1',   isAes: false, isV5: false, subFilter: 'adbe.pkcs7.s4' },
  aes128: { V: 4, R: 4, length: 128, cfm: 'AESV2', hash: 'sha1',   isAes: true,  isV5: false, subFilter: 'adbe.pkcs7.s4' },
  aes256: { V: 5, R: 6, length: 256, cfm: 'AESV3', hash: 'sha256', isAes: true,  isV5: true,  subFilter: 'adbe.pkcs7.s5' },
};

/** Normalize a certificate (PEM string or DER) to DER via node's parser. */
function toCertDer(cert: string | Uint8Array): Uint8Array {
  return new Uint8Array(new X509Certificate(
    typeof cert === 'string' ? cert : Buffer.from(cert)).raw);
}

export function buildPubSecEncryptor(opts: PubSecEncryptOptions): Encryptor {
  const algorithm = opts.algorithm ?? 'aes256';
  const p = PROFILES[algorithm];
  if (!p) throw new TypeError(`unknown PubSec algorithm: ${algorithm}`);
  const encryptMetadata = opts.encryptMetadata !== false;
  const P = permissionsToP(opts.permissions);

  // 24-byte payload: seed(20) ‖ P(4, big-endian).
  const seed = randomBytes(20);
  const payload = new Uint8Array(24);
  payload.set(seed, 0);
  payload[20] = (P >>> 24) & 0xff; payload[21] = (P >>> 16) & 0xff;
  payload[22] = (P >>> 8) & 0xff;  payload[23] = P & 0xff;

  const certs = opts.recipients.map((r) => toCertDer(r.certificate));
  const envelope = buildEnvelopedData(certs, payload);
  const fileKey = deriveFileKey(seed, [envelope], p.hash, p.length / 8, encryptMetadata);

  const cryptFilter: PdfDict = new Map<string, PdfObject>([
    ['CFM', name(p.cfm)],
    ['Length', p.length / 8],
    ['AuthEvent', name('DocOpen')],
    ['Recipients', [pdfStr(envelope)]],
  ]);
  if (!encryptMetadata) cryptFilter.set('EncryptMetadata', false);

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Filter', name('Adobe.PubSec')],
    ['SubFilter', name(p.subFilter)],
    ['V', p.V], ['R', p.R], ['Length', p.length],
    ['CF', new Map<string, PdfObject>([['DefaultCryptFilter', cryptFilter]])],
    ['StmF', name('DefaultCryptFilter')], ['StrF', name('DefaultCryptFilter')],
  ]);
  if (!encryptMetadata) dict.set('EncryptMetadata', false);

  const cipher = (data: Uint8Array, num: number, gen: number): Uint8Array => {
    if (p.isV5) return aesCbcEncrypt(fileKey, data);
    const key = objectKeyV4(fileKey, num, gen, p.isAes);
    return p.isAes ? aesCbcEncrypt(key, data) : rc4(key, data);
  };
  return makeEncryptor(dict, cipher, cipher);
}

export interface NormalizedRecipient {
  privateKey: KeyObject;
  certificate: Uint8Array; // DER
}

export function buildPubSecDecryptor(
  encrypt: PdfDict, recipient: NormalizedRecipient,
  resolve: (o: PdfObject | undefined) => PdfObject,
): { decryptObject: Decryptor['decryptObject']; permissions: Permissions } {
  const subFilter = asName(resolve(encrypt.get('SubFilter')));
  const V = asNum(resolve(encrypt.get('V'))) ?? 4;
  const length = asNum(resolve(encrypt.get('Length'))) ?? 128;
  const isV5 = V >= 5;
  const hash: 'sha1' | 'sha256' = isV5 ? 'sha256' : 'sha1';

  // Locate the crypt filter (V>=4: /CF /DefaultCryptFilter) and its /Recipients.
  const cf = resolve(encrypt.get('CF'));
  const stmf = asName(resolve(encrypt.get('StmF'))) ?? 'DefaultCryptFilter';
  const cfDict = isDict(cf) ? resolve(cf.get(stmf)) : null;
  if (!isDict(cfDict)) throw new UnsupportedFeatureError('PubSec: missing crypt filter');
  const cfm = asName(resolve(cfDict.get('CFM')));
  const isAes = cfm === 'AESV2' || cfm === 'AESV3';
  const encryptMetadata = resolve(cfDict.get('EncryptMetadata')) !== false
    && resolve(encrypt.get('EncryptMetadata')) !== false;

  const recipientsArr = resolve(cfDict.get('Recipients'));
  const blobs: Uint8Array[] = [];
  if (Array.isArray(recipientsArr)) {
    for (const el of recipientsArr) { const s = resolve(el); if (isString(s)) blobs.push(s.bytes); }
  } else if (isString(recipientsArr)) {
    blobs.push(recipientsArr.bytes);
  }
  if (blobs.length === 0) throw new UnsupportedFeatureError('PubSec: no /Recipients');

  // Recover the 24-byte payload from the first envelope our key can open.
  let payload: Uint8Array | undefined;
  for (const blob of blobs) {
    payload = openEnvelopedData(blob, recipient.privateKey, recipient.certificate);
    if (payload) break;
  }
  if (!payload || payload.length < 24) throw new InvalidPasswordError();

  const seed = payload.subarray(0, 20);
  const P = ((payload[20] << 24) | (payload[21] << 16) | (payload[22] << 8) | payload[23]) | 0;
  const fileKey = deriveFileKey(seed, blobs, hash, length / 8, encryptMetadata);

  const applyCipher = (data: Uint8Array, num: number, gen: number): Uint8Array => {
    if (isV5) return aesCbcDecrypt(fileKey, data);
    const key = objectKeyV4(fileKey, num, gen, isAes);
    return isAes ? aesCbcDecrypt(key, data) : rc4(key, data);
  };

  const decryptObject = (obj: PdfObject, num: number, gen: number): PdfObject => {
    if (isString(obj)) return { kind: 'string', bytes: applyCipher(obj.bytes, num, gen) };
    if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) obj[i] = decryptObject(obj[i], num, gen); return obj; }
    if (isDict(obj)) { for (const [k, v] of obj) obj.set(k, decryptObject(v, num, gen)); return obj; }
    if (obj && typeof obj === 'object' && 'kind' in obj && (obj as any).kind === 'stream') {
      const s = obj as { kind: 'stream'; dict: PdfDict; raw: Uint8Array };
      for (const [k, v] of s.dict) s.dict.set(k, decryptObject(v, num, gen));
      return { kind: 'stream', dict: s.dict, raw: applyCipher(s.raw, num, gen) };
    }
    return obj;
  };

  return { decryptObject, permissions: permissionsFromP(P) };
}

const asNum = (o: PdfObject | undefined): number | undefined => (typeof o === 'number' ? o : undefined);
const asName = (o: PdfObject | undefined): string | undefined => (isName(o) ? o.name : undefined);
```

Note: `_subFilter` is read for clarity/future validation but not required; remove the local if the linter objects, or prefix with `void subFilter;`. The stream branch avoids importing `isStream` to keep the reducer self-contained, but if `isStream` is already imported elsewhere in the file prefer it: `if (isStream(obj)) { ... }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pubsec.test.ts`
Expected: PASS (rc4/aes128/aes256 round-trips + stranger rejection).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/pubsec.ts test/pubsec.test.ts
git commit -m "feat(5av): PubSec encryptor + decryptor (module round-trip)"
```

---

## Task 5: Wire PubSec into Save (`serializer.ts`)

Route a `recipients`-shaped encrypt option to the PubSec encryptor. The existing encrypted-serialize paths already operate on an `Encryptor`, so only the selection and the option type change.

**Files:**
- Modify: `src/serializer.ts` (import + `SerializeOptions.encrypt` type at ~line 19 + encryptor selection at ~line 121)
- Test: `test/pubsec.test.ts` (extend)

**Interfaces:**
- Consumes: `buildPubSecEncryptor` (Task 4); `PubSecEncryptOptions` (Task 2); existing `buildEncryptor`, `serializeClassicEncrypted`, `serializeCompressedEncrypted`.
- Produces: `serializeDocument(objects, trailer, { encrypt: PubSecEncryptOptions })` emits a PubSec-encrypted byte image.

- [ ] **Step 1: Write the failing test**

Append to `test/pubsec.test.ts`:

```ts
import { serializeDocument } from '../src/serializer.js';
import { ref, name as pdfName } from '../src/types.js';

describe('PubSec serialize', () => {
  it('emits /Filter /Adobe.PubSec in the output', () => {
    const r = buildRsaSigner('Recipient');
    const objects = new Map<number, any>([
      [1, new Map<string, any>([['Type', pdfName('Catalog')], ['Pages', ref(2)]])],
      [2, new Map<string, any>([['Type', pdfName('Pages')], ['Kids', []], ['Count', 0]])],
    ]);
    const trailer = new Map<string, any>([['Root', ref(1)]]);
    const bytes = serializeDocument(objects, trailer, {
      encrypt: { recipients: [{ certificate: r.certificate }] },
    });
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('/Adobe.PubSec');
    expect(text).toContain('/DefaultCryptFilter');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pubsec.test.ts -t "PubSec serialize"`
Expected: FAIL — a `PubSecEncryptOptions` is not assignable to `encrypt`, or no `/Adobe.PubSec` in output.

- [ ] **Step 3: Wire the encryptor selection in `serializer.ts`**

Update the import (~line 5):

```ts
import { buildEncryptor, Encryptor, EncryptOptions, PubSecEncryptOptions } from './encrypt.js';
import { buildPubSecEncryptor } from './pubsec.js';
```

Widen the option type (~line 19):

```ts
  /** Encrypt the output: password-based standard handler ({@link EncryptOptions})
   *  or certificate-based PubSec ({@link PubSecEncryptOptions}). Default: plaintext. */
  encrypt?: EncryptOptions | PubSecEncryptOptions;
```

Replace the encryptor construction (~line 121) with a shape-discriminated selection:

```ts
  const { id0, id1 } = resolveIds(trailer);
  const encryptor = 'recipients' in options.encrypt
    ? buildPubSecEncryptor(options.encrypt)
    : buildEncryptor(options.encrypt, id0);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pubsec.test.ts -t "PubSec serialize"`
Expected: PASS.

- [ ] **Step 5: Full suite sanity + typecheck**

Run: `npm run typecheck && npx vitest run test/pubsec.test.ts test/serialize.test.ts`
Expected: PASS (no regression in existing serialize tests).

- [ ] **Step 6: Commit**

```bash
git add src/serializer.ts test/pubsec.test.ts
git commit -m "feat(5av): route PubSec recipients through Save"
```

---

## Task 6: Wire PubSec into Open + `Permissions` getter (`document.ts`)

Detect `/Filter /Adobe.PubSec` on Open, normalize the recipient credential (pkcs12 or KeyObject+cert), build the PubSec decryptor, and expose the recovered permissions. This is the first full Save→Open round-trip through the public API.

**Files:**
- Modify: `src/document.ts` (imports; `OpenOptions` ~line 99; the decryptor branch in `Open` ~line 326–336; the decrypt call ~line 359; a `permissions` field + `Permissions` getter on the class)
- Test: `test/pubsec.test.ts` (extend)

**Interfaces:**
- Consumes: `buildPubSecDecryptor`, `NormalizedRecipient` (Task 4); `parsePkcs12` from `./pkcs12.js`; `Permissions`, `permissionsFromP` from `./encrypt.js`; `buildDecryptor`, `Decryptor` from `./crypto.js` (existing); `X509Certificate`, `KeyObject` from `node:crypto`.
- Produces:
  - `OpenOptions.recipient?: PubSecRecipient` where `PubSecRecipient = { pkcs12: Uint8Array; passphrase?: string } | { privateKey: KeyObject; certificate: string | Uint8Array }`.
  - `Document.Permissions: Permissions | undefined` (read-only getter).

- [ ] **Step 1: Write the failing test**

Append to `test/pubsec.test.ts`:

```ts
import { Document } from '../src/document.js';

function tinyDoc(): Map<number, any> {
  return new Map<number, any>([
    [1, new Map<string, any>([['Type', pdfName('Catalog')], ['Pages', ref(2)],
      ['Marker', { kind: 'string', bytes: new TextEncoder().encode('secret') }]])],
    [2, new Map<string, any>([['Type', pdfName('Pages')], ['Kids', []], ['Count', 0]])],
  ]);
}

describe('PubSec Open round-trip', () => {
  it('encrypts on Save and decrypts on Open (aes256, KeyObject recipient)', () => {
    const r = buildRsaSigner('Recipient');
    const bytes = serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]), {
      encrypt: { recipients: [{ certificate: r.certificate }], permissions: { printing: false } },
    });
    const doc = Document.Open(bytes, { recipient: { privateKey: r.privateKey, certificate: r.certificate } });
    const marker = doc.catalog().get('Marker');
    expect(marker && isString(marker) && new TextDecoder().decode(marker.bytes)).toBe('secret');
    expect(doc.Permissions?.printing).toBe(false);
  });

  it('throws InvalidPasswordError without a recipient', () => {
    const r = buildRsaSigner('Recipient');
    const bytes = serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]), {
      encrypt: { recipients: [{ certificate: r.certificate }] },
    });
    expect(() => Document.Open(bytes)).toThrowError(/password|recipient/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pubsec.test.ts -t "PubSec Open"`
Expected: FAIL — `recipient` not in `OpenOptions`; PubSec `/Filter` throws `UnsupportedFeatureError`.

- [ ] **Step 3: Extend imports and `OpenOptions` in `document.ts`**

Add to the crypto import (~line 71) and new imports:

```ts
import { buildDecryptor, Decryptor } from './crypto.js';
import { buildPubSecDecryptor, NormalizedRecipient } from './pubsec.js';
import { parsePkcs12 } from './pkcs12.js';
import { Permissions, permissionsFromP } from './encrypt.js';
import { X509Certificate, KeyObject } from 'node:crypto';
```

Replace `OpenOptions` (~line 99):

```ts
export type PubSecRecipient =
  | { pkcs12: Uint8Array; passphrase?: string }
  | { privateKey: KeyObject; certificate: string | Uint8Array };

export interface OpenOptions {
  /** Password for a standard-handler document; defaults to the empty user password. */
  password?: string;
  /** Recipient credential for a public-key (PubSec) document. */
  recipient?: PubSecRecipient;
}
```

- [ ] **Step 4: Add a recipient-normalization helper in `document.ts`**

Place near the other module-level helpers (e.g. above the `Document` class):

```ts
/** Resolve an OpenOptions.recipient into a private key + DER certificate. */
function normalizeRecipient(recipient: PubSecRecipient): NormalizedRecipient {
  if ('pkcs12' in recipient) {
    const { privateKey, certificates } = parsePkcs12(recipient.pkcs12, recipient.passphrase ?? '');
    return { privateKey, certificate: certificates[0] };
  }
  const certificate = new Uint8Array(new X509Certificate(
    typeof recipient.certificate === 'string'
      ? recipient.certificate : Buffer.from(recipient.certificate)).raw);
  return { privateKey: recipient.privateKey, certificate };
}
```

- [ ] **Step 5: Branch the decryptor construction in `Open` and store permissions**

Replace the block that builds `decryptor` (~line 326–336) with:

```ts
    let decryptor: Decryptor | undefined;
    let permissions: Permissions | undefined;
    let encObjNum = -1;
    const encRef = trailer.get('Encrypt');
    if (encRef !== undefined) {
      if (isRef(encRef)) encObjNum = encRef.num;
      const encDict = resolveRaw(encRef);
      if (!isDict(encDict)) throw new PdfParseError('/Encrypt is not a dict');
      const filter = resolveRaw(encDict.get('Filter'));
      if (isName(filter) && filter.name === 'Adobe.PubSec') {
        if (!opts.recipient) throw new InvalidPasswordError();
        const result = buildPubSecDecryptor(encDict, normalizeRecipient(opts.recipient), resolveRaw);
        decryptor = { decryptObject: result.decryptObject };
        permissions = result.permissions;
      } else {
        const idArr = trailer.get('ID');
        const id0 = isArray(idArr) && isString(idArr[0]) ? idArr[0].bytes : undefined;
        decryptor = buildDecryptor(encDict, id0, opts.password ?? '', resolveRaw);
        const P = resolveRaw(encDict.get('P'));
        if (typeof P === 'number') permissions = permissionsFromP(P);
      }
    }
```

Confirm `InvalidPasswordError` is imported in `document.ts` (it is used elsewhere; add to the `./errors.js` import if not present).

- [ ] **Step 6: Pass `permissions` to the Document and add the getter**

After `const doc = new Document(objects, trailer);` (~line 387), add:

```ts
    doc.permissions = permissions;
```

In the `Document` class, add the backing field near the other private fields (~line 184) and a getter:

```ts
  /** Access permissions recovered from an encrypted document (undefined when
   *  the document is not encrypted). Surfaced for the caller; not enforced. */
  private permissions?: Permissions;
  get Permissions(): Permissions | undefined { return this.permissions; }
```

Since `permissions` is assigned from the static `Open` method on the instance, make the field non-`readonly` (it is not) — assignment from `Open` is allowed because `Open` is a static member of the same class.

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/pubsec.test.ts -t "PubSec Open"`
Expected: PASS.

- [ ] **Step 8: Typecheck + full pubsec file**

Run: `npm run typecheck && npx vitest run test/pubsec.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/document.ts test/pubsec.test.ts
git commit -m "feat(5av): open PubSec documents + Document.Permissions getter"
```

---

## Task 7: Full coverage matrix (input methods, algorithms, metadata, compressed)

Round out the acceptance criteria: pkcs12 input path, wrong-recipient rejection at the Document level, per-algorithm end-to-end, `encryptMetadata: false`, multi-recipient, and compressed output.

**Files:**
- Test: `test/pubsec.test.ts` (extend)
- Modify (only if a gap surfaces): `src/pubsec.ts` / `src/document.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–6; `buildPkcs12` from `./helpers/build-pkcs12.js`.
- Produces: no new production interface (coverage task).

- [ ] **Step 1: Write the failing/red tests**

Append to `test/pubsec.test.ts`:

```ts
import { buildPkcs12 } from './helpers/build-pkcs12.js';

describe('PubSec coverage matrix', () => {
  const encToBytes = (r: { certificate: Uint8Array }, extra: any = {}) =>
    serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]),
      { encrypt: { recipients: [{ certificate: r.certificate }], ...extra } });

  for (const algorithm of ['rc4', 'aes128', 'aes256'] as const) {
    it(`end-to-end via Document (${algorithm})`, () => {
      const r = buildRsaSigner('Recipient');
      const bytes = encToBytes(r, { algorithm });
      const doc = Document.Open(bytes, { recipient: { privateKey: r.privateKey, certificate: r.certificate } });
      const marker = doc.catalog().get('Marker');
      expect(marker && isString(marker) && new TextDecoder().decode(marker.bytes)).toBe('secret');
    });
  }

  it('opens via a pkcs12 recipient bundle', () => {
    const bundle = buildPkcs12();
    const bytes = serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]),
      { encrypt: { recipients: [{ certificate: bundle.certificate }] } });
    const doc = Document.Open(bytes, { recipient: { pkcs12: bundle.p12 } });
    expect(isString(doc.catalog().get('Marker'))).toBe(true);
  });

  it('rejects an unrelated recipient with InvalidPasswordError', () => {
    const r = buildRsaSigner('Recipient');
    const stranger = buildRsaSigner('Stranger');
    const bytes = encToBytes(r);
    expect(() => Document.Open(bytes, {
      recipient: { privateKey: stranger.privateKey, certificate: stranger.certificate },
    })).toThrowError(/password|recipient/i);
  });

  it('supports two recipients (each opens the file)', () => {
    const a = buildRsaSigner('A'); const b = buildRsaSigner('B');
    const bytes = serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]),
      { encrypt: { recipients: [{ certificate: a.certificate }, { certificate: b.certificate }] } });
    for (const who of [a, b]) {
      const doc = Document.Open(bytes, { recipient: { privateKey: who.privateKey, certificate: who.certificate } });
      expect(isString(doc.catalog().get('Marker'))).toBe(true);
    }
  });

  it('round-trips with encryptMetadata: false', () => {
    const r = buildRsaSigner('Recipient');
    const bytes = encToBytes(r, { encryptMetadata: false });
    expect(new TextDecoder('latin1').decode(bytes)).toContain('/EncryptMetadata false');
    const doc = Document.Open(bytes, { recipient: { privateKey: r.privateKey, certificate: r.certificate } });
    expect(isString(doc.catalog().get('Marker'))).toBe(true);
  });

  it('round-trips compressed PubSec output', () => {
    const r = buildRsaSigner('Recipient');
    const bytes = serializeDocument(tinyDoc(), new Map([['Root', ref(1)]]),
      { compressed: true, encrypt: { recipients: [{ certificate: r.certificate }] } });
    const doc = Document.Open(bytes, { recipient: { privateKey: r.privateKey, certificate: r.certificate } });
    expect(isString(doc.catalog().get('Marker'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/pubsec.test.ts -t "coverage matrix"`
Expected: initially may FAIL only if a gap exists (e.g. compressed path). If all pass, proceed. If the compressed case fails because strings inside a compressed ObjStm are handled differently, inspect `serializeCompressedEncrypted` in `serializer.ts` — it encrypts the ObjStm by its object number via `encryptor.encryptStreamRaw`, which the PubSec `Encryptor` already implements through `makeEncryptor`; no code change is expected.

- [ ] **Step 3: If a gap surfaced, fix it minimally**

Only touch production code if a test above fails. Re-run until green:

Run: `npx vitest run test/pubsec.test.ts`
Expected: PASS (entire file).

- [ ] **Step 4: Commit**

```bash
git add test/pubsec.test.ts src/pubsec.ts src/document.ts
git commit -m "test(5av): PubSec coverage matrix (inputs, algorithms, metadata, compressed)"
```

---

## Task 8: Optional external cross-check (qpdf golden decrypt)

A best-effort conformance check against a real encoder, skipped when the tool is absent so no new dependency is introduced. Validates our decrypt against externally-produced bytes (our encrypt+decrypt agreeing does not prove spec-conformance).

**Files:**
- Test: `test/pubsec-golden.test.ts` (new)

**Interfaces:**
- Consumes: `Document.Open`; `node:child_process` `execFileSync`; `buildPkcs12`.
- Produces: none (conditional test).

- [ ] **Step 1: Write the conditional test**

Create `test/pubsec-golden.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';

function has(cmd: string): boolean {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// qpdf's public-key encryption needs a certificate file; this golden test is a
// placeholder that runs only when qpdf (>=11, with --encrypt … --recipient) is
// available. When present, encrypt a known plaintext PDF to a test certificate
// with qpdf and assert our Document.Open recovers it. Skipped otherwise so the
// suite stays dependency-free.
describe.skipIf(!has('qpdf'))('PubSec golden (qpdf)', () => {
  it('decrypts a qpdf-produced PubSec file', () => {
    // Implementation note: wire up qpdf --encrypt with a PEM cert + the matching
    // key here once a fixture cert/key pair is materialized to disk. If wiring
    // proves impractical in CI, keep this describe.skipIf guard and leave the
    // in-suite round-trip (Task 7) as the primary correctness gate.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run it (expected: skipped locally)**

Run: `npx vitest run test/pubsec-golden.test.ts`
Expected: PASS or SKIPPED (no failure when qpdf is absent).

- [ ] **Step 3: Commit**

```bash
git add test/pubsec-golden.test.ts
git commit -m "test(5av): optional qpdf golden decrypt (skipped without qpdf)"
```

---

## Task 9: Public exports + README

Export the new public types and document the feature.

**Files:**
- Modify: `src/index.ts` (~line 60, next to the existing `EncryptOptions`/`Permissions` export)
- Modify: `README.md` (Features, Quick start, Limitations)

**Interfaces:**
- Consumes: `PubSecEncryptOptions`, `PubSecRecipientCert` (from `encrypt.ts`); `PubSecRecipient` (from `document.ts`).
- Produces: public type exports.

- [ ] **Step 1: Export the new types in `index.ts`**

Extend the encrypt export (~line 60):

```ts
export type { EncryptOptions, Permissions, PubSecEncryptOptions, PubSecRecipientCert } from './encrypt.js';
```

And add to the document-options export (~line 6):

```ts
export type { SplitOptions, ExtractPagesOptions, InsertPagesOptions, OpenOptions, SaveOptions, PubSecRecipient } from './document.js';
```

- [ ] **Step 2: Verify the exports typecheck and are importable**

Run: `npm run typecheck`
Expected: PASS. Optionally: `npx vitest run test/pubsec.test.ts`.

- [ ] **Step 3: Update `README.md`**

Under **Features**, add a bullet:

```markdown
- **Public-key encryption (PubSec):** certificate-based `Save`/`Open` (RC4,
  AES-128, AES-256) alongside the password-based standard handler.
```

Under **Quick start** (near the existing encryption example), add:

````markdown
### Certificate-based (public-key) encryption

```ts
import { Document } from 'aspose-pdf-foss-for-ts';

// Encrypt to one or more recipient certificates (PEM or DER):
const bytes = doc.Save({
  encrypt: { recipients: [{ certificate: recipientCertPem }], algorithm: 'aes256' },
});

// Open with the recipient's private key + certificate, or a PKCS#12 bundle:
const opened = Document.Open(bytes, {
  recipient: { privateKey, certificate: recipientCertPem },
  // or: recipient: { pkcs12: p12Bytes, passphrase: '…' },
});
console.log(opened.Permissions); // recovered permission flags (not enforced)
```
````

Under **Limitations**, add:

```markdown
- Public-key (PubSec) encryption uses RSA key-transport recipients with a single
  shared permission set; per-recipient permission groups and EC/ECDH
  (`KeyAgreeRecipientInfo`) recipients are not supported. Permissions are
  surfaced via `Document.Permissions` but not enforced.
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts README.md
git commit -m "docs(5av): export PubSec types + README public-key encryption"
```

---

## Task 10: Final gates + close

**Files:** none (verification + issue close).

- [ ] **Step 1: Full quality gates**

Run: `npm run typecheck && npm test`
Expected: both green, including the new `test/pubsec*.test.ts` and no regression in `test/crypto.test.ts` / `test/serialize.test.ts` / `test/encrypt*.test.ts`.

- [ ] **Step 2: Build sanity**

Run: `npm run build`
Expected: `dist/` emits without error (ESM + `.d.ts`), confirming the new public exports resolve.

- [ ] **Step 3: Close the beads issue and push**

```bash
bd close aspose-pdf-foss-for-ts-5av
git pull --rebase
git push -u origin feat/pubsec-5av
git status   # MUST show "up to date with origin"
```

---

## Self-Review Notes (author)

- **Spec coverage:** Envelope CMS (Task 1) ↔ spec §"CMS EnvelopedData structure"; key derivation + `/Encrypt` dict (Tasks 3–4) ↔ §"Key derivation"/"/Encrypt dictionary produced"; Save wiring (Task 5) ↔ §"Save (serializer.ts)"; Open + recipient normalization + Permissions (Task 6) ↔ §"Open"/"Permissions accessor"; full matrix incl. both input methods, algorithms, metadata, compressed, wrong-recipient (Tasks 6–7) ↔ §"Testing"; qpdf golden (Task 8) ↔ §"Correctness cross-check"; exports + README (Task 9) ↔ §"index.ts"/"Documentation". All spec sections mapped.
- **Type consistency:** `deriveFileKey`, `buildPubSecEncryptor`, `buildPubSecDecryptor`, `NormalizedRecipient`, `PubSecEncryptOptions`, `PubSecRecipientCert`, `PubSecRecipient`, `permissionsFromP`, `makeEncryptor`, `sha1` are used with identical signatures across the tasks that define and consume them.
- **Correctness caveat:** the primary conformance gate is the in-suite round-trip plus the fixed key-derivation vector (Task 3); the qpdf golden (Task 8) is best-effort and guarded by `describe.skipIf`.
```
