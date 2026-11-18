# PostScript graphics operators

Issue `aspose-pdf-foss-for-ts-lw8w.2`. Design approved by the user on
2026-11-18.

## Intent

Extend the bounded internal PostScript interpreter so programs can produce PDF
vector content, images, forms and tiling patterns. This supplies the graphics
foundation for the PostScript/EPS import epic and its text and EPS children.
The pinned .NET converter supplies the parity inventory. Adobe's language
reference governs operator semantics and error behavior.

The deliverable includes source-driven execution through `PsInterpreter`, PDF
page/resource descriptors, an internal adapter that installs those descriptors
in a `Document`, and integration tests that save and reopen the resulting PDF.
The language-only interpreter remains usable independently of a graphics device.

## Existing constraints

`psvm.ts` provides iterative scheduling, typed operand access, operator undo,
named errors, persistent dictionaries and cumulative `PsBudget` accounting.
`currentScanner` exposes the source cursor. VM saves currently restore memory
and packing mode. Graphics must participate in this same save/restore boundary.

Use TypeScript NodeNext with `.js` import specifiers and zero runtime
dependencies. All new entry points remain internal to `src/`. Fonts and text
operators are owned by `lw8w.3`, EPS framing and bounding-box sizing by
`lw8w.4`, and the larger rendered-page fixture corpus by `lw8w.5`.

## Approaches

The proposed approach is a PostScript graphics model with a PDF emitter.
It retains paths, clipping and graphics state with PostScript semantics and
reuses the existing affine, PDF object and image/resource helpers where their
contracts fit. The emitter produces vector paths and reusable PDF resources.
This choice follows the internal extension boundary approved for `lw8w.1`.

Adapting `VectorGraphics` directly would require adding PostScript path
inspection, path restoration, virtual-memory ownership and continuation
scheduling to the public authoring builder. A raster device would introduce
resolution-dependent output and discard reusable vector resources. Those
approaches carry additional integration costs for this epic.

The module split, A4 fallback size and internal installation API below are
proposals made by the agent for this design.

## Integration and module boundaries

Provide `installPsGraphics(vm, options)` returning a graphics session. Options
include an initial page box and default matrix. The proposed fallback is
`[0, 0, 595, 842]` points with an identity default matrix, matching the pinned
converter. The host can supply a different box/matrix for future EPS framing.
An installation owns one job and shares the interpreter's policy and budgets.

- `psgraphics.ts` owns graphics state, path/clip state, graphics-stack entries,
  page lifecycle and the operator installation boundary.
- `psmatrix.ts` and `pspath.ts` own validated matrix operands and bounded path
  construction, inspection, arcs, flattening, reversal and stroke outlines.
- `psclip.ts` owns clipping-region materialization for `clippath`.
- `pscolor.ts` owns supported color-space descriptions, components, conversions,
  and bounded execution of tint procedures.
- `psimage.ts` and `pssource.ts` own image requests and supplied-byte readers.
- `pspaint.ts` owns form/pattern execution and captures using the VM pump.
- `pspdf.ts` owns PDF content/resource descriptors and the `Document` adapter.

Exact filenames and smaller helper splits may be settled in the implementation
plan. Dependency direction keeps the language VM independent of `Document`.
Reuse `text.ts` affine helpers with their existing row-vector convention,
`types.ts` PDF objects, resource helpers and compatible image builders.
Existing render geometry can be reused after accounting and tolerance audits.

Add the minimal VM support for continuation completion/unwinding, extension
roots, and save/restore participation. Continuations execute on the existing
pump. A cancellation or control transfer that leaves a capture scope unwinds
that scope deterministically.
Source procedures, image producers, tint transforms and paint callbacks never
start a nested interpreter or a second `run` pump.

## Operator inventory

Implement these groups with Adobe operand validation and named faults.

- State and matrices. `gsave`, `grestore`, `grestoreall`, `initgraphics`,
  `gstate`, `currentgstate`, `setgstate`, `copy` for gstate objects, `matrix`,
  `initmatrix`, `identmatrix`, `defaultmatrix`, `currentmatrix`, `setmatrix`,
  `translate`, `scale`, `rotate`, `concat`, `concatmatrix`, `invertmatrix`,
  `transform`, `itransform`, `dtransform`, `idtransform`.
- Paths. `newpath`, `currentpoint`, `moveto`, `lineto`, `rmoveto`, `rlineto`,
  `curveto`, `rcurveto`, `arc`, `arcn`, `arct`, `arcto`, `closepath`,
  `flattenpath`, `reversepath`, `strokepath`, `pathbbox`, `pathforall`,
  `setbbox`, `upath`, `uappend`, `ucache`, `ustrokepath`.
- Clipping and painting. `clip`, `eoclip`, `initclip`, `clippath`, `clipsave`,
  `cliprestore`, `rectclip`, `stroke`, `fill`, `eofill`, `ufill`, `ueofill`,
  `ustroke`, `rectfill`, `rectstroke`, `erasepage`, `showpage`, `copypage`,
  `nulldevice`.
- Line state. `setlinewidth`, `currentlinewidth`, `setlinecap`,
  `currentlinecap`, `setlinejoin`, `currentlinejoin`, `setmiterlimit`,
  `currentmiterlimit`, `setdash`, `currentdash`, `setflat`, `currentflat`,
  `setstrokeadjust`, `currentstrokeadjust`, `setoverprint`, `currentoverprint`.
- Color. `setgray`, `currentgray`, `setrgbcolor`, `currentrgbcolor`,
  `sethsbcolor`, `currenthsbcolor`, `setcmykcolor`, `currentcmykcolor`,
  `setcolorspace`, `currentcolorspace`, `setcolor`, `currentcolor`.
- Images, forms and patterns. `image`, `imagemask`, `colorimage`, `execform`,
  `makepattern`, `setpattern`.
- Supplied-source support. `currentfile`, `read`, `readstring`,
  `readhexstring`, `readline`, `bytesavailable`, `fileposition`, `closefile`,
  and decoding `filter` for the formats specified below.
- Page device. `currentpagedevice` and `setpagedevice` support `PageSize`.

User paths include ordinary operator-array and encoded representations used by
the pinned inventory. Cache hints have defined advisory behavior. Their accepted
syntax is validated even when caching supplies no optimization.

Shading patterns, `shfill`, halftones, arbitrary printer-device policies and
additional PostScript facilities require explicit `UnsupportedFeatureError`
when requested through this installation. The implementation plan must map
every inventory entry to its implementation/tests or this explicit boundary.

## Graphics semantics

Path coordinates are stored in device space when constructed. The state also
retains subpath starts, current point, line parameters, color, clipping,
default/current matrix and the selected device. `gsave` includes the current
path. Path readers transform back through the current matrix and detect
singular inverses. `pathforall` walks a bounded snapshot while its callbacks
can construct another path. All callback control flow uses VM frames.

Clipping intersects the previous region and preserves the current path.
PDF emission can replay clip constraints in order. `clippath` materializes
their intersection using bounded flattening and planar boundary construction
with winding/even-odd membership, including holes, disjoint components,
coincident edges and empty intersections. Geometry tolerance is explicit and
tested. A last-clip or bounding-box substitute is insufficient for this operator.

Fill geometry retains its device coordinates. Strokes preserve the full matrix
at painting time, including nonuniform scale, rotation, shear, dash and pen
shape. Reuse existing stroke geometry only where its approximation contract
fits PostScript, especially hairlines and flatness. The proposed reference
device resolution is 250 dpi for geometry that requires a device pixel, matching
the pinned converter. The plan must document the tolerance and its consequences.

VM `save` records a graphics-stack boundary. A successful `restore` restores
that boundary and discards subsequent graphics saves. Invalid restore validation
finishes before memory or graphics state changes. Independently retained gstate
objects obey local/global allocation, access, copy and save-journal rules.
Extend the value/memory contracts to represent gstate/file objects consistently
with `type`, equality, access queries, global barriers and invalidrestore.

Page completion is explicit. `showpage` emits the current page, including a
deliberately blank page, and resets page graphics state. `copypage` emits a
snapshot while retaining marks for subsequent use. `erasepage` removes marks
on the current page. Finalization includes a trailing page only when it carries
marks and is idempotent. Page-device size changes follow documented validation
and transition rules. Forms and pattern callbacks cannot eject or resize pages.

## Colors, images and captures

Support DeviceGray, DeviceRGB, DeviceCMYK, Indexed, Separation, DeviceN and
Pattern with a supported underlying space. Retain the source space/components
for current-color queries. Preserve device color spaces in PDF resources.
Indexed lookup supports strings and procedures. Tint/lookup procedures run on
the shared VM, with checked result counts and ranges. Unsupported CIE-based or
other spaces fail explicitly. Overprint and stroke adjustment emit PDF graphics
state parameters. Uncolored tiling cells enforce their color restrictions.

Images support legacy stack operands and ImageType 1 dictionaries, 1/2/4/8/12-bit
samples, row padding, Decode, ImageMatrix, interleaved data and separate planes.
Masks retain stencil semantics and polarity. Strings, files and procedures
supply data. Each procedure's returned chunk is copied before another invocation
can overwrite it. Empty-producing procedures consume fuel. EOF and malformed
results follow the language contract, with tests for partial final rows.

File objects refer exclusively to supplied bytes and the live scanner cursor.
`currentfile` reads and scanner execution share one position. Read/filter state
has checked access, EOF and close behavior. Source data resumes at the exact
first byte after an inline encoded stream. Support ASCIIHexDecode,
ASCII85Decode, RunLengthDecode, FlateDecode and LZWDecode, with their supported
decode parameters. Reuse existing codecs behind bounded reader adapters.
Other filter requests fail explicitly. Host filesystem/network/process access
has no installed operator.

Forms validate FormType 1, BBox, Matrix and executable PaintProc. Tiling
patterns validate PatternType 1, PaintType 1/2, TilingType 1/2/3, BBox, signed
nonzero steps, Matrix and PaintProc. `makepattern` binds placement at creation.
Bound metadata cannot be forged through source dictionary keys. Captured
resources remain valid across repeated uses and page transitions, and caches
respect VM invalidation. Captures execute under bounded, isolated graphics
state and their own resource dictionaries. Published output contains completed
captures only. A language fault handled by a custom `errordict` procedure that
returns normally resumes the callback through the existing VM error machinery.
That callback may complete and publish its capture. A `stop`, escaping `exit`,
`quit` or terminal exception that leaves the callback abandons its unfinished
capture and restores its graphics/output scope. Completed earlier painting and
ordinary dictionary/VM side effects retain their language-defined behavior.
Font callbacks can later use the same capture/resource boundary.

## Resource accounting and failure handling

Use the existing policy fields. Every path segment, state snapshot, clip
intersection edge, gstate/file body, emitted byte, resource entry, image buffer
and callback frame is charged before growth through the shared `PsBudget`.
Copy-on-write state is permitted when every subsequent copy is charged.
Accounting is cumulative across pages, captures and repeated `run` calls.

`maxContainerItems` bounds each path, clip/graphics stack, resource collection
and page list. `maxNestingDepth` bounds captures, file/filter chains where
applicable and state nesting. Enforce `maxFilterChain`, `maxImagePixels`,
decoded-stream/total/ratio bounds and `maxContentBytes`/`maxContentTokens` while
producing data. Reuse one decode budget for the entire graphics job. Charge
proportional scanning, subdivision, dashing, intersection and serialization work
to `maxPostScriptOperations`. Native decoder output is capped before allocation.

Each operator validates source-controlled operands and reserves required growth
before committing its state change. Language faults use the existing undo and
errordict machinery. Scope cleanup applies when `stop`, `exit`, `quit`, an
uncaught language fault, an unsupported request or a resource failure leaves
that scope. A returning error handler follows the callback rule above.
ResourceLimitError escapes
every recovery path, and every `src` catch begins with `rethrowLimit`.
An error during PDF installation cannot expose a partially installed page.

## Verification and delivery

Use TDD for behavioral changes, with literal expected matrices, stacks,
coordinates, clipping membership and image samples. Regressions cover
matrix/alias/access cases, path restoration, nested clips, anisotropic strokes,
dash validation, current-color conversion, image-source cursor timing,
callbacks, nested captures, page lifecycle and VM save/restore interactions.

Hostile tests cover path/state/resource growth, intersection/subdivision
explosions, tiny-dash expansion, oversized images, decompression, empty data
procedures, recursive form/pattern/tint calls and output-only growth. Assert
the named ResourceLimitError and exact small boundaries before large growth.

Create small source programs with Adobe-derived expectations and independent
rendered or geometry observations where tools are available. A saved/reopened
PDF is checked through existing path extraction and image/render machinery.
Record fixture provenance and the tool/version used for every independent
oracle. The larger real-producer corpus remains tracked in `lw8w.5`.

Update CLAUDE's module/invariant entries when modules land and public policy
descriptions if their documented scope changes. Log user-visible changes in
CHANGELOG when applicable. Run focused tests and typecheck per implementation
task, obtain whole-branch review, then run both required full quality gates.
Integrate into main and verify its required gates before closing `lw8w.2`.
Push code and sync Beads under the repository workflow.

## References

- [Adobe PostScript Language Reference, third edition](https://www.adobe.com/jp/print/postscript/pdfs/PLRM.pdf), chapters 3–4 and operator entries.
- [.NET parity inventory pinned at 10a36383](https://github.com/aspose-pdf-foss/Aspose.PDF-FOSS-for-.NET/tree/10a36383/src/Converters/PsToPdf), consulted 2026-11-18.
- [Approved PostScript core design](2026-11-17-postscript-core-design.md).
