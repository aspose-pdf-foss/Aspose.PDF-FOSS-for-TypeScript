# PubSec envelope breadth — design

**Issue:** aspose-pdf-foss-for-ts-8kb (Feature 3; F1 EC/Ed signing and F2 image
appearance were found already implemented and verified — see the issue notes).

**Date:** 2026-07-22

## Problem

The PDF public-key security handler ("PubSec", `/Filter /Adobe.PubSec`) encrypts
a document to one or more recipient certificates. The current implementation
(`cms.ts` `buildEnvelopedData` / `openEnvelopedData`, driven by `pubsec.ts`) has
three gaps, all recorded in README "Limitations" (the PubSec bullet):

1. **Single shared permission set.** All recipients go into one CMS
   `EnvelopedData` carrying one `seed ‖ permissions` payload, so every recipient
   gets identical permissions. PDF (ISO 32000-1 §7.6.4) allows per-recipient
   permission groups: several `EnvelopedData` blobs in `/Recipients`, each with
   its own permission bytes, sharing one document seed.
2. **RSA PKCS#1 v1.5 key transport only.** No RSAES-OAEP option.
3. **RSA recipients only.** No EC recipient certificates
   (`KeyAgreeRecipientInfo` / ECDH-ES key agreement).

## Principle

Backward-compatible extension. The current single-envelope / single-permission /
RSA-PKCS1 path remains the default and must stay **byte-identical** when the new
options are unused. New behaviour is opt-in (per-recipient `permissions`,
`keyWrap: 'oaep'`) or auto-detected (EC recipient certificate → ECDH-ES).

## 1. API surface (`encrypt.ts`)

Extend the existing options rather than replacing them:

```ts
interface PubSecRecipientCert {
  certificate: string | Uint8Array;
  permissions?: Permissions;   // NEW: per-recipient; falls back to opts.permissions
}
interface PubSecEncryptOptions {
  recipients: PubSecRecipientCert[];
  permissions?: Permissions;   // default group for recipients without their own
  keyWrap?: 'pkcs1' | 'oaep';  // NEW: RSA key-transport padding, default 'pkcs1'
  oaepHash?: 'sha1' | 'sha256';// NEW: default 'sha256' when keyWrap:'oaep'
  algorithm?: 'aes256' | 'aes128' | 'rc4';
  encryptMetadata?: boolean;
}
```

- Recipients are **grouped by identical effective permissions** — one CMS
  envelope per distinct permission set. No per-recipient permissions ⇒ one group
  ⇒ output identical to today.
- **EC vs RSA is auto-detected** from each recipient certificate's public-key
  type; no flag. `keyWrap` / `oaepHash` apply to RSA recipients only (ECDH-ES
  ignores them).
- Grouping is by the resolved permission set (`recipient.permissions ??
  opts.permissions ?? default`). Group order is the order of first appearance in
  `recipients`, which fixes the `/Recipients` array order (load-bearing for the
  file-key hash — see §3).

## 2. Write path (`cms.ts`, `pubsec.ts`)

- **One shared 20-byte seed** for the whole document (§7.6.4.2), generated in
  `pubsec.ts` (`buildPubSecEncryptor`).
- Per permission group:
  - payload = `seed ‖ P_group` (24 bytes) — unchanged shape.
  - fresh 16-byte CEK + IV; AES-128-CBC content-encrypt the payload (unchanged).
  - one `EnvelopedData` whose `recipientInfos` (`SET OF` CHOICE) holds one entry
    per recipient in the group. RSA and EC recipients may coexist in one group.
- Per recipient:
  - **RSA → `KeyTransRecipientInfo`** (version 0): `rid` = issuerAndSerial;
    `keyEncryptionAlgorithm` = `rsaEncryption` + NULL (pkcs1) **or** `rsaesOaep`
    + OAEP params (oaep); `encryptedKey` = `publicEncrypt(pub, CEK)` with the
    matching padding. This is the current path for pkcs1.
  - **EC → `KeyAgreeRecipientInfo`** (version 3), **one per EC recipient** with
    its own ephemeral key (avoids curve-grouping). Fixed writer choice:
    `dhSinglePass-stdDH-sha256kdf-scheme` + `aes128-wrap` (16-byte KEK), matching
    the 16-byte AES-128 CEK; larger KDF hashes / wrap sizes are accepted on
    **read** (dispatched by the parsed OID) but not emitted.
    - ephemeral EC keypair on the recipient's curve;
      `Z = crypto.diffieHellman({ privateKey: ephem, publicKey: recipientPub })`.
    - `KEK = X9.63-KDF(Z, 16, ECC-CMS-SharedInfo)` with SHA-256 (§4).
    - `encryptedKey = AES-KeyWrap(KEK, CEK)` via `crypto.createCipheriv('aes128-wrap', KEK, defaultIV)`.
    - `originator [0]` = `originatorKey [1]` = the ephemeral public key. The
      node SPKI export (`SEQUENCE { algorithm, subjectPublicKey BIT STRING }`) is
      structurally identical to CMS `OriginatorPublicKey`, so it is reused
      directly (re-tagged `[1]`).
    - `keyEncryptionAlgorithm` = `dhSinglePass-stdDH-sha256kdf-scheme` whose
      parameter is the key-wrap `AlgorithmIdentifier` (`aesNNN-wrap`).
    - `recipientEncryptedKeys` = one `RecipientEncryptedKey { rid, encryptedKey }`.
- `/Recipients` = array of every group blob, in group order.
- **File key = HASH(seed ‖ concat(all group blobs) ‖ [0xFFFFFFFF when metadata
  not encrypted])**, truncated to key length. HASH is SHA-1 for V4, SHA-256 for
  V5/AESV3. This matches the existing reader, which already hashes every blob.

## 3. Read path (`cms.ts` `openEnvelopedData`, `pubsec.ts`)

`buildPubSecDecryptor` already: collects **every** `/Recipients` blob, tries each
until one opens with the caller's key, derives the file key from the opened
payload's seed + **all** blobs, and surfaces that payload's permission bytes. So
per-recipient permissions and the multi-blob file-key hash already work on read.

The only new work is inside `openEnvelopedData`, dispatched by the
`RecipientInfo` CHOICE tag:

- **`KeyTransRecipientInfo`** (universal `SEQUENCE`): read
  `keyEncryptionAlgorithm` OID. `rsaEncryption` → `privateDecrypt` PKCS#1 v1.5
  (current). `rsaesOaep` → parse OAEP params for the hash → `privateDecrypt` with
  `RSA_PKCS1_OAEP_PADDING` + `oaepHash`.
- **`KeyAgreeRecipientInfo`** (context `[1]`): parse `originator` ephemeral
  public key and `recipientEncryptedKeys`; find the `RecipientEncryptedKey` whose
  `rid` matches the caller's issuer/serial; `Z = diffieHellman(callerPriv,
  ephemPub)`; `KEK = X9.63-KDF(Z, wrapLen, sharedInfo)` (sharedInfo rebuilt from
  the parsed KDF/wrap algorithm); `CEK = AES-KeyUnwrap(KEK, encryptedKey)`.
- With the CEK recovered, the existing AES-128-CBC content decryption yields the
  `seed ‖ P` payload unchanged.

## 4. New primitives / OIDs

- **`cmskdf.ts`** (new, small, isolated): the X9.63 / ANSI-X9.63 concat KDF —
  `K = Hash(Z ‖ counter32-BE ‖ sharedInfo)` repeated (counter from 1) until
  `keyLen` bytes — and the `ECC-CMS-SharedInfo` builder (RFC 5753 §7.2):
  `SEQUENCE { keyInfo AlgorithmIdentifier, [0] entityUInfo OPTIONAL,
  [2] suppPubInfo }` where `suppPubInfo` = key length in **bits** as a 4-byte
  big-endian OCTET STRING and `keyInfo` = the key-wrap algorithm id. Kept out of
  `cms.ts` for isolation and independent testing.
- **`asn1.ts` OID additions:** `rsaesOaep` 1.2.840.113549.1.1.7, `mgf1`
  1.2.840.113549.1.1.8, `dhSinglePass-stdDH-sha{256,384,512}kdf-scheme`
  1.3.132.1.11.{1,2,3}, `aes{128,192,256}-wrap` 2.16.840.1.101.3.4.1.{5,25,45}.

## 5. Node primitives (verified available)

- `crypto.diffieHellman({ privateKey, publicKey })` → shared secret `Z`.
- `crypto.createCipheriv('aes{128,192,256}-wrap', KEK, iv)` / `createDecipheriv`
  for RFC 3394 AES Key Wrap (default IV `A6A6A6A6A6A6A6A6`).
- `crypto.publicEncrypt` / `privateDecrypt` with `RSA_PKCS1_OAEP_PADDING` +
  `oaepHash`.
- EC public-key SPKI export reused directly as `OriginatorPublicKey`.

## 6. Testing (TDD; hermetic builders in `test/helpers/`)

- **Unit (`cms.test.ts`)**: OAEP `KeyTransRecipientInfo` round-trip; ECDH-ES
  `KeyAgreeRecipientInfo` round-trip (P-256 and P-384); mixed RSA + EC recipients
  in one envelope both recover the same content; a non-recipient key returns
  `undefined`.
- **Integration (`pubsec.test.ts`)**: a document with two permission groups —
  each recipient opens it and recovers **its own** permissions and a working file
  key; an OAEP-wrapped document; an EC-recipient document. Reuse the
  `build-signer.ts` EC/RSA credential builders.
- **Golden (`pubsec-golden.test.ts`)**: where feasible, confirm our envelopes
  decrypt with the `openssl cms` CLI (bytes we did not produce), gated on CLI
  availability like the pkcs12 legacy fixture.
- **Load-bearing proof (repo convention)**: mutate to confirm assertions bite —
  e.g. swap a group's permission bytes and confirm the wrong-permissions
  assertion fails; corrupt the derived KEK and confirm the EC round-trip fails.

## Out of scope

- KDF schemes other than `dhSinglePass-stdDH-*kdf` (e.g. cofactor DH,
  `dhSinglePass-cofactorDH`).
- `RecipientKeyIdentifier` rid form (only `issuerAndSerialNumber` is emitted and
  matched, consistent with the current KeyTrans path).
- Password + certificate mixed recipient lists in one document.

## README

Update the PubSec "Limitations" bullet: per-recipient permission groups,
RSAES-OAEP key wrap, and EC (ECDH-ES) recipients are now supported. Keep noting
any residual gaps (the out-of-scope items above).
