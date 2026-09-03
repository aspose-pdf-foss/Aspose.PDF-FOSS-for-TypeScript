# Preserving encryption on save — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a document opened encrypted is written encrypted again, on both the full rewrite and the incremental append, reusing the original `/Encrypt` dict and file key.

**Architecture:** `buildDecryptor` already computes everything needed — `fileKey`, `streamCipher`, `stringCipher` — and discards it. Expose those three values, turn them into an `Encryptor` through the **existing** `makeEncryptor`, retain it on `Document`, and route both write paths through machinery that already exists. The `/Encrypt` dict is copied verbatim, never rebuilt.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, `node:crypto`. No runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-09-03-preserve-encryption-on-save-design.md`](../specs/2026-09-03-preserve-encryption-on-save-design.md)

**Issue:** `0cr3` (absorbed `61z2`)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every import specifier carries `.js`.
- **Strict TypeScript.** `npm run typecheck` green before any task is done.
- **Public error types only:** `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError`.
- **Both gates green before closing any task:** `npm run typecheck` and `npm test`.
- **CHANGELOG.md updated in the same commit** as any user-visible change, under `## [Unreleased]`, citing the issue id.
- **Do not use TodoWrite** — this project tracks work in `bd`.
- **THE PRIMARY FENCE: an unencrypted document's output must stay BYTE-IDENTICAL.** `test/serializer-signed.test.ts`, `test/docx-flow-identity.test.ts`, `test/html-identity.test.ts` and `test/rich-runs-identity.test.ts` must not move. If one does, the routing is wrong — do not refresh the golden.
- **Never rebuild the `/Encrypt` dict.** It carries `/O /U /P /V /R` (or `/Recipients`, `/CF`) — statements about credentials we do not hold. Copy it verbatim.
- **Never re-derive encryption from a password.** `buildEncryptor` defaults `ownerPassword ?? userPassword`, which silently equates them.

---

### Task 1: expose the file key, and build an encryptor from it

**Files:**
- Modify: `src/crypto.ts` (export `Cipher`, add `CryptKeys`, widen `Decryptor`, return keys from `buildDecryptor`)
- Modify: `src/pubsec.ts` (return keys from `buildPubSecDecryptor`)
- Modify: `src/encrypt.ts` (add `buildEncryptorFromKeys`)
- Test: `test/crypt-keys.test.ts`

**Interfaces:**
- Consumes: `makeEncryptor(encryptDict, strCipher, stmCipher)` and `Encryptor` from `./encrypt.js`; `rc4`, `aesCbcEncrypt`, `objectKeyV4` from `./crypto.js`
- Produces:
  - `export type Cipher = 'rc4' | 'aes128' | 'aes256' | 'identity'` (crypto.ts, newly exported)
  - `export interface CryptKeys { fileKey: Uint8Array; streamCipher: Cipher; stringCipher: Cipher }`
  - `Decryptor` gains `readonly keys: CryptKeys`
  - `buildPubSecDecryptor` returns `{ decryptObject, permissions, keys }`
  - `export function buildEncryptorFromKeys(keys: CryptKeys, encryptDict: PdfDict): Encryptor`

- [ ] **Step 1: Write the failing test**

Create `test/crypt-keys.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildEncryptorFromKeys } from '../src/encrypt.js';
import { CryptKeys } from '../src/crypto.js';
import { name, PdfDict, PdfObject, isString } from '../src/types.js';

const dict = (): PdfDict => new Map<string, PdfObject>([['Filter', name('Standard')]]);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const str = (s: string): PdfObject => ({ kind: 'string', bytes: bytes(s) });

// A 32-byte key satisfies every cipher: rc4 and aes128 derive a per-object key
// from it, aes256 uses it directly.
const KEY = new Uint8Array(32).map((_, i) => i * 7 + 1);

describe('buildEncryptorFromKeys', () => {
  for (const cipher of ['rc4', 'aes128', 'aes256'] as const) {
    it(`round-trips a string through ${cipher}`, async () => {
      const keys: CryptKeys = { fileKey: KEY, streamCipher: cipher, stringCipher: cipher };
      const enc = buildEncryptorFromKeys(keys, dict());
      const out = enc.encryptObject(str('SecretTitle'), 7, 0);
      expect(isString(out)).toBe(true);
      // Encrypted output must not be the plaintext.
      expect(new TextDecoder('latin1').decode((out as { bytes: Uint8Array }).bytes))
        .not.toContain('SecretTitle');
    });

    it(`round-trips a stream payload through ${cipher}`, () => {
      const keys: CryptKeys = { fileKey: KEY, streamCipher: cipher, stringCipher: cipher };
      const enc = buildEncryptorFromKeys(keys, dict());
      const out = enc.encryptStreamRaw(bytes('payload-bytes-here'), 7, 0);
      expect(new TextDecoder('latin1').decode(out)).not.toContain('payload');
    });
  }

  it('passes identity through unchanged', () => {
    const keys: CryptKeys = { fileKey: KEY, streamCipher: 'identity', stringCipher: 'identity' };
    const enc = buildEncryptorFromKeys(keys, dict());
    expect(enc.encryptStreamRaw(bytes('plain'), 1, 0)).toEqual(bytes('plain'));
  });

  it('carries the supplied /Encrypt dict verbatim', () => {
    const d = dict();
    d.set('R', 4);
    const enc = buildEncryptorFromKeys(
      { fileKey: KEY, streamCipher: 'rc4', stringCipher: 'rc4' }, d);
    expect(enc.encryptDict).toBe(d);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/crypt-keys.test.ts`
Expected: FAIL — `buildEncryptorFromKeys` is not exported from `../src/encrypt.js`.

- [ ] **Step 3: Export `Cipher` and add `CryptKeys` in `src/crypto.ts`**

Change the `Cipher` declaration (currently `type Cipher = 'rc4' | 'aes128' | 'aes256' | 'identity';` at line 104) to:

```ts
export type Cipher = 'rc4' | 'aes128' | 'aes256' | 'identity';

/** Everything needed to encrypt or decrypt a document's objects: the file key
 *  and the two crypt-filter choices. Password validation has already happened
 *  by the time these exist, so they are the whole of the crypto state. */
export interface CryptKeys {
  readonly fileKey: Uint8Array;
  readonly streamCipher: Cipher;
  readonly stringCipher: Cipher;
}
```

Widen the `Decryptor` interface (line 107):

```ts
export interface Decryptor {
  decryptObject(obj: PdfObject, num: number, gen: number): PdfObject;
  /** The same key and ciphers, so a save can encrypt what it writes with them
   *  instead of re-deriving from a password it does not have. */
  readonly keys: CryptKeys;
}
```

- [ ] **Step 4: Return the keys from `buildDecryptor`**

In `src/crypto.ts`, change the final `return { decryptObject };` of `buildDecryptor` to:

```ts
  return { decryptObject, keys: { fileKey, streamCipher, stringCipher } };
```

- [ ] **Step 5: Return the keys from `buildPubSecDecryptor`**

In `src/pubsec.ts`, widen the declared return type of `buildPubSecDecryptor` to include the keys and return them alongside. Its file key and ciphers are computed the same way; find the local names it uses and return:

```ts
  return { decryptObject, permissions, keys: { fileKey, streamCipher, stringCipher } };
```

Update its signature:

```ts
export function buildPubSecDecryptor(
  encrypt: PdfDict, recipient: NormalizedRecipient,
  resolve: (o: PdfObject | undefined) => PdfObject,
): { decryptObject: Decryptor['decryptObject']; permissions: Permissions; keys: CryptKeys } {
```

Import `CryptKeys` from `./crypto.js` there.

- [ ] **Step 6: Add `buildEncryptorFromKeys` to `src/encrypt.ts`**

Append to `src/encrypt.ts`:

```ts
/** An Encryptor that reuses a document's OWN key and `/Encrypt` dict.
 *
 *  This is the mirror of `buildDecryptor`'s `applyCipher`: RC4 is symmetric,
 *  AES swaps decrypt for encrypt, identity passes through. It exists because
 *  encryption CANNOT be re-derived from what an opened document retains — the
 *  owner password is hashed into `/O` and unrecoverable, and `buildEncryptor`
 *  defaults `ownerPassword ?? userPassword`, so re-deriving would silently
 *  equate them. The dict is carried VERBATIM for the same reason: `/O /U /P`
 *  are statements about credentials we do not hold. */
export function buildEncryptorFromKeys(keys: CryptKeys, encryptDict: PdfDict): Encryptor {
  const apply = (cipher: Cipher): CipherFn => {
    switch (cipher) {
      case 'identity': return (data) => data;
      case 'rc4': return (data, num, gen) => rc4(objectKeyV4(keys.fileKey, num, gen, false), data);
      case 'aes128': return (data, num, gen) => aesCbcEncrypt(objectKeyV4(keys.fileKey, num, gen, true), data);
      case 'aes256': return (data) => aesCbcEncrypt(keys.fileKey, data);
    }
  };
  return makeEncryptor(encryptDict, apply(keys.stringCipher), apply(keys.streamCipher));
}
```

Add to the existing `./crypto.js` import in `src/encrypt.ts`: `Cipher`, `CryptKeys`, `aesCbcEncrypt`, `objectKeyV4`, `rc4` (whichever are not already imported).

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/crypt-keys.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 8: Run both gates and commit**

```bash
npm run typecheck && npm test
git add src/crypto.ts src/pubsec.ts src/encrypt.ts test/crypt-keys.test.ts
git commit -m "feat(0cr3): expose the file key and build an encryptor from it"
```

---

### Task 2: retain the encryptor on Document

**Files:**
- Modify: `src/document.ts` (`BuildResult`, `build()`, a retained field)
- Test: `test/preserve-encryption.test.ts`

**Interfaces:**
- Consumes: `buildEncryptorFromKeys`, `CryptKeys`, `Encryptor`
- Produces: `Document`'s `private preservedEncryptor?: Encryptor`, and `BuildResult.preserved?: { keys: CryptKeys; encryptDict: PdfDict }`

- [ ] **Step 1: Write the failing test**

Create `test/preserve-encryption.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildEncryptedPdf } from './helpers/encrypt-pdf.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { Encryptor } from '../src/encrypt.js';

export const encryptedPdf = (cipher: 'rc4' | 'aes128' | 'aes256'): Uint8Array => {
  const cfg = cipher === 'rc4'
    ? { cipher, R: 3, V: 2, length: 128 } as const
    : cipher === 'aes128'
      ? { cipher, R: 4, V: 4, length: 128 } as const
      : { cipher, R: 6, V: 5, length: 256 } as const;
  return buildEncryptedPdf(cfg, { info: { Title: 'SecretTitle' }, pageContents: ['BT ET'] }).bytes;
};

const retained = (d: Document): Encryptor | undefined =>
  (d as unknown as { preservedEncryptor?: Encryptor }).preservedEncryptor;

describe('Document retains the crypto it opened with', () => {
  for (const cipher of ['rc4', 'aes128', 'aes256'] as const) {
    it(`retains an encryptor for ${cipher}`, () => {
      const doc = Document.Open(encryptedPdf(cipher));
      expect(retained(doc)).toBeDefined();
    });
  }

  it('retains the ORIGINAL /Encrypt dict rather than a rebuilt one', () => {
    const doc = Document.Open(encryptedPdf('rc4'));
    const fromTrailer = doc.resolve(doc.trailer.get('Encrypt'));
    expect(retained(doc)!.encryptDict).toBe(fromTrailer);
  });

  it('retains nothing for an unencrypted document', () => {
    expect(retained(Document.Open(buildClassicPdf(1)))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/preserve-encryption.test.ts`
Expected: FAIL — `preservedEncryptor` is undefined for every case.

- [ ] **Step 3: Carry the crypto state out of `build()`**

In `src/document.ts`, add to the `BuildResult` interface (line 224):

```ts
  /** The key and `/Encrypt` dict this document was decrypted with, so a save
   *  can write it encrypted again. Absent for a plaintext document. */
  preserved?: { keys: CryptKeys; encryptDict: PdfDict };
```

In `build()`, where `decryptor` is assigned (both the PubSec branch and the
standard branch around lines 700-715), capture the dict and keys into a local
`preserved` and include it in the returned object:

```ts
    let preserved: { keys: CryptKeys; encryptDict: PdfDict } | undefined;
    // ... in each branch, after the decryptor is built:
    //   preserved = { keys: decryptor.keys, encryptDict: encDict };
```

and extend the final `return { objects, failed, lostInObjStm, ... }` with `preserved,`.

- [ ] **Step 4: Retain it on the Document**

Add the field beside `openOptions`:

```ts
  /** An Encryptor over the key and `/Encrypt` dict this document was opened
   *  with, so `Save` writes it encrypted again rather than silently in the
   *  clear. Absent for a plaintext document, which is what keeps an
   *  unencrypted save byte-identical. */
  private preservedEncryptor?: Encryptor;
```

At both `Open` sites that set `doc.originalBytes` (around lines 576 and 657), add:

```ts
      if (pass.preserved)
        doc.preservedEncryptor = buildEncryptorFromKeys(pass.preserved.keys, pass.preserved.encryptDict);
```

Add the imports: `buildEncryptorFromKeys`, `Encryptor` from `./encrypt.js`, `CryptKeys` from `./crypto.js`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/preserve-encryption.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Run both gates and commit**

```bash
npm run typecheck && npm test
git add src/document.ts test/preserve-encryption.test.ts
git commit -m "feat(0cr3): retain the opened document's encryptor"
```

---

### Task 3: the rewrite path preserves encryption

**Files:**
- Modify: `src/serializer.ts` (`SerializeOptions.encrypt` widened, `serializeDocument` takes the preserved encryptor)
- Modify: `src/document.ts` (`Save` passes it; the `/ID` refusal)
- Test: `test/preserve-encryption.test.ts` (append)
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `Document`'s `preservedEncryptor` (Task 2)
- Produces: `SerializeOptions.encrypt?: EncryptOptions | PubSecEncryptOptions | false`; `serializeDocument(objects, trailer, options, preserved?: Encryptor)`

- [ ] **Step 1: Write the failing test**

Append to `test/preserve-encryption.test.ts`:

```ts
const visible = (b: Uint8Array, s: string): boolean =>
  new TextDecoder('latin1').decode(b).includes(s);

describe('Save preserves encryption', () => {
  for (const cipher of ['rc4', 'aes128', 'aes256'] as const) {
    it(`round-trips a ${cipher} document`, () => {
      const out = Document.Open(encryptedPdf(cipher)).Save();
      // The sharp assertion: actually encrypted, not merely carrying /Encrypt.
      expect(visible(out, 'SecretTitle')).toBe(false);
      expect(Document.Open(out).GetMetadata().title).toBe('SecretTitle');
    });
  }

  it('writes plaintext when asked explicitly', () => {
    const out = Document.Open(encryptedPdf('rc4')).Save({ encrypt: false });
    expect(visible(out, 'SecretTitle')).toBe(true);
    expect(Document.Open(out).GetMetadata().title).toBe('SecretTitle');
  });

  it('lets an explicit encrypt option win over the retained one', () => {
    const out = Document.Open(encryptedPdf('rc4'))
      .Save({ encrypt: { userPassword: 'new', ownerPassword: 'owner' } });
    expect(Document.Open(out, { password: 'new' }).GetMetadata().title).toBe('SecretTitle');
    expect(() => Document.Open(out)).toThrow();
  });

  it('preserves /ID byte for byte, which the retained key depends on', () => {
    const base = encryptedPdf('rc4');
    const idOf = (b: Uint8Array): string => {
      const arr = Document.Open(b).trailer.get('ID') as { bytes: Uint8Array }[];
      return Buffer.from(arr[0].bytes).toString('hex');
    };
    expect(idOf(Document.Open(base).Save())).toBe(idOf(base));
  });

  it('leaves an unencrypted document byte-identical', () => {
    const base = buildClassicPdf(2);
    expect(Document.Open(base).Save()).toEqual(Document.Open(base).Save());
    expect(visible(Document.Open(base).Save(), '/Encrypt')).toBe(false);
  });

  // The retained key is only valid against the SAME /ID, and resolveIds would
  // invent a fresh random one — producing a file nothing can decrypt.
  it('refuses to preserve when the trailer names no /ID', () => {
    const doc = Document.Open(encryptedPdf('rc4'));
    doc.trailer.delete('ID');
    expect(() => doc.Save()).toThrow(/names no \/ID/);
    // But the two explicit routes still work.
    expect(() => doc.Save({ encrypt: false })).not.toThrow();
    expect(() => doc.Save({ encrypt: { userPassword: 'new' } })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/preserve-encryption.test.ts`
Expected: FAIL — the round-trip cases show `SecretTitle` in the clear.

- [ ] **Step 3: Widen the option and the serializer signature**

In `src/serializer.ts`, change the `encrypt` field of `SerializeOptions`:

```ts
  /** Encrypt the output: password-based standard handler ({@link EncryptOptions})
   *  or certificate-based PubSec ({@link PubSecEncryptOptions}). Pass `false` to
   *  write PLAINTEXT from a document that was opened encrypted, which is
   *  otherwise preserved. Default: preserve if the document was encrypted,
   *  else plaintext. */
  encrypt?: EncryptOptions | PubSecEncryptOptions | false;
```

Change `serializeDocument`'s signature to take the preserved encryptor:

```ts
export function serializeDocument(
  objects: Map<number, PdfObject>, trailer: PdfDict,
  options: SerializeOptions = {}, preserved?: Encryptor,
): Uint8Array {
```

- [ ] **Step 4: Route the three cases**

Replace the plaintext short-circuit and encryptor construction (currently lines 126-135) with:

```ts
  // Precedence: an explicit `encrypt` wins; else the document's own retained
  // encryption; else plaintext. `encrypt: false` is how a caller asks for
  // plaintext from a document that was opened encrypted.
  const chosen: Encryptor | undefined = options.encrypt === false
    ? undefined
    : options.encrypt
      ? ('recipients' in options.encrypt
        ? buildPubSecEncryptor(options.encrypt)
        : buildEncryptor(options.encrypt, resolveIds(trailer).id0))
      : preserved;
  if (!chosen) {
    return options.compressed ? serializeCompressed(plan, trailer, ver) : serializeClassic(plan, trailer, ver);
  }
  const { id0, id1 } = resolveIds(trailer);
  return options.compressed
    ? serializeCompressedEncrypted(plan, trailer, chosen, id0, id1, ver)
    : serializeClassicEncrypted(plan, chosen, id0, id1, ver);
```

- [ ] **Step 5: Pass it from `Save`, and add the `/ID` refusal**

In `src/document.ts`'s `Save`, replace the final return with:

```ts
    // A retained key for R<=4 hashes /ID[0], so it is valid only against the
    // SAME /ID -- and resolveIds falls back to a fresh random one when the
    // trailer names none, which would yield a file nothing can decrypt.
    if (this.preservedEncryptor && options.encrypt === undefined && !isArray(this.trailer.get('ID')))
      throw new UnsupportedFeatureError(
        'cannot preserve encryption: the trailer names no /ID, which the file key '
        + 'is derived from. Pass `encrypt` to re-encrypt with stated credentials, '
        + 'or `encrypt: false` to write plaintext.');
    return serializeDocument(this.objects, this.trailer, options, this.preservedEncryptor);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/preserve-encryption.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 7: Run the byte-identity fences, which are the primary gate**

Run: `npx vitest run test/serializer-signed.test.ts test/docx-flow-identity.test.ts test/html-identity.test.ts test/rich-runs-identity.test.ts`
Expected: PASS. A failure here means an unencrypted document's output moved — fix the routing, do not refresh the golden.

- [ ] **Step 8: Update README**

In the Limitations section, replace the entry about encrypted output with an added note under Saving:

```markdown
A document opened encrypted is **saved encrypted again by default**, reusing its
original `/Encrypt` dictionary and file key — the owner password is hashed into
`/O` and cannot be recovered, so re-deriving encryption is impossible and
carrying the key forward is the only faithful route. Pass
`Save({ encrypt: false })` to write plaintext, or `Save({ encrypt })` to
re-encrypt with stated credentials. Preserving requires the trailer's `/ID`,
which the file key is derived from.
```

- [ ] **Step 9: Add the CHANGELOG entry**

Under `## [Unreleased]`, in `### Changed`, leading with the breaking note:

```markdown
- **BREAKING: `Save()` now preserves a document's encryption instead of silently writing it in the clear.** Opening an encrypted PDF and saving it produced a **plaintext** file with no `/Encrypt` and no signal — measured, an `/Info /Title` of `SecretTitle` was visible in the output and read back fine, so a caller who opened a confidential document and saved it got an unprotected one. It is now written encrypted again, reusing the original `/Encrypt` dictionary and file key. Reusing them is not an optimization but the only faithful route: the owner password is hashed into `/O` and is unrecoverable, and re-deriving through `EncryptOptions` defaults `ownerPassword ?? userPassword`, which would silently equate them — a permissions downgrade shipped as a confidentiality fix. Pass `Save({ encrypt: false })` for the old behaviour, or `Save({ encrypt })` to re-encrypt with stated credentials. Preserving requires the trailer's `/ID`, which the file key is derived from, and throws `UnsupportedFeatureError` without it. Unencrypted documents are byte-identical. (`0cr3`)
```

- [ ] **Step 10: Run both gates and commit**

```bash
npm run typecheck && npm test
git add src/serializer.ts src/document.ts test/preserve-encryption.test.ts README.md CHANGELOG.md
git commit -m "feat(0cr3): Save preserves the document's own encryption"
```

---

### Task 4: the incremental append encrypts and carries /Encrypt

**Files:**
- Modify: `src/incremental.ts` (`IncrementalUpdateOptions.encryptor`, `layout` encrypts and emits `/Encrypt`)
- Modify: `src/document.ts` (`saveIncremental` drops its refusal, passes the encryptor)
- Test: `test/preserve-encryption.test.ts` (append)
- Modify: `test/save-incremental.test.ts` (invert the refusal case), `CHANGELOG.md`

**Interfaces:**
- Consumes: `Document`'s `preservedEncryptor`
- Produces: `IncrementalUpdateOptions.encryptor?: Encryptor`

- [ ] **Step 1: Write the failing test**

Append to `test/preserve-encryption.test.ts`:

```ts
describe('an incremental save keeps the document encrypted', () => {
  it('reopens with BOTH old and new content decrypting', () => {
    const doc = Document.Open(encryptedPdf('rc4'));
    doc.Pages[0].Dict.set('Rotate', 90);
    const out = doc.Save({ incremental: true });

    // The x8kx regression: the original /Info used to decode to garbage.
    const re = Document.Open(out);
    expect(re.GetMetadata().title).toBe('SecretTitle');
    expect(re.Pages[0].Dict.get('Rotate')).toBe(90);
  });

  it('carries /Encrypt into the appended trailer', () => {
    const base = encryptedPdf('rc4');
    const doc = Document.Open(base);
    doc.Pages[0].Dict.set('Rotate', 90);
    const appended = new TextDecoder('latin1')
      .decode(doc.Save({ incremental: true }).subarray(base.length));
    expect(appended).toMatch(/\/Encrypt \d+ 0 R/);
  });

  it('preserves the original bytes verbatim', () => {
    const base = encryptedPdf('rc4');
    const doc = Document.Open(base);
    doc.Pages[0].Dict.set('Rotate', 90);
    expect(doc.Save({ incremental: true }).subarray(0, base.length)).toEqual(base);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/preserve-encryption.test.ts`
Expected: FAIL — `cannot save incrementally: encrypted documents are not supported`.

- [ ] **Step 3: Accept an encryptor in `incremental.ts`**

Add to `IncrementalUpdateOptions`:

```ts
  /** Encrypt appended strings and streams with the document's own key. The
   *  `/Encrypt` object itself already lives in the original bytes, so the new
   *  trailer references it rather than rewriting it. */
  encryptor?: Encryptor;
```

Import `Encryptor` from `./encrypt.js`.

- [ ] **Step 4: Encrypt the appended objects and emit `/Encrypt`**

In `layout`, change the serialization of each appended object so it passes
through the encryptor first:

```ts
  for (const [num, obj] of opts.objects)
    items.push({
      num,
      body: serializeObject(opts.encryptor ? opts.encryptor.encryptObject(obj, num, prevGen(prev.entries, num)) : obj),
    });
```

and add `/Encrypt` to the trailer, taken from the previous trailer since the
object already exists in the original bytes:

```ts
  const encRef = prev.trailer.get('Encrypt');
  if (encRef !== undefined && isRef(encRef)) tr += ` /Encrypt ${encRef.num} ${encRef.gen} R`;
```

Insert that line beside the existing `/Info` and `/ID` appends, before the
closing `' >>'`.

- [ ] **Step 5: Drop the refusal and pass the encryptor**

In `src/document.ts`'s `saveIncremental`, delete:

```ts
    if (this.trailer.get('Encrypt') !== undefined)
      throw new UnsupportedFeatureError(
        'cannot save incrementally: encrypted documents are not supported');
```

and add `encryptor: this.preservedEncryptor,` to the `appendIncrementalUpdate` call.

- [ ] **Step 6: Invert the obsolete refusal test**

In `test/save-incremental.test.ts`, replace the `refuses an encrypted document`
case with:

```ts
  it('now supports an encrypted document', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'rc4', R: 3, V: 2, length: 128 },
      { pageContents: ['BT ET'] },
    );
    const doc = Document.Open(bytes);
    doc.Pages[0].Dict.set('Rotate', 90);
    expect(() => doc.Save({ incremental: true })).not.toThrow();
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/preserve-encryption.test.ts test/save-incremental.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the CHANGELOG entry**

Under `### Fixed`:

```markdown
- **An incremental save of an encrypted document no longer destroys it.** `Save({ incremental: true })` refused encrypted documents because the append had no encryption at all: appended objects were written in the clear, and the appended trailer carried no `/Encrypt`, so a reader took the newest trailer at its word, treated the file as unencrypted, and decoded every pre-existing encrypted string to garbage. Appended objects are now encrypted with the document's own key, and the new trailer references the `/Encrypt` object already present in the original bytes. (`0cr3`)
```

- [ ] **Step 9: Run both gates and commit**

```bash
npm run typecheck && npm test
git add src/incremental.ts src/document.ts test/preserve-encryption.test.ts test/save-incremental.test.ts CHANGELOG.md
git commit -m "feat(0cr3): encrypt appended objects and carry /Encrypt"
```

---

### Task 5: signing an encrypted document

**Files:**
- Modify: `src/sigplaceholder.ts` (`buildSigDictPlaceholder` encrypts strings except `/Contents`)
- Modify: `src/incremental.ts` (`appendSignatureUpdate` passes the encryptor through)
- Modify: `src/document.ts` (delete `assertNotEncrypted` and its three call sites)
- Test: `test/sign-encrypted-refusal.test.ts` → rewrite as `test/sign-encrypted.test.ts`
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `Encryptor`, `SignatureUpdateOptions`
- Produces: `SignatureUpdateOptions.encryptor?: Encryptor`

- [ ] **Step 1: Write the failing test**

Create `test/sign-encrypted.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildEncryptedPdf } from './helpers/encrypt-pdf.js';
import { buildSigner, TestSigner } from './helpers/build-signer.js';
import { Document } from '../src/document.js';
import { verifySignedData } from '../src/cms.js';

const signerOf = (t: TestSigner): { certificate: Uint8Array; privateKey: any } =>
  ({ certificate: t.certificate, privateKey: t.privateKey });

const encrypted = (): Uint8Array => buildEncryptedPdf(
  { cipher: 'rc4', R: 3, V: 2, length: 128 },
  { info: { Title: 'SecretTitle' }, pageContents: ['BT ET'] },
).bytes;

describe('signing an encrypted document', () => {
  it('produces a signature that verifies', async () => {
    const doc = Document.Open(encrypted());
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'ok', name: 'Alice' });
    const bytes = doc.Save();

    const sig = Document.Open(bytes).Signatures[0];
    const [, a, b, c] = sig.byteRange!;
    const covered = new Uint8Array(a + c);
    covered.set(bytes.subarray(0, a), 0);
    covered.set(bytes.subarray(b, b + c), a);
    const digest = new Uint8Array(createHash('sha256').update(covered).digest());
    const r = verifySignedData(sig.contents!.subarray(0, sig.cmsLength!), digest);
    expect(r.digestMatches).toBe(true);
    expect(r.signatureValid).toBe(true);
  });

  // The two mistakes are silent and OPPOSITE: encrypting /Contents breaks
  // verification above, and failing to encrypt /Name leaks it here.
  it('does not leak the signer name in cleartext', async () => {
    const doc = Document.Open(encrypted());
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { name: 'PLAINTEXT_NAME' });
    const text = new TextDecoder('latin1').decode(doc.Save());
    expect(text).not.toContain('PLAINTEXT_NAME');
  });

  it('reads the name back after decrypting', async () => {
    const doc = Document.Open(encrypted());
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { name: 'Alice' });
    expect(Document.Open(doc.Save()).Signatures[0].Name).toBe('Alice');
  });

  it('leaves the original encrypted content readable', async () => {
    const doc = Document.Open(encrypted());
    await doc.Sign(signerOf(buildSigner({ type: 'rsa' })), { reason: 'ok' });
    expect(Document.Open(doc.Save()).GetMetadata().title).toBe('SecretTitle');
  });
});
```

Delete `test/sign-encrypted-refusal.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/sign-encrypted.test.ts`
Expected: FAIL — `cannot sign an encrypted document`.

- [ ] **Step 3: Encrypt the placeholder's strings, exempting `/Contents`**

In `src/sigplaceholder.ts`, give `buildSigDictPlaceholder` an optional
encryptor and apply it to every string value except `/Contents`:

```ts
/** `/Contents` is EXEMPT from encryption (32000-1 7.6.2) and `/ByteRange` is
 *  not a string; every other value is encrypted like any object's would be.
 *  Both mistakes are silent and opposite — encrypting `/Contents` breaks
 *  verification, leaving `/Name` in the clear leaks the signer from a document
 *  whose whole point is encryption. */
export function buildSigDictPlaceholder(
  sigDict: PdfDict, placeholderBytes: number,
  encryptor?: Encryptor, objNum?: number,
): SigPlaceholder {
  const d: PdfDict = new Map(sigDict);
  if (encryptor && objNum !== undefined)
    for (const [k, v] of d)
      if (k !== 'Contents' && k !== 'ByteRange') d.set(k, encryptor.encryptObject(v, objNum, 0));
  // ... existing body, now building from `d` rather than `sigDict`
}
```

- [ ] **Step 4: Thread the encryptor through the signature append**

In `src/incremental.ts`, add `encryptor?: Encryptor` to `SignatureUpdateOptions`
and pass it into both the placeholder build and the generic `layout` call:

```ts
  const ph = buildSigDictPlaceholder(opts.sigDict, placeholderBytes, opts.encryptor, opts.sigObjNum);
  // ...
  const { bytes, sigStart } = layout(original, {
    objects, encryptor: opts.encryptor,
    rootNum: opts.rootNum, infoNum: opts.infoNum, id: opts.id,
  }, { num: opts.sigObjNum, text });
```

In `src/document.ts`, pass `encryptor: this.preservedEncryptor` at each
`appendSignatureUpdate` call site.

- [ ] **Step 5: Delete the refusal**

Remove `assertNotEncrypted` from `src/document.ts` and its three call sites
(`signCore`, `AddValidationData`, `AddDocumentTimestamp`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/sign-encrypted.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 7: Run the whole signing suite, which is the fence here**

Run: `npx vitest run test/sign.test.ts test/serializer-signed.test.ts test/sign-cades.test.ts test/sign-doctimestamp.test.ts test/sign-incremental-dirty.test.ts test/sign-incremental-survival.test.ts`
Expected: PASS, unmoved — these are unencrypted documents and must be unaffected.

- [ ] **Step 8: Remove the README limitation and add the CHANGELOG entry**

Delete the README Limitations bullet beginning **"Signing an encrypted document is refused"**. Add under `### Fixed`:

```markdown
- **Signing an encrypted document works instead of being refused.** It was refused because the append could not encrypt what it wrote; now it can. The signature value dictionary's `/Name`, `/Reason`, `/Location` and `/M` are encrypted like any other strings while `/Contents` is left in the clear, as 32000-1 §7.6.2 requires — the two mistakes are silent and opposite, since encrypting `/Contents` breaks verification and leaving `/Name` unencrypted leaks the signer from a document whose whole point is encryption. (`0cr3`)
```

- [ ] **Step 9: Run both gates and commit**

```bash
npm run typecheck && npm test
git add src/sigplaceholder.ts src/incremental.ts src/document.ts test/sign-encrypted.test.ts README.md CHANGELOG.md
git rm test/sign-encrypted-refusal.test.ts
git commit -m "feat(0cr3): sign an encrypted document"
```

---

### Task 6: PubSec, the qpdf anchor, docs and the mutation sweep

**Files:**
- Test: `test/preserve-encryption.test.ts` (PubSec case)
- Modify: `test/helpers/qpdf-fixtures.ts`, `scripts/gen-qpdf-goldens.ts`, `test/fixtures/qpdf/PROVENANCE.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the PubSec round trip**

No helper builds a whole PubSec-encrypted *document* — `test/pubsec.test.ts`
works at the encryptor level — so build one with our own writer. Append to
`test/preserve-encryption.test.ts`:

```ts
import { buildRsaSigner } from './helpers/build-signer.js';

describe('Save preserves certificate-based (PubSec) encryption', () => {
  it('round-trips a PubSec document', () => {
    const r = buildRsaSigner('Recipient');
    const authored = Document.Open(buildClassicPdf(1));
    authored.SetMetadata({ title: 'SecretTitle' });
    const encrypted = authored.Save({
      encrypt: { recipients: [{ certificate: r.certificate }], algorithm: 'aes256' },
    });

    const reopened = Document.Open(encrypted, { recipient: r });
    const out = reopened.Save();

    expect(visible(out, 'SecretTitle')).toBe(false);
    expect(Document.Open(out, { recipient: r }).GetMetadata().title).toBe('SecretTitle');
  });
});
```

> `buildRsaSigner` returns `{ certificate, privateKey }`, which satisfies both
> `PubSecRecipient` on the open side and the recipient entry on the encrypt
> side. If its shape differs, read `normalizeRecipient` in
> `src/document.ts:241` for what `OpenOptions.recipient` accepts.

- [ ] **Step 2: Extend the qpdf goldens with an encrypted shape**

In `test/helpers/qpdf-fixtures.ts`, add:

```ts
  {
    name: 'encrypted-preserved',
    covers: 'a document opened encrypted and saved again, checked by a reader '
      + 'that is not ours — the only external check in this feature',
    build: () => {
      const { bytes } = buildEncryptedPdf(
        { cipher: 'rc4', R: 3, V: 2, length: 128 },
        { info: { Title: 'SecretTitle' }, pageContents: ['BT ET'] },
      );
      return Document.Open(bytes).Save();
    },
  },
```

In `scripts/gen-qpdf-goldens.ts`, pass an empty password for the check so qpdf
can open it: use `qpdf(['--password=', '--check', tmp])` for any fixture whose
name starts with `encrypted-`.

Update `test/qpdf-goldens.test.ts`'s name-list assertion to include it, and
regenerate:

```bash
npx tsx scripts/gen-qpdf-goldens.ts
```

Add the new fixture's row and coverage line to
`test/fixtures/qpdf/PROVENANCE.md`.

- [ ] **Step 3: Run the mutation sweep**

Apply each, confirm the named case reddens, revert. Record any that redden
nothing in CLAUDE.md rather than leaving it unstated.

| Mutation | Expected red |
|---|---|
| drop `/Encrypt` from `layout`'s appended trailer | "reopens with BOTH old and new content decrypting" |
| encrypt `/Contents` in `buildSigDictPlaceholder` | "produces a signature that verifies" |
| skip encrypting `/Name` (exempt every key) | "does not leak the signer name in cleartext" |
| write a fresh `/ID` (force `randomBytes` in `resolveIds`) | the round-trip cases, which stop decrypting |
| return `preserved` as undefined from `build()` | every round-trip case |

- [ ] **Step 4: Add the CLAUDE.md entries**

Add to the `crypto.ts` entry in the Source list:

```markdown
  **Invariant:** the `/Encrypt` dict is COPIED VERBATIM and encryption is never
  RE-DERIVED. `EncryptOptions` needs an owner password, which is hashed into
  `/O` and unrecoverable, and `buildEncryptor` defaults
  `ownerPassword ?? userPassword` — so carrying encryption forward by
  re-deriving would SILENTLY EQUATE the owner and user passwords, a permissions
  downgrade shipped as a confidentiality fix. `buildEncryptorFromKeys` reuses
  the key `buildDecryptor` already computed instead.
  **Invariant:** preserving requires `/ID`. For R<=4 the file key hashes
  `/ID[0]`, and `resolveIds` falls back to a fresh random one when the trailer
  names none — which with a retained key yields a file NOTHING can decrypt.
  `Save` refuses rather than producing it.
  **Note:** a signature's `/Contents` is EXEMPT from encryption (32000-1
  7.6.2) while `/Name`, `/Reason`, `/Location` and `/M` are not. The two
  mistakes are silent and opposite — encrypting `/Contents` breaks
  verification, leaving `/Name` clear leaks the signer.
```

- [ ] **Step 5: Run both gates and commit**

```bash
npm run typecheck && npm test
git add test/ scripts/ CLAUDE.md
git commit -m "test(0cr3): PubSec round trip, qpdf anchor and the mutation sweep"
```

- [ ] **Step 6: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-0cr3
```

---

## Not in this plan

- Changing what `Save({ encrypt })` does with stated credentials.
- Encrypted linearization, refused outright and unchanged.
- A compressed appended section, refused by `msdn.3` and unrelated.
