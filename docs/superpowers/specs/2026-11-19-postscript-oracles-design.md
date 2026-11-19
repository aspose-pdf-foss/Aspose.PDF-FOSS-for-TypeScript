# Independent PostScript and EPS oracle fixtures

Issue `aspose-pdf-foss-for-ts-lw8w.5`. Complete design approved by the user
on 2026-11-19 (yes). Branch `feat/lw8w.5-postscript-oracles`.

## Intent and current evidence

Validate `Document.AddPostScript` against a separately implemented interpreter,
using reproducible, committed Ghostscript references. Existing language,
graphics, text and EPS tests hold literal expectations and saved/reopened output,
but their visual checks use this library. They explicitly do not establish
independent visual agreement. `qpdf --check` establishes structure only.

This issue supplies that missing evidence for a bounded fixture set. It does
not claim general PostScript conformance or complete the separate fractional
integer-`for` investigation, `lw8w.6`.

## Approaches

1. **Converted PDFs alone.** Matches the original issue's smallest reading and
   permits page/text/geometry comparisons, but running both PDFs through our own
   interpreter can hide a defect shared by those reads.
2. **Converted PDFs and direct raster references, with a compact mixed corpus.**
   Keep inspectable Ghostscript PDFs and PNGs rendered independently from the
   source. Exercise focused boundaries and unmodified external source. This is
   the proposed approach: it tests visible output without asking our PDF reader
   to establish its own truth.

An exhaustive upstream interpreter regression suite is outside this issue's
small fixture-set scope and would mostly exercise deliberately unsupported
features. PNGs alone would omit the converted PDF references the issue requests.

## Corpus

Use an explicit manifest, not a directory glob with silently skipped failures.
Target about ten logical cases; multipage outputs and equivalent EPS envelopes
may create additional files. The implementation plan fixes the final case IDs,
source revisions and license records before generating references.

The required coverage is:

- Multipage ordinary PS: explicit blank pages, a marked trailing page and source
  page-size changes. Check page ordering and geometry independently.
- Constructed vector paths: cubic curves, transformed strokes, dashes and
  cumulative clips, with substantial painted regions.
- DeviceRGB/Gray images and paints, including raw `currentfile` image samples
  in a counted DSC block and a filtered image source.
- Text using the same explicitly selected Type 1 and TrueType program bytes in
  both engines; include nontrivial glyphs, advances and a transformed baseline.
  Add a small self-contained Type 3 source font to cover procedure glyphs.
- Reusable forms and tiling patterns, with nested paint/text and a nonidentity
  transform. Reuse existing integration-source ideas without treating their
  present expected values as oracle output.
- EPS with a negative integer origin, fractional HiRes bounds and deferred outer
  bounds. Exercise ASCII/EPSI and separate DOS TIFF/WMF envelopes without
  interpreting their preview artwork.
- At least two externally authored, unmodified PS/EPS inputs with identifiable
  upstream provenance. Prefer compact upstream samples that exercise emitted
  definitions and paths, including an application-produced EPS when available.
  Record the actual author/producer; an external hand-written example must not
  be described as application output.

Pin external selections by URL, revision, checksum and license. Do not replace
a failing selected sample just to make the suite green. A supported-behavior
failure earns a focused regression and correction; a genuinely unsupported
mechanism is recorded and tracked explicitly, not hidden in an allowlist.

DeviceCMYK/spot-color preservation may receive semantic checks, but pixel
agreement is scoped to an explicitly matched color model. Ghostscript's ICC
defaults and this library's device-color conversion must not be conflated by
loosening a global image threshold.

## Generation and tool ownership

Pin Ghostscript 10.07.1, consistent with the existing PDF/X fixture producer.
Accept an explicit executable path and verify its actual version. The recorded
`C:/Users/user/gs/gs10.07.1` installation is absent on this machine; PATH,
registry and common installation locations were also checked. Obtaining a
verified generation-only executable is a prerequisite, not completed work.
Prefer an isolated scratch/tool location; do not silently install machine-wide
software or add an npm runtime dependency. If it cannot be obtained, keep the
issue in progress and report that concrete prerequisite rather than manufacture
oracle bytes.

A regeneration script produces both reference PDFs and direct source renders.
It uses explicit devices, noninteractive execution, finite timeouts, fixed
resolution/background and recorded font/color settings. The normal test suite
never invokes Ghostscript, downloads inputs or regenerates goldens.

Use an explicit Fontmap or equally verifiable loading mechanism for the exact
licensed font programs supplied to our public API. Disable ambient platform
font lookup and detect substitutions; matching a nominal Standard-14 name does
not establish that the two engines draw the same outlines. Reuse existing font
fixtures/licenses where possible. Record any source-font expansion separately
from the original source and preserve its byte identity for both executions.

For EPS, document and verify Ghostscript's import/device setup against the
declared bounds. Do not preprocess EPS through our own framing or DSC reader to
compute the oracle. A required host wrapper must be independently specified,
retained as an oracle input and limited to placement/device/font setup; it must
not implement source graphics or text operators. Where standalone Ghostscript
page lifecycle differs from our EPS importer policy, use a stated compatible
fixture or an independently justified import wrapper, rather than report raw
standalone output as equivalent.

Run PDF conversion and direct rasterization from the same selected source and
explicit setup. A PNG made only by rendering a Ghostscript PDF through our own
renderer is not an independent reference. Record stdout/stderr, exit status,
complete command arguments, tool version, input/output hashes and font hashes.
Generate in scratch and publish the complete artifact set only after every
selected job succeeds. Failed regeneration must preserve existing goldens.

## Assertions and comparison policy

All library execution goes through `Document.AddPostScript`, then Save/Open so
the checks include framing, execution, resource installation and serialization.
Use literal manifest page counts, sizes and selected semantic facts alongside
the independent reference artifacts. Keep page order exact; compare fractional
point geometry with a stated numerical tolerance, not pixel rounding.

Compare our rendered output with Ghostscript's direct PNG on the same pixel
grid. Reuse the existing PNG decoder and image-comparison helpers where they
fit. Measure whole-page differences plus named regions containing each feature;
a tiny lost glyph must not disappear into a mostly white page denominator.
Blank-page expectations are checked separately. Include independent interior
color/occupancy probes and minimum painted-content checks where useful.

Thresholds must account for antialiasing and font hinting while remaining able
to detect missing paint, wrong clipping, displaced text, a changed image sample
and duplicate/lost EPS translation. Record measured baselines and the reason
for each threshold. Do not blindly adopt another corpus's 1% ceiling, compare
only encoded PNG lengths or weaken bounds to absorb a functional mismatch.

Prove the fixtures' assertions with targeted mutations: wrong page dimensions,
omitted clip, wrong image data/placement, omitted or displaced glyph output,
wrong form/pattern transform and EPS normalization. Record which cases fail;
do not claim that a witness validates an operation its mutation cannot reach.

## Files and documentation

- `test/fixtures/postscript-oracle/`: selected sources, reference PDFs, direct
  PNGs, machine-readable manifest/observations and `PROVENANCE.md`.
- `scripts/gen-postscript-oracles.ts` (or `.mjs`): explicit, generation-only
  runner. A package script may expose it; no normal-test hook is added.
- `test/postscript-oracle.test.ts` and small helpers as needed: public import,
  independent artifact comparisons and literal semantic assertions.
- Update existing PostScript provenance and CLAUDE's fixture table to describe
  exactly what was executed and what remains outside the corpus. Add applicable
  third-party notices for vendored inputs. No new public API is planned.

The source-language engine remains unchanged unless a witnessed supported
behavior fails. Such fixes follow RED/GREEN and update CHANGELOG; fixtures and
documentation alone do not get a user-facing changelog entry.

## Completion

The approved plan will specify source acquisition, tool provisioning,
generation, comparison bounds and mutation witnesses concretely. Execute inline
under the established preference, with one fresh whole-branch review. Run
typecheck and the complete test suite, integrate under repository policy, verify
both gates on main before closing `lw8w.5`, push main and sync Beads. Preserve
unrelated user files and remove the merged feature branch after completion.

## Sources

- Ghostscript 10.07.1 [release](https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/tag/gs10071).
- Version-pinned [usage/font lookup](https://ghostscript.readthedocs.io/en/gs10.07.1/Use.html)
  and [raster-device documentation](https://ghostscript.readthedocs.io/en/gs10.07.1/Devices.html).
- Existing approved core, graphics, text and EPS specs under
  `docs/superpowers/specs/2026-11-17-postscript-core-design.md` and
  `2026-11-18-postscript-{graphics,text,eps}-design.md`.
