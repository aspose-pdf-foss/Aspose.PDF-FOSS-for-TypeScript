# Encrypted Save (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Save({ encrypt })` producing standard-security-handler PDFs (AES-256, AES-128, RC4) that re-open through the existing reader.

**Architecture:** Add write-side ciphers to `crypto.ts`; a new `encrypt.ts` builds the `/Encrypt` dict and an `Encryptor` (mirroring `decryptObject`); the serializer gains an `encrypt` branch that ensures a `/ID`, encrypts the remapped object copies by their final numbers, and writes `/Encrypt`. AES-256 uses the file key directly; RC4/AES-128 derive per-object keys via the existing `objectKeyV4`.

**Tech Stack:** TypeScript (strict, NodeNext, `.js` import specifiers), vitest, `node:crypto`. Zero npm runtime dependencies.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins (`zlib`, `crypto`, `fs`). Do NOT add npm runtime deps.
- ESM + NodeNext, strict TypeScript; every relative import specifier carries a `.js` extension.
- Live-mutation model: encryption runs only on the serializer's remapped **copies** (`plan.objs`); never mutate `objects`/`trailer`.
- Public error types only (`errors.ts`): `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError`. An unknown `algorithm` throws `TypeError`.
- Default behaviour unchanged: omitting `encrypt` yields today's plaintext output.
- Round-trip is the correctness bar: every encrypted file must re-open via `Document.Open(bytes, { password })`.
- Reader limitation to respect in tests: the existing `buildDecryptor` validates only the **user** password for R≤4 (RC4/AES-128). Owner-password opening is therefore tested for **AES-256 only**.
- Run `npm run typecheck` and `npm test` before considering any task done; both must be green.

---

### Task 1: Write-side ciphers in `crypto.ts`

**Files:**
- Modify: `src/crypto.ts`
- Test: `test/crypto-encrypt.test.ts`

**Interfaces:**
- Consumes: `createCipheriv`, `randomBytes` from `node:crypto`; the private `concat` already in `crypto.ts`.
- Produces (exported from `src/crypto.ts`):
  - `randomBytes(n: number): Uint8Array`
  - `aesCbcEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array` (random IV prepended, PKCS#7)
  - `aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array`
  - `aes256EcbEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array`

- [ ] **Step 1: Write the failing test**

Create `test/crypto-encrypt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createDecipheriv } from 'node:crypto';
import {
  aesCbcEncrypt, aesCbcDecrypt, aesCbcEncryptNoPad, aesCbcDecryptNoPad,
  aes256EcbEncrypt, randomBytes,
} from '../src/crypto.js';

describe('write-side ciphers', () => {
  it('aesCbcEncrypt round-trips through aesCbcDecrypt (128 and 256)', () => {
    for (const klen of [16, 32]) {
      const key = randomBytes(klen);
      const data = randomBytes(40);
      const ct = aesCbcEncrypt(key, data);
      expect([...aesCbcDecrypt(key, ct)]).toEqual([...data]);
    }
  });

  it('aesCbcEncryptNoPad round-trips through aesCbcDecryptNoPad', () => {
    const key = randomBytes(32);
    const iv = new Uint8Array(16);
    const data = randomBytes(32);
    const ct = aesCbcEncryptNoPad(key, iv, data);
    expect([...aesCbcDecryptNoPad(key, iv, ct)]).toEqual([...data]);
  });

  it('aes256EcbEncrypt matches a node reference decrypt', () => {
    const key = randomBytes(32);
    const data = randomBytes(16);
    const ct = aes256EcbEncrypt(key, data);
    const d = createDecipheriv('aes-256-ecb', key, null);
    d.setAutoPadding(false);
    const pt = new Uint8Array(Buffer.concat([d.update(Buffer.from(ct)), d.final()]));
    expect([...pt]).toEqual([...data]);
  });

  it('randomBytes returns the requested length', () => {
    expect(randomBytes(16).length).toBe(16);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/crypto-encrypt.test.ts`
Expected: FAIL — `aesCbcEncrypt` (and the others) are not exported.

- [ ] **Step 3: Implement the ciphers in `src/crypto.ts`**

Change the `node:crypto` import (currently `import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';`) to also import `randomBytes`:

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
```

Append at the end of `src/crypto.ts`:

```ts
/** Cryptographically strong random bytes. */
export function randomBytes(n: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(n));
}

/** AES-CBC encrypt: a random 16-byte IV is prepended; PKCS#7 padding. Key length
 *  (16 or 32) selects AES-128 vs AES-256. Inverse of aesCbcDecrypt. */
export function aesCbcEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const iv = randomBytes(16);
  const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const c = createCipheriv(algo, key, iv);
  c.setAutoPadding(true);
  const body = new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
  return concat(iv, body);
}

/** AES-CBC encrypt with an explicit IV and NO padding (for /UE, /OE). */
export function aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const c = createCipheriv(algo, key, iv);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
}

/** AES-256-ECB encrypt, no padding, no IV (for the 16-byte /Perms block). */
export function aes256EcbEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-256-ecb', key, null);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(data)), c.final()]));
}
```

(`concat` is the existing private helper at the top of `crypto.ts`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/crypto-encrypt.test.ts`
Expected: PASS (4 cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/crypto.ts test/crypto-encrypt.test.ts
git commit -m "feat: write-side AES ciphers + randomBytes in crypto.ts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `encrypt.ts` — types, `/P`, and the AES-256 encryptor

**Files:**
- Create: `src/encrypt.ts`
- Test: `test/encrypt.test.ts`

**Interfaces:**
- Consumes: `aesCbcEncrypt`, `aesCbcEncryptNoPad`, `aes256EcbEncrypt`, `randomBytes`, `hash2B` from `crypto.ts`; `buildDecryptor` (for the test only); `name`, `isString`, `isArray`, `isDict`, `isStream` from `types.ts`.
- Produces (exported from `src/encrypt.ts`):
  - `interface Permissions { printing?; modifying?; copying?; annotating?; fillingForms?; accessibility?; assembling?; highQualityPrinting?: boolean }`
  - `interface EncryptOptions { userPassword?: string; ownerPassword?: string; algorithm?: 'aes256' | 'aes128' | 'rc4'; permissions?: Permissions; encryptMetadata?: boolean }`
  - `interface Encryptor { readonly encryptDict: PdfDict; encryptObject(obj: PdfObject, num: number, gen: number): PdfObject; encryptStreamRaw(raw: Uint8Array, num: number, gen: number): Uint8Array }`
  - `function permissionsToP(p?: Permissions): number`
  - `function buildEncryptor(opts: EncryptOptions, id0: Uint8Array): Encryptor`

Note: `encryptObject` **returns** the (possibly new) object, mirroring `decryptObject` in `crypto.ts` — necessary because `PdfStream.raw` is readonly, so an encrypted stream is a fresh `{ kind:'stream', dict, raw }`.

- [ ] **Step 1: Write the failing test**

Create `test/encrypt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildEncryptor, permissionsToP } from '../src/encrypt.js';
import { buildDecryptor } from '../src/crypto.js';
import { isString, PdfObject } from '../src/types.js';

const id0 = new Uint8Array(16).fill(7);
const resolve = (o: PdfObject | undefined): PdfObject => (o === undefined ? null : o);

function roundTripString(algorithm: 'aes256' | 'aes128' | 'rc4'): string {
  const e = buildEncryptor({ userPassword: 'pw', algorithm }, id0);
  const original = new TextEncoder().encode('hello secret');
  const enc = e.encryptObject({ kind: 'string', bytes: original }, 5, 0);
  const d = buildDecryptor(e.encryptDict, id0, 'pw', resolve)!;
  const back = d.decryptObject(enc, 5, 0);
  return isString(back) ? new TextDecoder().decode(back.bytes) : '<not a string>';
}

describe('buildEncryptor (AES-256)', () => {
  it('encryptObject round-trips a string through buildDecryptor', () => {
    expect(roundTripString('aes256')).toBe('hello secret');
  });

  it('produces an AESV3 /Encrypt dict', () => {
    const e = buildEncryptor({ userPassword: 'pw', algorithm: 'aes256' }, id0);
    expect(e.encryptDict.get('V')).toBe(5);
    expect(e.encryptDict.get('R')).toBe(6);
  });
});

describe('permissionsToP', () => {
  it('defaults to all-allowed', () => {
    const p = permissionsToP();
    expect(p & 0x04).toBe(0x04); // printing
    expect(p & 0x800).toBe(0x800); // high-quality printing
  });
  it('clears only the disabled bit', () => {
    const p = permissionsToP({ copying: false });
    expect(p & 0x10).toBe(0);    // copying cleared
    expect(p & 0x04).toBe(0x04); // printing untouched
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/encrypt.test.ts`
Expected: FAIL — cannot import from `../src/encrypt.js` (module does not exist).

- [ ] **Step 3: Implement `src/encrypt.ts` (types, `/P`, AES-256 path)**

```ts
import { PdfDict, PdfObject, name, isString, isArray, isDict, isStream } from './types.js';
import {
  aesCbcEncrypt, aesCbcEncryptNoPad, aes256EcbEncrypt, randomBytes, hash2B,
} from './crypto.js';

export interface Permissions {
  printing?: boolean;
  modifying?: boolean;
  copying?: boolean;
  annotating?: boolean;
  fillingForms?: boolean;
  accessibility?: boolean;
  assembling?: boolean;
  highQualityPrinting?: boolean;
}

export interface EncryptOptions {
  userPassword?: string;
  ownerPassword?: string;
  algorithm?: 'aes256' | 'aes128' | 'rc4';
  permissions?: Permissions;
  encryptMetadata?: boolean;
}

export interface Encryptor {
  readonly encryptDict: PdfDict;
  encryptObject(obj: PdfObject, num: number, gen: number): PdfObject;
  encryptStreamRaw(raw: Uint8Array, num: number, gen: number): Uint8Array;
}

const pdfStr = (bytes: Uint8Array): PdfObject => ({ kind: 'string', bytes });
const EMPTY = new Uint8Array(0);
const ZERO16 = new Uint8Array(16);

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Signed-int32 /P from permission flags (each defaults to allowed). */
export function permissionsToP(p: Permissions = {}): number {
  let v = 0xfffff0c0; // reserved bits 7,8 and 13..32 set; 1,2 clear
  const on = (flag: boolean | undefined, bit: number) => { if (flag !== false) v |= bit; };
  on(p.printing, 0x04);
  on(p.modifying, 0x08);
  on(p.copying, 0x10);
  on(p.annotating, 0x20);
  on(p.fillingForms, 0x100);
  on(p.accessibility, 0x200);
  on(p.assembling, 0x400);
  on(p.highQualityPrinting, 0x800);
  return v | 0; // coerce to signed int32
}

type CipherFn = (data: Uint8Array, num: number, gen: number) => Uint8Array;

/** Wrap string/stream ciphers into an Encryptor that recurses like decryptObject. */
function makeEncryptor(encryptDict: PdfDict, strCipher: CipherFn, stmCipher: CipherFn): Encryptor {
  const encryptObject = (obj: PdfObject, num: number, gen: number): PdfObject => {
    if (isString(obj)) return pdfStr(strCipher(obj.bytes, num, gen));
    if (isArray(obj)) { for (let i = 0; i < obj.length; i++) obj[i] = encryptObject(obj[i], num, gen); return obj; }
    if (isDict(obj)) { for (const [k, v] of obj) obj.set(k, encryptObject(v, num, gen)); return obj; }
    if (isStream(obj)) {
      const d = obj.dict;
      for (const [k, v] of d) d.set(k, encryptObject(v, num, gen));
      return { kind: 'stream', dict: d, raw: stmCipher(obj.raw, num, gen) };
    }
    return obj;
  };
  return {
    encryptDict,
    encryptObject,
    encryptStreamRaw: (raw, num, gen) => stmCipher(raw, num, gen),
  };
}

function buildAes256(userPw: Uint8Array, ownerPw: Uint8Array, P: number, encryptMetadata: boolean): Encryptor {
  const fileKey = randomBytes(32);

  // Algorithm 8: /U, /UE
  const uVal = randomBytes(8), uKey = randomBytes(8);
  const U = concat(hash2B(userPw, uVal, EMPTY), uVal, uKey); // 48 bytes
  const UE = aesCbcEncryptNoPad(hash2B(userPw, uKey, EMPTY), ZERO16, fileKey);

  // Algorithm 9: /O, /OE (udata = the 48-byte U)
  const oVal = randomBytes(8), oKey = randomBytes(8);
  const O = concat(hash2B(ownerPw, oVal, U), oVal, oKey);
  const OE = aesCbcEncryptNoPad(hash2B(ownerPw, oKey, U), ZERO16, fileKey);

  // Algorithm 13: /Perms
  const perms = new Uint8Array(16);
  perms[0] = P & 0xff; perms[1] = (P >> 8) & 0xff; perms[2] = (P >> 16) & 0xff; perms[3] = (P >>> 24) & 0xff;
  perms[4] = perms[5] = perms[6] = perms[7] = 0xff;
  perms[8] = encryptMetadata ? 0x54 : 0x46; // 'T' / 'F'
  perms[9] = 0x61; perms[10] = 0x64; perms[11] = 0x62; // 'a','d','b'
  perms.set(randomBytes(4), 12);
  const Perms = aes256EcbEncrypt(fileKey, perms);

  const stdcf: PdfDict = new Map<string, PdfObject>([
    ['CFM', name('AESV3')], ['Length', 32], ['AuthEvent', name('DocOpen')],
  ]);
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Filter', name('Standard')], ['V', 5], ['R', 6], ['Length', 256], ['P', P],
    ['O', pdfStr(O)], ['U', pdfStr(U)], ['OE', pdfStr(OE)], ['UE', pdfStr(UE)], ['Perms', pdfStr(Perms)],
    ['CF', new Map<string, PdfObject>([['StdCF', stdcf]])],
    ['StmF', name('StdCF')], ['StrF', name('StdCF')],
  ]);
  if (!encryptMetadata) dict.set('EncryptMetadata', false);

  const cipher: CipherFn = (data) => aesCbcEncrypt(fileKey, data);
  return makeEncryptor(dict, cipher, cipher);
}

export function buildEncryptor(opts: EncryptOptions, id0: Uint8Array): Encryptor {
  const algorithm = opts.algorithm ?? 'aes256';
  if (algorithm !== 'aes256' && algorithm !== 'aes128' && algorithm !== 'rc4')
    throw new TypeError(`unknown encryption algorithm: ${algorithm}`);
  const enc = new TextEncoder();
  const userPw = enc.encode(opts.userPassword ?? '');
  const ownerPw = enc.encode(opts.ownerPassword ?? opts.userPassword ?? '');
  const P = permissionsToP(opts.permissions);
  const encryptMetadata = opts.encryptMetadata !== false;

  if (algorithm === 'aes256') return buildAes256(userPw, ownerPw, P, encryptMetadata);
  return buildR34(algorithm, userPw, ownerPw, P, id0, encryptMetadata);
}

// buildR34 (RC4 / AES-128) is added in Task 3. Stub keeps the AES-256 path linkable.
function buildR34(
  _algorithm: 'aes128' | 'rc4', _userPw: Uint8Array, _ownerPw: Uint8Array,
  _P: number, _id0: Uint8Array, _encryptMetadata: boolean,
): Encryptor {
  throw new Error('RC4/AES-128 not yet implemented');
}
```

Note: the `buildR34` stub is replaced in Task 3 (same signature). This is the single intentional cross-task edit to one function.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/encrypt.test.ts`
Expected: PASS (4 cases — the AES-256 and permissions tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/encrypt.ts test/encrypt.test.ts
git commit -m "feat: encrypt.ts with /P + AES-256 (R6) encryptor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: RC4 (R3) and AES-128 (R4) encryptors

**Files:**
- Modify: `src/crypto.ts` (export `md5`)
- Modify: `src/encrypt.ts` (replace the `buildR34` stub)
- Modify: `test/encrypt.test.ts` (extend the round-trip to all three)

**Interfaces:**
- Consumes: `md5` (newly exported), `rc4`, `padPassword`, `PASSWORD_PADDING`, `fileKeyR234`, `objectKeyV4` from `crypto.ts`.
- Produces: real `buildR34(algorithm, userPw, ownerPw, P, id0, encryptMetadata): Encryptor`.

- [ ] **Step 1: Extend the test to cover RC4 and AES-128**

In `test/encrypt.test.ts`, replace the `describe('buildEncryptor (AES-256)' ...)` block's first test with a parametrized version (keep the AESV3-dict test as-is):

```ts
describe('buildEncryptor round-trip', () => {
  for (const algorithm of ['aes256', 'aes128', 'rc4'] as const) {
    it(`${algorithm}: encryptObject round-trips a string through buildDecryptor`, () => {
      expect(roundTripString(algorithm)).toBe('hello secret');
    });
  }
});
```

- [ ] **Step 2: Run the test to verify the new cases fail**

Run: `npx vitest run test/encrypt.test.ts`
Expected: FAIL — `aes128` and `rc4` throw `RC4/AES-128 not yet implemented`.

- [ ] **Step 3: Export `md5` from `src/crypto.ts`**

Change line 5 of `src/crypto.ts` from:

```ts
const md5 = (b: Uint8Array) => new Uint8Array(createHash('md5').update(b).digest());
```

to:

```ts
export const md5 = (b: Uint8Array) => new Uint8Array(createHash('md5').update(b).digest());
```

- [ ] **Step 4: Replace the `buildR34` stub in `src/encrypt.ts`**

Update the `crypto.js` import in `encrypt.ts` to add the needed helpers:

```ts
import {
  aesCbcEncrypt, aesCbcEncryptNoPad, aes256EcbEncrypt, randomBytes, hash2B,
  md5, rc4, padPassword, PASSWORD_PADDING, fileKeyR234, objectKeyV4,
} from './crypto.js';
```

Replace the stub `buildR34` with:

```ts
/** Algorithm 3: compute /O (32 bytes) for R3/R4 (128-bit). */
function computeO(ownerPw: Uint8Array, userPw: Uint8Array, n: number): Uint8Array {
  let h = md5(padPassword(ownerPw.length ? ownerPw : userPw));
  for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n)); // R>=3
  const key = h.subarray(0, n);
  let data = rc4(key, padPassword(userPw));
  for (let i = 1; i <= 19; i++) data = rc4(key.map((b) => b ^ i), data);
  return data;
}

/** Algorithm 5: compute /U (32 bytes) for R3/R4. */
function computeU(fileKey: Uint8Array, id0: Uint8Array): Uint8Array {
  const h = md5(concat(PASSWORD_PADDING, id0));
  let data = rc4(fileKey, h);
  for (let i = 1; i <= 19; i++) data = rc4(fileKey.map((b) => b ^ i), data);
  const U = new Uint8Array(32);
  U.set(data.subarray(0, 16), 0);
  U.set(randomBytes(16), 16); // arbitrary trailing padding (reader checks first 16)
  return U;
}

function buildR34(
  algorithm: 'aes128' | 'rc4', userPw: Uint8Array, ownerPw: Uint8Array,
  P: number, id0: Uint8Array, encryptMetadata: boolean,
): Encryptor {
  const n = 16; // 128-bit
  const R = algorithm === 'rc4' ? 3 : 4;
  const V = algorithm === 'rc4' ? 2 : 4;
  const isAes = algorithm === 'aes128';

  const O = computeO(ownerPw, userPw, n);
  const fileKey = fileKeyR234(userPw, O, P, id0, R, 128, encryptMetadata);
  const U = computeU(fileKey, id0);

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Filter', name('Standard')], ['V', V], ['R', R], ['Length', 128], ['P', P],
    ['O', pdfStr(O)], ['U', pdfStr(U)],
  ]);
  if (isAes) {
    const stdcf: PdfDict = new Map<string, PdfObject>([
      ['CFM', name('AESV2')], ['Length', 16], ['AuthEvent', name('DocOpen')],
    ]);
    dict.set('CF', new Map<string, PdfObject>([['StdCF', stdcf]]));
    dict.set('StmF', name('StdCF'));
    dict.set('StrF', name('StdCF'));
  }
  if (!encryptMetadata) dict.set('EncryptMetadata', false);

  const cipher: CipherFn = (data, num, gen) => {
    const key = objectKeyV4(fileKey, num, gen, isAes);
    return isAes ? aesCbcEncrypt(key, data) : rc4(key, data);
  };
  return makeEncryptor(dict, cipher, cipher);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/encrypt.test.ts`
Expected: PASS (all three algorithms round-trip; the AESV3-dict and permissions cases still pass).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/crypto.ts src/encrypt.ts test/encrypt.test.ts
git commit -m "feat: RC4 (R3) and AES-128 (R4) encryptors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Serializer — classic encrypted output

**Files:**
- Modify: `src/serializer.ts`
- Test: `test/encrypt-save.test.ts`

**Interfaces:**
- Consumes: `buildEncryptor`, `Encryptor`, `EncryptOptions` from `encrypt.ts`; `randomBytes` from `crypto.ts`; existing `planDocument`, `serializeClassic`, `serializeCompressed`, `concat`, `enc`, `serializeObject`, `serializeValue`.
- Produces: `SerializeOptions.encrypt?: EncryptOptions`; `serializeClassicEncrypted(plan, encryptor, id0, id1)`; `serializeDocument` routes to it.

- [ ] **Step 1: Write the failing test**

Create `test/encrypt-save.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { InvalidPasswordError } from '../src/errors.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

const ALGOS = ['aes256', 'aes128', 'rc4'] as const;

describe('encrypted Save — classic', () => {
  for (const algorithm of ALGOS) {
    it(`${algorithm}: user password round-trips text`, () => {
      const doc = Document.Open(buildStampTarget());
      const bytes = doc.Save({ encrypt: { userPassword: 'u', ownerPassword: 'o', algorithm } });
      const reopened = Document.Open(bytes, { password: 'u' });
      expect(reopened.Pages[0].GetText()).toContain('Original');
    });

    it(`${algorithm}: wrong password throws InvalidPasswordError`, () => {
      const doc = Document.Open(buildStampTarget());
      const bytes = doc.Save({ encrypt: { userPassword: 'u', algorithm } });
      expect(() => Document.Open(bytes, { password: 'x' })).toThrow(InvalidPasswordError);
    });
  }

  it('aes256: owner password also opens', () => {
    const doc = Document.Open(buildStampTarget());
    const bytes = doc.Save({ encrypt: { userPassword: 'u', ownerPassword: 'o', algorithm: 'aes256' } });
    expect(() => Document.Open(bytes, { password: 'o' })).not.toThrow();
  });

  it('no encrypt option leaves output unencrypted', () => {
    const doc = Document.Open(buildStampTarget());
    const bytes = doc.Save();
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).not.toContain('/Encrypt');
    expect(Document.Open(bytes).Pages[0].GetText()).toContain('Original');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/encrypt-save.test.ts`
Expected: FAIL — `Save({ encrypt })` currently ignores `encrypt`; reopening with a password fails (or `/Encrypt` absent) so assertions fail.

- [ ] **Step 3: Wire encryption into `src/serializer.ts`**

Update imports at the top of `src/serializer.ts`:

```ts
import { PdfObject, PdfDict, PdfRef, PdfStream, isRef, isDict, isArray, isStream, isString, name, ref } from './types.js';
import { enc, serializeObject, serializeValue, serializeDict } from './serialize.js';
import { PdfParseError } from './errors.js';
import { buildEncryptor, Encryptor, EncryptOptions } from './encrypt.js';
import { randomBytes } from './crypto.js';
```

Extend `SerializeOptions`:

```ts
export interface SerializeOptions {
  compressed?: boolean;
  encrypt?: EncryptOptions;
}
```

Replace `serializeDocument` with the routing version:

```ts
export function serializeDocument(
  objects: Map<number, PdfObject>, trailer: PdfDict, options: SerializeOptions = {},
): Uint8Array {
  const plan = planDocument(objects, trailer);
  if (!options.encrypt) {
    return options.compressed ? serializeCompressed(plan, trailer) : serializeClassic(plan, trailer);
  }
  const { id0, id1 } = resolveIds(trailer);
  const encryptor = buildEncryptor(options.encrypt, id0);
  return options.compressed
    ? serializeCompressedEncrypted(plan, trailer, encryptor, id0, id1)
    : serializeClassicEncrypted(plan, encryptor, id0, id1);
}

/** First/second /ID elements, generating random 16-byte values when absent. */
function resolveIds(trailer: PdfDict): { id0: Uint8Array; id1: Uint8Array } {
  const id = trailer.get('ID');
  const at = (i: number): Uint8Array | undefined => {
    if (isArray(id) && isString(id[i])) return (id[i] as { bytes: Uint8Array }).bytes;
    return undefined;
  };
  return { id0: at(0) ?? randomBytes(16), id1: at(1) ?? randomBytes(16) };
}

const pdfStr = (bytes: Uint8Array): PdfObject => ({ kind: 'string', bytes });
```

Add the classic encrypted serializer (place after `serializeClassic`):

```ts
function serializeClassicEncrypted(
  plan: Plan, encryptor: Encryptor, id0: Uint8Array, id1: Uint8Array,
): Uint8Array {
  const { rootRef, oldToNew, objs } = plan;
  const n = objs.length;
  const encNum = n + 1;
  const encObjs = objs.map((o, i) => encryptor.encryptObject(o, i + 1, 0));

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array): void => { chunks.push(b); length += b.length; };

  push(enc('%PDF-1.7\n%âãÏÓ\n'));
  const offsets = new Array(encNum + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const num = i + 1;
    offsets[num] = length;
    push(enc(`${num} 0 obj\n`));
    push(serializeObject(encObjs[i]));
    push(enc('\nendobj\n'));
  }
  // /Encrypt dict — written verbatim, never encrypted
  offsets[encNum] = length;
  push(enc(`${encNum} 0 obj\n`));
  push(serializeObject(encryptor.encryptDict));
  push(enc('\nendobj\n'));

  const xrefStart = length;
  let xref = `xref\n0 ${encNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= encNum; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(enc(xref));

  let tr = `trailer\n<< /Size ${encNum + 1} /Root ${oldToNew.get(rootRef.num)} 0 R`;
  tr += ` /Encrypt ${encNum} 0 R /ID ${serializeValue([pdfStr(id0), pdfStr(id1)])}`;
  const infoRef = plan.infoRef;
  if (isRef(infoRef) && oldToNew.has(infoRef.num)) tr += ` /Info ${oldToNew.get(infoRef.num)} 0 R`;
  tr += ` >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(enc(tr));

  return concat(chunks);
}
```

Add a stub for the compressed path so the module compiles (replaced in Task 5):

```ts
function serializeCompressedEncrypted(
  _plan: Plan, _trailer: PdfDict, _encryptor: Encryptor, _id0: Uint8Array, _id1: Uint8Array,
): Uint8Array {
  throw new Error('compressed encrypted output not yet implemented');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/encrypt-save.test.ts`
Expected: PASS (classic cases for all three algorithms + owner + regression).

- [ ] **Step 5: Run the full suite (regression) and typecheck**

Run: `npx vitest run`
Expected: PASS — existing serializer tests unchanged (no-encrypt path untouched).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/serializer.ts test/encrypt-save.test.ts
git commit -m "feat: classic encrypted Save (Save({ encrypt }))

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Serializer — compressed encrypted output

**Files:**
- Modify: `src/serializer.ts` (replace the `serializeCompressedEncrypted` stub)
- Modify: `test/encrypt-save.test.ts` (add compressed cases)

**Interfaces:**
- Consumes: `deflateSync` (already imported in `serializer.ts`), the `Encryptor`, `byteWidth`, `putBE` (existing helpers).
- Produces: real `serializeCompressedEncrypted(plan, trailer, encryptor, id0, id1)`.

- [ ] **Step 1: Add the failing compressed tests**

Append to `test/encrypt-save.test.ts`:

```ts
describe('encrypted Save — compressed', () => {
  for (const algorithm of ALGOS) {
    it(`${algorithm}: user password round-trips text (compressed)`, () => {
      const doc = Document.Open(buildStampTarget());
      const bytes = doc.Save({ compressed: true, encrypt: { userPassword: 'u', algorithm } });
      const reopened = Document.Open(bytes, { password: 'u' });
      expect(reopened.Pages[0].GetText()).toContain('Original');
    });
  }

  it('compressed + no encrypt stays unencrypted', () => {
    const doc = Document.Open(buildStampTarget());
    const bytes = doc.Save({ compressed: true });
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('/Encrypt');
  });
});
```

- [ ] **Step 2: Run to verify the compressed cases fail**

Run: `npx vitest run test/encrypt-save.test.ts`
Expected: FAIL — `compressed encrypted output not yet implemented`.

- [ ] **Step 3: Replace the `serializeCompressedEncrypted` stub**

```ts
function serializeCompressedEncrypted(
  plan: Plan, _trailer: PdfDict, encryptor: Encryptor, id0: Uint8Array, id1: Uint8Array,
): Uint8Array {
  const { rootRef, oldToNew, objs } = plan;
  const n = objs.length;
  const objStmNum = n + 1;
  const encNum = n + 2;
  const xrefStmNum = n + 3;
  const size = n + 4;

  // Partition: streams stay direct (and are individually encrypted); everything
  // else packs into the ObjStm and is left PLAINTEXT (protected by ObjStm crypto).
  const compressedNums: number[] = [];
  const directNums: number[] = [];
  for (let i = 0; i < n; i++) (isStream(objs[i]) ? directNums : compressedNums).push(i + 1);

  // Build the plaintext ObjStm payload from the packed objects.
  let header = '';
  const bodies: string[] = [];
  let bodyLen = 0;
  compressedNums.forEach((num, idx) => {
    header += `${num} ${bodyLen} `;
    const body = serializeValue(objs[num - 1]) + (idx === compressedNums.length - 1 ? '' : '\n');
    bodies.push(body);
    bodyLen += enc(body).length;
  });
  const headerBytes = enc(header);
  const objStmPlain = concat([headerBytes, enc(bodies.join(''))]);
  // Deflate THEN encrypt the whole ObjStm stream by its own object number.
  const objStmRaw = encryptor.encryptStreamRaw(
    new Uint8Array(deflateSync(Buffer.from(objStmPlain))), objStmNum, 0,
  );
  const objStm: PdfStream = {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('ObjStm')],
      ['N', compressedNums.length],
      ['First', headerBytes.length],
      ['Filter', name('FlateDecode')],
    ]),
    raw: objStmRaw,
  };

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array): void => { chunks.push(b); length += b.length; };
  const offsets = new Map<number, number>();

  push(enc('%PDF-1.7\n%âãÏÓ\n'));
  for (const num of directNums) {
    offsets.set(num, length);
    const encObj = encryptor.encryptObject(objs[num - 1], num, 0); // stream: dict strings + raw
    push(enc(`${num} 0 obj\n`));
    push(serializeObject(encObj));
    push(enc('\nendobj\n'));
  }
  const objStmOffset = length;
  push(enc(`${objStmNum} 0 obj\n`));
  push(serializeObject(objStm));
  push(enc('\nendobj\n'));

  // /Encrypt as a direct object (never packed, never encrypted).
  const encOffset = length;
  push(enc(`${encNum} 0 obj\n`));
  push(serializeObject(encryptor.encryptDict));
  push(enc('\nendobj\n'));

  const xrefOffset = length;

  type Row = [number, number, number];
  const rows: Row[] = new Array(size);
  rows[0] = [0, 0, 0xffff];
  const indexInObjStm = new Map<number, number>();
  compressedNums.forEach((num, idx) => indexInObjStm.set(num, idx));
  for (let num = 1; num <= n; num++) {
    if (indexInObjStm.has(num)) rows[num] = [2, objStmNum, indexInObjStm.get(num)!];
    else rows[num] = [1, offsets.get(num)!, 0];
  }
  rows[objStmNum] = [1, objStmOffset, 0];
  rows[encNum] = [1, encOffset, 0];
  rows[xrefStmNum] = [1, xrefOffset, 0];

  let maxF1 = 0, maxF2 = 0;
  for (const [, f1, f2] of rows) { if (f1 > maxF1) maxF1 = f1; if (f2 > maxF2) maxF2 = f2; }
  const w = [1, byteWidth(maxF1), byteWidth(maxF2)];
  const rowLen = w[0] + w[1] + w[2];
  const table = new Uint8Array(size * rowLen);
  let tp = 0;
  for (const [f0, f1, f2] of rows) {
    tp = putBE(table, tp, f0, w[0]);
    tp = putBE(table, tp, f1, w[1]);
    tp = putBE(table, tp, f2, w[2]);
  }
  const xrefRaw = new Uint8Array(deflateSync(Buffer.from(table))); // XRef stream never encrypted

  const xrefDict: PdfDict = new Map<string, PdfObject>();
  xrefDict.set('Type', name('XRef'));
  xrefDict.set('Size', size);
  xrefDict.set('Root', ref(oldToNew.get(rootRef.num)!, 0));
  const infoRef = plan.infoRef;
  if (isRef(infoRef) && oldToNew.has(infoRef.num)) xrefDict.set('Info', ref(oldToNew.get(infoRef.num)!, 0));
  xrefDict.set('Encrypt', ref(encNum, 0));
  xrefDict.set('ID', [pdfStr(id0), pdfStr(id1)]);
  xrefDict.set('W', w);
  xrefDict.set('Filter', name('FlateDecode'));
  xrefDict.set('Length', xrefRaw.length);

  push(enc(`${xrefStmNum} 0 obj\n`));
  push(enc(serializeDict(xrefDict) + '\nstream\n'));
  push(xrefRaw);
  push(enc('\nendstream\nendobj\n'));
  push(enc(`startxref\n${xrefOffset}\n%%EOF\n`));

  return concat(chunks);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/encrypt-save.test.ts`
Expected: PASS (classic + compressed for all three algorithms).

- [ ] **Step 5: Full suite + typecheck**

Run: `npx vitest run`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/serializer.ts test/encrypt-save.test.ts
git commit -m "feat: compressed encrypted Save (encrypted ObjStm, plain XRef stream)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Permissions/metadata integration tests, exports, README

**Files:**
- Modify: `test/encrypt-save.test.ts` (permissions + encryptMetadata)
- Modify: `src/index.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `permissionsToP` from `encrypt.ts`.
- Produces: public exports of `EncryptOptions`/`Permissions`.

- [ ] **Step 1: Add the failing permission/metadata tests**

Append to `test/encrypt-save.test.ts`:

```ts
import { permissionsToP } from '../src/encrypt.js';

describe('encrypted Save — options', () => {
  it('writes the computed /P for restricted permissions', () => {
    const perms = { copying: false, printing: false };
    const doc = Document.Open(buildStampTarget());
    const bytes = doc.Save({ encrypt: { userPassword: 'u', permissions: perms } });
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain(`/P ${permissionsToP(perms)}`);
  });

  it('encryptMetadata:false emits /EncryptMetadata false and still opens', () => {
    const doc = Document.Open(buildStampTarget());
    const bytes = doc.Save({ encrypt: { userPassword: 'u', encryptMetadata: false } });
    expect(new TextDecoder('latin1').decode(bytes)).toContain('/EncryptMetadata false');
    expect(Document.Open(bytes, { password: 'u' }).Pages[0].GetText()).toContain('Original');
  });

  it('unknown algorithm throws TypeError', () => {
    const doc = Document.Open(buildStampTarget());
    // @ts-expect-error invalid algorithm on purpose
    expect(() => doc.Save({ encrypt: { algorithm: 'des' } })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify (the permission/metadata cases) — they should already pass once the import resolves**

Run: `npx vitest run test/encrypt-save.test.ts`
Expected: PASS — these assert behaviour already implemented in Tasks 2–5; this step locks it in. If `permissionsToP` import fails to resolve, that's a real bug to fix before continuing.

- [ ] **Step 3: Export the new types from `src/index.ts`**

Add after the existing `StampOptions`/graphics exports:

```ts
export type { EncryptOptions, Permissions } from './encrypt.js';
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Update `README.md`**

In the **Features** list, replace the "Saving" bullet's tail or add after it:

```markdown
- **Encrypted output** — `Save({ encrypt })` writes a PDF protected with the standard security handler: AES-256 (default), AES-128, or RC4. Set user/owner passwords, restrict permissions with named flags, and toggle metadata encryption. Works with classic and compressed output.
```

Add a usage section after the "Encrypted PDFs" (open) section:

````markdown
### Encrypted output

```ts
const doc = Document.OpenFile('in.pdf');
doc.WriteTo('locked.pdf', {
  encrypt: {
    userPassword: 'open-me',       // required to open (default '')
    ownerPassword: 'full-rights',  // default: same as userPassword
    algorithm: 'aes256',           // 'aes256' (default) | 'aes128' | 'rc4'
    permissions: { copying: false, modifying: false },
    encryptMetadata: true,
  },
});
```

The output re-opens with either password via `Document.Open(bytes, { password })`.
Permission flags (`printing`, `modifying`, `copying`, `annotating`,
`fillingForms`, `accessibility`, `assembling`, `highQualityPrinting`) each
default to allowed. `algorithm` other than the three names throws `TypeError`.
````

In the **API overview** table, add a row:

```markdown
| `doc.Save({ encrypt })` / `WriteTo(name, { encrypt })` | Write a standard-security-handler encrypted PDF (AES-256/128, RC4) |
```

In **Limitations**, remove the line:

```markdown
- **No encrypted output** — encryption is handled on open only; `Save()` always produces an unencrypted PDF.
```

and add:

```markdown
- **Encrypted output passwords are UTF-8, not SASLprep-normalized** (R6), matching the read side. Opening an RC4/AES-128 file requires the *user* password (the reader does not derive the user key from the owner password for R≤4).
```

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test`
Expected: PASS (all suites).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add test/encrypt-save.test.ts src/index.ts README.md
git commit -m "feat: export encrypt types; permission/metadata tests; document encrypted Save

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review notes

- **Spec coverage:** ciphers → Task 1; AES-256 + `/P` → Task 2; RC4/AES-128 → Task 3; classic serializer integration + `/ID` generation + `/Encrypt` object + no-encrypt regression → Task 4; compressed (encrypted ObjStm, plaintext packed objects, never-encrypted XRef stream, direct `/Encrypt`) → Task 5; permissions/`encryptMetadata`/`/Perms`/exports/README → Tasks 2 & 6. Algorithm-validation `TypeError` → Tasks 2 (unit) & 6 (integration).
- **Interface consistency:** `Encryptor.encryptObject` returns `PdfObject` everywhere (refines the spec's "in place" wording — required because `PdfStream.raw` is readonly; matches `decryptObject`). `buildEncryptor(opts, id0)`, `permissionsToP`, `EncryptOptions`/`Permissions` names are identical across tasks. The `buildR34` stub (Task 2) → real (Task 3) and `serializeCompressedEncrypted` stub (Task 4) → real (Task 5) are the two intentional same-signature hand-offs, each called out in its task.
- **Deviations from spec, by design:** (1) owner-password open is tested for AES-256 only, because the existing reader validates only the user password for R≤4 — documented in Global Constraints and README. (2) The deep `/Perms` "adb marker" assertion from the spec is covered indirectly: `/Perms` is produced by Algorithm 13 in Task 2 and every AES-256 file round-trips; a byte-level `/Perms` decrypt test is omitted because it would require re-deriving the file key in the test. (3) "Metadata stream readable without key" is asserted as flag-presence + successful re-open, since the `buildStampTarget` fixture has no `/Metadata` stream.
- **Placeholder scan:** none — every code step is complete; the two stubs are explicit, named, and replaced in later tasks.
```
