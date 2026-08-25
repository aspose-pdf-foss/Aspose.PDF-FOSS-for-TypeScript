# Encryption support on Open (standard security handler) — Design

Issue: `aspose-pdf-foss-for-ts-u91`
Date: 2026-06-10

## Goal

`Document.Open` currently throws `UnsupportedFeatureError` when the trailer
carries `/Encrypt`. Implement the PDF **standard security handler** so encrypted
documents open transparently: strings and streams are decrypted on parse, the
in-memory object model holds plaintext, and `Save()` round-trips to an
unencrypted (readable) PDF.

Cipher families in scope:

- **RC4** — V1/V2, R2/R3 (40–128-bit keys).
- **AES-128** — V4, R4, crypt-filter `AESV2`.
- **AES-256** — V5, R6 (and the deprecated R5), crypt-filter `AESV3`.

The empty-user-password case is the primary target, but an optional password is
wired through key derivation so a correct non-empty password also opens the file.

## Public API changes

```ts
interface OpenOptions { password?: string }   // password defaults to ''
static Open(buf: Uint8Array, opts?: OpenOptions): Document
static OpenFile(fileName: string, opts?: OpenOptions): Document
```

- `password` is encoded to bytes (PDFDocEncoding/latin1 for R≤4; UTF-8 for R6,
  SASLprep is **not** implemented — out of scope) and run through key derivation.
- On a password that validates against neither `/U` nor `/O`, throw a clear
  `Error`: `"PDF is password-protected: wrong or missing password"`.
- A `/Filter` other than `/Standard` (e.g. a public-key handler) throws
  `UnsupportedFeatureError("unsupported security handler: <name>")`.

## Architecture

### Where decryption hooks in — inline in `parseEntry` (Option A)

`Document.Open` already lazily materializes each xref entry through a local
`parseEntry(num)` closure that knows the object number and (for `offset`
entries) the generation. Decryption is performed there, as each **top-level
`offset` object** is first materialized:

1. Parse the indirect object as today.
2. If a `Decryptor` is present, replace the object with
   `decryptor.decryptObject(value, num, gen)` before storing it in `objects`.
3. Object-stream **containers** are `offset` objects, so their raw bytes are
   decrypted in step 2 *before* `decodeObjStm` runs — the correct layering
   (encryption is the outermost wrapper, applied after compression).

Objects sourced from object streams (`compressed` entries) are **not** decrypted:
per spec, strings/streams inside an object stream are not individually
encrypted because the container was encrypted as a whole.

Rejected alternative (Option B): a post-parse pass over the `objects` map. It
would require separately recovering each object's generation and tagging which
objects came from object streams to avoid double-decryption — more plumbing, no
benefit.

### New module: `src/crypto.ts`

Self-contained. Exposes a `Decryptor` plus the building blocks. No new runtime
dependencies — Node's `crypto` for AES/MD5/SHA-2, hand-rolled RC4.

```ts
export interface Decryptor {
  decryptString(bytes: Uint8Array, num: number, gen: number): Uint8Array
  decryptStream(bytes: Uint8Array, num: number, gen: number): Uint8Array
  /** Walk obj, decrypting nested strings and (for streams) raw; returns the
   *  object to store. Strings are immutable so replaced in their parent
   *  container; a stream is returned as a new object with decrypted raw. */
  decryptObject(obj: PdfObject, num: number, gen: number): PdfObject
}

/** Build from the resolved /Encrypt dict, the trailer /ID, and a password.
 *  Returns undefined for /Identity-only (nothing to do). Throws on unsupported
 *  handler. Throws on password mismatch. */
export function buildDecryptor(
  encrypt: PdfDict, id: Uint8Array | undefined, password: string,
  resolve: (o: PdfObject | undefined) => PdfObject,
): Decryptor
```

Internal pieces:

- **RC4** — `rc4(key, data)` keystream KSA/PRGA, ~15 lines.
- **AES-CBC** — `aesCbcDecrypt(key, data)`: IV = first 16 bytes of `data`,
  remainder decrypted with `crypto.createDecipheriv('aes-128-cbc'|'aes-256-cbc')`,
  PKCS#7 padding stripped (`setAutoPadding(true)`). Empty/short ciphertext → `[]`.
- **File key derivation**
  - *Algorithm 2* (R2–R4): MD5 of `pad(password) + O[0..32] + P(4 bytes LE) +
    ID[0] + (R≥4 && !EncryptMetadata ? 0xFFFFFFFF : nothing)`; if R≥3, 50 extra
    MD5 rounds over the first `n` bytes. Key length `n = Length/8` (default 5).
  - *Algorithm 2.A/2.B* (R5/R6): validate password against `/U`
    (`hash(password + U.validationSalt) == U[0..32]`), then derive the
    intermediate key `hash(password + U.keySalt)` and AES-256-CBC-decrypt `/UE`
    (IV=0, no padding) to recover the 32-byte file key. R6 uses the hardened
    hash (Algorithm 2.B: iterative SHA-256/384/512 with AES-128-CBC rounds);
    R5 uses plain SHA-256.
  - Owner-password path (Algorithm 2 step using `/O`, and R6 `/OE`) is supported
    so a supplied owner password also opens the file.
- **Per-object key**
  - V≤4 (Algorithm 1): `MD5(fileKey + num_lo3 + gen_lo2 + (AES ? 'sAlT' : ''))`,
    truncated to `min(n + 5, 16)` bytes.
  - V5: the file key is used directly (no per-object salting).
- **Crypt-filter resolution** (V4/V5): `/StmF` and `/StrF` name entries in `/CF`;
  each entry's `/CFM` selects the cipher (`V2`→RC4, `AESV2`→AES-128,
  `AESV3`→AES-256, `Identity`→passthrough). Default filter is `/Identity` when
  unnamed. For V<4 the cipher is RC4 with `/Length`.

### What gets decrypted / what is exempt

Decrypted: every string and every stream's raw bytes in top-level `offset`
objects, plus strings inside a stream's own dict (keyed by the stream object).

Exempt — parsed before or outside the decryptor, so untouched naturally:

- The `/Encrypt` dict and all its strings (`/O`, `/U`, `/OE`, `/UE`, `/Perms`).
- The trailer `/ID`.
- The cross-reference stream (its data is never encrypted).
- Every object materialized from an object stream.

### Save behavior

After a successful open the live map is plaintext and the serializer is
encryption-unaware. `Save()`:

- strips `/Encrypt` from the live trailer (so output is not flagged encrypted),
- **keeps** `/ID` (harmless; some readers expect it),

and emits a normal unencrypted PDF. No re-encryption is implemented.

## Error handling

| Condition | Result |
|-----------|--------|
| `/Filter` ≠ `/Standard` | `UnsupportedFeatureError` |
| `/V` or `/R` outside {1,2,4,5}/{2,3,4,5,6} | `UnsupportedFeatureError` |
| Password validates against neither `/U` nor `/O` | `Error` (clear message) |
| `/CFM` unrecognized | `UnsupportedFeatureError` |

The old blanket `throw UnsupportedFeatureError` on `/Encrypt` in `Open` is
replaced by the decryptor build.

## Testing

A PDF **encryptor** added to `test/helpers/` (mirrors `build-pdf.ts`): given a
plaintext object set, derives the file key and per-object keys and produces an
encrypted PDF with a chosen V/R/cipher and password. Tests then assert
`Document.Open` recovers the original strings/streams.

Coverage:

- RC4 (R3, 128-bit), AES-128 (V4/R4), AES-256 (V5/R6) — empty user password.
- A multi-page document containing an **object stream** (verifies container is
  decrypted once and contained objects are not double-decrypted).
- Non-empty user password (correct password opens).
- Wrong password → clear throw.
- `EncryptMetadata false` variant (RC4) — metadata still recovered.
- Round-trip: open encrypted → `Save()` → re-open → content matches and trailer
  has no `/Encrypt`.

**Breaking the encryptor⇄decryptor circularity** — pin primitives against
published vectors in a dedicated test:

- RC4 against the classic key/plaintext test vectors.
- MD5 / SHA-256 via Node `crypto` (trusted) — used as ground truth.
- The Algorithm-2 32-byte padding string matches the PDF spec's documented bytes.

## Out of scope (future issues)

- Writing/saving **encrypted** output (re-encryption).
- Public-key (`/Filter /PubSec`) security handlers.
- SASLprep/`stringprep` normalization of R6 passwords.
- Revision 5-only edge readers beyond the deprecated-R5 path noted above.
