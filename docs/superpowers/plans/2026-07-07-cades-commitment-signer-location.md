# CAdES commitment-type + signer-location signed attributes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional CAdES `commitment-type-indication` and `signer-location` signed attributes to the PAdES signature path, and surface them read-only through `VerifySignatures`.

**Architecture:** The CMS layer (`src/cms.ts`) owns the two new attributes: pure DER build helpers append them to the signed-attribute set in `buildSignedData`, and `parseSignedData` reads them back onto its parsed result. `Document.signCore` threads a new `SignOptions.cades` through to `buildSignedData` after validating the PAdES gate, and `verifySignature` copies the parsed values onto the `SignatureReport`. Shared public types (`CommitmentType`, `SignerLocation`, `CadesAttributes`) live in `cms.ts` (the lowest module in the import chain) and are re-exported from `signature.ts` and the barrel.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest. Zero runtime deps — only `node:crypto`, reusing the existing `src/asn1.ts` DER encoder.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries a `.js` extension (e.g. `import { X } from './cms.js'`).
- Public errors are `PdfParseError` / `UnsupportedFeatureError` / `InvalidPasswordError` from `./errors.js`.
- Run `npm run typecheck` and `npm test` green before considering any task done.
- Attribute = `SEQUENCE { type OID, values SET OF value }`, built via the existing `attribute(typeOid, value)` helper. The signed-attribute set is DER-sorted by the existing `sortedSet(elements)`; do not re-sort manually.
- Context tags `[0]/[1]/[2]` in `SignerLocation` are **explicit** (`der.explicit(n, …)`) because `DirectoryString` is an ASN.1 CHOICE. `DirectoryString` values are emitted as `UTF8String`.

## File Structure

- `src/asn1.ts` — add the 8 CAdES OID constants to the `OID` table (additive only).
- `src/cms.ts` — new public types (`CommitmentType`, `SignerLocation`, `CadesAttributes`); `cades?` on `SignedDataOptions` and `ParsedCms`; build helpers `commitmentTypeAttr` / `signerLocationAttr` + the `commitmentTypeOid` / `signerLocationEmits` validators + reverse-OID map; wiring in `buildSignedData` and `parseSignedData`.
- `src/signature.ts` — `SignOptions.cades?: CadesAttributes`; re-export the three types.
- `src/document.ts` — PAdES gate + early validation in `signCore`; pass `cades` into `buildSignedData`.
- `src/sigverify.ts` — `commitmentType?` / `signerLocation?` on `SignatureReport`, populated from the parsed CMS.
- `src/index.ts` — barrel export of the three new types.
- `test/cades.test.ts` — CMS-level DER round-trip (Tasks 1 & 2).
- `test/sign-cades.test.ts` — document-level sign + verify + gating (Task 3).
- `README.md` — document the option (Task 4).

---

### Task 1: Types, OIDs, and the commitment-type attribute (build + parse)

**Files:**
- Modify: `src/asn1.ts` (OID constants)
- Modify: `src/cms.ts` (types, `SignedDataOptions.cades`, `ParsedCms.commitmentType`, build + parse)
- Test: `test/cades.test.ts` (create)

**Interfaces:**
- Consumes: `der`, `readOid`, `OID`, `Asn1Node` from `./asn1.js`; `attribute`, `sortedSet`, `buildSignedData`, `parseSignedData` in `./cms.js`; `UnsupportedFeatureError` from `./errors.js`; `buildRsaSigner` from `./helpers/build-signer.js`.
- Produces:
  - `type CommitmentType = 'proof-of-origin' | 'proof-of-receipt' | 'proof-of-delivery' | 'proof-of-sender' | 'proof-of-approval' | 'proof-of-creation' | (string & {})`
  - `interface SignerLocation { country?: string; locality?: string; postalAddress?: string[] }`
  - `interface CadesAttributes { commitmentType?: CommitmentType; signerLocation?: SignerLocation }`
  - `SignedDataOptions.cades?: CadesAttributes`
  - `ParsedCms.commitmentType?: string`
  - `commitmentTypeOid(ct: string): string` (module-internal; validates → OID, throws `UnsupportedFeatureError`)

- [ ] **Step 1: Add the OID constants** (`src/asn1.ts`)

In the `OID` object (after the `timeStampToken` entry near line 49), add:

```ts
  commitmentTypeIndication: '1.2.840.113549.1.9.16.2.16', // id-aa-ets-commitmentType
  signerLocation: '1.2.840.113549.1.9.16.2.17',           // id-aa-ets-signerLocation
  ctiProofOfOrigin: '1.2.840.113549.1.9.16.6.1',
  ctiProofOfReceipt: '1.2.840.113549.1.9.16.6.2',
  ctiProofOfDelivery: '1.2.840.113549.1.9.16.6.3',
  ctiProofOfSender: '1.2.840.113549.1.9.16.6.4',
  ctiProofOfApproval: '1.2.840.113549.1.9.16.6.5',
  ctiProofOfCreation: '1.2.840.113549.1.9.16.6.6',
```

- [ ] **Step 2: Write the failing test** (`test/cades.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildRsaSigner } from './helpers/build-signer.js';
import { buildSignedData, parseSignedData, verifySignedData } from '../src/cms.js';
import { UnsupportedFeatureError } from '../src/errors.js';

const digestOf = (s: string) => new Uint8Array(createHash('sha256').update(s).digest());

describe('CAdES commitment-type attribute', () => {
  it('round-trips a friendly commitment type and keeps the signature valid', async () => {
    const signer = buildRsaSigner();
    const md = digestOf('commit');
    const cms = await buildSignedData(md, signer, { cades: { commitmentType: 'proof-of-origin' } });
    const parsed = parseSignedData(cms);
    expect(parsed.commitmentType).toBe('proof-of-origin');
    // attribute is part of the signed set -> signature must still verify
    expect(verifySignedData(cms, md).signatureValid).toBe(true);
  });

  it('passes a custom dotted OID through verbatim', async () => {
    const signer = buildRsaSigner();
    const cms = await buildSignedData(digestOf('x'), signer, {
      cades: { commitmentType: '1.3.6.1.4.1.99999.7' },
    });
    expect(parseSignedData(cms).commitmentType).toBe('1.3.6.1.4.1.99999.7');
  });

  it('omits the attribute when no cades option is given', async () => {
    const signer = buildRsaSigner();
    const cms = await buildSignedData(digestOf('y'), signer);
    expect(parseSignedData(cms).commitmentType).toBeUndefined();
  });

  it('rejects a commitment type that is neither a known name nor an OID', async () => {
    const signer = buildRsaSigner();
    await expect(buildSignedData(digestOf('z'), signer, {
      cades: { commitmentType: 'not-a-commitment' },
    })).rejects.toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/cades.test.ts`
Expected: FAIL — `cades` not accepted / `parsed.commitmentType` undefined / no throw.

- [ ] **Step 4: Add types + `cades` option + build helper** (`src/cms.ts`)

Add the errors import near the top imports (after the `./asn1.js` import):

```ts
import { UnsupportedFeatureError } from './errors.js';
```

Add the public types just above `export interface SignedDataOptions`:

```ts
/** Standard CAdES commitment-type identifiers, or a custom dotted OID string. */
export type CommitmentType =
  | 'proof-of-origin' | 'proof-of-receipt' | 'proof-of-delivery'
  | 'proof-of-sender'  | 'proof-of-approval' | 'proof-of-creation'
  | (string & {});

/** CAdES `signer-location` signed attribute (all fields optional). */
export interface SignerLocation {
  country?: string;
  locality?: string;
  postalAddress?: string[]; // 1..6 lines
}

/** Optional CAdES signed attributes for a PAdES signature. */
export interface CadesAttributes {
  commitmentType?: CommitmentType;
  signerLocation?: SignerLocation;
}
```

Add the field to `SignedDataOptions` (after `signingCertificateV2?`):

```ts
  /** Optional CAdES signed attributes (commitment-type, signer-location).
   *  Emitted into the signed attribute set when present. */
  cades?: CadesAttributes;
```

Add the commitment-type map + helpers below the `signingCertificateV2` function (near line 108):

```ts
/** Friendly CAdES commitment-type name -> id-cti-ets-* OID. */
const COMMITMENT_OID: Record<string, string> = {
  'proof-of-origin': OID.ctiProofOfOrigin,
  'proof-of-receipt': OID.ctiProofOfReceipt,
  'proof-of-delivery': OID.ctiProofOfDelivery,
  'proof-of-sender': OID.ctiProofOfSender,
  'proof-of-approval': OID.ctiProofOfApproval,
  'proof-of-creation': OID.ctiProofOfCreation,
};
const COMMITMENT_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(COMMITMENT_OID).map(([name, oid]) => [oid, name]),
);

/** Resolve a commitment type to its OID: a known name maps to its id-cti OID,
 *  a well-formed dotted OID passes through; anything else throws. */
export function commitmentTypeOid(ct: string): string {
  if (ct in COMMITMENT_OID) return COMMITMENT_OID[ct];
  if (/^\d+(\.\d+)+$/.test(ct)) return ct;
  throw new UnsupportedFeatureError(`unknown commitmentType: ${ct}`);
}

/** CommitmentTypeIndication ::= SEQUENCE { commitmentTypeId OBJECT IDENTIFIER }. */
function commitmentTypeAttr(ct: string): Uint8Array {
  return attribute(OID.commitmentTypeIndication, der.sequence(der.oid(commitmentTypeOid(ct))));
}
```

Wire the build into `buildSignedData` — after the `signingCertificateV2` push (line ~127), before `const signedAttrsSet = sortedSet(...)`:

```ts
  if (opts.cades?.commitmentType) {
    signedAttrElements.push(commitmentTypeAttr(opts.cades.commitmentType));
  }
```

- [ ] **Step 5: Add parse support** (`src/cms.ts`)

Add to `interface ParsedCms` (after `timestampToken?`):

```ts
  /** CAdES commitment-type: the friendly name for a known OID, else the OID. */
  commitmentType?: string;
```

In `parseSignedData`, after the `messageDigest` extraction loop (line ~217), add:

```ts
  // CAdES commitment-type-indication, when present.
  let commitmentType: string | undefined;
  for (const attr of signedAttrsNode.children) {
    if (readOid(attr.children[0]) !== OID.commitmentTypeIndication) continue;
    const oid = readOid(attr.children[1].children[0].children[0]); // SET -> SEQUENCE -> OID
    commitmentType = COMMITMENT_NAME[oid] ?? oid;
  }
```

Add `commitmentType` to the returned object literal (near line 242, alongside `timestampToken`):

```ts
    commitmentType,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/cades.test.ts`
Expected: PASS (4 tests). Then `npm run typecheck` — clean.

- [ ] **Step 7: Commit**

```bash
git add src/asn1.ts src/cms.ts test/cades.test.ts
git commit -m "feat(38p): CAdES commitment-type signed attribute (build + parse)"
```

---

### Task 2: The signer-location attribute (build + parse)

**Files:**
- Modify: `src/cms.ts` (build helper, `ParsedCms.signerLocation`, parse)
- Test: `test/cades.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `SignerLocation`, `attribute`, `der`, `Asn1Node`, `OID` from Task 1 / `./asn1.js`.
- Produces: `ParsedCms.signerLocation?: SignerLocation`; module-internal `signerLocationEmits(loc: SignerLocation): boolean`.

- [ ] **Step 1: Write the failing test** (append to `test/cades.test.ts`)

```ts
describe('CAdES signer-location attribute', () => {
  it('round-trips country, locality, and a multi-line postal address', async () => {
    const signer = buildRsaSigner();
    const md = digestOf('loc');
    const location = { country: 'DE', locality: 'Berlin', postalAddress: ['Alexanderplatz 1', '10178'] };
    const cms = await buildSignedData(md, signer, { cades: { signerLocation: location } });
    const parsed = parseSignedData(cms);
    expect(parsed.signerLocation).toEqual(location);
    expect(verifySignedData(cms, md).signatureValid).toBe(true);
  });

  it('emits only the present sub-fields', async () => {
    const signer = buildRsaSigner();
    const cms = await buildSignedData(digestOf('c'), signer, {
      cades: { signerLocation: { country: 'FR' } },
    });
    expect(parseSignedData(cms).signerLocation).toEqual({ country: 'FR' });
  });

  it('omits the attribute for an all-empty signer location', async () => {
    const signer = buildRsaSigner();
    const cms = await buildSignedData(digestOf('e'), signer, {
      cades: { signerLocation: { postalAddress: [] } },
    });
    expect(parseSignedData(cms).signerLocation).toBeUndefined();
  });

  it('carries both commitment-type and signer-location together', async () => {
    const signer = buildRsaSigner();
    const md = digestOf('both');
    const cms = await buildSignedData(md, signer, {
      cades: { commitmentType: 'proof-of-approval', signerLocation: { locality: 'Paris' } },
    });
    const parsed = parseSignedData(cms);
    expect(parsed.commitmentType).toBe('proof-of-approval');
    expect(parsed.signerLocation).toEqual({ locality: 'Paris' });
    expect(verifySignedData(cms, md).signatureValid).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cades.test.ts -t signer-location`
Expected: FAIL — `parsed.signerLocation` is undefined.

- [ ] **Step 3: Add the build helper + wiring** (`src/cms.ts`)

Add below `commitmentTypeAttr` (from Task 1):

```ts
/** True when a SignerLocation would emit at least one sub-field. */
function signerLocationEmits(loc: SignerLocation): boolean {
  return loc.country !== undefined || loc.locality !== undefined
    || (loc.postalAddress !== undefined && loc.postalAddress.length > 0);
}

/** SignerLocation ::= SEQUENCE { [0] country, [1] locality, [2] postalAddress },
 *  each context tag EXPLICIT over a UTF8String (or SEQUENCE OF for [2]). Returns
 *  undefined when no sub-field is present. */
function signerLocationAttr(loc: SignerLocation): Uint8Array | undefined {
  if (!signerLocationEmits(loc)) return undefined;
  const parts: Uint8Array[] = [];
  if (loc.country !== undefined) parts.push(der.explicit(0, der.utf8String(loc.country)));
  if (loc.locality !== undefined) parts.push(der.explicit(1, der.utf8String(loc.locality)));
  if (loc.postalAddress !== undefined && loc.postalAddress.length > 0) {
    parts.push(der.explicit(2, der.sequence(...loc.postalAddress.map((l) => der.utf8String(l)))));
  }
  return attribute(OID.signerLocation, der.sequence(...parts));
}
```

Wire into `buildSignedData`, right after the commitment-type push from Task 1:

```ts
  if (opts.cades?.signerLocation) {
    const attr = signerLocationAttr(opts.cades.signerLocation);
    if (attr) signedAttrElements.push(attr);
  }
```

- [ ] **Step 4: Add parse support** (`src/cms.ts`)

Add to `interface ParsedCms` (after `commitmentType?`):

```ts
  /** CAdES signer-location, when present. */
  signerLocation?: SignerLocation;
```

Add a decode helper below `parseSignedData` (e.g. after the function, near line 250):

```ts
/** Decode a SignerLocation SEQUENCE (explicit [0]/[1]/[2] fields). */
function parseSignerLocation(node: Asn1Node): SignerLocation {
  const loc: SignerLocation = {};
  const td = new TextDecoder();
  for (const ch of node.children) {
    if (ch.tagClass !== 2) continue;
    if (ch.tag === 0) loc.country = td.decode(ch.children[0].content);
    else if (ch.tag === 1) loc.locality = td.decode(ch.children[0].content);
    else if (ch.tag === 2) loc.postalAddress = ch.children[0].children.map((c) => td.decode(c.content));
  }
  return loc;
}
```

In `parseSignedData`, extend the commitment-type loop to also read signer-location. Replace the loop added in Task 1 with:

```ts
  // CAdES commitment-type-indication and signer-location, when present.
  let commitmentType: string | undefined;
  let signerLocation: SignerLocation | undefined;
  for (const attr of signedAttrsNode.children) {
    const attrOid = readOid(attr.children[0]);
    if (attrOid === OID.commitmentTypeIndication) {
      const oid = readOid(attr.children[1].children[0].children[0]); // SET -> SEQUENCE -> OID
      commitmentType = COMMITMENT_NAME[oid] ?? oid;
    } else if (attrOid === OID.signerLocation) {
      signerLocation = parseSignerLocation(attr.children[1].children[0]); // SET -> SEQUENCE
    }
  }
```

Add `signerLocation` to the returned object literal (next to `commitmentType`):

```ts
    signerLocation,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/cades.test.ts`
Expected: PASS (8 tests total). Then `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/cms.ts test/cades.test.ts
git commit -m "feat(38p): CAdES signer-location signed attribute (build + parse)"
```

---

### Task 3: Thread `cades` through Sign + PAdES gate + surface in report

**Files:**
- Modify: `src/signature.ts` (`SignOptions.cades`, re-export types)
- Modify: `src/document.ts` (gate + validation in `signCore`; pass `cades` to `buildSignedData`)
- Modify: `src/sigverify.ts` (`SignatureReport` fields + populate)
- Test: `test/sign-cades.test.ts` (create)

**Interfaces:**
- Consumes: `CadesAttributes`, `CommitmentType`, `SignerLocation`, `commitmentTypeOid` from `./cms.js`; `UnsupportedFeatureError` from `./errors.js`; `buildSigner`, `TestSigner` from `./helpers/build-signer.js`; `buildClassicPdf` from `./helpers/build-pdf.js`.
- Produces: `SignOptions.cades?: CadesAttributes`; `SignatureReport.commitmentType?: string`; `SignatureReport.signerLocation?: SignerLocation`.

- [ ] **Step 1: Add the option + re-exports** (`src/signature.ts`)

Extend the `./cms.js` import (currently `import { CmsSigner } from './cms.js';`):

```ts
import { CmsSigner, CadesAttributes, CommitmentType, SignerLocation } from './cms.js';
```

Re-export the types (add near the top-level exports, e.g. after the `SignOptions` interface):

```ts
export type { CadesAttributes, CommitmentType, SignerLocation } from './cms.js';
```

Add the field to `SignOptions` (after `timestampDigest?`):

```ts
  /** Optional CAdES signed attributes (commitment-type, signer-location).
   *  Requires `subFilter: 'PAdES'`; throws otherwise. */
  cades?: CadesAttributes;
```

- [ ] **Step 2: Write the failing test** (`test/sign-cades.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}

describe('Document.Sign with CAdES attributes', () => {
  it('embeds commitment-type + signer-location and reads them back via VerifySignatures', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'CAdES' }); // force full-rewrite path
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), {
      subFilter: 'PAdES',
      cades: {
        commitmentType: 'proof-of-origin',
        signerLocation: { country: 'DE', locality: 'Berlin', postalAddress: ['Alexanderplatz 1'] },
      },
    });
    const reopened = Document.Open(doc.Save());
    const report = (await reopened.VerifySignatures())[0];
    expect(report.signature).toBe('valid');
    expect(report.integrity).toBe('valid');
    expect(report.commitmentType).toBe('proof-of-origin');
    expect(report.signerLocation).toEqual({
      country: 'DE', locality: 'Berlin', postalAddress: ['Alexanderplatz 1'],
    });
  });

  it('rejects cades attributes without subFilter PAdES', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await expect(doc.Sign(signerOf(buildSigner()), {
      cades: { commitmentType: 'proof-of-origin' },
    })).rejects.toThrow(UnsupportedFeatureError);
  });

  it('rejects an unknown commitment type', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    await expect(doc.Sign(signerOf(buildSigner()), {
      subFilter: 'PAdES', cades: { commitmentType: 'bogus' },
    })).rejects.toThrow(UnsupportedFeatureError);
  });

  it('ignores an all-empty cades object (no gate, no attributes)', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'empty' });
    await doc.Sign(signerOf(buildSigner()), { cades: { signerLocation: {} } });
    const report = (await Document.Open(doc.Save()).VerifySignatures())[0];
    expect(report.signature).toBe('valid');
    expect(report.commitmentType).toBeUndefined();
    expect(report.signerLocation).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/sign-cades.test.ts`
Expected: FAIL — no gate/validation, and `report.commitmentType` / `report.signerLocation` are undefined on the happy path.

- [ ] **Step 4: Add the gate + validation, and pass `cades` through** (`src/document.ts`)

In `signCore` (near line 899, right after `subFilterName(opts); // validate subfilter early`), add:

```ts
    if (opts.cades) {
      const c = opts.cades;
      const emitsLocation = !!c.signerLocation && (
        c.signerLocation.country !== undefined || c.signerLocation.locality !== undefined
        || (c.signerLocation.postalAddress !== undefined && c.signerLocation.postalAddress.length > 0));
      const emits = c.commitmentType !== undefined || emitsLocation;
      if (emits && opts.subFilter !== 'PAdES')
        throw new UnsupportedFeatureError('CAdES signed attributes require subFilter: "PAdES"');
      if (c.commitmentType !== undefined) commitmentTypeOid(c.commitmentType); // validate early (throws)
    }
```

Add `commitmentTypeOid` to the `./cms.js` import in `document.ts` (currently `import { buildSignedData, CmsSigner } from './cms.js';`):

```ts
import { buildSignedData, CmsSigner, commitmentTypeOid } from './cms.js';
```

Pass `cades` into `buildSignedData` at line ~957. Replace:

```ts
    const cms = await buildSignedData(digest, cmsSigner, { signingCertificateV2: opts.subFilter === 'PAdES' });
```

with:

```ts
    const cms = await buildSignedData(digest, cmsSigner, {
      signingCertificateV2: opts.subFilter === 'PAdES',
      cades: opts.cades,
    });
```

- [ ] **Step 5: Surface the values in the report** (`src/sigverify.ts`)

Add to `interface SignatureReport` (after `signerCert?`, near line 87):

```ts
  /** CAdES commitment-type (friendly name or OID), when the signature carries it. */
  commitmentType?: string;
  /** CAdES signer-location, when the signature carries it. */
  signerLocation?: SignerLocation;
```

Import `SignerLocation` — extend the `./cms.js` import at the top of `sigverify.ts` (currently `import { parseSignedData, verifySignedData } from './cms.js';`):

```ts
import { parseSignedData, verifySignedData, SignerLocation } from './cms.js';
```

In `verifySignature`, after `base.signerCert = certInfo(res.signerCertificate);` (line ~116), add:

```ts
    base.commitmentType = parsed.commitmentType;
    base.signerLocation = parsed.signerLocation;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/sign-cades.test.ts`
Expected: PASS (4 tests). Then the full suite + typecheck:

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/signature.ts src/document.ts src/sigverify.ts test/sign-cades.test.ts
git commit -m "feat(38p): thread cades attrs through Sign + PAdES gate + report"
```

---

### Task 4: Public exports + README

**Files:**
- Modify: `src/index.ts` (barrel export of the three types)
- Modify: `README.md`
- Test: `test/sign-cades.test.ts` (add an export smoke check)

**Interfaces:**
- Consumes: `CadesAttributes`, `CommitmentType`, `SignerLocation` (re-exported from `./signature.js`).
- Produces: the three types on the public surface; README documents `cades`.

- [ ] **Step 1: Export the types from the barrel** (`src/index.ts`)

Extend the signature.js type export block (line 65-67) to include the three types:

```ts
export type {
  SignOptions, SignatureAppearance, SignatureField, CertifyOptions, DocMdpPermission,
  CadesAttributes, CommitmentType, SignerLocation,
} from './signature.js';
```

- [ ] **Step 2: Add an export smoke test** (append to `test/sign-cades.test.ts`)

```ts
import type { CadesAttributes, CommitmentType, SignerLocation } from '../src/index.js';

describe('public surface', () => {
  it('exposes the CAdES types through the barrel', () => {
    const ct: CommitmentType = 'proof-of-origin';
    const loc: SignerLocation = { country: 'DE' };
    const cades: CadesAttributes = { commitmentType: ct, signerLocation: loc };
    // Type-level check; a runtime assertion keeps vitest happy.
    expect(cades.commitmentType).toBe('proof-of-origin');
  });
});
```

- [ ] **Step 3: Run the test + typecheck**

Run: `npx vitest run test/sign-cades.test.ts && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 4: Update `README.md`**

In the **Digital signatures** Features bullet, after the PAdES-B-T timestamp sentence, add:

```markdown
Pass `opts.cades` (requires `subFilter: 'PAdES'`) to embed CAdES signed attributes — a `commitmentType` (one of `'proof-of-origin' | 'proof-of-receipt' | 'proof-of-delivery' | 'proof-of-sender' | 'proof-of-approval' | 'proof-of-creation'`, or a custom OID string) and a structured `signerLocation` (`country` / `locality` / `postalAddress`). `VerifySignatures` reads them back on each `SignatureReport` (`commitmentType`, `signerLocation`).
```

- [ ] **Step 5: Full verification + commit**

Run: `npm run typecheck && npm test`
Expected: all green.

```bash
git add src/index.ts README.md test/sign-cades.test.ts
git commit -m "feat(38p): export CAdES types + document opts.cades"
```

---

## Self-Review Notes

**Spec coverage:**
- API (`cades` nested object; `CommitmentType` friendly+OID; structured `SignerLocation`) → Tasks 1–3.
- DER encoding (commitment `SEQUENCE { OID }`; signer-location explicit `[0]/[1]/[2]`, UTF8String, SEQUENCE OF for postalAddress; friendly→OID map; append after signing-cert-v2, existing `sortedSet`) → Tasks 1, 2.
- Verification read-back (`ParsedCms` + `SignatureReport` fields; known-OID→name) → Tasks 1, 2, 3.
- Gating (cades requires PAdES; empty cades no-op) + input validation (unknown commitment throws) → Tasks 1 (`commitmentTypeOid`), 3 (gate).
- Tests (CMS round-trip, exact-DER via signature-valid + parse, custom OID, multi-line/partial location, doc-level sign+verify, gating/bad-input throws) → Tasks 1, 2, 3.
- README + public export → Task 4.

**Type consistency:** `CommitmentType` / `SignerLocation` / `CadesAttributes` defined once in `cms.ts`, re-exported via `signature.ts` and `index.ts`. `commitmentTypeOid`, `signerLocationEmits`, `commitmentTypeAttr`, `signerLocationAttr`, `parseSignerLocation`, `COMMITMENT_OID`/`COMMITMENT_NAME` are used consistently. `ParsedCms.commitmentType/signerLocation` and `SignatureReport.commitmentType/signerLocation` share names and types. `buildSignedData(md, signer, { cades })` signature matches every call site.

**Placeholders:** none — every code and test step is complete.
