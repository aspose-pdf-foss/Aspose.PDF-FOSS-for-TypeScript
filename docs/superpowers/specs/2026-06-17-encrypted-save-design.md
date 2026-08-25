# Encrypted Save — Design Spec (Phase 2a)

Date: 2026-06-17

## Context

The library decrypts on open (RC4, AESV2, AESV3 via the standard security
handler in `crypto.ts`) but always writes **unencrypted** output — the #1 entry
in the README Limitations. This spec adds **encrypted Save**: producing PDFs
protected with the standard security handler, round-trippable through the
existing `buildDecryptor`.

This is **Phase 2a** of the content/secure-output roadmap
(`docs/superpowers/specs/2026-06-17-content-authoring-design.md`). It is
self-contained — it depends only on `crypto.ts` (already shipped) and the
serializer, not on the Phase 1 drawing layer.

## Goals

- `Save({ encrypt })` / `WriteTo(name, { encrypt })` produce a PDF encrypted with
  the standard security handler.
- Support all three ciphers the read side already understands: **AES-256**
  (V5/R6, AESV3, default), **AES-128** (V4/R4, AESV2), **RC4** (V2/R3).
- Named **permission flags** → the `/P` bitfield; an **owner password** can
  restrict permissions while the **user password** still opens the file.
- Work for **both** classic-xref and compressed (`{ compressed: true }`) output.
- Every file we write must re-open through the existing `buildDecryptor` — this
  is the primary correctness criterion (round-trip tests).
- Zero new runtime dependencies (only `node:crypto`, already used).

## Non-goals

- Public-key (`PubSec`) encryption — standard handler only.
- SASLprep / Unicode password normalization for R6 (matches the read side's
  documented limitation; passwords are UTF-8 encoded as-is).
- Re-encrypting in place / incremental update — `Save` always rewrites the whole
  document, as today.
- Changing the default: omitting `encrypt` yields the exact plaintext output of
  today (regression-protected).

## Public API

`SaveOptions` (today `= SerializeOptions`) gains an `encrypt` field.
`EncryptOptions`/`Permissions` are defined in `encrypt.ts` and imported by
`serializer.ts`, so the dependency flows one way (`serializer → encrypt →
crypto/types`) with no cycle:

```ts
// serializer.ts
export interface SerializeOptions {
  compressed?: boolean;
  encrypt?: EncryptOptions;   // imported from ./encrypt.js
}

// encrypt.ts
export interface EncryptOptions {
  /** Password required to open. Default '' (no open prompt). */
  userPassword?: string;
  /** Password granting full rights. Default: same as userPassword. */
  ownerPassword?: string;
  /** Cipher/handler revision. Default 'aes256'. */
  algorithm?: 'aes256' | 'aes128' | 'rc4';
  /** Allowed operations; each flag defaults to true (all allowed). */
  permissions?: Permissions;
  /** Encrypt the document Metadata stream too. Default true. */
  encryptMetadata?: boolean;
}

export interface Permissions {
  printing?: boolean;             // /P bit 3
  modifying?: boolean;            // /P bit 4
  copying?: boolean;              // /P bit 5 (extract text/graphics)
  annotating?: boolean;          // /P bit 6
  fillingForms?: boolean;        // /P bit 9
  accessibility?: boolean;       // /P bit 10 (extract for accessibility)
  assembling?: boolean;          // /P bit 11
  highQualityPrinting?: boolean; // /P bit 12
}
```

Re-exported from `index.ts` (`EncryptOptions`, `Permissions`). `SaveOptions`
already flows through `Document.Save`/`WriteTo` unchanged.

Validation: an `algorithm` other than the three names throws `TypeError`. Empty
passwords are valid. No other option can be invalid (all have defaults).

## Module layout

### `crypto.ts` — add write-side ciphers (co-located with the read-side ones)

```ts
/** AES-CBC encrypt: random 16-byte IV prepended, PKCS#7 padding. Key length
 *  (16 or 32) selects AES-128 vs AES-256. Inverse of aesCbcDecrypt. */
export function aesCbcEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array;

/** AES-CBC encrypt with explicit IV and NO padding (for /UE, /OE; 32-byte in). */
export function aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array;

/** AES-256-ECB encrypt, no padding, no IV (for the 16-byte /Perms block). */
export function aes256EcbEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array;

/** Cryptographically random bytes (node:crypto randomBytes). */
export function randomBytes(n: number): Uint8Array;
```

These reuse `createCipheriv`/`randomBytes` from `node:crypto`. `aesCbcEncrypt`
produces output that `aesCbcDecrypt` (existing) reverses: `iv ++ ciphertext`.

### `encrypt.ts` (new) — orchestration

Defines `EncryptOptions`/`Permissions` (shown above) plus:

```ts
import { PdfDict, PdfObject } from './types.js';

export interface Encryptor {
  /** The /Encrypt dict to write verbatim. Its own strings (/O,/U,/UE,/OE,/Perms)
   *  are final and must NOT be re-encrypted. */
  readonly encryptDict: PdfDict;
  /** Encrypt every string and (for streams) the raw payload inside `obj`, in
   *  place, keyed by the object's number/generation. Used for classic output and
   *  for direct (stream) objects in compressed output. */
  encryptObject(obj: PdfObject, num: number, gen: number): void;
  /** Encrypt a standalone stream payload (e.g. the /ObjStm) by object number. */
  encryptStreamRaw(raw: Uint8Array, num: number, gen: number): Uint8Array;
}

/** Build an Encryptor from options and the document's first /ID element. */
export function buildEncryptor(opts: EncryptOptions, id0: Uint8Array): Encryptor;
```

`encryptObject` recurses dict/array/stream exactly like `decryptObject` in
`crypto.ts` (strings → cipher; stream → encrypt `.raw`, recurse dict). It mutates
in place; callers only ever pass it the **remapped copies** the serializer
produces, so the live object model is never touched.

## Key derivation

All algorithm/step numbers refer to ISO 32000-1 §7.6. Existing helpers in
`crypto.ts` are reused where noted.

### Permission integer `/P`

`/P` is a signed 32-bit value. Reserved bits 7–8 and 13–32 are always 1; bits
1–2 are always 0; bits 3–6 and 9–12 follow the flags:

```
base = 0xFFFFF0C0                       // bits 7,8 and 13..32 set
| printing(0x04) | modifying(0x08) | copying(0x10) | annotating(0x20)
| fillingForms(0x100) | accessibility(0x200) | assembling(0x400)
| highQualityPrinting(0x800)
P = base | 0                            // coerce to signed int32
```

A flag set to `false` clears its bit; default (undefined) leaves it set.

### RC4 (V2/R3) and AES-128 (V4/R4)

- `length` = 128 bits (`n = 16`).
- **Algorithm 3 (`/O`):** pad the owner password (or the user password when
  `ownerPassword` is omitted) → MD5 → (R≥3) 50× MD5 of the first `n` bytes →
  RC4 key. RC4-encrypt the padded user password; then (R≥3) 19 rounds where round
  `i` (1..19) uses the key XOR-ed with `i`. `/O` = 32-byte result.
- **Algorithm 2 (file key):** `fileKeyR234(userPw, O, P, id0, R, 128, encryptMetadata)`
  (existing helper).
- **Algorithm 4/5 (`/U`):** R3 path — `MD5(PASSWORD_PADDING ++ id0)`, RC4 with the
  file key, 19 XOR rounds; `/U` = the 16-byte result padded to 32 with arbitrary
  bytes (16 random bytes; the read side only checks the first 16).
- **Per-object content:** `objectKeyV4(fileKey, num, gen, isAes)` (existing) →
  `rc4(key, data)` for RC4, `aesCbcEncrypt(key, data)` for AES-128.
- `/Encrypt` for AES-128 adds the crypt-filter dict (below).

### AES-256 (V5/R6)

- Generate a random 32-byte **file key** (the content key).
- **Algorithm 8 (`/U`,`/UE`):** random validation salt (8) + key salt (8).
  `U = hash2B(userPw, valSalt, ∅) ++ valSalt ++ keySalt` (48 bytes).
  `UE = aesCbcEncryptNoPad(hash2B(userPw, keySalt, ∅), zeros16, fileKey)`.
- **Algorithm 9 (`/O`,`/OE`):** random salts; `udata = U[0..48]`.
  `O = hash2B(ownerPw, valSalt, udata) ++ valSalt ++ keySalt`.
  `OE = aesCbcEncryptNoPad(hash2B(ownerPw, keySalt, udata), zeros16, fileKey)`.
- **Algorithm 13 (`/Perms`):** 16-byte block: `P` as 4 LE bytes, `0xFF`×4,
  `'T'`/`'F'` for `encryptMetadata`, `'a','d','b'`, 4 random bytes; then
  `aes256EcbEncrypt(fileKey, block)`.
- **Per-object content:** `aesCbcEncrypt(fileKey, data)` — file key used directly,
  no per-object derivation.

`hash2B`, `padPassword`, `PASSWORD_PADDING`, `fileKeyR234`, `objectKeyV4`, `rc4`
already exist in `crypto.ts`.

## `/Encrypt` dictionary

| Key | RC4 (R3) | AES-128 (R4) | AES-256 (R6) |
|---|---|---|---|
| `/Filter` | `/Standard` | `/Standard` | `/Standard` |
| `/V` `/R` | 2 / 3 | 4 / 4 | 5 / 6 |
| `/Length` | 128 | 128 | 256 |
| `/P` | signed int | signed int | signed int |
| `/O` `/U` | 32-byte | 32-byte | 48-byte |
| `/UE` `/OE` | — | — | 32-byte |
| `/Perms` | — | — | 16-byte |
| `/CF` | — | `<< /StdCF << /CFM /AESV2 /Length 16 /AuthEvent /DocOpen >> >>` | same with `/CFM /AESV3 /Length 32` |
| `/StmF` `/StrF` | — | `/StdCF` | `/StdCF` |
| `/EncryptMetadata` | (omit; default true) unless false | same | same |

Binary values are PDF string objects (`{ kind: 'string', bytes }`);
`serializeString` already escapes binary correctly.

## Serializer integration

`serializeDocument(objects, trailer, options)` branches on `options.encrypt`:

1. **Plan** as today (`planDocument` → `plan.objs` remapped to 1..N).
2. **Determine `/ID`:** `id0` = existing `trailer.ID[0]` bytes if present, else
   `randomBytes(16)`; `id1` = existing `trailer.ID[1]` bytes if present, else
   `randomBytes(16)`. `/ID` must be fixed before key derivation (R≤4 depends on
   `id0`).
3. **Build** the `Encryptor` from `options.encrypt` and `id0`.
4. **Encrypt + lay out**, differing by mode:

**Classic (`serializeClassicEncrypted`):**
- For each `plan.objs[i]`, `encryptObject(objs[i], i+1, 0)` (strings + stream raw).
- Serialize objects 1..N as today.
- Append the `/Encrypt` dict as object **N+1** (not encrypted).
- Trailer adds `/Encrypt N+1 0 R`, `/ID [<id0><id1>]`, and `/Size N+2`.

**Compressed (`serializeCompressedEncrypted`):**
- **Direct (stream) objects** (`isStream`): `encryptObject(obj, newNum, 0)` —
  encrypts dict strings + the stream raw with the object's own number.
- **Packed (non-stream) objects:** left **plaintext**; their strings are
  protected by the encryption of the `/ObjStm` as a whole (per spec, objects in
  an object stream are not individually encrypted).
- Build the `/ObjStm` payload from the plaintext packed objects, deflate, then
  `raw = encryptStreamRaw(deflated, objStmNum, 0)`.
- The **XRef stream is never encrypted**.
- The `/Encrypt` dict is a **direct object** (object number after the XRef/ObjStm
  block) — never packed, never encrypted. It is referenced from the XRef-stream
  dict via `/Encrypt`, alongside `/ID`.
- Object numbering: today `objStmNum=N+1`, `xrefStmNum=N+2`. Add
  `encryptNum=N+3`; bump `/Size` to `N+4`; add a type-1 xref row for the
  `/Encrypt` object.

In both modes the encryption runs on the **remapped copies** in `plan.objs`, so
`objects`/`trailer` are never mutated (preserving today's guarantee).

## Error handling

- `algorithm` not in `{aes256, aes128, rc4}` → `TypeError`.
- No new failure modes for valid input; `node:crypto` errors propagate as-is
  (should not occur for well-formed inputs).
- Public error types unchanged; encryption never throws `PdfParseError`.

## Testing (TDD)

Round-trip is the core strategy: write, then re-open with the existing reader.

- **Cipher × mode matrix** — for each of `{aes256, aes128, rc4}` × `{classic,
  compressed}`: encrypt a fixture (reuse `test/helpers` builders), then
  `Document.Open(bytes, { password: userPassword })` and assert page count,
  `GetText()`, and metadata match the source.
- **Owner password** opens the file too; **wrong password** → `InvalidPasswordError`.
- **Permissions** — set a subset to false; re-open and assert the resolved
  `/Encrypt /P` has exactly the expected bits; verify default (omitted
  `permissions`) grants all.
- **`encryptMetadata: false`** — the `/Metadata` stream is readable without the
  key (not encrypted); `/EncryptMetadata false` present in `/Encrypt`.
- **AES-256 `/Perms`** — present and 16 bytes; decrypts (AES-256-ECB with file
  key) to a block whose bytes 9–11 are `adb`.
- **No-encrypt regression** — `Save()` and `Save({ compressed: true })` without
  `encrypt` produce byte-for-byte the same output as today (existing tests stay
  green; add an explicit "output has no /Encrypt" assertion).
- **Low-level units** — `aesCbcEncrypt`→`aesCbcDecrypt` round-trips random data;
  `aesCbcEncryptNoPad`/`aes256EcbEncrypt` match `node:crypto` references.

Fixtures: a new `test/helpers` builder is unnecessary — reuse existing builders
(e.g. `build-text-pdf`, `build-stamp-target`) as plaintext inputs and assert on
the re-opened result.

## Files

- New: `src/encrypt.ts` (`EncryptOptions`/`Permissions`/`Encryptor` types +
  `buildEncryptor`), `test/encrypt-save.test.ts`.
- Changed: `src/crypto.ts` (write-side ciphers + `randomBytes`),
  `src/serializer.ts` (import `EncryptOptions` from `encrypt.ts`; add
  `SerializeOptions.encrypt`; `encrypt` branch; `serializeClassicEncrypted` /
  `serializeCompressedEncrypted`), `src/index.ts` (export `EncryptOptions` /
  `Permissions` from `encrypt.ts`), `README.md` (Encrypted output: Features,
  usage, API table; remove the "No encrypted output" limitation).
  `src/document.ts` needs no change — `SaveOptions = SerializeOptions` already
  carries the new field.
