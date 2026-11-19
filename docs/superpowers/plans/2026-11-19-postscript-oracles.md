# PostScript and EPS Oracle Fixtures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use
> `superpowers:executing-plans` to implement task by task inline, then obtain
> one independent whole-branch review. This preserves the existing execution
> preference. Repository instructions require Beads for progress and rulings;
> this plan is not a checkbox ledger. Await user plan review before execution.

**Goal:** Commit reproducible independent Ghostscript PDF and PNG references
that validate the public PS/EPS import pipeline over a small mixed corpus.

**Architecture:** A frozen input matrix supplies authored jobs, two untouched
upstream inputs and explicit fonts/device setup. A generation-only runner stages
Ghostscript outputs and provenance before publication. Offline tests import the
same source through AddPostScript, Save/Open, and compare literal geometry and
feature regions with the independent artifacts.

**Tech Stack:** TypeScript NodeNext ESM, `.js` specifiers, Node built-ins, vitest,
existing tsx and PNG helpers. No added npm/runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-19-postscript-oracles-design.md`,
approved by the user on 2026-11-19. Branch `feat/lw8w.5-postscript-oracles`;
planning base `78af6b7e`, feature base `ccde22d2`.

## Global Constraints

- Ghostscript **10.07.1** is a generation tool only; normal tests invoke no
  Ghostscript, network access or golden regeneration.
- Run every selected case. Never substitute our writer/renderer for independent
  reference generation, silently skip failures or swap a failing frozen source.
- Target eleven logical families, thirteen manifest entries including the two
  DOS envelope variants below. External sources remain byte-identical.
- Font files, source/tool revisions, hashes, effective commands and color/device
  setup are provenance inputs. A font name alone is not program identity.
- All library end-to-end execution uses Document.AddPostScript, then Save/Open.
- Keep source/count/currentfile bytes exact. Mark committed input bytes `-text`
  in .gitattributes, including upstream LF files and binary source/envelopes.
- RGB/Gray raster agreement only; do not absorb an ICC/CMYK-model mismatch in a
  permissive global threshold. No general language-conformance claim.
- Generation failure preserves existing artifacts. No machine-wide installation
  or registry change is needed by the preferred tool-acquisition path.
- Correct witnessed supported behavior with RED/GREEN and CHANGELOG in the same
  commit. Tests/docs alone do not receive a user-facing changelog entry.
- Every source catch starts with rethrowLimit. No new value-import cycle or
  public export. Track progress/decisions in lw8w.5 and preserve user files.

## Review Focus

1. A requested font silently falling back to a nominally similar bundled face
   must fail generation, not produce a misleading visual baseline (T2/T3).
2. A timeout, nonzero exit or incomplete later page must preserve the entire
   committed artifact set; paths with spaces/metacharacters remain argv, never
   shell commands (T2).
3. EPS deferred bounds and standalone PS finalization must match the stated
   importer/device policy without using our framing/DSC parser as oracle (T3).
4. A lost tiny glyph, unexpected mark on a blank page or missing clipped feature
   must not disappear into the white-page denominator (T4/T5).
5. An external producer's optional prolog opening, source device-grid rounding
   and saved state must not be rewritten, silently excluded or mistaken for
   antialiasing without an explicit measured explanation (T1/T3/T5).

## File / Interface Map

- `test/helpers/postscript-oracle-cases.ts`: `OracleCase`, `OraclePage`,
  `OracleRegion`, `OracleFont`, and `oracleCases(root: string): OracleCase[]`.
  Case source paths are relative to the corpus; expected values are literals.
- `test/fixtures/postscript-oracle/inputs/`: thirteen source files plus retained
  independent host/font setup files. `UPSTREAM.md`, `LICENSE.ghostpdl` and
  `COPYING.ghostpdl` identify/retain upstream terms.
  `inputs/hashes.json` freezes expected source hashes once, before generation.
- `scripts/postscript-oracle-runner.ts`: command construction and staged
  generation; owns Node process/filesystem interactions. No src PS/framing/
  rendering imports; Document.Open may inspect reference PDFs for validation.
- `scripts/gen-postscript-oracles.ts`: thin CLI, `--gs <executable>` and optional
  `--out <directory>`; execution only when invoked as the entry script.
- `test/helpers/fake-ghostscript.mjs`: Node child used only to test orchestration
  errors. It is explicitly not an interpreter or source of corpus goldens.
- `test/postscript-oracle-generator.test.ts`: hermetic runner failure/argv tests.
- `test/helpers/postscript-oracle-compare.ts` and
  `test/postscript-oracle-compare.test.ts`: raster comparison.
- `test/postscript-oracle.test.ts`: frozen manifest/artifact integrity, public
  import, PDF geometry/text facts, independent PNG comparisons.
- `references/manifest.json`, `references/<id>.pdf`, `<id>-<page>.png`,
  `references/runs.json`: the complete generated set, published together.
- `policy.json`: manually reviewed comparison bounds and reference-PNG hashes,
  outside the generated directory. Regeneration never rewrites these bounds.
- `PROVENANCE.md`: commands, versions/hashes, measured differences, limits and
  mutation matrix. Update prior PS provenance and CLAUDE's fixture table.

`OracleCase { id:string; source:string; sourceSha256:string;
format: 'ps'|'eps'; setup: 'ps'|'eps-native'|'eps-literal';
epsBox?: [number,number,number,number]; flushMarkedTail: boolean;
fonts: readonly OracleFont[]; pages: readonly OraclePage[] }`.
`OracleFont { name; path; sha256 }`. `OraclePage { mediaBox: [number,number,number,number];
blank?: true; text?: readonly string[]; regions: readonly OracleRegion[] }`.
`OracleRegion { id; box: [number,number,number,number]; kind: 'paint'|'text'; probes?:
readonly { x:number; y:number; rgb:[number,number,number] }[] }`.
Region boxes/probes are literal PDF points, bottom-left origin; raster mapping
uses the fixed scale and image height. EPS boxes are independent literal setup
data attached to eps-literal cases, never inferred through src/epsdsc.ts.

## Task 1: Acquire the pinned oracle and freeze corpus inputs

**Files:** Create the case helper, inputs and upstream/license records above;
modify .gitattributes. Add case/byte-integrity tests to postscript-oracle.test.ts.

**Interfaces:** Produces oracleCases and exact source bytes; T2 consumes this
matrix without changing its sources or deriving expected geometry from output.

**Step 1.** Provision under `.tmp/lw8w5-tools/`, not the machine installation.
Use an existing verified 10.07.1 executable if supplied. Otherwise download:

| Official asset | SHA-256 |
|---|---|
| `ArtifexSoftware/ghostpdl-downloads`, `gs10071/gs10071w64.exe` | `3a4c28d0aac47aa7cccd35a5932c55110376e9dbd966898dde388b7faba444a4` |
| `ip7z/7zip`, `26.02/7z2602-x64.exe` | `6745fa76dc2ea031596d8678f6f6b99c3c1b435b4164a63485adbbc7b8d82ef0` |

These hashes were read from the upstream release asset records during planning.
Verify before use. The installed `C:/Util/Arc/7za.exe` lacks the NSIS handler.
Extract the full 7-Zip distribution from its asset with `7za x -y -o<scratch>`,
then use its full `7z.exe`/`7z.dll` to extract the Ghostscript installer as an
archive, without running either installer. Locate the extracted gswin64c.exe,
retain its matching DLL/resources, run `-version`, and require 10.07.1.
Record actual executable/DLL hashes and extraction/version output.
If the archive path fails, do not improvise an elevated machine-wide install;
record the exact acquisition failure and resolve this prerequisite before T2.

**Step 2.** Freeze these two original upstream files from
`ArtifexSoftware/ghostpdl` commit **9a39d68ca934f8e9343f46a2803e765122a3b4a9**
(tag `ghostpdl-10.07.1`, distinct from the downloads repo's `gs10071`):

| Input / id | Bytes | SHA-256 | Expected pages |
|---|---:|---|---|
| `examples/tiger.eps` / `upstream-tiger` | 78687 | `ed255555fdab768cce7f025dcde744a6807292cac40f80f73733fbffe61edb4f` | one, `[0,0,550,568]` |
| `examples/colorcir.ps` / `upstream-colorcir` | 2061 | `3867d5e63b6e48e67682970254161368e718a6fb486c49a8029689d2b5d7d9ce` | one, `[0,0,595,842]` |

Git blob hashes were independently checked as eebd7af5eebc7ed8a5cad88451fd02c611d015ae
and ec57be6c6dd86c1a78799c96853e12465185b15d. Retain LICENSE and doc/COPYING from
the same commit (upstream identifies examples as AGPL-3.0-or-later); add the
applicable THIRD-PARTY-NOTICES entry. Tiger identifies Illustrator 1.2d4;
colorcir is an upstream example, not application-produced output.

**Step 3.** Write original input jobs with these fixed IDs and literal geometry:

| ID | Geometry / feature |
|---|---|
| `ps-pages` | blank 80x60, red 80x60, blue marked tail 100x80; three pages |
| `ps-paths` | 160x120; thick cubic/dashed strokes and overlapping clip regions |
| `ps-images` | 160x120; RGB/Gray images, raw currentfile plus ASCIIHex filter |
| `ps-fonts` | 200x120; Type 1, TrueType and source Type 3 labels, transformed baseline |
| `ps-reuse` | 160x120; transformed form containing paint/text/patterns |
| `eps-integer` | BB -10,20,90,70 -> 100x50; source-origin image/path anchors |
| `eps-hires` | BB as above; HiRes -9.5,20.25,89.75,69.5 -> 99.25x49.25 |
| `eps-deferred` | same 100x50, outer atend trailer; nested/string fake boxes |
| `eps-epsi` | same 100x50; comment preview plus counted raw image bytes |
| `eps-dos-tiff`, `eps-dos-wmf` | exact eps-integer executable span, opaque hostile previews |

Use saturated RGB/Gray paint and substantial features. ps-pages literal red
rectangle is `[10,10,40,30]`, blue is `[20,20,50,40]`; write the tail without
showpage and set flushMarkedTail true only there. Other jobs end with one
showpage. Fractional EPS fixtures avoid source resets whose physical-device
meaning differs from standalone Ghostscript; lw8w.4 retains those policy tests.
Each nonblank page gets named feature regions, including individual text labels.

Fonts are existing files: NimbusSans-Regular.t1
`779a9c820bbe8b470d36e77bcf949eef7bf1b889184274ba0f51da4c8c883cfa`,
LiberationSans-Regular.ttf
`76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8`,
and LiberationSerif-Regular.ttf
`058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74`.
Use bindings NimbusSans-Regular, LiberationSans, and Times-Roman respectively;
Times-Roman is for colorcir in BOTH engines, using the same Serif program.
No font-byte duplication. The font specimen has 24-point AWgy labels at
baselines 96 and 64, plus a separate 8-point A at (178,100) with its own region.
It paints A-advance bars at (12,92) and (12,60), height 2, widths 16.008 and
16.0078125 respectively. Those are independent literal metrics, not glyph
ink bounds; assert ours within 1e-6 and Ghostscript PDF coordinates within 1e-4
point (its decimal serialization/float precision). Use a third row for Type3.

**Step 4.** Write `freezes all thirteen selected inputs and their literal boxes`
before helper/input construction. Its core assertions include:

```ts
expect(oracleCases(root).map(c => c.id)).toEqual([
  'ps-pages', 'ps-paths', 'ps-images', 'ps-fonts', 'ps-reuse',
  'eps-integer', 'eps-hires', 'eps-deferred', 'eps-epsi',
  'eps-dos-tiff', 'eps-dos-wmf', 'upstream-tiger', 'upstream-colorcir',
]);
expect(oracleCases(root).find(c => c.id === 'ps-pages')!.pages.map(p => p.mediaBox))
  .toEqual([[0,0,80,60], [0,0,80,60], [0,0,100,80]]);
```

Also assert the upstream hashes above and unchanged bytes after reading.
Freeze all authored source hashes in inputs/hashes.json and load expected
sourceSha256 from it; do not calculate the expected hash afresh from the same
input that generation is supposed to verify. Source changes require explicit
hash review/commit, not silent manifest repair.
Run `npx vitest run test/postscript-oracle.test.ts`; expect RED for
missing inputs/helper, then GREEN for integrity only. No visual result yet.
Run typecheck; commit `test(ps): freeze independent oracle inputs (lw8w.5)`.

## Task 2: Build a safe, staged generation runner

**Files:** runner, CLI, fake child and generator tests from the map; package.json
adds `gen:postscript-oracles: tsx scripts/gen-postscript-oracles.ts`.

**Interfaces:** `OracleCommand { executable:string; prefixArgs:readonly string[] }`;
`oracleCommands(case:OracleCase, paths:OraclePaths): { pdf:string[]; png:string[] }`;
`generateOracles(options:{command:OracleCommand; root:string; outDir:string;
cases:readonly OracleCase[]; timeoutMs?:number}): Promise<void>`.
`OraclePaths {input:string; setup:string; fontmap:string; pdfOutput:string;
pngOutput:string; fontPaths:readonly string[]}`. Prefix args support a real Node child
in hermetic orchestration tests; the CLI's --gs path uses an empty prefix.
The CLI passes all oracleCases(root); it must not execute on import.

**Step 1.** Add tests with literal argv expectations and real Node child effects:
successful complete publication; version mismatch; exit failure; timeout;
missing/corrupt later PNG; wrong page count; changed source/font hash; reported
font substitution. Pure argv tests preserve strings with spaces, quotes, `$()`
and backticks; real child/filesystem tests use only characters legal on the
host filesystem (Windows filenames cannot contain a double quote).
Prepopulate destination with a sentinel and hash every file; any failed run
must leave all bytes and the directory entries unchanged. The fake child's
outputs test orchestration only and never enter the committed oracle corpus.
Use two tiny caller-supplied cases in these tests, not the thirteen production
jobs. Have the fake child copy a real minimal PDF built by the existing
buildClassicPdf helper in the parent test; use literal small PNG bytes.
Define local test helper `hashTree(dir:string): Record<string,string>` over
relative paths and file SHA-256s, recording directories with a trailing slash
and `<dir>` value too. In `keeps every prior file after a later job
fails`, arrange before = hashTree(outDir), a fake second-job exit, then assert:

```ts
await expect(generateOracles(options)).rejects.toThrow();
expect(hashTree(outDir)).toEqual(before);
```

**Step 2.** Run generator tests RED. Implement argument arrays with execFile (no
shell), windowsHide, 60-second per-job default timeout and maxBuffer 1 MiB for
stdout/stderr; include an output-overflow refusal witness. Validate hashes
before execution and version before
all generation. Reject root/ancestor, .git, src, fonts or inputs as the output
directory, and reject overlapping staging/output/input paths before any move.
Generate every case into a sibling staging directory; check
PDF/PNG headers, page cardinality and dimensions before publication. Read the
PDF structure for validation only; no reference pixel is produced by src code.

Publish references by a directory handover with a backup restored on rename
failure; test failure after the old directory was renamed too. Export internal
`publishOracleDirectory(staged:string, output:string,
rename?:(from:string,to:string)=>Promise<void>): Promise<void>` for injection
at that fs/promises.rename boundary; all other operations
remain real, and the assertion is on preserved files rather than mock calls.
Validate resolved scratch/output paths before any recursive cleanup, use native
PowerShell or Node filesystem APIs end-to-end, and delete only owned scratch.
Keep inputs/licenses out of the replaced references directory.

**Step 3.** Capture complete argv, exit status, stdout/stderr, tool/input/font/
output hashes and selected settings. Store portable root placeholders with
explicit bindings; retain actual argv in the scratch run log. Require all
expected pages and no unexpected outputs. Run tests/typecheck GREEN; commit
`test(ps): stage reproducible Ghostscript oracle generation (lw8w.5)`.

## Task 3: Execute independent conversion and raster jobs

**Files:** retained setup/Fontmap files, references/manifest.json, runs.json,
PDFs/PNGs and initial PROVENANCE.md. Extend command tests for device policy.

**Interfaces:** Produces schema-version-1 manifest with case IDs, source/font
hashes, literal page boxes, region definitions, output filenames/hashes, tool
identity, and comparison policies. Generation never reads our emitted PDF.

**Step 1.** Lock command tests RED for the following exact policies. Common
flags: `-dSAFER -dBATCH -dNOPAUSE -dNOPLATFONTS -dNONATIVEFONTMAP`, explicit
Fontmap and permitted file reads, an empty ambient FONTPATH. Fontmap explicitly
maps every supplied name to the exact file; reject substitution warnings and
check reference font identity/known advances. Do not use NOFONTMAP to disable
the very explicit map being supplied.
In `separates vector and raster options`, assert:

```ts
expect(oracleCommands(fixture, paths).pdf).toContain('-dOmitID=true');
expect(oracleCommands(fixture, paths).pdf).not.toContain('-dTextAlphaBits=4');
expect(oracleCommands(fixture, paths).png).toContain('-r144');
```

PDF flags: `-sDEVICE=pdfwrite -dCompatibilityLevel=1.7 -dAutoRotatePages=/None
-sColorConversionStrategy=LeaveColorUnchanged -dEmbedAllFonts=true
-dSubsetFonts=false -dOmitInfoDate=true -dOmitID=true -r72`.
Raster flags: `-sDEVICE=png16m -r144 -dTextAlphaBits=4 -dGraphicsAlphaBits=4`;
opaque white, explicit per-page output template. Set SOURCE_DATE_EPOCH=0 in
the child environment. Do not send raster antialias flags to pdfwrite.

Use an initial PS device `[595,842]`, set in a retained setup PS file rather
than relying on Ghostscript's locale/default paper. Source PageSize changes
remain enabled. Append `-c showpage` only for the declared marked-tail case;
the fixture's last marks, not a source scan, justify that host finalization.

Use native `-dEPSCrop` for immediate EPS bounds, including DOS/EPSI/tiger.
For eps-deferred, use `-dNOEPS` and retained independent literal setup:
`<< /PageSize [100 50] >> setpagedevice 10 -20 translate`, then execute the
unchanged source. Ghostscript's pinned gs_epsf.ps processes header boxes and
stops at EndComments; do not pretend its header crop resolves atend trailers.
The literal setup comes from the fixture's hand-specified geometry, not our
parser. All selected EPS inputs contain exactly one showpage.

**Step 2.** Run command tests GREEN, then invoke the real generator with the
verified --gs path into scratch. Record default-device/resolution control
observations: pdfwrite executes in a 72-dpi point device, raster executes at
144 dpi; source transform/round instructions can be device-sensitive. Tiger
contains quarter-device-grid rounding. Inspect/record this difference rather
than attributing every contour-edge change to a library defect.

Require independently generated PDF page boxes within 1e-6 point of manifest
literals and PNG sizes equal Math.round(point dimension * 2), including the
fractional case's 199x99 pixels. If a control disagrees, fix/explicitly document
the physical-grid setup before accepting visual baselines; never change the
literal EPS box to the rounded raster size. Run the generator a second time
and compare reference hashes. Investigate nondeterminism before claiming byte
reproducibility; retain raw producer output rather than rewriting it with our
serializer. qpdf --check every PDF and record version/results.

**Step 3.** Publish only after all cases complete. Write exact tool/archive/
source/font hashes, commands, license/source identities and device controls to
PROVENANCE. The two external inputs remain hash-identical. Commit
`test(ps): capture Ghostscript PDF and direct PNG references (lw8w.5)`.

## Task 4: Implement independent image and semantic comparisons

**Files:** comparison helper/test, corpus tests, policy.json and observations.

**Interfaces:** `compareOracle(ours:DecodedPng, reference:DecodedPng,
regions:readonly OracleRegion[], scale:number): OracleComparison`.
`OracleStat {foreground:number; strictMismatches:number; edgeAccepted:number;
mismatchFraction:number; maxDelta:number}`. `OracleComparison {failures:string[];
whole:OracleStat & {pageFraction:number}; regions:(OracleStat & {id:string})[]}`.
Dimension mismatch returns a failure without sampling out-of-bounds pixels;
blank/probe/occupancy failures are explicit. It consumes no generator code.
Both whole-page and region statistics use
`mismatchFraction = (strictMismatches-edgeAccepted)/max(1,foreground)`;
whole.pageFraction also records strictMismatches/(width*height).
`OraclePolicy {version:1; dpi:144; referenceHashes:Record<string,string>;
pages:Record<string,{whole:number; regions:Record<string,number>}>}` lives in
policy.json. Page keys are `<id>:<one-based-page>`; referenceHashes contains
every manifest PDF/PNG filename and hash. Reject stale/missing/extra keys.

**Step 1.** Write small literal pixel tests RED: identical, dimension mismatch,
lost 3x5 black glyph on a large white page, new mark on a blank page, wrong
interior color, moved feature, empty named region and a one-pixel antialiased
edge. Both missing and unexpected paint count; alpha is treated consistently
with the opaque-white contract. A region outside the image is an error.
In `does not dilute a lost glyph into a white page`, construct a 100x100 white
reference with one solid 3x5 black glyph and an all-white observed image; a
named region contains exactly that glyph. Assert:

```ts
const result = compareOracle(blank, referenceWithGlyph, [glyphRegion], 1);
expect(result.regions[0]!.foreground).toBe(15);
expect(result.regions[0]!.mismatchFraction).toBe(1);
```

**Step 2.** Implement strict RGB delta **12**, foreground when any channel is
below **250**, denominator the UNION of foreground in both images. Blank pages
require zero mismatches over delta12; nonblank expected regions require positive
reference and observed occupancy. Keep whole-page strict statistics even if a
separate edge-tolerant metric is used. Permit a symmetric one-pixel neighbor
match only for edge differences, not interior color drift, and record accepted
edge counts; this bounds antialias/device-grid differences rather than erasing
missing features. Literal interior probes use channel tolerance 2.
A match requires each pixel's color to exist in the other image's 3x3
neighborhood within delta12; count a differing pixel as an edge only when a
neighbor in either image has channel contrast above12. This rule is symmetric.

Initial hard ceilings are 5% foreground mismatch for paint regions and 20% for
text regions after the bounded edge treatment. Measure/inspect each difference
image before assigning the committed per-region ceiling:
`max(0.005, baseline * 1.25 + 0.0025)`, never above its hard ceiling. Baseline
over the cap is an investigation, not permission to raise the cap. No auto-update
mode rewrites thresholds from a failing run. Prove at least a 2-point displacement
and a removed complete glyph/painted block fail the selected regions.
Apply the same measured-bound formula to the whole foreground-union metric,
with the largest permitted region cap on that page (zero for blank pages).
Write policy.json manually after reviewing measurements. The runner never
rewrites it; changed reference hashes require another explicit policy review.

**Step 3.** Add one public import test per manifest entry, passing identical
font bytes, then Save/Open. Assert exact page ordering/counts, MediaBox/CropBox,
rotation 0, known text labels and widths, and compare ToImage({scale:2}) against
direct source PNGs. The Ghostscript PDF supplies a separate page/text/geometry
cross-check; no PDF-vs-PDF raster comparison substitutes for direct PNG truth.
Assert all thirteen entries ran and every referenced file/hash exists.

Run `npx vitest run test/postscript-oracle-compare.test.ts test/postscript-oracle.test.ts`
and typecheck. Classify observed failures in T5; do not commit a passing claim
until all required cases and assertions pass.

## Task 5: Resolve witnessed incompatibilities and prove witnesses

**Files:** owning src/test regression files only as failures dictate,
CHANGELOG for observable fixes, comparison observations and provenance.

**Interfaces:** Retains all frozen inputs and public signatures; consumes T4's
actual failures. No generic language-engine expansion is implied.

**Step 1.** Pin the known producer shape in test/eps-dsc.test.ts before changing
the scanner: an outer EndProlog without BeginProlog, as tiger actually emits.
Assert a valid required box and public tiger import; retain mismatched nested
EndFile/EndDocument and counted-data refusal cases. Current src/epsdsc.ts treats
every EndProlog as a stack pop, so observe the actual RED rather than assume it.
The focused `accepts an implicit outer prolog boundary` assertion is:

```ts
expect(readEpsBox(epsSource('%%EndProlog\nshowpage'), new PsBudget()))
  .toEqual([-10,20,90,70]);
```

Only broaden an implicit outer prolog boundary where the source requires it;
do not remove structural nesting checks generally. Compare against the real
Ghostscript result and add the user-visible fix to CHANGELOG.

**Step 2.** For each other failure, distinguish source semantics, PDF emission,
our rasterizer, setup/font/color mismatch and genuine unsupported machinery.
Add a focused independent regression first, observe RED, fix and run GREEN.
Record unsupported discoveries in Beads and explicit refusal tests rather than
skipping a selected input. All thirteen positive corpus cases remain required;
if a genuinely unsupported feature makes that impossible, report the scoped
conflict instead of quietly replacing the input or declaring the issue done.

**Step 3.** Temporarily mutate and restore one path at a time: page dimensions,
clip emission, image samples/matrix, glyph emission/baseline, nested form or
pattern transform, and EPS origin sign/duplicate translation. For every change
name the corpus region/test that turns RED, restore, then require GREEN.
Deleting all glyph output and adding paint to the declared blank page must
fail even when the whole page is otherwise white. Update provenance with actual
measurements and the exact limits of what the mutations proved.

Run all PS/EPS, font and raster regression files plus import-cycle,
limits-catch and README guards; typecheck and diff-check. Commit helper/tests
as `test(ps): compare public imports with independent oracle regions (lw8w.5)`
and witnessed production fixes separately with their tests/changelog.

## Task 6: Review, documentation and repository completion

**Files:** PROVENANCE, prior postscript-{core,graphics,text}/PROVENANCE.md,
CLAUDE fixture table and README only if supported behavior/limitations changed.

**Step 1.** State precisely which sources, fonts, host policies, render paths,
colors and resolutions were compared. Preserve prior literal-test provenance;
link the new independent corpus without relabeling old fixtures. Keep the
generation tool out of dependencies, the package tarball and normal test hooks.
Run the generator-failure suite and corpus tests with Ghostscript absent from
PATH and no oracle process access; committed-byte tests must still pass.

**Step 2.** Obtain one fresh whole-branch independent review against this plan,
the spec and the five Review Focus cases. Re-grade findings by consumer effect;
fix material findings once with focused RED/GREEN and the complete suite.
Record rulings/deferred minors explicitly in Beads. No plan-review agent is
dispatched during this writing-plans self-review.

**Step 3.** Run npm run typecheck, npm test, npm run build and git diff --check
on the final branch. Integrate into main under the existing authorization,
rerun both mandatory gates on main before closing lw8w.5, commit tracker
bookkeeping, pull/rebase safely, push main and bd dolt push. Verify upstream
equality, preserve unrelated edits and remove the merged local/remote feature
branch. The parent epic and lw8w.6 are not automatically closed by this task.

## Plan Self-Review

Before commit, map every approved spec section to T1-T6, cross-check each
consumer against these interfaces and all existing helper/CLI callers, and
confirm the five Review Focus items have witnesses. Verify source hashes against
their Git blobs, font hashes, named case count, staging failure behavior,
independent EPS setup, raster rounding and threshold/mutation policy. Record
the outcome in lw8w.5; this paragraph is an instruction, not task tracking.
