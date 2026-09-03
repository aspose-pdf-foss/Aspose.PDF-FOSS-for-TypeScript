# Preserving a document's encryption on save — design

**Issue:** `0cr3`, which absorbed `61z2`. The two were halves of one missing
concept, failing in opposite directions.

**Decision:** retain the file key recovered at open, reuse the original
`/Encrypt` dict verbatim, and encrypt on **both** write paths — the full
rewrite and the incremental append. `Save()` preserves encryption **by
default**; `Save({ encrypt: false })` is how a caller asks for plaintext.

## What is broken today

| path | behaviour |
|---|---|
| `Save()` | Writes **plaintext** with no `/Encrypt` and no signal. Measured: an `/Info /Title` of `SecretTitle` is visible in the clear and reads back fine — a valid, unprotected file. |
| `Save({ incremental: true })`, `Sign`, `Certify` | Would write plaintext objects into an encrypted file **and** omit `/Encrypt` from the appended trailer, so a reader takes the newest trailer at its word and decodes every pre-existing encrypted string to garbage (`Title` → `CÞQjþ{}3`). Refused today (`x8kx`, `msdn.3`) rather than done wrong. |

Neither is a special case. The rewrite writes plaintext because the mark-sweep
roots are `/Root` and `/Info` and `/Encrypt` hangs off the trailer alone, so it
is simply collected; the append omits it because `layout` builds its trailer
from scratch with only `/Size /Root /Prev /Info /ID`.

## The trap this design exists to avoid

**Encryption cannot be re-derived from what we retain, and the convenient
shortcut is worse than the bug.** `EncryptOptions` needs an owner password,
which is hashed into `/O` and unrecoverable from the file. `buildEncryptor`
defaults `ownerPassword ?? userPassword ?? ''`
([encrypt.ts:138](../../../src/encrypt.ts#L138)) — so "carry forward using the
retained password" would **silently equate the owner and user passwords**, a
permissions downgrade shipped under the banner of fixing a confidentiality
leak. Nothing in the output would look wrong.

The faithful route is to reuse what the file already has: its key and its
`/Encrypt` dict.

## Mechanism

**Invariant: the `/Encrypt` dict is COPIED VERBATIM, never rebuilt.** It
carries `/O /U /P /V /R` — or `/Recipients` and `/CF` for `Adobe.PubSec` —
which are statements about credentials we do not hold and cannot reconstruct.

**Invariant: the retained state is the three values `buildDecryptor` already
computes** — `fileKey`, `streamCipher`, `stringCipher`
([crypto.ts:186-199](../../../src/crypto.ts#L186)). Everything else in that
function is password validation, which has already happened by the time we
have a key.

Both decrypt entry points widen to return their keys beside `decryptObject`:
`buildDecryptor` and `buildPubSecDecryptor`. That is what makes PubSec cost one
extra return value rather than a second implementation — its decryptor has the
same shape, recovering a file key and applying ciphers, so it needs no
encryptor of its own.

`buildEncryptorFromKeys(keys, encryptDict)` mirrors `applyCipher`, swapping
`aesCbcDecrypt` for AES-CBC encrypt; RC4 is symmetric and `identity` passes
through. It returns the **existing** `Encryptor` interface
([encrypt.ts:26](../../../src/encrypt.ts#L26)), so every consumer already
written works unchanged.

`Document` retains the resulting encryptor. `build()` constructs a `Decryptor`
locally and discards it today; this is the same shape of change `msdn.2` made
for `OpenOptions`.

**Two things the earlier issue text got wrong, corrected by reading:**

- **Rooting `/Encrypt` in the mark-sweep is NOT needed.** The encrypted
  serialize path writes it explicitly
  ([serializer.ts:304](../../../src/serializer.ts#L304),
  [:386](../../../src/serializer.ts#L386)). It vanishes today only because the
  *plaintext* path never emits it, so preserving means routing through a path
  that already exists.
- **Object renumbering is harmless.** `serializeClassicEncrypted` re-encrypts
  under fresh numbers 1..N. The file key does not depend on object numbers —
  only the per-object key does, via `objectKeyV4(fileKey, num, gen, …)` — and
  it is derived consistently on write and on the next read.

## The rewrite path

`serializeDocument` takes the retained encryptor as a **separate argument**,
not through `SaveOptions`, which is public API and has no business carrying an
`Encryptor`.

Precedence, in order: an explicit `encrypt` option wins (re-encrypt with stated
credentials); else the retained encryptor; else plaintext exactly as now.

**The opt-out is `encrypt: false`.** The field is already
`EncryptOptions | PubSecEncryptOptions`, so widening it to `| false` spells "no
encryption" without inventing a second option name.

**Invariant, and it is a hard refusal: `/ID` must be preserved exactly.** For
R≤4 the file key hashes `/ID[0]`, so a retained key is valid only against the
same `/ID`. `resolveIds` falls back to `randomBytes(16)` when `/ID` is absent
([serializer.ts:236](../../../src/serializer.ts#L236)) — which, combined with a
retained key, yields a file **nothing can decrypt**, including us. Preservation
therefore requires the trailer to carry `/ID`: `Save()` throws
`UnsupportedFeatureError` when a document was opened encrypted, encryption
would be preserved, and the trailer names no `/ID`. R5/6 do not hash it, but
one rule is better than two, and an encrypted document without `/ID` is already
pathological.

## The append path

`saveIncremental` drops its encrypted-document refusal. Appended objects are
encrypted with the retained encryptor under their own number and generation,
and `layout` carries `/Encrypt N 0 R` into the appended trailer — the missing
entry that made `x8kx` garble every pre-existing encrypted string.

The `/Encrypt` object itself is never encrypted, and it already lives in the
original bytes, so the appended revision **references** it rather than
rewriting it: the object number comes from the previous trailer's own
`/Encrypt` entry, which `layout` already reads via `readXref(original)` for
`/Root` and `/Info`. Nothing new has to be resolved.

## Signing

Objects in `opts.objects` pass through `serializeObject` and encrypt for free.
The **signature dictionary does not**: `buildSigDictPlaceholder` hand-builds it
as text, bypassing that path.

**Invariant: its string values are encrypted like any others, EXCEPT
`/Contents`** (32000-1 §7.6.2), which is exempt. `/ByteRange` is not a string
and is unaffected. So the placeholder builder takes the encryptor and encrypts
`/Name`, `/Reason`, `/Location`, `/ContactInfo` and `/M`, leaving `/Contents`
alone.

Getting either half wrong is silent in opposite directions: encrypting
`/Contents` breaks signature verification, and failing to encrypt `/Name` leaks
the signer's name in cleartext from a document whose point is encryption.

## Refusals that remain unchanged

`Save({ incremental: true })` still refuses `compressed`, `linearized` and
`streamFilter`; linearization still refuses `encrypt` outright.

## What this deletes when it lands

- `assertNotEncrypted` in `document.ts` and its three call sites (`x8kx`)
- the encrypted-document check in `saveIncremental` (`msdn.3`)
- `test/sign-encrypted-refusal.test.ts` inverts from refusal to round trip
- the encrypted refusal case in `test/save-incremental.test.ts` inverts
- the README Limitations entry stating signing refuses encrypted documents

## Testing

**The primary fence: an unencrypted document's output must be BYTE-IDENTICAL
to before.** Every behaviour here is gated on retained key material a plaintext
document does not have, so `test/serializer-signed.test.ts`,
`test/docx-flow-identity.test.ts`, `test/html-identity.test.ts` and
`test/rich-runs-identity.test.ts` must not move. One of them moving means the
routing is wrong, not that a golden needs refreshing.

**Round trip per cipher family** — RC4, AES-128 and AES-256 through
`buildEncryptedPdf`, plus PubSec through the existing recipient fixtures: open,
`Save()`, reopen with the same password, compare content.

**The sharp assertion is the negative one.** A round trip alone is weaker than
it looks, so every case also asserts the secret string is **absent from the
output bytes** — that is what separates "actually encrypted" from "carries an
`/Encrypt` dict". Conversely `encrypt: false` must write it **visibly**, which
pins the opt-out.

**Rules:** an explicit `encrypt` wins, so the new password opens the result and
the old one does not; `/ID` is byte-identical across the save; a trailer with
no `/ID` refuses.

**The `x8kx` regressions:** an encrypted incremental save reopens with *both*
old and new content decrypting — the exact case that garbled `Title`. And
signing an encrypted document produces a signature that **verifies** while
`/Name` is **not** visible in cleartext; that one pair catches both signing
mistakes from opposite sides.

**External anchor:** extend `scripts/gen-qpdf-goldens.ts` with encrypted
shapes. qpdf reads an encrypted file given a password, so this is the only
check in the feature that is not our reader agreeing with our writer — the
arrangement `rxzx` landed, and `test/fixtures/qpdf/PROVENANCE.md` records the
same ceiling.

**Mutations, each expected to redden a different case:** drop `/Encrypt` from
the appended trailer; encrypt `/Contents`; skip encrypting `/Name`; write a
fresh `/ID`.

## Out of scope

- Changing what `Save({ encrypt })` does with stated credentials.
- Encrypted linearization, which is refused outright and stays so.
- A compressed appended section, refused by `msdn.3` and unrelated.
