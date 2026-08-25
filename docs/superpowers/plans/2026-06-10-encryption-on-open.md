# Encryption support on Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open RC4, AES-128, and AES-256 encrypted PDFs (empty or correct password) so strings/streams decrypt transparently and `Save()` round-trips to plaintext.

**Architecture:** A self-contained `src/crypto.ts` exposes vector-pinned ciphers (hand-rolled RC4, Node AES-CBC) plus standard-security-handler key derivation, wrapped in a `Decryptor`. `Document.Open` builds the decryptor from the `/Encrypt` dict and, inline in its existing `parseEntry` closure, decrypts each top-level `offset` object by its `num`/`gen`. Objects from object streams and the `/Encrypt` dict are exempt. A test-only encryptor in `test/helpers/` produces fixtures.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `crypto` (md5/sha2/aes), Vitest.

**Reference spec:** `docs/superpowers/specs/2026-06-10-encryption-on-open-design.md`

---

## File Structure

- **Create `src/crypto.ts`** — ciphers (`rc4`, `aesCbcDecrypt`, `aesCbc128Encrypt`), hashes/padding, key derivation (`fileKeyR234`, `objectKeyV4`, `hash2B`, `fileKeyR56`), crypt-filter resolution, `buildDecryptor` → `Decryptor`. One responsibility: turn an `/Encrypt` dict + password into per-object decryption.
- **Create `test/helpers/encrypt-pdf.ts`** — test-only PDF encryptor reusing derivation/ciphers from `crypto.ts`; given a plaintext object set, emits an encrypted classic-xref PDF for a chosen V/R/cipher/password.
- **Modify `src/errors.ts`** — add `InvalidPasswordError`.
- **Modify `src/document.ts`** — `OpenOptions`, thread `password` through `Open`/`OpenFile`, build + apply the decryptor in `parseEntry`, strip `/Encrypt` in `Save()`.
- **Create tests:** `test/crypto.test.ts` (primitives + derivation ground-truth), `test/encryption.test.ts` (end-to-end open/round-trip).

A note on circularity: the encryptor reuses `crypto.ts` derivation, so end-to-end round-trips primarily validate cipher application, the object walker, and `Open` wiring. Derivation correctness is anchored independently in Task 3 (Node `md5` as ground truth) and the pinned 32-byte padding constant; ciphers are anchored in Tasks 1–2 against published vectors.

---

### Task 1: RC4 cipher (vector-pinned)

**Files:**
- Create: `src/crypto.ts`
- Test: `test/crypto.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/crypto.test.ts
import { describe, it, expect } from 'vitest';
import { rc4 } from '../src/crypto.js';

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const ascii = (s: string) => new TextEncoder().encode(s);

describe('rc4', () => {
  // Classic published RC4 test vectors.
  it('Key/Plaintext', () => {
    expect(rc4(ascii('Key'), ascii('Plaintext'))).toEqual(hex('bbf316e8d940af0ad3'));
  });
  it('Wiki/pedia', () => {
    expect(rc4(ascii('Wiki'), ascii('pedia'))).toEqual(hex('1021bf0420'));
  });
  it('Secret/Attack at dawn', () => {
    expect(rc4(ascii('Secret'), ascii('Attack at dawn'))).toEqual(hex('45a01f645fc35b383552544b9bf5'));
  });
  it('is symmetric (decrypt undoes encrypt)', () => {
    const key = ascii('Key');
    const ct = rc4(key, ascii('Plaintext'));
    expect(new TextDecoder().decode(rc4(key, ct))).toBe('Plaintext');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/crypto.test.ts`
Expected: FAIL — `rc4` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/crypto.ts
/** RC4 stream cipher. Symmetric: the same call encrypts and decrypts. */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0, b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff;
    b = (b + s[a]) & 0xff;
    const t = s[a]; s[a] = s[b]; s[b] = t;
    out[k] = data[k] ^ s[(s[a] + s[b]) & 0xff];
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/crypto.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/crypto.ts test/crypto.test.ts
git commit -m "feat(crypto): RC4 cipher with published test vectors (u91)"
```

---

### Task 2: AES-CBC decrypt + AES-128 encrypt helpers

**Files:**
- Modify: `src/crypto.ts`
- Test: `test/crypto.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to test/crypto.test.ts
import { aesCbcDecrypt, aesCbc128Encrypt } from '../src/crypto.js';
import { createCipheriv } from 'node:crypto';

describe('aesCbcDecrypt', () => {
  it('round-trips AES-128 with PKCS#7 padding, IV prefixed', () => {
    const key = hex('00112233445566778899aabbccddeeff');
    const iv = hex('0f0e0d0c0b0a09080706050403020100');
    const plain = ascii('hello pdf encryption!'); // 21 bytes -> padded
    const c = createCipheriv('aes-128-cbc', key, iv);
    const body = Buffer.concat([c.update(plain), c.final()]);
    const data = new Uint8Array([...iv, ...body]); // PDF prepends IV
    expect(aesCbcDecrypt(key, data)).toEqual(plain);
  });

  it('round-trips AES-256', () => {
    const key = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    const iv = hex('00000000000000000000000000000000');
    const plain = ascii('thirty-two bytes? no, just text.');
    const c = createCipheriv('aes-256-cbc', key, iv);
    const body = Buffer.concat([c.update(plain), c.final()]);
    expect(aesCbcDecrypt(key, new Uint8Array([...iv, ...body]))).toEqual(plain);
  });

  it('returns empty for sub-block data', () => {
    expect(aesCbcDecrypt(hex('00112233445566778899aabbccddeeff'), hex('0011'))).toEqual(new Uint8Array(0));
  });
});

describe('aesCbc128Encrypt (no padding)', () => {
  it('matches Node createCipheriv with autoPadding off', () => {
    const key = hex('00112233445566778899aabbccddeeff');
    const iv = hex('0f0e0d0c0b0a09080706050403020100');
    const plain = hex('00000000000000000000000000000000'); // exactly one block
    const c = createCipheriv('aes-128-cbc', key, iv); c.setAutoPadding(false);
    const exp = new Uint8Array(Buffer.concat([c.update(plain), c.final()]));
    expect(aesCbc128Encrypt(key, iv, plain)).toEqual(exp);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/crypto.test.ts`
Expected: FAIL — `aesCbcDecrypt` / `aesCbc128Encrypt` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/crypto.ts
import { createCipheriv, createDecipheriv } from 'node:crypto';

/** Decrypt PDF AES-CBC data: first 16 bytes are the IV, rest is ciphertext with
 *  PKCS#7 padding. Key length selects AES-128 vs AES-256. Sub-block input -> []. */
export function aesCbcDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 32) return new Uint8Array(0); // need IV + >=1 padded block
  const iv = data.subarray(0, 16);
  const body = data.subarray(16);
  const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const d = createDecipheriv(algo, key, iv);
  d.setAutoPadding(true);
  return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
}

/** AES-256-CBC decrypt with an explicit IV and NO padding (for /UE, /OE). */
export function aesCbcDecryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
  const d = createDecipheriv(algo, key, iv);
  d.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([d.update(data), d.final()]));
}

/** AES-128-CBC encrypt with explicit IV and NO padding (used by the R6 hash). */
export function aesCbc128Encrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/crypto.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/crypto.ts test/crypto.test.ts
git commit -m "feat(crypto): AES-CBC decrypt + AES-128 no-pad encrypt helpers (u91)"
```

---

### Task 3: Hashes, padding, and R2–R4 key derivation (Algorithm 1 & 2)

**Files:**
- Modify: `src/crypto.ts`
- Test: `test/crypto.test.ts`

- [ ] **Step 1: Write the failing test** (uses Node `md5` as independent ground truth)

```ts
// add to test/crypto.test.ts
import { PASSWORD_PADDING, padPassword, fileKeyR234, objectKeyV4 } from '../src/crypto.js';
import { createHash } from 'node:crypto';

const md5node = (b: Uint8Array) => new Uint8Array(createHash('md5').update(b).digest());
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

describe('key derivation', () => {
  it('padding string is the spec 32-byte constant', () => {
    expect(PASSWORD_PADDING.length).toBe(32);
    expect(Buffer.from(PASSWORD_PADDING).toString('hex')).toBe(
      '28bf4e5e4e758a41640' + '04e56fffa01082e2e00b6d0683e802f0ca9fe6453697a');
  });

  it('padPassword of empty password is exactly the padding string', () => {
    expect(padPassword(new Uint8Array(0))).toEqual(PASSWORD_PADDING);
  });

  it('padPassword truncates passwords longer than 32 bytes', () => {
    const long = new Uint8Array(40).fill(0x41);
    expect(padPassword(long)).toEqual(new Uint8Array(32).fill(0x41));
  });

  it('fileKeyR234 at R=2 equals one MD5 over the spec inputs (ground truth)', () => {
    const pw = new Uint8Array(0);
    const O = new Uint8Array(32).fill(0x11);
    const id0 = hex('cafebabe');
    const P = -44; // typical permissions
    const pLE = new Uint8Array([P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >> 24) & 0xff]);
    const expected = md5node(cat(padPassword(pw), O, pLE, id0)).subarray(0, 5);
    expect(fileKeyR234(pw, O, P, id0, 2, 40, true)).toEqual(expected);
  });

  it('fileKeyR234 at R=3 applies 50 extra MD5 rounds (ground truth)', () => {
    const pw = new Uint8Array(0);
    const O = new Uint8Array(32).fill(0x22);
    const id0 = hex('0badf00d');
    const P = -3904;
    const n = 16; // 128-bit
    const pLE = new Uint8Array([P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >> 24) & 0xff]);
    let h = md5node(cat(padPassword(pw), O, pLE, id0));
    for (let i = 0; i < 50; i++) h = md5node(h.subarray(0, n));
    expect(fileKeyR234(pw, O, P, id0, 3, 128, true)).toEqual(h.subarray(0, n));
  });

  it('objectKeyV4 (RC4) matches MD5(fileKey + num3 + gen2) truncated', () => {
    const fk = new Uint8Array(16).fill(0xab);
    const exp = md5node(cat(fk, new Uint8Array([7, 0, 0, 0, 0]))).subarray(0, 16);
    expect(objectKeyV4(fk, 7, 0, false)).toEqual(exp);
  });

  it('objectKeyV4 (AES) appends the sAlT bytes', () => {
    const fk = new Uint8Array(16).fill(0xcd);
    const salt = new Uint8Array([0x73, 0x41, 0x6c, 0x54]); // "sAlT"
    const exp = md5node(cat(fk, new Uint8Array([5, 0, 0, 1, 0]), salt)).subarray(0, 16);
    expect(objectKeyV4(fk, 5, 1, true)).toEqual(exp);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/crypto.test.ts`
Expected: FAIL — symbols not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/crypto.ts
import { createHash } from 'node:crypto';

const md5 = (b: Uint8Array) => new Uint8Array(createHash('md5').update(b).digest());
export const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
export const sha384 = (b: Uint8Array) => new Uint8Array(createHash('sha384').update(b).digest());
export const sha512 = (b: Uint8Array) => new Uint8Array(createHash('sha512').update(b).digest());

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** The 32-byte password padding string (PDF spec, Algorithm 2 step a). */
export const PASSWORD_PADDING = Uint8Array.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
]);

/** Pad/truncate a password to exactly 32 bytes per Algorithm 2 step a. */
export function padPassword(pw: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  const n = Math.min(pw.length, 32);
  out.set(pw.subarray(0, n), 0);
  out.set(PASSWORD_PADDING.subarray(0, 32 - n), n);
  return out;
}

/** Algorithm 2: compute the file encryption key for R2–R4.
 *  `length` is the key length in bits; returns length/8 bytes. */
export function fileKeyR234(
  pw: Uint8Array, O: Uint8Array, P: number, id0: Uint8Array,
  R: number, length: number, encryptMetadata: boolean,
): Uint8Array {
  const n = length / 8;
  const pLE = new Uint8Array([P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >>> 24) & 0xff]);
  const meta = (R >= 4 && !encryptMetadata) ? Uint8Array.from([0xff, 0xff, 0xff, 0xff]) : new Uint8Array(0);
  let h = md5(concat(padPassword(pw), O.subarray(0, 32), pLE, id0, meta));
  if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.subarray(0, n);
}

/** Algorithm 1: per-object key for V<=4. `isAes` appends the "sAlT" bytes. */
export function objectKeyV4(fileKey: Uint8Array, num: number, gen: number, isAes: boolean): Uint8Array {
  const ext = concat(
    fileKey,
    new Uint8Array([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]),
    isAes ? Uint8Array.from([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0),
  );
  return md5(ext).subarray(0, Math.min(fileKey.length + 5, 16));
}
```

Note: keep the local `concat` and `md5` helpers — they are reused by later tasks.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/crypto.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/crypto.ts test/crypto.test.ts
git commit -m "feat(crypto): password padding + R2-R4/Algorithm-1 key derivation (u91)"
```

---

### Task 4: Test-only PDF encryptor (RC4 R3)

**Files:**
- Create: `test/helpers/encrypt-pdf.ts`
- Test: `test/helpers/encrypt-pdf.test.ts` (sanity check the helper produces a parseable shell)

The encryptor reuses derivation/ciphers from `src/crypto.ts`. It takes a map of
plaintext indirect objects (numbers → serialized body strings are NOT used here;
we operate on the live `PdfObject` model so we can encrypt strings/streams) and
emits encrypted PDF bytes. To keep it small it supports exactly what the tests
need: classic xref, a `/Catalog`+`/Pages` tree the caller supplies, and one
security configuration at a time.

- [ ] **Step 1: Write the helper** (no separate failing test first — this is test infrastructure; Step 3 adds a sanity test)

```ts
// test/helpers/encrypt-pdf.ts
import { createHash, randomBytes } from 'node:crypto';
import {
  rc4, aesCbc128Encrypt, fileKeyR234, objectKeyV4, padPassword, PASSWORD_PADDING,
} from '../../src/crypto.js';

export interface EncryptConfig {
  cipher: 'rc4' | 'aes128' | 'aes256';
  R: number;            // 3 (rc4), 4 (aes128), 6 (aes256)
  V: number;            // 2, 4, 5
  length: number;       // key bits: 128 (rc4/aes128), 256 (aes256)
  userPassword?: string;       // default ''
  encryptMetadata?: boolean;   // default true
}

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...a: Uint8Array[]) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const md5 = (b: Uint8Array) => new Uint8Array(createHash('md5').update(b).digest());

/** Compute /O for R2-4: RC4 of padded user pw under a key derived from owner pw.
 *  Tests use ownerPassword === userPassword, so this collapses but stays correct. */
function computeO(userPw: Uint8Array, ownerPw: Uint8Array, R: number, n: number): Uint8Array {
  let key = md5(padPassword(ownerPw));
  if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
  key = key.subarray(0, n);
  let data = padPassword(userPw);
  data = rc4(key, data);
  if (R >= 3) for (let i = 1; i <= 19; i++) {
    const k = key.map((b) => b ^ i);
    data = rc4(k, data);
  }
  return data;
}

/** Compute /U for R3-4 (Algorithm 5). */
function computeU(fileKey: Uint8Array, id0: Uint8Array): Uint8Array {
  const h = md5(cat(PASSWORD_PADDING, id0));
  let data = rc4(fileKey, h);
  for (let i = 1; i <= 19; i++) data = rc4(fileKey.map((b) => b ^ i), data);
  return cat(data, new Uint8Array(16)); // 32 bytes (16 arbitrary trailing)
}

export interface PlainDoc {
  /** indirect objects, 1-based; index 0 unused. Each is a serialized body WITHOUT
   *  the surrounding `N 0 obj`/`endobj`. Streams use the `<<dict>>\nstream\n...` form
   *  with a {{STREAM:bytes}} placeholder resolved by the caller-built encryptor. */
  objects: string[];
  rootNum: number;
  /** object numbers whose body is a stream, with the raw (pre-encryption) bytes. */
  streams: Map<number, Uint8Array>;
  /** object numbers carrying a literal string to encrypt, with raw bytes + the
   *  placeholder token used in the body. */
  strings: Map<number, { token: string; bytes: Uint8Array }[]>;
}
```

This `PlainDoc` shape is fiddly. To keep the helper simple and the tests
readable, the helper instead builds the PDF itself from a tiny page model:

```ts
// REPLACE the PlainDoc section above with this simpler model.
export interface SimpleDoc {
  /** /Info-style metadata strings (encrypted as object strings). */
  info?: Record<string, string>;
  /** page content streams (encrypted as object streams), one per page. */
  pageContents: string[];
}

/** Build an encrypted classic-xref PDF: 1 Catalog, 2 Pages, then per page a Page
 *  dict + Contents stream, then optional Info. Strings/streams are encrypted per
 *  `cfg`; the trailer carries /Encrypt and /ID. Returns { bytes, plain } so tests
 *  can assert the decrypted values. */
export function buildEncryptedPdf(cfg: EncryptConfig, doc: SimpleDoc): {
  bytes: Uint8Array;
  expected: { info?: Record<string, string>; pageContents: string[] };
} {
  const userPw = enc(cfg.userPassword ?? '');
  const encryptMetadata = cfg.encryptMetadata ?? true;
  const n = cfg.length / 8;
  const P = -44;
  const id0 = randomBytes(16);

  // --- derive keys (RC4/AES-128 path; AES-256 added in Task 7) ---
  const O = computeO(userPw, userPw, cfg.R, n);
  const fileKey = fileKeyR234(userPw, O, P, new Uint8Array(id0), cfg.R, cfg.length, encryptMetadata);
  const U = computeU(fileKey, new Uint8Array(id0));
  const isAes = cfg.cipher !== 'rc4';

  const encBytes = (num: number, data: Uint8Array): Uint8Array => {
    const key = objectKeyV4(fileKey, num, 0, isAes);
    if (!isAes) return rc4(key, data);
    const iv = randomBytes(16);
    // PKCS#7 pad then AES-128-CBC, prefix IV.
    const padLen = 16 - (data.length % 16);
    const padded = cat(data, new Uint8Array(padLen).fill(padLen));
    return cat(new Uint8Array(iv), aesCbc128Encrypt(key, new Uint8Array(iv), padded));
  };

  const encString = (num: number, s: string): string => {
    const ct = encBytes(num, enc(s));
    // hex-string literal so arbitrary bytes survive
    return '<' + Buffer.from(ct).toString('hex') + '>';
  };

  // --- object layout ---
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  const pageNums: number[] = [];
  let next = 3;
  const contentNums: number[] = [];
  for (let i = 0; i < doc.pageContents.length; i++) { pageNums.push(next++); contentNums.push(next++); }
  objects[2] = `<< /Type /Pages /Count ${pageNums.length} /Kids [${pageNums.map((p) => `${p} 0 R`).join(' ')}] /MediaBox [0 0 200 200] >>`;

  const streamCt = new Map<number, Uint8Array>();
  for (let i = 0; i < doc.pageContents.length; i++) {
    const pageNum = pageNums[i], contentNum = contentNums[i];
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents ${contentNum} 0 R >>`;
    const ct = encBytes(contentNum, enc(doc.pageContents[i]));
    streamCt.set(contentNum, ct);
    objects[contentNum] = `<< /Length ${ct.length} >>\nstream\n{{STREAM:${contentNum}}}\nendstream`;
  }
  let maxObj = next - 1;
  let infoNum: number | undefined;
  if (doc.info) {
    infoNum = ++maxObj;
    const body = Object.entries(doc.info).map(([k, v]) => `/${k} ${encString(infoNum!, v)}`).join(' ');
    objects[infoNum] = `<< ${body} >>`;
  }

  // --- /Encrypt object ---
  const encNum = ++maxObj;
  const Ohex = Buffer.from(O).toString('hex');
  const Uhex = Buffer.from(U).toString('hex');
  let encDict: string;
  if (cfg.V === 2) {
    encDict = `<< /Filter /Standard /V 2 /R ${cfg.R} /Length ${cfg.length} /P ${P} /O <${Ohex}> /U <${Uhex}> >>`;
  } else {
    const cfm = cfg.cipher === 'aes128' ? 'AESV2' : 'V2';
    const em = encryptMetadata ? '' : ' /EncryptMetadata false';
    encDict = `<< /Filter /Standard /V 4 /R ${cfg.R} /Length ${cfg.length} /P ${P} /O <${Ohex}> /U <${Uhex}>`
      + ` /CF << /StdCF << /CFM /${cfm} /Length ${n} >> >> /StmF /StdCF /StrF /StdCF${em} >>`;
  }
  objects[encNum] = encDict;

  // --- serialize ---
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const parts: Uint8Array[] = [enc(body)];
  let pos = enc(body).length;
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let num = 1; num <= maxObj; num++) {
    if (!objects[num]) continue;
    offsets[num] = pos;
    const header = enc(`${num} 0 obj\n`);
    parts.push(header); pos += header.length;
    if (streamCt.has(num)) {
      const [pre, post] = objects[num].split(`{{STREAM:${num}}}`);
      const a = enc(pre), b = streamCt.get(num)!, c = enc(post + `\nendobj\n`);
      parts.push(a, b, c); pos += a.length + b.length + c.length;
    } else {
      const a = enc(`${objects[num]}\nendobj\n`);
      parts.push(a); pos += a.length;
    }
  }
  const xrefOffset = pos;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= maxObj; num++) xref += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`;
  const idHex = Buffer.from(id0).toString('hex');
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${1} 0 R /Encrypt ${encNum} 0 R /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(enc(xref + trailer));

  let total = 0; for (const p of parts) total += p.length;
  const bytes = new Uint8Array(total); let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
  return { bytes, expected: { info: doc.info, pageContents: doc.pageContents } };
}
```

- [ ] **Step 2: Add a sanity test for the helper**

```ts
// test/helpers/encrypt-pdf.test.ts
import { describe, it, expect } from 'vitest';
import { buildEncryptedPdf } from './encrypt-pdf.js';

describe('buildEncryptedPdf helper', () => {
  it('produces bytes with an /Encrypt trailer and an xref', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'rc4', V: 2, R: 3, length: 128 },
      { info: { Title: 'Secret' }, pageContents: ['BT (Hi) Tj ET'] },
    );
    const text = Buffer.from(bytes).toString('latin1');
    expect(text).toContain('/Encrypt');
    expect(text).toContain('startxref');
    expect(text).toContain('/ID [<');
  });
});
```

- [ ] **Step 3: Run the sanity test**

Run: `npx vitest run test/helpers/encrypt-pdf.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/encrypt-pdf.ts test/helpers/encrypt-pdf.test.ts
git commit -m "test: PDF encryptor helper for RC4/AES-128 fixtures (u91)"
```

---

### Task 5: `Decryptor` + `buildDecryptor` (RC4 path) and wire into `Open`

**Files:**
- Modify: `src/errors.ts`, `src/crypto.ts`, `src/document.ts`
- Test: `test/encryption.test.ts`

- [ ] **Step 1: Write the failing end-to-end test**

```ts
// test/encryption.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { inflateStream } from '../src/flate.js';
import { buildEncryptedPdf } from './helpers/encrypt-pdf.js';
import { isStream } from '../src/types.js';

const dec = new TextDecoder();

describe('Open: RC4 (V2/R3) empty password', () => {
  it('decrypts info strings and content streams', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'rc4', V: 2, R: 3, length: 128 },
      { info: { Title: 'Hello RC4', Author: 'Oleg' }, pageContents: ['BT (Page one) Tj ET'] },
    );
    const doc = Document.Open(bytes);
    const md = doc.GetMetadata();
    expect(md.title).toBe('Hello RC4');
    expect(md.author).toBe('Oleg');

    const page = doc.Pages[0];
    const contents = doc.resolve(page.Dict.get('Contents'));
    expect(isStream(contents)).toBe(true);
    if (isStream(contents)) {
      expect(dec.decode(inflateStream(contents))).toBe('BT (Page one) Tj ET');
    }
  });
});
```

(`Metadata` fields are lowercase — `title`, `author`, etc. — per `src/metadata.ts`. The `/Info` dict *keys* the encryptor writes are PDF-cased: `Title`, `Author`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/encryption.test.ts`
Expected: FAIL — currently `Open` throws `UnsupportedFeatureError('encrypted PDFs are not supported')`.

- [ ] **Step 3a: Add the error class**

```ts
// add to src/errors.ts
export class InvalidPasswordError extends Error {
  constructor(message = 'PDF is password-protected: wrong or missing password') {
    super(message); this.name = 'InvalidPasswordError';
  }
}
```

- [ ] **Step 3b: Implement `buildDecryptor` + `Decryptor` (RC4/AES-128 via crypt filters; AES-256 added in Task 7)**

```ts
// add to src/crypto.ts
import { PdfObject, PdfDict, isDict, isStream, isString, isArray, isName } from './types.js';
import { InvalidPasswordError, UnsupportedFeatureError } from './errors.js';

type Cipher = 'rc4' | 'aes128' | 'aes256' | 'identity';

export interface Decryptor {
  decryptObject(obj: PdfObject, num: number, gen: number): PdfObject;
}

type Resolve = (o: PdfObject | undefined) => PdfObject;
const asNum = (o: PdfObject): number | undefined => (typeof o === 'number' ? o : undefined);
const asName = (o: PdfObject): string | undefined => (isName(o) ? o.name : undefined);
const asBytes = (o: PdfObject): Uint8Array | undefined => (isString(o) ? o.bytes : undefined);

/** Map a crypt-filter /CFM name to our cipher tag. */
function cfmToCipher(cfm: string | undefined): Cipher {
  switch (cfm) {
    case 'V2': return 'rc4';
    case 'AESV2': return 'aes128';
    case 'AESV3': return 'aes256';
    case 'Identity': case undefined: return 'identity';
    default: throw new UnsupportedFeatureError(`unsupported crypt filter /CFM ${cfm}`);
  }
}

/** Resolve /StmF or /StrF (a filter name) to a cipher via /CF. */
function filterCipher(cf: PdfObject, filterName: string | undefined, resolve: Resolve): Cipher {
  if (filterName === undefined || filterName === 'Identity') return 'identity';
  const cfDict = resolve(cf);
  if (!isDict(cfDict)) return 'identity';
  const entry = resolve(cfDict.get(filterName));
  if (!isDict(entry)) return 'identity';
  return cfmToCipher(asName(entry.get('CFM')));
}

/**
 * Build a Decryptor from a resolved /Encrypt dict, the first /ID element, and a
 * password. Returns undefined when nothing needs decrypting. Throws
 * UnsupportedFeatureError for non-standard handlers and InvalidPasswordError on
 * a password that validates against neither /U nor /O.
 */
export function buildDecryptor(
  encrypt: PdfDict, id0: Uint8Array | undefined, password: string, resolve: Resolve,
): Decryptor | undefined {
  const filter = asName(resolve(encrypt.get('Filter')));
  if (filter !== 'Standard') throw new UnsupportedFeatureError(`unsupported security handler: ${filter}`);

  const V = asNum(resolve(encrypt.get('V'))) ?? 0;
  const R = asNum(resolve(encrypt.get('R'))) ?? 0;
  const length = asNum(resolve(encrypt.get('Length'))) ?? 40;
  const P = asNum(resolve(encrypt.get('P'))) ?? 0;
  const O = asBytes(resolve(encrypt.get('O'))) ?? new Uint8Array(0);
  const U = asBytes(resolve(encrypt.get('U'))) ?? new Uint8Array(0);
  const encryptMetadata = resolve(encrypt.get('EncryptMetadata')) !== false;
  const pw = new TextEncoder().encode(password);
  const id = id0 ?? new Uint8Array(0);

  // crypt-filter selection
  let streamCipher: Cipher;
  let stringCipher: Cipher;
  if (V >= 4) {
    const cf = encrypt.get('CF');
    streamCipher = filterCipher(cf, asName(resolve(encrypt.get('StmF'))), resolve);
    stringCipher = filterCipher(cf, asName(resolve(encrypt.get('StrF'))), resolve);
  } else {
    streamCipher = 'rc4';
    stringCipher = 'rc4';
  }
  if (streamCipher === 'identity' && stringCipher === 'identity') return undefined;

  // file key + password validation
  let fileKey: Uint8Array;
  if (R <= 4) {
    fileKey = fileKeyR234(pw, O, P, id, R, length, encryptMetadata);
    if (!validateUserR234(fileKey, U, id, R)) {
      // (owner-password path could be added here)
      throw new InvalidPasswordError();
    }
  } else {
    fileKey = fileKeyR56(pw, encrypt, resolve, R); // implemented in Task 7
  }

  const applyCipher = (cipher: Cipher, data: Uint8Array, num: number, gen: number): Uint8Array => {
    switch (cipher) {
      case 'identity': return data;
      case 'rc4': return rc4(objectKeyV4(fileKey, num, gen, false), data);
      case 'aes128': return aesCbcDecrypt(objectKeyV4(fileKey, num, gen, true), data);
      case 'aes256': return aesCbcDecrypt(fileKey, data);
    }
  };

  const decryptObject = (obj: PdfObject, num: number, gen: number): PdfObject => {
    if (isString(obj)) return { kind: 'string', bytes: applyCipher(stringCipher, obj.bytes, num, gen) };
    if (isArray(obj)) { for (let i = 0; i < obj.length; i++) obj[i] = decryptObject(obj[i], num, gen); return obj; }
    if (isDict(obj)) { for (const [k, v] of obj) obj.set(k, decryptObject(v, num, gen)); return obj; }
    if (isStream(obj)) {
      for (const [k, v] of obj.dict) obj.dict.set(k, decryptObject(v, num, gen));
      return { kind: 'stream', dict: obj.dict, raw: applyCipher(streamCipher, obj.raw, num, gen) };
    }
    return obj;
  };

  return { decryptObject };
}

/** Algorithm 6 (R2/R3): validate the user password by recomputing /U. */
function validateUserR234(fileKey: Uint8Array, U: Uint8Array, id0: Uint8Array, R: number): boolean {
  if (R === 2) {
    const u = rc4(fileKey, PASSWORD_PADDING);
    return u.every((b, i) => b === U[i]);
  }
  let h = md5(concat(PASSWORD_PADDING, id0));
  let data = rc4(fileKey, h);
  for (let i = 1; i <= 19; i++) data = rc4(fileKey.map((b) => b ^ i), data);
  // compare first 16 bytes (the trailing 16 are arbitrary)
  for (let i = 0; i < 16; i++) if (data[i] !== U[i]) return false;
  return true;
}
```

(Stub `fileKeyR56` so the module compiles until Task 7:)

```ts
// add to src/crypto.ts (replaced with the real impl in Task 7)
function fileKeyR56(_pw: Uint8Array, _encrypt: PdfDict, _resolve: Resolve, _R: number): Uint8Array {
  throw new UnsupportedFeatureError('AES-256 (R5/R6) not yet implemented');
}
```

- [ ] **Step 3c: Wire into `Document.Open`**

In `src/document.ts`, add imports:

```ts
import { buildDecryptor, Decryptor } from './crypto.js';
```

Add the options type near `SplitOptions`:

```ts
export interface OpenOptions { password?: string }
```

Replace the `Open` signature and the `/Encrypt` guard. The full new head of `Open`:

```ts
static Open(buf: Uint8Array, opts: OpenOptions = {}): Document {
  const { entries, trailer } = readXref(buf);

  // Raw (un-decrypted) resolver for the /Encrypt dict and /ID — these are never
  // encrypted, and must be read before a Decryptor exists.
  const rawObject = (num: number): PdfObject => {
    const e = entries.get(num);
    if (!e || e.type !== 'offset') return null;
    const p = new ObjectParser(new Lexer(buf, e.offset), (lenObj) => {
      const r = isRef(lenObj) ? rawObject(lenObj.num) : lenObj;
      return typeof r === 'number' ? r : undefined;
    });
    return p.parseIndirectObject().value;
  };
  const resolveRaw = (o: PdfObject | undefined): PdfObject =>
    o === undefined ? null : isRef(o) ? rawObject(o.num) : o;

  let decryptor: Decryptor | undefined;
  let encObjNum = -1;
  const encRef = trailer.get('Encrypt');
  if (encRef !== undefined) {
    if (isRef(encRef)) encObjNum = encRef.num;
    const encDict = resolveRaw(encRef);
    if (!isDict(encDict)) throw new PdfParseError('/Encrypt is not a dict');
    const idArr = trailer.get('ID');
    const id0 = isArray(idArr) && isString(idArr[0]) ? idArr[0].bytes : undefined;
    decryptor = buildDecryptor(encDict, id0, opts.password ?? '', resolveRaw);
  }

  const objects = new Map<number, PdfObject>();
  const objStmCache = new Map<number, Map<number, PdfObject>>();

  const parseEntry = (num: number): PdfObject => {
    const existing = objects.get(num);
    if (existing !== undefined) return existing;
    const entry = entries.get(num);
    if (!entry) return null;
    let value: PdfObject;
    if (entry.type === 'offset') {
      const parser = new ObjectParser(new Lexer(buf, entry.offset), (lenObj) => {
        const r = isRef(lenObj) ? parseEntry(lenObj.num) : lenObj;
        return typeof r === 'number' ? r : undefined;
      });
      value = parser.parseIndirectObject().value;
      // Decrypt top-level offset objects (NOT the /Encrypt dict itself).
      if (decryptor && num !== encObjNum) value = decryptor.decryptObject(value, num, entry.gen);
    } else {
      let map = objStmCache.get(entry.streamObj);
      if (!map) {
        const s = parseEntry(entry.streamObj);
        if (!isStream(s)) throw new PdfParseError(`object stream ${entry.streamObj} is not a stream`);
        map = decodeObjStm(s);
        objStmCache.set(entry.streamObj, map);
      }
      value = map.get(num) ?? null;
      // Objects from an object stream are already plaintext — do not decrypt.
    }
    objects.set(num, value);
    return value;
  };

  for (const num of entries.keys()) parseEntry(num);
  // ...unchanged: drop ObjStm containers, then `return new Document(objects, trailer);`
```

Update `OpenFile`:

```ts
static OpenFile(fileName: string, opts: OpenOptions = {}): Document {
  return Document.Open(new Uint8Array(readFileSync(fileName)), opts);
}
```

Remove the old lines:

```ts
if (trailer.get('Encrypt') !== undefined)
  throw new UnsupportedFeatureError('encrypted PDFs are not supported');
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/encryption.test.ts test/crypto.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts src/crypto.ts src/document.ts test/encryption.test.ts
git commit -m "feat: decrypt RC4 PDFs on Open via standard security handler (u91)"
```

---

### Task 6: AES-128 (V4/R4) end-to-end

**Files:**
- Test: `test/encryption.test.ts`

The crypt-filter and `aes128` branches already exist (Task 5); the encryptor
already supports `cipher: 'aes128'` (Task 4). This task only adds coverage.

- [ ] **Step 1: Write the failing test**

```ts
// add to test/encryption.test.ts
describe('Open: AES-128 (V4/R4) empty password', () => {
  it('decrypts info strings and content streams', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'aes128', V: 4, R: 4, length: 128 },
      { info: { Title: 'Hello AES128' }, pageContents: ['BT (AES page) Tj ET'] },
    );
    const doc = Document.Open(bytes);
    expect(doc.GetMetadata().title).toBe('Hello AES128');
    const contents = doc.resolve(doc.Pages[0].Dict.get('Contents'));
    if (isStream(contents)) expect(dec.decode(inflateStream(contents))).toBe('BT (AES page) Tj ET');
    else throw new Error('contents not a stream');
  });
});
```

- [ ] **Step 2: Run test to verify it fails (if it does)**

Run: `npx vitest run test/encryption.test.ts -t AES-128`
Expected: PASS already if Tasks 4–5 are correct. If it FAILS, debug AES padding/IV handling in the encryptor or `aesCbcDecrypt` before proceeding.

- [ ] **Step 3: (No new code expected.)** If a bug surfaced, fix it minimally in `src/crypto.ts` or `test/helpers/encrypt-pdf.ts`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/encryption.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/encryption.test.ts src/crypto.ts test/helpers/encrypt-pdf.ts
git commit -m "test: AES-128 V4/R4 decrypt on Open (u91)"
```

---

### Task 7: AES-256 (V5/R6) — hardened hash + Algorithm 2.A

**Files:**
- Modify: `src/crypto.ts`, `test/helpers/encrypt-pdf.ts`
- Test: `test/crypto.test.ts`, `test/encryption.test.ts`

- [ ] **Step 1: Write the failing unit test for the R6 hash**

```ts
// add to test/crypto.test.ts
import { hash2B } from '../src/crypto.js';
import { createHash } from 'node:crypto';

describe('hash2B (R6 hardened hash)', () => {
  it('first iteration with mod 0 reduces to SHA-256 of E (structural check)', () => {
    // We can't easily hand-compute the loop, but hash2B must be deterministic
    // and 32 bytes. Determinism + length guard the obvious mistakes.
    const a = hash2B(new Uint8Array(0), Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), new Uint8Array(0));
    const b = hash2B(new Uint8Array(0), Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), new Uint8Array(0));
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/crypto.test.ts -t hash2B`
Expected: FAIL — `hash2B` not exported.

- [ ] **Step 3: Implement the R6 hash + file key, replace the stub**

```ts
// add to src/crypto.ts
/** Algorithm 2.B: the R6 hardened hash. `udata` is empty for the user-key path
 *  and the 48-byte /U for the owner-key path. */
export function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let K = sha256(concat(password, salt, udata));
  for (let round = 0; ; round++) {
    const block = concat(password, K, udata);
    const K1 = new Uint8Array(block.length * 64);
    for (let i = 0; i < 64; i++) K1.set(block, i * block.length);
    const E = aesCbc128Encrypt(K.subarray(0, 16), K.subarray(16, 32), K1);
    let mod = 0; for (let i = 0; i < 16; i++) mod += E[i]; mod %= 3;
    K = mod === 0 ? sha256(E) : mod === 1 ? sha384(E) : sha512(E);
    if (round >= 63 && E[E.length - 1] <= round - 32) break;
  }
  return K.subarray(0, 32);
}
```

Now replace the `fileKeyR56` stub:

```ts
// replace the stub fileKeyR56 in src/crypto.ts
function fileKeyR56(pw: Uint8Array, encrypt: PdfDict, resolve: Resolve, R: number): Uint8Array {
  const U = asBytes(resolve(encrypt.get('U'))) ?? new Uint8Array(0);
  const UE = asBytes(resolve(encrypt.get('UE'))) ?? new Uint8Array(0);
  const O = asBytes(resolve(encrypt.get('O'))) ?? new Uint8Array(0);
  const OE = asBytes(resolve(encrypt.get('OE'))) ?? new Uint8Array(0);

  const valSaltU = U.subarray(32, 40), keySaltU = U.subarray(40, 48);
  const hashU = R === 6 ? hash2B(pw, valSaltU, new Uint8Array(0)) : sha256(concat(pw, valSaltU));
  if (hashU.every((b, i) => b === U[i])) {
    const ik = R === 6 ? hash2B(pw, keySaltU, new Uint8Array(0)) : sha256(concat(pw, keySaltU));
    return aesCbcDecryptNoPad(ik, new Uint8Array(16), UE);
  }
  // owner path: salts in O, udata = U[0..48]
  const u48 = U.subarray(0, 48);
  const valSaltO = O.subarray(32, 40), keySaltO = O.subarray(40, 48);
  const hashO = R === 6 ? hash2B(pw, valSaltO, u48) : sha256(concat(pw, valSaltO, u48));
  if (hashO.every((b, i) => b === O[i])) {
    const ik = R === 6 ? hash2B(pw, keySaltO, u48) : sha256(concat(pw, keySaltO, u48));
    return aesCbcDecryptNoPad(ik, new Uint8Array(16), OE);
  }
  throw new InvalidPasswordError();
}
```

- [ ] **Step 4: Add AES-256 support to the encryptor**

```ts
// add to test/helpers/encrypt-pdf.ts
import { hash2B, aesCbcDecryptNoPad, sha256 } from '../../src/crypto.js';
import { createCipheriv } from 'node:crypto';

/** Build /U,/UE for R6 (Algorithm 8): random salts, file key encrypted under the
 *  intermediate key. Returns { U, UE, fileKey }. */
function buildR6User(userPw: Uint8Array): { U: Uint8Array; UE: Uint8Array; fileKey: Uint8Array } {
  const fileKey = randomBytes(32);
  const valSalt = randomBytes(8);
  const keySalt = randomBytes(8);
  const hash = hash2B(userPw, new Uint8Array(valSalt), new Uint8Array(0));
  const U = cat(hash, new Uint8Array(valSalt), new Uint8Array(keySalt)); // 48 bytes
  const ik = hash2B(userPw, new Uint8Array(keySalt), new Uint8Array(0));
  const c = createCipheriv('aes-256-cbc', ik, new Uint8Array(16)); c.setAutoPadding(false);
  const UE = new Uint8Array(Buffer.concat([c.update(fileKey), c.final()]));
  return { U: new Uint8Array(U), UE, fileKey: new Uint8Array(fileKey) };
}
```

Extend `buildEncryptedPdf` to branch on `cfg.cipher === 'aes256'`:
- derive `{ U, UE, fileKey }` via `buildR6User(userPw)` (skip `computeO`/`computeU`/`fileKeyR234`),
- `encBytes` uses the file key directly: `iv = randomBytes(16)`, PKCS#7 pad, `aesCbc128Encrypt` replaced by a local AES-256 encrypt:
  ```ts
  const aes256Enc = (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => {
    const c = createCipheriv('aes-256-cbc', key, iv); c.setAutoPadding(false);
    return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
  };
  ```
- emit the V5 `/Encrypt` dict:
  ```ts
  encDict = `<< /Filter /Standard /V 5 /R 6 /Length 256 /P ${P}`
    + ` /O <${ownerHex}> /OE <${oeHex}> /U <${Buffer.from(U).toString('hex')}> /UE <${Buffer.from(UE).toString('hex')}>`
    + ` /Perms <${permsHex}>`
    + ` /CF << /StdCF << /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF >>`;
  ```
  For test purposes `/O`,`/OE`,`/Perms` may be filler (32/32/16 bytes of zero) since the user path validates `/U`/`/UE`; document this in a code comment. The `/ID` is still emitted but is NOT used by R6 derivation.

- [ ] **Step 5: Write the end-to-end AES-256 test**

```ts
// add to test/encryption.test.ts
describe('Open: AES-256 (V5/R6) empty password', () => {
  it('decrypts info strings and content streams', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'aes256', V: 5, R: 6, length: 256 },
      { info: { Title: 'Hello AES256' }, pageContents: ['BT (AES256 page) Tj ET'] },
    );
    const doc = Document.Open(bytes);
    expect(doc.GetMetadata().title).toBe('Hello AES256');
    const contents = doc.resolve(doc.Pages[0].Dict.get('Contents'));
    if (isStream(contents)) expect(dec.decode(inflateStream(contents))).toBe('BT (AES256 page) Tj ET');
    else throw new Error('contents not a stream');
  });
});
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/crypto.test.ts test/encryption.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/crypto.ts test/helpers/encrypt-pdf.ts test/crypto.test.ts test/encryption.test.ts
git commit -m "feat: AES-256 V5/R6 decrypt on Open (hardened hash) (u91)"
```

---

### Task 8: Object-stream document decrypts correctly

**Files:**
- Modify: `test/helpers/encrypt-pdf.ts` (add an object-stream emitter)
- Test: `test/encryption.test.ts`

Verifies the container stream is decrypted once and contained objects are not
double-decrypted. The encryptor needs to emit an object stream (`/Type /ObjStm`)
holding the /Info dict, with an xref **stream** referencing it.

- [ ] **Step 1: Add an object-stream variant to the encryptor**

Add `buildEncryptedPdfWithObjStm(cfg, doc)` that:
- builds the same Catalog/Pages/Page/Contents objects (Contents stream encrypted as before),
- places the /Info dict **inside** an object stream: the ObjStm content is
  `"<infoNum> 0 <Title...>"` style header + serialized Info body with its strings
  **already plaintext** (they are NOT individually encrypted),
- encrypts the **ObjStm stream bytes** as a normal stream object (by the ObjStm's
  own object number),
- emits an xref **stream** (reuse the W=[1 2 1] approach from
  `test/helpers/build-pdf.ts::buildXrefStreamPdf`) with type-2 entries for the
  compressed Info object and type-1 entries for the rest, and `/Encrypt`+`/ID` in
  the xref-stream dict.

(Full code mirrors `buildXrefStreamPdf` in `test/helpers/build-pdf.ts`; reuse its
structure. The ObjStm body and `/First`/`/N` must be computed exactly as in
`src/objstm.ts` expects — verify against that file while implementing.)

- [ ] **Step 2: Write the test**

```ts
// add to test/encryption.test.ts
import { buildEncryptedPdfWithObjStm } from './helpers/encrypt-pdf.js';

describe('Open: encrypted document with an object stream', () => {
  it('decrypts the ObjStm container once; contained Info is correct', () => {
    const { bytes } = buildEncryptedPdfWithObjStm(
      { cipher: 'aes128', V: 4, R: 4, length: 128 },
      { info: { Title: 'In ObjStm' }, pageContents: ['BT (objstm) Tj ET'] },
    );
    const doc = Document.Open(bytes);
    expect(doc.GetMetadata().title).toBe('In ObjStm');
    const contents = doc.resolve(doc.Pages[0].Dict.get('Contents'));
    if (isStream(contents)) expect(dec.decode(inflateStream(contents))).toBe('BT (objstm) Tj ET');
    else throw new Error('contents not a stream');
  });
});
```

- [ ] **Step 3: Run to verify it fails, then implement until it passes**

Run: `npx vitest run test/encryption.test.ts -t "object stream"`
Expected: FAIL first (helper missing), then PASS after Step 1 is complete.

- [ ] **Step 4: Commit**

```bash
git add test/helpers/encrypt-pdf.ts test/encryption.test.ts
git commit -m "test: encrypted object-stream document decrypts once (u91)"
```

---

### Task 9: Passwords — correct non-empty, wrong throws, EncryptMetadata=false

**Files:**
- Test: `test/encryption.test.ts`

- [ ] **Step 1: Write the tests**

```ts
// add to test/encryption.test.ts
import { InvalidPasswordError } from '../src/errors.js';

describe('Open: password handling', () => {
  it('opens with the correct non-empty user password', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'rc4', V: 2, R: 3, length: 128, userPassword: 'swordfish' },
      { info: { Title: 'Guarded' }, pageContents: ['BT (pw) Tj ET'] },
    );
    const doc = Document.Open(bytes, { password: 'swordfish' });
    expect(doc.GetMetadata().title).toBe('Guarded');
  });

  it('throws InvalidPasswordError on a wrong password', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'rc4', V: 2, R: 3, length: 128, userPassword: 'swordfish' },
      { info: { Title: 'Guarded' }, pageContents: ['BT (pw) Tj ET'] },
    );
    expect(() => Document.Open(bytes, { password: 'wrong' })).toThrow(InvalidPasswordError);
  });

  it('throws on a password-protected file opened with no password', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'aes256', V: 5, R: 6, length: 256, userPassword: 'hunter2' },
      { info: { Title: 'R6 guarded' }, pageContents: ['BT (r6) Tj ET'] },
    );
    expect(() => Document.Open(bytes)).toThrow(InvalidPasswordError);
  });

  it('decrypts with EncryptMetadata false (RC4)', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'aes128', V: 4, R: 4, length: 128, encryptMetadata: false },
      { info: { Title: 'NoMetaEnc' }, pageContents: ['BT (nme) Tj ET'] },
    );
    const doc = Document.Open(bytes);
    expect(doc.GetMetadata().title).toBe('NoMetaEnc');
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run test/encryption.test.ts -t "password"`
Expected: PASS. If the wrong-password case does not throw, verify
`validateUserR234` / `fileKeyR56` comparison logic.

- [ ] **Step 3: Commit**

```bash
git add test/encryption.test.ts
git commit -m "test: password validation and EncryptMetadata=false (u91)"
```

---

### Task 10: `Save()` round-trips an opened encrypted PDF to plaintext

**Files:**
- Test: `test/encryption.test.ts`
- Modify: `src/document.ts` (optional defensive cleanup only)

**Note:** `serializeDocument` (verified in `src/serializer.ts`) rebuilds the
output trailer from scratch with only `/Size`, `/Root`, `/Info`, `/ID`, and
mark-sweeps reachable objects from `/Root`+`/Info`. The `/Encrypt` trailer entry
is therefore never emitted, and the orphaned Encrypt object is swept. So this
test should **pass immediately** — it characterizes existing behavior. No
production change is required; the optional `delete('Encrypt')` in Step 3 is
belt-and-suspenders only.

- [ ] **Step 1: Write the characterization test**

```ts
// add to test/encryption.test.ts
describe('Save: round-trips an opened encrypted PDF to plaintext', () => {
  it('drops /Encrypt and re-opens without a password', () => {
    const { bytes } = buildEncryptedPdf(
      { cipher: 'aes128', V: 4, R: 4, length: 128 },
      { info: { Title: 'RoundTrip' }, pageContents: ['BT (rt) Tj ET'] },
    );
    const out = Document.Open(bytes).Save();
    // Output must not be flagged encrypted.
    expect(Buffer.from(out).toString('latin1')).not.toContain('/Encrypt');
    // Re-open with no password and verify content survived.
    const re = Document.Open(out);
    expect(re.GetMetadata().title).toBe('RoundTrip');
    const contents = re.resolve(re.Pages[0].Dict.get('Contents'));
    if (isStream(contents)) expect(dec.decode(inflateStream(contents))).toBe('BT (rt) Tj ET');
    else throw new Error('contents not a stream');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/encryption.test.ts -t "round-trip"`
Expected: PASS (characterizes the serializer already omitting `/Encrypt`). If it
unexpectedly FAILS, apply the optional cleanup in Step 3.

- [ ] **Step 3 (optional, only if Step 2 failed): make the intent explicit in `Save`**

In `src/document.ts`, change `Save`:

```ts
Save(): Uint8Array {
  // Opened-encrypted documents hold plaintext in the live map; drop the stale
  // /Encrypt ref so the orphaned Encrypt object is swept (the serializer already
  // rebuilds the trailer without it, so this is defensive only).
  if (this.trailer.has('Encrypt')) this.trailer.delete('Encrypt');
  return serializeDocument(this.objects, this.trailer);
}
```

- [ ] **Step 4: Commit**

```bash
git add test/encryption.test.ts src/document.ts
git commit -m "test: opened encrypted PDF round-trips to plaintext via Save (u91)"
```

---

### Task 11: Full-suite verification, export, and close issue

**Files:**
- Modify: `src/index.ts` (export new public symbols), `.beads`

- [ ] **Step 1: Export public symbols**

In `src/index.ts`, add the new public symbols, matching the file's existing
`export` / `export type` split. Change line 3 and line 6:

```ts
// line 3 — add InvalidPasswordError to the errors re-export
export { PdfParseError, UnsupportedFeatureError, InvalidPasswordError } from './errors.js';
```

```ts
// line 6 — add OpenOptions to the document type re-export
export type { SplitOptions, OpenOptions } from './document.js';
```

- [ ] **Step 2: Run the whole suite + typecheck + build**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: ALL tests pass; no type errors; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "chore: export OpenOptions + InvalidPasswordError (u91)"
```

- [ ] **Step 4: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-u91 --reason="RC4/AES-128/AES-256 decrypt on Open with empty + correct password; Save round-trips to plaintext; tests green"
bd remember "Encryption-on-Open shipped (u91): src/crypto.ts standard security handler. RC4 (V2/R3), AES-128 (V4/R4 AESV2), AES-256 (V5/R6 AESV3). Decryption inline in Document.Open's parseEntry for top-level offset objects by num/gen; objstm-contained objects and the /Encrypt dict are exempt. Open(buf,{password}) / OpenFile(name,{password}); empty default; wrong/missing -> InvalidPasswordError. Save() strips /Encrypt -> plaintext output. Fixtures via test/helpers/encrypt-pdf.ts (reuses crypto.ts derivation); primitives pinned to public vectors. Not done: writing encrypted output, PubSec, SASLprep."
git pull --rebase
git push
git status
```

Expected: `bd close` succeeds; `git status` shows "up to date with origin".

---

## Self-Review Notes

- **Spec coverage:** RC4 (T1,T5), AES-128 (T2,T6), AES-256/R6 hash (T2,T7), key derivation A2/A1 (T3) and A2.A/2.B (T7), crypt filters (T5), password param + validation (T5,T7,T9), object-stream exemption (T5,T8), `/Encrypt`+`/ID` exemption (T5), Save strips `/Encrypt` (T10), testing strategy with pinned primitives (T1–T3) — all mapped.
- **Verified against the codebase (no longer open):** `Metadata` fields are lowercase (`src/metadata.ts`); `serializeDocument` rebuilds the trailer with only `/Root`+`/Info`+`/ID` and mark-sweeps from `/Root`+`/Info`, so it already omits `/Encrypt` (`src/serializer.ts`, drove the Task 10 rewrite); `src/index.ts` uses `export` / `export type` re-exports (drove Task 11).
- **One verification point left for the implementer:** the object-stream emitter in Task 8 must match `src/objstm.ts`'s expectations for `/First`, `/N`, and the integer-pair header — verify against that file while implementing.
