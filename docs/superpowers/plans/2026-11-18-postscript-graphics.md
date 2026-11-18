# PostScript Graphics Implementation Plan

Use superpowers:subagent-driven-development or superpowers:executing-plans,
according to the user's execution choice. Track progress and rulings in Beads.
Repository instructions prohibit a Markdown task-progress ledger.

**Goal:** Execute the approved internal PostScript graphics inventory and produce
bounded PDF pages, images, forms and tiling patterns.

**Architecture:** Extend the existing iterative language VM with scope cleanup
and save participants. Keep graphics state and geometry separate from the PDF
emitter, with source readers and callback consumers sharing the VM and budget.
An internal adapter installs completed output into a Document.

**Tech Stack:** TypeScript NodeNext ESM, Node built-ins, vitest, zero runtime deps.

**Spec:** `docs/superpowers/specs/2026-11-18-postscript-graphics-design.md`.

## Global Constraints

All entry points remain internal, with `.js` relative import specifiers.
The language-only interpreter and existing PDF callers retain their contracts.
Use the existing LoadLimits fields and cumulative per-interpreter PsBudget.
Default box is `[0, 0, 595, 842]`, default matrix identity, reference resolution
250 dpi. Geometry flatness is measured in device pixels and converted using
`72 / 250` points per pixel. Resource failures escape all language handlers.
Every catch in src begins with rethrowLimit. Supplied bytes are the only file
sources. Every new module earns its CLAUDE entry in the commit that adds it.
Only one implementation task writes files at a time. Verify each task's focused
tests and typecheck, then review it before the next task begins.

## Review Focus

- A returning error handler resumes its callback, while an escaping transfer
  must unwind exactly the scopes it leaves and preserve the original exception.
- A VM restore validates the prospective retained graphics roots before mutation,
  including stored gstate objects, old pattern dictionaries and source readers.
- An inline decoder consumes its encoded terminator only, leaving following
  PostScript source executable through the same cursor.
- Changing the CTM between path construction and painting must preserve path
  placement and the complete stroke pen transformation.
- Resource ownership and cumulative accounting must survive repeated runs,
  page changes, nested captures, discarded captures and cross-page pattern reuse.

## Files and shared types

Modify `psvm.ts`, `psbudget.ts`, `psvalue.ts`, `psmemory.ts` and `psdata.ts`
only where the following tasks extend their contracts. Keep PDF types out of
the language/value/memory modules.

Create `psstate.ts` for state types and bounded state copying, `psmatrix.ts`
for matrix operands/operators, `pspath.ts` for current paths/operators,
`psclip.ts` for intersection materialization, and `psgraphics.ts` for graphics
installation, state-stack and page-device ownership.

Create `pspdf.ts` for output and Document installation, `pscolor.ts` for color
operators, `pssource.ts` for supplied readers/filters, `psimage.ts` for images,
and `pspaint.ts` for forms/patterns. Smaller private helpers remain in their
owning file unless a coherent shared responsibility requires another module.

Use existing `Matrix` from `text.ts` and type-only `Seg`, `Path`, `StrokeStyle`
from `pagerender.ts`. Define `type PsBox = [number, number, number, number]`
in `psstate.ts`. `PsPathData` contains `segments: Path`,
an optional device-space current/subpath-start point, and optional setbbox
metadata. `PsClip` contains a path snapshot and an evenOdd flag.
`PsColorState` is a discriminated union for the approved spaces, retaining
the source PsValue descriptor/components and prepared paint data.
`PsState` contains CTM/default matrix, path, clip chain, line state, flatness,
stroke adjustment, overprint, color and null-device selection.

`PsPageOutput` contains `box: [number, number, number, number]`,
`content: Uint8Array` and `resources: PdfDict`. Resource streams are direct
objects until the adapter allocates their indirect references. Every consumer
receives the same session/output owner, never a separately constructed budget.

## Task 1 — VM scopes, save participants and budget reservations

**Files.** Modify `src/psvm.ts`, `src/psbudget.ts`, their tests and CLAUDE entries.

**Interfaces.** Preserve execute/scheduleLoop. Add
`invoke(value: PsValue, options: PsInvocation): void`, where options has
`roots: readonly PsValue[]`, `complete: () => void`, and
`unwind: () => void`. Add `addSaveParticipant(participant: PsSaveParticipant)`
before any open save. A participant prepares a save snapshot before memory
save, exposes prospective restore roots for its snapshot and commits restoration
only after memory validation. Its interface is the following.

```ts
interface PsSaveParticipant {
  prepareSave(): PsSaveSnapshot;
}
interface PsSaveSnapshot {
  visitRoots(visit: (value: PsValue) => void): void;
  saved?(): void;
  restore(): void;
}
```

prepareSave performs all copying/accounting without changing participant state.
The optional saved callback activates the prepared graphics-stack boundary only
after memory save succeeds, without allocating or throwing. This Task 2
integration ruling is recorded in Beads with its RED/GREEN regression.
restore is allocation-free and nonthrowing. Root enumeration uses the VM's
metered visitor. Participant snapshots remain attached to their save tokens.

Add readonly `remainingBytes`/`remainingOperations` and
`reserve(bytes: number, operations: number): PsReservation` to PsBudget.
A reservation holds capacity until `commit(actualBytes, actualOperations)` or
`cancel()`. Committed work/bytes are never refunded. Uncommitted capacity is
released exactly once. Validate all counts and keep the trusted fixed-bootstrap
contract. Later native decoders use reservations to cap output before allocation.
PsReservation has `commit(bytes: number, operations: number): void` and
`cancel(): void`. Invalid host counts or double finalization throw RangeError.

**Step 1.** Add failing tests named `returning_handler_completes_invocation`,
`stop_exit_quit_unwind_only_exited_scopes`, `terminal_failure_unwinds_lifo`,
`cleanup_preserves_resource_error` and `restore_preflight_is_atomic`.
Assert complete/unwind counters, their order, retained operand behavior and
the exact original ResourceLimitError identity. Add reservation exact-boundary,
double-finalization and nested-reservation tests.

```ts
const budget = new PsBudget(LoadLimits.defaults.with({
  maxPostScriptVmBytes: 128, maxPostScriptOperations: 32,
}));
const reservation = budget.reserve(64, 8);
expect(budget.remainingBytes).toBe(64);
reservation.commit(16, 2);
expect(budget.remainingBytes).toBe(112);
expect(budget.remainingOperations).toBe(30);
expect(() => reservation.commit(0, 0)).toThrow(RangeError);
```

**Step 2.** Run `npm test -- test/psvm.test.ts test/psbudget.test.ts` and observe RED.

**Step 3.** Implement scope frames and central frame removal with metered roots.
Normal completion removes its boundary before invoking complete. Error recovery
that stays inside the scope retains it. Cleanup is registered before scheduling
the callback. Save failure leaves no participant/memory level installed.

**Step 4.** Run the Task 1 tests, `test/psmemory.test.ts` and typecheck. Require GREEN.

**Step 5.** Commit the VM/budget change and its precise interface contract.

## Task 2 — Graphics state, matrices and current paths

**Files.** Create `src/psstate.ts`, `src/psmatrix.ts`, `src/pspath.ts`,
`src/psgraphics.ts`, `test/psmatrix.test.ts`, `test/pspath.test.ts` and
`test/psgraphics.test.ts`. Extend value/memory/data types and tests for gstate.
Create `test/helpers/ps-graphics.ts` with `runGraphics(source: string,
limits?: LoadLimits): { vm: PsInterpreter; graphics: PsGraphics }` for source
tests throughout the remaining tasks.

**Interfaces.** Produce `installPsGraphics(vm: PsInterpreter,
options?: { box?: PsBox; defaultMatrix?: Matrix }): PsGraphics`.
`PsGraphics` exposes readonly `state: PsState`, `budget: PsBudget`,
`defaultBox: PsBox`, `saveState(): void`, `restoreState(): void`,
`restoreAll(): void`, `replacePath(path: PsPathData): void`, and
`withPaintScope(complete: () => void, unwind: () => void): PsInvocation`.
The initial installer registers only the implemented groups as each lands.

Produce `installPsMatrix(vm, graphics): void` and
`installPsPath(vm, graphics): void`. Add typed PsGState/PsGStateBody containing
PsState through a type-only import. PsMemory provides checked
`gstate(state: PsState): PsGState`, `readGState(value): PsState`,
`writeGState(value, state): void`. State snapshots, journal entries and retained
references are charged and checked. Access helpers distinguish state objects
from indexable composites, with explicit narrowing in existing get/put/copy.
`copyPsState(state: PsState, budget: PsBudget): PsState` and
`visitPsStateRoots(state, visit): void` are the shared bounded state operations.

**Step 1.** Write failing source-driven tests for all state/matrix and basic
path operators in the spec, including gstate copy/access/global barriers.
Assert `[1 0 0 1 10 20]` after `10 20 translate matrix currentmatrix`, and
the user current point `[0, 0]` after `10 20 moveto 10 20 translate currentpoint`.
Check matrix aliasing, six-element access, real outputs, singular inverse
undefinedresult, relative paths, closepath current point and arc tangents.
Pin pathbbox/setbbox to Adobe rules, including curves and rotated CTMs.
Assert nested save/grestore/restore restores the path and clips atomically.

```ts
const { vm } = runGraphics('10 20 moveto 10 20 translate currentpoint');
expect(vm.stack).toMatchObject([
  { kind: 'real', value: 0 }, { kind: 'real', value: 0 },
]);
```

**Step 2.** Run the three new tests and existing memory/data tests and observe RED.

**Step 3.** Implement typed states, gstate objects and the operator groups.
Store geometry in device space. Bound segment growth and iterative arc
subdivision. Register the graphics save participant using Task 1's contract.
Preserve the existing constructor-only bootstrap boundary. Graphics installation
and subsequent source-controlled work consume ordinary accounting.

**Step 4.** Run focused state/matrix/path/value/memory/data tests and typecheck.
Require GREEN and verify the language-only interpreter still omits graphics.

**Step 5.** Commit the independently usable graphics-state/path foundation.

## Task 3 — Clipping, path transformations and user paths

**Files.** Create `src/psclip.ts`, `test/psclip.test.ts` and
`test/psuserpath.test.ts`. Extend pspath/psstate/psgraphics and relevant tests.
Modify `src/strokegeom.ts` only for compatible bounded geometry reuse.

**Interfaces.** Produce `materializePsClip(clips: readonly PsClip[],
box: PsBox, flatness: number, budget: PsBudget): PsPathData`.
Add bounded snapshot/flatten/reverse/stroke-outline helpers in pspath.
An optional geometry-accounting argument added to existing stroke helpers must
preserve the default behavior of all existing renderer callers.

**Step 1.** Write failing tests for clip/eoclip/initclip/clippath,
clipsave/cliprestore, rectclip, flattenpath, reversepath, strokepath,
pathforall, upath/uappend/ucache and ustrokepath. Assert intersection membership
for two overlapping rectangles, disjoint regions, even-odd holes, self-crossing
paths and coincident/opposite edges. Check empty intersections and curved clips
within the documented flattening tolerance. Assert path preservation after clip.
Use ordinary and encoded user paths with malformed opcode/count cases.
Check pathforall snapshot mutation, current-CTM coordinates and exit behavior.
Pin anisotropic stroke/dash geometry and tiny-dash work exhaustion.

```ts
const { vm } = runGraphics(
  '0 0 10 10 rectclip 5 0 10 10 rectclip clippath pathbbox',
);
expect(vm.stack).toMatchObject([
  { value: 5 }, { value: 0 }, { value: 10 }, { value: 10 },
]);
```

**Step 2.** Run new clipping/userpath tests plus pspath tests and observe RED.

**Step 3.** Materialize clipping by flattening bounded inputs, splitting edges
at intersections, classifying each side under every input fill rule and linking
oriented boundary edges. Meter pair comparisons, intersections and output growth.
Handle edge coincidences before constructing contours. Preserve exact curve
constraints for PDF replay and use materialization only where a path is required.
Reuse shared stroke algorithms only after auditing hairlines and subdivision.

**Step 4.** Run new geometry tests, existing stroke/raster/SVG geometry tests
affected by helper changes, and typecheck. Require GREEN.

**Step 5.** Commit clipping and the completed geometry/operator inventory.

## Task 4 — PDF output, page lifecycle and device parameters

**Files.** Create `src/pspdf.ts`, `test/pspdf.test.ts`,
`test/pspages.test.ts`, and extend the Task 2 test harness.
Extend psgraphics and its tests.

**Interfaces.** Produce `PsPdfWriter(budget: PsBudget, box: PsBox)` with
`emit(operator: string, operands?: readonly PdfObject[]): void`,
`resource(category: string, object: PdfObject): string`,
`finish(): PsPageOutput`, and `hasMarks: boolean`. The writer charges operands,
content tokens, bytes and resources before serialization/growth.
Add `paint(mode: 'fill' | 'eofill' | 'stroke'): void`,
`showPage(copy?: boolean): void`, `erasePage(): void`,
`finish(): readonly PsPageOutput[]` and readonly `writer: PsPdfWriter` to
PsGraphics. `appendPsPages(doc: Document, pages: readonly PsPageOutput[]): Page[]`
is the sole Document installation boundary.

**Step 1.** Write failing end-to-end tests for stroke/fill/eofill,
rectfill/rectstroke and user-path paints. Save/reopen a PDF, then assert path
coordinates and clipping. Use a path constructed before a changed shear/scale
and inspect full stroke matrix/style output. Test blank showpage, repeated
copypage, erasepage, trailing marked-page finalization, repeated finish and
repeated VM run. Validate PageSize/currentpagedevice and nulldevice restoration.
Assert a failed append exposes no partially installed page.

```ts
const { graphics } = runGraphics('showpage showpage');
expect(graphics.finish()).toHaveLength(2);
expect(graphics.finish()).toHaveLength(2);
```

**Step 2.** Run the new PDF/page tests and observe RED.

**Step 3.** Implement state-isolated PDF painting blocks and bounded writer
serialization, retaining native device colors for later color integration.
PageSize accepts a readable two-number array with positive finite dimensions.
An equal size preserves marks. A changed size publishes the current page if
marked, then begins a blank page with box `[0, 0, width, height]` and reset
graphics state under the host's default matrix. A blank old page is discarded.
Reject unsupported page-device parameters explicitly. Prepare all page/resource
data before publishing page-tree entries.

**Step 4.** Run PDF/page/path tests and typecheck. Validate generated fixture
structure using available qpdf, recording its version if output is committed.

**Step 5.** Commit working vector page output and installation.

## Task 5 — Color spaces and graphics state parameters

**Files.** Create `src/pscolor.ts`, `test/pscolor.test.ts`. Extend psstate,
psgraphics/pspdf and integration tests.

**Interfaces.** Produce `installPsColor(vm: PsInterpreter, graphics: PsGraphics):
void`, `parsePsColorSpace(vm: PsInterpreter, descriptor: PsValue): PsColorState`
and `preparePsColor(vm: PsInterpreter, space: PsColorState,
components: readonly number[], complete: (color: PsColorState) => void): void`.
The latter schedules procedure work using Task 1, and validated state commits
only on completion.
PDF emission consumes PsColorState through a single writer paint-state method.

**Step 1.** Write failing tests for all line/color query/setter operators in
the spec. Assert exact device component retention and conversion, HSB wrap and
clamping rules, invalid line styles, all-zero dash faults and dash array aliasing.
Test Indexed string/procedure lookup, nonlinear Separation/DeviceN transforms,
wrong callback results, returning error handlers and stopped escape.
Assert native PDF device colors and OP/op/SA graphics-state parameters survive
save/reopen. Check CIE/shading requests throw UnsupportedFeatureError.

```ts
const { vm } = runGraphics('0.2 0.3 0.4 0.5 setcmykcolor currentcolor');
expect(vm.stack).toMatchObject([
  { value: 0.2 }, { value: 0.3 }, { value: 0.4 }, { value: 0.5 },
]);
```

**Step 2.** Run color/PDF/graphics tests and observe RED.

**Step 3.** Implement supported color descriptors and callbacks. Preserve
source descriptors/components for currentcolor/currentcolorspace, separate from
emitted alternate paint. Default construction/selection initializes components
per language rules. Keep color state roots reachable through gstate/save/capture
validation. Use existing affine/resources/conversion helpers where compatible.

**Step 4.** Run color/PDF/graphics/VM tests and typecheck. Require GREEN.

**Step 5.** Commit supported color and line-state inventory.

## Task 6 — Supplied file objects and bounded decoding filters

**Files.** Create `src/pssource.ts`, `test/pssource.test.ts`,
`test/psfilter.test.ts`. Extend psvm/psvalue/psmemory/psdata and file-object tests.
Modify existing decoder helpers only to expose consumed encoded length or
bounded output without duplicating codec implementations.

**Interfaces.** Define `PsReader` with `position: number`, `closed: boolean`,
`readByte(): number | undefined`, and `available(): number`.
Add PsFile/PsFileBody with checked reader ownership/access and memory identity.
Produce `installPsSource(vm: PsInterpreter, decode: DecodeBudget): void`,
`currentPsFile(vm): PsFile`, and
`decodePsSource(vm, source: PsFile | PsString, filter: string,
parameters: PsDictionary | undefined, decode: DecodeBudget): PsFile`.
The session creates exactly one DecodeBudget and passes it to every decoder.
Source frames establish file/reader identity when opened, before executing
source. An executable string still reports the enclosing executable input file
through currentfile. File execution and the file overload of token use the same
source scheduling/scanner machinery. Local readers opened after a save close
on successful restore, while existing reader positions retain their advancement.
Taking a new currentfile reference to an already open source does not reopen it.
Preserve file-specific language restore semantics when integrating memory roots.

**Step 1.** Write failing tests for every supplied-source operator, file type,
equality, EOF, closed/access/global/save behavior and currentfile identity.
Assert `currentfile read 65 ...` reads the next byte after the scanner's consumed
separator, leaving subsequent source execution at the correct position.
For each supported filter, decode bytes followed immediately by `7 8 add`
and assert payload bytes plus final operand 15. Cover exact terminators,
truncated data, nested filters, LZW EarlyChange and supported predictors.
Test decoded/total/ratio/VM/work exhaustion and reservation cleanup on failure.
Test file execution, token's file overload, and currentfile from an executable
string. Verify a file obtained from an older open source after save survives
restore, while a newly opened local filter closes.

```ts
const { vm } = runGraphics('currentfile read A pop 7 8 add');
expect(vm.stack).toMatchObject([{ value: 65 }, { value: 15 }]);
```

**Step 2.** Run source/filter/value/memory/data tests and observe RED.

**Step 3.** Implement shared scanner readers and checked file operations.
Use existing codecs with prefix consumption metadata. RunLength/LZW terminate
at their encoded end markers. Flate uses bounded native decoding with consumed
input metadata. Codec limits come from DecodeBudget plus reserved PsBudget
capacity, and actual output is committed before language-level copying.
Decode work/reservations and total bytes remain shared across filter chains.
Supported parameters are CloseSource, LZW EarlyChange 0/1, and the existing
Flate/LZW predictor parameters Predictor, Colors, BitsPerComponent and Columns.
Predictors are 1, 2 and 10–15. Validate parameter types/ranges and preserve
CloseSource behavior when a filter is closed or exhausted.
Unknown filters and host-file requests take the approved failure boundary.

**Step 4.** Run new source/filter and affected existing codec tests, core scanner
tests and typecheck. Require GREEN with following-source cursor witnesses.

**Step 5.** Commit file readers and bounded decoding integration.

## Task 7 — Images, masks and procedure data sources

**Files.** Create `src/psimage.ts`, `test/psimage.test.ts` and
`test/psimage-limits.test.ts`. Extend graphics/color/writer integration.

**Interfaces.** Produce `installPsImage(vm: PsInterpreter, graphics: PsGraphics,
decode: DecodeBudget): void`. Add writer `drawImage(image: PdfStream,
matrix: Matrix, state: PsState): void` for ordinary/stencil images.
All data producers use Task 1 scopes and Task 6 readers on the existing pump.

**Step 1.** Write failing tests for stack/dictionary image forms, 1/2/4/8/12-bit
samples, padded rows, separate planes, Decode, image matrix direction and mask
polarity. Use a 2x1 DeviceRGB source with literal red/green expected pixels,
plus widths that force row padding and 12-bit values spanning bytes.
Test a scratch string overwritten on every producer call, empty producer loops,
invalid returned types, early EOF, partial last rows and image sources consuming
inline bytes followed by ordinary source. Assert declared pixels fail before
buffer allocation and stopped cannot catch resource exhaustion.

```ts
const { graphics } = runGraphics(
  '2 1 8 [2 0 0 -1 0 1] <ff000000ff00> false 3 colorimage showpage',
);
expect(graphics.finish()).toHaveLength(1);
// Reopen and sample the image, asserting red then green as specified above.
```

**Step 2.** Run image/source/color/PDF tests and observe RED.

**Step 3.** Validate requests before scheduling producers, copy returned chunks
before another call, and preserve language EOF semantics. Preserve raw device
samples and Decode when PDF supports the source form. Convert lookup/tint
images through the shared color machinery as required. Charge image buffers,
row scratch, conversion work and output before publication. Reject unsupported
image types explicitly. Emit reusable image XObjects and stencil resources.

**Step 4.** Run image/source/color/PDF tests, save/reopen render/sample checks,
and typecheck. Require GREEN.

**Step 5.** Commit image operators and source-consumer integration.

## Task 8 — Forms and colored/uncolored tiling patterns

**Files.** Create `src/pspaint.ts`, `test/psform.test.ts`,
`test/pspattern.test.ts`. Extend state/writer/session capture methods.

**Interfaces.** Produce `installPsPaint(vm: PsInterpreter,
graphics: PsGraphics): void`. Add `beginCapture(box: PsBox,
matrix: Matrix, uncolored: boolean): PsCapture` with
`complete(): PsPageOutput` and `abort(): void`. Scope completion publishes
the resource and scope unwinding restores the parent writer/state.
Keep bound pattern metadata in a host-owned WeakMap keyed by its valid body.

**Step 1.** Write failing tests for FormType 1 matrix/BBox/PaintProc and all
approved pattern parameter variants. Assert makepattern placement remains fixed
after CTM changes, signed steps work, uncolored cells receive the correct base
components and color-changing operators fault within them. Paint a reusable
pattern on two pages and inside a form and assert every resource owner resolves
after save/reopen. Test recursive forms/patterns, VM restore invalidation,
forged private metadata, captured font/resource extension hooks, callback
returning-handler completion and stop/quit/limit cleanup. A failed capture
must leave no partial resource reference or altered parent graphics state.

```ts
const { graphics } = runGraphics(
  '<< /FormType 1 /BBox [0 0 10 10] /Matrix [1 0 0 1 0 0] '
  + '/PaintProc { pop 0 0 10 10 rectfill } >> execform showpage',
);
expect(graphics.finish()).toHaveLength(1);
```

**Step 2.** Run form/pattern/page/color/VM tests and observe RED.

**Step 3.** Implement validated captures on the shared pump. Capture graphics
state and BBox clipping have explicit ownership. Preserve required callback
operands and VM side effects under language semantics. Snapshot/cache only
completed resources, with VM-valid identity and correct creation matrix.
Reject page ejection/resizing within paint callbacks through the documented
unsupported boundary. Store Type 1 patterns as native PDF pattern streams.

**Step 4.** Run new capture tests plus images/colors/pages/VM and typecheck.
Require GREEN including fresh runs after an aborted capture.

**Step 5.** Commit forms/patterns and the completed installation inventory.

## Task 9 — Integration, hostile inputs, provenance and delivery

**Files.** Create `test/psgraphics-limits.test.ts`,
`test/psgraphics-inventory.test.ts`, and small fixtures under
`test/fixtures/postscript-graphics/` with `PROVENANCE.md`.
Update affected CLAUDE/README policy descriptions and CHANGELOG when applicable.

**Interfaces.** The full `installPsGraphics` installs Tasks 2–8 exactly once,
owns their shared DecodeBudget and output counters, and returns PsGraphics.
Finalize exposes completed pages through the Task 4 adapter. There is no new
public index export or public import method in this issue.

**Step 1.** Add a source-driven test for every operator in the approved
inventory, including unsupported boundaries. Extend hostile tests for output
growth, page/resource accumulation, clip-edge intersections, arc subdivision,
tiny dashes, nested reader chains, image producers and recursive color/capture
callbacks. Use exact small limits and literal reached/allowed/detail assertions.
Exercise null/unlimited, repeated run and retained budgets after discard/restore.

```ts
expect(() => runGraphics('{ 0 0 1 1 rectfill } loop',
  LoadLimits.defaults.with({ maxPostScriptVmBytes: 1048576 }),
)).toThrow(ResourceLimitError);
```

The complete assertion also checks field equals maxPostScriptVmBytes and that
failure occurs while painting, after installation succeeded.

**Step 2.** Run focused graphics tests and observe RED for any uncovered behavior.

**Step 3.** Resolve gaps using individual RED/GREEN regressions. Record
geometry tolerance as `flatness * 72 / 250` device points and each fixture's
provenance. qpdf verifies file structure when available. Independent visual
oracles are recorded only when actually executed. Literal geometry/sample
expectations and the library's own renderer remain identified separately.
Document decoder accounting, callback unwind and ownership invariants.

**Step 4.** Run all new graphics/core/codec tests, calculator regressions,
`test/import-cycles.test.ts`, `test/limits-catch.test.ts` and README contract
tests that exist in this checkout. Run typecheck and whole-branch diff checks.
Obtain the selected workflow's whole-branch review and fix material findings.

**Step 5.** Run `npm run typecheck` and `npm test`. Integrate the verified branch
into main under repository authorization, then run both required gates on main.
Keep lw8w.2 in_progress until those gates pass. Close the issue, commit any
Beads-generated bookkeeping, push main and run `bd dolt push`. Verify main is
up to date with origin. Preserve user-owned scratch files throughout.
