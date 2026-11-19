# PostScript and EPS Import Implementation Plan

Use `superpowers:executing-plans` or `superpowers:subagent-driven-development`
after the user reviews this plan and selects the execution method. Track task
progress, verification and rulings in Beads. Repository instructions override
the generic checkbox/Markdown-ledger workflow: this file is a plan, not a task
tracker. No product code changes before that review.

**Goal:** Append bounded PostScript jobs and correctly cropped EPS artwork to a
Document through the approved synchronous AddPostScript API.

**Architecture:** Frame bytes without modifying the executable source, scan EPS
DSC metadata through a bounded structural reader, and configure the existing
VM/graphics/text job. Stage PDF resources and page dictionaries before a single
append commit that preserves the destination's live objects and page tree.

**Tech Stack:** TypeScript NodeNext ESM, `.js` specifiers, Node built-ins,
vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-18-postscript-eps-design.md`, approved
by the user on 2026-11-18. Branch: `feat/lw8w.4-eps`.

## Global constraints

- Public signature: `AddPostScript(bytes: Uint8Array, options?: PostScriptOptions): PostScriptResult`.
- `PostScriptFont { name: string; bytes: Uint8Array }`;
  `PostScriptOptions { format?: 'auto' | 'ps' | 'eps'; pageSize?: PageFormat; fonts?: readonly PostScriptFont[] }`;
  `PostScriptResult { pages: Page[] }`.
- The method is synchronous. No async/progress/cancellation interface is promised
  by this issue. No new Node file helper and no ambient font/file/network access.
- Limits apply per import job, not cumulatively across unrelated method calls.
  Use the destination's current LoadLimits, with no per-call limits patch.
- Check maxFileBytes on the complete original input before inspecting or slicing
  it, including any preview bytes. Preserve source bytes and currentfile offsets.
- One EPS import produces exactly one page, including a valid file painting
  nothing. Normalize MediaBox to `[0,0,urx-llx,ury-lly]`, default matrix
  `[1,0,0,1,-llx,-lly]`; no margins/scaling. Plain PS fallback `[0,0,595,842]`.
- No failed call may change the destination's objects, pages or Save output.
  Preserve existing live Page handles and signed-output state on failure.
- PdfParseError for source/framing damage, UnsupportedFeatureError for unsupported
  source/device/envelopes, TypeError for caller mistakes, ResourceLimitError for
  policy refusals. Every catch begins with rethrowLimit.
- No new value-import cycles. Public types must have README API rows; new source
  modules must have CLAUDE entries. Update CHANGELOG for the public capability.
- Broad producer/visual oracle corpus stays in lw8w.5; integer-for follow-up in
  lw8w.6. Structural qpdf checks are not a visual conformance oracle.

## Review focus

1. A failed append after earlier pages/resources were prepared must preserve an
   existing PDF byte-for-byte, its Page handles, and its signed-output cache (T4/T5).
2. Fake BoundingBox/Trailer text in nested documents, multiline strings, previews
   and counted binary data must never crop the outer artwork (T2).
3. A negative/fractional EPS origin plus initgraphics/initmatrix and nested text,
   image/form/pattern output must apply normalization exactly once (T3/T6).
4. Binary wrapper offsets/lengths with the high bit set, overlapping spans, or
   executable bytes outside the declared PS span must not reach the VM (T1/T5).
5. systemdict showpage and empty setpagedevice requests must not bypass EPS host
   policy; glyph/form/pattern capture restrictions must still apply (T3).

## File and interface map

- `src/eps.ts`: framing/format/header selection and unsupported envelope detection.
  `framePostScript(bytes, format, budget): PsSourceFrame`, where
  `PsSourceFrame { source: Uint8Array; kind: 'ps' | 'eps' }` and format is
  `'auto' | 'ps' | 'eps'`. No Document/VM dependency.
- `src/epsdsc.ts`: `readEpsBox(source: Uint8Array, budget: PsBudget): PsBox`;
  metadata lexical/structural states and box resolution. No source execution.
- `src/psgraphics.ts`: exported internal `PsGraphicsOptions` extends the existing
  optional box/defaultMatrix fields with `eps?: boolean`; used by constructor
  and installPsGraphics. Defaults preserve every existing caller.
- `src/pspdf.ts`: `preparePsPages(pages: readonly PsPageOutput[], allocate:
  (object: PdfObject) => PdfRef, budget: PsBudget): PdfDict[]`; returns fully
  prepared page dictionaries without Parent. Existing `appendPsPages(doc, pages,
  budget?: PsBudget): Page[]` delegates publication to Document's internal append.
- `src/document.ts`: internal `appendPsPagesInternal(pages: readonly PsPageOutput[],
  budget: PsBudget): Page[]` stages resource/page allocation and publishes it;
  public AddPostScript calls the job runner then this append via appendPsPages.
- `src/psimport.ts`: public option/font/result interfaces (Page, PageFormat are
  type imports); `runPostScriptImport(bytes: Uint8Array, options: PostScriptOptions,
  limits: LoadLimits): { pages: readonly PsPageOutput[]; budget: PsBudget }`.
  Options validation and one fresh VM/graphics/text job live here.
- `src/index.ts`: export PostScriptFont/PostScriptOptions/PostScriptResult as types.
- Test builders live under `test/helpers/`, never in product modules. Reuse
  psBytes/joinPs/encryptedPs and the existing text/graphics/font builders.

T1/T2 can be tested against plain buffers and PsBudget. T3 is graphics-only.
T4 is independently testable using existing PsPageOutput fixtures. T5 composes
all four and T6 owns complete saved-output/documentation evidence.

## Task 1: Byte framing and format identity

**Files:** Create `src/eps.ts`, `test/eps-framing.test.ts`,
`test/helpers/build-eps.ts`; update CLAUDE's source list.

**Interfaces:** Produces PsSourceFrame/framePostScript from the map above.
Consumes PsBudget, PdfParseError, UnsupportedFeatureError; uses no VM.
Builder contracts: `epsSource(body: string, comments?: string, eol?: string): Uint8Array`
(default EPSF-3.0 header, BoundingBox -10 20 90 70 and EndComments) and
`dosEps(source: Uint8Array, preview: Uint8Array, kind?: 'tiff' | 'wmf'): Uint8Array`
(valid 30-byte header with FFFF checksum, PS section then preview).

**Step 1.** Add named tests with literal expectations:

```ts
const code = epsSource('1 2 add');
const wrapped = dosEps(code, psBytes('quit definitelyNotPostScript'));
const frame = framePostScript(wrapped, 'auto', new PsBudget());
expect(frame.kind).toBe('eps');
expect(frame.source).toEqual(code);
expect(frame.source.buffer).toBe(wrapped.buffer);
```

Cover ASCII EPSF-1/2/3 version headers, ordinary %!PS and headerless PS;
forced ps/eps contradictions; no arbitrary prefix/header search. Independently
hand-set uint32 offsets including 0x80000000/0xffffffff, truncation, PS span
length zero, header overlap, section overlap and partial-zero pairs. Test WMF
and TIFF separately; permit adjacent sections and unused wrapper gaps. Validate
non-FFFF checksum using XOR of bytes 0..27, and reject corruption. Validate
both previews' nonzero declarations independently (do not invent a decoder).
Recognize AppleSingle/AppleDouble magic 00051600/00051607 and MacBinary II/III
`mBIN` signature at byte 102 as unsupported; signatureless classic MacBinary
has no promised heuristic detection and otherwise fails as source.
A valid extracted data fork remains EPS. Bare PFB is not a whole PS document
wrapper introduced here; host PFB font registration remains in the font layer.

For maxFileBytes use a long preview with a short executable span: error fields
must name maxFileBytes and original wrapped length. Check a one-byte scan-work
limit directly through framePostScript, independently of VM bootstrap.

**Step 2.** Run `npx vitest run test/eps-framing.test.ts`; expect RED for missing
framing/identity, not fixture syntax errors.

**Step 3.** Implement framePostScript in eps.ts. Read first-line/header bytes
with bounded comparisons; allocate small views/scratch only after accounting.
Read uint32 through DataView little-endian and validate `length <= total-start`
with start inside the buffer before slicing. Pairwise range overlap checks use
validated unsigned Numbers, never signed bitwise sums. No preview decoding.
Enforce maxFileBytes first, and meter bounded header comparisons and checksum.
Read EPSF identity from the extracted code too, never the preview.

**Step 4.** Run framing tests, `test/psinput.test.ts`, `test/pseexec.test.ts`
and `npm run typecheck`; expect GREEN. Mutate PS offset/length selection and
confirm the wrapper selection test fails, then restore before committing.

**Step 5.** Commit as `feat(ps): frame bounded PS and binary EPS sources (lw8w.4)`.

## Task 2: Bounded outer DSC bounding boxes

**Files:** Create `src/epsdsc.ts`, `test/eps-dsc.test.ts`; extend build-eps.ts
only for shared fixtures and update CLAUDE's source list.

**Interfaces:** Consumes frame.source and PsBudget from T1; produces readEpsBox.
Returns a copied four-number PsBox, never a reference to mutable source data.

**Step 1.** Write named, table-driven tests with literal boxes. Required cases:
integer `[-10,20,90,70]`; HiRes `[-9.5,20.25,89.75,69.5]`; both declarations
atend resolved in an outer Trailer; each of CR/LF/CRLF; no final newline;
missing/invalid required box despite valid HiRes; negative, fractional integer,
NaN/Infinity, reversed/zero boxes; dimensions that overflow finite subtraction;
conflicting duplicates (identical duplicates allowed); duplicate/conflicting
outer trailers; atend not resolved; HiRes outside the integer box.
Use containment tolerance `1e-7` points, absolute, including boundary tests.
Decimal grammar permits optional sign and decimal point, not exponent notation;
integers are safe integers. This is a concrete parser choice within the approved
finite integer/decimal contract.

Pin spoofing and source preservation independently:

```ts
const input = epsSource('(label\n%%BoundingBox: 0 0 999 999\n) pop\n'
  + '%%BeginDocument: child.eps\n%%BoundingBox: 0 0 888 888\n%%EndDocument\n');
const before = input.slice();
expect(readEpsBox(input, new PsBudget())).toEqual([-10, 20, 90, 70]);
expect(input).toEqual(before);
```

Exercise nested BeginFile/BeginResource/BeginFont/BeginProcSet/BeginProlog,
EPSI preview, escaped/nested parentheses, multiline hex and ASCII85 strings,
and fake Trailer/EOF/EndDocument inside counted blocks. Cover BeginData default
byte counts and explicit Binary/Hex/ASCII with Bytes/Lines, BeginBinary byte
counts, zero counts, truncated blocks, wrong endings and structural mismatch.
Put executable `image` text inside a counted data block to prove the scanner
skips its declared span without changing the later interpreter's input.
Bounds tests must separately exhaust work, retained line scratch, nesting and
container storage with exact limit names. Large irrelevant comments may be
skipped without retaining their full text.

**Step 2.** Run `npx vitest run test/eps-dsc.test.ts`; expect RED for the missing
reader and then for individual structural/lexical gaps as cases are added.

**Step 3.** Implement readEpsBox as a byte cursor with physical line tracking,
lexical state and a structural delimiter stack. Header ends at EndComments,
BeginProlog/BeginSetup, or the first non-comment token; a valid outer Trailer
enters trailer state once. Only depth-zero header boxes and explicitly deferred
depth-zero trailer boxes are candidates. Immediate header values remain the
answer; conflicting later same-scope declarations fail. Stop outer metadata at
outer EOF; ignore following garbage for metadata only (source bytes stay intact).

Recognize DSC only at column zero outside literal/hex/ASCII85 strings. Treat
`<<`/`>>` as dictionary delimiters, not hex strings. Literal-string parentheses,
escapes and line continuations follow the existing scanner's byte rules, without
allocating VM objects. Structural region pairs suppress candidates; binary/data
counted spans are skipped before scanning for region endings. Read their entire
comment line before starting the count; CRLF is one physical line. Require a
matching closing DSC line after a counted payload; counts never allocate arrays.
EPSI preview payload remains opaque until its closing comment. Resource bodies
are scanned only for valid structural/counted boundaries; they never supply
outer metadata. Uncounted opaque binary that prevents safe structural resolution
is malformed deferred metadata, not an excuse for reverse-regexp box selection.

Parse only relevant bounded argument strings. Meter cursor work, numeric reads,
stack entries and retained values using the SAME budget later used by the VM.
No unconditional whole-input TextDecoder conversion; no executing token lookup,
font definition or eexec merely to determine a box. All format failures at this
boundary are PdfParseError, with ResourceLimitError propagated unchanged.

**Step 4.** Run `npx vitest run test/eps-framing.test.ts test/eps-dsc.test.ts`
and typecheck. Mutate nested-region suppression and counted-data skipping
separately; the respective spoof tests must turn RED. Restore and expect GREEN.

**Step 5.** Commit as `feat(eps): resolve bounded outer DSC artwork boxes (lw8w.4)`.

## Task 3: Fixed EPS graphics-device policy

**Files:** Modify `src/psgraphics.ts` constructor/install options, lifecycle and
setpagedevice entry; create `test/eps-device.test.ts`; reuse existing graphics
builders and update CLAUDE invariants. No public Document API yet.

**Interfaces:** Produces PsGraphicsOptions and EPS behavior from the map.
An `eps: true` host job supplies normalized box/defaultMatrix. Host EPS box and
matrix are retained independently of mutable current state and nulldevice.

**Step 1.** Add a test helper constructing PsInterpreter/installPsGraphics with
`{ eps: true, box: [0,0,100,50], defaultMatrix: [1,0,0,1,10,-20] }`.
For no showpage, one/repeated showpage and `systemdict /showpage get exec`, assert
one output with box `[0,0,100,50]`, both fills retained across showpage, and
idempotent finish returning the same result. A completely blank or nulldevice-only
EPS must produce one valid blank page; an erasepage job must lose earlier marks.

For source `-10 20 moveto currentpoint`, expect [-10,20]; transforming that
point yields [0,0]. After initmatrix/initgraphics, defaultmatrix remains
[1,0,0,1,10,-20]. initclip/clippath is the EPS device extent; no A4 resurrection.
After gsave/nulldevice/grestore, painting still targets the EPS device. Cover
EPS PageSize, raw setPageSize, copypage, and empty `<< >> setpagedevice` refusals.
During glyph/form/pattern capture, showpage remains forbidden (the capture guard
runs before the EPS no-op). Test one representative of each capture type using
existing helpers, not a second implementation of captures.

**Step 2.** Run `npx vitest run test/eps-device.test.ts`; expect RED (the existing
graphics session emits multiple pages/resets state and omits blank final pages).

**Step 3.** Add optional eps to PsGraphicsOptions without changing default callers.
Route showPage(copy) through existing capture guard, then EPS policy: reject copy,
otherwise return without publishing/resetting. At the setpagedevice operator,
check EPS policy even for an empty dictionary; retain ordinary operand/type
validation and ordinary PS supported parameter behavior. Guard setPageSize itself
too, so direct and systemdict routes cannot bypass the policy. Keep erasePage's
current semantics. EPS finish selects the host fixed page even if current state
is a nulldevice; output a valid host-sized blank descriptor when no marks exist.
Keep finish caching and output limits; don't use showPage as EPS finalization.
Keep ordinary PS lifecycle unchanged. No source-prelude userdict workaround.

**Step 4.** Run EPS device tests and `test/pspages.test.ts`, `test/psgraphics.test.ts`,
`test/psclip.test.ts`, `test/psform.test.ts`, `test/pspattern.test.ts`,
`test/psglyph.test.ts`; typecheck GREEN. Check ALL installPsGraphics/constructor
callers (including test/helpers); the new options are optional.

**Step 5.** Commit as `feat(eps): enforce a fixed single-page graphics device (lw8w.4)`.

## Task 4: Stage resource installation and append atomically

**Files:** Modify `src/pspdf.ts` installResources/appendPsPages; modify
`src/document.ts` near private install and page mutation helpers; extend
`test/pspdf.test.ts`, create `test/psappend-atomic.test.ts`; update CLAUDE.

**Interfaces:** Produces preparePsPages and appendPsPagesInternal from the map.
appendPsPages's new third argument is optional; existing tests/callers compile
unchanged. Choose the first output's owner budget or doc policy fallback for the
legacy wrapper; the public job supplies its exact budget. One installation uses
one shared cumulative budget. Keep output ownership private to pspdf.ts.

**Step 1.** Add named tests that create output descriptors with existing graphics
fixtures, then append to a PDF containing an existing live Page, metadata and a
nested inherited page tree. On a later cyclic direct resource, invalid later
box, resource-depth limit, actual maxObjects refusal, or installation-work limit:

```ts
const bytes = doc.Save(), first = doc.Pages[0]!, dict = first.Dict;
const objects = [...doc.objectEntries()];
expect(() => appendPsPages(doc, [validOutput, cyclicOutput])).toThrow(/cyclic/i);
expect(doc.Save()).toEqual(bytes);
expect(doc.Pages[0]).toBe(first);
expect(first.Dict).toBe(dict);
expect([...doc.objectEntries()]).toEqual(objects);
```

This strengthens the existing test that checks only page count on a cycle.
Use a saved/reopened signed fixture and assert cached Save bytes and modified
flag survive an installation failure; reuse signature fixture helpers, do not
invent signing mocks. Assert successful append retains preexisting Page handles,
inherited page boxes/resources, root child branches and metadata; returned pages
are live, correctly numbered and survive Save/Open. Assert imported streams
register with the destination decodeBudget. Check actual total object count
including preexisting unreachable objects, independent of largest object number.
Include inline /Pages-root refusal without mutation; no page-tree recovery here.

**Step 2.** Run `npx vitest run test/pspdf.test.ts test/psappend-atomic.test.ts`;
expect RED for leaked resource allocations or lost live handles.

**Step 3.** Refactor installResources to consume an allocation callback rather
than mutating Document. preparePsPages validates ALL boxes first, uses the shared
budget, preserves stream/resource sharing and cycle detection, and produces
page dictionaries with Type/MediaBox/Resources/Contents but no Parent.
No preparation code calls doc.allocObject/AddPage or marks the document dirty.

Document.appendPsPagesInternal stages `Map<number,PdfObject>` using fresh numbers
above maxObjNum (reject unsafe/nonfinite numbering), enforcing maxObjects against
`this.objects.size + staged.size + 1` before every new object. Charge staged map,
page dictionary, ref, page-handle/list and root-Kids storage before allocation.
Build the new page dictionaries/refs, Parent refs and Page handles entirely in
scratch. Verify an indirect dictionary /Pages root and a usable Kids array.
For an empty import return [] without any page-tree validation or mutation.

Preserve the root's existing Kids hierarchy: append new page refs to a copied
Kids array and increment Count using the actual final Pages length. Do NOT call
currentKids/flattenToRoot/syncPages: those mutate existing page dicts and replace
Page handles. Retain root dictionary identity; prepare its new Kids/Count before
commit. Preflight budget/container/numbering constraints and all new Page
construction; run no user callbacks in the commit section. Publish staged objects
through private install (the only objects.set owner), update root Kids/Count,
append new handles/parallel object numbers, and markModified exactly on success.
The short commit consists solely of prevalidated built-in map/array assignments;
no remaining policy checks or traversal that can throw after publication.
registerStream itself only registers identity and does not decode. Do not catch
OOM or promise rollback for process failure. No generic authoring transaction or
serialize/reopen snapshot is needed.

Legacy appendPsPages delegates to this method. Document imports preparation as a
value; pspdf keeps Document type-only, preserving graph direction. Use an internal
annotation on the method (as allocObject already does), not a new index export.

**Step 4.** Run atomic/pspdf tests plus `test/limits-acquired.test.ts`,
`test/import-cycles.test.ts`, `test/sign-incremental-dirty.test.ts`, all `test/ps`
and typecheck. Grep ALL appendPsPages/installResources callers, including tests.
Expect GREEN; no allowlist widening in the install/import-cycle guards.

**Step 5.** Commit as `refactor(ps): stage PDF resources before atomic page append (lw8w.4)`.

## Task 5: Public bounded AddPostScript job

**Files:** Create `src/psimport.ts`, `test/psimport.test.ts`,
`test/psimport-limits.test.ts`; modify document.ts/index.ts/README.md/CHANGELOG.md
and CLAUDE. Public exports and their README rows/counts land in the same task.

**Interfaces:** Implements the public types and runPostScriptImport from the map.
Consumes framePostScript, readEpsBox, PsGraphicsOptions, installPsText and
appendPsPages with the job's exact PsBudget.

**Step 1.** Import the public Document/PageFormat/LoadLimits and three new types
from index.js in tests. Assert one headerless PS rectfill appends one page;
showpage/showpage yields two blanks; empty PS yields none and no mutation;
EPS always yields one page of [0,0,100,50]. Preserve existing Pages/metadata,
return exactly newly appended live Pages and support successive independent calls.
A definition made in one call must be undefined in another.

Test format/bytes/null-options/non-array fonts/duplicate or empty names/invalid
font bytes/invalid PageFormat/invalid LoadLimits before source execution. Require
actual finite positive PageFormat width/height too, since runtime callers can
mutate nominal readonly fields. Reject pageSize for detected or forced EPS.
PS pageSize Letter gives [0,0,612,792]; later supported setpagedevice still wins.
Auto ASCII and binary EPS work; forced contradictions fail before execution.
Use supplied Type1 and TrueType Buffer fixtures with known literal A widths,
then mutate source/font Buffers after import and verify saved text/pixels stay
unchanged. No call to RegisterFontFolder/SystemFonts is required or consulted.

Hostile tests: original wrapper maxFileBytes, cumulative DSC+VM operations,
DSC+glyph allocations, decoded-stream/font totals, total PDF output, recursive
source and actual destination object totals. Catch exact ResourceLimitError
fields, never assert only a message. A two-showpage program followed by an
undefined name or unsupported operator must append no pages. Outside wrapper
bytes `quit`/undefined names and preview bytes must never execute, including
currentfile/eexec/filter reads near the end of the declared span.

**Step 2.** Run `npx vitest run test/psimport.test.ts test/psimport-limits.test.ts`;
expect RED for the missing public entry point and documented behaviors.

**Step 3.** Implement validation in psimport.ts before execution. Enforce whole
input file size before creating/bootstrapping a VM; then create one PsInterpreter
with doc.loadLimits. Pass its budget to framing/DSC and on to all installation
work (never create a second metering epoch). Configure EPS host box/matrix or
plain-PS initial PageFormat; install graphics and text once, register explicit
fonts, run frame.source once, finalize descriptors, return pages plus budget.
No swallowed language/unsupported/limit errors and no fallback to a preview.

Document.AddPostScript validates its current limits through the runner, receives
the finished job, calls appendPsPages(this, job.pages, job.budget), and returns
{ pages }. Any error before publication leaves the destination unchanged.
Export only the three approved public types and document the method. Update
README's obsolete internal-only import paragraph and maxPS limit descriptions;
add example `const doc = Document.New(); doc.AddPostScript(bytes); doc.Save()`
and API rows/counts from the compiler-backed readme-api test. Describe the sync
contract, font supply, PS/EPS page rules, supported engine scope and explicit
unsupported cases; no claims of full PostScript or independent visual parity.

**Step 4.** Run import tests, all `test/ps`, `test/eps`, `test/readme-api.test.ts`,
`test/import-cycles.test.ts`, `test/limits-catch.test.ts`, typecheck and diff-check.
Expect GREEN. Verify declaration build with `npm run build`; main package entry
and new type references must resolve without runtime dependencies.

**Step 5.** Commit as `feat(ps): expose bounded PS and EPS page import (lw8w.4)`.

## Task 6: Saved-output, hostile integration and final review

**Files:** Create `test/eps-integration.test.ts` and original small fixtures in
`test/fixtures/eps/` with PROVENANCE.md (or builder-owned buffers when clearer);
extend previous named regression files for discoveries. No general oracle corpus.

**Interfaces:** Uses only Document.AddPostScript for public integration, and
existing content parsing/render/text/font fixture helpers for inspection.

**Step 1.** Add named saved/reopened tests with literal expectations: integer
box [-10,20,90,70] -> MediaBox [0,0,100,50]; HiRes box [-9.5,20.25,89.75,69.5]
-> [0,0,99.25,49.25]. Place a source path/text baseline/image corner at each
nonzero box origin and assert device zero exactly within floating tolerance.
Use a mixed text/image/form/pattern EPS to pin one normalization across nesting;
inspect emitted matrices/paths and actual reopened pixels at known inside/outside
coordinates. Use existing image decoders/helpers to inspect pixels, not
`ToImage().length` as a rendering assertion. initgraphics/initmatrix/initclip
must preserve crop, marks outside it must not appear. Repeat systemdict showpage
between separated marks; ensure both stay on the sole EPS page.

Vendor small original ASCII/EPSI and DOS TIFF/WMF wrappers distinctly from any
third-party producer output. PROVENANCE states who authored bytes, what counts
were hand-derived, and that the preview is skipped rather than interpreted.
Run a raw currentfile binary image through a wrapped EPS and compare exact decoded
samples; verify neither framing nor DSC scan shifted a byte. Include an encrypted
font source inside properly declared resource/counted regions and extract its
known glyph to cover the opaque-body boundary. Add failures discovered here as
RED/GREEN tests beside their owning module.

**Step 2.** Run `npx vitest run test/eps-integration.test.ts` and observe RED
for any remaining gaps. For fixtures green immediately, temporarily mutate
normalization sign/duplicate application, bbox precedence, preview selection or
showpage policy; each intended witness must redden, then restore.

**Step 3.** Resolve witnessed gaps only. Generate a fresh mixed-font EPS import
PDF through the public API and run installed qpdf --check, recording its version
and outcome in Beads. Use temporary scripts in the plan's scratch location; do
not add a runtime external converter. Distinguish literal expectations, this
library's own renderer and structural qpdf evidence.

**Step 4.** Run `npx vitest run test/ps test/eps type1 sfnt std14 fontwork limits-fonts test/import-cycles.test.ts test/limits-catch.test.ts test/readme-api.test.ts`,
`npm run typecheck` and `git diff --check`; expect GREEN. Obtain the chosen
workflow's independent whole-branch review. Re-grade findings against the approved
spec, fix material findings in one RED/GREEN pass, and record rulings in Beads.
No plan-review subagent is dispatched during writing-plans self-review.

**Step 5.** Run full `npm run typecheck` and `npm test` on the final branch.
Integrate into main under the authorized repository workflow; rerun both gates
on merged main before bd close lw8w.4. Commit generated Beads bookkeeping,
pull/rebase safely preserving user edits, push main and bd dolt push, delete
merged feature branches locally/remotely, and verify upstream equality. Leave
unrelated user _my files untouched. File any genuine remaining work in Beads.

## Self-review record

Before committing, map every approved spec section to T1-T6, cross-check all
signatures/callers including tests, and ensure each Review Focus item has its
named owner and witness. Verify the plan resolves DSC lexical/region/count
states, no-op showpage versus capture restrictions, shared budgets and atomic
publication. Record the self-review outcome and any ruling in lw8w.4. This
paragraph is an instruction, not a Markdown progress ledger.
