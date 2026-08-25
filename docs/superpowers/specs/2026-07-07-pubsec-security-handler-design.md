# Public-key (PubSec) security handler — design

**Issue:** aspose-pdf-foss-for-ts-5av
**Date:** 2026-07-07
**Status:** approved (brainstorming)

## Goal

Support certificate-based (public-key / "PubSec") PDF encryption alongside the
existing password-based standard handler:

- **Open** decrypts a PubSec-protected file given a recipient's key + certificate.
- **Save** produces a PubSec-encrypted file openable by the listed recipients'
  certificates.
- Access permissions carried in the file are surfaced to the caller.

Acceptance (from the issue): Open decrypts a PubSec-protected file given a
recipient key; `Save({ encrypt: { recipients } })` produces a file openable by
those certs; permissions honored; vitest; README + Limitations updated.

## Scope (locked decisions)

- **Crypto profiles:** full parity with the standard handler — RC4, AES-128,
  AES-256.
- **Recipient key input (Open):** both a PKCS#12 bundle and a pre-loaded
  `KeyObject` + certificate.
- **Encrypt API:** a distinct `PubSecEncryptOptions` type (discriminated by a
  `recipients` field), separate from the password-based `EncryptOptions`.
- **Permissions:** a single shared permission set for the whole recipient list
  (one seed / one file key). Per-recipient permission groups are out of scope.

## Background: the PDF PubSec scheme

Reference: ISO 32000-1 §7.6.4 (public-key security handlers) and the Adobe
supplement. Key facts that shape the implementation:

- The `/Encrypt` dict has **no top-level `/O`, `/U`, or `/P`**. Permissions are
  carried *inside* the encrypted seed, not in the dict.
- A random **20-byte seed** plus the **4-byte permission integer** (24 bytes
  total) is the plaintext that gets enveloped to the recipients via CMS
  (PKCS#7) `EnvelopedData`.
- All recipients in one `/Recipients` array share the **same seed**, so they all
  derive the **same file key**.
- The **file key** is derived by hashing the seed concatenated with every
  `/Recipients` byte string (and a trailing `0xFFFFFFFF` when metadata is not
  encrypted). The per-object key derivation and stream/string ciphers are then
  **identical to the standard handler**.

### `/Encrypt` dictionary produced

```
<<
  /Filter /Adobe.PubSec
  /SubFilter /adbe.pkcs7.s4        % V4 (RC4, AES-128);  s5 for V5 (AES-256)
  /V 4                             % 4 for RC4/AES-128, 5 for AES-256
  /R 4                             % 4 for V4, 6 for V5
  /Length 128                      % 128 for RC4/AES-128, 256 for AES-256
  /CF << /DefaultCryptFilter <<
      /CFM /AESV2                  % /V2 (RC4) | /AESV2 | /AESV3
      /Recipients [ <…DER EnvelopedData…> ]
      /EncryptMetadata true       % omitted-as-true; present-false when disabled
  >> >>
  /StmF /DefaultCryptFilter
  /StrF /DefaultCryptFilter
  /EncryptMetadata false          % top-level, only when disabled
>>
```

A single, uniform crypt-filter code path serves all three ciphers; RC4 rides the
V4 crypt-filter form with `/CFM /V2`. For V4 the `/Recipients` array lives in the
crypt-filter dict (not top-level).

### Key derivation (encrypt and decrypt must agree)

```
plaintext   = seed(20 bytes) ‖ P(4 bytes, big-endian)        // 24 bytes
CEK         = random 16 bytes (AES-128)
envelope    = CMS EnvelopedData:
                encryptedContent   = AES-128-CBC(CEK, plaintext)   // IV prepended in the AlgId params
                per recipient:     encryptedKey = RSA-PKCS1v1.5(recipientPubKey, CEK)
Recipients  = [ envelope ]                                    // one byte string

H           = SHA-1  for V4  (RC4 / AES-128)
              SHA-256 for V5 (AES-256)
digest      = H( seed ‖ concat(each byte string in /Recipients, in array order)
                 ‖ (0xFFFFFFFF when EncryptMetadata is false) )
fileKey     = digest[0 .. Length/8]        // 16 for AES-128, 5..16 for RC4, all 32 for AES-256

per-object cipher:
  V4 (RC4/AES-128): objectKeyV4(fileKey, num, gen, isAes) then RC4 / AES-CBC   // Algorithm 1
  V5 (AES-256):     fileKey used directly, AES-256-CBC                          // no per-object salt
```

`P` uses the same bit layout as the standard handler (`permissionsToP`).

### CMS `EnvelopedData` structure

```
ContentInfo ::= SEQUENCE {
  contentType  OID = id-envelopedData (1.2.840.113549.1.7.3)
  content [0] EXPLICIT EnvelopedData }

EnvelopedData ::= SEQUENCE {
  version                INTEGER (0)
  recipientInfos         SET OF RecipientInfo            -- one per recipient cert
  encryptedContentInfo   EncryptedContentInfo }

RecipientInfo (KeyTransRecipientInfo) ::= SEQUENCE {
  version                INTEGER (0)
  rid                    IssuerAndSerialNumber
  keyEncryptionAlgorithm AlgorithmIdentifier (rsaEncryption, NULL)
  encryptedKey           OCTET STRING                    -- RSA-PKCS1v1.5(CEK) }

EncryptedContentInfo ::= SEQUENCE {
  contentType                 OID = id-data
  contentEncryptionAlgorithm  AlgorithmIdentifier (aes128-CBC, IV)
  encryptedContent [0] IMPLICIT OCTET STRING             -- AES-128-CBC(CEK, 24-byte plaintext) }
```

Decrypt: for each byte string in `/Recipients`, parse the `EnvelopedData`; for
each `RecipientInfo`, match `rid` (issuer + serial) against the caller's
certificate; on a match, RSA-decrypt `encryptedKey` → CEK, then AES-decrypt
`encryptedContent` → 24-byte plaintext → seed + P. If no recipient matches,
throw `InvalidPasswordError`.

## Module layout

Mirrors the existing password-handler split (`crypto.ts` read / `encrypt.ts`
write, `cms.ts` for CMS).

### `cms.ts` (extend)

Add the CMS `EnvelopedData` encode/decode, siblings to `buildSignedData`:

- `buildEnvelopedData(recipientCerts: Uint8Array[], content: Uint8Array): Uint8Array`
  — one `EnvelopedData` ContentInfo with a `KeyTransRecipientInfo` per cert
  (shared random CEK, AES-128-CBC content encryption, RSA-PKCS1v1.5 key wrap).
- `openEnvelopedData(envelope: Uint8Array, privateKey: KeyObject, certDer: Uint8Array): Uint8Array | undefined`
  — recover the content when one of the recipients matches `certDer`
  (issuer/serial), else `undefined`.

Reuses `der`, `parse`, `readOid`, `OID`, `issuerAndSerial`/`certIssuerSerial`
(the last two already private in `cms.ts`; reuse in place). New OIDs added to
`asn1.ts` `OID`: `envelopedData`, `aes128CBC` (the `data` OID already exists).

RSA wrap/unwrap: `node:crypto` `publicEncrypt` / `privateDecrypt` with
`padding: RSA_PKCS1_PADDING`.

### `pubsec.ts` (new)

The PDF-level PubSec handler. No CMS or ASN.1 details leak here — it calls into
`cms.ts` for the envelope and `crypto.ts` for the per-object ciphers.

- `buildPubSecEncryptor(opts: PubSecEncryptOptions): Encryptor` — mirrors
  `buildEncryptor`. Generates the seed, builds the envelope via
  `buildEnvelopedData`, derives the file key, assembles the `/Encrypt` dict, and
  returns an `Encryptor` via the shared `makeEncryptor` helper.
- `buildPubSecDecryptor(encrypt: PdfDict, recipient: NormalizedRecipient, resolve): { decryptor: Decryptor; permissions: Permissions }`
  — mirrors the standard branch of `buildDecryptor`: reads `/CF`/`/Recipients`,
  opens an envelope, recovers seed + P, derives the file key, returns a
  `Decryptor` plus the decoded permissions.

Reuses from `crypto.ts`: `sha256`, `objectKeyV4`, `rc4`, `aesCbcDecrypt`; from
`encrypt.ts`: `makeEncryptor`, `permissionsToP`, and a new `permissionsFromP`.
SHA-1 for V4 derivation is added to `crypto.ts` (`sha1`) next to `sha256`.

### `encrypt.ts` (extend)

- Export `makeEncryptor` and `permissionsToP` (currently module-private /
  exported-as-needed).
- Add `permissionsFromP(P: number): Permissions` — inverse of `permissionsToP`.
- Add and export `PubSecEncryptOptions`:

```ts
export interface PubSecRecipientCert {
  /** Recipient certificate, DER (Uint8Array) or PEM (string). */
  certificate: string | Uint8Array;
}
export interface PubSecEncryptOptions {
  recipients: PubSecRecipientCert[];
  algorithm?: 'aes256' | 'aes128' | 'rc4';   // default 'aes256'
  permissions?: Permissions;                  // shared across all recipients
  encryptMetadata?: boolean;                  // default true
}
```

### `crypto.ts` (extend)

- Add `sha1`.
- `buildDecryptor` is unchanged: it still throws `UnsupportedFeatureError` for a
  non-`Standard` `/Filter`. PubSec is routed separately from `Document.Open`
  (see below), keeping the password path free of recipient-key concerns.

## Public API wiring

### Open (`document.ts`)

`OpenOptions` gains an optional `recipient`:

```ts
export type PubSecRecipient =
  | { pkcs12: Uint8Array; passphrase?: string }
  | { privateKey: KeyObject; certificate: string | Uint8Array };

export interface OpenOptions {
  password?: string;
  recipient?: PubSecRecipient;
}
```

`Open` flow change: after resolving the `/Encrypt` dict, branch on `/Filter`:

- `Standard` → existing `buildDecryptor` path (unchanged).
- `Adobe.PubSec` → require `opts.recipient`; normalize it to
  `{ privateKey, certificate: DER }` (a `pkcs12` bundle is decoded via the
  existing `parsePkcs12`, choosing its leaf cert + key); call
  `buildPubSecDecryptor`. Missing recipient or no matching `RecipientInfo` →
  `InvalidPasswordError`.
- other → `UnsupportedFeatureError` (as today).

The recovered permissions are stored on the `Document`.

### Permissions accessor (`document.ts`)

`Document` gains a read-only `Permissions` getter returning `Permissions |
undefined`:

- PubSec: decoded from the seed's 4-byte P via `permissionsFromP`.
- Standard handler: decoded from the `/Encrypt` `/P` (small addition, keeps the
  accessor meaningful for both handlers).
- Unencrypted: `undefined`.

Enforcement of permissions remains the caller's responsibility; the library
surfaces them.

### Save (`serializer.ts`)

`SerializeOptions.encrypt` widens to `EncryptOptions | PubSecEncryptOptions`.
The encryptor selection branches on the shape:

```ts
const encryptor = 'recipients' in options.encrypt
  ? buildPubSecEncryptor(options.encrypt)
  : buildEncryptor(options.encrypt, id0);
```

`serializeClassicEncrypted` and `serializeCompressedEncrypted` are unchanged —
they already operate on an `Encryptor`. PubSec ignores `id0` (no `/ID`-based key
derivation). The existing guards stand: encrypted linearization and encrypted
sign-on-save remain unsupported.

### `index.ts`

Export `PubSecEncryptOptions`, `PubSecRecipientCert`, and `PubSecRecipient`.

## Testing

Fixtures reuse `test/helpers/build-signer.ts` (`buildRsaSigner` / `issueCert`
mint an RSA keypair + self-signed X.509 cert with the library's own DER encoder)
and `test/helpers/build-pkcs12.ts` for the pkcs12 input path.

`test/cms.test.ts` (extend): `EnvelopedData` round-trip — `buildEnvelopedData`
then `openEnvelopedData` recovers the content; a non-matching cert returns
`undefined`; two recipients each recover the same content.

`test/pubsec.test.ts` (new):

- Round-trip per algorithm (`rc4`, `aes128`, `aes256`): encrypt a small doc,
  reopen with the recipient key, assert content/strings decrypt correctly.
- Multi-recipient (2 certs): each recipient opens the same file.
- Wrong recipient (unrelated key) → `InvalidPasswordError`.
- Both input methods: `{ pkcs12 }` and `{ privateKey, certificate }` both open.
- Permissions round-trip: set non-default permissions, reopen, assert
  `doc.Permissions` matches.
- `encryptMetadata: false` round-trips and sets the dict flags.
- Compressed output (`Save({ compressed: true, encrypt: { recipients } })`)
  round-trips.

**Correctness cross-check** (encrypt+decrypt agreeing does not prove
spec-conformance):

- A unit test asserting the exact documented key-derivation bytes for a fixed
  seed + fixed `/Recipients` (SHA-1 and SHA-256 vectors), so an internal
  spec-order mistake is caught.
- If `qpdf` (or `openssl`-driven tooling) is available on `PATH`, a golden test
  that decrypts an externally produced PubSec file; skipped when the tool is
  absent (no new runtime/test dependency).

## Documentation

- `README.md`: add PubSec to Features and a Quick-start snippet (encrypt to a
  cert; open with a recipient key). Document the `recipient` open option and the
  `PubSecEncryptOptions` shape.
- `README.md` Limitations: single shared permission set (no per-recipient
  groups); RSA key-transport recipients only (no EC/ECDH `KeyAgreeRecipientInfo`).

## Follow-up issues (out of scope)

- Per-recipient permission groups (multiple seeds / envelopes).
- `KeyAgreeRecipientInfo` (ECDH) recipients.
- RSAES-OAEP key wrap (Adobe uses PKCS#1 v1.5).

## Non-goals

- No change to the standard password handler's behavior.
- No permission *enforcement* — permissions are surfaced, not policed.
```
