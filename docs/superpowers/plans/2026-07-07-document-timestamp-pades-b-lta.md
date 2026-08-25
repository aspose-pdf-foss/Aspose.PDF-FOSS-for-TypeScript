# Document timestamp (`/DocTimeStamp`) + PAdES-B-LTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Document.AddDocumentTimestamp` (an ETSI.RFC3161 `/DocTimeStamp` incremental overlay), verify it via `VerifyDocumentTimestamps`, and classify each signature's PAdES baseline level (`padesLevel`), so a B-LT document plus a document timestamp verifies as B-LTA.

**Architecture:** A `/DocTimeStamp` is a `FT /Sig` field whose value dict is `Type /DocTimeStamp` / `SubFilter /ETSI.RFC3161` and whose `/Contents` is the raw RFC 3161 TimeStampToken (imprint = digest of the `/ByteRange`), written as an incremental append. Authoring reuses `appendSignatureUpdate` + `fillSignature`; verification reuses `verifyTimestampToken` by feeding it the concatenated `/ByteRange` bytes. `padesLevel` is a structural presence-ladder computed in `VerifySignatures` from embedded/document timestamps and `/DSS` material.

**Tech Stack:** TypeScript (strict, NodeNext ESM, `.js` import specifiers), vitest, `node:crypto`. Zero runtime dependencies.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries a `.js` extension.
- Throw `UnsupportedFeatureError` (from `errors.js`) for unsupported states.
- Run `npm run typecheck` and `npm test` before considering any task done; both must be green.
- Follow existing patterns; keep files focused. TDD, frequent commits.
- PDF names in `PdfDict` are keyed WITHOUT the leading `/` (e.g. `'DocTimeStamp'`).

---

### Task 1: Pure helpers in `signature.ts` — `byteRangeContent` + `buildDocTimeStampDict`

**Files:**
- Modify: `src/signature.ts` (append two functions after `digestByteRange`, ~line 166)
- Test: `test/sign-doctimestamp.test.ts` (new)

**Interfaces:**
- Consumes: `PdfObject`, `PdfDict`, `name` (already imported in `signature.ts`).
- Produces:
  - `export function byteRangeContent(bytes: Uint8Array, byteRange: [number, number, number, number]): Uint8Array` — the two `/ByteRange` segments concatenated.
  - `export function buildDocTimeStampDict(): PdfDict` — `{ Type /DocTimeStamp, Filter /Adobe.PPKLite, SubFilter /ETSI.RFC3161 }` (writer fills `/ByteRange` + `/Contents`).

- [ ] **Step 1: Write the failing test**

Create `test/sign-doctimestamp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { byteRangeContent, buildDocTimeStampDict } from '../src/signature.js';
import { isName } from '../src/types.js';

describe('signature.ts doc-timestamp helpers', () => {
  it('byteRangeContent concatenates the two /ByteRange segments', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Hole at [3, 6): first segment [0,3), second segment [6, 6+3)=[6,9).
    const out = byteRangeContent(bytes, [0, 3, 6, 3]);
    expect(Array.from(out)).toEqual([0, 1, 2, 6, 7, 8]);
  });

  it('buildDocTimeStampDict carries the /DocTimeStamp value-dict keys', () => {
    const d = buildDocTimeStampDict();
    const type = d.get('Type'); const filter = d.get('Filter'); const sf = d.get('SubFilter');
    expect(isName(type) && type.name).toBe('DocTimeStamp');
    expect(isName(filter) && filter.name).toBe('Adobe.PPKLite');
    expect(isName(sf) && sf.name).toBe('ETSI.RFC3161');
    expect(d.has('ByteRange')).toBe(false);
    expect(d.has('Contents')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sign-doctimestamp.test.ts`
Expected: FAIL — `byteRangeContent` / `buildDocTimeStampDict` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/signature.ts`, after `digestByteRange` (the function ending ~line 166), add:

```ts
/** The two `/ByteRange` segments of `bytes` concatenated (the companion to
 *  {@link digestByteRange}, which returns their hash). Used to verify a
 *  `/DocTimeStamp`, whose token message-imprint is over these raw bytes. */
export function byteRangeContent(bytes: Uint8Array, byteRange: [number, number, number, number]): Uint8Array {
  const [, a, b, c] = byteRange;
  const out = new Uint8Array(a + c);
  out.set(bytes.subarray(0, a), 0);
  out.set(bytes.subarray(b, b + c), a);
  return out;
}

/** Build the `/DocTimeStamp` value dictionary (without `/ByteRange` or
 *  `/Contents`, which the writer fills). A document timestamp is an RFC 3161
 *  token over the `/ByteRange`; it carries no `/M`/`/Reason`/etc. */
export function buildDocTimeStampDict(): PdfDict {
  return new Map<string, PdfObject>([
    ['Type', name('DocTimeStamp')],
    ['Filter', name('Adobe.PPKLite')],
    ['SubFilter', name('ETSI.RFC3161')],
  ]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sign-doctimestamp.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/signature.ts test/sign-doctimestamp.test.ts
git commit -m "feat(zn6): byteRangeContent + buildDocTimeStampDict helpers"
```

---

### Task 2: Extract shared widget-attach helper `attachSigWidget`

Pure refactor of `installSignatureField` so both signing and the new timestamp path share the invisible-widget / `/Annots` / AcroForm wiring. No behavior change — the deliverable is verified by the existing signing suite staying green.

**Files:**
- Modify: `src/document.ts` — `installSignatureField` (lines ~1125-1195)

**Interfaces:**
- Produces (private): `attachSigWidget(widget: PdfDict, pageNum: number, touched: Set<number>): PdfRef` — allocates `widget`, attaches it to page `pageNum`'s `/Annots`, ensures an `/AcroForm` with the field + `/SigFlags |= 3`, records touched object numbers, and returns the widget ref.

- [ ] **Step 1: Add the shared helper**

In `src/document.ts`, add this private method immediately before `installSignatureField` (~line 1125):

```ts
  /** Allocate `widget`, attach it to page `pageNum`'s `/Annots`, and ensure an
   *  `/AcroForm` carrying it as a field with the signature flags. Records every
   *  touched object number in `touched`; returns the widget's ref. Shared by
   *  {@link installSignatureField} and {@link AddDocumentTimestamp}. */
  private attachSigWidget(widget: PdfDict, pageNum: number, touched: Set<number>): PdfRef {
    const pageDict = this.objects.get(pageNum);
    if (!isDict(pageDict)) throw new UnsupportedFeatureError('cannot attach signature widget: target page is not a dict');

    const widgetRef = this.allocObject(widget);
    touched.add(widgetRef.num);

    // Attach the widget to the target page's /Annots.
    const annots = this.resolve(pageDict.get('Annots'));
    if (isArray(annots)) annots.push(widgetRef);
    else pageDict.set('Annots', [widgetRef]);
    touched.add(pageNum);

    // Ensure /AcroForm with this field and the signature flags.
    const catalog = this.catalog();
    let acro = this.resolve(catalog.get('AcroForm'));
    const catRef = this.trailer.get('Root');
    if (!isDict(acro)) {
      acro = new Map<string, PdfObject>([['Fields', []], ['SigFlags', 3]]);
      const acroRef = this.allocObject(acro);
      catalog.set('AcroForm', acroRef);
      if (isRef(catRef)) touched.add(catRef.num);
      touched.add(acroRef.num);
    } else {
      const acroRefObj = catalog.get('AcroForm');
      if (isRef(acroRefObj)) touched.add(acroRefObj.num);
    }
    // When /Fields is an indirect array we mutate it in place, so its own object
    // must join the incremental delta (else the new widget would be dropped).
    const fieldsRef = acro.get('Fields');
    const fields = this.resolve(fieldsRef);
    if (isArray(fields)) {
      fields.push(widgetRef);
      if (isRef(fieldsRef)) touched.add(fieldsRef.num);
    } else {
      acro.set('Fields', [widgetRef]);
    }
    const flags = acro.get('SigFlags');
    acro.set('SigFlags', (typeof flags === 'number' ? flags : 0) | 3);

    return widgetRef;
  }
```

- [ ] **Step 2: Rewrite `installSignatureField` to delegate**

Replace the body of `installSignatureField` (from the `const touched` line through the final `return touched;`) with the version below. It builds the widget (and optional appearance) then calls `attachSigWidget`:

```ts
  private installSignatureField(
    sigRef: PdfRef, opts: SignOptions, certificate: Uint8Array, signingTime: Date,
  ): Set<number> {
    const touched = new Set<number>();
    const pageIndex = opts.appearance ? opts.appearance.page : 0;
    const pageNum = this.pageObjNums[pageIndex];

    const fieldName = opts.fieldName ?? `Signature${this.nextSignatureIndex()}`;
    const widget: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Annot')],
      ['Subtype', name('Widget')],
      ['FT', name('Sig')],
      ['T', pdfString(fieldName)],
      ['Rect', opts.appearance ? [...opts.appearance.rect] : [0, 0, 0, 0]],
      ['F', 132], // Print + LockedContents
      ['V', sigRef],
      ['P', ref(pageNum)],
    ]);

    // Generate the visible appearance (/AP /N), tracking every object it allocates
    // (form stream, font, image) so the incremental-update delta includes them.
    if (opts.appearance) {
      const displayName = signerDisplayName(opts, certificate);
      const text = opts.appearance.text ?? defaultAppearanceText(opts, signingTime, displayName);
      const before = new Set(this.objects.keys());
      const stream = buildSignatureAppearance(this, opts.appearance, text);
      const apRef = this.allocObject(stream);
      widget.set('AP', new Map<string, PdfObject>([['N', apRef]]));
      for (const k of this.objects.keys()) if (!before.has(k)) touched.add(k);
    }

    this.attachSigWidget(widget, pageNum, touched);
    return touched;
  }
```

Note: this switches the `/T` construction to `pdfString(fieldName)` (identical bytes to the previous inline `{ kind: 'string', bytes: new TextEncoder().encode(fieldName) }`). Ensure `pdfString` is imported — see Step 3.

- [ ] **Step 3: Import `pdfString`**

In `src/document.ts`, extend the `./signature.js` import (lines ~46-50) to include `pdfString`:

```ts
import {
  SignOptions, CertifyOptions, DocMdpPermission, SignatureField,
  buildSigValueDict, buildDocMdpReference, subFilterName,
  digestByteRange, digestName, derTotalLength, pdfString,
} from './signature.js';
```

- [ ] **Step 4: Typecheck + run the signing suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx vitest run test/verify.test.ts test/sign-chain.test.ts test/sign-timestamp.test.ts test/docmdp-verify.test.ts test/sign-incremental-dirty.test.ts test/dss.test.ts`
Expected: all PASS (behavior unchanged by the refactor).

- [ ] **Step 5: Commit**

```bash
git add src/document.ts
git commit -m "refactor(zn6): extract attachSigWidget from installSignatureField"
```

---

### Task 3: `Document.AddDocumentTimestamp` + read model

**Files:**
- Modify: `src/signature.ts` — add `isDocTimeStamp` to `SignatureField`; set it in… (read side is in `document.ts`)
- Modify: `src/document.ts` — `readSignatureField`, `Signatures` getter, add `DocumentTimestamps` getter + `nextDocTimestampIndex`, add `AddDocumentTimestamp`, add imports.
- Test: `test/sign-doctimestamp.test.ts` (extend)

**Interfaces:**
- Consumes: `byteRangeContent`/`buildDocTimeStampDict` (Task 1), `attachSigWidget` (Task 2), `appendSignatureUpdate`, `fillSignature`, `digestByteRange`, `buildTimeStampRequest`, `extractTimeStampToken`, `TimestampProvider`, `DigestAlgorithm`.
- Produces:
  - `SignatureField.isDocTimeStamp: boolean`.
  - `export interface DocumentTimestampOptions { digest?: DigestAlgorithm; placeholderBytes?: number; fieldName?: string }` (in `signature.ts`).
  - `Document.get DocumentTimestamps(): SignatureField[]`.
  - `async Document.AddDocumentTimestamp(tsa: TimestampProvider, opts?: DocumentTimestampOptions): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append to `test/sign-doctimestamp.test.ts`:

```ts
import { Document } from '../src/document.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { buildTimeStampToken } from '../src/rfc3161.js';
import type { CmsSigner } from '../src/cms.js';
import { parseTstInfo } from '../src/rfc3161.js';

function signerOf(t: TestSigner): { certificate: Uint8Array; privateKey: any } {
  return { certificate: t.certificate, privateKey: t.privateKey };
}
function testTsa(t: TestSigner): (req: Uint8Array) => Promise<Uint8Array> {
  const signer: CmsSigner = { certificate: t.certificate, privateKey: t.privateKey };
  return (req) => buildTimeStampToken(req, signer);
}

describe('Document.AddDocumentTimestamp — authoring + read model', () => {
  it('appends a /DocTimeStamp via incremental update and lists it separately', async () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'dts' });
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'signed' });
    const signedBytes = doc.Save();

    const doc2 = Document.Open(signedBytes);
    await doc2.AddDocumentTimestamp(testTsa(buildSigner({ type: 'rsa', commonName: 'Test TSA' })));
    const out = doc2.Save();

    // Incremental append: the signed revision is preserved byte-for-byte.
    expect(out.subarray(0, signedBytes.length)).toEqual(signedBytes);

    const re = Document.Open(out);
    // Real signatures exclude the timestamp; DocumentTimestamps lists only it.
    expect(re.Signatures).toHaveLength(1);
    expect(re.Signatures[0].isDocTimeStamp).toBe(false);
    expect(re.DocumentTimestamps).toHaveLength(1);
    const dts = re.DocumentTimestamps[0];
    expect(dts.isDocTimeStamp).toBe(true);
    expect(dts.subFilter).toBe('ETSI.RFC3161');
    expect(dts.name).toBe('Timestamp1');
    // The /Contents is a parseable RFC 3161 token whose imprint is over the doc.
    const token = dts.contents!.subarray(0, dts.cmsLength);
    expect(() => parseTstInfo(token)).not.toThrow();
  });
});
```

Note: the `AddDocumentTimestamp` "no base image" guard (`throw UnsupportedFeatureError`) is not reachable through the public API — the `Document` constructor is private and every `Document.Open`/`OpenFile` result carries `originalBytes` — so there is no unit test for it; it remains a defensive guard.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sign-doctimestamp.test.ts`
Expected: FAIL — `AddDocumentTimestamp` / `DocumentTimestamps` / `isDocTimeStamp` do not exist.

- [ ] **Step 3a: Add `isDocTimeStamp` to the `SignatureField` interface + `DocumentTimestampOptions`**

In `src/signature.ts`, add to the `SignatureField` interface (after `coversWholeFile`):

```ts
  /** Whether this is a document timestamp (`/DocTimeStamp` / `ETSI.RFC3161`)
   *  rather than an approval/certification signature. */
  isDocTimeStamp: boolean;
```

And add near `SignOptions` (e.g. after `CertifyOptions`):

```ts
/** Options for {@link Document.AddDocumentTimestamp}. */
export interface DocumentTimestampOptions {
  /** Imprint hash algorithm for the timestamp request. Default `'sha256'`. */
  digest?: DigestAlgorithm;
  /** Reserved `/Contents` capacity in bytes. Default 16384 — the token embeds
   *  the TSA certificate, so the signature default is usually too small. */
  placeholderBytes?: number;
  /** Field name (`/T`); defaults to `Timestamp<n>`. */
  fieldName?: string;
}
```

(`DigestAlgorithm` is already imported in `signature.ts` from `./sigalg.js`.)

- [ ] **Step 3b: Set `isDocTimeStamp` in `readSignatureField`**

In `src/document.ts`, update `readSignatureField` (~line 1224). In the unsigned early-return add `isDocTimeStamp: false`, and compute it for the signed path:

```ts
  private readSignatureField(field: PdfDict): SignatureField {
    const nameObj = field.get('T');
    const fieldName = isString(nameObj) ? new TextDecoder().decode(nameObj.bytes) : '';
    const value = this.resolve(field.get('V'));
    if (!isDict(value)) {
      return { name: fieldName, subFilter: '', isSigned: false, valueDict: new Map(), coversWholeFile: false, isDocTimeStamp: false };
    }
    const sf = value.get('SubFilter');
    const subFilter = isName(sf) ? sf.name : '';
    const typeObj = value.get('Type');
    const isDocTimeStamp = (isName(typeObj) && typeObj.name === 'DocTimeStamp') || subFilter === 'ETSI.RFC3161';
    const br = this.resolve(value.get('ByteRange'));
    const byteRange = isArray(br) && br.length === 4 && br.every((x) => typeof x === 'number')
      ? (br as number[] as [number, number, number, number]) : undefined;
    const contentsObj = value.get('Contents');
    const contents = isString(contentsObj) ? contentsObj.bytes : undefined;
    const cmsLength = contents ? derTotalLength(contents) : undefined;
    const coversWholeFile = byteRange !== undefined && byteRange[0] === 0 &&
      this.originalBytes !== undefined && byteRange[2] + byteRange[3] === this.originalBytes.length;
    return {
      name: fieldName, subFilter, isSigned: contents !== undefined, valueDict: value,
      byteRange, contents, cmsLength, coversWholeFile, isDocTimeStamp,
    };
  }
```

- [ ] **Step 3c: Filter `Signatures` and add `DocumentTimestamps`**

In `src/document.ts`, change the `Signatures` getter (~line 1208) so its final push skips timestamps, and add a sibling getter. Replace the loop tail:

```ts
  /** Every approval/certification signature field (read-side; always available).
   *  Document timestamps are excluded — see {@link DocumentTimestamps}. */
  get Signatures(): SignatureField[] {
    const out: SignatureField[] = [];
    const acro = this.resolve(this.catalog().get('AcroForm'));
    if (!isDict(acro)) return out;
    const fields = this.resolve(acro.get('Fields'));
    if (!isArray(fields)) return out;
    for (const f of fields) {
      const field = this.resolve(f);
      if (!isDict(field)) continue;
      const ft = field.get('FT');
      if (!isName(ft) || ft.name !== 'Sig') continue;
      const sig = this.readSignatureField(field);
      if (!sig.isDocTimeStamp) out.push(sig);
    }
    return out;
  }

  /** Every document-timestamp field (`/DocTimeStamp`), read-side. */
  get DocumentTimestamps(): SignatureField[] {
    const out: SignatureField[] = [];
    const acro = this.resolve(this.catalog().get('AcroForm'));
    if (!isDict(acro)) return out;
    const fields = this.resolve(acro.get('Fields'));
    if (!isArray(fields)) return out;
    for (const f of fields) {
      const field = this.resolve(f);
      if (!isDict(field)) continue;
      const ft = field.get('FT');
      if (!isName(ft) || ft.name !== 'Sig') continue;
      const sig = this.readSignatureField(field);
      if (sig.isDocTimeStamp) out.push(sig);
    }
    return out;
  }

  /** 1-based index for the next auto-named document-timestamp field. */
  private nextDocTimestampIndex(): number {
    return this.DocumentTimestamps.length + 1;
  }
```

- [ ] **Step 3d: Add imports for the timestamp path**

In `src/document.ts`, extend the `./signature.js` import to add `buildDocTimeStampDict` and the options type:

```ts
import {
  SignOptions, CertifyOptions, DocMdpPermission, SignatureField,
  buildSigValueDict, buildDocMdpReference, subFilterName,
  digestByteRange, digestName, derTotalLength, pdfString,
  buildDocTimeStampDict, DocumentTimestampOptions,
} from './signature.js';
```

And add a new import for the RFC 3161 request helpers + provider type (near line 43-44):

```ts
import { buildTimeStampRequest, extractTimeStampToken, type TimestampProvider } from './rfc3161.js';
import type { DigestAlgorithm } from './sigalg.js';
```

- [ ] **Step 3e: Add `AddDocumentTimestamp`**

In `src/document.ts`, add this method just after `AddValidationData` (~line 1020). Define the default placeholder constant at the top of the method:

```ts
  /** Append a document timestamp (`/DocTimeStamp`, ETSI.RFC3161) as an
   *  incremental update, enabling PAdES-B-LTA archival on top of B-LT. Builds an
   *  invisible signature field whose value dict is `/DocTimeStamp` and whose
   *  `/Contents` is the RFC 3161 token returned by `tsa` over the `/ByteRange`
   *  digest. Requires an existing byte image to append to; the result is returned
   *  by the next {@link Save}/{@link WriteTo}. Async because the TSA callback is. */
  async AddDocumentTimestamp(tsa: TimestampProvider, opts: DocumentTimestampOptions = {}): Promise<void> {
    const base = this.pendingSignedBytes ?? this.originalBytes;
    if (!base)
      throw new UnsupportedFeatureError('AddDocumentTimestamp requires an existing document to append to');
    if (this.Pages.length === 0)
      throw new UnsupportedFeatureError('cannot timestamp a document with no pages');
    this.finalizeEmbeddedFonts();

    const hashAlg: DigestAlgorithm = opts.digest ?? 'sha256';
    const placeholderBytes = opts.placeholderBytes ?? 16384;
    const fieldName = opts.fieldName ?? `Timestamp${this.nextDocTimestampIndex()}`;

    // Build the /DocTimeStamp value dict + an invisible widget wired into the
    // AcroForm and the first page's /Annots.
    const dtsDict = buildDocTimeStampDict();
    const dtsRef = this.allocObject(dtsDict);
    const touched = new Set<number>();
    const pageNum = this.pageObjNums[0];
    const widget: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Annot')],
      ['Subtype', name('Widget')],
      ['FT', name('Sig')],
      ['T', pdfString(fieldName)],
      ['Rect', [0, 0, 0, 0]],
      ['F', 132],
      ['V', dtsRef],
      ['P', ref(pageNum)],
    ]);
    this.attachSigWidget(widget, pageNum, touched);

    // Serialize with a /Contents placeholder + /ByteRange, then digest the range,
    // request a token, and drop the token in.
    const layout = appendSignatureUpdate(base, {
      sigObjNum: dtsRef.num,
      sigDict: dtsDict,
      objects: this.collectObjects(touched),
      placeholderBytes,
    });
    const imprint = digestByteRange(layout.bytes, layout.byteRange, hashAlg);
    const request = buildTimeStampRequest(imprint, hashAlg);
    const token = extractTimeStampToken(await tsa(request));
    fillSignature(layout.bytes, layout, token);
    this.pendingSignedBytes = layout.bytes;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sign-doctimestamp.test.ts`
Expected: PASS. Fix the "no base" test per its Step-1 note if `new Document()` is not valid.

Run: `npm run typecheck`
Expected: no errors (every `SignatureField` literal now includes `isDocTimeStamp` — the two in `readSignatureField` are the only ones; the compiler flags any missed).

- [ ] **Step 5: Commit**

```bash
git add src/signature.ts src/document.ts test/sign-doctimestamp.test.ts
git commit -m "feat(zn6): AddDocumentTimestamp + DocumentTimestamps read model"
```

---

### Task 4: Verify — `verifyDocumentTimestamp` + `VerifyDocumentTimestamps`

**Files:**
- Modify: `src/sigverify.ts` — add `DocumentTimestampReport` + `verifyDocumentTimestamp`.
- Modify: `src/document.ts` — add `VerifyDocumentTimestamps`; import the new symbols.
- Modify: `src/index.ts` — export `DocumentTimestampReport`.
- Test: `test/sign-doctimestamp.test.ts` (extend)

**Interfaces:**
- Consumes: `byteRangeContent` (Task 1), `verifyTimestampToken` + `TimestampInfo` (already imported in `sigverify.ts`), `parseSignedData`, `certInfo`, `revisionChanges` (module-local), `SignatureField`.
- Produces:
  - `export interface DocumentTimestampReport { name: string; timestamp: TimestampInfo; coversWholeFile: boolean; modifications: Change[]; signerCert?: CertInfo }`.
  - `export function verifyDocumentTimestamp(bytes: Uint8Array, sig: SignatureField): DocumentTimestampReport`.
  - `async Document.VerifyDocumentTimestamps(): Promise<DocumentTimestampReport[]>`.

- [ ] **Step 1: Write the failing test**

Append to `test/sign-doctimestamp.test.ts`:

```ts
describe('Document.VerifyDocumentTimestamps', () => {
  async function timestamped(): Promise<Uint8Array> {
    const doc = Document.Open(buildClassicPdf(1));
    doc.SetMetadata({ title: 'dts-verify' });
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'signed' });
    const doc2 = Document.Open(doc.Save());
    await doc2.AddDocumentTimestamp(testTsa(buildSigner({ type: 'rsa', commonName: 'Test TSA' })));
    return doc2.Save();
  }

  it('verifies the document timestamp (imprint + TSA signature)', async () => {
    const out = await timestamped();
    const reports = await Document.Open(out).VerifyDocumentTimestamps();
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.name).toBe('Timestamp1');
    expect(r.timestamp.valid).toBe(true);
    expect(r.timestamp.imprintMatches).toBe(true);
    expect(r.timestamp.tokenSignatureValid).toBe(true);
    expect(r.timestamp.time).toBeInstanceOf(Date);
    expect(r.coversWholeFile).toBe(true);
    expect(r.signerCert?.subject).toContain('Test TSA');
  });

  it('flips imprintMatches when the timestamped range is corrupted', async () => {
    const out = await timestamped();
    const dts = Document.Open(out).DocumentTimestamps[0];
    out[Math.floor(dts.byteRange![1] / 2)] ^= 0xff; // corrupt the covered range
    const r = (await Document.Open(out).VerifyDocumentTimestamps())[0];
    expect(r.timestamp.imprintMatches).toBe(false);
    expect(r.timestamp.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sign-doctimestamp.test.ts`
Expected: FAIL — `VerifyDocumentTimestamps` undefined.

- [ ] **Step 3a: Add `DocumentTimestampReport` + `verifyDocumentTimestamp` to `sigverify.ts`**

In `src/sigverify.ts`, extend the imports:

```ts
import { parseSignedData, verifySignedData, SignerLocation } from './cms.js';
import { verifyTimestampToken, type TimestampInfo } from './rfc3161.js';
import { digestByteRange, byteRangeContent } from './signature.js';
```

(The first two lines already exist — add `byteRangeContent` to the `./signature.js` import, which currently imports `digestByteRange`.)

Then add, after `verifySignature` (before `revisionChanges`, or after it — `revisionChanges` is hoisted):

```ts
/** Verdict for one document timestamp (`/DocTimeStamp`): the RFC 3161 token's
 *  time and imprint/TSA-signature checks, plus coverage and the TSA cert. */
export interface DocumentTimestampReport {
  /** Timestamp field name (`/T`). */
  name: string;
  /** RFC 3161 verdict: `time`, `imprintMatches`, `tokenSignatureValid`, `valid`. */
  timestamp: TimestampInfo;
  /** Whether the `/ByteRange` spans the whole file (no later revision). */
  coversWholeFile: boolean;
  /** Objects added/modified in revisions appended after this timestamp. */
  modifications: Change[];
  /** The TSA's certificate summary, when the token could be parsed. */
  signerCert?: CertInfo;
}

/** Verify one signed `/DocTimeStamp` field against the full file `bytes`:
 *  recompute the `/ByteRange` content, check the token's message-imprint binding
 *  and the TSA's CMS signature, and diff what changed after the timestamp.
 *  Assumes `sig.isDocTimeStamp` and that `byteRange`/`contents` are present. */
export function verifyDocumentTimestamp(bytes: Uint8Array, sig: SignatureField): DocumentTimestampReport {
  const failed: TimestampInfo = {
    time: new Date(0), imprintMatches: false, tokenSignatureValid: false,
    valid: false, policy: '', serialNumber: '',
  };
  const report: DocumentTimestampReport = {
    name: sig.name, timestamp: failed, coversWholeFile: sig.coversWholeFile, modifications: [],
  };
  if (!sig.byteRange || !sig.contents) return report;

  const token = sig.cmsLength !== undefined ? sig.contents.subarray(0, sig.cmsLength) : sig.contents;
  try {
    report.timestamp = verifyTimestampToken(token, byteRangeContent(bytes, sig.byteRange));
  } catch {
    // malformed token: keep the failed verdict
  }
  try {
    report.signerCert = certInfo(parseSignedData(token).signerCertificate);
  } catch {
    // no signer cert available
  }

  const signedEnd = sig.byteRange[2] + sig.byteRange[3];
  if (!sig.coversWholeFile && signedEnd < bytes.length)
    report.modifications = revisionChanges(bytes, signedEnd);
  return report;
}
```

- [ ] **Step 3b: Add `VerifyDocumentTimestamps` to `document.ts`**

In `src/document.ts`, extend the `./sigverify.js` import to add the new symbols:

```ts
import {
  SignatureReport, VerifyOptions, RevocationFetcher,
  verifySignature, checkSignatureRevocation,
  DocumentTimestampReport, verifyDocumentTimestamp,
} from './sigverify.js';
```

Then add the method just after `VerifySignatures` (~line 1056):

```ts
  /** Verify every document timestamp (`/DocTimeStamp`) in the document: check
   *  each token's message-imprint binding to the `/ByteRange` and the TSA's CMS
   *  signature, returning one {@link DocumentTimestampReport} per field. */
  async VerifyDocumentTimestamps(): Promise<DocumentTimestampReport[]> {
    const bytes = this.pendingSignedBytes ?? this.originalBytes;
    if (!bytes) return [];
    const src = Document.Open(bytes);
    return src.DocumentTimestamps.filter((t) => t.isSigned).map((t) => verifyDocumentTimestamp(bytes, t));
  }
```

- [ ] **Step 3c: Export `DocumentTimestampReport`**

In `src/index.ts`, add `DocumentTimestampReport` to the `./sigverify.js` type export (line ~72):

```ts
  SignatureReport, CertInfo, Change, VerifyOptions, RevocationFetcher,
  DocumentTimestampReport,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sign-doctimestamp.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/sigverify.ts src/document.ts src/index.ts test/sign-doctimestamp.test.ts
git commit -m "feat(zn6): verifyDocumentTimestamp + VerifyDocumentTimestamps"
```

---

### Task 5: `padesLevel` on `SignatureReport`

**Files:**
- Modify: `src/sigverify.ts` — add `padesLevel` field to `SignatureReport`.
- Modify: `src/document.ts` — compute `padesLevel` in `VerifySignatures`.
- Test: `test/sign-doctimestamp.test.ts` (extend)

**Interfaces:**
- Consumes: `verifyDocumentTimestamp` (Task 4), `readDssMaterial`/`readDssCerts` (already imported in `document.ts`).
- Produces: `SignatureReport.padesLevel?: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA'`.

- [ ] **Step 1: Write the failing test**

Append to `test/sign-doctimestamp.test.ts`:

```ts
import { buildOcspResponse } from './helpers/build-revocation.js';

describe('padesLevel classification', () => {
  it('classifies B-B / B-T / B-LT / B-LTA up the ladder', async () => {
    const s = buildSigner({ type: 'rsa' });
    const tsa = buildSigner({ type: 'rsa', commonName: 'Test TSA' });

    // B-B: bare signature, no timestamp, no DSS.
    const bDoc = Document.Open(buildClassicPdf(1));
    bDoc.SetMetadata({ title: 'b-b' });
    await bDoc.Sign(signerOf(s), { reason: 'plain' });
    const bBytes = bDoc.Save();
    expect((await Document.Open(bBytes).VerifySignatures())[0].padesLevel).toBe('B-B');

    // B-T: signature carries an embedded RFC 3161 signature-timestamp.
    const tDoc = Document.Open(buildClassicPdf(1));
    tDoc.SetMetadata({ title: 'b-t' });
    await tDoc.Sign(signerOf(s), { timestamp: testTsa(tsa), placeholderBytes: 16384 });
    const tBytes = tDoc.Save();
    expect((await Document.Open(tBytes).VerifySignatures())[0].padesLevel).toBe('B-T');

    // B-LT: add /DSS validation data over the B-T signature.
    const ocsp = buildOcspResponse({ responder: s, cert: s.certificate, issuer: s.certificate, status: 'good' });
    const ltDoc = Document.Open(tBytes);
    await ltDoc.AddValidationData({ getOCSP: () => ocsp });
    const ltBytes = ltDoc.Save();
    expect((await Document.Open(ltBytes).VerifySignatures())[0].padesLevel).toBe('B-LT');

    // B-LTA: add a document timestamp on top of the B-LT document.
    const ltaDoc = Document.Open(ltBytes);
    await ltaDoc.AddDocumentTimestamp(testTsa(tsa));
    const ltaBytes = ltaDoc.Save();
    expect((await Document.Open(ltaBytes).VerifySignatures())[0].padesLevel).toBe('B-LTA');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sign-doctimestamp.test.ts`
Expected: FAIL — `padesLevel` is `undefined`.

- [ ] **Step 3a: Add the field to `SignatureReport`**

In `src/sigverify.ts`, add to the `SignatureReport` interface (after `signerLocation?`):

```ts
  /** PAdES baseline level of this signature (structural presence, not trust):
   *  `B-B` (basic) → `B-T` (trusted time) → `B-LT` (long-term validation data)
   *  → `B-LTA` (archive timestamp). Undefined when not classified. */
  padesLevel?: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
```

- [ ] **Step 3b: Compute it in `VerifySignatures`**

In `src/document.ts`, inside `VerifySignatures`, after the `reports` are built and revocation is resolved but before `applyDocMdp` (~line 1051), insert the classification block:

```ts
    // PAdES baseline level (structural presence): B-B → B-T → B-LT → B-LTA.
    const docTsValid = src.DocumentTimestamps
      .filter((t) => t.isSigned)
      .some((t) => verifyDocumentTimestamp(bytes, t).timestamp.valid);
    const dssMaterial = readDssMaterial(src);
    const dssCerts = readDssCerts(src);
    reports.forEach((report) => {
      const hasT = report.timestamp?.valid === true || docTsValid;
      const hasLT = dssMaterial.has(report.name) || dssCerts.length > 0;
      const hasA = docTsValid;
      report.padesLevel = hasLT && hasA ? 'B-LTA' : hasLT ? 'B-LT' : hasT ? 'B-T' : 'B-B';
    });
```

Note: `readDssMaterial`/`readDssCerts` and `verifyDocumentTimestamp` are already imported (Tasks 4). `readDssMaterial` is already imported in `document.ts` (used for revocation fallback); `readDssCerts` too.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sign-doctimestamp.test.ts`
Expected: PASS (all describe blocks).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/sigverify.ts src/document.ts test/sign-doctimestamp.test.ts
git commit -m "feat(zn6): padesLevel (B-B/B-T/B-LT/B-LTA) on SignatureReport"
```

---

### Task 6: Export `DocumentTimestampOptions`, README, full gate

**Files:**
- Modify: `src/index.ts` — export `DocumentTimestampOptions`.
- Modify: `README.md` — extend the Digital signatures paragraph.

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: public exports + docs; no new code.

- [ ] **Step 1: Export the options type**

In `src/index.ts`, add `DocumentTimestampOptions` to the `./signature.js` type export (line ~66):

```ts
  SignOptions, SignatureAppearance, SignatureField, CertifyOptions, DocMdpPermission,
  DocumentTimestampOptions,
```

(Keep the existing members on that export; add the new name.)

- [ ] **Step 2: Update the README**

In `README.md`, at the end of the Digital signatures bullet (~line 60, after the `AddValidationData` sentence), append:

```markdown
 `await doc.AddDocumentTimestamp(tsa, opts?)` appends a standalone **document timestamp** (`/DocTimeStamp`, `ETSI.RFC3161`) as an incremental update — an RFC 3161 token (from the `tsa` callback) over the whole document image — enabling **PAdES-B-LTA** archival on top of B-LT; `doc.DocumentTimestamps` enumerates them and `await doc.VerifyDocumentTimestamps()` returns a `DocumentTimestampReport` per timestamp (imprint binding + TSA signature, asserted `time`, TSA `signerCert`, and post-timestamp modifications). `VerifySignatures` now also reports each signature's `padesLevel` (`'B-B' | 'B-T' | 'B-LT' | 'B-LTA'`), climbing the ladder as a trusted timestamp, embedded `/DSS` validation data, and an archive document timestamp are present.
```

- [ ] **Step 3: Full gate**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: the full suite passes, including `test/sign-doctimestamp.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts README.md
git commit -m "docs(zn6): export DocumentTimestampOptions + README doc-timestamp/B-LTA note"
```

- [ ] **Step 5: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-zn6
```

---

## Self-Review notes

- **Spec coverage:** `AddDocumentTimestamp` (Task 3) · incremental append asserted byte-for-byte (Task 3) · `VerifyDocumentTimestamps` (Task 4) · `padesLevel` B-LTA ladder (Task 5) · read-model separation (`Signatures` vs `DocumentTimestamps`, Task 3) · `byteRangeContent`/`buildDocTimeStampDict` (Task 1) · shared wiring refactor (Task 2) · exports (Tasks 4, 6) · README (Task 6) · tests each task. All spec sections map to a task.
- **Type consistency:** `isDocTimeStamp` added to `SignatureField` and populated in the two `readSignatureField` return sites; `DocumentTimestampReport` shape identical across `sigverify.ts` definition, `document.ts` consumer, and `index.ts` export; `padesLevel` union identical in interface and computation.
- **Placeholder default:** 16384 for document timestamps (token embeds the TSA cert), matching the value the signature-timestamp tests use.
- **Unreachable guard:** the `AddDocumentTimestamp` "no base image" throw is defensive only — the private constructor means every public `Document` has `originalBytes`. No unit test; noted inline in Task 3.
