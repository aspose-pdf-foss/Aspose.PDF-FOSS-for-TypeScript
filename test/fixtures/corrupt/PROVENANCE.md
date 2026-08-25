# Damaged-file fixtures — provenance

Damaged PDFs for the recovery suite (`test/corrupt-real.test.ts`), covering
issue `dxfk.4`. Design: `docs/superpowers/specs/2026-08-07-xref-recovery-design.md`,
`2026-08-10-trailer-rebuild-design.md`, `2026-08-10-objstm-degradation-design.md`.

This directory is unlike every other one under `test/fixtures/`. A corrupt file
has no producer, so there are no third-party bytes to vendor. **What is
third-party here is the source.** The rest of the recovery suite damages
builder-made PDFs, which can only show that the reader survives our own writer's
layout; a shared-convention bug, where reader and builder agree with each other
and both disagree with the format, is invisible to it. Ghostscript and qpdf lay
a file out their own way — where the trailer sits, how the xref table is spaced,
which objects get packed into an `/ObjStm` and in what order — so these fixtures
are the guard against that class.

| Fixture | Source producer | Damage | Recovers by |
|---|---|---|---|
| `gs-x3-startxref-past-eof.pdf` | Ghostscript | `startxref` points past EOF | sweep |
| `gs-x3-trailer-keyword-destroyed.pdf` | Ghostscript | `trailer` keyword overwritten | sweep + trailer synthesis |
| `gs-x3-offsets-shifted.pdf` | Ghostscript | bytes prepended, every offset stale | sweep |
| `gs-x3-truncated-mid-stream.pdf` | Ghostscript | last 30% cut, mid content stream | sweep + trailer synthesis |
| `qpdf-objstm-payload-damaged.pdf` | qpdf | `/ObjStm` payload tail overwritten | per-object degradation |

## Sources

`ghostscript-x3-noicc.pdf` is already vendored one directory over, in
`test/fixtures/pdfx/`, where `PROVENANCE.md` records the Ghostscript version and
the exact command that produced it. It is reused rather than re-vendored, so
Ghostscript is **not** needed to regenerate anything here.

`qpdf-objstm-source.pdf` is committed because no vendored file was both small
and object-stream-based: the only `/ObjStm` fixture in the repo is
`ghostscript-x4.pdf` at 147 KB. qpdf repacks the 7.5 KB Ghostscript file into
one at 6 KB, and adds a second independent producer to the corpus.

**Producer:** qpdf 12.3.2. **Command:**

```
qpdf --object-streams=generate --compress-streams=y \
  test/fixtures/pdfx/ghostscript-x3-noicc.pdf \
  test/fixtures/corrupt/qpdf-objstm-source.pdf
```

| File | Bytes | SHA-256 |
|---|---|---|
| `../pdfx/ghostscript-x3-noicc.pdf` | 7,495 | `d55e41f5a6798ee308659901967d01f2908509d22648a8c6e11617aab478cd28` |
| `qpdf-objstm-source.pdf` | 5,956 | `48b3e7b7d5206adfca5bc846594300cf744a935969b0fb8c782b3f00ccd34755` |

Both open **cleanly** — no `doc.recovery`, one page, text extracted. That is
asserted in `corrupt-real.test.ts`, and it is half of what makes every
assertion below mean anything: if a source did not open cleanly, "recovered"
would be indistinguishable from "was never broken", and a damage step that
silently did nothing would pass.

## Regenerating

```
npm i --no-save tsx
npx tsx scripts/gen-corrupt-fixtures.ts
```

The script applies the damage functions in `test/helpers/damage-pdf.ts` — the
same ones the programmatic suites use, deliberately, so that a difference in
outcome between a builder-made file and one of these isolates the producer
rather than the damage. Re-running must reproduce every SHA-256 below byte for
byte. If it does not, a damage function drifted and this file is stale.

The hashes are also pinned in `corrupt-real.test.ts`. A regenerated or
half-written fixture fails loudly there instead of quietly weakening the
recovery assertions.

---

### gs-x3-startxref-past-eof.pdf

**Source:** `../pdfx/ghostscript-x3-noicc.pdf` (7,495 bytes, SHA-256
`d55e41f5a6798ee308659901967d01f2908509d22648a8c6e11617aab478cd28`)

**Damage:** the `startxref` value replaced with (file length + 5000), pointing
past EOF. Only the digits of the offset change, so the xref table and trailer
are untouched and intact — the file is unreadable solely because nothing can
find them.

**Result:** 7,496 bytes, SHA-256
`08035fefd8717b50bfdca0acea76c4508cef815df6925bc6df1c7de6119da7ab`

**Salvages:** everything. `reason: 'startxref-unreadable'`, 18 objects repaired
from the sweep, 0 lost, 1 page, and `GetText()` returns the pristine file's 93
characters exactly. **Loses:** nothing.

---

### gs-x3-trailer-keyword-destroyed.pdf

**Source:** as above.

**Damage:** the last `trailer` keyword overwritten with `#######` in place. Byte
length unchanged. The trailer *dict* is untouched, but the classic table reader
finds it by the keyword, so nothing reaches `/Root`.

**Result:** 7,495 bytes, SHA-256
`c6ffc02fc48d326fb3462ac8dfa7c62fcdb808e675b6cd66cfcf34aad0b811da`

**Salvages:** everything. `reason: 'xref-unparsable'`, 18 repaired, 0 lost, 1
page, pristine text. A trailer is synthesized rather than found:
`recovery.trailer` is `{ root: 1, rootCandidates: [1], info: 2, infoSource:
'info-dict' }` — a single unambiguous catalog, and `/Info` recovered from the
dict rather than from XMP. **Loses:** nothing.

---

### gs-x3-offsets-shifted.pdf

**Source:** as above.

**Damage:** `"%X-Junk-Header 1\r\n"` prepended, shifting every byte in the file
by 18. A PDF comment, so the bytes are legal at file scope; the xref table and
`startxref` are otherwise untouched, which means every offset they hold is now
18 too small and points into the middle of the previous object.

**Result:** 7,513 bytes, SHA-256
`38f0bc8c73fbea34e4beaa11d17c0a6d77fbf98319a8db6a0013f7dc02e148d0`

**Salvages:** everything. `reason: 'xref-unparsable'`, 18 repaired, 0 lost, 1
page, pristine text. Also asserted: `Save()` on the recovered document produces
a file that opens with no `recovery` at all and the same text, so recovery is a
repair the caller can keep. **Loses:** nothing.

---

### gs-x3-truncated-mid-stream.pdf

**Source:** as above.

**Damage:** the last 30% of the file removed (2,248 bytes), which takes the xref
table, the trailer, and the tail of the last content stream with it. The only
fixture here that destroys content rather than just the means of finding it.

**Result:** 5,247 bytes, SHA-256
`b0f7b1cd9e6f5cbe48c960f5d00a9bcc2742b59d9c325302c3e7652302732d23`

**Salvages:** `reason: 'startxref-unreadable'`, 16 objects repaired, 1 page, and
the pristine 93 characters of text — the page's own content survived the cut. A
trailer is synthesized: `{ root: 1, rootCandidates: [1] }`, with no `/Info`,
since that object was in the removed tail.

**Loses:** 1 object, reported in `recovery.lost` — the one the cut landed
inside. This is the fixture that proves `lost` is not decorative.

---

### qpdf-objstm-payload-damaged.pdf

**Source:** `qpdf-objstm-source.pdf` (5,956 bytes, SHA-256
`48b3e7b7d5206adfca5bc846594300cf744a935969b0fb8c782b3f00ccd34755`)

**Damage:** the last 10% of the `/ObjStm` payload overwritten with `0x5A` (`Z`)
in place. Byte length unchanged, so every xref offset stays valid and the
container is the only fault in the file.

In-place corruption rather than truncation is deliberate, and is the harder of
the two shapes: cutting bytes makes zlib report `Z_BUF_ERROR` and hand back what
it produced, whereas altered bytes raise `Z_DATA_ERROR` and yield nothing at
all. The second case is what `inflateSalvage` in `src/filters.ts` exists for.

**Result:** 5,956 bytes, SHA-256
`42585b86253d46cd3c491784a86d6e01243a4cfd7932ebc2515674ed8bd8dfcc`

**Salvages:** `reason: 'objstm-undecodable'`, 1 page, and 8 of the 12 objects
the container declared — `2` (Catalog), `3` (Info), `4` (Pages), `5`
(OutputIntent), `6` (Page), `7` and `9` (Font), `8` (FontDescriptor). The
container's own `detail` reads *"payload inflated to 1993 bytes before it
stopped; 4 of 12 objects did not parse"*.

**Loses:** objects `10` (a FontDescriptor), `11` (an ExtGState), and `12`/`13` —
the page's `/Resources` sub-dictionaries, which map the names `R8`, `R10` and
`R12` to the objects above. Each resolves to `null`, per the spec rule for a
reference to a non-existent object.

The consequence is worth stating plainly, because it is the honest shape of this
loss rather than a defect: the page survives and is a real page, but
`GetText()` returns **empty**. The content stream is intact and was never inside
the container — streams cannot be — but the name-to-font map it needs was, so
there is nothing to decode its glyphs against. An object inside an `/ObjStm`
carries no `N G obj` header and exists nowhere else in the file, so no sweep can
bring it back. This is the one loss recovery cannot backfill.

## Mutation record

Fixtures usually pass on the first run, which is not evidence. Per the rule in
`CLAUDE.md`, each recovery path was broken deliberately and the suite confirmed
red. Results against `test/corrupt-real.test.ts` (16 tests):

| Mutation | Site | Result |
|---|---|---|
| xref failure is fatal — throw instead of sweeping | `Document.Open`, the `xrefFailure` branch | **6 failed** |
| trailer synthesis returns an empty trailer | `Document.Open`, the `rebuildTrailer` call | **3 failed** |
| `/ObjStm` partial inflate rethrows instead of degrading | `decodeObjStm`, the fallback inflate | **2 failed** |

The failure mode this suite exists to avoid is the opposite one: a recovery test
that passes because the file was never actually broken. Two things guard it —
the pinned SHA-256 of every fixture, and the assertion that both *sources* open
with `recovery === undefined`. A damage step that quietly did nothing changes a
hash and turns a `reason` assertion undefined.
