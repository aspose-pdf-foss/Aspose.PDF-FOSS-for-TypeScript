# PDF/X test fixtures — provenance

PDF/X files from a third-party producer, here to validate `src/pdfxvalidate.ts`
against bytes this repo did not produce. Four are conformant; one is
deliberately not. Tests in `test/pdfx-real.test.ts`.

| Fixture | Level | Identification | `/DestOutputProfile` | `/OutputConditionIdentifier` |
|---|---|---|---|---|
| `ghostscript-x3.pdf` | X-3 | `/Info`, `PDF/X-3:2002` | embedded | `CGATS TR001` |
| `ghostscript-x1a.pdf` | X-1a | `/Info`, `PDF/X-1a:2001` | embedded | `CGATS TR001` |
| `ghostscript-x4.pdf` | X-4 | XMP `pdfxid` | embedded | `CGATS TR001` |
| `ghostscript-x3-registered.pdf` | X-3 | `/Info`, `PDF/X-3:2002` | **absent** | `CGATS TR 001` (registered) |
| `ghostscript-x3-noicc.pdf` | X-3 | `/Info`, `PDF/X-3:2002` | **absent** | `CGATS TR001` (**not** registered) |

The last two are a matched pair differing only in the spelling of the
identifier; they are the only fixtures that reach the registered-name branch of
`outputIntentRule`. `ghostscript-x3-noicc.pdf` is the one deliberately
**non-conformant** file here — see "The `CGATS TR001` finding".

`test/helpers/build-pdfx-pdf.ts` builds every other PDF/X fixture in the suite,
and it cannot catch the one class this file exists for: **our validator and our
builder agreeing with each other and both disagreeing with ISO 15930.** The
builder writes what the validator expects because the same working knowledge
produced both. Ghostscript does not share that knowledge.

The X-3 file found two real over-enforcement defects on its first run (see
"Outcome"). The later additions found none in our code — but the no-profile pair
found one in the **producer's**, and settled a registry question we had been
guessing at (see "The `CGATS TR001` finding").

---

## The files

**Producer:** GPL Ghostscript 10.07.1 (2026-05-19), AGPLv3, via its own `-dPDFX`
path. Installed one-off from the Artifex release
[`gs10071`](https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/tag/gs10071)
(`gs10071w64.exe`, SHA-256
`3a4c28d0aac47aa7cccd35a5932c55110376e9dbd966898dde388b7faba444a4`, verified
against the release's `SHA512SUMS` and Authenticode-signed by "Artifex Software,
Inc."). Not a dev dependency — running the suite needs nothing but these bytes.

The PDF/X definition file is Ghostscript's own `lib/PDFX_def.ps`, committed here
as `pdfx-fixture-def.ps` with **one line changed**, the profile path:

```diff
-/ICCProfile (ISO Coated sb.icc) def  % Customize or remove.
+/ICCProfile (default_cmyk.icc) def  % Customize or remove.
```

Every line their file marks "Must be so (the standard requires)" —
`GTS_PDFXVersion`, `/S /GTS_PDFX`, `/RegistryName` — is left exactly as Artifex
ships it. That is the whole point: the fixture must reflect Artifex's reading of
ISO 15930, not ours.

`/OutputConditionIdentifier (CGATS TR001)` is also left as shipped in this base
file, though it is marked `% Customize` rather than "Must be so" — and it turns
out to be wrong. See "The `CGATS TR001` finding".

The same file drives all three levels: it branches on the `PDFX` value and
writes the matching `GTS_PDFXVersion` (`PDF/X-1a:2001`, `PDF/X-3:2002`,
`PDF/X-4`), so `-dPDFX=1|3|4` selects the level with no further edits.

Two derived definition files exist for the registered-name pair. Both drop the
`/ICCProfile` line — the emission of `/DestOutputProfile` is guarded by
`currentdict /ICCProfile known`, so removing it is Artifex's own documented
"Customize or remove" path to an output intent with no embedded profile:

- **`pdfx-fixture-def-noicc.ps`** — `/ICCProfile` line replaced by a comment,
  nothing else touched. Retains Artifex's `CGATS TR001`.
- **`pdfx-fixture-def-registered.ps`** — the above, plus the identifier
  corrected to `CGATS TR 001`. That line is marked `% Customize` in Artifex's
  file, not "Must be so", so editing it stays inside the intended surface.

| File | Bytes | SHA-256 |
|---|---|---|
| `input.ps` (producer input) | 669 | `6354933a23ff550fc77697854266be4a13bdd6f4eb545be844b6ba31b7e178b7` |
| `pdfx-fixture-def.ps` (producer input) | 4,727 | `fdcc1d54275d3eebf8192b0f5ad78b720925d560d3ee3c53fe58e83030bb2afc` |
| `pdfx-fixture-def-noicc.ps` (producer input) | 4,745 | `23a07e7445cd382e2a8959fdf6dd4b68c2ad25124663212a654dd85f8d01982b` |
| `pdfx-fixture-def-registered.ps` (producer input) | 4,746 | `56b82ab9e036978232e7f6639f36475fd3e3f3dd95281d62bb374bdbee225493` |
| `default_cmyk.icc` (producer input, **not committed**) | 187,484 | `8472fa1493a024b800b67dee9424835ec0c41ab79490200ae8ec4a689fd1b9a9` |
| `ghostscript-x3.pdf` (producer output) | 147,005 | `a00df038e55cf471b9324e1565f7f6b1c7f61b89e996b6897e4165479672b016` |
| `ghostscript-x1a.pdf` (producer output) | 146,983 | `f3f121f543360bea6dc3bdc8c90f8503935e66a186f9798adf1901f9c1919514` |
| `ghostscript-x4.pdf` (producer output) | 147,528 | `5be8b9d6456df361e75e426bdb9e352d4759cee8234acc0d0d35aefae332eb84` |
| `ghostscript-x3-registered.pdf` (producer output) | 7,496 | `3bcb080319e2b42f9f99ca215ba85b418c2ab45f947b458f797621dd0d22472b` |
| `ghostscript-x3-noicc.pdf` (producer output) | 7,495 | `d55e41f5a6798ee308659901967d01f2908509d22648a8c6e11617aab478cd28` |

The two no-profile files are ~7 KB rather than ~147 KB for exactly the reason
they exist: no 187 KB ICC stream.

`default_cmyk.icc` is Ghostscript's own bundled profile
(`iccprofiles/default_cmyk.icc`), referenced by hash rather than vendored — it
arrives with any Ghostscript install and is 187 KB.

### Command

```sh
# The three profile-carrying fixtures. -dPDFX=3 is what -dPDFX alone defaults to.
for lvl in 1:x1a 3:x3 4:x4; do
  gs -dPDFX=${lvl%%:*} -dBATCH -dNOPAUSE \
     -sColorConversionStrategy=CMYK \
     -sDEVICE=pdfwrite \
     --permit-file-read=default_cmyk.icc \
     -sOutputFile=ghostscript-${lvl##*:}.pdf \
     pdfx-fixture-def.ps input.ps
done

# The registered-name pair. No ICC profile is read, so no --permit-file-read.
gs -dPDFX=3 -dBATCH -dNOPAUSE -sColorConversionStrategy=CMYK -sDEVICE=pdfwrite \
   -sOutputFile=ghostscript-x3-registered.pdf pdfx-fixture-def-registered.ps input.ps
gs -dPDFX=3 -dBATCH -dNOPAUSE -sColorConversionStrategy=CMYK -sDEVICE=pdfwrite \
   -sOutputFile=ghostscript-x3-noicc.pdf pdfx-fixture-def-noicc.ps input.ps
```

Two invocation details cost time and are recorded so the next person skips them:

- **The definition file must not be named `PDFX_def.ps`.** Ghostscript resolves a
  bare filename through its own lib search path, so it silently loads
  `<gs>/lib/PDFX_def.ps` and ignores the edited copy in the working directory —
  including when the argument is written `./PDFX_def.ps`. The rename to
  `pdfx-fixture-def.ps` is what makes the customization take effect. A run that
  hits this fails with `invalidfileaccess` on `(ISO Coated sb.icc)`, which reads
  like a permissions problem and is not.
- **`--permit-file-read` is required.** SAFER is default since 9.50, so reading
  the ICC profile is blocked without it.

### What the fixtures actually contain

Read from the files themselves, not assumed. Common to all five: one
`/S /GTS_PDFX` output intent with `/RegistryName (http://www.color.org)`;
`/MediaBox`, `/TrimBox` and `/BleedBox`; 2 embedded fonts (`FontFile`, from the
NimbusSans / NimbusRoman substitutes); DeviceCMYK fill and stroke plus a
DeviceGray wedge; and no live transparency, optional content, embedded files or
`JPXDecode` imagery.

| | `x3` | `x1a` | `x4` | `x3-registered` | `x3-noicc` |
|---|---|---|---|---|---|
| header | `%PDF-1.3` | `%PDF-1.3` | `%PDF-1.6` | `%PDF-1.3` | `%PDF-1.3` |
| `/Info /GTS_PDFXVersion` | `PDF/X-3:2002` | `PDF/X-1a:2001` | `PDF/X-4` | `PDF/X-3:2002` | `PDF/X-3:2002` |
| XMP `/Root /Metadata` | absent | absent | **present** | absent | absent |
| `/DestOutputProfile` | ICC, `/N 4` | ICC, `/N 4` | ICC, `/N 4` | absent | absent |
| `/OutputConditionIdentifier` | `CGATS TR001` | `CGATS TR001` | `CGATS TR001` | `CGATS TR 001` | `CGATS TR001` |
| `ValidatePdfX` verdict | passes | passes | passes | passes | **1 error** |

The X-1a and X-3 headers sit under the 1.4 legacy ceiling. X-4 is `%PDF-1.6`,
which is correct — ISO 15930-7 is built on PDF 1.6 and the 1.4 cap is a
legacy-level rule (`isLegacy`), not a PDF/X-wide one.

---

## Outcome — the original X-3 fixture

Unlike the font and JPEG fixtures, this one **did** expose correctness defects —
both in the direction the issue predicted (over-enforcement), and both in
`identificationRule`:

**1. XMP `pdfxid` was required at every level.** The rule demanded a
`/Root /Metadata` packet unconditionally and cited *ISO 15930-7 §6.2* — the
PDF/X-**4** standard — while validating X-3. XMP-based identification is X-4's
mechanism; X-1a and X-3 identify through the `/Info /GTS_PDFXVersion` key
(ISO 15930-1/-4 and -3/-6). Ghostscript's X-3 output has no XMP at all and is
conformant. The rule now splits by level, and an XMP packet that contradicts
`/Info` at a legacy level is a **warning**, not an error, per the design's
"downgrade rather than remove" guidance.

**2. Only one identification vintage was accepted.** `xVersionString('3')`
returns `PDF/X-3:2003` (ISO 15930-6), but ISO 15930-3:2002 defines
`PDF/X-3:2002` and both identify PDF/X-3. Ghostscript writes the 2002 string —
its own `PDFX_def.ps` marks that line "Must be so (the standard requires)". The
same split exists for X-1a (`:2001` / `:2003`). Validation now accepts either via
`xVersionStrings`; conversion still writes the newer one.

Defect 2 was **masked** by defect 1: the early return on missing XMP meant the
`/Info` string was never compared at all. Fixing the first is what surfaced the
second.

### Verified load-bearing, not merely green

Per the rule in `CLAUDE.md`, each assertion was confirmed by breaking the code
path it covers and watching the suite go red:

| Mutation to `src/pdfxvalidate.ts` | Result |
|---|---|
| `xVersionStrings('3')` drops `'PDF/X-3:2002'` | caught — 2 tests fail |
| `identificationRule` legacy branch disabled (falls through to the X-4 path) | caught — 2 tests fail |
| `xVersionStrings('1a')` drops `'PDF/X-1a:2001'` | caught — 1 test fails |
| `xVersionStrings('4')` returns `'PDF/X-9'` | caught — 2 tests fail |
| `REGISTERED_CONDITIONS` drops `'CGATS TR 001'` | caught — 1 test fails |

The X-1a mutation fails one test rather than two because the vintage-string
assertion reads the raw `/Info` bytes and never enters the validator; only the
conformance test moves. That is the intended split.

---

## The `CGATS TR001` finding

The issue that prompted the no-profile pair (`zud`) predicted a **false
positive**: that `REGISTERED_CONDITIONS` was a too-narrow hand-written subset,
and that Ghostscript writing `CGATS TR001` where we list `CGATS TR 001` meant
our set needed widening. The check went the other way.

The [ICC CMYK characterization data registry](https://registry.color.org/cmyk-registry/)
lists the reference name **`CGATS TR 001`, with the space**, alongside
`CGATS TR 002/003/005/006` in the same form. `CGATS TR001` is not a registered
name. Our set is right; **Ghostscript's shipped `PDFX_def.ps` sample writes an
unregistered identifier**, and every file produced from it unedited inherits
that.

This is invisible in the three profile-carrying fixtures because
`outputIntentRule` returns at the embedded-stream branch — an embedded
`/DestOutputProfile` makes the identifier moot, which is why Artifex can ship
the typo without anyone noticing. It only bites a file that relies on the
registered name alone, which is precisely what `ConvertToPdfX` emits by default.

So the pair is deliberately asymmetric, and only one of the two is conformant:

- `ghostscript-x3-registered.pdf` → **passes**. Guards the false-positive
  direction: a conformant registered name with no embedded profile must not be
  rejected. This is the branch the default `ConvertToPdfX` path rests on and it
  had no real-world guard at all.
- `ghostscript-x3-noicc.pdf` → **one `OutputIntent` error**. Guards the
  enforcement direction, and pins the exact spelling that fails.

No validator change resulted. The strict match is kept on purpose: accepting
`CGATS TR001` would mean accepting a name that is not in the registry, and the
conservative reading of ISO 15930 §6.3 is that the identifier *shall* be a
registered characterization name. Loosening to whitespace-insensitive matching
would paper over a real defect in the producer's file.

**Open question:** whether a production preflight tool (Acrobat, veraPDF)
flags `CGATS TR001` the same way, or tolerates it as a near-miss. Untested —
see below.

---

## Not covered

Five files from a **single producer**, all from the same trivial one-page
source. Everything below remains builder-only or unverified:

- **X-4's substantive feature surface.** The `-dPDFX=4` run establishes the XMP
  `pdfxid` identification path and nothing else: this input has no live
  transparency, no optional content, no embedded files and no `JPXDecode`
  imagery, so Ghostscript emitted none. The open questions about X-4's position
  on **embedded files and `JPXDecode` are still unanswered**, and our rules for
  them are still written from working knowledge rather than the ISO text. A
  fixture cannot settle them either — Ghostscript is a producer, not a
  validator; it would pass such constructs through without ruling on them.
  Answering these needs the ISO 15930-7 text or a preflight tool.
- **X-4p.** The `p` variant (external profile reference) is untouched.
- **The rest of `REGISTERED_CONDITIONS`.** One name of ~57 is witnessed by a
  real file. The omissions `zud` predicted (`CGATS21-2-CRPC1..7`,
  `APTEC_CTV_3..8`, `JCS2011`, `JC200104`, `FOGRA48/49/50/53/54`, the two APTEC
  board names) were confirmed against the registry and fixed under `h1h`, and
  builder tests now pin each of them — but a builder test only proves our set
  contains the name we told it to contain. The set as a whole is still a
  transcription of a web page, retrieved 2026-07-21, with no fixture behind it.
  It will drift again as the registry grows.
- **Producer diversity.** Everything here is Ghostscript. A second producer
  (Acrobat Distiller, callas) would be worth more than a sixth Ghostscript file
  — a shared-convention bug in Artifex's reading of ISO 15930 is invisible to
  all five of these at once, and the `CGATS TR001` finding shows Artifex's
  sample is not infallible.
- **A conformance verdict from a real preflight tool.** "Ghostscript emitted it
  under `-dPDFX`" is good evidence, not certification. Neither Acrobat Preflight
  nor veraPDF has been run against any of these.

## Licence

All five PDFs embed subsets of NimbusSans and NimbusRoman, URW base35 under
AGPLv3 + font exception — the same grant already covering the URW faces in
`fonts/` (`fonts/LICENSE-URW-AGPL.txt`). The three `pdfx-fixture-def*.ps` files
are one- and two-line modifications of a Ghostscript AGPLv3 sample file.

`package.json` declares `files: ["dist"]`, so nothing under `test/` enters the
published tarball.
