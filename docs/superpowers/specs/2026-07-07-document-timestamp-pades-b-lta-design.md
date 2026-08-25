# Document timestamp (`/DocTimeStamp`) + PAdES-B-LTA — design

**Issue:** aspose-pdf-foss-for-ts-zn6
**Date:** 2026-07-07

## Goal

Add a standalone **document timestamp** signature (ETSI.RFC3161 `/DocTimeStamp`)
that layers on top of the existing B-T / B-LT support, enabling **PAdES-B-LTA**
archival. Extend verification to validate the document timestamp and to classify
each real signature's PAdES baseline level.

Acceptance criteria (from the issue):

- `doc.AddDocumentTimestamp(tsaCallback)` appends a `/DocTimeStamp` via an
  incremental update.
- `VerifySignatures` reports it (here: a dedicated `VerifyDocumentTimestamps`
  accessor plus a `padesLevel` on each `SignatureReport`).
- A B-LT doc + doc-timestamp verifies as **B-LTA**.
- vitest coverage; README signatures note updated.

## Background

A `/DocTimeStamp` is structurally a signature field (`FT /Sig`) but its value
dict is `Type /DocTimeStamp`, `SubFilter /ETSI.RFC3161`, and its `/Contents`
holds the **RFC 3161 TimeStampToken itself** (a CMS ContentInfo whose eContent
is a TSTInfo) — *not* a detached CMS over signed attributes. The token's message
imprint is the digest of the field's `/ByteRange` (the document bytes), so the
timestamp binds a trusted time to the whole document image up to that revision.

The building blocks already exist:

- `rfc3161.ts` — `buildTimeStampRequest(imprint, hashAlg)`,
  `extractTimeStampToken(respOrToken)`, `verifyTimestampToken(token,
  signedValue)` (hashes `signedValue` with the token's own alg, then checks the
  message-imprint binding **and** the TSA's CMS signature over the TSTInfo),
  `parseTstInfo`, and the `TimestampProvider` callback type.
- `incremental.ts` — `appendSignatureUpdate(base, { sigObjNum, sigDict,
  objects, placeholderBytes })` lays out a `/Contents` placeholder with a
  computed `/ByteRange`; `fillSignature(bytes, layout, der)` drops the bytes in
  without shifting offsets.
- `signature.ts` — `digestByteRange(bytes, byteRange, alg)`.
- `dss.ts` — `/DSS` LTV store (B-LT) plus `readDssCerts` / `readDssMaterial`.

The doc-timestamp reuses all of this; the only genuinely new mechanics are the
value-dict shape, the "digest → request → token → fill" order (no CMS build),
and the verify branch.

## 1. Authoring — `Document.AddDocumentTimestamp`

```ts
export interface DocumentTimestampOptions {
  /** Imprint hash algorithm for the timestamp request. Default 'sha256'. */
  digest?: DigestAlgorithm;
  /** Reserved `/Contents` capacity in bytes. Default 16384 — the token embeds
   *  the TSA certificate, so the 8 KiB signature default is usually too small. */
  placeholderBytes?: number;
  /** Field name (`/T`); defaults to `Timestamp<n>`. */
  fieldName?: string;
}

async AddDocumentTimestamp(
  tsa: TimestampProvider, opts?: DocumentTimestampOptions,
): Promise<void>
```

Behaviour:

1. Require a base byte image (`pendingSignedBytes ?? originalBytes`); throw
   `UnsupportedFeatureError` when there is none — a document timestamp is an
   incremental overlay on an existing (typically signed) image and never a full
   rewrite.
2. Materialize pending fonts (`finalizeEmbeddedFonts`) for parity with signing,
   though a timestamp overlay typically has nothing pending.
3. Build the value dict `buildDocTimeStampDict()`:
   `Type /DocTimeStamp`, `Filter /Adobe.PPKLite`, `SubFilter /ETSI.RFC3161`
   (the writer fills `/ByteRange` and `/Contents`).
4. Wire an **invisible** `FT /Sig` widget into the AcroForm + first page
   `/Annots` (reusing the field/AcroForm wiring; no appearance branch). Field
   name defaults to `Timestamp<n>` where `n` counts existing document
   timestamps + 1.
5. `layout = appendSignatureUpdate(base, { sigObjNum, sigDict: dtsDict, objects,
   placeholderBytes })`.
6. `imprint = digestByteRange(layout.bytes, layout.byteRange, hashAlg)`.
7. `request = buildTimeStampRequest(imprint, hashAlg)`.
8. `token = extractTimeStampToken(await tsa(request))`.
9. `fillSignature(layout.bytes, layout, token)` and set
   `pendingSignedBytes = layout.bytes`.

The returned bytes surface through the next `Save()` / `WriteTo()`, exactly like
`Sign` / `AddValidationData`.

### Field wiring reuse

`installSignatureField` currently hard-codes the signature naming
(`Signature<n>`) and an optional visible appearance. To avoid duplicating the
AcroForm/`/Annots`/`/SigFlags` logic, factor the invisible-widget wiring so both
`signCore` and `AddDocumentTimestamp` share it. Concretely: extract a helper
that, given a value-dict ref and a field name, creates the invisible widget,
attaches it to the first page and the AcroForm (`/SigFlags |= 3`), and returns
the touched object numbers. `installSignatureField` keeps the appearance branch
and delegates the wiring; `AddDocumentTimestamp` calls the shared helper
directly. This is a targeted refactor of code being extended, not speculative
reshaping.

## 2. Read model

- `SignatureField` gains `isDocTimeStamp: boolean`, set in `readSignatureField`
  from the value dict: `Type === 'DocTimeStamp'` **or** `SubFilter ===
  'ETSI.RFC3161'`.
- `get Signatures()` **excludes** doc-timestamp fields (real approval /
  certification signatures only). This keeps `AddValidationData`,
  `readDssMaterial`, and DocMDP enforcement — all of which iterate `Signatures`
  — from treating a timestamp as a signer.
- New `get DocumentTimestamps(): SignatureField[]` lists only the doc-timestamp
  fields (signed ones carry `byteRange` / `contents`).

## 3. Verification — `VerifyDocumentTimestamps`

```ts
export interface DocumentTimestampReport {
  /** Timestamp field name (`/T`). */
  name: string;
  /** RFC 3161 verdict: asserted `time`, `imprintMatches`, `tokenSignatureValid`,
   *  overall `valid`, `policy`, `serialNumber`. */
  timestamp: TimestampInfo;
  /** Whether the `/ByteRange` spans the whole file (no later revision). */
  coversWholeFile: boolean;
  /** Objects added/modified in revisions appended after this timestamp. */
  modifications: Change[];
  /** The TSA's certificate summary, when the token could be parsed. */
  signerCert?: CertInfo;
}

async VerifyDocumentTimestamps(): Promise<DocumentTimestampReport[]>
```

Core (new `verifyDocumentTimestamp(bytes, sig)` in `sigverify.ts`):

1. Trim the token to `cmsLength` (drop zero padding), as `verifySignature` does.
2. `content = byteRangeContent(bytes, sig.byteRange)` — a new helper in
   `signature.ts` returning the two `/ByteRange` segments concatenated (the
   companion to `digestByteRange`, which returns their hash).
3. `report.timestamp = verifyTimestampToken(token, content)` — this hashes
   `content` with the token's declared alg and checks the imprint binding and
   the TSA's CMS signature. Wrap in try/catch; a malformed token yields a report
   with `timestamp.valid === false`.
4. `signerCert = certInfo(parseSignedData(token).signerCertificate)` (best
   effort).
5. Coverage diff via the existing `revisionChanges(bytes, signedEnd)`.

`VerifyDocumentTimestamps` re-opens the authoritative bytes
(`pendingSignedBytes ?? originalBytes`), maps `src.DocumentTimestamps` (signed)
through `verifyDocumentTimestamp`.

## 4. `padesLevel` on `SignatureReport`

```ts
/** PAdES baseline level of this signature, or undefined when it could not be
 *  classified. B-B (basic) → B-T (trusted time) → B-LT (long-term validation
 *  data) → B-LTA (archive timestamp). */
padesLevel?: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
```

Computed in `VerifySignatures` (which already re-opens `src`, so it can inspect
`/DSS` and the document timestamps):

- `docTsValid` = at least one entry of `VerifyDocumentTimestamps` /
  `verifyDocumentTimestamp` has `timestamp.valid === true`.
- Per signature report:
  - `hasT` = `report.timestamp?.valid === true` (embedded signature-timestamp)
    `|| docTsValid`.
  - `hasLT` = `/DSS` validation material is present for this signature —
    `readDssMaterial(src).has(name)`, or, failing a per-VRI entry, a `/DSS` with
    a non-empty `/Certs` exists (`readDssCerts(src).length > 0`).
  - `hasA` = `docTsValid`.
  - ladder: `hasLT && hasA → 'B-LTA'` · `hasLT → 'B-LT'` · `hasT → 'B-T'` ·
    else `'B-B'`.

`padesLevel` is set only on real-signature reports (`VerifySignatures` already
returns only those). It is a structural/verified-presence classification, not a
trust judgement — chain trust and revocation remain separate report fields.

## 5. Exports

`index.ts` adds `DocumentTimestampOptions`, `DocumentTimestampReport`. The
`TimestampProvider` type and the `rfc3161` helpers are already exported.

## 6. Tests — `test/sign-doctimestamp.test.ts`

Reuse the in-process test TSA and `buildSigner` from `sign-timestamp.test.ts`.

1. **Append + verify** — open a classic PDF, `Sign` (RSA), `AddDocumentTimestamp`
   with the test TSA; `VerifyDocumentTimestamps()` returns one report with
   `timestamp.valid`, `imprintMatches`, `tokenSignatureValid`, and a `Date`
   `time`; `signerCert` reflects the TSA subject.
2. **Excluded from `Signatures`** — after adding the timestamp, `doc.Signatures`
   has length 1 (the RSA signature); `doc.DocumentTimestamps` has length 1.
3. **Tamper** — corrupt a byte inside the timestamp's signed `/ByteRange`;
   `timestamp.imprintMatches` flips to false (`valid` false).
4. **B-LTA flow** — `Sign` with an embedded signature-timestamp →
   `AddValidationData` (test OCSP/CRL, giving `/DSS`) → `AddDocumentTimestamp`;
   `VerifySignatures()[0].padesLevel === 'B-LTA'`, and the same document without
   the doc-timestamp reports `'B-LT'`, without the `/DSS` `'B-T'`, and a bare
   signed doc `'B-B'`.
5. **Coverage** — the timestamp's `coversWholeFile` is true when it is the last
   revision.

## 7. Non-goals

- No renewal / re-timestamping chains (multiple stacked archive timestamps are
  parsed and each verified independently, but no explicit "renew" helper).
- No trust-anchor / revocation validation of the TSA certificate inside the
  document-timestamp report (the TSA chain is a caller concern; `signerCert` is
  surfaced for that). Consistent with how signature-timestamps are reported
  today.
- No visible appearance for document timestamps (always invisible).
