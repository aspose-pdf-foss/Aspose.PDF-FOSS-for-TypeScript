# PostScript text

Issue `aspose-pdf-foss-for-ts-lw8w.3`. Design approved by the user on
2026-11-18.

## Intent and scope

Complete the text foundation of the PostScript/EPS import epic: execute font
selection and text operators against the existing bounded VM and graphics job,
then save their output as PDF text and reusable glyph resources. The issue names
Standard faces, Type 1 and Type 42 programs, and composite fonts. The pinned .NET
inventory additionally requires procedure-built Type 3 glyphs and text callbacks.

All entry points remain internal. A public PS/EPS import API and EPS framing are
left to `lw8w.4`; the broad producer/oracle corpus remains `lw8w.5`. This issue
does include small original source fixtures, source-defined fonts, real font
program witnesses with provenance, saved/reopened PDF tests and hostile inputs.

The .NET implementation at `10a36383` supplies the inventory. Adobe's language
and font specifications govern semantics. Do not reproduce stub operators,
silent missing text, horizontal-only arithmetic for transformed glyphs, guessed
encoding fallbacks, or converter-specific outline offsets.

## Approaches

The approved approach retains native PDF Type 1 text for Standard-14 faces and
builds PDF Type 3 glyph resources for Type 1/42 outlines and procedure-built
glyphs. Existing parsers provide outlines; existing graphics captures provide
glyph painting and nested resources. Text remains text where Unicode mapping is
known. Type 3 output loses original font hinting, as the existing outline
conversion does; the library's renderer does not implement those hints.

Native embedding for every program font preserves more font information but
would require reconstructing complete font programs from live PostScript
dictionaries, or separate emitters for supplied files and source-defined fonts.
Outlining all text directly into page paths simplifies output but discards text
extraction and repeats glyph geometry. Neither is proposed for this issue.

The user approved these proposals on 2026-11-18.

## Integration and ownership

Add optional `installPsText(vm, graphics, options)` returning a text/font session.
Require the graphics session to belong to the same VM and reject duplicate or
late installation before mutation. Language-only and graphics-only sessions keep
their existing installation contracts. No public index exports are added.

Host font inputs are explicit names and supplied bytes, supporting PFA/PFB Type 1
and TrueType sfnt bytes. The host can register such inputs before execution;
source can also execute ordinary font definitions and call `definefont`.
No source operator opens a path, scans machine fonts or accesses the network.
Exact internal option/type names are left to the implementation plan.

Module responsibilities:

- `psfont.ts`: font registration, protected identity, dictionaries, derivation,
  encoding resources and supplied-face resolution.
- `psfontprogram.ts`: Type 1 dictionary/byte adapters, Type 42 assembly, outline
  metrics and bounded use of existing font engines.
- `pstext.ts`: character iteration, positioning, show variants, measurement and
  text/glyph invocation scopes.
- `psglyph.ts`: procedure-built glyph contexts, metric declarations and capture.
- `pscomposite.ts`: bounded Type 0 character mapping and descendant selection.
- `pspdf.ts`: PDF text blocks and reusable font/glyph resource ownership.

Smaller splits can change in the plan. Keep PDF types out of language/value/
memory modules. Any additions to existing parser interfaces are optional for
ordinary PDF callers and preserve their current damage-recovery contracts.

## Fonts, dictionaries and VM

Install `FontDirectory`, `GlobalFontDirectory`, `StandardEncoding` and
`ISOLatin1Encoding`, together with the standard Symbol/Dingbats vectors needed
by their builtin faces. Standard-14 means the exact fourteen PDF face names;
aliases exist only through explicit host registration or source definitions.
The initial font is Courier at 12 user units, a deterministic device
policy. Missing requested faces raise `invalidfont`; no silent painting omission
or automatic substitute is proposed. Unknown encoding resources raise
`undefinedresource`.

`definefont` validates supported dictionary shapes, creates an opaque, unforgeable
font identity, marks the font dictionary readonly, registers it and returns it.
The visible FID has `fonttype`; fonts themselves remain dictionaries. Derivation
copies dictionaries and composes the declared FontMatrix rather than storing a
source-forgeable private scale/face name. Re-encoding by copying all entries
except FID and defining the result must work. A missing glyph selects `.notdef`.

Font registries obey local/global allocation and lookup, including the global
FontDirectory view under `setglobal`. Registry mutation has a narrow host-only
boundary for the VM-owned dictionaries and uses normal save journaling. Optional
standard-value installation is guarded against execution/open saves, meters its
allocations, and does not reopen systemdict to source writes or invoke bootstrap.
The plan must spell out the binding mechanism and its global-reference rules.

Font references belong to `PsState`, its copy/root walkers and independently
stored gstates. Save/restore validation includes font dictionaries, descriptors,
FID and callback roots before changing memory or graphics state. Registry entries
and local identities created after a save disappear on restore. Emitted PDF
resources are detached immutable data and remain valid after VM restoration.
Caches test body validity and compiled identity; source keys cannot forge them.

The compiler snapshots font-defining program data at successful definition.
Supported modifications happen by deriving/redefining fonts; mutable executable
Type 3 procedures still observe their ordinary VM/dictionary effects each time
they execute. Trusted font machinery can inspect protected Private/CharStrings
data without granting source access to it. Font selection survives initgraphics,
showpage and ordinary device transitions; graphics/VM restore restores the saved
font. The pre-existing broader initgraphics preservation defect is tracked
separately in `k421`.

## Supported inventory and explicit boundaries

Implement source-driven semantics for:

- `findfont`, `definefont`, `undefinefont`, `scalefont`, `makefont`, `setfont`,
  `currentfont`, `rootfont`, `selectfont`, `findencoding`.
- `show`, `ashow`, `widthshow`, `awidthshow`, `kshow`, `cshow`, `xshow`, `yshow`,
  `xyshow`, `glyphshow`, `stringwidth`, `charpath`, `eocharpath`.
- `setcharwidth`, `setcachedevice`, `setcachedevice2` within glyph contexts.
- `eexec` for supplied encrypted source, plus the Font/Encoding portions of
  `findresource`, `defineresource`, `undefineresource`, `resourcestatus` and
  `resourceforall` needed by font prologs. Enumeration is bounded and uses the
  same VM callbacks as other iteration.

`composefont` is an explicit unsupported boundary, not the .NET empty-dictionary
stub. CID-keyed/CMap fonts, vertical writing mode, FMapTypes other than 2/3,
Multiple Master fonts, arbitrary Type 1 OtherSubrs, incremental GlyphDirectory
fonts, procedure overrides in Type 1/42 CharStrings, and proprietary font types
raise `UnsupportedFeatureError` when requested. Standard Type 1 flex/OtherSubrs
are supported. Hinting is ignored. Font-cache tuning operators can be explicit
unsupported boundaries; cache hints do not promise a bitmap cache. Every pinned
inventory entry must be mapped to tests or an explicit boundary in the plan.

## Programs and encrypted source

Reuse Type 1 charstring decoding, StandardEncoding names, bundled Standard-14
outlines, sfnt parsing and TrueType contour conversion. Source-defined Type 1
fonts supply Private/Subrs/CharStrings/lenIV directly; support both encrypted
charstrings and lenIV -1. Preserve sidebearings, two-dimensional advances, seac
and standard flex behavior. Unsupported charstring mechanisms must not silently
produce an apparently successful empty glyph.

PFA source runs normally through the VM. PFB framing is removed by a bounded
host-input adapter, retaining segment boundaries needed to identify binary
encrypted data. `eexec` uses incremental binary/hex decryption over the supplied
reader. Its scanner and explicit currentfile reads share the decrypted cursor;
closing the decrypted file resumes the underlying source at the actual consumed
position. It must not decrypt the remaining clear-text trailer in advance.
PsScanner currently assumes a complete Uint8Array, as does SourceReader. Extend
their internal input contract with bounded pull-byte access rather than eagerly
decrypting an entire source. Preserve the existing byte-array path and token
separator/offset contracts. Scanner reads, explicit reads and token inspection
must share that input and its cursor; peeking must not consume trailing clear
source beyond the encrypted stream's actual termination. Nested supported reader
operations must retain this property. The plan owns the exact input interface.
The implicit systemdict scope is installed/unwound on the same pump, including
normal completion, closefile, stop, exit, quit and terminal failures.

Type 42 consumes sfnts strings with the format's per-chunk padding rules. Validate
offsets and reconstructed length before parsing; resolve encoding name through
CharStrings to the specified TrueType GID, never through a guessed Unicode cmap.
TrueType font-unit metrics/outlines are normalized into Type 42 glyph space before
applying its FontMatrix, which normally is identity, unlike Type 1's .001 scale.
Basic FontMatrix, FontBBox, Encoding, PaintType 0/2 and StrokeWidth are supported;
Metrics overrides are supported in writing mode 0. Other metric mechanisms such
as CDevProc must be rejected explicitly rather than ignored.

## Text placement and callbacks

Use complete affine matrices and x/y width vectors. Glyph outline, glyph origin,
natural advance and additional user-space displacement are separate quantities.
CTM changes preserve the already constructed device-space current path.
Showing moves the current point while retaining prior path segments. Charpath
appends glyph outlines to that path and leaves the final current point at the
text endpoint; the stroke flag and PaintType affect which outline is appended.
eocharpath uses the same path construction and does not paint by itself.

`ashow`/`widthshow`/`awidthshow` add their specified displacements. The x/y/xyshow
variants replace natural advances with supplied displacements and retain the final
advanced current point. Accept arrays and Adobe encoded number strings, validate
available counts and access, and reject short/malformed data with named faults.
Do not copy .NET's reset-to-start behavior. `glyphshow` can select an unencoded
glyph without mutating the font's Encoding array.

`kshow` executes its procedure between adjacent characters with both codes.
`cshow` maps characters and invokes its procedure with code and user-space width
vector; it does not paint or advance on its own, and restores temporary font
selection afterward. `stringwidth` does not require a current point or publish
marks. Composite show, measurement and callbacks share the same decoder.

All text iteration uses private work frames, not language loop frames. Callbacks
run via `invoke`; resource errors pass through language handlers. A returning
custom handler resumes the callback. Escaping control transfers discard the
unfinished glyph/measurement/text continuation and restore exactly its scopes,
while retaining earlier completed painting and ordinary VM side effects.

## Procedure-built and composite fonts

Type 3 prefers BuildGlyph over BuildChar, supplies the font and name/code with
the documented operand shape, and runs under an isolated transformed glyph
graphics state and resource owner. The implicit restore boundary is the glyph's
own initial state, not its caller's state. Nested glyphs keep independent metrics,
root/current fonts and continuation roots. Type 3 callbacks are executed on every
request in this implementation; no bitmap-cache elision of callback effects is
required.

setcharwidth permits colored glyph output. Cache-device declarations establish
checked metrics/bounds and their uncolored restrictions before marking; output
before such a required declaration is rejected rather than retrospectively
accepted. setcachedevice2 accepts and validates both metric sets but only writing
mode 0 is selected in this issue. Declare metrics only within an active glyph
context. Publish completed glyph resources only. Measurement uses the same glyph
machinery under a nonpublishing device; source dictionary effects remain visible.
Charpath of a procedure glyph collects path painting as outline data. Image and
mask portions contribute no outline, as Adobe specifies; test a mixed path/image
glyph so this omission cannot suppress its path portion. Truly unsupported
graphics mechanisms still fail through their existing explicit boundaries.

Composite FontType 0 supports FMapType 2 (8/8) and 3 (escape), including validated
Encoding selectors, EscChar, nested supported descendants, rootfont and effective
matrix composition. Follow Adobe's modal/nonmodal nesting and reset rules, not
a flat byte-to-descendant approximation. Cycle checks and both the language's
composite-depth bound and the configured nesting bound apply. Truncated codes,
invalid selectors and unsupported mappings produce their specified errors.
Only horizontal writing mode is selected, though transformations and explicit
glyph width vectors may advance in either user-space direction.

## PDF resources and failure atomicity

Extend PsPdfWriter with bounded text painting that uses the same clips, color,
overprint/stroke adjustment and basis rebasing as vector painting. Colored and
uncolored captures retain their restrictions. Standard-14 resources carry exact
code-to-name encodings and metrics. Program/procedure fonts use Type 3 CharProcs
with correct FontMatrix, widths, BBox, Resources and d0/d1 behavior.

Resources and glyph streams are reused across pages and nested captures when
semantically identical. Mutable VM dictionaries never become PDF dictionaries
by reference. Re-encoded or differently defined fonts get distinct resources.
Known glyph names get ToUnicode entries; unknown names do not receive invented
characters. Dynamic procedure output cannot reuse stale captures. A failed glyph
does not publish its incomplete stream or text block; earlier completed glyphs
and pages survive. Type 3 bank construction handles more than 256 named glyphs
and unencoded glyphshow without collisions or overwriting earlier meanings.

## Accounting and verification

All work shares the interpreter's cumulative PsBudget, graphics DecodeBudget and
output counters. Charge before allocating font snapshots, decrypted bytes,
tables, outlines, contours, glyph code banks, strings, callback frames and PDF
resources. Enforce source/object, container, nesting, content-byte/token, decoded
byte/ratio and glyph-operation limits alongside PS VM/work limits. Loading or
restoring fonts does not refund totals. Cache hits cannot bypass per-job charges.

Existing font engines need an accounting audit: per-glyph maxGlyphOperations
alone does not bound cumulative PS work or allocation. Introduce optional metered
hooks or bounded adapters before their untrusted parse/decode loops and growth,
not a charge after an outline has already been built. Retain ordinary PDF caller
behavior and all ResourceLimitError propagation. No catch violates rethrowLimit.

TDD must include literal Standard-14 widths/re-encodings, skew/rotation and
nonzero y advances, width overrides, charpath control points, all show variants,
encoded displacements, source-defined Type 1 and padded multi-chunk Type 42,
real supplied font witnesses, both Type 3 builders, metrics declarations, nested
callbacks, save/restore/global/access checks and FMapType 2/3 nesting. Exercise
fonts in forms/patterns and reused across page changes and VM restoration.

Hostile tests must cover repeated measurement, enormous font dictionaries and
sfnts inputs, tiny/empty glyph callbacks, composite cycles, recursive glyphs,
charstring/subroutine explosions, large contour sets, output/resource-only growth,
failed definition/capture cleanup and continued execution after an escape. Assert
specific ResourceLimitError fields and small exact boundaries before large growth.

Save/reopen output and check text extraction, glyph advances, outlines and rendered
samples. Record which observations use this library's renderer, literal reference
values, qpdf structure checks or an actually executed independent interpreter.
qpdf is available; Ghostscript was not found on PATH during design. No independent
visual oracle is claimed. Existing licensed font fixtures should be reused where
possible, with new derived wrappers and their provenance identified separately.

After design approval, write a task plan and run focused TDD/typecheck per task,
one whole-branch review under native execution if selected, both full gates,
integration and both gates on main before closing. Push code and sync Beads.
Update architecture/policy docs; add a changelog entry only for a public-facing
behavior change. Implementation follows review of the implementation plan.

## References

- [Pinned .NET font operator inventory](https://github.com/aspose-pdf-foss/Aspose.PDF-FOSS-for-.NET/blob/10a36383/src/Converters/PsToPdf/PsOperators.Fonts.cs), plus PsBuiltGlyphs/PsCompositeFonts/PsFontProgram.
- [Adobe PostScript Language Reference, third edition](https://www.adobe.com/jp/print/postscript/pdfs/PLRM.pdf), font chapter and operator entries.
- [Adobe Type 1 Font Format](https://adobe-type-tools.github.io/font-tech-notes/pdfs/T1_SPEC.pdf).
- [Adobe Type 42 Font Format, technical note 5012](https://adobe-type-tools.github.io/font-tech-notes/pdfs/5012.Type42_Spec.pdf).
- [Approved graphics design](2026-11-18-postscript-graphics-design.md).
