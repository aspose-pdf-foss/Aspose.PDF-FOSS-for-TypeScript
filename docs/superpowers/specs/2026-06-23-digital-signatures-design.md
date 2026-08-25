# Phase 8 — Digital Signatures (design)

Status: approved (brainstorm) — pending implementation plan
Date: 2026-06-23
Epic: Phase 8 — Digital signatures (sign + verify)

## 1. Goal & scope

Add the ability to **create** and **verify** PDF digital signatures, staying
within the library's zero-runtime-dependency rule (only `node:` built-ins) and
its from-scratch parse/serialize model.

In scope:

- **Sign and verify.**
- **Both write paths:** incremental-update (append-only) and sign-on-save
  (single-pass full rewrite). The path is chosen automatically from document
  state (see §5).
- **Both subfilters:** `adbe.pkcs7.detached` (ISO 32000 CMS) and
  `ETSI.CAdES.detached` (PAdES — CAdES with the ESS signing-certificate signed
  attribute).
- **Algorithms:** RSA PKCS#1 v1.5, RSA-PSS, ECDSA (P-256/384/521), Ed25519
  (Ed25519 shipped as **experimental** — thin reader support). Digests
  SHA-256/384/512 throughout.
- **Advanced:** RFC 3161 signature timestamps (PAdES-B-T), LTV via `/DSS`
  validation data (PAdES-B-LT), certification signatures (`/DocMDP`), and
  visible signature appearances.
- **Credentials:** PEM key + cert chain, PKCS#12 (`.pfx`/`.p12`), and an
  external signer callback (HSM/KMS/smartcard).
- **Verification depth:** integrity + crypto + post-signing change analysis;
  certificate chain to caller-supplied trust anchors; revocation (OCSP/CRL);
  `/DocMDP` enforcement.

Network features (timestamps, OCSP, CRL) never perform I/O themselves — the
caller supplies fetch callbacks and we handle all ASN.1 build/parse/embed. This
preserves the zero-runtime-dependency rule.

## 2. New modules (`src/`)

`node:crypto` provides every cryptographic primitive we need: `sign`/`verify`
(RSA PKCS#1 v1.5, RSA-PSS via padding options, ECDSA, Ed25519), digests
(SHA-256/384/512), `createPrivateKey`/`createPublicKey`, and `X509Certificate`
for reading certs. Everything else — DER, CMS, PKCS#12, OCSP, CRL, RFC 3161 —
is **hand-rolled** on a minimal ASN.1 layer.

- **`asn1.ts`** — minimal DER encoder/decoder + an OID registry. Foundational;
  nothing comparable exists in the codebase today. All modules below build on it.
- **`cms.ts`** — PKCS#7/CMS `SignedData` build + parse. Signed attributes:
  `contentType`, `messageDigest`, `signingTime`, and (PAdES) ESS
  `signingCertificateV2`. Unsigned attribute slot for the signature timestamp.
- **`sigalg.ts`** — algorithm-identifier (OID) ↔ `node:crypto` mapping, including
  RSA-PSS padding parameters, EC curve selection, and Ed25519.
- **`pkcs12.ts`** — `.pfx`/`.p12` parser: ASN.1 structure + the PKCS#12 KDF +
  PBES1/PBES2 decryption, yielding the private key and certificate chain.
- **`incremental.ts`** — append-only writer: original bytes preserved verbatim,
  new objects + a new cross-reference section + `startxref` appended, with a
  fixed-size `/Contents` placeholder and a computed `/ByteRange`.
- **`signature.ts`** — `/Sig` field + value-dictionary model, the signing
  orchestration (`Sign`/`Certify`), the `/DocMDP` transform, and visible-
  appearance Form XObject generation (reusing `appearance.ts`).
- **`sigverify.ts`** — verification engine: digest/byte-range check, CMS
  cryptographic verification, revision/coverage diff, chain validation,
  revocation, timestamp verification, and `/DocMDP` enforcement → typed result.
- **`rfc3161.ts`** — timestamp token build-from-callback + parse/verify (TSTInfo).
- **`dss.ts`** — `/DSS` validation-data embedding (LTV) and read-back.

## 3. Public API (on `Document`)

```ts
// Enumerate existing signatures (read-side, always available)
doc.Signatures: SignatureField[];
// each: { name, subFilter, byteRange, isSigned, coversWholeFile }

// Sign (approval). Chooses the write path automatically (see §5).
await doc.Sign(signer: Signer, opts?: SignOptions): Promise<void>;
// then Save() / WriteTo()

// Certify (author signature with permitted-changes level). Once per document.
await doc.Certify(signer: Signer, opts: CertifyOptions): Promise<void>;

// Verify all signatures.
await doc.VerifySignatures(opts?: VerifyOptions): Promise<SignatureReport[]>;
```

### Types

`Signer` — discriminated union over credential source:

```ts
type Signer =
  | { pem: { key: string | Buffer; passphrase?: string; certificates: (string|Buffer)[] } }
  | { pkcs12: string | Buffer; passphrase?: string }
  | { certificates: (string|Buffer)[]; sign(digest: Uint8Array, alg: SigAlg): Promise<Uint8Array> | Uint8Array };
```

All `Signer` variants may also carry:

- `algorithm?: SigAlg` — preference (defaults inferred from the key type).
- `timestamp?(req: Uint8Array): Promise<Uint8Array>` — RFC 3161 TSA fetch
  (returns the DER timestamp token / TSA response).
- `getOCSP?(req): Promise<Uint8Array>`, `getCRL?(url): Promise<Uint8Array>` —
  for LTV embedding at sign time.

`SignOptions`:

```ts
{
  reason?: string; location?: string; contactInfo?: string; name?: string;
  signingTime?: Date;
  subFilter?: 'CMS' | 'PAdES';           // default 'CMS'
  appearance?: VisibleAppearance;        // omit → invisible (zero-rect widget)
  ltv?: boolean;                         // embed /DSS validation data
}
```

`CertifyOptions` extends `SignOptions` with
`permissions: 'no-changes' | 'form-fill' | 'form-fill-and-annotate'` (the
`/DocMDP` `/P` levels 1/2/3).

`VisibleAppearance`: `{ page: number; rect: [x,y,w,h]; text?: string; image?: Uint8Array }`.

`VerifyOptions`: `{ trustAnchors?: (string|Buffer)[]; getOCSP?; getCRL?; at?: Date }`.

`SignatureReport`:

```ts
{
  name: string;
  integrity: 'valid' | 'tampered';
  signature: 'valid' | 'invalid';
  coversWholeFile: boolean;
  modifications: Change[];               // what changed after this signature
  chain: 'trusted' | 'untrusted' | 'unchecked';
  revocation: 'good' | 'revoked' | 'unknown' | 'unchecked';
  timestamp?: { time: Date; valid: boolean };
  docMDP: 'ok' | 'violated' | 'n/a';
  signerCert: CertInfo;
}
```

### Async rationale

Timestamp/OCSP/CRL callbacks are inherently asynchronous, so `Sign`, `Certify`,
and `VerifySignatures` return Promises. Pure-offline signing (no callbacks)
still resolves synchronously-fast (no I/O).

## 4. CMS / signature internals

A signature value dictionary holds: `/Type /Sig`, `/Filter /Adobe.PPKLite`,
`/SubFilter` (`/adbe.pkcs7.detached` or `/ETSI.CAdES.detached`), `/ByteRange`,
`/Contents` (the hex-encoded detached CMS, inside a fixed-size placeholder),
and the optional `/M` (signing time), `/Name`, `/Reason`, `/Location`,
`/ContactInfo`. Certification adds a `/Reference` array with a `/DocMDP`
transform and the corresponding `/Perms /DocMDP` entry on the catalog.

The CMS `SignedData` is **detached** (no `eContent`); the message digest in the
signed attributes is the digest of the `/ByteRange`-covered bytes. Signed
attributes are DER-encoded with their SET-OF ordering, the signature is computed
over that encoding, and the signer's certificate chain is embedded in
`certificates`. PAdES adds the ESS `signingCertificateV2` signed attribute
binding the signing cert. A timestamp, when present, is an **unsigned**
attribute carrying the RFC 3161 token over the signature value.

## 5. Write-model mechanics (the crux)

The signed byte image must not change after signing. The write path is chosen
from document state:

| Document state                     | Path                         | Why                                                        |
| ---------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| Opened, **unmodified**             | Incremental append           | Preserves exact signed bytes; required if already signed   |
| Already has a signature            | Incremental append (forced)  | A full rewrite would invalidate the prior signature(s)     |
| New / authored / mutated in memory | Sign-on-save (full rewrite)  | No prior signature to protect; one clean pass              |

Shared mechanism: reserve a fixed-size `/Contents <00…00>` hex placeholder,
write the byte image, compute `/ByteRange = [0, a, b, c]` spanning the whole
image except the placeholder hex, digest that range, build the CMS, and hex-fill
the placeholder in place (no length change). Incremental appends a new xref
section referencing the existing `/Root`; sign-on-save emits the placeholder
during normal serialization.

**Rule:** mutating the model after an incremental signature and then `Save()`
forces a full rewrite, which is reported as invalidating that signature — we
warn rather than silently corrupt it. Incremental signing requires a base byte
image (the opened bytes, or a freshly serialized image when the document was
authored from scratch and then needs a second signature).

## 6. Epic track decomposition (children of the Phase 8 epic)

Foundational → parallel tracks → integration. Dependencies noted.

0. **D — this design spec.**
1. **A1 — ASN.1/DER toolkit** (`asn1.ts`). Foundation; blocks most.
2. **A2 — CMS SignedData build + parse** (RSA v1.5 + SHA-256 baseline). ← A1.
3. **A3 — Algorithm coverage** (ECDSA, RSA-PSS, Ed25519). ← A2.
4. **W1 — Incremental-update writer** (`incremental.ts`). Parallel to A.
5. **W2 — Sign-on-save placeholder in serializer.** Parallel.
6. **K1 — Signer credentials** (PEM + callback; `pkcs12.ts` parser). ← A1.
7. **F1 — Sig field/dict model + invisible signing** wired to W1/W2. ← A2, W1/W2.
8. **F2 — Visible appearance generation.** ← F1.
9. **C1 — Certification (`/DocMDP`).** ← F1.
10. **T1 — RFC 3161 timestamps.** ← A2.
11. **L1 — LTV `/DSS` embedding.** ← T1, V3.
12. **V1 — Verify core** (integrity + crypto + revision/coverage). ← A2.
13. **V2 — Chain to trust anchors.** ← V1, A1.
14. **V3 — Revocation (OCSP/CRL).** ← V1, A1.
15. **V4 — `/DocMDP` enforcement on verify.** ← V1, C1.

Each child is a focused, independently testable unit. The implementation plan
(writing-plans) turns these into ordered, detailed tasks.

## 7. Testing strategy

TDD throughout, fixtures generated programmatically in `test/helpers/` (no
checked-in secrets):

- `build-signer.ts` helper generates self-signed RSA / EC / Ed25519 keypairs
  and certificates at test time via `node:crypto`.
- Round-trip: sign → re-open → verify `valid`.
- Tamper a byte in the signed range → `tampered`.
- Sign-then-edit-then-save → prior signature reported invalidated (full-rewrite
  rule).
- Multi-signature: certify + later approval via incremental append; both verify.
- PAdES: ESS `signingCertificateV2` signed attribute present and verified.
- Chain validation against a test root anchor; untrusted when anchor withheld.
- `/DocMDP` violation detection (a change exceeding the permitted level).
- Timestamp / OCSP / CRL via mock callbacks returning canned DER.
- Self-consistency: our verifier parses our own CMS output; additionally
  cross-check against an openssl/Acrobat-produced fixture where available.

## 8. Non-goals

- PKCS#11 / smartcard drivers (use the external signer callback instead).
- Full RFC 5280 path-building edge cases (name constraints, policy mapping).
- CAdES-A / archival re-timestamping (PAdES-B-LTA).
- Signature appearance rendering beyond text + image.
- Built-in network I/O — all network access is via caller-supplied callbacks.

## 9. Risks

- **Hand-rolled ASN.1/CMS is the correctness-critical core.** Mitigate with
  heavy unit tests and cross-checks against openssl/Acrobat-produced fixtures.
- **PKCS#12 KDF/PBES is fiddly.** Isolate in `pkcs12.ts` with focused tests.
- **Ed25519 in PDF has thin reader support.** Ship as experimental.
- **Async `Sign`/`Verify` is a new convention** for this codebase (everything
  else is synchronous). Documented and consistent across the signature API.
