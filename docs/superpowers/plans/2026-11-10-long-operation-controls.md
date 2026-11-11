# Long-operation Controls Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` inline. The recorded
> user preference excludes subagents. Beads issue `u34c.2` is the execution
> record; numbered steps describe work and are not a second task tracker.

**Goal:** Add cancellation/progress and yielding async forms to the 35 APIs in
the approved design, including input imports and XFA conversion.

**Architecture:** Refactor existing algorithms into shared generator pipelines.
One runner drives them synchronously and another awaits the existing checkpoint
helper between units. Nested pipelines delegate with a shared context, preserving
document-wide state and the outer operation name.

**Tech Stack:** TypeScript, Node >=22, Vitest, Node built-ins only.

**Spec:** [Approved design](../specs/2026-11-10-long-operation-controls-design.md).

## Global constraints

- Node >=22; no runtime dependencies; strict ESM/NodeNext with `.js` imports.
- Existing synchronous parameters/results remain compatible. Append `Async`
  for same-parameter promise-returning counterparts, exactly as the spec lists.
- Extend existing option interfaces with `OperationControlOptions`. Validators
  gain their final options argument; `Flow.Render(options?)` gains per-call controls.
- Capture controls once. Abort before parsing, allocation, modified flags, or
  consuming a Flow; check around callbacks and after real event-loop yields.
- Completed edits remain after cancellation. Preserve marked errors, structural
  consistency, signed/incremental refusals, and all existing report/output order.
- Every source catch begins with `rethrowLimit(caught)`. Close suspended
  generators on failure; cleanup performs bookkeeping, never more yielded work.
- No transient control state on Document, no global controls, no new concurrency
  guarantee. Preserve unrelated `_my/` files.
- Add public docs/changelog with each public change, architecture entries with
  new modules; update compiler-derived README export counts when types are exported.
- Keep Beads `in_progress` through local merge and both passing main gates.

## Review focus

1. Pre-abort of imports/Save/Flow must leave the live model and Flow lifetime
   untouched, even when a source or later phase would fail (Tasks 1, 7, 8, 10).
2. Cancelling after an in-place edit must leave serializable, correctly marked
   partial work; finalization must not silently run success actions (Tasks 5–9).
3. Tagged content spanning pages and shared fonts/images/tab indices must retain
   their original cross-page identities after the refactor (Tasks 3, 8).
4. Signed, encrypted, linearized, compressed, and incremental Save branches must
   all observe controls and retain their restrictions/semantics (Task 7).
5. Nested calls must use the outer operation name, captured controls, factual
   counts, and one notification per checkpoint, including unknown totals (all tasks).

## Shared conventions and file structure

Create only `src/operation.ts` for the generic runner/context. Keep algorithms
in their existing modules. Each algorithm gets an internal `*<name>Steps`
generator; existing functions and new internal `<name>Async` functions are thin
drivers of that generator. Public class methods delegate to these functions.
Class-local pipelines use lowercase `*<name>Steps`; expose them as `@internal`
only when another pipeline needs delegation (not via `index.ts`).

All generators return `OperationSteps<T>`. Pass resolved algorithm options and
an `OperationContext` explicitly; never run a nested public facade to simulate
async behavior. Keep existing internal function signatures compatible by adding
only optional controls/parameters or providing a sync wrapper.

Use these phase names and units (nested scopes prepend `prefix.`):

| Family | Phases and units |
| --- | --- |
| Rendering | `render` pages; `encode` final encoding; `assemble` final output |
| Semantic model | `headings` pages; `model` pages or tagged elements; `blocks` serialized blocks; `chapters` EPUB chapters |
| Validation | `rules` rules; `nodes` structural page-tree nodes |
| Conformance conversion | `passes` remediation passes; nested `validate.rules` |
| Colour | `images`, `shadings`, `content`, `annotations`, `scopes` processed units |
| Optimize | `passes`; `glyph-pages`; `image-pages`; `images`; `fonts`; `streams`; `dedup` atomic iterations |
| Save | `prepare`; `fonts`; `plan`; `remap`; `filter`; `objects`; `groups`; `linearize`; `diff`; `xref`; `assemble` |
| Input | `parse`; `lower` source blocks/list groups; `layout` completed placements; `metadata`; `frames` decoded/appended input frames |
| XFA | `plan`; `pages` atomic replacement group; `reconcile`; `fields`; `groups`; `finalize` |

Counts are phase-local, include attempted units that legitimately degrade/skip,
and never imply a successful result. Omit totals for dynamic work such as
pagination and linearization iteration; page numbers are actual document numbers.

Create focused tests under `test/control-*.test.ts` plus `test/operation.test.ts`.
Share fixtures in `test/helpers/control-fixtures.ts`: a three-page PDF, tagged
cross-page variants, and helpers using real controllers/immediates. Reuse existing
format/signing/XFA builders rather than authoring another encoder. Tests assert
behavior; do not inspect source text or use mocked checkpoints.

## Task 1: Runners, contexts, and public control types

**Files:** Create `src/operation.ts`, `test/operation.test.ts`,
`test/helpers/control-fixtures.ts`; modify `src/checkpoint.ts`, `src/index.ts`,
`README.md`, `CHANGELOG.md`, `CLAUDE.md`.

**Produces:**

```ts
type OperationSteps<T> = Generator<OperationProgress | undefined, T, void>;
interface OperationContext {
  readonly operation: string;
  progress(phase: string, completed: number, total?: number,
    pageNumber?: number): OperationProgress | undefined;
  scope(prefix: string): OperationContext;
}
function runOperation<T>(operation: string,
  options: OperationControlOptions | undefined,
  build: (context: OperationContext) => OperationSteps<T>): T;
function runOperationAsync<T>(operation: string,
  options: OperationControlOptions | undefined,
  build: (context: OperationContext) => OperationSteps<T>): Promise<T>;
```

1. Write runner tests: pre-abort never calls `build`; a two-unit generator
   reports completed counts `[1, 2]`; abort at count 1 prevents unit 2 and runs
   `finally` once; final return is checked for abort; `setImmediate` abort during
   a yield stops the next unit. Assert object reason identity, primitive cause,
   and propagation through `rethrowLimit`. Test option mutation during a yield,
   `scope('validate')` producing `validate.rules` with the outer operation, and
   undefined progress markers without a callback. Test generator-thrown errors
   and early return/cleanup separately from callback failures.
2. Run `npx vitest run test/operation.test.ts`; expect RED for missing runners.
3. Implement the interfaces above using `createOperationControl`, real yielding
   checkpoints, and `finally` closure. Export only the two control types from
   `index.ts`. Add their README rows/counts, initial changelog entry, and module
   architecture entry.
4. Run `npx vitest run test/operation.test.ts test/checkpoint.test.ts test/caller-error.test.ts test/limits-catch.test.ts test/readme-api.test.ts`
   and `npm run typecheck`; expect GREEN. Commit explicit paths.

## Task 2: Single-page raster/SVG and multi-page TIFF

**Files:** `src/raster.ts`, `src/svgrender.ts`, `src/page.ts`, `src/document.ts`;
create `test/control-render.test.ts`; update API docs/changelog.

**Consumes:** Task 1 runners/context. **Produces:**
`renderPageToPngSteps(doc, page, opts: ImageOptions, context): OperationSteps<Uint8Array>`,
`renderPageToSvgSteps(doc, page, opts: SvgOptions, context): OperationSteps<string>`,
`renderDocumentToTiffSteps(doc, opts: TiffExportOptions, context): OperationSteps<Uint8Array>`;
new async wrappers matching existing entry signatures. Extend `ImageOptions`
and `SvgOptions`; TIFF inherits controls through `ImageOptions`.

1. Write tests for sync/async parity across image formats and SVG, pre-abort
   before rendering, callback abort after rendering, and TIFF selection `[1, 3]`
   reporting actual page numbers `[1, 3]`/two frames. Schedule a real abort after
   TIFF frame 1 and prove frame 2 is not processed. Assert one outer operation
   name (`ToTiff`) and no nested `ToImage` events; retain empty-selection refusal.
2. Run `npx vitest run test/control-render.test.ts`; expect RED.
3. Extract shared pipelines with render/encoding boundaries. TIFF retains one
   frame list and one final `encodeTiff` call. Add Page `ToImageAsync`/`ToSvgAsync`
   and Document `ToTiffAsync`; keep internal backdrop rendering under its outer
   consumer rather than spawning another control run.
4. Run `npx vitest run test/control-render.test.ts test/raster-tiff.test.ts test/document-totiff.test.ts`
   and `npm run typecheck`; expect GREEN. Commit explicit paths; do not change
   codecs or rendering algorithms.

## Task 3: Shared document model and all remaining exports

**Files:** `src/textrank.ts`, `src/docmodel.ts`, `src/html.ts`, `src/htmlfixed.ts`,
`src/htmlsemantic.ts`, `src/mdexport.ts`, `src/docxexport.ts`, `src/docxflow.ts`,
`src/epubexport.ts`, `src/page.ts`, `src/document.ts`; create
`test/control-export.test.ts`; update architecture/API docs/changelog.

**Consumes:** Task 1 and Task 2 rendering steps. **Produces:**
`headingRanksSteps(doc, context): OperationSteps<Map<number, number>>` and
`buildDocModelSteps(doc, pages: Page[], context): OperationSteps<DocNode[]>`;
exporter step/async wrappers following the shared naming convention, returning
their existing `string`, `MarkdownExportResult`, or `Uint8Array` results.

1. Write a matrix exercising Page/Document HTML, Markdown, assets, DOCX, and
   Document EPUB for pre-abort and parity. Pin HTML/Markdown strings and decoded
   archive parts. Cancel in headings/model and blocks/chapters using callbacks
   and real yields. Use a tagged paragraph/list spanning two pages and shared
   image bytes: output must retain one semantic element and one package image.
   Cover fixed HTML forms/tab order and textbox DOCX shared registries. Abort
   reasons must escape the existing damage-degradation catches.
2. Run `npx vitest run test/control-export.test.ts`; expect RED.
3. Refactor heading scans and tagged/untagged model traversal with shared
   context/state, yielding inside recursive tagged traversal rather than only
   after a root Document element that may contain the whole file. Add
   serialized-block steps without rebuilding a model per
   page. Delegate model/serializer pipelines from each exporter; retain a single
   image registry, numbering state, font registry, and final package assembly.
   Add all remaining Page/Document export Async methods from the spec.
4. Run `npx vitest run test/control-export.test.ts test/docmodel.test.ts test/html-identity.test.ts test/html-forms.test.ts`
   and `npm run typecheck`; expect GREEN. Commit explicit paths.

## Task 4: Conformance and structural validators

**Files:** `src/pdfavalidate.ts`, `src/structvalidate.ts`, `src/pdfxvalidate.ts`,
`src/pagecheck.ts`, `src/document.ts`; create `test/control-validation.test.ts`;
update API docs/changelog.

**Produces (consumed by Task 5):**
`validatePdfASteps(doc, catalog, level: PdfALevel, context): OperationSteps<ValidationReport>`,
`validatePdfUaSteps(doc, catalog, part: PdfUaPart, context): OperationSteps<ValidationReport>`,
`validatePdfXSteps(doc, catalog, level: PdfXLevel, context): OperationSteps<ValidationReport>`;
`checkPageTreeSteps(doc, fix: boolean, context): OperationSteps<ValidationIssue[]>`.
Add optional controls to existing validator wrappers and public signatures from
the spec, with Async counterparts.

1. Write tests for all four public validators: pre-abort, unchanged issue order,
   callback failure propagation, and abort between rules/nodes during a real
   yield. Exercise PDF/A level-a's nested UA scan (`ValidatePdfA` stays the outer
   operation), untagged UA's early return, and structural cycles/shared nodes.
   Validation must not mutate saved bytes. Preserve Repair's uncontrolled sync
   behavior through the existing `checkPageTree` wrapper.
2. Run `npx vitest run test/control-validation.test.ts`; expect RED.
3. Convert rule iteration to steps without reordering rules; delegate nested
   UA validation. Convert structural traversal to generator delegation with the
   same ancestor/count maps. A conformance rule remains an atomic work unit.
4. Run the new file and `test/pdfua-part1-identity.test.ts`, plus typecheck;
   expect GREEN. Commit explicit paths.

## Task 5: Colour and PDF/A/UA/X transformations

**Files:** `src/colorconvert.ts`, `src/pdfaconvert.ts`, `src/pdfuaconvert.ts`,
`src/pdfxconvert.ts`, `src/document.ts`; create `test/control-convert.test.ts`;
update API docs/changelog.

**Consumes:** Task 4 validation steps. **Produces:** step/async forms of
`convertColors`, `convertToGrayscale`, `convertToPdfA`, `convertToPdfUa`, and
`convertToPdfX`, with their existing options/report types. Extend
`ConvertColorsOptions`, `ColorConvertOptions`, `ConvertOptions`,
`PdfUaConvertOptions`, and `PdfXConvertOptions` with shared controls.

1. Write the five-method pre-abort/parity matrix. Abort during colour phases
   and between conformance passes, including a real yielding abort. Save/reopen
   partial edits; assert they remain valid and modified, no later pass ran, and
   callback errors were not logged as skipped content. Test invalid targets and
   signed refusal unchanged. Assert `ConvertToGrayscale` and nested revalidation
   retain their outer names; PDF/UA-2 still validates against part 2.
2. Run `npx vitest run test/control-convert.test.ts`; expect RED.
3. Extract shared phase/unit pipelines, keeping resource dedup and pass order.
   Move facade `markModified` calls after the initial abort check but before
   edits; ensure early cancellation after edits cannot hide the modified state.
   Delegate revalidation with `context.scope('validate')`, never a nested runner.
4. Run new tests, `test/grayscale-identity.test.ts`, `test/pdfua2-convert.test.ts`,
   and typecheck; expect GREEN. Commit explicit paths.

## Task 6: Optimization passes and scans

**Files:** `src/optimize.ts`, `src/glyphusage.ts`, `src/imageusage.ts`,
`src/imageopt.ts`, `src/unembed.ts`, `src/recompress.ts`, `src/dedup.ts`,
`src/drprune.ts`, `src/document.ts`; create `test/control-optimize.test.ts`;
update architecture/API docs/changelog.

**Produces:** `optimizeDocumentSteps(doc, opts: OptimizeOptions, context): OperationSteps<OptimizeReport>`
and its async wrapper. Add controls to `OptimizeOptions`. Expose delegated
`collectGlyphUsageSteps(doc, context): OperationSteps<UsageMap>` and matching
scan/pass generators returning their existing result types.

1. Reuse `build-optimize-pdf` for tests: pre-abort, parity with optional image
   recompression/unembedding, abort after one image/font/stream and during a
   glyph-page yield. Save/reopen partial work; bytes/report semantics and signed
   refusal remain correct. Assert disabled passes emit no completed pass work.
   Cancel between dedup iterations and verify all surviving references resolve.
2. Run `npx vitest run test/control-optimize.test.ts`; expect RED.
3. Preserve DR/images/unembed/fonts/dedup/compress ordering. Add scan/unit
   checkpoints; keep each dedup iteration atomic. Mark the document correctly
   on an early exit after mutation; do not return a partial OptimizeReport.
4. Run new tests plus `test/optimize.test.ts`/`test/optimize-dr.test.ts` and
   typecheck; expect GREEN. Commit explicit paths.

## Task 7: Save through every output mode

**Files:** `src/serializer.ts`, `src/linearize.ts`, `src/incrementaldelta.ts`,
`src/incremental.ts`, `src/streamfilter.ts`, `src/document.ts`; create
`test/control-save.test.ts`; update architecture/API docs/changelog.

**Produces:** `serializeDocumentSteps(objects, trailer, options: SerializeOptions,
preserved: Encryptor | undefined, context): OperationSteps<Uint8Array>`;
`planDocumentSteps(objects, trailer, context): OperationSteps<Plan>`;
delegated linearization, delta, and emission generators returning existing
results. Extend `SerializeOptions` (and thus `SaveOptions`) with controls.
Document gets shared private save/incremental/font-finalization pipelines and
`SaveAsync(options?: SaveOptions): Promise<Uint8Array>`.

1. Write tests across classic/compressed, encryption, filtering, linearization,
   incremental, and signed-verbatim branches. Pre-abort precedes font/barcode
   prep. Abort in planning/remapping/object/group emission, a linearization
   iteration, font preparation, and incremental diff/emission; no bytes resolve.
   Check real event-loop aborts and callback errors. Retry Save after cancellation
   and reopen; preserve signatures, encryption, changed objects, and refusal
   combinations. Fix IDs for byte comparisons; otherwise compare decoded semantics.
2. Run `npx vitest run test/control-save.test.ts`; expect RED.
3. Refactor all listed paths to shared steps, keeping offsets/chunks/local plans
   private until success. Do not change numbering, random-ID/IV generation order,
   layout fixed-point computation, incremental reachability blindness, or signing
   serializers. Existing signing callers keep the sync font-finalization wrapper.
4. Run new tests plus `test/save-incremental.test.ts`,
   `test/sign-incremental-survival.test.ts`, `test/linearize-serialize.test.ts`,
   and typecheck; expect GREEN. Commit explicit paths.

## Task 8: Source imports and resumable Flow layout

**Files:** `src/flow.ts`, `src/flowplace.ts`, `src/mdflow.ts`, `src/htmlflow.ts`,
`src/cssflow.ts`, `src/wmlimport.ts`, `src/wmlflow.ts`, `src/imagepages.ts`,
`src/page.ts`, `src/document.ts`; create `test/control-import.test.ts`;
update architecture/API docs/changelog.

**Produces:** delegated source-lowering generators returning existing element
results; `placeElementsSteps(doc, page, elements, rect, options, context): OperationSteps<PlaceElementsResult>`;
Flow `renderSteps(context): OperationSteps<Page[]>` and `addHtmlSteps`,
`addMarkdownSteps`, `addDocxSteps` with resolved original arguments plus context.
Expose these as `@internal` for Document's delegation. Extend source option
interfaces and `AddImagePagesOptions` with controls. Add all import/Flow Async
methods and `Render(options?: OperationControlOptions)` from the spec.

1. Write Document/Page/Flow import matrices using real HTML/Markdown and
   `buildDocx`; test parsed trees as well as bytes/strings. Pre-abort must not
   parse, allocate fonts/pages, change title, or consume a Flow. Abort after
   lowering/layout work and during a real yield. Check unknown layout totals,
   page numbers when appending, rect remainders, and returned skipped/unsupported
   order. Cancel a tagged flow with notes: completed pages Save/reopen, note IDs
   remain consistent, `onRendered` is not called, and started Flow is consumed.
   Cancel image-page import after one frame and verify one saved page remains.
2. Run `npx vitest run test/control-import.test.ts`; expect RED.
3. Convert top-level lowering and placement/layout loops to steps, preserving
   HTML margin/list-run context, Markdown footnote state, Word note/section
   geometry, floats, keep-with-next, and skipped logs. Parsing/building boxes
   remains atomic; yield between source block/list groups and completed
   placements. Put required note-ID finalization in non-yielding cleanup; retain
   normal success decoration order. Apply Document titles after successful layout.
4. Run new tests plus `test/flow-notes-identity.test.ts`,
   `test/flow-notes-tagged.test.ts`, `test/flow-onpage.test.ts`,
   `test/docx-import.test.ts`, and typecheck; expect GREEN. Commit explicit paths.

## Task 9: XFA conversion and async file helpers

**Files:** `src/xfaconvert.ts`, `src/document.ts`, `src/node.ts`; create
`test/control-xfa.test.ts`, `test/control-node.test.ts`; update API docs/changelog.

**Consumes:** Tasks 2, 3, 7, 8 async entry points. **Produces:**
`convertXfaToAcroFormSteps(doc, opts: XfaConvertOptions, context): OperationSteps<XfaConvertReport>`
and its async wrapper/facade; shared controls on `XfaConvertOptions`. Existing
Node helper signatures inherit controls through their existing options types.

1. Reuse `build-xfa-pdf` and dynamic/master fixtures: pre-abort, parity, abort
   after reconciliation/field creation and during a yield; one atomic placeholder
   page replacement group, XFA retained until finalization, saved partial form
   remains coherent. Preserve signed refusal and no-conversion no-op behavior.
   For each of the five Node helpers in the spec, pre-abort and cancel conversion
   with a real controller; assert an existing output sentinel is unchanged and
   no new output/assets were written. Verify successful outputs still read back.
2. Run `npx vitest run test/control-xfa.test.ts test/control-node.test.ts`; expect RED.
3. Delegate XFA plan/apply/finalization steps with no yield inside the page
   replacement group. Node helpers capture signal/callback once at entry, then
   call the corresponding Async conversion and SaveAsync where applicable,
   forwarding those captured controls; check before reads/parsing
   and output writes, without promising interruption of in-flight filesystem I/O.
4. Run new files plus `test/xfaconvert.test.ts`, `test/xfaconvert-master.test.ts`,
   `test/html-file.test.ts`, and typecheck; expect GREEN. Commit explicit paths.

## Task 10: Coverage audit, full verification, and integration

**Files:** Create `test/control-api.test.ts`; finalize `README.md`,
`CHANGELOG.md`, `CLAUDE.md`; any test-only additions to shared fixtures.

1. Write an explicit, independent 35-entry public API matrix from the spec. For
   every pair assert pre-abort reason identity and unchanged input/Flow state,
   correct sync versus promise return shape, and success parity. Cover empty
   operations, options captured across a yield, all five Node helpers, and an
   async call without controls genuinely servicing an immediate. Add a failing
   test first for any missing route found; repair that route in its owning module.
2. Run `npx vitest run test/control-api.test.ts test/operation.test.ts test/limits-catch.test.ts test/readme-api.test.ts`
   and typecheck; expect GREEN. Finish the README cancellation example, coverage
   and phase/unit table, no-rollback/Flow lifetime/no-concurrent-mutation contract,
   all Async method rows, and corrected "never throws" claims. Derive type export
   counts from `test/readme-api.test.ts`; do not guess them.
3. Review the whole branch inline against the spec and Review Focus; record
   findings/decisions in Beads. Run `npm run typecheck` and `npm test`; both must
   pass. Commit the final docs/audit with explicit paths.
4. Pull/rebase as needed, merge the feature branch into main locally, and run
   both mandatory gates on main. Only then close `u34c.2`; close `u34c` after
   verifying both children are complete. Push main and sync with `bd dolt push`;
   commit/push any tracked closure records. Delete the merged feature branch
   locally/on origin, preserving `__dolt_remote_info__`; verify main matches
   origin and leave user scratch files untouched.
