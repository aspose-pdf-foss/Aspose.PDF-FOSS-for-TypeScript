# Long-operation controls

Issue: `aspose-pdf-foss-for-ts-u34c.2`, completing epic `u34c`.
Foundation: [cooperative checkpoints](2026-11-10-cooperative-checkpoint-design.md).

## Intent and decisions

Let applications report progress and cancel long conversions, validation,
optimization, and serialization. The user selected both controls on existing
synchronous methods and explicit yielding `Async` counterparts. The user also
expanded conversion coverage to input imports and XFA conversion.

This spans several subsystems, exceeding the issue's original medium estimate.
It remains one feature with one shared control contract, implemented and
reviewed inline according to the recorded workflow preference.

Goals are compatibility for existing callers, actual event-loop opportunities
in async operations, factual progress, and propagation of caller failures.
Preserve existing output semantics, report ordering, font/image identity,
tagged content spanning pages, and all signed/incremental-save restrictions.

## Approaches

1. Add options only to synchronous APIs: smallest change, but timers and I/O
   cannot cancel a blocked synchronous loop. Not selected.
2. Keep synchronous APIs and add explicit async forms: selected by the user.
   Share resumable processing steps so the two forms cannot drift.
3. Change existing methods to return promises: breaks current consumers and
   was ruled out by the compatibility requirement.

The shared-step architecture below is my implementation proposal. Separate
copies of processing algorithms would double the correctness surface; wrappers
that merely await before calling the whole synchronous operation would provide
no cancellation between its work units.

## Public API coverage

Every method in this table retains its existing parameters/return type, gains
optional `signal`/`onProgress` controls, and gains a same-parameter method named
`<ExistingName>Async`, returning `Promise<ExistingReturnType>`.

| Surface | Methods |
| --- | --- |
| Document exports | `ToHtml`, `ToMarkdown`, `ToMarkdownAssets`, `ToDocx`, `ToEpub`, `ToTiff` |
| Page exports | `ToImage`, `ToSvg`, `ToHtml`, `ToMarkdown`, `ToMarkdownAssets`, `ToDocx` |
| Document transformations | `Optimize`, `ConvertColors`, `ConvertToGrayscale`, `ConvertToPdfA`, `ConvertToPdfUa`, `ConvertToPdfX`, `ConvertXfaToAcroForm` |
| Document validation | `Validate`, `ValidatePdfA`, `ValidatePdfUa`, `ValidatePdfX` |
| Document output | `Save` |
| Document input conversion | `AddHtml`, `AddMarkdown`, `AddDocx`, `AddImagePages` |
| Page input conversion | `AddHtml`, `AddMarkdown`, `AddDocx` |
| Queued flow input/layout | `Flow.AddHtml`, `Flow.AddMarkdown`, `Flow.AddDocx`, `Flow.Render` |

Controls extend existing options types rather than add another positional
argument. The validators are the exception because they currently have no
options: `Validate(options?)`, `ValidatePdfA(level, options?)`,
`ValidatePdfUa(part = 1, options?)`, and `ValidatePdfX(level, options?)`.
`Flow.Render(options?)` takes per-call controls; its existing geometry and
decoration callbacks remain configured through `FlowOptions`.

Export `OperationProgress` and `OperationControlOptions` from `src/index.ts`,
using the existing definitions in `checkpoint.ts` (remove their internal-only
designation). Keep the factory, `OperationControl`, and step runners internal.

```ts
interface OperationProgress {
  readonly operation: string;
  readonly phase?: string;
  readonly completed: number;
  readonly total?: number;
  readonly pageNumber?: number;
}
interface OperationControlOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: OperationProgress) => void;
}
```

Existing async Node helpers that wrap covered exports/imports use the yielding
forms and forward controls: `savePageImageFile`, `saveMarkdownFile`,
`saveDocxFile`, `htmlFileToPdf`, and `docxFileToPdf`. They must not start writing
an output whose conversion was cancelled. Conversion controls do not claim to
interrupt filesystem I/O or `Document.Open`.

## Shared processing and cancellation boundaries

Add an internal, dependency-light `operation.ts` with typed generator runners.
A pipeline yields an `OperationProgress` record after each completed unit and
returns its normal result. Without a progress callback, yield an undefined
checkpoint marker instead and construct no progress record. A sync runner feeds
those records/markers to `checkpoint`;
an async runner uses `checkpointAsync`, including a cancellation check/yield
before starting work. Both check cancellation before advancing a pipeline and
before returning its result, and close suspended generators on failure so
required bookkeeping in `finally` runs. Cleanup must not emit progress or run
success callbacks.

Use delegation (`yield*`) and one control instance for nested pipelines.
Progress keeps the outer operation name (the synchronous method name, without
`Async`) and identifies nested work through phase names. This avoids duplicate
notifications and preserves one captured signal/callback throughout a run.

| Pipeline | Checkpoint boundaries |
| --- | --- |
| Image/SVG and other single-page exports | Before rendering, after rendering/model construction, after encoding/assembly |
| TIFF | Each selected page/frame, then final encoding |
| Semantic exports | Each page in heading analysis and untagged model construction; tagged-tree traversal units; serialized blocks/chapters; final archive assembly |
| Fixed HTML/textbox DOCX | Each page, preserving shared fonts, image registry, form tab order, and document-wide assembly |
| Optimize | Pass boundaries; page glyph-usage scans, image/font units, and stream recompression; a dedup iteration stays atomic so reference rewrites cannot be left half-applied |
| Colour conversion | Phase boundaries and page/content/image/shading/annotation units, preserving shared-resource deduplication |
| PDF/A, UA, X conversion | Each remediation pass, then each re-validation rule |
| PDF/A, UA, X validation | Each rule; a rule's internal scan remains an atomic unit |
| Structural validation | Page-tree node units with existing cycle/shared-node defenses |
| Save | Preparation phases and font units; reachable-object planning/remapping and object emission; compressed groups; linearization iterations; incremental diff/emission units |
| HTML/Markdown/DOCX input | Parse/lower/layout phases; top-level source blocks and completed layout units; metadata after successful layout |
| Image-page input | Each decoded/appended frame |
| XFA conversion | Plan phase, page replacement group, reconciled/created fields and radio groups, then finalization |

The table defines cooperative granularity, not a time limit: parsing a source
file, rendering a page, shrinking a font, compressing a stream, applying a
conformance rule/pass, replacing XFA placeholder pages as a group, or assembling
an archive can still block until that unit finishes. No worker threads,
cross-thread interrupts, parallel execution, or codec-level preemption.

Do not split tagged semantic documents into independent page documents: an
element may span pages, and that would alter lists, headings, images, and
structure. Refactor traversal while preserving its shared context instead.
Keep ordinary synchronous entry points in existing modules available for
internal consumers and tests; both public forms use the same underlying steps.

## Progress and failure contract

- No options means existing synchronous behavior, with no event allocation for
  callbacks that do not exist. Async methods still yield without controls.
- Records are fresh shallow snapshots. Callbacks are synchronous and returned
  promises are not awaited. Emit only completed work; optional phase-start
  records use `completed: 0`. Empty operations can finish with `0/0`.
- Counts are local to a phase, not an overall percentage. `total` is omitted
  when unknown (such as pagination). Page numbers, when meaningful, are the
  actual one-based document numbers, not indices within a selection.
- Phases can recur in nested operations; consumers must not assume globally
  monotonic counters. Document phase names and unit meanings for each family.
- Check an already-aborted signal before parsing, allocation, changing modified
  flags, consuming a Flow, or running callbacks. Cancellation from a callback
  stops that same checkpoint; async cancellation during a yield stops the next
  unit. Do not report success or return partial output bytes on abort.
- Use `markCallerError` through the shared helper: preserve object reason/error
  identity, wrap primitives with `Error.cause`, and let `rethrowLimit` pass these
  through all damage-recovery catches. Existing recovery from corrupt content
  otherwise remains unchanged.

## Mutation and lifetime

Completed edits remain on cancellation; no rollback or atomic-document promise.
Mark edits correctly even when the operation exits early, so a later Save
reflects the live model. Keep each yielded mutation unit internally consistent.
Pre-aborted calls leave the document and any queued Flow untouched.

Once layout actually starts, an aborted Flow remains consumed; callers create
a new Flow rather than replaying already-drawn content. Run structural/note-ID
cleanup needed by completed work in `finally`, but call `onRendered` only after
successful layout. Preserve XFA until the successful finalization that removes
it; page replacement itself is one indivisible unit.

Save still has its existing font/barcode preparation side effects. Cancellation
returns no bytes and creates no signed or incremental success state. Preserve
verbatim signed-byte returns, encryption, stream filtering, classic/compressed
output, and linearized/incremental refusals.

While an async operation is pending, callers must not mutate the same document
(including raw dictionaries) or start another operation on it. This feature
adds cooperation, not document locking or concurrency support. Do not add a
new global control state or attach a transient signal to Document.

## Constraints and non-goals

Node >=22; no runtime dependencies; strict ESM/NodeNext with `.js` imports.
Use Beads for tracking and execute inline. Preserve unrelated `_my/` files.
This issue covers source-document conversion, not PDF parsing (`Open`),
split/merge, form-data import/export, primitive authoring/embedding APIs, or
AI/OCR APIs that already have their own async callback contracts.

Update public JSDoc and README, including the exceptions to old "never throws"
claims and compiler-derived API export counts. Add an Unreleased changelog
entry and architecture entries for new modules and changed control paths.

## Verification and completion

Use TDD with real controllers and deterministic `setImmediate` scheduling.
Test the runners' early checks, generator cleanup, and error propagation first.
Exercise every covered public entry point for pre-abort and sync/async parity;
test representative mid-operation callback aborts and aborts during real yields
for each pipeline family. Verify snapshots, page selections, unknown totals,
nested operation names, and no duplicate events.

Keep all existing output/report tests green. Use fixed IDs/metadata for exact
byte comparisons where deterministic; compare decoded content and preserved
semantics for randomized encrypted/archive outputs. Cover multi-page tagged
exports, shared images/fonts, partial edits saved/reopened after abort, Flow
cleanup/consumption, and every Save mode (including signed-verbatim paths).

Both `npm run typecheck` and `npm test` must pass on main after local merge and
before closing the issue. Push main, sync Beads, delete the merged feature
branch locally/on origin, and preserve `__dolt_remote_info__`. Close the parent
epic only once its two children are complete.
