# CAdES commitment-type + signer-location signed attributes — Design

**Issue:** aspose-pdf-foss-for-ts-38p
**Date:** 2026-07-07

## Goal

Add two optional CAdES signed attributes — **commitment-type-indication** and
**signer-location** — to the PAdES signature path, and surface them when reading
signatures back through `VerifySignatures`. Read-back is informational only (no
new trust semantics).

## Scope

- In: option plumbing, DER assembly of the two attributes in the CMS layer,
  parse-and-surface on verification, PAdES gating, input validation, tests,
  README.
- Out: commitment-type *qualifiers* (`CommitmentTypeQualifier`), signer-attributes
  (`id-aa-ets-signerAttr`), any trust/policy evaluation of the attribute values.

## Background (current architecture)

- Signed attributes are assembled in `buildSignedData` (`src/cms.ts`, ~line 119)
  from a `SignedDataOptions` object; the PAdES path already appends
  `signing-certificate-v2` there.
- Options flow `SignOptions` → `Document.Sign` → `buildSignedData`
  (`src/document.ts:957`, currently `{ signingCertificateV2: opts.subFilter === 'PAdES' }`).
- Verification parses signed attributes in `parseSignedData` (`src/cms.ts`) and
  reports a `SignatureReport` (`src/sigverify.ts:64`).
- Naming note: `SignOptions.location` (`src/signature.ts:41`) is the PDF
  `/Location` string — unrelated to the CAdES *signer-location* signed attribute.
  The new attributes live under a nested `cades` object to avoid the clash.

## 1. API surface

New types (exported from the package barrel alongside the other signing types):

```ts
export type CommitmentType =
  | 'proof-of-origin' | 'proof-of-receipt' | 'proof-of-delivery'
  | 'proof-of-sender'  | 'proof-of-approval' | 'proof-of-creation'
  | (string & {});                      // custom dotted OID

export interface SignerLocation {
  country?: string;                     // countryName   -> [0]
  locality?: string;                    // localityName  -> [1]
  postalAddress?: string[];             // postalAddress -> [2], 1..6 lines
}

export interface CadesAttributes {
  commitmentType?: CommitmentType;
  signerLocation?: SignerLocation;
}
```

`SignOptions` gains `cades?: CadesAttributes;` (inherited by `CertifyOptions`).

`SignedDataOptions` (`src/cms.ts`) gains a parallel `cades?: CadesAttributes;`
field; `Document.Sign` forwards `opts.cades` into `buildSignedData`.

The `CommitmentType` union uses `(string & {})` so the six friendly names appear
in editor autocomplete while still accepting an arbitrary dotted-OID string.

## 2. DER encoding (`src/cms.ts`)

Both attributes are built and pushed onto `signedAttrElements` (after the
`signing-certificate-v2` push), then ordered by the existing `sortedSet` (DER
SET OF sort). They are covered by the signature because they are part of the
signed `SET OF` — exactly like the existing attributes.

### commitment-type-indication

- Attribute OID `id-aa-ets-commitmentType` = `1.2.840.113549.1.9.16.2.16`.
- Value:
  ```
  CommitmentTypeIndication ::= SEQUENCE { commitmentTypeId OBJECT IDENTIFIER }
  ```
  (the optional `commitmentTypeQualifier` is omitted — out of scope).
- Friendly-name → OID map (`id-cti-ets-*`, arc `1.2.840.113549.1.9.16.6`):
  | name | OID |
  |------|-----|
  | `proof-of-origin`   | `…16.6.1` |
  | `proof-of-receipt`  | `…16.6.2` |
  | `proof-of-delivery` | `…16.6.3` |
  | `proof-of-sender`   | `…16.6.4` |
  | `proof-of-approval` | `…16.6.5` |
  | `proof-of-creation` | `…16.6.6` |
- A value not in the map is treated as a raw OID and passed to `der.oid`
  verbatim (which itself rejects malformed OIDs).

### signer-location

- Attribute OID `id-aa-ets-signerLocation` = `1.2.840.113549.1.9.16.2.17`.
- Value:
  ```
  SignerLocation ::= SEQUENCE {
    countryName   [0] DirectoryString OPTIONAL,
    localityName  [1] DirectoryString OPTIONAL,
    postalAddress [2] PostalAddress   OPTIONAL }
  PostalAddress ::= SEQUENCE SIZE(1..6) OF DirectoryString
  ```
- Each `DirectoryString` is emitted as `UTF8String`. Context tags `[0] [1] [2]`
  are **explicit** (`der.explicit(n, …)`), because `DirectoryString` is a CHOICE
  and an implicit tag over a CHOICE is illegal.
- Only present sub-fields are emitted. If `signerLocation` has no present
  sub-field (all undefined / empty `postalAddress`), the whole attribute is
  omitted. `postalAddress` is emitted only when non-empty.

New OID constants are added to the `OID` table in `src/asn1.ts`
(`commitmentTypeIndication`, `signerLocation`, and the six `cti*` commitment
OIDs). Assembly reuses existing helpers (`attribute`, `der.sequence`,
`der.explicit`, `der.oid`, `der.utf8String`) — no new ASN.1 primitives.

## 3. Verification (`src/cms.ts` parse + `src/sigverify.ts`)

`parseSignedData` scans `signedAttrs` for the two attribute OIDs and adds to its
parsed result:

- `commitmentType?: string` — the inner `commitmentTypeId` OID resolved back to
  its friendly name when known, else the dotted OID string.
- `signerLocation?: SignerLocation` — decoded `[0]/[1]/[2]` fields.

`SignatureReport` (`src/sigverify.ts`) gains the same two optional fields
(`commitmentType?: string`, `signerLocation?: SignerLocation`), populated from
the parsed result. Absent when the signature carries no such attribute. No
verdict fields — this is read-back only.

## 4. Gating & error handling

Validated in `Document.Sign` (and `Certify`) before serialization:

- `opts.cades` present with `subFilter !== 'PAdES'` → throw
  `UnsupportedFeatureError('CAdES signed attributes require subFilter: "PAdES"')`.
- `commitmentType` that is neither one of the six friendly names nor a
  well-formed dotted OID → throw `UnsupportedFeatureError` (surfaced from
  `der.oid` / an explicit pre-check).

The PAdES gate triggers only when `cades` would actually emit an attribute. An
empty `cades: {}` (or one whose sub-fields are all absent, so nothing is
emitted) is treated as absent: no attributes added, no throw, no gate.

## 5. Testing (TDD, vitest)

CMS-level (`test/cms-*.test.ts` style):
- Round-trip each attribute `buildSignedData` → `parseSignedData`.
- Assert exact DER for a known input (attribute OID bytes, inner SEQUENCE,
  explicit `[0]/[1]/[2]` tags, SET-OF ordering unchanged).
- Custom dotted-OID commitment passthrough.
- Multi-line `postalAddress`; partial `signerLocation` (only `country`).
- Signature over the signed attrs still verifies with attributes present.

Document-level (`test/sign-*.test.ts` style, existing signer fixtures):
- `doc.Sign({ subFilter:'PAdES', cades:{ commitmentType, signerLocation } })`
  then `VerifySignatures` returns the values; `signature: 'valid'`,
  `integrity: 'valid'`.
- Gating throw: `cades` with default/CMS subFilter.
- Bad-input throw: unknown non-OID `commitmentType`.

## 6. Docs

Update README: the signatures Features bullet gains a sentence on the optional
`cades` attributes and their read-back in `VerifySignatures`; the API-overview
signature entry notes the new option. Keep in sync with the existing PAdES-B-T
wording.

## Self-contained units

- `src/cms.ts` — new build helpers `commitmentTypeAttr`, `signerLocationAttr`
  (pure DER from the option object), and parse additions. Depends only on
  `asn1.ts` + option shape.
- `src/asn1.ts` — additive OID constants only.
- `src/sigverify.ts` — passes parsed fields through to the report; no new logic.
- `src/signature.ts` / `src/document.ts` — types + gating/validation only.
