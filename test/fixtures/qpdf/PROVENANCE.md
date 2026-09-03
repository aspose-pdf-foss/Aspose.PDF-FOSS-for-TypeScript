# Incremental-Save Goldens — Provenance

Outputs of `Save({ incremental: true })` that **qpdf** has inspected, plus its
verdict on each. They exist to answer a question our own suite structurally
cannot: every other test of the incremental writer reads the result back through
our own parser, so an append our reader happens to tolerate and the format does
not is invisible to it — the shared-convention class this directory tree exists
for. qpdf is a separately written implementation, so its approval is evidence in
a way a round trip through `Document.Open` is not.

## Producer

| | |
|---|---|
| Generator | `scripts/gen-qpdf-goldens.ts` (not run by `npm test`) |
| Verdict from | qpdf 12.3.2 |
| Runner | tsx 4.23.13 |
| Node | v24.16.0 |
| OS | Windows 11 Pro, 10.0.26200 |
| Date | 2026-09-03 |
| Issue | `rxzx` |

Unlike the browser goldens, the tool here is an **external binary rather than an
npm package**, so there is nothing to `npm i --no-save`. qpdf must be on PATH.

```bash
qpdf --version
npx tsx scripts/gen-qpdf-goldens.ts
```

The generator **refuses to write anything** for a fixture qpdf does not call
clean — a golden that freezes a defect is worse than no golden, which is the
rule `scripts/gen-svg-goldens.ts` already follows for engine disagreement.

## Fixtures

| Fixture | Bytes | SHA-256 |
|---|---|---|
| `base.pdf` | 834 | `dd8d74393f2fe6df4f8756527e2f2dc788b0f59264ab62892b393be1bc871d39` |
| `one-edit.pdf` | 1089 | `187d3c731dd4cd693823922c639b97e289b7512329e37a26646380e94bff41fd` |
| `freed-object.pdf` | 1032 | `c837b00500262907cba3bbc8a413ecaf1bd18b41180a25307176e83bfe22bfaa` |
| `classic-onto-xref-stream.pdf` | 903 | `6c726ef895d316ce836d3f7afd0906a3800d128e3986d35f2d633b65bb9f0397` |
| `encrypted-preserved.pdf` | 941 | `9ece7bf3dece3c47146befe1e4cd208ff4e150d4be3a0a47772356f6a805f1db` |

One fixture is an INPUT rather than an output: `encrypted-base.pdf` is the
encrypted document `encrypted-preserved.pdf` is produced FROM. It is committed
because `buildEncryptedPdf` generates a random `/ID` per call and `/ID[0]` is
hashed into the R<=4 file key, so a built base would differ every run and
byte-identity could not be a fence at all.

Each `.pdf` has a `.txt` beside it carrying qpdf's `--check` and `--show-xref`
output. Those reports are **evidence, not assertions**: nothing compares them
byte for byte at test time, and reading them as a gate would be a mistake.

## What each fixture covers

| Fixture | Covers |
|---|---|
| `base` | The control — an unmodified classic file, so a qpdf complaint about an appended file cannot be blamed on the base. |
| `one-edit` | One replaced object appended: the ordinary shape. |
| `freed-object` | An `f` entry. **The one thing our own reader provably cannot check**, because `readXref` drops free entries (`2yvi`) — so before this, nothing anywhere verified that a deletion we write is honoured. qpdf's `--show-xref` shows object 5 absent while the rewritten `/Pages` moved to offset 834 and the untouched objects kept theirs. That is also what proves `2yvi` is a reader bug rather than a writer bug. |
| `encrypted-preserved` | A document opened encrypted and saved again (`0cr3`). The strongest external evidence in that feature: qpdf derives the file key itself and reports `R = 3`, `P = -44` and that the empty password matches BOTH `/O` and `/U`. We never held the owner password, so an `/O` we had rebuilt could not validate — this is what confirms the `/Encrypt` dict was carried verbatim. |
| `classic-onto-xref-stream` | A classic appended section chaining `/Prev` to a cross-reference **stream**. CLAUDE.md documents this as legal for any PDF 1.5+ reader, and nothing else in the suite verified it against a reader that is not ours. |

## How the fence works

`test/qpdf-goldens.test.ts` rebuilds each fixture from
`test/helpers/qpdf-fixtures.ts` and asserts **byte-identity** with the committed
file. It runs no qpdf, so CI needs nothing installed. The generator and the test
build from that one shared list, which is what makes a golden mean anything: the
bytes the test compares are provably the bytes qpdf was shown.

The fence is therefore indirect. A change to the incremental writer reddens
these, and that is the signal to re-run the generator and let qpdf pass
judgement again — **not** to refresh a snapshot. Measured: adding a single space
to the appended trailer reddens the three appended fixtures and correctly leaves
`base` green.

Output is deterministic, which is what makes byte-identity a sound fence rather
than a flake — verified by generating each shape twice and comparing digests.

## The ceiling — what this does NOT cover

- **`qpdf --check` reports no *syntax* errors. It does not say the revision
  structure means what we intended.** A file can be perfectly well-formed and
  still carry the wrong delta. The anchor for meaning is
  `test/sign-incremental-survival.test.ts`, whose digest is over bytes: it
  verifies an earlier signature still validates over its own `/ByteRange` after
  an incremental edit.
- **One tool, no second to arbitrate.** The browser goldens cross-check Chrome
  against resvg; there is no second PDF checker here, so a qpdf quirk would be
  frozen rather than caught.
- **No PubSec fixture.** The password handler is covered; certificate-based
  encryption is exercised only by our own round trip.
- **No compressed appended section.** `Save({ incremental: true })` refuses
  `compressed`, so the appended section is always a classic table; only the
  *base* is compressed, in `classic-onto-xref-stream`.
- **Small synthetic bases.** These are `buildClassicPdf` outputs, not files from
  a third-party producer. They exercise our writer against an external reader,
  which is the point — but they are not evidence about reading files we did not
  write. `test/fixtures/corrupt/` is where that lives.
