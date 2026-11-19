# PostScript and EPS public import

Issue `aspose-pdf-foss-for-ts-lw8w.4`. Design approved by the user on
2026-11-18.

## Intent and scope

Expose the completed PostScript language, graphics and text engine through
`Document.AddPostScript(bytes, options)`, appending new PDF pages to an existing
or newly created document. The user chose this entry point on 2026-11-18,
over a factory returning a new document. This matches AddHtml/AddDocx and lets
callers combine imports with existing PDF pages.

The original issue names BoundingBox sizing and binary-preview stripping.
The approved lw8w.3 design also assigns the public PS/EPS import boundary here.
Both are included. Reuse the bounded interpreter and PDF emitter; retain vector
content, images, reusable resources and extractable text wherever the engine
already supports them. Do not render previews instead of executing the program.

The user approved the complete design, including the agent-proposed policies
below, on 2026-11-18. The broader Ghostscript/producer oracle corpus remains
lw8w.5; language compatibility follow-up lw8w.6 remains separate.

## Approaches

The user selected appending imported pages through Document.AddPostScript.
A Document.FromPostScript factory would isolate construction nicely but add a
second creation pattern while making callers merge an intermediate document to
append pages. It is not selected.

Within the selected API, put byte framing and DSC metadata in a separate leaf,
then run the existing VM/graphics/text job and install its completed descriptors.
Extending Document.Open with format detection would mix PDF parsing/recovery
with executing another language; it is not proposed. Rasterizing through an
external converter would lose the engine's vector/text output and violate the
zero-runtime-dependency constraint.

## Public contract

Proposed signature:

```ts
AddPostScript(bytes: Uint8Array, options?: PostScriptOptions): PostScriptResult

interface PostScriptFont { name: string; bytes: Uint8Array }
interface PostScriptOptions {
  format?: 'auto' | 'ps' | 'eps'; // default auto
  pageSize?: PageFormat;         // initial plain-PS device only
  fonts?: readonly PostScriptFont[];
}
interface PostScriptResult { pages: Page[] }
```

The method is synchronous. No async/progress/cancellation interface is promised
by this issue: the existing VM executes one bounded synchronous pump. Adding an
async wrapper without yielding inside that pump would misrepresent its behavior.
An incremental/cooperative VM is future work only if separately requested.

Input is bytes, including Buffer. Strings and file paths are not accepted.
Options are checked before source execution: recognized format, real PageFormat,
nonempty supplied font names, Uint8Array font bytes, and no duplicate supplied
names. Explicit supplied names may replace a builtin face, as the engine already
allows. Fonts are supplied explicitly; no ambient font-folder or system-font
lookup is introduced. Existing interpreter operators cannot read filesystem or
network resources. There is no new Node file helper in this issue.

The job uses the destination's current `doc.loadLimits`; there is no separate
per-call limits patch. A caller importing into a new PDF may set that existing
public property before calling AddPostScript. Validate it is a LoadLimits.
Limits apply per import job, not cumulatively across unrelated method calls.
Each call owns a fresh interpreter and font registry; definitions never leak
between calls. Supplied program storage is copied into job-owned storage, even
for Buffer inputs. Source bytes remain borrowed for the synchronous call and
are not retained by the returned document; emitted stream storage is detached.

Return only the newly appended Page objects in order. Preserve existing pages,
metadata, page geometry, forms and document configuration. Do not infer or copy
DSC Title/Creator metadata in this issue. A failed parse or execution must append
no pages. Resource-limit and unsupported-feature failures are never suppressed.

## Framing and detection

Check maxFileBytes on the complete original input before inspecting or slicing
it, including any preview bytes. Check a DOS EPS magic before ASCII detection.
A recognized binary header always opts into EPS framing; explicit ps format
rejects it rather than executing header/preview bytes.

In auto mode a first PostScript header line declaring EPSF selects EPS; an
ordinary %!PS header selects PS. Other byte programs are accepted as plain PS,
since the language core already accepts headerless source. Explicit eps requires
an EPSF version header in the extracted code; explicit ps rejects an EPSF header
rather than silently overriding its page semantics. Do not search arbitrary
prefix bytes for a header or execute preview/trailing wrapper bytes.

Support DOS EPS's 30-byte C5 D0 D3 C6 header. Read little-endian unsigned offsets
and lengths without signed bitwise overflow. Validate the PostScript span is
nonempty, begins after the header, and fits wholly in the input. Validate any
present WMF/TIFF span similarly; reject overlapping declared sections, partial
zero offset/length pairs, truncated headers and incorrect non-sentinel checksum.
FFFF means no checksum. Preview payloads are opaque; do not decode or allocate
images for them. Extract exactly the declared PostScript span as a view. Bytes
outside it never reach currentfile, scanners, filters or eexec.

Support ordinary ASCII EPS, including EPSI previews stored as comment lines.
Those comments may stay in the source stream; they must not influence sizing.
Macintosh resource-fork/MacBinary/AppleDouble envelopes are not supported here;
recognizable envelopes should raise UnsupportedFeatureError, never pretend the
preview is executable PS. An already extracted Macintosh data fork is ordinary
EPS and can work normally.

## Bounding boxes and DSC metadata

Parse the document's outer BoundingBox in the header, or resolve a header
BoundingBox: (atend) from its outer Trailer. Recognize optional HiResBoundingBox
in the same locations, including an atend declaration. Prefer a valid resolved
high-resolution box for EPS sizing. BoundingBox coordinates follow the integer
DSC grammar; HiResBoundingBox permits finite decimal coordinates. Reject missing,
unresolved, duplicate conflicting, malformed, reversed or zero-area EPS boxes.
A HiResBoundingBox supplements the mandatory BoundingBox; it does not excuse a
missing or invalid required box. A valid high-resolution box must fit inside
the integer box, allowing only a small explicit floating arithmetic tolerance.

Read DSC at physical line starts with CR, LF and CRLF line endings. Do not turn
the whole file into a JavaScript string. Bound each comment/line scratch by
maxObjectBytes, byte work by the shared PsBudget, structural stack growth by
maxNestingDepth/maxContainerItems and retained metadata by maxPostScriptVmBytes.
Ignore irrelevant comments without allocating their entire text.

This is structural metadata scanning, not a regexp over the file. Nested
BeginDocument/EndDocument, BeginFile/EndFile and resource/prolog-contained
metadata cannot replace the outer document box or trailer. Skip counted
BeginBinary blocks and BeginData blocks with byte or line counts exactly,
including their payload's possible fake DSC comments; validate truncation,
counts and nesting. EPSI BeginPreview/EndPreview cannot contribute metadata.
Literal PostScript strings (including nested parentheses and escapes), hex
strings and ASCII85 strings cannot contribute apparent DSC lines either. The
scanner never executes source. Do not rewrite counted data, normalize source
newlines, remove comments or otherwise shift currentfile input.

The implementation plan must resolve the precise DSC scanner states against
Adobe's grammar, including opaque resource bodies; do not grow a second
PostScript evaluator. Structurally ambiguous/broken deferred metadata is a
parse failure, not permission to select a convenient body comment. No DSC page
reordering or DocumentNeededResources resolver is introduced.

For plain PS, document BoundingBox comments do not crop the job: ordinary PS
may contain multiple pages. Only EPS framing selects bounding-box page sizing.
The default plain-PS initial device remains the existing [0,0,595,842] points;
pageSize overrides that initial device, and supported source setpagedevice calls
continue to control subsequent PS device sizes. pageSize with EPS is rejected
as an incompatible option rather than silently ignored.

## EPS device and placement

One EPS import produces exactly one page, including a valid file painting
nothing. Normalize its PDF MediaBox to [0,0,urx-llx,ury-lly], using a default
matrix translating by [-llx,-lly]. For example [-10,20,90,70] yields a 100 by
50 point PDF page; a source mark at [-10,20] lands at [0,0]. Keep units at one
PostScript point per PDF point. Do not scale to A4 or add margins.

The EPS device clips to the declared artwork extent. initgraphics, initmatrix,
defaultmatrix, clippath and initclip must continue to refer to that same host
EPS device; a source reset must not restore an A4 clip or lose normalization.
Text, images, forms and patterns must receive the translation exactly once.

Adobe permits showpage in EPS and places responsibility on the importer to
neutralize it. Implement this as a graphics-device policy, not just a shadowed
userdict name: systemdict /showpage get exec must also be harmless. In EPS,
showpage neither emits/resets a page nor clears marks. Keep erasepage's existing
clear-marks meaning. Reject copypage and page-device changes as unsupported EPS
operations so they cannot create extra pages or override the bounding box.
The plan should place this policy at the graphics entry points, preserving
ordinary PS and glyph/form/pattern capture restrictions. Finishing an EPS job
emits its sole page once, regardless of whether showpage appeared.

Plain PS retains the current lifecycle: explicit blank showpages are pages,
a final marked page without showpage is included once, and an unmarked trailing
page is omitted. A valid PS job producing nothing returns pages: [] without
adding an arbitrary blank page.

## Architecture and errors

Proposed modules, exact smaller splits left to the plan:

- eps.ts: bounded framing, format identification, outer DSC bounding metadata;
  depends on byte/budget/value leaves and never Document or the interpreter pump.
- psimport.ts: one import job, installs graphics and text, runs only the selected
  byte span, finalizes detached page descriptors and returns them to the caller.
- psgraphics.ts: explicit host EPS device/page lifecycle policy.
- document.ts: public validation/entry point and installation of completed pages.
- pspdf.ts: existing completed-resource/page installation adapter, extended only
  where needed to keep a failed AddPostScript from appending partial results.
- index.ts: method-associated public option/font/result type exports.

Keep Document as a type-only dependency of the lower layers. Do not add a new
value-import cycle or expose VM/value/scanner implementation types publicly.

Framing/DSC damage and uncaught PostScript language faults use PdfParseError;
unsupported language/device/envelope features use UnsupportedFeatureError;
caller option mistakes use TypeError; load policy refusals use ResourceLimitError.
Every catch starts with rethrowLimit. Unsupported source never produces an
apparently successful partially imported document.

Execution and output construction complete before destination page mutation.
Prepare potentially failing resource installation work before page publication.
If installation itself can fail after allocating objects, use staged installation
or a narrowly scoped rollback so failure leaves destination page count, object
map and Save output unchanged. Do not serialize/reopen the entire destination
as a transaction, since that would destroy live object identities and signatures.
Successful appending follows the existing Document authoring/signing policy;
this issue does not reinterpret existing signatures or promise to preserve them.

Framing, DSC, VM, glyph parsing, decoded streams and PDF installation share the
same job budget; do not reset operation/allocation totals after preflight. Avoid
allocating directly from untrusted wrapper lengths or declared DSC counts.
Retain the existing cumulative content byte/token counters across all pages.
Where installation creates PDF objects, enforce destination maxObjects against
the actual resulting object count before publication, accounting for existing
objects as well as imported ones. The plan must inspect the existing allocator
and avoid claiming a global authoring-limit redesign.

## Validation and completion

Use TDD with literal independent geometry/byte expectations, plus saved/reopened
PDF integration checks. Cover at least:

- Public appending to empty/existing documents, separate call state, explicit
  supplied fonts, Buffer ownership and public exports/README rows/counts.
- Auto/forced PS/EPS, ordinary and headerless PS, ASCII EPS/EPSI and DOS preview
  wrappers with TIFF and WMF separately; binary/currentfile data untouched.
- Signed/negative coordinates, HiRes preference, deferred trailer bounds,
  CR/LF/CRLF, conflicting/missing/broken boxes and fake metadata inside nested
  documents, strings, previews and counted binary/data blocks.
- Every wrapper range, overlap, checksum/sentinel, unsigned large offset and
  truncation case; bytes outside the declared PS span never executed.
- EPS no/one/repeated/systemdict showpage, valid blank EPS, forbidden device
  changes/copies, source resets, clipping and translated text/image/form output.
- Normal multipage PS and source-controlled page sizing remain unchanged.
- Failure before/after output/resource preparation leaves an existing document
  byte-identical, with original Page handles still live; cover exact small
  operation, allocation, decoded/output and object-count policy limits.

Retain RED evidence for new behavior, and use targeted mutations where fixtures
pass initially to prove they detect wrong offsets, wrong box selection, preview
execution and repeated translation. Run the PS/font regression suite, import
cycle guard, public README/export checks and catch-limit guard. Check a freshly
saved PS/EPS result with installed qpdf. Separate structural agreement from this
library's own render checks; no external visual conformance claim without an
executed independent renderer. The broad oracle corpus stays in lw8w.5.

Update README capabilities/examples/API/scope, CHANGELOG and CLAUDE module and
invariant descriptions when implementation lands. Finish with the independent
whole-branch review and one RED/GREEN fix pass selected by the execution workflow.
Run npm run typecheck and npm test on the feature and merged main; keep lw8w.4
in_progress until merged main passes. Push main, close/sync Beads and clean the
merged branch under the standing repository instructions. No runtime dependencies.

## References

- Adobe, Encapsulated PostScript File Format Specification 3.0, 1 May 1992,
  especially required BoundingBox, importing/showpage and DOS EPS sections:
  https://printtechnologies.org/standards/files/epsf_spec_v3_0.pdf
- Adobe, PostScript Language Document Structuring Conventions Specification
  3.0, 25 September 1992, especially comment placement, atend, nesting,
  BeginBinary and BeginData:
  https://web.mit.edu/PostScript/Adobe/Documents/5001.DSC_Spec.pdf
- Approved local foundation: 2026-11-17-postscript-core-design.md,
  2026-11-18-postscript-graphics-design.md and
  2026-11-18-postscript-text-design.md in this directory.
