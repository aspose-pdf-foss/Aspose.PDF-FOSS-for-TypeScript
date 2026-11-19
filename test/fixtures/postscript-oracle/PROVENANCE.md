# Independent PostScript and EPS references

Issue `lw8w.5`, captured 2026-11-19. Thirteen frozen inputs produce thirteen
Ghostscript PDFs and fifteen **direct source** PNGs. Nothing here is a PNG
rendered from a PDF by this library. Tests use committed bytes without invoking
Ghostscript, accessing the network or regenerating references. The hermetic
generator tests launch a fake Node child solely to exercise orchestration.

This is bounded evidence for these sources, fonts, encodings and devices, not
general PostScript conformance. The original literal-test corpora remain useful
and are not retroactively described as independent oracles. `lw8w.6` remains
separate. No runtime dependency or public API was added.

## Inputs and licenses

`UPSTREAM.md` pins the untouched Illustrator 1.2d4 tiger and upstream colorcir
example to ghostpdl commit `9a39d68ca934f8e9343f46a2803e765122a3b4a9`.
`LICENSE.ghostpdl` and `COPYING.ghostpdl` retain upstream AGPL-3.0-or-later terms;
these files are test assets outside the npm package. The other eleven inputs
are original test programs. `inputs/hashes.json` freezes their exact bytes,
including currentfile samples, counted DSC lengths and DOS preview envelopes.
Reading or regeneration never repairs these expected hashes.

`test/helpers/postscript-oracle-cases.ts` fixes all page boxes, regions, probes,
source hashes and font registrations. The manifest repeats this matrix and
records each PDF/PNG hash. The separately maintained `policy.json` binds every
reference hash and every page/region key; the generator never writes it.

## Generation tool

The absent system Ghostscript installation was replaced with an **extracted,
generation-only** distribution under `.tmp/lw8w5-tools/`; no installer, registry
change or machine-wide installation was used. Artifex's official `gs10071w64.exe`
and ip7z's official `7z2602-x64.exe` were verified before extraction:

| File | SHA-256 |
| --- | --- |
| gs10071w64.exe | 3a4c28d0aac47aa7cccd35a5932c55110376e9dbd966898dde388b7faba444a4 |
| 7z2602-x64.exe | 6745fa76dc2ea031596d8678f6f6b99c3c1b435b4164a63485adbbc7b8d82ef0 |
| gswin64c.exe | de3bce7c03dfce0dfd78af8bf1d464c6a21fbcb7237f127ec5c027179d2c2741 |
| gsdll64.dll | af9bcd9313956aea105fd38da35413d50e446548ba21b6e85b87da3f24e8c546 |

The executable reports **GPL Ghostscript 10.07.1 (2026-05-19)**. Sources:
[Ghostscript release](https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/tag/gs10071),
[7-Zip release](https://github.com/ip7z/7zip/releases/tag/26.02).

From the repository root:

```text
npm run gen:postscript-oracles -- --gs .tmp/lw8w5-tools/ghostscript/bin/gswin64c.exe
```

`--out <directory>` permits a separate scratch capture. The executable path is
explicit, its version is checked before generation, and source/font hashes are
checked before execution. `execFile` receives argv arrays, with no shell, hidden
Windows processes, a 60-second per-command timeout, a 1 MiB log bound and
`SOURCE_DATE_EPOCH=0`. A sibling staging directory holds the entire new corpus.
PDF geometry and complete PNG chunks, CRCs, decoded sizes and cardinality must
all validate before the directory handover; a failed handover restores the old
directory. Existing nonempty destinations must be positively identified prior
generated sets: manifest ownership/schema, exact listed files and matching
hashes, with no extra files or directories. Unmanaged destinations and changed
or additional user files are refused before execution and again before moving.
Producer PDFs must retain terminal startxref/EOF framing and open without
recovery. Inputs and policy are outside that replaced directory.

`references/runs.json` retains every successful command, stdout/stderr and zero
exit status, with `<ROOT>`, `<STAGE>` and `<GS>` path bindings. Exact local argv
and extracted setup files were also retained in generation scratch logs. The
portable `inputs/setup/` copies document each independently specified host and
Fontmap; substitute `<ROOT>` with the absolute repository path. The runner
reconstructs these files and records their actual-byte hashes in the manifest.

## Device and font policy

Common arguments are `-dSAFER -dBATCH -dNOPAUSE -dNOPLATFONTS
-dNONATIVEFONTMAP`, an explicit Fontmap and file-read permissions, and an empty
ambient FONTPATH/GS_FONTPATH. Substitution warnings fail generation. Every
requested font must report the selected dictionary's exact PathLoad and expected
FontName. These are read directly from the selected font, rather than inferred
from a loading diagnostic substring or an earlier attempt. A silent nominal
fallback also fails. The same program bytes are passed to AddPostScript:

| Registration | Existing program | SHA-256 |
| --- | --- | --- |
| NimbusSans-Regular | test/fixtures/fonts/NimbusSans-Regular.t1 | 779a9c820bbe8b470d36e77bcf949eef7bf1b889184274ba0f51da4c8c883cfa |
| LiberationSans | fonts/LiberationSans-Regular.ttf | 76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8 |
| Times-Roman | fonts/LiberationSerif-Regular.ttf | 058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74 |

Existing font licenses apply; bytes are not duplicated. Ghostscript aliases the
loaded LiberationSerif program to Times-Roman. Supplied TrueType fonts are
explicitly reencoded to StandardEncoding in the **font setup**, matching the
API; source programs remain unchanged. This matters for colorcir's apostrophe:
GS's native sfnt encoding otherwise selects quotesingle, while StandardEncoding
selects quoteright. The Type 1 program retains its own encoding.

PDF conversion uses `pdfwrite`, PDF 1.7, no autorotation, LeaveColorUnchanged,
embedded nonsubset fonts and a 72 dpi device. It omits Info dates, trailer ID and
optional XMP. `OmitID` alone did not omit XMP's generated DocumentID; byte-level
and qpdf QDF comparison isolated that UUID as the repeat-capture difference.
With `OmitXMP=true`, repeated captures produce byte-identical PDFs and PNGs.
Execution diagnostics are not promised byte-identical.

Direct rasterization uses `png16m`, 144 dpi, opaque white, TextAlphaBits=4 and
GraphicsAlphaBits=4. GridFitTT=0 and AlignToPixels=0 select unhinted outlines and
subpixel placement, matching the library's outline renderer. Without this
explicit control the TrueType text region differed by 35.23% under the initial
exact-neighbor metric; turning off hinting reduced it to 16.70% before the
coverage treatment described below. No raster antialias flags reach pdfwrite.

Ordinary PS starts on a literal 595x842 point device; source PageSize changes
remain enabled. Only ps-pages receives a final host `showpage`, to flush its
declared marked tail. Its three pages are blank 80x60, red 80x60 and blue 100x80.
All EPS sources execute one showpage. Immediate EPS/EPSI/DOS/tiger bounds use
native EPSCrop. Deferred EPS uses NOEPS plus the independent literal host
`<< /PageSize [100 50] >> setpagedevice 10 -20 translate`; no library DSC or
framing code computes that oracle setup. The fractional EPS remains exactly
99.25x49.25 points; its physical grid rounds to 199x99 pixels, not new PDF bounds.

Tiger's source rounds constructed points to a quarter of the active device
pixel. pdfwrite at 72 dpi and PNG at 144 dpi therefore execute slightly different
coordinates. This is retained, documented device dependence, not source editing
or general pixel conformance. colorcir restores its saved VM state before its
final showpage; all its output and ordering remain required. Its import uses an
explicit bounded 100 million operation policy because the default 10 million is
insufficient. Product defaults are unchanged.

## Comparisons and measured limits

Each public test runs AddPostScript, Save and Open before checking page order,
MediaBox/CropBox, rotation, known text, and direct PNGs at scale 2. Ghostscript
PDFs independently confirm page/text/geometry facts. Type 1/TrueType A-advance
bars have literal widths 16.008 and 16.0078125 pt: ours must agree within 1e-6 pt;
GS serializes both as 16.0078, so its separate tolerance is 3e-4 pt. Both PDFs'
RGB/Gray image samples, including GS's inline images, must equal the literal
source arrays exactly. qpdf 12.3.2 `--check` found all thirteen PDFs structurally
clean; this is not a visual assertion.

`observations.json` retains strict counts, foreground occupancy and region
measurements. RGB delta12 defines a strict mismatch; foreground is the union
of pixels with any channel below250, so white margins cannot dilute a lost
feature. A blank reference allows zero strict mismatches. Each expected region
requires paint in both images; literal interior probes use delta2.

Antialias treatment is symmetric and limited to a 3x3 neighborhood. Each
different pixel must be near contrast above12 and each color must occur in the
opposite neighborhood, either as an actual sample or on the RGB segment between
local lightest/darkest samples. The segment permits different fractional
coverage shades without treating interior color drift as coverage. Strict
counts are retained separately. This is a recorded departure from the plan's
exact-sample-only neighbor rule, which rejected a literal 80-vs-160 gray edge
even though both occupied the same contour. A one-pixel contour defect can be
accepted; this corpus does not claim finer spatial discrimination.

Bounds are reviewed separately from generation: max(0.005, baseline*1.25+0.0025),
with zero for the blank page. Paint caps are 5%, text caps20%. The sole explicit
exception is ps-images/rgb: Ghostscript uses Mitchell filtering, this renderer
uses bilinear. The measured mismatch is 11.4896% of image foreground, bounded
at14.6120%; the page is6.2387%, bounded at8.0484%. The exception's hard caps are
15% and10% respectively. It is **not** evidence of matching interpolation
kernels. Exact sample checks, interior probes and changed-sample/placement
mutations guard the independent image semantics; no other bound is widened.

Other whole-page baselines are: paths0.0162%, fonts0%, reuse1.6967%, integer,
deferred and DOS EPS0%, fractional EPS1.0402%, EPSI0%, tiger1.2517% and
colorcir0.2434%. Named text regions include the isolated 8pt A; its loss cannot
hide in the rest of the font specimen. The small fractional red-edge difference
and nested-pattern edge differences are retained in the measurements.

## Witnessed compatibility correction and mutations

Tiger exposed a valid implicit outer `EndProlog` emitted without `BeginProlog`.
The focused DSC regression failed before the correction. The scanner now accepts
that outer boundary before the trailer while preserving nested matching and
counted-data refusals. The real untouched tiger import is required too.

Mutation evidence and final verification are recorded with this issue in Beads.
The mutations target page width, omitted clipping, removed clipped paint,
changed image sample/placement, isolated tiny glyph, all glyph paint, a 2pt
glyph baseline shift, form transform, EPS origin sign and a mark on the blank
page. Each mutation is applied alone and restored; only a real failed assertion,
not a load/transform error or skipped test, counts as detection.

The generator/decoder failure witnesses include wrong version, source/font
hash changes, silent or reported substitution, bounded-output overflow,
timeout/nonzero exit, missing/truncated/corrupt/extra PNG, wrong page count and
geometry, unsafe output paths, and rollback after the old directory was moved.
Normal corpus tests need no oracle executable on PATH.

Final independent review additionally pinned unmanaged-directory preservation,
later-job truncated/recovered PDFs and misleading prefix/earlier-attempt font
diagnostics. All were RED before their fixes. A source-input mutation survived
the original Buffer.slice snapshot because it shared storage; independent byte
copies now detect that mutation, and normal imports pass after restoration.

The generator uses the host platform's separator for Ghostscript's read
permission list (`lw8w.7`). The executable capture and generation instructions
here are verified on Windows. Duplicate outer EndProlog handling is tracked
separately as `lw8w.8`.
