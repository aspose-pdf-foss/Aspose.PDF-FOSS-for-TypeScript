# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and SemVer, mirroring the Go implementation's.

**Update it in the same commit as the change**, under `## [Unreleased]`, whenever
a change is visible to a user of the library:

- **Added** — a new public API, option or capability.
- **Changed** — altered behaviour or a renamed/removed option. Lead a breaking
  change with **BREAKING**.
- **Fixed** — a defect a user could hit. Say what went wrong and when it bit,
  not just what was repaired.
- **Deprecated** / **Removed** / **Security** as they arise.

Do NOT log internal refactors, test-only work, or documentation edits that
change no behaviour — the audience is someone deciding whether to upgrade.

Write entries the way the rest of this repo writes: a bold lead-in, then prose
that says what it does, why the design went that way, and what was measured.
Cite the issue id in parentheses at the end. An entry that only names a feature
is not worth the line.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Update CHANGELOG.md** - Add an `## [Unreleased]` entry for any user-visible change (see Changelog above)
3. **Run quality gates** (if code changed) - Tests, linters, builds
4. **Update issue status** - Close finished work, update in-progress items
5. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
6. **Clean up** - Clear stashes, prune remote branches
7. **Verify** - All changes committed AND pushed
8. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

No runtime dependencies; dev deps are TypeScript + vitest only.

```bash
npm install        # install dev deps (TypeScript, vitest)
npm test           # vitest run — full suite (test/**/*.test.ts)
npm run test:watch # vitest in watch mode
npm run typecheck  # tsc -p tsconfig.json --noEmit
npm run build      # clean + tsc -p tsconfig.build.json -> dist/ (ESM + .d.ts)
```

**Two tsconfigs, and the split is load-bearing.** `tsconfig.json` includes
`src`, `test` and `examples` with `rootDir: "."` — that is what typechecks the
suite, and it must stay that way. But building through it emits
`dist/src/index.js` and compiles the whole test suite into the package, while
`package.json` declares `main: "dist/index.js"`: the published tarball then
resolves to a file that does not exist. `tsconfig.build.json` is `src`-only
with `rootDir: "src"`, so `dist/index.js` lands where `main` points. Never
point `build` at `tsconfig.json`.

Five generators rebuild the bundled data tables and are **not** run by `npm
test` — the generated `src/*data.ts` files are committed, and each is pinned to
the upstream version its module documents. Re-run one only when that pin moves:

```bash
npm run gen:fonts      # std14data.ts    — Standard-14 substitute outlines (fonts/)
npm run gen:ucd        # unicode-data.ts — UAX #9/#14 classes, caseFold (unicode/)
npm run gen:entities   # mdentity.ts     — HTML character references
npm run gen:cmaps      # cmapdata.ts     — the 195 predefined Adobe CMaps (cmaps/)
npm run gen:cidunicode # cidunidata.ts   — CID->Unicode, mapping-resources-pdf
```

`npm run example:showcase` builds the feature-showcase document under
`examples/feature-showcase/`; the remaining `scripts/gen-*` entries
regenerate committed test fixtures (the corrupt files, the JPX and JBIG2
streams, the SVG inputs, the headless-Chrome SVG and filter goldens) and are
likewise never run by the suite — it reads what they produced.

**Note, and do NOT "fix" it back:** `.gitignore` deliberately carries **no**
rule for `examples/feature-showcase/.reference/`. That directory was a fetched
copy of the Go showcase's `main.go`, used while the example was being ported;
it is no longer fetched, does not exist, and needs no ignore rule. The archived
plan `docs/superpowers/plans/2026-08-06-feature-showcase-example.md` still
lists the rule under its Task 1, because it records what that task did at the
time — so the plan reads as evidence the rule is missing by accident. It is
not. The rule was removed on purpose; it has already been restored once in
error and removed again.

Always run `npm run typecheck` and `npm test` before closing an issue — both
must be green. Target a single test file with `npx vitest run test/<name>.test.ts`.

## Architecture Overview

The library parses an entire PDF into an in-memory object model on `Open`, lets
callers mutate that live model, and serializes a fresh, compactly-renumbered
document on `Save` (mark-sweep from `/Root` + `/Info`). No temp files; the only
incremental-update path is digital signing (`Sign`/`Certify`/`AddValidationData`/
`AddDocumentTimestamp`), which appends to preserve earlier signed bytes.

Source (`src/`):

- **types.ts** — the `PdfObject` model and type guards. `PdfDict` is a `Map`
  keyed by name (no leading `/`); names/strings/refs/streams are tagged objects
  (`isDict`/`isRef`/`isName`/`isStream`/...).
- **lexer.ts**, **object-parser.ts** — PDF tokenizer and object grammar.
  **Invariant:** `Lexer.next()` never throws, and either consumes at least one
  byte or returns `eof`. Every caller loops until eof, so a token returned at an
  unchanged `pos` is an infinite loop. `)`, `{`, `}` and an unmatched `>` are the
  bytes that reach this: they are delimiters no production claims, so
  `readRegular` stops on them without advancing and they come back as
  one-character keywords rather than as an empty one. A single such byte in a
  still-encrypted content stream grew `parseContentStream`'s op list until the
  heap died — a damaged file must throw `PdfParseError`, never take the process
  down.
  **Invariant:** deciding that a token is a *syntax error* belongs to the
  caller, the only layer that knows the grammar. Four grammars share this
  tokenizer, and only `object-parser.ts` may reject: it throws on a stray
  keyword in every position one can appear, which is what lets `sweepObjects`
  decide an offset holds no object. The other three — content streams, CMaps
  (`cmap.ts`) and `/DA` strings (`da.ts`) — already ignore keywords they do not
  recognise, so damage costs them the bytes it touched instead of the page, the
  font's decoder or the appearance. A throw in the lexer took all four down at
  once and was reachable from any file we did not write.
- **xref.ts** — classic cross-reference tables, cross-reference streams, and
  hybrid `/XRefStm`. **objstm.ts** — object stream (`/ObjStm`) decoding.
  **Invariant:** a damaged `/ObjStm` costs its unreadable objects, not the
  container. `decodeObjStm` inflates partially, reads the header pairs that are
  there rather than the `/N` that is claimed, recovers `/First` from the header
  end, and parses each object in its own `try`; what it could not produce lands
  in `BuildResult.lostInObjStm`. That set is deliberately *not* the one the
  `object-parse-failure` rethrow reads. An object inside a container has no
  `N G obj` header, so the sweep that rule reasons about was never available to
  it, and widening the rethrow refuses documents over damage that provably
  cannot be repaired. Only one fixture reaches that guard at all — a file
  damaged *both* ways, so the sweep runs — which is why the widening survives
  every other test in `objstm-recovery.test.ts`.
  **Invariant:** the header loop is bounded by stopping at the first non-pair
  token, not by `/N`, which is only a number in a dict and may say 2³¹. That is
  a real bound solely because `Lexer.next()` always advances or returns `eof`.
  **Invariant:** `filters.ts`'s `partial` decode is best effort and its output
  is not trustworthy to the last byte. `Z_SYNC_FLUSH` covers a payload that
  merely stops early; a payload whose bytes were *altered* raises a data error
  with no output at all, so `inflateSalvage` searches for a prefix that still
  decodes. Altered bytes often still form valid DEFLATE symbols, so a prefix
  reaching past the damage decodes to something arbitrary — every consumer must
  validate what it parses and be ready to discard the tail.
- **recover.ts**, **rebuild.ts** — brute-force recovery: the path `Document.Open`
  falls back to when the cross-reference structure cannot be read, when an object
  will not parse at the offset the xref gave, or when `/Root` does not resolve to
  a `/Type /Catalog`. What it did and what it cost is surfaced as `doc.recovery`
  (a `RecoveryReport`), `undefined` after a clean parse. The split is by what each
  half touches: `recover.ts` is pure byte work — `sweepObjects` finds every
  `N G obj` header and every `trailer` keyword without parsing a single object —
  and `rebuild.ts` is the parsing half, identifying structure by *shape* for a
  file that lost the references that would otherwise name it
  (`expandObjectStreams`, `chooseCatalog`, `chooseInfo`, `findEncryptDict`,
  `rebuildTrailer`). Neither imports `document.ts`; both take plain maps and
  callbacks, which is what lets the whole ladder be driven from hand-built
  buffers in `test/recover.test.ts` rather than from damaged files.
  **Invariant:** the sweep alone cannot find everything, and the gap is not
  marginal. An object stored inside an `/ObjStm` carries no `N G obj` header of
  its own and is invisible to any byte scan — but the container carries one, so
  `expandObjectStreams` registers what each container *declares*. Without that
  step `/Root` is unreachable in every file `Save({ compressed: true })` has ever
  produced. An existing `offset` entry always wins over a container's claim: the
  former was found literally in the file, the latter is only an assertion about
  what the container holds.
  **Invariant:** the catalog is chosen **validated first, then latest** — keep
  the candidates whose `/Pages` resolves to a `/Type /Pages`, and among those
  take the highest file offset, which is last-wins and matches append-only
  incremental updates. Validation earns its cost on a tail-truncated file, where
  the *newest* catalog is precisely the broken one. With nothing walkable it
  falls back to plain highest-offset rather than failing: a document with a
  damaged page tree should still open and carry the damage in `doc.recovery`.
  Every candidate considered is reported, so "one catalog, obvious" reads
  differently from "three, we took the last".
  **Invariant:** `/Info` is identified by **reachability**, not by its key set.
  It carries no `/Type`, so only shape is available — but the decisive signal is
  structural: a valid document never reaches `/Info` from the catalog graph,
  since it hangs off the trailer alone. That is what stops an outline item, which
  carries `/Title` and no `/Type`, from winning a lexical key-set test. An
  exclusion list of other-dict shapes would have to stay ahead of every construct
  in the format; reachability does not. Only when no such dict exists is an
  `/Info` synthesized from the catalog's XMP packet, through the mirror `xmp.ts`
  already applies for `SetXmp` — so the shared fields have one mapping, not two.
  **Invariant:** `findEncryptDict` scans **offset entries only** and loads them
  raw. An `/Encrypt` dict is never itself encrypted and never lives inside an
  `/ObjStm`, so decrypting would be circular and scanning containers pointless;
  requiring the handler's own keys (`/V /R /O /U /P`, or `/Recipients`/`/CF` for
  `Adobe.PubSec`) is what keeps an unrelated dict carrying a `/Filter` — a stream
  dict, a filespec — from matching.
  **Invariant:** the three refusals are a **ladder**, not alternatives:
  `no indirect objects found` (nothing in the file), `no /Type /Catalog object
  found` (objects but no catalog), then a catalog we can work from. Collapsing
  any two turns a diagnosis the caller can act on into "the file is broken".
- **flate.ts**, **predictor.ts** — `FlateDecode` (via `node:zlib`) with PNG/TIFF
  predictors.
- **crypto.ts** — standard security handler decryption on open (RC4, `AESV2`,
  `AESV3`) via `node:crypto`.
- **document.ts** — the `Document` facade: `Open`/`Save`, page-tree edits,
  metadata (`/Info` + XMP), outlines, forms, annotations, split/merge/extract.
- **page.ts**, **pagetree.ts** — `Page` wrapper plus page-tree flattening and
  attribute inheritance.
- **extractor.ts** — single-page / object-graph extraction with a `PrunePolicy`.
- **serializer.ts**, **serialize.ts** — output: classic xref table (default) and
  compressed (cross-reference stream + `/ObjStm`) via `Save({ compressed: true })`.
- **outline.ts**, **image.ts**, **content.ts**, **metadata.ts** — feature modules
  (bookmarks, image XObjects, content-stream tokenizer, `/Info` metadata).
  `content.ts` also owns **`imageCutSet`**, the `q … cm … Do … Q` group cut
  shared by redaction and image removal — pure `ContentOp[]` arithmetic, so it
  belongs in the leaf rather than in either consumer.
  **Invariant (`5ttj`):** the group is cut only when EVERY op between the `q`
  and the `Do` MARKS NOTHING, and `NON_MARKING` is an ALLOWLIST rather than a
  denylist — that direction is the safety property. An operator nobody has
  classified stops the walk and degrades to cutting the `Do` alone, which is
  always safe; a denylist would silently cut a group containing an operator
  nobody thought of. It holds the graphics-state ops (all restored by the
  group's own `Q`) and the path-construction and clipping ops.
  **Note, and it is what makes the path ops safe to include:** every PAINTING
  operator is excluded, so `re W n` is crossed while `re f` is not — the
  terminator is the only difference between them. `Do` is out because a form
  draws its own content. `BDC`/`BMC`/`EMC` are out on different grounds: they
  mark no ink, but a `BDC` is optional-content membership, so cutting one
  changes what the OCG covers rather than leaving residue. Both directions are
  mutation-checked in `test/content-cutset.test.ts`, which carries a REFUSAL
  case per class — adding `f` or `BDC` to the allowlist reddens exactly one.
  **Note on what this bought, which a unit test cannot show:** until `5ttj` the
  walk crossed `cm` alone, so a `gs` or a clip left an inert `q /GS0 gs … cm Q`.
  Inert to render — the `Q` restores it — but it kept `/GS0` REFERENCED, so even
  `Remove({ sanitize: true })` could not orphan an ExtGState used only by the
  block it had just removed. `buildGsWrappedImagePdf` exists for exactly that
  and is distinct from `buildTwiceDrawnImagePdf`, whose `/GS0` is referenced by
  no operator at all: that one separates a targeted Remove from a sanitizing
  one, this one separates a sanitizing Remove from a complete one.
  **Note, measured:** widening this moved NO existing test. No fixture in the
  suite wrapped an image draw in a `gs` or a clip, which is why the bug
  survived — do not read the green suite as having covered redaction here.
- **imageedit.ts** — editing an embedded image in place, behind
  `ImageInfo.Replace` and `ImageInfo.Remove`. Object-graph and content-stream
  work only; no decoding.
  **Invariant:** it imports neither `redact.ts` nor `image.ts`. `redact.ts`
  imports `image.ts` for its decoder, so either edge closes a cycle back to
  `ImageInfo`, whose methods delegate here — which is why `imageCutSet` moved to
  `content.ts` and `sanitizeResources` to the leaf `resprune.ts` rather than
  being reached through `redact.ts`. It takes `doc`, `page` and the target
  `PdfStream` as plain arguments, so the scope walk is drivable from hand-built
  resource dicts.
  **Invariant:** `imageScopes` matches on stream IDENTITY, never on a resource
  name. `collectImages` descends into Form XObjects, so two forms may each hold
  an `Im0`; and one stream registered under two keys would be only half-handled
  by a name match. Identity is sound because `resolve` is a map lookup over a
  fully-parsed document.
  **Invariant:** both operations are scoped to the page the handle came from,
  because that is what `page.Images` already means. Replace is copy-on-write for
  the same reason — mutating the stream in place is Go's shape and would edit
  every page at once, which a per-page handle must not do silently. If the image
  was unshared the old object is orphaned and swept, so the file is the same size
  either way.
  **Invariant:** `Replace` builds the new XObject BEFORE any mutation, so a
  rejected call leaves the document byte-identical; and it builds the dict fresh,
  carrying over only `/OC`. Every other entry describes the samples being
  discarded — a stale `/SMask` would show the new picture through a stencil cut
  for the old one — while optional-content membership describes the slot. Both
  halves are measured: dropping the `/OC` carry reddens only the `/OC` case, and
  seeding the new dict from the old one reddens only the `/SMask` case.
  **Invariant:** `Remove` reaches a scope's `/Resources` THROUGH the
  `EditableContent`, never through a dict captured during the `imageScopes` walk
  — the form copy-on-write replaces that dict, so the captured one is stale and
  writing to it mutates an object the page no longer points at.
  **Note, measured and recorded because the obvious reading is wrong:** the ORDER
  of the op-cut and resource-delete loops is *not* load-bearing. `cowXObject`
  memoizes by path, so whichever runs first performs the COW and the other gets
  the same cached clone; swapping them leaves every case in
  `test/image-edit.test.ts` green. Do not write an ordering invariant here.
  **Invariant:** `RemoveImageOptions.sanitize` changes which `/Resources`
  entries survive, never which objects reach the file — `Save()` sweeps orphans
  either way. A test asserting only that the image is absent from the saved bytes
  therefore passes with the flag ignored; it is pinned by asserting an unrelated
  unreferenced `/ExtGState` BOTH ways.
  **Note:** an inline `BI…EI` image has no `/XObject` entry, so `collectImages`
  never sees one and no `ImageInfo` for it can exist — the refusal is structural
  rather than a check. Go refuses it explicitly. Tracked as its own issue.
- **inlineimage.ts** — `page.InlineImages`: enumerating and removing
  `BI … ID … EI` images. An inline image lives in NO object — no `/XObject`
  entry, no resource name, samples in the content op itself — so `ImageInfo`
  cannot represent one and `page.Images` correctly never sees it. This module
  supplies the missing addressing, a `ContentAddr` naming the op.
  **Invariant:** `InlineImageInfo` COMPOSES an `ImageInfo` over the normalized
  stream rather than reimplementing its accessors. That is what makes "an inline
  image and an XObject report their colour space by one rule" true rather than
  aspirational — and it is why `inlineImageToStream` now expands filter names
  (`AHx` → `ASCIIHexDecode`) as well as keys and colour spaces: decoding never
  needed it, since `filters.ts` accepts both spellings, but a public `Filter`
  accessor does.
  **Invariant:** `Remove` removes exactly ONE draw. An inline image IS a single
  draw, so the `ImageInfo.Remove` rule — every draw of a resource key — has no
  counterpart. Nothing is pruned from `/Resources`: there is no entry.
  **Invariant:** a handle is verified before it cuts. Removing one inline image
  shifts the op indices of every later one, so a handle from the same
  enumeration may address a different op afterwards; `Remove` compares the op at
  its address against the dict and data recorded at enumeration and throws
  `RangeError` on a mismatch. Measured load-bearing: deleting the check reddens
  the two staleness cases in `test/inline-image.test.ts` and nothing else, which
  is exactly the silent wrong-removal it exists to prevent.
  **Note:** `Replace` is deliberately absent. Re-encoding an inline image means
  choosing abbreviated filter and colour-space spellings — its own decision, and
  no caller has asked.
- **inlinedict.ts** — an inline image's abbreviated dict normalized to
  image-XObject spelling. A leaf over `types.js` alone, because FOUR unrelated
  callers need it and none should reach through the others: `redact.ts` and
  `inlineimage.ts` edit inline images, `pagerender.ts` draws them.
  **Invariant:** it expands FILTER and COLOUR-SPACE names as well as keys.
  Decoding never needed that — `filters.ts` accepts both spellings — but a
  public `ImageInfo.Filter` accessor compares against the full spelling, and an
  inline image reporting `AHx` where an XObject reports `ASCIIHexDecode` makes
  one rule read as two.
  **Note on what its absence cost:** until `6dud` the renderer built its own
  synthetic stream from the RAW dict, so every inline image using the
  abbreviations 32000-1 Table 93 MANDATES decoded to nothing and drew nothing —
  in both `ToImage` and `ToSvg`, silently.
- **resprune.ts** — `sanitizeResources` and its helpers, moved out of
  `redact.ts` so `imageedit.ts` can reach the prune without importing
  `redact.ts`. `redact.ts` re-exports it (and imports it locally beside that,
  since `export … from` creates no local binding and `redactRegions` calls it),
  so `redact.js` stays the import path it has always been. One owner: redaction
  and image removal must not disagree about what "unreferenced" means.
- **form.ts**, **formfield.ts**, **formcreate.ts**, **fieldstyle.ts**,
  **choiceopt.ts**, **fieldflags.ts**, **actions.ts**, **buttonap.ts** —
  AcroForm: `form.ts` is the
  `Form` facade (tree walk, `Get`, `GenerateAppearances`, the `Add*` entry
  points); `formfield.ts` holds the `Field` base class and its typed subclasses
  (`TextField`, `CheckboxField`, `RadioField`, `ChoiceField`, `ButtonField`)
  behind a `wrapField` dispatcher — there is no `SignatureField`, since that name
  belongs to signature.ts and a signature field is not creatable;
  `formcreate.ts` owns field *creation* — `/AcroForm` bootstrap, `/DR`+`/DA`
  defaults, hierarchical field-tree wiring and widget construction;
  `fieldstyle.ts` owns the style vocabulary (`WidgetStyle`/`FieldStyle`, their
  validation, the `/MK`+`/BS` writer, and the `/DA`+`/DR` helpers) — it is its
  own module because `Field.SetStyle` needs all of it and `formcreate.ts`
  already imports `formfield.ts`, so keeping it there would close a cycle;
  `choiceopt.ts` is the `/Opt` vocabulary — `ChoiceOption`, its validation, and
  the single writer/parser pair for the two-shape entry grammar — split out for
  the same reason, since `ChoiceField.AddOption` needs it and it must stay
  readable from `appearance.ts` too.
  **Invariant:** an `/Opt` entry is read and written in exactly one place. The
  export half is what `/V` carries and the display half is what gets drawn;
  every consumer that re-derived that grammar inline got one of the two halves
  wrong, which is how a list box came to highlight nothing and a combo to draw
  the export value.
  **Invariant:** creation validates every argument *and* the whole field path
  before allocating any object, so a rejected call leaves the document
  byte-identical.
  **Invariant:** appending into an *indirect* array mutates that array's own
  object, not the dict that points at it — so `/AcroForm /Fields` and a page's
  `/Annots` each join an incremental-update delta on their own account. This is
  what the optional `TouchedObjects` seam on `ensureAcroForm`/`appendField`/
  `attachWidget` is for; signing is the only caller that passes one, because
  `Save()` rewrites the whole reachable model. Record only allocations and the
  appended field or widget is silently dropped from the signed output. Creating intermediate nodes allocates, so the path is walked
  twice — a single fused pass strands orphan nodes when a conflict is found
  deeper down.
  **Invariant:** terminal-ness cannot be read off `/Kids` alone. A kid with `/T`
  means an intermediate node and kids without `/T` mean widgets, but an *empty*
  `/Kids` is ambiguous: a node we just created stays empty until its first child
  is appended, and calling that terminal rejects every sibling after the first.
  With no kids, fall back to what the node claims to be (`/FT` or `/Subtype`),
  which an intermediate node has neither of.
  **Invariant:** `Field.ff` is the effective `/Ff` captured during the tree
  walk, and `GenerateAppearance()` reads it rather than the dict. Any code that
  changes a flag must go through `setFlag`, which updates both — writing only
  the dict stores the new flag and draws the old one.
  **Invariant:** a password field's value must never reach a content stream.
  Masking lives in `generateFieldAppearance`, not at the creation call sites, so
  `GenerateAppearances` and `FlattenForm` get it too — flattening otherwise
  bakes the plaintext into permanent page content, where no viewer will ever
  mask it again.
  **Invariant:** `synthOnState` guesses a button's on-state name (`/AS`, then
  `/Opt[i]`, then `/V`, then `'Yes'`) and exists only for documents we did not
  author. Creation must never route through it — it calls `buildButtonAP` with
  the export name outright, via the `buildAP` hook on `FieldSpec`. An unchecked
  checkbox with a custom export value is the case that exposes the difference:
  every input the guess reads is `Off`, so it would key the appearance `Yes`.
  **Invariant:** a radio group validates every option before allocating
  anything. Rejecting option 3 after the parent and two kids are wired strands
  all three — the parent in `/AcroForm /Fields` and the widgets in page
  `/Annots`.
  **Invariant:** a `/Opt` entry may be a plain string or an `[export, display]`
  pair, and `/V` holds the **export**. Any appearance code that keeps only the
  display half silently mismatches — a list box highlights nothing and a combo
  draws the export value. `parseOptions` (choiceopt.ts) parses both halves into
  `NormalizedOption`, and `displayOf` picks the display; match on export first,
  then display, and draw the display. (This invariant named a `choiceEntries`
  function until `kf8h.1` — no such function has ever existed in `src/`.) `/V` may also be an *array* on a
  multi-select list box, which `textOf` renders as `''`; use `valueStrings`.
  **Invariant:** a restyle must not route through `generateFieldAppearance` for
  the two button families. That function preserves an existing `/AP` (the
  `hasNStates` guard) so an author's artwork survives a value change — but a
  restyle is the request to replace it, and a push button's face is not
  value-driven at all: it must be rebuilt from `/MK` plus the icon already in
  its `/N` resources (`regeneratePushButtonAP`), or restyling silently drops
  the icon and the captions.
  **Invariant:** `/A` actions have exactly one encoder and one parser, in
  `actions.ts`, shared by link annotations, push buttons and field `/AA`
  triggers. They were inline in `addLink` and `LinkAnnotation.Action` and
  reusable from neither, which is why a link carrying a submit action used to
  read back as `undefined`. A SubmitForm `/F` is a `/FS /URL` filespec, not a
  bare string.
  **Invariant:** a field's `/AA` is written key by key, never whole. A created
  field is a *merged* field/widget dict, so one `/AA` carries the annotation's
  triggers (`/E`, `/X`, …) beside the field's four (`/K /F /V /C`); replacing
  the dict silently drops the annotation half, and deleting it when only the
  field keys are gone drops it too.
- **graphics.ts**, **pagecontent.ts**, **imageembed.ts**, **stamp.ts**,
  **layout.ts**, **textdecor.ts**, **gradient.ts**, **pageformat.ts** — the
  content-authoring layer: a buffered `PageGraphics` vector
  builder, shared page-content helpers (resource/`/ExtGState` registration,
  `/Contents` splicing), JPEG/PNG image embedding (`AddImage`), Standard-14 text
  stamping (`AddText`, any of the 12 Latin faces with WinAnsi) and wrapped
  multi-line text blocks (`AddTextBlock`), backed by `layout.ts`, the pure
  word-wrap/line-break/measure engine that flows text into a box and returns the
  overflow remainder. `textdecor.ts` owns the decoration vocabulary shared by
  every text producer — per-font `VMetrics` and the `underline`/`strikethrough`/
  text-tight `background` rect geometry — so a stamp, a flow paragraph, a table
  cell and a TOC row all decorate from one rule set, and — since `gl6o.3.1` —
  the `TextRun` model behind rich inline styling.
  **Invariant:** there is ONE wrapping engine, `layoutRuns` in layout.ts, and
  `layoutText` is a one-run wrapper over it. floatbox.ts and tableauthor.ts
  *measure* through it while stamp.ts *paints* through it, so a second wrapper
  lets a box measure one way and paint another.
  **Invariant:** a rich block's break opportunities are found on the
  CONCATENATED run text, never per run — `**bold**text` is one word and must not
  break at the style boundary. Widths are summed per segment, which agrees
  exactly with measuring the whole string for the WinAnsi and Identity-H drivers
  (a string's width is the sum of its glyph advances) and is what lets the
  single-run path stay byte-identical. It would NOT hold for a shaping driver,
  which is one more reason shaping stays single-run and throws with a run list.
  **Invariant:** lines are lists of word *units*, not contiguous text spans,
  because the engine collapses runs of spaces — `a  b` lays out as `a b`. A
  span-based line preserves the double space and moves the bytes of every
  existing caller. The separator space belongs to the run that precedes it,
  which is the run whose `Tf` is in force when it paints.
  **Invariant:** `TextRun` lives in textdecor.ts, not layout.ts. It names an
  `AuthoringFont`, which stamp.ts defines, and stamp.ts imports layout.ts — the
  reverse inverts that dependency. layout.ts works over resolved runs carrying a
  `FontDriver` and never learns what a font object is.
  **Invariant:** a run inherits every property it does not state from the block,
  and a block whose runs carry no decoration of their own still emits through
  `blockLineBoxes`, not the per-run path. That fast path is what keeps output
  byte-identical for every caller that never asks for runs — asserted directly
  by `test/rich-runs-identity.test.ts`, which hashes emitted page bytes for
  eight existing call sites and was confirmed to go red on a 0.01pt nudge to
  `alignOffset`.
  **Invariant:** a line's height is `max(leading, maxRunSize *
  leading / blockFontSize)`, computed in `layoutRuns` while wrapping —
  that function decides which lines fit the budget, so a caller computing
  heights afterwards would disagree with the wrapping about what fitted. The
  `max` collapses to `leading` for any line whose runs sit at or below the
  block size, which is every line the string path and every pre-`g61q` caller
  produces; that collapse, not a recorded hash, is why the change is
  byte-identical. Note a fixture for the floor needs EVERY run on the line to be
  small — a line mixing a 10pt and a 4pt run has `maxFontSize` 10 and yields
  `leading` either way.
  **Invariant:** a line's baseline sits `maxFontSize` below its band top, NOT
  the block's `fontSize`. With the block size, an oversized run on line 0 leaves
  the box entirely rather than merely crowding a neighbour — measured at 2pt
  above the previous line's top for a 24pt run in a 10pt block. A test for this
  must assert the top edge EXACTLY: dropping the baseline by the line's height
  instead pushes the whole block down, which still satisfies an upper bound.
  **Invariant:** `usedHeight` is the SUM of the line bands, and the flow engine
  reads it without re-deriving it — which is why pagination, keep-with-next and
  the column budget needed no change at all when leading became per-line.
  `gradient.ts` is the
  colour-stop model shared by the two gradient *producers*, `PageGraphics`
  authoring and SVG import; it builds DIRECT `PdfDict`s and touches no
  `Document` (nothing to do with `svgrender.ts`, which is PDF→SVG).
  `pageformat.ts` is the named page-size vocabulary (`PageFormat.A4`,
  `.custom`, `.landscape()`) used by blank-page creation and `Flow`.
- **tiling.ts** — the tiling-pattern model shared by the authoring layer: option
  validation, the lattice `/Matrix`, and the `PatternType 1` dict.
  **Invariant:** pure. It builds a DIRECT `PdfDict` and touches no `Document`,
  exactly as `gradient.ts` does for colour stops, which is what keeps every rule
  here testable from numbers rather than from a built file.
  **Note the direction, and it is a false friend:** `svgpattern.ts` resolves an
  SVG `<pattern>`'s attributes into a tile rect for IMPORT. This is AUTHORING,
  it starts from declared numbers, and the two share no code at all.
  **Note:** `xStep`/`yStep` default to the tile size, and stating them is how a
  caller asks for gaps (larger) or overlap (smaller) — so they are validated as
  `> 0` rather than defaulted silently.
- **flow.ts**, **floatbox.ts**, **floatstack.ts** — multi-column document flow
  (`doc.NewFlow`): `flow.ts` owns the element list (`AddParagraph`,
  `AddHeading`, `AddList` incl. nesting, `AddImage`, `AddColumnBreak`,
  `AddFloatBox`, `AddFloatingBox`) and the single-shot `Render()` that appends
  freshly sized pages
  and paginates across columns, optionally emitting `/H1`–`/H6`, `/P`, `/L` and
  `/Figure` structure. `floatbox.ts` is the `FloatingBox`
  (`doc.NewFloatingBox`) — a self-measuring bordered box of paragraphs and
  images; `floatstack.ts` is the pure arithmetic behind wrapping: which bands
  the active floats exclude, where those bands end, and where a new box may go.
  It knows nothing about PDF or drawing, so the geometry that is silently wrong
  when reversed is testable without building a file.
  Note the two placements are different features on one box: `AddFloatBox` is a
  *side* float (narrows the channel, needs floatstack's band bookkeeping),
  `AddFloatingBox` is *in-flow* (consumes the band outright, excludes nothing,
  and never splits — a callout broken across a column reads as a fault, and a
  box's border and background have no defined way to continue).
- **flowelement.ts**, **flowblock.ts**, **flowplace.ts** — the Flow element
  protocol and the three block types Markdown needed and Flow lacked.
  `flowelement.ts` holds `FlowElement`/`PlaceContext`/`PlaceResult` and the
  shared spacing validators; it is its own module so `flowblock.ts` can
  implement the protocol while `flow.ts` imports its builders back, closing no
  cycle (the split `fieldstyle.ts` and `bordersides.ts` already make).
  `flowblock.ts` is `rule` (thematic break), `codeBlock` (preformatted) and
  `quote` (block quote); `flowplace.ts` is `placeElements`, the Render loop with
  columns, floats, keep-with-next and page creation removed, so a caller can lay
  elements into ONE rect and get the overflow back.
  **Invariant:** a container never holds and paginates its children. The engine
  is a flat queue, and a container with its own pagination loop is how a quote
  comes to break across a column under one rule and a list under another. A
  quote lowers to a flat array of single-child decorators, each owning an indent
  and its own ink; a split quote therefore needs no special case, and nesting is
  the decorator wrapping itself.
  **Invariant:** there is ONE builder per construct. `Flow.AddX`, a list item's
  `blocks` and the Markdown mapper all construct content, and three definitions
  of "a list" is three chances for them to disagree.
  **Invariant:** a code block substitutes U+00A0 for every space, in
  `preformat`, once. `layoutRuns` COLLAPSES runs of spaces (`a  b` lays out as
  `a b`), which is fatal to indentation, and a preserve-spaces mode would put
  every existing caller's byte-identity at risk. U+00A0 costs nothing instead:
  `winAnsi[0xA0]` is U+00A0, WinAnsiEncoding names that code `/space` (Annex D
  Table D.2's documented duplicate, recorded in `WIN_HIGH`), and its AFM advance
  is identical — 278 in Helvetica, 600 in Courier. Each source line then becomes
  one unbreakable unit, and an over-wide line falls through the existing UAX #14
  path instead of running off the page.
  **Invariant:** a list item's marker is owned by per-item state, not by one
  element. An item lowers to a body plus its `blocks`, and whichever draws FIRST
  paints the marker — with a private flag the text body owns it, so an item
  opening with a code block draws none at all.
- **mdstyle.ts**, **mdruns.ts**, **mdflow.ts** — Markdown rendering
  (`flow.AddMarkdown`, `page.AddMarkdown`, `doc.AddMarkdown`). Three pure layers
  lowering an `MdDocument` to a flat `FlowElement[]`: `mdstyle.ts` is the style
  vocabulary and its defaults, `mdruns.ts` maps inlines to `TextRun`s, and
  `mdflow.ts` maps blocks. Note the direction — nothing here parses; that is
  `markdown.ts`.
  **Invariant:** `mdflow.ts` knows nothing about columns, rects or pagination.
  Both consumers take its array, which is what makes three entry points one
  implementation — asserted directly by rendering one source through all three
  and comparing extracted text.
  **Invariant:** emphasis selects from a four-face FAMILY. There is no synthetic
  slant or emboldening here, so a Standard-14 base derives its family by name
  (including from a non-roman member — emphasis is relative to the family) and
  an embedded face falls back to `regular`, showing no change rather than a
  missing glyph.
  **Invariant:** a run states only what it CHANGES. Plain text is one run
  carrying nothing but `text`, which is the closest a run list gets to the
  string path; setting the block's own font on every run would restate it
  needlessly and move bytes.
  **Invariant:** a construct that does not render names itself in `skipped` and
  still contributes its text where it has any — a table, raw HTML, an inline or
  unresolvable image. Visible content beats a silently dropped subtree, the rule
  `svgdraw.ts` already sets. `MdList.tight` is the one mapping input no HTML
  oracle can see, which is why the loose-versus-tight spacing is asserted on
  rendered heights.
  **Invariant:** a link's destination is part of its run identity. `stateKey`
  folds the URI in, so `[a](x)[b](y)` stays two runs — merge them and the first
  destination is lost and the whole phrase points at the second, which renders
  perfectly and links wrongly.
  **Invariant:** a table cell's inlines go through `inlineRuns`, the same
  function a paragraph uses. A second inline mapper is how a cell comes to
  render bold where a paragraph renders code.
  **Invariant:** the header row sets `setRepeatingRowsCount(1)` and lets `/TH`
  with column scope follow from `CellOptions.header`'s documented default.
  Saying both is two statements that can drift apart.
- **runlink.ts**, **flowtable.ts** — the two things `gl6o.3.3` needed and the
  authoring layer lacked. `runlink.ts` turns a laid-out run into a `/Link`
  annotation and its structure element; `flowtable.ts` is the table
  `FlowElement`. Note `runlink.ts` is object-graph work while `stamp.ts` is
  layout and ink — the split `redactannots.ts` makes against `redact.ts` — and
  it holds `stamp.ts`'s dependency on `annotation.ts` to one symbol; nothing in
  `annotation.ts`'s transitive graph reaches `stamp.ts`, so the edge closes no
  cycle.
  **Invariant:** a link rect and a text background are ONE geometry —
  `vmetricsFor` scaled by the RUN's own `fontSize`, not the block's. A second
  derivation drifts, and the drift is invisible until someone compares a link's
  clickable area with its underline.
  **Invariant:** a link rect stops at its run's last GLYPH, while run decoration
  spans the run's whole segment. They differ on purpose: the separator space
  between two words belongs to the run that paints it, so both would otherwise
  include it — but a clickable 3-6pt of blank space is felt directly (a hand
  cursor over nothing) where an underline's is not, and decoration is shipped
  typography fenced by `rich-runs-identity`. `SegmentBox.trailing` carries the
  amount; only `runLinkBoxes` subtracts it.
  **Invariant:** that trim matches U+0020 only, never `\s`. JavaScript's `\s`
  matches U+00A0, which `preformat` substitutes for every space in a code block
  so its indentation survives `layoutRuns` collapsing runs of spaces — a glyph
  the author asked for, not a separator. It also agrees with `justifySpacing`,
  which counts `ch === ' '` exactly. Note the guard for this needs the FULL
  advance asserted, not `toBeGreaterThan`: a trimming build lands 4e-15 above
  the untrimmed width on floating-point residue alone, so the loose form reports
  green with the bug present. Measured, not reasoned about.
  **Invariant:** the trim subtracts the `Tw` those spaces gained as well as
  their nominal advance, because `SegmentBox.width` already includes it.
  Measured: 3.34pt of overshoot unjustified, 6.16pt justified, so a `Tw`-blind
  trim leaves nearly half the defect in the case that shows it worst.
  **Invariant:** a justified line's run positions are not its measured ones.
  `Tw` spreads slack across spaces and the error ACCUMULATES, so a box computed
  from `seg.width` alone marches left of the glyphs, worst for the last run on
  the line. `segmentBoxes` is the single walk that reads the same
  `justifySpacing` the emitter reads — which is why run decoration and link
  rects share it rather than each keeping a copy. Two things a fixture for this
  must get right, both found the hard way: the final line of a block is a
  `hardBreak` and is never justified, so a decorated run on the LAST line cannot
  show the defect at all; and decoration and links leave no trace in the text
  state, so two same-font runs merge into one `TextFragment` whose quad spans
  both — give the run under test its own font or the anchor is the pair's.
  **Invariant:** ONE `/Link` element per linked run, not per rect. A link broken
  across a line break is one link; two elements have a screen reader announce it
  twice. Its glyphs' MCID is *reserved* against the block being laid out
  (`reserveContentMcid`) and *retargeted* onto the `/Link` (`retargetMcid`),
  because the reserving element and the owning element differ — the `/Link` does
  not exist until the block is laid out.
  **Invariant:** an untagged block emits no `BDC` at all; the link split fires
  only for a linked run in a TAGGED block. Note where that is actually fenced:
  dropping the guard leaves every `test/rich-runs-identity.test.ts` hash green,
  because all of those cases are untagged and a tagged-only leak is invisible to
  them. `test/rich-runs-link-tagged.test.ts`'s "emits no /Span when no run
  carries a link" is the only thing in the suite that goes red.
  **Invariant:** `page.AddTable` paginates against the page CropBox and a flow
  element against a rect; the two models contradict each other and cannot be one
  function. The PAINTING can be, and is — `paintRowSlice`, shared by both.
  **Invariant:** a split table carries its `TableTagger` forward, which is what
  keeps it one `/Table` rather than one per column.
  **Invariant:** a tagged flow element tags its own ink or artifacts it — there
  is no third option. A code block did neither from `gl6o.3.2` to `gl6o.4` and
  no test noticed: `UntaggedContent` is a per-page WARNING that names no
  element, and the only Markdown fixture reaching the validator had no code
  block in it. `test/flow-tagging.test.ts` sweeps every construct and asserts
  the untagged count beside the structure types — measured as load-bearing, and
  more sharply than expected: creating the `/Code` element and *passing* it to
  `flowTextBlock` are separate steps, so the un-fixed code still builds
  `/P` > `/Code` and the type list still matches exactly. The elements are
  simply hollow. A type list can tell neither a populated element from an empty
  one, nor a missing element from an artifacted one.
  **Invariant:** a quote's `/BlockQuote` is per-QUOTE state shared by its
  siblings, and it survives a split. Per-element state yields one element per
  paragraph (measured: 3 for a three-paragraph quote, 40 for a split one). Same
  holder pattern as a list item's marker and a paginated table's `TableTagger`.
  **Invariant:** `/Code` is inline level and `/BlockQuote` is grouping level
  (32000-1 §14.8.4.3 and §14.8.4.1), so a code block is `/P` > `/Code`.
  `structvalidate.ts` has no block/inline nesting rule, so a bare `/Code` passes
  our own report — do not cite it as evidence here.
  **Invariant:** `FlowOptions.lang` writes the flow's `/Sect`, never the
  catalog. `EffectiveLang` walks ancestors before falling back to
  `Document.Lang`, so the `/Sect` is enough — and a flow appended to an existing
  document must not relabel that document. It requires `tagged: true` and throws
  otherwise, because an untagged flow has no `/Sect` and the option would
  silently do nothing.
- **markdown.ts**, **mdast.ts**, **mdblock.ts**, **mdinline.ts**, **mdscan.ts**,
  **mdentity.ts**, **mdtable.ts**, **mdgfm.ts** — CommonMark 0.31.2 parsing
  (`parseMarkdown`), the spec's
  Appendix A two-phase algorithm: `mdblock.ts` walks lines over a stack of open
  blocks, `mdinline.ts` then runs a delimiter stack for emphasis and a bracket
  stack for links over each leaf's raw text. Nothing here produces PDF — the
  renderer is `gl6o.3`.
  `parseMarkdown(src, { gfm: true })` adds the five GitHub Flavored Markdown
  extensions (`gl6o.2`), whose rules live in two pure modules the phase modules
  call into: `mdtable.ts` owns the table block grammar (delimiter row,
  alignment, cell splitting, row building) and `mdgfm.ts` owns strikethrough's
  run rule, the extended autolinks and `filterDisallowedHtml`. The task-list
  marker is the one extension small enough to live at its hook, in `mdblock.ts`.
  The spec's 24 extension examples are far too thin to pin this grammar, so
  rules the prose does not settle are transcribed from `cmark-gfm`'s own
  `extensions/` sources rather than guessed — every such port names its upstream
  function in a comment.
  **Invariant:** `gfm` off must leave the output byte-identical. Every hook is
  guarded, and `test/commonmark-spec.test.ts` runs the 652 cases with no options
  at all, so the default path is the one conformance pins. A second run with
  `{ gfm: true }` asserts an explicit five-entry divergence list with a reason
  each — all five are Autolinks cases, two of them CommonMark's own "this is not
  an autolink" counter-examples. An extension leaking into an unrelated
  construct is a red build rather than a discovery years later.
  **Invariant:** a table's header is the paragraph's **last** line, and a
  pipeless line still continues the table. Both are cmark-gfm's behaviour and
  neither follows from the prose: earlier paragraph lines split off into a
  paragraph of their own, `bar` under a table is a one-cell row padded to width
  rather than a paragraph, and only a blank line or another block structure ends
  the table. `'table'` is in `ACCEPTS_LINES` but excluded from
  `incorporateLine`'s `matchedLeaf` test, which is what lets a heading interrupt
  it; and `incorporateLine`'s cheap "can this line start a block" gate needs `|`
  and `:` added under GFM, or `tryStart` is never reached and every table
  silently stays a paragraph.
  **Note, measured rather than assumed:** what keeps `foo\n---` a setext heading
  is `scanDelimiterRow`'s pipe requirement, **not** the table branch's position
  after the setext branch — moving it above leaves all 652 cases green. The two
  are redundant defences, so breaking either one alone proves nothing.
  **Invariant:** strikethrough rides the SAME delimiter stack as `*` and `_`; a
  post-pass cannot get `*a~~b*c~~` right. Runs of one or two tildes only, and
  the opener and closer must be the same length or nothing wraps.
  **Invariant:** the extended-autolink pass never descends into a `link`. It is
  the one extension where a post-pass is correct, because code spans and links
  are already their own node types by then, so the two contexts an autolink must
  not fire in are structurally excluded rather than re-derived. One divergence
  from cmark-gfm is recorded rather than hidden: it refuses to autolink while a
  bracket is open, so `[a www.b.com]` with no matching reference stays plain
  text there and becomes a link here.
  **Invariant:** the tag filter is a RENDERING transform and does not touch the
  tree. `MdHtmlBlock`/`MdHtmlInline` keep their literal raw, exactly as a link
  destination is stored unencoded; `filterDisallowedHtml` is public API whose
  only in-repo caller is the oracle, on cmapcodec.ts's terms — one owner for a
  rule beats two copies of a tag list.
  **Invariant:** an HTML tag, an entity, a backslash escape, a link
  destination, a link title and a reference label each have exactly one
  scanner, in `mdscan.ts`. Both phases need the HTML grammar — the block phase
  for HTML block conditions 1–7, the inline phase for `html_inline` — and a
  reference definition's destination must parse identically to an inline
  link's. Two copies differ only on the balanced-parenthesis and pointy-bracket
  forms, which no HTML rendering reveals.
  **Invariant:** escapes and character references resolve in ONE pass, not two
  sequential ones. `\&copy;` must stay the literal text `&copy;`, so an `&` an
  escape produced must never be offered to the entity scanner.
  **Invariant:** the parser never throws. Every string is a valid CommonMark
  document, so there is no `PdfParseError` path here — unlike every other
  parser in `src/`. Damage shows up as literal text.
  **Invariant:** `unicodePunctuation` is P\* **and** S\*. CommonMark folded
  symbols into the definition at 0.31.0 and the class decides emphasis
  flanking, so a 0.30-era implementation mis-emphasizes around `$`, `+` and
  `©`. Only **one** spec case covers this, which is why the table is asserted
  directly in `test/unicode-data.test.ts` rather than left to the suite.
  **Invariant:** a link label is matched by full **case folding**, not
  `toLowerCase`. `[ẞ]` must find `[SS]: /url`; folding maps both to `ss` while
  lowercasing maps `ẞ` to `ß`. `caseFold` in unicode-data.ts holds only the
  code points where the two differ, emitted by `gen-ucd.mjs` from
  `CaseFolding.txt` at the pinned version.
  **Invariant:** the HTML **comment** grammar is 0.31.2's, which is looser than
  0.30's: `<!-->` and `<!--->` are comments and a body may contain `--`.
  Implementing the older rule costs two Raw HTML cases and nothing else, so it
  is easy to get wrong and hard to notice.
  **Invariant:** `NodeList.collect` takes an explicit start rather than
  defaulting `undefined` to the head. An empty range legitimately starts at
  `undefined`, and defaulting it returns the WHOLE list — which is how `[]()`
  came to render as `<a href="">[</a>`.
  **Invariant:** a destination is stored **unencoded** in the AST, ready for a
  PDF `/URI`. HTML's percent-encoding lives only in the test-only oracle.
  **Note, deliberately recorded as unproven:** the block phase caps container
  nesting at 1000 and that cap *is* load-bearing — removing it throws
  `RangeError` on nested block quotes. The emphasis algorithm's
  `openers_bottom` is **not**: removing it leaves all 652 cases passing and
  changes no timing on seven adversarial inputs, including cmark's own
  "openers and closers multiple of 3". It is retained because the spec
  specifies it. Do not cite the green suite as evidence that it works.
  **Invariant:** `test/helpers/md-html.ts` is a test-only conformance oracle,
  not an output format — the suite's expectations are HTML, so conformance is
  unmeasurable without one, and nothing in `src/` may import it. It builds
  output through a `cr()` that appends a newline only when one is not already
  there: in a **tight** list item a paragraph contributes bare inlines with no
  line of its own, while every other block still starts on a fresh line
  (`<li>a</li>` but `<li>\n<pre>`). A renderer that inlines the whole item gets
  a dozen cases wrong and reads exactly like a parser bug.
  **Invariant:** the oracle is blind to list **tightness**, which drives
  paragraph spacing in Flow and is what `gl6o.3` depends on.
  `test/markdown-ast.test.ts` covers what the rendering collapses.
- **mdexport.ts** — PDF→**Markdown** (`Document.ToMarkdown`, `Page.ToMarkdown`),
  a serializer over `docmodel.ts` plus `escapeMarkdown`. Note the direction: the
  eleven `md*.ts` modules above are all Markdown→PDF and share no code with this
  one, the same hazard the `svgembed.ts`/`svgrender.ts` split carries.
  The escaping itself lives in **mdescape.ts** — its own module because
  `tablemodel.ts` needs the cell escaper and is a leaf, so importing
  `mdexport.ts` would close a cycle (`mdexport` → `docmodel` → `tablemodel`);
  the same split `fieldstyle.ts`, `choiceopt.ts` and `bordersides.ts` make.
  **Invariant:** every escaper is specified by our own parser —
  `parseMarkdown(escapeX(s))` must yield text equal to `s`. A hand-written
  character list makes both under- and over-escaping invisible.
  **Invariant:** there are two escapers because there are two contexts, and the
  difference is not cosmetic. `escapeMarkdown` is for BLOCK text and escapes the
  line-leading openers (`#`, `>`, `-`, `1.`); `escapeTableCell` is for a GFM
  cell, whose content parses as inline only, so it escapes none of them — a cell
  reading `3.5` would otherwise ship as `3\.5` — and instead escapes `|`, which
  is structural there and nowhere else.
  Measured, and worth keeping straight: `escapeTableCell`'s `|` rule IS pinned
  (a cell round trip goes red without it), while `escapeMarkdown`'s `|` is
  **not** — a lone pipe is not structural in a paragraph without a delimiter
  row. The block rule is retained for byte-identity with the pre-`no93.3`
  escaper, asserted directly, and is otherwise unpinned; do not read the green
  suite as covering it.
  **Invariant:** an unknown structure type is transparent — its children are
  emitted as sibling blocks — never dropped. Everything in a tagged tree hangs
  under a `Document` wrapper, so dropping unknown types empties the output
  entirely, which is what makes this cheap to verify.
  **Invariant:** the option bag is `MarkdownExportOptions`, not
  `MarkdownOptions`, which `markdown.ts` already exports for the opposite
  direction and `mdflow.ts` already extends. The result type is
  `MarkdownExportResult` for the same reason — `mdflow.ts` owns `MarkdownResult`
  for Markdown→PDF, and the collision is a compile error rather than a subtle
  one only because both are exported from `index.ts`.
  **Invariant:** image identity is a hash of the ENCODED BYTES, never the
  `PdfStream` object. A merged document holds distinct stream objects with
  identical content, so keying on identity re-encodes each of them and, in
  external mode, writes the same picture to several files.
  **Note, measured:** inline dedup is a COST saving and is invisible in the
  output — two copies of one picture encode to the same bytes and so yield the
  same `data:` URI with or without the cache. Only the external cases observe
  sharing, as a single asset. Do not read the inline test's green as covering
  the cache.
  **Invariant:** `ToMarkdown` throws on `images: 'external'` rather than
  returning links to files nobody wrote — a string has nowhere to hand the bytes
  back, and a document that looks fine and is broken is worse than a refused
  call. `ToMarkdownAssets` is the entry that returns them, and `ToMarkdown` is a
  thin wrapper over the same render so the two cannot drift.
  **Invariant:** `imagehref.ts` has one decoder. `encodeImage` returns bytes plus
  a media type — which is what tells the external path its extension, a `.png`
  holding JPEG bytes being a file no viewer opens — and `imageHref` is the base64
  wrapper over it, so the inline and external paths cannot disagree about what an
  image is.
  **Invariant:** a code fence is `max(3, longest backtick run inside + 1)`
  backticks. A fixed three-backtick fence lets a block containing a fenced
  example break out of itself, producing valid Markdown that says something
  else. There is no info string: a PDF records no language, and guessing one
  lexically would be a claim the document does not make. Code text is emitted
  verbatim and never escaped — inside a fence there is nothing to escape, and
  `escapeMarkdown` would fill it with backslashes.
  **Invariant:** a list is loose — items blank-line separated — only when an
  item holds more than one block that is **not** a nested list. Counting the
  sub-list would make every nesting parent loose, and the blank lines that
  follow make it loose for the parser too, so a tight list with sub-items would
  not survive its own round trip.
- **bordersides.ts** — the shared "a rectangle with a subset of its edges drawn"
  vocabulary (`BorderSides`, `resolveBorderSides`, `countBorderEdges`,
  `checkBorderSides`). Its own module because table cells and the table frame
  (tablerender.ts) and a floating box's chrome (floatbox.ts) all need it, and a
  float box importing the *table-authoring* module for a border type is a
  dependency nobody reading either file would expect. `tableauthor.ts`
  re-exports it so `BorderInfo` and its `sides` stay one import for callers.
  **Invariant:** all four edges keep the single `re` shorthand. That is what
  makes an unset `sides` byte-identical to a border written before the option
  existed, in both consumers.
- **toc.ts**, **tocrender.ts**, **tocstruct.ts** — table of contents
  (`page.AddTOC`), split exactly like tableauthor/tablerender: `toc.ts` is the
  model, validation and measurement (it reads the `Document` for two read-only
  things only — `/PageLabels` for default labels and page-range validation of
  the GoTo targets), `tocrender.ts` paints and paginates through `stampText` and
  `addLink` (no new rendering primitives), and `tocstruct.ts` emits the
  `/TOC` + `/TOCI` subtree for `{ tagged: true }` — its own module so that
  threading a level stack through `paintRow` does not blur "where the ink goes".
- **tableauthor.ts**, **tablerender.ts** — the table *authoring* layer (distinct
  from the extraction stack below): `createTable` builds a page-independent
  `TableBuilder` of rows/cells over a table→row→cell style cascade (borders,
  background fills, H/V alignment, padding) with fixed/fractional column widths
  and `colSpan`; `tableauthor.ts` owns the model plus `measure`
  (word-wrap-driven row heights, image-aware) and `continuationFrom` (the
  re-drawable overflow remainder, which embeds repeating-header rows).
  `tablerender.ts` (`page.AddTable`) lays it out and paints each page block
  (backgrounds → images → text → borders) through the stamping/`PageGraphics`
  primitives, with manual `remainder` or `autoPaginate` pagination, repeating
  header rows (`setRepeatingRowsCount`), and per-cell images (`cell.setImage`,
  aspect-fit via `drawBuiltImage`).
  `tabletag.ts` is the authoring-side structure module behind
  `AddTable({ tagged: true })` — the `/Table` > `/TR` > `/TD`|`/TH` subtree, its
  `/Scope` and `ColSpan` attributes, and the `/Table` reuse that keeps a
  paginated table one table. Its own module for tocstruct.ts's reason: threading
  the tree through `paintPlaced` would blur "where the ink goes". Note the
  direction — `tablestruct.ts` is table *extraction*, and the two never import
  each other.
- **tablespan.ts** — the occupancy grid behind an AUTHORED table's spans: where
  each cell's top-left corner lands, how many physical columns the table has,
  where it may legally be cut, and how a spanning cell's height shortfall is
  settled. Pure arithmetic, importing nothing and touching no PDF object — the
  split `floatstack.ts`, `booklet.ts` and `docinfer.ts` already make.
  **Invariant:** it is a MODULE rather than methods on `TableBuilder`, because
  the safe-break set has two consumers that must not import each other:
  `tablerender.ts` paginates against the anchor page's CropBox and
  `flowtable.ts` against a rect. Those pagination rules contradict each other
  and cannot be one function — but "where may this table be cut" is the same
  question for both.
  **Note the direction:** `tablegrid.ts` is the pure grid leaf the two table
  *detectors* share and it works the OPPOSITE way, inferring spans from gaps in
  ruling lines. Authoring starts from declared spans and needs no geometry at
  all. The two share a name and no code.
  **Invariant:** `applySpanDeficits` settles spans in order of increasing LAST
  COVERED row, ties by increasing start row, and the order is not cosmetic.
  Satisfying the earlier-ending span first means a longer overlapping one then
  measures against the already-enlarged rows and needs less, or nothing;
  reversed, the long span is satisfied first and the short one finds its rows
  unchanged and adds a second shortfall for height that is already there.
  **Invariant:** `columnCount` is an OUTPUT of the placement walk, not an input
  to it, which is why the grid grows rather than being allocated up front — a
  `colSpan` running past the declared columns widens the table.
  **Invariant:** auto-fit measures at RESOLVE time, not at build time. The
  column budget arrives when the table is placed and differs between a
  one-column and a two-column flow, and again on a continuation — so widths
  computed up front could only be fractions, and a fraction cannot carry the
  min-content floor, which depends on the total.
  **Invariant:** `continuationFrom` carries the auto-fit flag as well as the
  column specs. Without it the second page of a paginated table reverts to equal
  fractions and its columns visibly jump mid-table.
  **Invariant:** an explicit `setColumnWidths` outranks `autoFitColumns` — a
  stated width is a decision, a measured one is a guess — and a `colSpan` cell
  sizes no column at all, since its width belongs to none of them.
  **Invariant:** auto-fit is opt-in for hand-built tables and default for
  Markdown. GFM declares no widths so Markdown has nothing to lose, while
  `page.AddTable` callers have `setColumnWidths` and a byte-identity fence.
  **Invariant:** a cell's max-content is its longest LINE, not its whole string
  — `addCell` takes arbitrary text and `mdruns.ts` maps a hard break to `'\n'`,
  and measuring across one would demand a column fitting every line at once. Its
  min-content is its longest word found on the CONCATENATED run text, because a
  word may span a run boundary, with each piece measured at its own run's font.
  **Note on fixtures here, both measured the hard way:** Helvetica and
  Helvetica-Bold give `M`, `I` and the digits the *same* advance, so a
  per-run-font test built on those cannot tell the two faces apart and passes
  whatever the code does (`l` is 222 against 278). And a space-free string
  pushes min-content past the budget, landing in the equal-shares fallback
  rather than the proportional-shrink branch a test may mean to cover.
  **Invariant:** a cell's `/Figure` is appended when the cell element is created,
  not in the image pass. `paintPlaced` draws every image before any text, so
  allocating it later would put the text MCID ahead of the figure in the cell's
  `/K` and reverse its reading order.
  **Invariant:** the two `PageGraphics` passes open their `/Artifact` sequence
  only when they actually draw. `apply()` no-ops on an empty part list but
  `BeginArtifact` pushes a part, so an unconditional call emits a bare
  `/Artifact BMC EMC` into a table with no backgrounds — moving bytes for no
  content, and breaking the byte-identical guarantee the untagged path relies on.
- **barcode.ts**, **qr.ts**, **barcodeplace.ts** — barcode generation and
  placement (`page.AddBarcode`): the pure geometry models in `barcode.ts`
  (Code 128, EAN-13/8, UPC-A) and `qr.ts` (QR: GF(256)/Reed–Solomon, mode/version
  selection, masking) produce a `LinearBarcode`/`MatrixBarcode`, which
  `barcodeplace.ts` paints as vector modules into a rect (optional `/Alt` tag and
  OCG layer).
- **decorate.ts**, **pagerange.ts** — page decoration as an ergonomic layer over
  the stamping primitives (no new rendering): `AddWatermark`, `AddHeaderFooter`,
  and `AddBatesNumbering` (position anchors, `{page}`/`{bates}`/date templates)
  across a page selection resolved by `pagerange.ts` (an explicit 1-based list or
  a `"1-5,8,12-"` range string).
- **svgembed.ts**, **svgdraw.ts**, **svgpath.ts**, **svgstyle.ts**,
  **svgcss.ts**, **svgtransform.ts**, **svggradient.ts**, **svgpattern.ts**,
  **svgmask.ts**, **svgmarker.ts**, **svgtext.ts**, **svgtextpath.ts**,
  **svgtextstretch.ts**, **svgimage.ts**, **svgfilter.ts**, **svgfilterfx.ts**,
  **svgfilterlight.ts**, **svgfilternoise.ts** — SVG→PDF **import**
  (`page.AddSVGObject`). Direction matters: this stack is the opposite of
  `svgrender.ts` (PDF→SVG) and shares no code with it. `svgdraw.ts` is the
  walker over the `xml.ts` node tree, emitting operators and maintaining the
  `q`/`Q` stack; `svgembed.ts` wraps its stream as a Form XObject placed into
  the target rect and is **the only module in the stack that touches a
  `Document`**. Everything else is pure: `svgpath.ts` normalizes the `d` grammar
  and the shape elements to M/L/C/Z cubics, `svgtransform.ts` owns transform
  lists and the viewBox→rect placement matrix (including the y-flip),
  `svgstyle.ts` owns the cascade *result* and `svgcss.ts` decides which
  declarations reach it (a whole-tree pre-pass, since a `<style>` may appear
  after what it styles), `svggradient.ts`/`svgpattern.ts` build shading and
  tiling patterns, `svgmask.ts`/`svgmarker.ts`/`svgfilter.ts` resolve geometry
  and hand back descriptors, `svgtext.ts` emits text operators with fonts
  arriving through an `SvgFontProvider` that only `svgembed.ts` can implement,
  `svgtextpath.ts` places glyphs along a path and `svgtextstretch.ts` warps
  their outlines (via `glyphoutline.ts`), and `svgimage.ts` decodes a `data:`
  payload and computes its placement. The filter pixels live in
  `svgfilterfx.ts` (premultiplied **linear** RGBA surfaces + the kernels), with
  the lighting kernels and the Perlin generator split out into
  `svgfilterlight.ts` and `svgfilternoise.ts` — both transcriptions of SVG
  1.1's published reference implementations, which is why they are verified
  against browser-rendered goldens (`test/fixtures/svg-filter/`) rather than
  against themselves.
  **Invariant:** the pure modules allocate no indirect objects. `/ExtGState`
  entries are DIRECT dicts that `svgembed.ts` places in the Form XObject's own
  `/Resources`; anything that must be a stream (an image XObject, a tiling
  pattern) is handed to a sink `svgembed.ts` implements. Allocating from the
  walker would put a `Document` dependency into every one of these files.
  **Invariant:** an element the walker cannot render fully must name itself in
  `result.skipped` and still **draw** — unfiltered, unmasked, on the baseline.
  Visible ink beats silently dropped content. The exceptions are the cases SVG
  itself mandates as empty (a zero-area filter region or mask region, a stopless
  gradient, a zero-area pattern tile), which paint nothing and are *not*
  reported. `rasterized` is a separate list from `skipped`: it means fidelity
  was preserved but the subtree is now resolution-bound.
- **annotation.ts** — the typed `Annotation` model over `/Annots` (base plus
  `Text`/`Stamp`/`Markup`/`Link`/`Redact`/`Caret` subclasses) with live accessors
  and the `Page.Add*`/`RemoveAnnotation` create-edit-delete API. `QuadPoints`,
  `Alignment`, `InteriorColor`, `/T` and the `/DA` read are module-private
  helpers the subclasses delegate to, since several of them need overlapping
  subsets and TypeScript has single inheritance. The `/AP` *generation*
  code it drives lives in **annotdraw.ts** (the drawing bodies, plus
  `regenerateAppearance`, which builds an appearance from an existing dict
  rather than from an options object); appearance *resolution* for rendering and
  flattening lives in **annotappearance.ts**.
- **formdata.ts**, **fdf.ts**, **xfdf.ts**, **xml.ts**, **annotdata.ts**,
  **fdfannot.ts**, **xfdfannot.ts** — FDF/XFDF data exchange
  (`ExportFdf`/`ExportXfdf`/`ImportFdf`/`ImportXfdf`). Two format-neutral middles
  own all interaction with the document — `formdata.ts` for field values (a
  string model, since XFDF has no types) and `annotdata.ts` for annotations (the
  annotation dict itself, made self-contained by inlining every ref it reaches).
  The format modules never import `Document`: `fdf.ts`/`fdfannot.ts` write PDF
  object syntax, `xfdf.ts`/`xfdfannot.ts` write XML over the dependency-free
  reader in **xml.ts**, with `xfdfannot.ts` owning the element/attribute table
  that drives both directions. **cosxml.ts** is read-only and foreign: Acrobat's
  `<appearance>` payload is not a one-object PDF fragment (ours) but base64 of an
  XML COS serialization rooted at `<DICT KEY="AP">`, so `decodeAppearance` sniffs
  the first byte and dispatches. We read both encodings and write only ours.
  **Invariant:** an annotation dict in the neutral model carries no reference
  cycle — `/Popup` and `/IRT` are stripped and carried as `/NM` name links,
  because `/Popup` → popup → `/Parent` closes a loop that inlining cannot
  represent.
- **appearance.ts**, **da.ts**, **metrics.ts** — appearance-stream generation
  for form fields and annotations: Form XObject assembly, `/DA` parsing, and
  Standard-14 (AFM) glyph metrics.
  **Invariant:** the font key in a body's `Tf` operator and the key its form
  registers in `/Resources /Font` are one decision, not two. There are two
  appearance paths with *different* keys — fields use `'Helv'` throughout
  appearance.ts, annotations use `annotdraw.ts`'s `AP_FONT_KEY` — so a body
  producer shared across them must take the key as an argument, never hardcode
  one. `wrapTextBody` hardcoded the field path's `/Helv` and its only caller is
  on the annotation path, so every `/FreeText` appearance named a font its own
  form did not contain. No viewer complains: they fall back to a default face,
  which is why `test/ap-font-key.test.ts` asserts the contract directly over
  every generated appearance rather than trusting a rendering to reveal it.
  **Invariant:** `WidgetGeom` is the *layout* box, not the `/Rect` — under a
  `/MK /R` quarter turn it is the `/Rect` transposed, and `/Matrix` turns it
  back. A viewer maps the `/Matrix`-transformed `/BBox` onto `/Rect`
  (32000-1 12.5.5), so composing in the `/Rect`'s own dimensions leaves a box
  the viewer stretches to fit, on top of wrapping and centring text against the
  wrong edges.
- **encrypt.ts** — standard security handler encryption on `Save`
  (`Save({ encrypt })`: RC4, AES-128, AES-256), the write counterpart to
  crypto.ts.
- **xmp.ts** — read (`GetXmp`) and build (`SetXmp`) the `/Root /Metadata` XMP
  packet with a dependency-free scan, mirroring shared fields with `/Info`.
- **text.ts** — coordinate-based text extraction (`Page.GetText()`): walks
  content ops, emits positioned glyph runs, and assembles them into words/lines
  (affine matrix helpers live here too). **font.ts** — `TextFont`, the per-font
  code→Unicode decoder (simple-font encodings, `/Differences`, `/ToUnicode`,
  Type0/Identity-H) plus glyph-advance widths. **encoding.ts** — base text
  encodings (WinAnsi/MacRoman/Standard/PDFDoc) and the Adobe-glyph-name→Unicode
  resolver. **cmap.ts** — `/ToUnicode` and embedded `CMap` parsing.
  **glyphprogram.ts** — the embedded font program itself: which of
  `/FontFile`/`/FontFile2`/`/FontFile3` a descriptor carries, which glyph a code
  selects in it, and how wide that glyph is.
  **Invariant:** "is this font bold or italic" has ONE owner, `fontStyleOf` in
  font.ts, whose answer `TextFont` stores at construction. Two consumers ask —
  `fragmentsFromGlyphs` for the untagged path and `struct.ts`'s `styledRuns` for
  the tagged one — and a second copy is how the two come to disagree about one
  document. Every signal is POSITIVE evidence and they are OR-ed: a descriptor
  that merely omits `/FontWeight` says nothing and must not veto a `/BaseFont`
  name that says Bold, which is the common shape for an embedded subset. The
  name test strips a subset prefix, since `/AAAAAB+Arial-BoldMT` is the everyday
  case, and a composite font's descriptor lives on the DESCENDANT.
  **Invariant:** `struct.ts` splits an own-text run where the DERIVED STYLE
  changes, not where the font object does. A document setting one face through
  two font objects — inline code beside body text is the everyday case — must
  come back as one run. Measured: a single-face paragraph cannot pin this,
  because object identity and style comparison agree there whatever the code
  does; `test/struct-text-style.test.ts`'s two-faces-one-style case is the only
  thing that goes red.
  **Invariant:** sub/superscript joins that split key but does NOT come from the
  font, and is NOT derivable from the run's own glyphs. `markScriptLevel`
  measures a run against its LINE's dominant size and baseline, while
  `styledRuns` sees one MCID — and a `/Span` around a footnote marker contains
  nothing but the marker, so its own size is the dominant one and a per-MCID
  classification correctly marks nothing at all. `scriptByGlyph` (text.ts) runs
  the ordinary fragment assembly over a WHOLE page and returns the answer keyed
  by `GlyphEvent`; `mcidIndex` builds it in the content walk it already makes
  and memoizes it per page, so the tagged path pays no extra walk. Measured:
  swapping the page map for a per-MCID one turns
  `test/struct-text-script.test.ts` red on every case.
  **Invariant:** that map is built from EVERY glyph the page draws, not just the
  MCID-bearing ones. A line is a visual fact rather than a structural one, and
  excluding untagged neighbours would give a marker a different answer here than
  on an untagged page — which is the disagreement the whole design exists to
  avoid. `buildFragments` records each fragment's source glyph range for this,
  since a fragment always consumes a contiguous run of the input; re-deriving
  the mapping outside would be a second copy of the merge rule.
  **Note:** `docmodel.ts` and `docxflow.ts` needed NO change — `docText(n.text,
  n)` already spreads `style.script`, and `docxflow.ts` already emits
  `w:vertAlign`. c3t7.4 built the whole downstream half, so the tagged path only
  had to start supplying the field.
  **Invariant:** `TextLine.styles` is recorded WHERE `line.text` is assembled,
  never re-derived from `line.fragments`. The assembly inserts a synthesized
  space wherever two fragments sit apart, so a later walk cannot reconstruct the
  offsets — the same reason `splitLineLinks` only ever slices that string. A
  line with nothing emphasized gets no `styles` at all and yields one unchanged
  piece, which is what keeps every existing snapshot byte for byte.
  **Invariant:** those questions have **one owner** — four of them since `e5j5`,
  which moved the CID route here as `gidForCid`. `raster.ts` asked them all for
  rendering and `font.ts` needs them for measurement, but
  `raster.ts` imports `font.ts`, so the alternative was a second copy — which is
  how `gidForCode`'s two callers would come to disagree about a glyph. Measured:
  neutering `gidForCid`'s `/CIDToGIDMap` branch reddens the new width test AND
  every CJK rendering case in `test/cjk-end-to-end.test.ts`, which is what shows
  the two really do share one rule rather than merely agreeing today. The
  module takes `resolve`/`inflate` and the name resolver as *arguments* rather
  than importing `font.ts` or `document.ts`; that is what keeps
  `font.ts → glyphprogram.ts` free of a cycle.
  **Invariant:** `programAdvance` returns 1/1000 em, never font units. The three
  programs report in three different spaces — `hsbw` in glyph space, a CFF
  charstring width in charstring units, `hmtx` in font units — and only the
  first two are reliably 1000/em. A TrueType is commonly 2048, so an
  unnormalised advance is 2.048× too wide, which looks like a plausible wide
  face rather than a bug. `hmtx` outranks the CFF charstring width when both
  exist, which is the OpenType-CFF case.
  **Invariant:** a CFF charstring's width operand is a *delta* from
  `nominalWidthX`, and its absence means `defaultWidthX` — not zero. Reading the
  operand directly yields a plausible narrow glyph.
  **Invariant:** `/Widths` always wins, and an explicit `/MissingWidth` wins over
  the embedded program; both are statements the producer made, including a
  deliberate `/MissingWidth 0` for codes that should not advance. The program
  answers only where the font is silent. `parseSimpleWidths` therefore reports
  whether `/MissingWidth` was *present*, which it used to collapse into `?? 0` —
  losing the difference between "the font says zero" and "the font says
  nothing", which want opposite treatment.
  **Invariant:** the SAME present-versus-absent rule governs a composite font's
  `/DW`, and `parseType0Widths` reports `hasDw` for exactly the reason
  `parseSimpleWidths` reports `hasMissing`. A stated `/DW` outranks the program,
  including a deliberate `/DW 1000`; an ABSENT one leaves 1000 as a spec default
  the producer never said, so a CID outside `/W` falls through to the embedded
  program and reaches 1000 only as a last resort. It used to collapse into
  `?? 1000`, which is the same defect this file already recorded one paragraph
  up — and the reason `e5j5`'s premise ("`/DW` supplies a real default, so
  neither failure mode applies") was weaker than the real one.
  **Note, measured:** the whole suite stayed green when this shipped. No fixture
  anywhere had a composite font with a gapped `/W` and no `/DW`, which is what
  the issue meant by "untested against any real file"; `test/font-cid-program-widths.test.ts`
  is the only thing covering it.
  **Invariant:** the program is loaded on the first code `/Widths` cannot cover,
  never at construction. Nearly every font carries complete `/Widths`, and those
  must not pay to parse a `/FontFile2` that will never be consulted.
  **Note:** a Type 3 font's `/FontMatrix` skew terms `b` and `c` are correctly
  absent from the advance while `drawType3Run` applies them to the ink. 32000-1
  9.4.4 makes the displacement a scalar along the writing direction, so only the
  `a` term reaches the pen. This is settled, not an outstanding gap.
  **Invariant:** a simple font with no `/Widths` measures from its **embedded
  program** if it has one (see **glyphprogram.ts** below), and otherwise from
  metrics.ts's AFM tables — never a flat per-em estimate. Only a Standard-14
  face may omit the array (32000-1 9.6.2.2) — which is exactly what our own
  `stampText` writes — so an estimate makes the interpreter disagree with the
  authoring side about text this library itself laid out, and
  `GetTextFragments`/`ToImage`/`ToSvg` space glyphs too widely, rendering text
  overflowing a box it provably fits. The AFM table is keyed by the
  Standard-14 face `normalizeFont` maps `/BaseFont` onto, so for an embedded
  `/AAAAAB+SomeFont` it is Helvetica's metrics against that font's own outlines
  — which is why the program now outranks it.
  The Latin tables are indexed by WinAnsi code, so reach them through the code's
  *Unicode*: `/MacRomanEncoding` and a `/Differences` name both land on another
  glyph's width otherwise. Symbol and ZapfDingbats keep their built-in encodings
  and index by the raw code.
  **Invariant:** a **Type 3** font's glyph space is whatever its `/FontMatrix`
  says, and it is not 1/1000. That one matrix fixes two things — how big the
  glyph procedures draw *and*, since `/Widths` are in the same space, how far
  the pen advances — so `TextFont.widthScale` is `fontMatrix[0]` rather than
  0.001 and both the interpreter and extraction read the advance from it. Fix
  only the drawing and a page renders at the right size with the glyphs piled
  on top of one another.
  **Invariant:** the code→procedure route is `/Encoding /Differences` → the
  *name* → `/CharProcs`, never the Unicode those names decode to. A Type 3 font
  has no built-in encoding to fall back on, so a code the differences array
  never names simply has no glyph — and `/square` and `/uni25A1` are the same
  character but generally not the same procedure. There is also no substitute
  face: a missing procedure draws nothing, where every other font would fall
  back to a bundled Standard-14 outline.
  **Invariant:** the glyphs are interpreted in pagerender.ts (`drawType3Run`),
  not in a sink — they are content streams, so both backends see only the
  primitives they draw and neither needs to know Type 3 exists. A procedure is
  ordinary content and may show text in its own font; `ctx.seen` is what stops
  that, since a charproc has no `/BBox` to shrink into and recurses at full
  size. The depth bound alone is not enough to *prove* the guard works — the
  runaway bottoms out on the JS stack, whose `RangeError` `drawGlyphProc`
  catches, so the page looks identical either way and only a paint count
  distinguishes a cycle guard from a stack overflow.
- **cidcmap.ts**, **cmapcodec.ts**, **cmapdata.ts**, **predefcmap.ts** — the
  code→**CID** direction, for a composite font's `/Encoding`. Note the
  direction: cmap.ts reads code→Unicode out of `/ToUnicode` and `bf` operators,
  these read code→CID out of `cidrange`/`cidchar`, and a CMap file may carry
  both. `cidcmap.ts` is the model (`CidCMap`) and the text parser
  (`parseCidCMap`), used for an embedded `/Encoding` CMap stream *and* by
  `scripts/gen-cmaps.ts` at build time, so the bundled data and a document's own
  CMap cannot be read by two subtly different grammars. `cmapdata.ts` is the
  generated bundle: all 195 predefined Adobe CMaps (Japan1, GB1, CNS1, Korea1,
  KR, Identity, and the deprecated Japan2), 385,860 ranges, ~1.0 MB of base64.
  `predefcmap.ts` serves them by name.
  **Invariant:** the shape a predefined CMap needs and `/ToUnicode` never does
  is the *codespace*: codes are not a fixed width. `UniJIS-UTF8-H` mixes 1-, 2-,
  3- and 4-byte codes in one show string, and even the nominally two-byte
  `90ms-RKSJ-H` takes single bytes for ASCII and half-width katakana. A caller
  cannot slice a show string up front — it asks `CidCMap.next` for one code at a
  time, and `next` always consumes at least one byte so the loop cannot spin.
  **Invariant:** codespace ranges are compared **byte by byte**, not as
  integers (32000-1 9.7.6.2). `<8140> <9ffc>` admits `81 40` and rejects
  `82 00`, which an integer `lo <= code <= hi` test wrongly accepts — and a
  Shift-JIS lead byte with an out-of-range trail is what mislabelled CJK text is
  made of.
  **Invariant:** a `usecmap` parent supplies the *codespace*, not just the
  mappings. Nearly every vertical CMap Adobe ships declares no
  `begincodespacerange` at all — `UniJIS-UCS2-V` states only the ~100 codes
  whose glyphs differ set vertically and inherits the rest. Index a child on its
  own ranges alone and it matches no code whatsoever, so every vertical CMap
  silently decodes to nothing.
  **Invariant:** a `notdefrange` names **one** substitute CID for its whole
  range (Adobe TN #5014), unlike a `cidrange`. Interpolating turns `B5pc-H`'s
  `<00> <1f> 1` — all 32 control codes to CID 1 — into a march across CIDs 1..32,
  drawing real glyphs for codes that map to nothing. A real mapping anywhere in
  the `usecmap` chain outranks a notdef substitute anywhere in it.
  **Invariant:** cmapcodec.ts holds the encoder *and* the decoder. The encoder
  runs only at build time and ships unused — a few hundred bytes of dist buying
  the guarantee that a format with no self-description cannot drift between its
  two halves, and letting `test/cmapcodec.test.ts` round-trip all 195 bundled
  blobs through both. The encoding is columnar (all `lo` gaps, then all spans,
  then all CID steps) rather than per-range triples: the three columns have very
  different value distributions, and separating them is worth 753 KB against
  813 KB after brotli.
  **Invariant:** a CMap is inflated when a document first names it, and only
  then — which is why the data is one compressed blob per name rather than one
  stream over the corpus. A document with no CJK in it costs nothing.
  **Invariant:** the name comes out of the document, so the bundle is probed
  with `hasOwnProperty`, never `in`: `/Encoding /constructor` otherwise finds
  `Object.prototype.constructor` and is treated as a CMap that exists.
  **Invariant:** a composite font's `/Encoding` is resolved in exactly one place
  — `resolveEncodingCMap` in font.ts — and it follows *both* parent mechanisms:
  the `usecmap` name inside the CMap text and a `/UseCMap` entry in the stream
  dict, the latter winning because it is the PDF object the document points at.
  The walk is depth-bounded, since a file can point a `/UseCMap` at itself.
  **Invariant:** an `/Encoding` that cannot be resolved degrades to Identity,
  never to nothing. A name outside the bundled set is a CMap we do not have,
  not a broken document; returning undefined drops the font's text entirely.
  `-V` degrades to Identity-V, because decoding is identical either way and the
  writing mode is the only thing that distinguishes the two — drop it and a
  vertical run silently turns horizontal.
  **Invariant:** `TextFont.codeWidth` is the *narrowest* code the font admits
  and is advisory for a composite font; the truth for a given code is its
  `Glyph.byteLen`. `TextFont.codes()` is the single place that splits a show
  string, and it asks the CMap rather than stepping by a fixed width.
  **Invariant:** `Glyph.cid`, not the code, selects the glyph and the advance.
  A composite font's `/W` is keyed by CID and `gidForCode` expects a CID, while
  a simple font's `/Widths` is keyed by code; the two coincide only under
  Identity. Every consumer that re-derived the code from `byteStart`/`byteLen`
  (raster.ts's `eachGlyph`, htmlfontembed.ts's `run`) drew the right glyph for
  `/Identity-H` and the wrong one for every other CMap — silently, since both
  numbers are valid glyph ids.
  **Invariant:** word spacing applies to the single-byte code 32, including in
  a composite font that defines 32 as a one-byte code (32000-1 9.3.3) — which
  the Shift-JIS and EUC CMaps all do. Test the *code's own* length, not the
  font's nominal width.
- **Vertical writing** (`/WMode 1`, the `-V` CMaps) lives in font.ts's
  `glyphDisplacement` / `runDisplacement` / `tjShift` / `glyphOrigin` and
  `Glyph.vertical` (`/W2` + `/DW2`, parsed by `parseType0VerticalWidths`).
  **Invariant:** those four functions are the only place a writing direction is
  decided. Five callers advance a text matrix — extraction, the interpreter (by
  run), the rasterizer (by glyph), and the two TJ paths — and each had the
  horizontal formula written out inline. Adding a second direction to each
  independently is how two of them come to disagree about a `Tz` or a `Tc` on a
  page nobody looks at closely.
  **Invariant:** horizontal scaling multiplies horizontal displacements only
  (32000-1 9.4.4), so `Tz` must not appear in the vertical advance at all — but
  it *does* apply to the position vector's `vx`, which is a horizontal offset.
  **Invariant:** an absent `/W2` position vector is not (0,0). It defaults to
  (w0/2, `/DW2[0]`) — half the glyph's *own* horizontal width across, the
  default origin up. `/W2` is absent from most real vertical fonts because the
  default is right for nearly every glyph, so the defaulted path is the one that
  runs, and a zero vector misplaces the whole page rather than a few glyphs.
  Note the two `/W2` shapes differ in meaning, not just spelling: the array
  form's triples advance with the CID, the range form shares one vector across
  the range.
  **Invariant:** a vertical glyph's `quad` is the cell it occupies — half an em
  either side of the pen, running down to the next pen position — not a
  baseline-anchored box. The pen sits at the *vertical origin*, top centre.
  **Invariant:** reading order is one algorithm, not two. `axisKeys` reorients a
  run so that `line` selects the line or column and `start`/`end` run along the
  writing direction, both increasing: horizontal negates Y, vertical negates
  *both* axes (columns right-to-left, each read top-to-bottom). A second copy of
  the layout with the comparisons flipped is how the gap rule and the line
  tolerance end up differing between the two directions. A mixed page lays each
  direction out under its own rule and emits the vertical body first — no single
  ordering is right for both, and interleaving by position drops a running head
  into the middle of a column.
- **cidunicode.ts**, **cidunidata.ts** — CID→**Unicode**, the last step of
  reading CJK text. An `/Encoding` CMap gives code→CID, which draws the right
  glyph but says nothing about what character it is; when `/ToUnicode` is absent
  (or partial), the route is the collection `/CIDSystemInfo` names and Adobe's
  published table for it. `cidunidata.ts` is generated by
  `scripts/gen-cidunicode.ts` (`npm run gen:cidunicode`, pinned to
  mapping-resources-pdf 20230118): 5 collections, 113,292 mappings, ~116 KB of
  base64. The generator parses through cmap.ts's own `parseCMap` — the tables
  are ordinary `bfchar`/`bfrange` CMaps keyed by CID — which is what `CMap.entries()`
  exists for.
  **Invariant:** these tables are *not* derivable by inverting the bundled
  `Uni*-UCS2-H` CMaps, which is the tempting way to get them for nothing.
  Measured against Adobe's own: inversion agrees on 39% of Adobe-Japan1's CIDs,
  86% of Adobe-CNS1's, 94% of Adobe-Korea1's. Japan1 CID 93 is U+00A6 and CID 99
  is U+007C, and inversion returns them *swapped*, because both characters map
  into both CIDs going the other way; a many-to-one mapping cannot be
  round-tripped. 13,569 Japan1 CIDs are not reachable from UCS-2 at all.
  **Invariant:** an unmappable CID contributes *nothing* to extracted text,
  never U+FFFD. Adobe spells "no Unicode for this CID" as U+FFFD (once per
  collection for CID 0, 199 times in Adobe-CNS1) and the generator drops those,
  so extraction shows a gap rather than a run of replacement characters that
  reads as a decoding bug.
  **Invariant:** the ordering means nothing without registry `Adobe`. The name
  is a bare string the producer chose, and a private collection may call its
  ordering `Japan1` while numbering CIDs however it likes — mapping those
  through Adobe's table emits confident Japanese for a font containing none. A
  *missing* `/Registry` reads as Adobe's, since that is the only registry with
  published collections and producers omit it.
  **Invariant:** the descendant's `/CIDSystemInfo` outranks the `/Encoding`
  CMap's ordering, and the CMap is only the fallback. `/Identity-H` with a real
  collection is a common shape: the CMap calls its ordering `Identity` (glyph
  indices, no characters) while the descendant declares Adobe-Japan1, and the
  descendant is the authority on what its own CIDs mean.
  **Invariant:** SVG has no `/WMode`. A vertical run emits one positioned
  `<tspan>` per glyph, because a plain `<text>` lays a Japanese column out as a
  row; the element's local Y runs *down* text space, so a text-space offset is
  negated on the way in. **HTML fixed mode does the same since kf8h.4**, from
  the SAME `glyphOrigin`/`glyphDisplacement` helpers, so neither backend keeps
  its own copy of the vertical arithmetic — but its offsets go through the run
  matrix on the way out, because a `<span>` is positioned in device px while a
  `<tspan>` is local to an element already carrying the transform.
  **Note, measured:** a test built only on inter-glyph DELTAS cannot see the
  position vector at all — it is a constant per-glyph offset, so it cancels.
  Replacing `glyphOrigin` with the bare pen left every delta and count
  assertion in `test/vertical-writing.test.ts` green; only the ABSOLUTE case
  ("a 40pt glyph draws 20pt left of its pen") turns red.
- **text.ts** also hosts `visitContent`/`mapRegions` and the positioned models
  (`TextFragment`/`TextLine`/`TextBlock`) behind `GetTextFragments` /
  `GetStructuredText`. `ImageEvent` carries the resolved image XObject as
  `stream` — undefined for an inline image, whose samples live in the content op
  and in no object — which is what lets a consumer get from marked content to
  actual image bytes (see the HTML `/Figure` invariant below).
  **Invariant:** `GlyphEvent` carries the fill `color` and `TextFragment`
  deliberately does not. `walkScope`'s `q`/`Q` stack holds a graphics-state
  record (CTM + fill + its converter) rather than a bare CTM, and `g`/`rg`/`k`/
  `cs`/`sc`/`scn` resolve through `colorspace.ts`'s `resolveColorSpace` exactly
  as `paths.ts` does — one owner for "what colour is this operand". Colour stops
  at the glyph because `fragmentsFromGlyphs` merges consecutive glyphs sharing
  font, size and baseline ACROSS show operators: a fragment spanning a colour
  change could only report one of them (painting a line the colour of its first
  word), and putting colour into the identity instead would move every untagged
  fragment snapshot and disturb the premise `docmodel.ts`'s link recovery is
  written against. `docxgroup.ts` groups glyphs for exactly this reason.
  **Invariant:** `color` is absent for black, the PDF initial fill — the fence
  `TextFragment.bold`/`.italic` set. **Note, measured:** proving that rule needs
  an EXPLICIT black operator. With no colour operator at all the fill is already
  undefined, so such a fixture stays green with the black test deleted.
  **Note:** stroke colour is not tracked, so text under the stroke-only render
  modes (`Tr 1`/`5`) reports its fill. The miss is a shade rather than a
  disappearance, and tracking it would double the saved state for that one case.
  **Invariant:** `TextFragment.script` needs a size drop AND a baseline shift,
  both, measured against the line's DOMINANT size and that size's baseline.
  Neither alone works: without the size test, OpenType mark positioning is
  labelled a script (a raised glyph at an unchanged size — `otemit.ts` emits
  exactly that as a `Ts` for shaped Arabic and Devanagari, so we would mislabel
  our own output); without the shift test, small caps and any smaller inline
  label qualify. The reference baseline must come from the dominant-size
  fragments, never the line's bounding box — a subscript drags that box down, so
  the box measures its own shift as zero and nothing is ever marked.
  The rule reads position and size, never `Ts`, because many producers write a
  superscript by moving the text matrix with no rise at all.
  **Note, measured rather than assumed:** the size rule is reachable only in a
  narrow band, and it took three attempts to pin end to end. A same-size raised
  run is ABSORBED into its neighbour's fragment when the rise is inside
  `fragmentsFromGlyphs`'s `max(2, 0.5 * fontSize)` tolerance, and lands on a
  LINE OF ITS OWN when the rise exceeds `markScriptLevel`'s (a single-fragment
  line is never evaluated). So it must be split by a wide horizontal GAP while
  staying inside the baseline tolerance — which is what
  `test/text-script.test.ts`'s "same-size raised run separated by a gap" builds.
  The shaped-GPOS test in that file passes with the size rule DELETED and says
  so in its own comment; do not cite it as covering this.
  **Invariant:** a fragment runs ALONG its writing direction, so
  `fragmentsFromGlyphs` bounds the inter-glyph gap in BOTH directions — half an
  em either way, on the axis `axisKeys` reorients, so one rule serves horizontal
  and vertical alike. The forward half is obvious; the backward half is not, and
  its absence was a live bug until `no93.6`: a right-aligned list marker painted
  *after* its body (what `flow.ts` emits) merged into the body's fragment however
  far back it was, yielding one fragment reading `three3.` whose `quad` started at
  the body's x and excluded the marker glyphs it contained — violating this
  type's own "x from the pen span" contract. Note `GetText()` never showed it,
  because `layoutLines` sorts by x; only `GetTextFragments`/`GetStructuredText`
  carried it, which is exactly what `docmodel.ts`'s untagged builder reads. The
  tolerance must stay loose enough that a kerned pair still merges, which
  `test/text-fragments.test.ts` asserts beside the split.
  **textedit.ts** — string/`RegExp` search
  (`Search`/`searchText`) and same-font, no-reflow `ReplaceText`.
  **Invariant:** `SearchOptions.region` uses `extractTables`' containment rule —
  a glyph is in or out by its quad's CENTROID, never partly in. Centroid rather
  than intersection makes the answer independent of glyph size, and two features
  answering "is this inside the region" differently is how a search and a table
  extraction come to disagree about one page.
  **Invariant:** the region filters glyphs BEFORE `layoutLines`, so a match
  straddling the boundary is not found at all. That is what a region means
  ("search here"), but it reads like a bug, so `test/search-region.test.ts`
  asserts it directly — with a companion assertion that the in-region *prefix*
  still matches, proving the glyphs were not simply all excluded.
  **Invariant:** `region` scopes the SEARCH and is destructured out before the
  consumers' own options are forwarded. `redactText` must not pass it to
  `redactPage` (which takes explicit rects) and `markRedactText` must not pass
  it to `addRedact` (which would carry it into an annotation dict); both would
  silently accept the key.
  **annotsearch.ts** — search the text an annotation *draws*
  (`Page.SearchAnnotations`): the words inside its `/AP` appearance stream, a
  `/FreeText`'s visible text or a filled form field's value, which
  `visitContent` never sees because it walks page content streams only. Its own
  module for redactannots.ts's reason — textedit.ts is content-stream search
  and edit, this is `/Annots` object-graph work — and it holds textedit.ts free
  of a dependency on annotation.ts.
  **Invariant:** ONE `layoutLines` assembly per annotation, never one shared
  with page content or across annotations. `layoutLines` groups by baseline and
  orders by X, so a note drawn over a paragraph shares its line — a shared
  assembly splices the note's words into the paragraph's and matches a query
  spanning both. Measured: the fixture's `bravo` sits on the page text's own
  baseline, and seeding the annotation runs with the page's glyphs turns
  `alpha bravo` into a hit.
  **Invariant:** no `GlyphEvent` escapes this module, which is why
  `AnnotationMatch` carries none. An `/AP` stream is not addressable by
  `ContentAddr` — its `path` is a chain of XObject resource names descended
  from the page — so `visitFormContent`'s `addr` names the page's first content
  stream and is a lie; a fabricated path throws `XObject /X not found` inside
  `EditableContent.cowXObject` rather than degrading. `buildMatch`'s `hits` are
  dropped at the one boundary in `searchAnnotations`.
  **Invariant:** `visitFormContent` lives in text.ts and knows nothing about
  annotations. annotappearance.ts value-imports `placementMatrix` from text.ts,
  so a `visitAnnotationAppearance` there would close a cycle; the annotation
  half (`isAnnotVisible`, `resolveAppearance`, composing `ap.place`) is
  annotsearch.ts's. Using those two predicates rather than reading `/AP`
  directly is what makes search agree with `ToImage`, `ToSvg` and
  `FlattenAnnotations` about which annotations draw.
  It also holds the OTHER reading of "annotation text", `searchAnnotationText`
  (`Page.SearchAnnotationText`): the text an annotation CARRIES and never draws
  — `/Contents`, `/T`, `/Subj`. Two features in one module because they answer
  one question about one object graph; three deliberate divergences keep them
  from being confused for each other.
  **Invariant:** the carried search reads EVERY annotation, Hidden, NoView and
  `/Popup` included, where the drawn search filters through `isAnnotVisible`.
  That one reports what a render draws; this one reports what the file carries,
  and a hidden annotation's text is still in the bytes and still what redaction
  removes. It reads like an inconsistency, so it is asserted directly.
  **Invariant:** an `AnnotationTextMatch` carries NO geometry and the function
  takes NO options. This text is never drawn, so its only available box is the
  whole `/Rect` — the shape the c3t7.6 design refused, since redacting it covers
  whatever innocent content sits under the annotation. `region` would have to
  mean that same `/Rect`, and accepting the key while ignoring it is the
  silent-acceptance trap `redactText`/`markRedactText` already guard against.
  **Invariant:** `/T` is in the key set, and that is the whole argument for the
  feature existing. `test/redact-annots.test.ts` already treats an author name
  as a secret redaction must remove, so a search limited to `/Contents` would
  report "not found" for text the same document's `Redact` does delete — which
  is exactly the trap a caller's hand-rolled `a.Contents?.includes(q)` falls
  into. Measured: dropping `'T'` from `TEXT_KEYS` turns two cases red.
  **Note:** `/RC` is deliberately out. It is an XHTML fragment, so reducing it
  to searchable text needs a block-separator rule (`<p>a</p><p>b</p>` must not
  become `ab`) plus a degrade path for `parseXml`'s throw — a feature with its
  own decisions, tracked separately alongside `readRichTextValue`, which
  returns raw markup for a form field's `/RV` today and has the same defect.
  **Invariant:** redaction is left alone. `RedactText`/`MarkRedactText` gain no
  annotation flag — a caller passes the quads to `Redact`, and
  `removeCoveredAnnotations` then takes the whole annotation, which is the only
  granularity available without surgery on the `/AP` stream. That recipe is
  asserted rather than only documented (`test/annot-search.test.ts`), which is
  what surfaced `vvft` — an orphaned widget then survived `Redact` entirely.
  Fixed; the orphan shapes are covered by `test/redact-orphan-widget.test.ts`
  and the rule is recorded under `redactannots.ts` above.
- **richtext.ts** — an XHTML rich-text fragment reduced to searchable plain
  text, added in `k2k5`. A pure leaf over `xml.ts`. Two entries carry markup
  rather than text: a markup annotation's `/RC` (32000-1 12.5.6.2) and a form
  field's `/RV`.
  **Invariant:** the reduction is a SIBLING of the raw read, never a
  replacement, and that is forced rather than preferred. `formdata.ts` writes
  `/RV` into FDF/XFDF `<value-richtext>` and `xfdfannot.ts` writes `/RC` into
  `contents-richtext`, both VERBATIM — changing what the raw reader returns
  would silently corrupt both round trips. `readRichTextMarkup` is that reader
  (`readRichTextValue` is retained as an alias for the existing import path),
  and it takes the key, since `/RV` and `/RC` share the string-or-stream duality
  and it should have one owner.
  **Invariant:** it PARSES, never strips angle brackets. A regex mishandles
  CDATA, comments, and a `>` inside an attribute value, and all three occur in
  real rich text — each is asserted directly.
  **Invariant:** the block rule has to be STATED because both failure modes are
  silent and opposite. Concatenating everything turns `<p>a</p><p>b</p>` into
  `ab`, so a query for `ab` matches text that never appeared; separating every
  sibling turns `<p>a<b>x</b>y</p>` into `a x y`, so a query for `axy` stops
  matching text that is there. `BLOCK` is the small list that gets both right,
  and both directions are mutation-checked.
  **Invariant:** the block boundary is a SENTINEL (U+0000) during the walk, not
  a literal newline, because the whitespace-collapsing pass that follows could
  not otherwise tell a break we inserted from a newline that was only
  indentation in the source markup.
  **Invariant:** the fragment is WRAPPED in a synthetic root before parsing.
  `parseXml` returns one root and a fragment legitimately has several, so a bare
  `<p>a</p><p>b</p>` would otherwise yield only the first — dropping content
  silently, which is worse than reporting nothing. The wrapper also carries the
  fragment's own XML declaration safely, since `skipMisc` runs inside
  `parseElement`'s child loop.
  **Invariant:** a parse failure returns `undefined` — never the markup, never a
  regex strip. Returning the source would reinstate the exact defect this
  closes (a query for `p` matching a tag name), and `parseXml` throws
  `PdfParseError`, which must never escape a search.
  **Note on the key that is spelled the same and is not the same:** a push
  button's ROLLOVER CAPTION is also `/RC`, but nested inside `/MK` and holding
  plain text (`buttonap.ts`). `annotsearch.ts` sweeps the annotation dict's own
  keys, so the two never meet — recorded because the collision is exactly the
  sort of thing that gets "fixed" wrongly later.
  **Note:** `AnnotationTextKey` gained `'RC'`, which is additive at runtime and
  source-breaking for a caller doing an exhaustive `switch` on it. An
  `AnnotationTextMatch.value` for `/RC` is the REDUCED text, not the markup:
  `text` is a slice of `value`, so reporting markup there would index a string
  the caller never saw.
  **textrank.ts** — font-size heuristics (dominant size, `headingRanks`) shared by
  structured text and HTML export. **paths.ts** — vector/path extraction
  (`page.GetPaths`): a focused content walker (cf. `imageusage.ts`, separate from
  `text.ts`'s `visitContent`) that tracks CTM/paint/clip and emits one positioned
  `PagePath` per paint op.
- **editcontent.ts** (`EditableContent` — per-stream op model with Form-XObject
  copy-on-write), **redact.ts** + **imageredact.ts** (`Redact`/`RedactText`:
  drop covered glyphs, delete/partially re-encode images, prune orphans),
  **redactapply.ts** (the annotation-driven half: `AddRedact`/`MarkRedactText`
  mark a region, `ApplyRedactions` consumes the marks and paints each one's
  overlay), and **flatten.ts** (`FlattenAnnotations`/`FlattenForm`) — the
  content-editing layer on top of `editcontent`. `redactapply.ts` is its own
  module because redact.ts owns the destructive content surgery while the apply
  layer reads annotation dicts and paints overlays.
  **redactannots.ts** removes the annotations covering a redacted region, called
  from `redactRegions` so every entry point shares it. It is its own module
  because `redact.ts` is content-stream surgery and this is object-graph work;
  it must not import `redact.ts` (which imports it), so its AABB helpers are
  local by design.
  **Invariant:** content surgery alone does not redact. `/Annots` is a separate
  object graph that `EditableContent` never visits, so an annotation over the
  region keeps its text — and with an `/AP`, keeps drawing it *over* the marker
  box, because annotations composite after page content. `GetText()` cannot see
  any of this, so the guarantee is asserted on saved bytes and on `ToSvg`.
  **Invariant:** a `/Redact` annotation is never swept. Marks are redaction
  machinery, and exempting them is what lets `applyRedactions` remove its own
  marks after `paintRedactOverlay` has read them.
  **Invariant:** a covered widget is removed through `removeField`, never by
  detaching the widget — the value lives on the field, so a detached widget
  leaves the `/V` in `/AcroForm /Fields`.
  **Invariant:** but `removeField` returning **false** is not a reason to keep
  the annotation. It returns false for exactly one case — the field is not
  reachable from `/AcroForm /Fields`, including a document with no `/AcroForm`
  — and the widget branch used to `continue` on it, so a covered widget
  survived redaction whole and went on drawing its `/AP` over the marker box
  (`vvft`). `detachUnwiredField` is the fallback: everything `removeField` does
  minus the field-tree surgery there is no entry for. It is a second entry
  rather than a branch inside `removeField`, whose "false means nothing
  happened" contract `Annotation.Flatten` relies on.
  **Note, all measured, and two of them defeat the obvious one-line fix:**
  detaching only the covered widget is not enough. `/AcroForm /CO` keeps the
  dead field and its `/V` in the saved bytes, because `scrubCO` lives inside
  `removeField`; and for a group, a sibling widget elsewhere keeps the shared
  field reachable, whose `/Kids` then keeps the "removed" widget reachable in
  turn — so detaching one of a group accomplishes nothing at all. A widget
  naming no field is passed as its own field, so both failure modes
  (`fieldOf` undefined, `removeField` false) share one path.
  **Note:** the old test for this shape was named "skips a widget whose field
  is not in the tree rather than throwing" and asserted only `not.toThrow()`,
  which the leak satisfies as readily as the fix. A test can name a behaviour
  without pinning it. The shape matrix is `test/redact-orphan-widget.test.ts`.
  **Invariant:** redaction's own ink is tagged in a tagged document — the marker
  box as an `/Artifact`, the overlay text and any `/RO` form as a `/P`. The text
  is *tagged, not artifacted*: `/Artifact` would silence the `UntaggedContent`
  warning by declaring "REDACTED" decorative, so assistive technology would skip
  it and a screen-reader user would never learn the region was redacted.
  `doc.GetStructTree() === null` is the whole switch; untagged output is
  byte-identical.
  **Note:** `UntaggedContent` does cover path fills (since `hdsx`), so an
  unartifacted marker box fires it. The wrapping is *also* asserted on the
  content stream, because the rule reports only that *something* on the page is
  unmarked and cannot distinguish a missed marker box from a missed overlay.
  **Invariant:** the removal → sanitize → commit ordering lives in
  `redactRegions` and nowhere else. Text removal rebuilds the op list, so a
  caller that splits the passes lets glyph rewrites and image removals drift
  each other's op indices — silently, because the page still looks redacted.
  **Invariant:** an unapplied `/Redact` mark must not render like an applied
  redaction. Its `/AP` outlines each quad and fills nothing, because both the
  renderers and `FlattenAnnotations` composite `/AP /N` — a filled preview would
  render a page whose text is still fully extractable as though it were already
  redacted.
  **Invariant:** applying a mark removes it via `Page.RemoveAnnotation`, never a
  raw `/Annots` splice, because that is what calls `untagObjects`. A tagged
  annotation is also named by an `/OBJR` reachable from `/Root`, so a splice
  leaves a `/Redact` in the saved bytes with no `/Annots` entry anywhere.
- **compose.ts**, **booklet.ts** — page composition (`StampWith`, `Overlay`,
  `NUp`, `Resize`, `Scale`) via shared imported Form XObjects. `booklet.ts` is
  the pure saddle-stitch model behind `Document.Booklet` — padding to a multiple
  of 4, the sheet-ordering permutation, signatures, and cell geometry including
  creep. It imports nothing and touches no PDF objects, so the arithmetic that
  is silently wrong when reversed is testable without building a file; sheet
  assembly itself lives in document.ts, beside `NUp`.
- **template.ts** — a reusable Form XObject a caller authors. `doc.NewTemplate(w, h)`
  hands back a `Template` wrapping an OFF-TREE page, so every existing authoring
  API draws into it unchanged, and the first `PlaceOn` converts that page into a
  form.
  **Invariant:** the page-to-form conversion here is its OWN, not
  `compose.ts`'s `importPageAsXObject`. That one is for a page in ANOTHER
  document and deep-copies the resource graph through `importGraphInto` — used
  same-document it would duplicate every font and image the template touches,
  once per template, which is the opposite of what a template is for.
  **Note:** the off-tree page is the whole trick. It is never in `/Pages`, so it
  cannot be saved, paginated or extracted as a page — but `Page` does not know
  that, which is why `AddText`, `AddImage`, `PageGraphics` and the rest work on
  a template with no template-specific code anywhere.
- **ocg.ts** — optional content / layers (`OptionalContent`, `Layer`,
  `LayerConfig`): enumerate/toggle, author, and delete OCGs + their marked
  content.
- **imagepages.ts** — `doc.AddImagePages()`: an image file expanded into PAGES,
  one per frame. Note the direction against `imageembed.ts`, which draws an
  image INTO a page.
  **Invariant:** the expansion happens at ADD time, not on save. Java expands a
  multi-frame TIFF when the document is written; here `Save()` is a pure
  function of the live model, so creating pages during serialization would make
  the page count depend on when you looked and would put a decoder inside the
  writer.
  **Invariant:** a frame that will not decode costs ITS OWN page and nothing
  else, reported in `skipped` — `svgdraw.ts`'s rule, so a partly-corrupt fax
  still yields the pages that survive. It throws only when NO frame decoded,
  where there is nothing to hand back and silence would read as success.
  **Invariant:** `frames` is a SELECTION, normalized ascending and deduped like
  every other page selection here. A caller wanting an ORDER makes the calls in
  that order.
  **Note, and it is the gap this feature sits on:**
  `test/fixtures/tiff/PROVENANCE.md` records that no third-party MULTI-PAGE
  TIFF is vendored. So each frame's CONTENT decoding is anchored by real
  single-frame libtiff/utif2 files, while the IFD CHAINING is our `encodeTiff`
  read back by our `decodeTiff` — the shared-convention class, tracked as its
  own issue. Do not read those tests as conformance evidence for the walk.
- **bmpencode.ts**, **gifencode.ts**, **quantize.ts** — the other two raster
  **writers** behind `page.ToImage`, and the palette reduction GIF needs. All
  pure; note the direction, since `bmp.ts` is the BMP *reader* and there is no
  GIF reader in `src/` at all.
  **Invariant:** `bmpencode.ts` writes rows BOTTOM-UP under a positive height.
  That is BMP's convention and the opposite of the top-down samples held
  everywhere else here — `bmp.ts` centralises the same flip on the reading side
  in `eachRowTopDown`. Wrong, it yields a vertically mirrored image, which is a
  plausible picture rather than an obvious fault, so the fixture pinning it is
  asymmetric TOP-TO-BOTTOM; a left/right one cannot see the flip at all.
  **Invariant:** rows pad to a 4-byte boundary (`fileStride`, reused from
  `bmp.ts` so the two halves cannot disagree), which differs from the packed
  length whenever the width is not a multiple of 4 — the shear `bmp.ts` already
  records in the other direction.
  **Invariant:** GIF's LZW is **not** `lzw.ts`'s. That one is PDF's —
  8-bit-rooted, MSB-first, with the early-change quirk — while GIF's is
  LSB-first, takes its root size from the palette, and frames output in
  length-prefixed sub-blocks. Reusing `lzwEncode` produces a structurally valid
  file that decodes to noise.
  **Invariant:** the code width grows when the dictionary passes `1 << width`,
  one step LATER than the naive reading, because the width applies to codes
  already emitted. Off by one desynchronises the decoder partway through, so
  the first half of the image is fine and the rest is garbage.
  **Invariant:** `quantize.ts` passes an image of at most 256 distinct colours
  through EXACTLY, reporting `exact`. Not an optimization: it is why GIF is
  usable for rendered pages at all, since a document of text and flat fills is
  losslessly representable and only a photograph reaches the median cut.
  **Note on the oracle, and it is weaker than every other codec here:** `src/`
  has no GIF reader, so this writer cannot be checked against its counterpart
  the way `tiffencode.ts` is against `tiff.ts`. `test/helpers/decode-gif.ts` is
  a test-only reader written independently from the GIF89a spec — the
  arrangement `scripts/jbig2-codec.mjs` has against `src/jbig2*.ts`. It is
  deliberately STRICT where the spec is: it requires the opening Clear code,
  which real decoders commonly tolerate the absence of. Measured — a lenient
  oracle leaves an encoder that omits it entirely green. There is no
  third-party GIF in `test/fixtures/`.
- **tiffencode.ts** — the TIFF **writer**, behind `doc.ToTiff()`, `page.ToImage({ format:
  'tiff' })` and the public `encodeTiff`. Note the direction: `tiff.ts` is the
  reader, and the two share no code — only a format.
  **Invariant:** pure. Bytes in, bytes out, no `Document` and no PDF object,
  the split `svgdraw.ts`/`svgembed.ts` makes, which is what lets every rule be
  tested from hand-built samples.
  **Invariant:** frames are a LIST and a single-page write is a list of one. A
  multi-page TIFF is not a different writer — it is the same IFDs with their
  `nextIFD` pointers chained — and it is the format's whole reason for existing
  in archival and fax pipelines. Building the one-page writer first would mean
  rewriting the offset arithmetic, which is the only part that is easy to get
  wrong. `doc.ToTiff()` is the entry that cashes this in, over
  `renderDocumentToTiff` in raster.ts: encoded TIFFs cannot be CONCATENATED, so
  a per-page call could never produce one and every frame must reach a single
  `encodeTiff`. That is also why `renderCanvas` is split out of `renderPage` —
  the multi-page path needs each page's SAMPLES, not a finished file.
  **Note:** `ToTiff` guards an EMPTY page selection itself rather than letting
  `encodeTiff` refuse. `resolvePages([])` is legally empty, and the encoder
  would report in terms of a function the caller never called; the actual
  mistake is a selection that matched nothing.
  **Invariant:** every choice comes from the set `tiff.ts` already decodes, so
  a file we write is one we can read back. Layout is header, then all strip
  data, then the chained IFDs — data first is what lets a strip offset be known
  before the IFD naming it is written, so the file is one forward pass with
  only `nextIFD` patched.
  **Invariant:** `ExtraSamples` is **2** (unassociated), never 1. `tiff.ts`
  divides associated alpha back out on read, so writing 1 over straight alpha
  brightens every SEMI-transparent pixel on the round trip. **Measured:** a
  fixture whose alpha is only 0 or 255 cannot see this at all — 255 divides by
  one and 0 is forced to 0 — so it stays green with the wrong value written.
  The half-alpha pixel in `test/raster-tiff.test.ts` is the whole test.
  **Note, measured:** asserting that a tall page's pixels round-trip does NOT
  pin the strip split; one whole-image strip reassembles perfectly. The count
  is read out of tag 273 for that reason.
  **Note on the oracle's ceiling, and do NOT read the green suite past it:**
  the tests read what we write back through `tiff.ts`, usable only because
  `test/fixtures/tiff/` anchors that decoder against libtiff and utif2. It is
  still OUR decoder, so anything it TOLERATES is invisible — removing the
  word-alignment before each IFD leaves all 12 cases green, because the reader
  seeks to the offset and does not care, while TIFF 6.0 requires it. There is
  no third-party TIFF *validator* in this suite, the gap `docxpackage.ts`
  records about not being able to open Word.
  **Note:** CCITT G4 is absent. `ccitt.ts` is decode-only, so it is a T.6
  encoder from scratch rather than wiring — tracked as its own issue, and it is
  what a bilevel scan needs to be small.
- **rasterimage.ts**, **bmp.ts**, **tiff.ts** — raster image INPUT, the decoders
  behind embedding a `.bmp` or `.tif`. Note the direction: `jpeg.ts`, `jpx.ts`
  and `jbig2.ts` decode streams already inside a PDF, and these turn a file on
  disk into one.
  **Invariant:** `rasterimage.ts` is a TYPE-ONLY leaf importing nothing. Both
  decoders produce a `RasterImage` and exactly one place consumes it —
  `imageembed.ts`'s `buildRasterXObject` — which is what lets the two depend on
  it without a cycle and keeps either of them free of PDF knowledge.
  **Invariant:** its rows are TOP-DOWN and padded to a BYTE boundary only, never
  a format's own row stride, so `samples` can be handed to a PDF image stream
  unchanged. Both formats store rows their own way, so both convert on the way
  out rather than teaching `imageembed.ts` two layouts.
  **Invariant:** `bmp.ts` has ONE owner of the row flip, `eachRowTopDown`. A
  positive `height` means the file stores the bottom row first, and every decode
  route reads its rows through that function — so no two of them can disagree
  about which end of the file the top row lives at, which would flip some depths
  and not others.
  **Note:** `fileStride` (padded to 4 bytes, wingdi's rule) and `packedStride`
  (padded to 1) are deliberately separate. Reading with the output stride walks
  progressively further into the wrong row on any width that is not a multiple
  of 4 — a shear, not a crash.
  **Invariant:** TIFF's `ExtraSamples 1` is ASSOCIATED alpha and must be divided
  out. PDF's `/SMask` composites colour × alpha, so premultiplied colour
  multiplies alpha in twice: the image renders too dark, worst exactly where it
  is most transparent, which reads as a bad picture rather than a decode fault.
  Value 2 is unassociated and passes through.
  **Note:** a tiled TIFF is the only shape that separates the BLOCK width
  `decodeCcitt` is told from the IMAGE width; `test/tiff.test.ts` leaves that
  mutation green and `test/fixtures/tiff/`'s tiled-G4 file is what catches it.
- **embeddedfont.ts**, **subset.ts**, **fontembed.ts**, **sfnt.ts**, **woff.ts**,
  **cff.ts**, **cffsubset.ts**, **cffstrings.ts** — authoring-font embedding:
  `AddFont`/`AddFontFile` parse the sfnt (**sfnt.ts**), accepting raw
  `.ttf`/`.otf` and reconstructing WOFF/WOFF2 web fonts to sfnt in memory
  (**woff.ts**), subset TrueType `glyf` (**subset.ts**) and CFF (**cff.ts**
  parse, **cffsubset.ts** CID-keyed `CIDFontType0C` subset build with a
  whole-embed fallback, **cffstrings.ts** the 391 predefined SIDs behind
  SID→glyph-name resolution), and emit Type0/Identity-H at `Save`.
  **Invariant:** the WOFF2 `glyf` transform discards the format's compact
  encodings, so reconstruction must re-choose them — short-form deltas, `SAME`
  bits, `REPEAT` flag runs. Emitting the plain long form is semantically correct
  and silently inflates `glyf` by ~28%, which reaches the PDF because
  `subset.ts` copies glyph bytes verbatim.
- **fontnames.ts**, **fontsource.ts** — finding a font by FAMILY NAME
  (`doc.RegisterFontFolder`, `doc.RegisterSystemFonts`, `doc.LoadFontByName`).
  `fontnames.ts` is a pure leaf reading an sfnt's `name`, `head` and `OS/2`
  fields and nothing else; `fontsource.ts` scans folders and holds the index,
  and is the only module in this feature that touches `node:fs`.
  **Invariant:** `fontnames.ts` is the ONE owner of the `name` table. `sfnt.ts`
  walked the records itself for ID 6 alone and was free to disagree with this
  one about platform preference — a font may carry both a platform-1 and a
  platform-3 record for the same ID, and platform 3 wins here because that is
  what other tooling reads.
  **Invariant:** a missing family (ID 1) leaves `FontNames.family` EMPTY rather
  than declining the font, and that is load-bearing rather than lax. `sfnt.ts`
  asks only for the PostScript name, which becomes the embedded font's
  `/BaseFont`, so declining a font that states ID 6 and no ID 1 drops it — a
  regression `test/sfnt.test.ts` caught on the first run of the delegation
  above, because its fixture name table carries only ID 6. `indexFolder` skips
  an empty family instead, since a face that cannot be matched by name is no
  use to an index that exists for nothing else.
  **Invariant:** indexing reads each candidate PARTIALLY, through
  `openSync`/`readSync` — 12-byte header, table directory, then only the byte
  ranges the three tables occupy. `readFileSync` is the obvious reach and is
  wrong: a system font folder holds thousands of faces and a CJK font runs to
  tens of megabytes. Measured — swapping the ranged reads for a fixed 64 KB
  prefix reddens exactly the fixture whose `name` table sits past a large
  `glyf`, and nothing else.
  **Invariant:** the system font directories are OPT-IN. Searching them by
  default makes the same code build different documents on different machines,
  and the failure surfaces at `Save` as a missing face rather than at the call
  — which is incompatible with a library whose test strategy is byte-identity
  fences. `systemFontFolders()` returns paths whether or not they exist, and
  the scan skips what is absent: no machine has every directory it names.
  **Invariant:** a miss returns `undefined` and NOTHING here throws. One
  corrupt file in a system font directory must not break every lookup on that
  machine.
  **Invariant:** `LoadFontByName` memoizes per document by resolved file PATH,
  not by the requested name, so two names resolving to one file share a handle.
  Without it a family drawn twice is subset and embedded twice.
  **Invariant:** a `.ttc`/`.otc` is indexed FACE BY FACE, in place — one
  `FaceRecord` per face, all sharing the file's path and told apart by
  `faceIndex`. Reading names needs no extraction, so the partial-read cost
  model survives one level deeper; `extractTtcFace` runs only when a face is
  actually loaded.
  **Invariant:** `LoadFontByName`'s memo is keyed `path#faceIndex`, NOT by path
  alone. Every face of a collection shares one path, so a path-only key hands
  back face 0's font for all of them and every glyph is drawn from the wrong
  face, silently. Measured: it reddens exactly the two collection cases in
  `test/font-byname.test.ts`.
  **Note:** the prefer-a-plain-face rule is no longer a rule of its own. Since
  `l1my.3` it is SUBSUMED by `fontmatch.ts` — it is exactly what resolving at
  `{ weight: 400, italic: false }` does — and `document.ts` holds no matching
  logic at all.
- **fontmatch.ts** — choosing WHICH face of a family, a pure leaf over
  `FaceRecord[]`: no `node:fs`, no `Document`, no font file, which is what lets
  every branch of the weight walk be asserted from hand-written naming fields.
  **Invariant:** the matching rule is CSS Fonts 4 §5.2, **cited rather than
  invented** — slant first, then the desired-weight walk. This repo anchors its
  trickier arithmetic outside itself (32000-1, T.88's SLTP constants, UAX
  #9/#14, Adobe TN #5014), and a hand-rolled weight rule would be one more thing
  only our own tests agree with.
  **Invariant:** **slant OUTRANKS weight**, which is the surprising half.
  `{ weight: 700, italic: true }` over a family holding *[Regular, Bold,
  Italic]* yields **Italic**, not Bold — the upright bold face is a worse answer
  than the italic regular one. A weight-first matcher returns a perfectly
  plausible face, so this is asserted alone in `test/font-match.test.ts` and
  named for what it protects.
  **Note, measured rather than assumed:** the companion case "picks the best
  weight WITHIN the matching slant" needs the wrongly-slanted face to be a
  BETTER weight match than any correctly-slanted one, or it passes with the
  slant pass deleted. A family of *[Regular, Italic, Bold Italic]* asked for
  `{ 700, italic }` returns Bold Italic either way, being an exact weight hit;
  the fixture therefore offers an upright Black against a requested 900.
  **Invariant:** a family CHAIN selects a **family**, and style matching then
  runs inside the winner. `['Arial', 'Liberation Sans']` at weight 700 with
  Arial present in Regular only gives Arial Regular and never consults
  Liberation Sans. The caller stated a preference order over families; scoring
  family position against style distance instead makes the answer depend on a
  weighting nobody can predict from the docs, and lets installing a font
  silently displace an earlier choice.
  **Invariant:** `l1my.1`'s prefer-a-plain-face rule is **subsumed, not
  replaced**. `test/font-byname.test.ts`'s pre-existing cases are the fence for
  that claim and stayed green unedited through the change; a red one there means
  the general rule got the special case wrong, not that the fixture is stale.
  Measured: loosening the tie-break comparison to `<=` reddens the
  registration-order case, so the fence passes on purpose rather than by luck.
  **Invariant:** every style signal is POSITIVE evidence and they are OR-ed, the
  rule `fontStyleOf` already sets in font.ts. The weight corroboration fires
  ONLY at 400, because 400 is what an absent `OS/2`, a stated 0 and a genuine
  Regular all produce alike — the one value that may mean "said nothing" — and a
  mis-stated Bold left there costs twice, being unreachable at 700 AND a rival
  for the face returned at 400. At any other value the font made a numeric
  statement and the subfamily name is a second opinion nobody asked for.
  **Invariant:** `SUBFAMILY_WEIGHTS` is ORDER-dependent: `ExtraLight` contains
  `Light` and `SemiBold` contains `Bold`, so the compound spellings are tested
  first or a first-match scan reports 300 and 700 — plausible weights, and both
  wrong.
  **Invariant:** `LoadFontFamily` fills a slot only when the chosen face plays
  that role, and leaves it absent otherwise — filling it with the regular face
  gives a one-weight family four faces that are one face. **Measured:** both
  builds render identically, so only an assertion on the SLOT can see it; the
  `AddMarkdown` case stays green either way.
  **Note:** the bold slot is a BUCKET (`weight ≥ 600`), not `FontMatch.exact`'s
  equality, and the two differ on purpose. A family shipping Semibold and no 700
  has a bold face — it is the only heavier face there is — while resolving it at
  700 reports `exact: false`, because the caller asked for 700 and did not get
  it. "Which face plays this role" and "did I get what I asked for" are
  different questions.
  **Note:** a face whose weight lives in ID 1 with no typographic pair
  (`Arial Narrow`) is its own family under the ID 16-else-ID 1 rule and is not
  reachable as a style of the base name. Documented as a limit rather than
  fixed: decomposing a family name would be exactly the string-parsing the
  derivation rule refuses to do on subfamilies, and it would make
  `LoadFontByName('Arial')` start matching files it does not match today.
- **ttc.ts** — TrueType/OpenType Collections. `ttcFaceOffsets` reads the `ttcf`
  header (versions 1.0 and 2.0 differ only after the offset array, so one
  reader serves both, and `.otc` is the same container with CFF faces);
  `extractTtcFace` rebuilds one face as a standalone sfnt through
  `sfntwrite.ts`'s `assembleSfnt`. `parseSfnt(bytes, faceIndex)` detects the
  header and delegates.
  **Invariant:** a face is EXTRACTED, never read in place, and this is the
  whole reason the module exists. A collection's per-face directories hold
  absolute FILE offsets and `SfntFont` resolves tables by absolute offset into
  its `raw` — so handing it the collection plus a face's directory offset
  decodes perfectly, in about five lines. It would also mean `fontembed.ts`'s
  CFF fallback, which whole-embeds `font.raw`, put every face of a 40 MB
  system collection into the PDF as one OpenType program. Extracting costs a
  copy of one face's tables and keeps collections invisible to subsetting,
  embedding, cmap and glyph access alike.
  **Note, measured:** that hazard has its own test — the extracted face must
  carry no trace of a sibling's name bytes. EVERY other assertion in
  `test/ttc.test.ts` passes under the read-in-place build; only that one fails,
  which is exactly why it is written as a byte search rather than as a name
  comparison.
  **Invariant:** `faceIndex` is ignored for a plain sfnt rather than rejected.
  A caller may not know which kind of file it was handed, so naming a face of a
  non-collection is meaningless, not an error. An out-of-range index on a real
  collection DOES throw `PdfParseError` — that is a caller naming something
  absent — while `fontsource.ts` catches it and skips the file, because one bad
  collection in a system directory must not break every lookup.
  **Note:** the folder walk does not follow symlinks — `Dirent.isDirectory()`
  is false for one — which is what actually prevents a cycle; `MAX_DEPTH` is
  defence behind that, for directories nobody in this project controls.
  **Invariant:** the walk opens a known font extension, a file with NO extension
  at all, and — only under `sniff` — anything else. The middle case is `l1my.4`:
  `peekNames` already judges by magic, so the extension filter was the sole
  thing hiding a font that had lost its extension in a repo or an archive. A
  DOTFILE is NOT extensionless — `.DS_Store` has its dot at index 0, so it falls
  to the extension test and stays skipped, which is the answer we want.
  **Invariant:** `sniff` is OPT-IN and `RegisterSystemFonts` never passes it.
  Widening to every file inverts the cost model the partial-read index exists
  for — a general asset folder then costs one open per image and blob — and the
  system directories are the case where that bites hardest.
  **Invariant:** the index cache key carries the sniff flag, not just the path.
  Two documents may want one folder scanned both ways, and a path-only key hands
  the narrow index to the sniffing caller or the wide one to a caller who
  declined the cost. Measured: dropping the flag from the key reddens the
  same two cases as deleting the sniff branch itself.
  **Invariant:** `sniff` is STICKY-ON and upgrades a folder IN PLACE.
  Re-registering must not move the folder — that is `l1my.1`'s guarantee that a
  helper registering on every call cannot perturb lookup order — but ignoring
  the flag on an already-held path means asking for the wider scan and silently
  not getting it. Both halves are pinned separately: ignoring the upgrade
  reddens the sticky case, and re-appending instead of upgrading reddens the
  order case.
- **type1.ts**, **type1charstring.ts** — the Type 1 (`/FontFile`) reader, the
  third embedded-outline format beside sfnt and CFF. Note the direction: this is
  *reading* an embedded program for rendering, not authoring one — nothing here
  is reachable from `AddFont`. `type1.ts` is the container (PFA/PFB framing,
  eexec decryption, `/Subrs`, `/CharStrings`, the program's own `/Encoding` and
  `/FontMatrix`); `type1charstring.ts` is the interpreter, pure and knowing
  nothing of PDF or of the container.
  **Invariant:** a Type 1 charstring is interpreted here, not by `cff.ts` with a
  flag. The two grammars share the operand encoding minus two cases and differ
  in every operator that clears the stack: `255` is a 32-bit integer here and
  16.16 fixed there, `callsubr` is **unbiased**, `hlineto`/`vlineto` take one
  argument rather than alternating over the stack, `closepath` exists and
  `hintmask` does not, and flex arrives through `callothersubr` rather than as
  an operator. A mode flag would fork inside nearly every branch.
  **Invariant:** `hsbw` moves the pen. It sets the current point to `(sbx, 0)`
  as well as recording the width, so an implementation that reads only the width
  leaves every glyph displaced by its own left sidebearing — uniformly enough
  across a font to read as a slightly wrong face rather than as a bug. `seac`'s
  accent offset is `sbx - asb + adx` for the same reason: drop the correction
  and every accent shifts by the two glyphs' sidebearing difference, which reads
  as bad kerning.
  **Invariant:** glyph ids are this parser's own numbering, order of appearance
  in `/CharStrings`, and carry none of the CFF/TrueType conventions. The bundled
  `NimbusSans-Regular.t1` lists `/A` first and `/.notdef` **last**, so assuming
  gid 0 is `.notdef` — or indexing the program by character code — is wrong by
  854 on the one real font we have.
  **Invariant:** code → glyph *name* has one owner, `glyphNameResolver` in
  font.ts, applying 32000-1 9.6.6.2 — `/Differences`, the named base encoding,
  the font program's own `/Encoding`, StandardEncoding — and both name-keyed
  program kinds go through it. `gidForCode` used to answer "assume gid = code"
  for a simple font with a bare `/FontFile3`, a guess that is right only under a
  charset nobody promised. `baseEncodingNamesByName` returns `undefined` rather
  than defaulting to WinAnsi the way `baseEncodingByName` does, because the
  *next* authority is the program's own encoding and a default would silently
  outrank it.
  **Note:** the one real Type 1 fixture contains no flex, no `seac` and no
  `div`, and all 360 of its `callsubr` calls reach a hint-replacement no-op — so
  those paths are covered by `test/helpers/build-type1.ts` alone. `PROVENANCE.md`
  records which mutations that fixture provably cannot catch; do not read its
  green as coverage of them.
- **type1header.ts**, **type1cff.ts** — the AUTHORING half of Type 1, added in
  `l1my.5`. Note the direction: `type1.ts` reads a program embedded in a
  document being rendered, and these turn one on disk into a font we can embed.
  **Invariant:** the conversion needs NO charstring transcoder, which is why it
  is small. `type1charstring.ts` already yields a `Path` of M/L/C/Z cubics in
  glyph units, and that is exactly the Type 2 vocabulary (`rmoveto`, `rlineto`,
  `rrcurveto`, close implicit), so `encodeType2` re-emits the path as deltas.
  **Invariant:** HINTS ARE LOST, by decision rather than oversight. Preserving
  them means a second charstring grammar whose divergences `type1.ts` already
  records — unbiased subrs, `closepath`, `255` meaning a 32-bit integer rather
  than 16.16, flex arriving through `callothersubr`. The loss is INVISIBLE to
  this suite, since `raster.ts` is a scanline filler that ignores hints
  entirely, so it is documented in README and CHANGELOG rather than left to be
  discovered. Do not add a hint path.
  **Invariant:** the conversion is EAGER, inside `parseSfnt`'s signature
  dispatch — the rule `woff.ts` and `ttc.ts` already follow. That single
  placement is what lets subsetting, `/FontFile3`, Identity-H, `/ToUnicode` and
  `fontmatch.ts` all work with no change; keeping a `Type1Font` on
  `EmbeddedFont` instead would fork every consumer of `SfntFont`.
  **Invariant:** glyph ids are RENUMBERED so `.notdef` is gid 0, which CFF
  requires. `Type1Font` numbers by order of appearance in `/CharStrings` and
  `NimbusSans-Regular.t1` lists `/.notdef` LAST — so the font's own order puts
  the wrong glyph at 0 and shifts every other by one, off by 854 on the only
  real font available.
  **Invariant:** every charstring emits its width. `assembleCidCff` writes
  `Private [0 0]`, so `nominalWidthX` and `defaultWidthX` are both 0 — a width
  operand is then the width itself, and an OMITTED one means an advance of
  zero. A blank glyph is where that shows: a space would stop advancing.
  **Note, measured the hard way and the reason the plan's own assertion was
  rewritten:** `Type1Conversion.advances` cannot fence that rule. It is a
  pass-through from `Type1Font`, so it agrees with the source whatever the
  emitter does — deleting the width emit outright left the suite GREEN. The
  width is read BACK OUT of the charstring through `CffFont.glyphWidth`, the
  independent interpreter, which is the only assertion here that can see an
  omitted width operand.
  **Invariant:** the `cmap` is built from glyph NAMES through
  `encoding.ts`'s `glyphToUnicode`, never the program's built-in `/Encoding`,
  which addresses at most 256 codes and says nothing about the rest of
  `/CharStrings`.
  **Invariant:** `type1header.ts` imports NOTHING. `fontsource.ts` indexes
  thousands of files and must not pull a charstring engine in to read a family
  name — which is also why it duplicates `stripPfb` rather than importing
  `type1.ts`. Three value syntaxes, transcribed off the real fixture: `/FontName`
  is a NAME, `/FamilyName` and `/Weight` are parenthesised STRINGS, `/FontBBox`
  is four numbers in braces (brackets accepted, since real fonts write both).
  Measured: reading `/FamilyName` as a name, or `/FontName` as a string, each
  redden the fixture case. `type1.ts` takes its `/FontMatrix` from here, so the
  two cannot disagree about the same header.
  **Invariant:** a Type 1's header sits ahead of `eexec`, so `peekNames` reads a
  PREFIX and touches no glyph data — `l1my.1`'s cost model survives one more
  format. `.pfb`/`.pfa` are in `FONT_EXT`, so they are found by default and need
  no `l1my.4` sniff.
  **Note on the mapping into `FontNames`, which is where this meets `l1my.3`:**
  `/Weight` becomes `subfamily` — the exact word `weightFromSubfamily` parses —
  and the numeric `weight` stays at **400** so that `deriveStyle`'s
  corroboration, which fires only at 400, turns `Bold` into 700. Setting it to
  anything else silently disables style matching for every Type 1; measured, 500
  reddens the style case. `bold` stays false because `head.macStyle` has no
  counterpart here; the `/Weight` string is the positive evidence, which is how
  `fontmatch.ts` OR-s its signals.
  **Note, and do NOT read the green suite as covering it:** `type1.ts` already
  records that `NimbusSans-Regular.t1` contains no flex, no `seac` and no `div`,
  and that all 360 of its `callsubr` calls reach a hint-replacement no-op. Those
  conversion paths are exercised by `test/helpers/build-type1.ts` synthetics
  alone. `PROVENANCE.md` records which mutations that fixture cannot catch.
  **Note:** `otfFromCff`'s `OtfMetrics` gained an optional `psName` here,
  because `buildName()` hardcoded `'Embedded'` and every converted font's
  `/BaseFont` would have read that. The default is unchanged, so
  `htmlfontembed.ts`'s output stays byte-identical —
  `test/html-identity.test.ts` is the fence. Note the name reaches the file
  behind a six-letter SUBSET TAG like every other embedded face, so an assertion
  looking for a bare `/NimbusSans-Regular` finds nothing.
- **dfont.ts** — Macintosh `.dfont` suitcases, added in `l1my.6`. Note what the
  name does NOT mean: a `.dfont` is a *data-fork* font, holding
  resource-fork-FORMAT bytes in the ordinary data fork, which is the entire
  reason the format exists. There is no `..namedfork/rsrc` handling and no
  platform branch anywhere.
  **Invariant:** a face is a `subarray`, never a rebuild. Each `sfnt` resource
  is a complete, self-consistent sfnt whose table offsets are relative to its
  OWN start — unlike a `.ttc`, whose are absolute into the file, which is why
  `ttc.ts` must `assembleSfnt` and this must not. `SfntFont` threads
  `byteOffset` through every `DataView` (`sfnt.ts:21`), which is what makes the
  view safe; this module imports `errors.js` and nothing else, `sfntwrite.ts`
  included.
  **Invariant:** detection is STRUCTURAL, because a `.dfont` has no signature —
  it opens with a raw `u32` data offset. The walk that finds the faces IS the
  test that the file is one, so `dfontSfntRanges` returns `undefined` exactly as
  `ttcFaceOffsets` does. The map's 16-byte copy of the header is deliberately
  NOT checked: Inside Macintosh reserves those bytes but nothing enforces them,
  and a tool that zeroes the field would cost us a font for no benefit.
  **Invariant:** the branch goes LAST in `parseSfnt`'s dispatch, after the three
  `u32` signature compares. **Note, measured and NOT fenced:** hoisting it to
  the front leaves woff, ttc, type1-embed and dfont-embed all green — 28 cases —
  because nothing decodes wrong, every other format merely pays for a structural
  walk it can never match. This is a cost rule, so do not read the green suite
  as covering it.
  **Invariant:** the walk takes a reader CALLBACK rather than bytes. `parseSfnt`
  holds the whole buffer while `fontsource.ts` holds a file descriptor and must
  not read one, and a bytes-only signature forces `fontsource.ts` to keep its own
  map parse — which is how an index and a loader come to disagree about how many
  faces a file holds. Same seam `grayimage.ts` takes `resolve`/`inflate`
  through.
  **Four details that are silent when wrong, all mutation-checked:** both the
  type count and each type's resource count are stored **minus one**, so reading
  either raw makes every single-face suitcase yield nothing at all; the
  reference-list offset is based on the **type list**, not the map, and the two
  differ by the 28-byte prologue, so confusing them reads a plausible wrong
  list; a resource's `u24` addresses a **length**, so the sfnt begins four bytes
  later; and non-`sfnt` types share the map — a real suitcase carries `FOND`,
  often `NFNT` or `POST` — so faces are selected **by tag**, never by position,
  or a `FOND` record comes back as though it were a font.
  **Invariant:** `faceAt` in `fontsource.ts` takes a `base` added to each table
  offset, 0 for a bare sfnt and a collection and the resource start for a
  `.dfont`. Measured: dropping it reddens the five `.dfont` cases alone and
  leaves all 36 pre-existing ones green.
  **Note on the `FontNames` mapping:** there is none. A `.dfont`'s payload is an
  ordinary sfnt, so the existing `name`/`head`/`OS/2` reader answers, and
  resource IDs and resource names are ignored entirely — unlike `l1my.5`'s Type 1
  header, which had to be mapped by hand.
  **Note, measured, and the sharpest evidence for structural detection:**
  removing `.dfont` from `FONT_EXT` reddens the by-name, by-default and
  corrupt-file cases but leaves the EXTENSIONLESS case GREEN, because that path
  never consults the extension at all.
  **Note, and do NOT read the green suite as covering it:** there is no real
  `.dfont` in `test/fixtures/`. `test/helpers/build-dfont.ts` and this module
  share one reading of Inside Macintosh, so the suite proves they agree, not that
  either matches what Apple writes — the shared-convention class this repo keeps
  real-world fixtures for, uncovered here. `test/fixtures/fonts/PROVENANCE.md`
  records it.
  **Note:** a `.dfont` whose `sfnt` resource is itself a `ttcf` is out of scope.
  `faceIndex` is consumed by the container layer before such a payload reaches
  the collection test, so it would need two-level addressing nobody has asked
  for. `.suit` is out of scope too: its resources live in a TRUE resource fork,
  so on any non-Mac filesystem its data fork is empty or arbitrary.
- **shape.ts**, **otlayout.ts**, **otemit.ts**, **bidi.ts**, **linebreak.ts**,
  **unicode-data.ts** — opt-in complex-text shaping (`{ shape: true }` on
  `AddText`/`AddTextBlock`): UAX #9 BiDi + script itemization + Arabic joining
  (**bidi.ts**), UAX #14 line-breaking (**linebreak.ts**), and OpenType
  GDEF/GSUB/GPOS apply (**otlayout.ts**) driven by **shape.ts**, emitted as
  Identity-H glyph runs (**otemit.ts**), over range-compressed Unicode 16 lookup
  tables (**unicode-data.ts**).
- **table.ts**, **tablemodel.ts**, **tablegrid.ts**, **tablestream.ts**,
  **tableorient.ts**, **tablestruct.ts**,
  **tablestitch.ts** — table extraction: geometry (ruling lines + text, rotated
  frame), the tagged `/Table`-tree path, cross-page stitching, and the `Table`
  model with `toHtml()`/`toMarkdown()`. There are TWO geometry detectors, and
  `buildTables` runs both: the RULED one in `table.ts`, and the whitespace
  ("stream") one in **tablestream.ts**, over the fragments left outside every
  ruled table. `table.ts` keeps only what reads a `Document` or a page's paths.
  **tablegrid.ts** is the grid arithmetic both detectors share — `buildCells`
  plus `centroid`/`contains`/`rowBbox`/`cellText`.
  **Invariant:** `tablegrid.ts` is a LEAF. Both detectors import it, so it
  imports neither; that is what keeps `tablestream.ts` from having to take
  `buildCells` as an argument the way `docxtable.ts` takes its paragraph
  builder. `rectContains` stays in `table.ts` — ruled-only, and it needs `SNAP`.
  **Invariant:** `tablestream.ts` is pure over `TextFragment[]` — no `Document`,
  no `Page`, no content walk — which is what lets every threshold be tested from
  hand-built fragments. It must not import `tablestruct.ts` (tagged extraction)
  or `tableink.ts` (border recovery). It had no test file at all until `c3t7.5`,
  observable only through `GetTables` on a built PDF, which is exactly how that
  issue's premise came to be wrong.
  **Invariant:** the whitespace detector infers a `colSpan` but never a
  `rowSpan`. Its rows come from baselines, so a cell covering two bands is
  indistinguishable from ordinary wrapped text — the common case, not the
  exception — and guessing there merges two real rows.
  **Invariant:** span detection runs AFTER the prose guard and changes nothing
  the detector decided. The guard still runs on the all-true grid and the final
  cuts are still the ALL-ROWS cuts; the reference cuts are a yardstick that never
  becomes the final grid. `decorateInk`'s rule, applied to the other detector —
  which is what makes the feature incapable of regressing the most heavily
  tested geometry in this stack.
  **Invariant:** the reference cuts come from the rows with the MODAL fragment
  count, ties resolving to the higher, because a spanning row distorts the very
  boundary it crosses. Measured: a header at x 20..93.4 over body columns at
  20..33 and 120..133 pushes the all-rows cut to 108 and so sits *entirely
  inside* column 0 — it is even narrower than its own column, which is why a
  width-ratio test against that column has the sign backwards.
  **Invariant:** the two cut systems are joined by INDEX, never position. Both
  must describe the same column count or span detection declines outright; on
  the canonical fixture they differ by 31pt, so no honest tolerance could join
  them.
  **Invariant:** cardinality is NOT the span signal — width is. A sparse row
  holds a single fragment too (`Bolt` alone in a two-column table), and spanning
  it would make `toMarkdown` print `Bolt | Bolt`, inventing data. `SPAN_OVERHANG`
  is the precision knob: measured, the canonical header clears the reference cut
  by 29% of the next column and a wrapped cell ending just past the midpoint by
  ~6%. The error is badly asymmetric — a false span destroys structure (a column
  vanishes from that row, `toMarkdown` repeats text, `AutoTag` announces a wrong
  `ColSpan`) while a missed one is merely the old flat output.
  **Invariant:** `spanSeparators` reads `ln[0]` only, which is safe SOLELY
  because of the single-fragment guard. Measured the hard way: dropping that
  guard left the suite green twice — first because no fixture had a straddling
  fragment, then because the straddling one sat at index 1.
  **Note on fixtures here, all three measured:** a UNIFORM table cannot exercise
  the span rule at all (every row is a reference row, so there are no
  candidates); `expect(colSpan).toBe(2)` passes if EVERYTHING spans, so it needs
  a body-rows-are-1x1 companion; and a fragment's width must be stated
  explicitly rather than derived from `text.length`, which made a synthetic
  header 93.5pt against the real 73.4pt — wide enough to close the column gap
  and stop detection entirely.
  **Invariant:** `PROSE_FILL` is knife-edge. A 4-row table whose second column
  holds text in exactly 2 rows passes; one fewer and the whole table is rejected
  as prose. It is the precision/recall knob for the detector as a whole.
  **Invariant:** the geometry detector needs an *interior* rule. A component
  with two horizontal and two vertical rule positions is satisfied by a bare
  rectangle outline, so `buildTables` requires `rowCount > 1 || colCount > 1` —
  a 1x1 grid is page furniture (a card, a callout, a frame), and an interior
  separator is the positive evidence of tabular intent the whole detector runs
  on. Content-presence is *not* the test: a card with a line of text is no more
  a table than an empty one. Reporting boxes cost twice over, because
  `AutoTag` shares this detector: the HTML export filled with empty `<table>`s
  and the structure tree with one-cell `Table > TR > TD` subtrees, where a
  screen reader announces decoration as data. `buildRuledRegion`'s nested path
  already required 2x2.
  **Invariant:** this rule is for *geometry* only. `extractTaggedTables` reports
  a 1x1 `/Table` as authored — a tag is a statement, detection is a guess.
  **tableink.ts** is the ink index behind per-cell borders and shading: it reads
  `page.GetPaths()`, whose `PagePath` carries `fill`/`stroke` COLOUR and a
  CTM-scaled `lineWidth` — none of which `text.ts`'s `PathEvent` has, which is
  why the detector alone could never see a rule's thickness or colour. Pure over
  `PagePath[]`, so every rule below is testable without building a file.
  **Invariant:** decoration runs AFTER `buildTables` and changes nothing the
  detector decided. That is what makes the feature incapable of regressing
  detection, and why moving detection onto `GetPaths()` was rejected.
  **Invariant:** the tolerances are ARGUMENTS. `table.ts` owns `SNAP`,
  `MIN_RULE_LEN` and `MAX_RULE_THICK` and passes them in, so the detector and
  the index cannot drift about what counts as a rule — the drift shows up as a
  border on some edges and not others.
  **Invariant:** a stroked edge comes from the path's SUBPATHS transformed
  through its own `ctm`, never from `bbox`. A grid drawn as one stroked path has
  a single bbox covering the whole table, which would border everything.
  **Invariant:** a fill claims a cell only when EACH of its four edges is within
  tolerance of the cell's — never merely containing it. A page background, a
  full-table wash and a shaded header cell are all filled rectangles, and
  containment paints the whole table grey. Where several qualify the LAST in
  content order wins: it is the one painted on top.
  **Invariant:** an edge must SPAN the cell side, not merely overlap it — a
  short rule under one column does not border the cell beside it.
  **Invariant:** `TableCell.borders` ABSENT means *not recovered* (a tagged
  table, a rotated one) and every consumer falls back to what it drew before the
  field existed; an edge missing from a PRESENT `borders` means *measured
  absent* and draws nothing. Same distinction `parseSimpleWidths` records about
  a present versus an absent `/MissingWidth`.
  **Note, measured rather than assumed:** the *consumer* half of that rule is
  pinned (`test/docx-table.test.ts` "treats a present-but-empty borders as
  recovered"), but the *producer* half — `decorateInk` assigning `borders`
  unconditionally — is **not**. Every cell of a detected ruled table has edges
  by construction, so making the assignment conditional leaves the whole suite
  green. Retained because the reasoning is sound; do not read the green suite
  as covering it.
  **Invariant:** recovery is skipped for a rotated table. Its cell quads are in
  the table's own upright frame while ink is in page space, and `borders` being
  absent is already how the model says so.
  **Invariant:** `Table.toMarkdown` distinguishes a table that carries NO header
  information from one that reports none, and gives them different answers.
  `isHeader` and `section` are tagged-path only, so a geometry-detected table
  sets neither: that is ignorance, and its row 0 stays the header — the common
  layout, and what the method has always emitted. A table that *did* report its
  structure and named no head genuinely has none, and gets a synthesized empty
  header row (GFM has no headerless table) rather than having a row of data
  relabelled as a heading. Collapsing the two is the same mistake
  `parseSimpleWidths` records about a present versus absent `/MissingWidth`.
  **Invariant:** what GFM's grammar cannot express is reported, never dropped —
  a nested table follows its parent as its own table (GFM cannot nest), a
  `/Summary` becomes a paragraph above it, a cell's newline becomes `<br>` as
  `toHtml` already does, and a zero-row table returns `''` rather than throwing
  on `grid[0]`. GFM permits exactly ONE header row, so a second `/THead` row is
  demoted to a body row rather than merged, which would invent text. Column
  alignment is absent because *extraction* records none — there is nothing to
  emit, not a gap.
  **Note:** `toHtml`'s own `<br>` went unasserted from the day it was written
  until `no93.3`, and was found only because a mutation aimed at `toMarkdown`
  matched that line first and the suite stayed green. Both are pinned now.
  **Invariant:** a `/Table` element's `/Pg` is optional and usually absent —
  `StructElement.Page` walks `/Pg` *up* the ancestor chain, never down into
  content, and `MarkContent` puts `/Pg` on the `TD`/`TH` it marks. So `el.Page`
  is undefined for every table `AutoTag` authors. Never key a table lookup on
  it: build from the element through `tableFromStruct`, which resolves the page
  via `primaryPage` (first content-bearing cell, else `/Pg`) — the same rule
  `extractTaggedTables` filters by. Keying on `el.Page` is what made the
  semantic HTML export emit zero tables from a 33-table tree.
- **struct.ts**, **structwrite.ts**, **structattr.ts**, **structpreserve.ts**,
  **autotag.ts** — tagged-PDF logical structure: read (`GetStructTree`), author
  (`CreateStructTree`, `tag`, `MarkContent`), typed `/A`+`/C` attribute views,
  structure preservation across split/merge/extract, and heuristic `AutoTag`.
  **Invariant:** `MarkContent` marks EVERY content stream its region covers, one
  balanced `BDC … EMC` per stream with its own MCID, all appended as kids of the
  one element (`regionOpSpans`). A page's `/Contents` is an array as often as
  not — `page.AddText` splices a new stream per call — and a region covering
  several is one line of text, not a damaged file: 32000-1 7.8.2 makes the
  division between streams unrelated to the page's logical content. It used to
  keep only the stream with the MOST hits, so the rest of the region was left in
  no element and not artifacted either, vanishing from the structure tree and
  from every export built on it, and firing `UntaggedContent` on a document we
  had just tagged (c3t7.10). `walkScope` would in fact tolerate one sequence
  opened in one stream and closed in another — it keeps `activeMcid` outside its
  stream loop — but per-stream balance is the rule this repo already holds
  itself to, and it leaves each stream well-formed for a reader that does not
  concatenate. The return stays the FIRST MCID, so a caller cannot tell a
  one-stream region from a three-stream one.
  **Note, measured:** the multi-stream case had never been exercised. All three
  tests in `test/struct-mark-content.test.ts` and every `AutoTag` fixture called
  `buildMultiStreamPage([ONE_STREAM])` — the helper is named for the shape it
  was never asked to build. The end-to-end guard is
  `test/autotag.test.ts`'s three-`AddText` page, which is what an authored page
  actually looks like.
  **Invariant:** `StructElement.Nodes` splits a parent's own text run around the
  child sequences nested INSIDE it, using each glyph's content position
  (`mcidIndex`), not just its MCID. A child's marked content is normally nested
  within its parent's — a `/Link` mid-paragraph is the everyday case — so the
  parent's glyphs sit on both sides of it. Grouping by MCID alone knows both
  exist but not where the child sat, which emitted the whole paragraph and then
  appended the link: `See the docs here.` exported as `See here.the docs`. It
  falls back to `/K` order whenever any element child contributes no glyphs (a
  `/Figure` whose `/K` is an `/OBJR`), because such a child has no position to
  sort by and guessing one could REORDER content rather than merely fail to
  split it. `.Nodes` has one consumer, `docmodel.ts`, so this reaches only the
  Markdown and HTML exports.
  **Invariant:** a text node keeps the leading and trailing spaces its glyph run
  drew (`spacedText`). `assembleLines` drops whitespace at a line's edges, which
  is right for a whole element and wrong for a fragment of one: a `/Link` draws
  `(the docs )` inside its own marked content, and dropping that space joins the
  words either side into `Seethe docshere.`.
  **Invariant:** removing an annotation must also untag it (`untagObjects`, the
  mirror of `tagAnnotation`, called by `Page.RemoveAnnotation` and
  `formremove.ts`). `/StructTreeRoot` is reachable from `/Root`, so the `/OBJR`
  kid naming an annotation keeps it alive through `Save()`'s mark-sweep — the
  file then carries a widget that is in no `/Annots` and no `/AcroForm /Fields`,
  exactly as a leftover `/AcroForm /CO` entry did.
  **Invariant:** *flattening* an annotation must **retag** it, not untag it
  (`retagAsContent`, called by `flatten.ts`). Removal destroys the annotation
  and its ink together, so dropping the tag loses nothing that still exists;
  flatten keeps the ink as page content, so the `/OBJR` becomes a
  marked-content kid in the *same* `/K` slot — appending instead moves the
  baked ink behind whatever used to precede it. `/Form` retypes to `/Figure`
  and `/Link` to `/Span`, since neither describes an annotation any more. When
  the tag cannot be rewritten (a `/Kids`-based `/ParentTree`, a `/StructParent`
  naming no element), fall back to dropping it — flatten must never throw on a
  tree shape we merely decline to author into.
  **Invariant:** per-object flatten bakes *before* it unwires
  (`flattenFieldWidgets` in flatten.ts, behind `Field.Flatten` /
  `Annotation.Flatten`). `retagAsContent` reaches its element through the
  `/OBJR` naming the annotation, and `removeField`'s `untagObjects` deletes
  exactly that `/OBJR` — and `removeField` detaches the widgets from `/Annots`
  too, which is what flatten walks. Unwire first and nothing is baked at all,
  while the structure element loses its only kid and gets pruned. In the right
  order `untagObjects` is a no-op: the `/OBJR` is already a marked-content kid
  and the widget's `/StructParent` is already deleted.
  **Invariant:** `UntaggedContent` covers text, images *and* vector paths.
  `PathEvent` carries `mcid`/`artifact` for exactly this; before it did, the rule
  could not subscribe and silently under-reported every untagged fill and stroke.
  **Invariant:** marked-content state propagates into Form XObjects. A sequence
  must open and close within one stream, but a form drawn inside one is still
  part of it, so `walkScope` threads `activeMcid`/`inArtifact` through its
  recursion — without that, everything inside a correctly tagged form reads as
  untagged.
  **Invariant:** a producer that draws vector content never guesses its own
  marking. `AddBarcode`/`AddSVGObject` take `tag`/`alt`/`artifact` (in
  `structwrite.ts`'s `MarkOptions`, applied by `markDrawing`) and default to
  none, leaving output byte-identical and letting the validator report honestly.
  Artifacting by default would declare a barcode decorative and hide the data it
  encodes; auto-tagging a `/Figure` without an `/Alt` merely trades
  `UntaggedContent` for `IllustrationAlt`.
- **structvalidate.ts**, **pdfavalidate.ts**, **pdfxvalidate.ts**,
  **validation.ts** — validators (`ValidatePdfUa`, `ValidatePdfA`,
  `ValidatePdfX`) returning a shared `ValidationReport`, over the neutral scan
  machinery in **validatectx.ts** (all-objects walk, content color scan,
  ExtGState and annotation collection, font enumeration), which both the PDF/A
  and PDF/X rule sets consume. **conversion.ts**, **pdfaconvert.ts**,
  **pdfuaconvert.ts**, **pdfxconvert.ts**, **pdfxcolor.ts**, **srgb.ts** —
  remediation (`ConvertToPdfA`, `ConvertToPdfUa`, `ConvertToPdfX`) with the
  bundled sRGB profile.
  **Invariant:** PDF/X conversion never silently alters printed appearance —
  live transparency, non-embeddable fonts, RGB rasters and annotations
  overlapping the trim area are reported unresolved, and the RGB→CMYK rewrite is
  opt-in because a naive conversion without the destination profile produces
  wrong ink on press.
  **Invariant:** presence of a dict key must be tested on the raw dict, not on
  the resolved value — `doc.resolve(undefined)` returns `null`, so
  `R(d.get(k)) !== undefined` is true for *every* absent key. This silently
  fired PDF/X rules on keys that were not there; a fixture with no ExtGState at
  all is what let it through.
- **svgrender.ts**, **raster.ts**, **pagerender.ts** — rendering (`ToSvg` /
  `ToImage`): a shared content-stream interpreter, a pure-TS scanline rasterizer,
  and glyph-outline drawing.
  **Invariant:** image transparency in `raster.ts` is a three-step fallback in
  `decodeImageRgba`, in this order: `/SMask`, then a stencil `/Mask` stream,
  then a colour-key `/Mask` array. The two `/Mask` forms are one entry so only
  one can be present; `/SMask` outranks both, being the richer mask and, per
  32000-1, mutually exclusive with `/Mask` anyway. A stencil `/Mask` is read
  with `/ImageMask`'s polarity — sample 0 PAINTS under the default
  `/Decode [0 1]`, and `/Decode [1 0]` flips it — because ignoring that
  `/Decode` renders the precise NEGATIVE of the intended transparency, which
  reads as deliberate rather than broken.
  **Invariant:** the colour-key rule itself lives in `colorkey.ts`, shared with
  `grayimage.ts`, so a greyed document cannot mask differently from the
  original. `colorKeyAlphaFor` passes the SAMPLE stride, and for an Indexed
  image `resolveColorSpace` already reports one component — the `indexed` flag
  beside it is about SCALING (a raw index rather than a 0..1 fraction), not
  about stride.
  **Invariant:** `decodeImageRgba` lives in **imagergba.ts**, not here. Three
  unrelated consumers want "image decoded to RGBA" and only one is a renderer:
  this module paints it, `redact.ts` inspects samples, and `imagehref.ts`
  re-encodes it to PNG for five exports. Reaching it through `raster.ts` would
  make a Markdown export import the rasterizer — the glyph outliner, the blend
  modes and `std14data.ts`'s bundled outlines — to produce a picture.
  `raster.ts` re-exports it so `redact.ts` and the tests keep their import path.
  **Note:** that shared decoder is also what closed `2pgr`, where `ToSvg` and
  the four document exports rendered every masked image opaque while `ToImage`
  masked it correctly — two decoders disagreeing about one document. An
  UNMASKED image still takes `imagehref.ts`'s own path (a DCT passes straight
  through as JPEG bytes), which is what keeps every export byte-identical;
  measured, and `test/html-identity.test.ts` is the ONLY downstream fence that
  catches a regression there. After the page content, `interpret` composites each
  visible annotation's `/AP /N` appearance through the same Form-XObject path, so
  both backends get it (`{ annotations: false }` opts out); the rules come from
  **annotappearance.ts** (read-only `/AP` resolution — the visibility predicate
  and the `/N`+`/AS`+`/Rect`/`/BBox`/`/Matrix` placement, shared with flatten.ts).
  **strokegeom.ts** holds the backend-neutral stroke geometry both renderers
  need — Bézier flattening, dashing, and outlining a stroke (joins, caps) into
  device-space polygons that share a winding sign, so nonzero fill unions them.
  **glyphoutline.ts** flattens glyph outlines (`glyf` and CFF alike) to
  polylines for *both* directions — raster.ts fills them to paint text, and the
  SVG authoring stack warps them along a `<textPath method="stretch">`. It is
  deliberately outside raster.ts so the authoring side needs no dependency on
  the rasterizer and one flattener serves both.
  **blend.ts** — the separable and non-separable blend functions (PDF 32000-1
  §11.3.5) as pure 0..1 arithmetic (no PDF/canvas knowledge), applied by the
  raster compositor.
  **Invariant:** an isolated transparency group whose *contents* use a blend mode
  needs an offscreen buffer even at alpha 1. The buffering predicate reads the
  graphics state at `Do` time, which cannot see an inner blend; miss this and the
  group draws inline and blends against the page backdrop — silently producing
  the non-isolated result for a group declared `/I true`.
  **Invariant:** `/Group /I` selects how a transparency group composites, never
  whether it is buffered. `/I` defaults to *false*, so gating buffering on
  `/I true` silently drew the ordinary `/Group` form inline and double-composited
  its overlaps. Buffer whenever the group composites as a unit — group alpha, a
  blend mode, or a soft mask — and let `/I` choose the path. Seeding the backdrop
  is needed only when the contents also blend: with Normal inner compositing,
  seed-then-remove provably recovers the isolated result.
  **Invariant:** a stroke-shaped clip must be emitted as *fill* geometry. SVG
  1.1 §14.3.5 excludes the `stroke` property from clipping paths, so clipping to
  a stroked zero-area line yields an empty clip and the paint silently vanishes
  in real engines while `ToImage` still looks correct.
  **Invariant:** a painted leaf that carries a `clip-path` must have the identity
  user space — bake the CTM into its `d` (device coordinates), never a
  `transform` attribute. `clip-path` resolves in the *referencing* element's user
  space, so a `transform=CTM` on the leaf re-applies that CTM to the already
  device-space clip geometry and mirrors/scales the clip. This silently mirrored
  every clip vertically (the page flip applied twice) while `ToImage` stayed
  correct, invisible until a non-flip-symmetric clip fixture existed. Fills,
  strokes and the shading covering rect bake to device space; images and glyph
  runs cannot, so they keep their transform and take the clip on an identity
  `<g>` wrapper instead (which isolates — a narrow blend residue, see the SVG
  goldens' PROVENANCE).
  **Invariant:** a type 4 (PostScript calculator) function is interpreted by
  **psfunc.ts**, which touches no PDF objects — bytes in, numbers out. That is
  what lets all 42 operators be tested against hand-written programs without
  building a file, and `pdffunction.ts` keeps `/Domain`, `/Range` and the type
  dispatch as it does for types 0, 2 and 3.
  **Invariant:** type 4 is the fourth non-object grammar over `lexer.ts`, with
  content streams, `cmap.ts` and `da.ts` — `{` and `}` are delimiters no PDF
  production claims, so they already arrive as one-character keywords. It is
  bound by the same rule as the other three: an unrecognised token is skipped,
  not rejected. Only `object-parser.ts` may treat a stray keyword as an error.
  **Invariant:** three type 4 semantics return plausible wrong numbers rather
  than failing, so each is asserted directly rather than trusted. Integers are a
  distinct type — `1 2 idiv` is 0 where `div` is 0.5; `and`/`or`/`xor`/`not` are
  overloaded on operand type, boolean on booleans and bitwise on integers; and
  trigonometry is in **degrees**, with `atan` returning 0..360 rather than a
  signed radian. Each of the three produces a smooth, entirely plausible,
  entirely wrong ramp.
  **Invariant:** the constant `/Range` midpoint in `pdffunction.ts` answers only
  for genuinely unsupported function types and for a type 4 program that will
  not parse. It used to answer for *every* type 4 function, which is how a
  PostScript-driven shading came to paint one flat colour with no error raised
  anywhere. A test asserting only that the page is painted accepts that bug, so
  the two acceptance renders assert that the ends *differ* and were confirmed to
  fail with the midpoint restored.
  **Invariant:** the type 4 memo lives in the evaluator, not in `colorspace.ts`.
  A tint transform runs per pixel for an image in a Separation or DeviceN space,
  so an interpreted program would be re-run millions of times; the function is
  pure, so the cache is unobservable. Caching one level up would change
  behaviour for function types this work does not touch.
  **Invariant:** `renderPageGraphicsToPng` is `renderPageToPng` with
  `RasterSink.glyphRun` suppressed, for `htmlfixed.ts`'s `backdrop: 'raster'` —
  a separate export rather than an `ImageOptions` flag, as `renderFormToRgba`
  already is for `svgembed.ts`, so `page.ToImage` is untouched. `clipToGlyphs`
  is deliberately NOT suppressed: it clips other paint to glyph outlines, so
  dropping it would drop the graphics that clip reveals. The suppression lives
  in the sink because `interpret` composites annotation `/AP` streams — a
  `/FreeText`'s glyphs must be dropped here and emitted as spans by the caller,
  which a pre-pass over page content would miss.
  Backed by **pngencode.ts**, **pdffunction.ts**
  (shading-function evaluator) with **psfunc.ts** behind its type 4 branch,
  **colorspace.ts**, **jpeg.ts** (baseline +
  progressive DCT decode, extended by **jpegarith.ts** arithmetic,
  **jpeglossless.ts** lossless, and **jpeghier.ts** hierarchical JPEG modes),
  **jpx.ts** (`JPXDecode` / JPEG 2000, ISO 15444-1: JP2 box + codestream over the
  **jpxmq.ts** MQ arithmetic decoder, **jpxt1.ts** / **jpxt2.ts** EBCOT
  Tier-1/Tier-2, and **jpxwavelet.ts** inverse 5/3+9/7 DWT), **jbig2.ts**
  (`JBIG2Decode` / ITU-T T.88, embedded organization: segment parse + page
  assembly over **jbig2generic.ts** generic regions (arithmetic templates 0–3 and
  MMR via ccitt.ts), **jbig2symbol.ts** symbol dictionaries, **jbig2text.ts** text
  regions, **jbig2refine.ts** generic refinement regions (§6.3, templates 0/1 and
  TPGRON), **jbig2halftone.ts** pattern dictionaries and halftone regions (§6.7,
  §6.6, Annex C.5), **jbig2huffman.ts** the Huffman bit reader, the standard
  tables B.1-B.15 and custom table segment 53 (Annex B), **jbig2ints.ts** the
  `IntSource` seam between the two entropy stacks, and **jbig2arith.ts**
  integer decoding — reusing jpxmq.ts, since JBIG2's arithmetic coder is the
  same MQ coder as JPEG 2000's), and the
  bundled Standard-14 substitute faces (**std14data.ts**, **std14fonts.ts**).
  **Invariant:** a JBIG2 **intermediate** region segment (4, 20, 36, 40) is
  decoded and stored under its segment number for a later segment to consume,
  and is **invisible to the page** until something consumes it. Only the
  immediate forms (6/7, 22/23, 38/39, 42/43) composite. `jbig2.ts` drew types 36
  and 4 as well, which is wrong by T.88 §7.4 — and wrong in the direction that
  looks right, because in a file where the intermediate region is subsequently
  refined onto the same spot the page ends up with approximately the intended
  ink, so every fixture passed either way. The buffer is a refinement region's
  reference bitmap, which is why it is kept with its `RegionInfo` and not just
  its pixels. An orphan intermediate — one nothing consumes — contributes
  nothing, which is the conformant reading; `test/jbig2-assembly.test.ts`
  asserts that directly so it stays a decision rather than a surprise.
  **Invariant:** a refinement region (T.88 §6.3, **jbig2refine.ts**) whose
  referred-to set contains no intermediate region refines **the page itself** —
  the reference is the page's current pixels under the region rectangle, and the
  result **replaces** them. The external combination operator does not apply to
  that case; it does apply when a referred-to buffer supplied the reference.
  Combining instead of replacing is the failure that hides: refinement output
  OR-ed onto its own input is more ink in roughly the right places, which renders
  as a slightly bold page rather than as a fault, so the fixture's target CLEARS
  pixels the reference had set. Measured — dropping the replace turns the
  page-refinement case red and leaves the buffer case green, which is exactly the
  asymmetry the rule is about.
  **Invariant:** GRRD is arithmetic-only. T.88 defines no MMR refinement, which
  is why a Huffman text region has to alternate entropy coders within one stream
  rather than refining in its own coding.
  **Invariant:** `jbig2refine.ts` APPENDS its AT pixels to the coding and
  reference lists and never sorts them, unlike `jbig2generic.ts`'s
  `buildTemplate`, which sorts the whole set by `(y, x)`. Context bit order is
  invisible to a round trip, and not merely by oversight: a reordering is a
  *bijective relabelling* of context bins, so bin `g(S)` in the decoder sees
  exactly the bit sequence bin `f(S)` produced in the encoder, the MQ state
  machine is identical, and the output is byte-for-byte the same. Measured —
  sorting the AT pixels, and swapping the coding and reference halves outright,
  each leave BOTH round-trip vectors green. What pins the order is T.88's
  published SLTP constants (`0x0020`, `0x0008`), each of which is the context
  label for "every template pixel 0 except the reference pixel at `(0,0)`"; only
  a non-injective change — dropping a template pixel, which merges bins — reaches
  the round trip at all. This is the sharpest instance in the repo of the rule
  that a differential test cannot validate the parser it runs through.
  **Invariant:** TPGRON's typicality is a property of the REFERENCE, not of the
  row — unlike TPGDON in `jbig2generic.ts`, which copies the row above. Where LTP
  is set, a pixel whose 3×3 reference neighbourhood is uniform takes that value
  and consumes no arithmetic decision. Out-of-bounds reference pixels read as 0,
  which is what makes the edge of a uniformly-black reference *not* typical;
  treating them as matching sends the first and last row of every TPGRON region
  down the typical path and desynchronises the stream.
  **Note on the TPGRON fixture, both halves measured the hard way:** its
  reference must be a centred BLOCK, not a box outline — an outline's border
  pixel at x=0 sits beside interior 0 on every row, so no row is ever fully
  typical, LTP is never set, and the vector exercises nothing while still
  passing. And the generator asserts the LTP row count directly rather than
  comparing encoded sizes: the TPGRON stream here is 8 bytes against 6 plain,
  *bigger*, because for an image this small the MQ coder already spends almost
  nothing on a blank row and the 16 SLTP decisions cost more than the typical
  path saves. Note also that seeding `typicalPixel`'s comparison from the centre
  rather than the corner is NOT a mutation — the seed cell is itself one of the
  nine compared, so any seed within the neighbourhood is equivalent.
  **Invariant:** the two GRRD offset rules are DIFFERENT and both are plausible.
  A text region (§6.4.11.1) offsets by `(RDW >> 1) + RDX, (RDH >> 1) + RDY` — the
  half-delta re-centres the grown bitmap on the original — while a symbol
  dictionary with `REFAGGNINST == 1` (§6.5.8.2.2) offsets by RDX/RDY **plain**,
  because there the refined symbol's size comes from the height class rather than
  from a decoded delta. Using one rule in both places is a small uniform
  misplacement that reads as bad rendering rather than as a decode fault, so the
  two are fenced independently: mutating the dictionary rule reddens only its own
  case and leaves both text-region cases green.
  **Invariant:** `>>` floors toward negative infinity, as T.88 requires;
  `(RDW / 2) | 0` truncates toward zero. They agree for every NON-NEGATIVE delta,
  so a growing refinement cannot tell them apart — measured, a truncating build
  passes the growing vector. `refine_text_shrink` (RDW = RDH = -1) exists solely
  for this, and the generator refuses to write it if the two happen to agree on
  its delta.
  **Invariant:** an aggregate text region's `symCodeLen` is the DICTIONARY's
  declared total (`SDNUMINSYMS + SDNUMNEWSYMS`, §6.5.8.2.3), never the number of
  symbols decoded so far. `decodeTextRegion` derives it from `symbols.length` for
  a standalone region, which is why `TextRegionParams.symCodeLen` exists as an
  override — without it every symbol ID inside an aggregate is read at the wrong
  width once the dictionary crosses a power of two. The `refagg_many` fixture's
  counts are chosen to straddle that boundary (declared 3 → 2 bits, decoded so
  far 2 → 1 bit); with any other counts the override is unfalsifiable.
  **Invariant:** `TextIntCtx` bundles the eleven integer contexts a text region
  uses, because a symbol dictionary's aggregate region shares every one of them
  with its enclosing decode (§6.5.8.2.1). `jbig2symbol.ts` therefore imports
  `jbig2text.ts`; that edge closes no cycle, since `jbig2text.ts` reaches only
  `jbig2.js`, `jbig2arith.js` and `jbig2refine.js`.
  **Note, recorded as unanchored:** none of the four rules above has a published
  constant to check against the way §6.3's SLTP constants pin the refinement
  context order, and our encoder shares our reading of all of them. Each is
  implemented to the letter of T.88 and fenced by a fixture chosen to straddle
  the boundary it turns on; do not read the green suite as independent
  confirmation. What the REFAGG vectors *do* give is a cross-check between two
  separately written implementations — `scripts/jbig2-codec.mjs`'s encoder and
  `src/`'s decoder — against a KNOWN target bitmap, rather than one file agreeing
  with itself: there is deliberately no reference `decodeSymbolDictRefagg`.
  **Invariant:** a halftone region decodes a GRAYSCALE image, not a bitmap
  (T.88 §6.6, Annex C.5): `ceil(log2(HNUMPATS))` bitplanes, each an ordinary
  generic region of HGW × HGH, all sharing one arithmetic decoder and one
  context set, MSB plane first, then Gray-folded downward. The fold is applied
  after every plane is decoded rather than interleaved as C.5 writes it — which
  is exactly equivalent, since plane J is folded against the already-folded
  plane J+1 and folding J changes nothing plane J's own decode reads — and that
  is what makes `grayscaleValues` a pure function with a hand-computable
  expectation. The Gray sequence 00 01 11 10 naming 0 1 2 3 is published, so
  unlike everything above it this is anchored OUTSIDE our own encoder.
  **Invariant:** the grid vectors' CROSS TERMS are load-bearing. A cell sits at
  `x = HGX + mg·HRY + ng·HRX`, `y = HGY + mg·HRX − ng·HRY`, both `>> 8` since
  they are 8.8 fixed point. Transposing the pair renders the screen rotated,
  which reads as an unusual halftone rather than as a decode fault, so
  `cellOrigin` is pinned by arithmetic over known inputs with one vector zeroed
  at a time — which no single grid could do. `>>` floors toward negative
  infinity where `| 0` truncates, and HGX/HGY are SIGNED, so only a grid
  starting off the left or top edge distinguishes them. Note the round-trip
  fixture deliberately uses an exactly-tiling grid (HRX = 256·HDPW, HRY = 0) so
  that its expectation is a plain tiling rather than a second copy of the
  formula — it cannot see any of this, and its test says so.
  **Invariant:** HENABLESKIP sets a pixel to 0 WITHOUT decoding it — it consumes
  no arithmetic decision, so the test sits before the context is assembled in
  `decodeGeneric`'s inner loop. As a post-filter over a finished plane it
  desynchronises the bitstream from the first skipped pixel onward, so the whole
  plane is wrong, and only for streams that set the flag. Measured: moving it
  out of the loop reddens the skip vector and leaves the plain one green, which
  is the asymmetry the rule is about. The skip fixture is also the sharpest
  cross-check in this feature — encoder and decoder each derive HSKIP from T.88
  and the stream desynchronises outright if they disagree about one cell.
  **Invariant:** a pattern dictionary is ONE collective bitmap `(GRAYMAX+1)·HDPW`
  wide with AT1 pinned at `(-HDPW, 0)` — the same column of the previous
  pattern — sliced into patterns afterwards. The AT set is a published constant,
  so its test is a transcription check and NOT an independent decode: our own
  encoder reads the same line of T.88. The LENGTH of that set is part of the
  answer, since `buildTemplate` appends every entry it is given and templates
  1–3 take one adaptive pixel where template 0 takes four (§6.2.5.3) — four on a
  template-1 decode widens the context from 13 bits to 15. It is also the one
  place in JBIG2 where a PRODUCT of three header fields sizes an allocation,
  which is why it carries an explicit pixel bound where a single u32 region
  dimension is left to fail as it does everywhere else.
  **Invariant:** under HMMR the bitplanes are ONE datastream with an EOFB
  between them, which is what `ccitt.ts`'s `decodeCcittConsumed` exists for —
  the only change this epic makes outside `src/jbig2*.ts`. `decodeCcitt` is a
  wrapper over it so the two cannot drift, and `decodeMmrBitmap` is
  `decodeGeneric`'s mmr branch with the count kept, so there is one reading of
  how MMR bits become a `Bitmap`. Note the next plane is taken to begin at the
  next BYTE: T.88 says only that the decoder must skip the EOFB, and no
  real-world fixture is available to settle the alignment, so that is recorded
  in the source as an assumption rather than as a fact.
  **Invariant:** the Huffman work (`jbig2huffman.ts`) is a TRANSCRIPTION problem
  rather than a reading-of-T.88 problem — fifteen tables of numbers and one
  textbook canonical assignment — so it carries three checks, and none subsumes
  another. The ANCHOR is that Annex B prints the assigned prefix CODES and not
  merely their lengths: the two are transcribed as separate columns and the
  printed codes asserted against B.3's assignment. Kraft equality (every
  standard table is a COMPLETE prefix code) and range contiguity (sorted by
  `rangeLow`, the normal lines tile the integers with no gap or overlap) cover
  the columns the codes cannot see. Measured, by mutating the DATA: a wrong
  `prefixLen` reddens the anchor and Kraft; a wrong `rangeLow` reddens
  contiguity and leaves the anchor GREEN; reordering two same-length lines
  reddens the anchor alone, which is what pins "assigned in TABLE order".
  B.14 is the only bounded standard table — five lines over −2..2 with neither
  a lower nor an upper range line — and is asserted directly, since a sweep
  cannot say which tables were meant to be open-ended.
  **Invariant:** a line with `prefixLen === 0` is unused and takes NO code. No
  standard table has one; a custom table routinely does, because §B.2.3 writes
  a length for every range whether the encoder used it or not — and counting
  them shifts every later code by one, which decodes a DIFFERENT line rather
  than failing.
  **Invariant:** a LOWER-range line subtracts. It is spelled exactly like an
  upper-range line but for the sign, so adding instead yields a large positive
  value where a large negative one was meant — a text-region symbol far off the
  page rather than an error. The two are tested side by side for that reason.
  **Invariant:** HTPS and HTRS are stored one LESS than their value (§B.2.3), a
  three-bit field being unable to hold 8. Read raw, every prefix length is one
  bit short and the table decodes plausible nonsense.
  **Invariant:** `HuffmanReader.bits` accumulates by multiplication, never
  `(v << 1) | b`, which wraps negative at bit 32 — and a range line reads
  exactly 32 bits. Its `align()` is a no-op when already aligned: skipping a
  byte there would lose the first byte of a collective bitmap.
  **Invariant:** there is ONE height-class walk and ONE strip walk, with the
  entropy source injected through `IntSource` (`jbig2ints.ts`). A second copy of
  either — which is how Go arranges it, in `jbig2_huffsym.go` and
  `jbig2_hufftext.go` — is how the two paths come to disagree about one
  document. `IntSource.align()` is a NO-OP on the arithmetic path, present so
  the shared walks never branch on which source they hold; the MQ decoder is not
  bit-addressed and skipping a byte there would desynchronise it.
  **Invariant:** the seam STOPS at bitmap production, and `SymbolProducer` is
  where it stops. The arithmetic path and the Huffman REFAGG path make one
  bitmap per SYMBOL as each width is decoded; a Huffman dictionary with
  SDREFAGG clear makes one per HEIGHT CLASS (§6.5.9) — widths for the whole
  class, then BMSIZE, then an align, then one bitmap sliced by those widths. A
  discriminated union rather than two optional methods, so the walk branches
  exactly once.
  **Invariant:** a collective bitmap advances the reader by BMSIZE, NOT by what
  MMR reported consuming. The two agree on everything our own encoder produces,
  so the fixture that fences this pads its MMR data deliberately — measured,
  without the padding a build that advances by MMR's own count passes.
  BMSIZE 0 means stored uncompressed with each ROW padded to a byte, which is
  the one shape needing no encoder at all and so the first fixture to build.
  **Invariant:** two of a Huffman dictionary's fields have NO selector and are
  easy to give one by mistake: the export run is always Table B.1 (§6.5.10) and
  the refinement deltas always Table B.15 (§6.5.8.2.2). The selector-to-table
  map is a transcription like the tables themselves, so it is asserted directly
  — measured, an end-to-end decode that only checks "does not throw" leaves a
  wrong export table entirely green.
  **Note, decided in `utax.2` and recorded as unanchored:** a symbol
  dictionary's aggregate text region shares the DICTIONARY's `IAID`/`IARDX`/
  `IARDY` rather than keeping its own, which is T.88 §6.5.8.2.1's reading and
  the natural shape under `IntSource`. `utax.5` had them separate. Only a
  dictionary MIXING the `REFAGGNINST == 1` and `> 1` paths can observe the
  difference — in `refagg_one` and `refagg_many` the other path never runs, so
  the contexts it would have touched stay in their initial state and both
  readings decode them identically, which is why the change moved no vector.
  `refagg_mixed` exists for it and pins that our encoder and decoder agree; it
  does NOT pin that the sharing matches T.88, since both halves are written from
  the same reading.
  **Invariant:** three reads differ under SBHUFF and the strip walk is otherwise
  the SAME one. CURT is `LOG2SBSTRIPS` RAW BITS (§6.4.5 3(c)(ii)) and RI is ONE
  raw bit (3(c)(iv)) — neither has a selector in the flag word, whose eight are
  FS, DS, DT, RDW, RDH, RDX, RDY and RSIZE — so `HuffmanTables` has no `it` and
  no `ri` field at all and the mistake is unrepresentable rather than merely
  untaken. The third is refinement, which alternates entropy coders within one
  stream (§6.4.11): RSIZE, align, an `MqDecoder` over exactly those bytes,
  Huffman reading resuming after them by the FILE's count. That one is a
  `RefinementProducer`, and `huffmanRefinement` is shared with the symbol
  dictionary's aggregate so the two cannot disagree about where reading resumes.
  **Invariant:** the symbol-ID code table (§7.4.3.1.7) runs for EVERY Huffman
  text region — 35 four-bit runcode lengths, a runcode table, one length per
  symbol through it, then an align. Its three repeat codes differ only in what
  they repeat and by how much: **32 repeats the PREVIOUS symbol's length** while
  33 and 34 repeat ZERO, and 34's count starts at 11 over seven bits where 33's
  starts at 3 over three. Confusing them shifts every later symbol ID by a code,
  so each gets a fixture asserting the resulting length array; measured, making
  33 repeat the previous length reddens the 33 case alone.
  **Invariant:** a text region's `SBHUFFFS` and its four refinement selectors
  have TWO standard choices, so value 2 is reserved — while `SBHUFFDS` and
  `SBHUFFDT` have THREE and 2 is a real table there. Getting the asymmetry wrong
  refuses valid files or accepts invalid ones, so it is asserted directly.
  **Note, tracked as `qfgw`:** a Huffman dictionary's aggregate
  (`REFAGGNINST > 1`) reads INLINE from the dictionary's bit stream with no
  BMSIZE wrapper, unlike the `== 1` path. The reading is that the wrapper exists
  because GRRD is arithmetic-only and needs a byte range; an aggregate reading
  Huffman bits does not, and its own refinements carry their RSIZE wrappers.
  Unverified — our encoder shares the reading, so no fixture can settle it.
- **docmodel.ts** — the neutral document model behind every document exporter.
  `buildDocModel(doc, pages)` reconstructs pages as a `DocNode[]` tree from the
  tagged structure tree when the document has one, and from geometry plus
  `textrank.ts` font-size ranking when it does not. `htmlsemantic.ts` and
  `mdexport.ts` are serializers over it; DOCX and EPUB export are meant to be
  the third and fourth.
  **Invariant:** the tree speaks PDF standard structure types (`'H1'`, `'P'`,
  `'Span'`), never HTML tags. That is what keeps the serializers unprivileged
  and what makes the untagged builder's output indistinguishable in shape from
  the tagged one.
  **Invariant:** `DocText.bold`/`.italic`/`.script` are read by ALL THREE
  serializers as of c3t7.8 — `docxflow.ts` as `w:b`/`w:i`/`w:vertAlign`,
  `htmlsemantic.ts` as `<b>`/`<i>`/`<sub>`/`<sup>`, and `mdexport.ts` as
  `*`/`**`/`***` plus raw `<sub>`/`<sup>`. All are still optional and absent
  rather than false. The old "read by docxflow.ts alone" rule, and the
  byte-identity it bought for the other two, is deliberately retired.
  `DocFigure.sizes` IS still DOCX-only and still absent-rather-than-zero — do
  not read this change as covering it. Emphasis remains DERIVED from
  the producing font (`fontStyleOf`), never declared: a PDF records a face, not
  an emphasis — which is why HTML gets `<b>`/`<i>` rather than
  `<strong>`/`<em>`, whose semantics assert an importance the document never
  stated.
  **Invariant:** the two rules the exports need live in `styledChildren`, and
  the BUILDER never calls it. Adjacent text siblings sharing a style are merged
  — required, not tidy: `struct.ts` splits a run per MCID, so two adjacent bold
  runs are the normal case and emitting them separately gives Markdown
  `**a****b**`, a four-asterisk delimiter run that does not reparse as two
  strong spans. A heading's UNIFORM bold is dropped throughout its subtree,
  because both formats already render headings bold and `mdstyle.ts` defaults
  them to Helvetica-Bold, so our own `# Title` would otherwise round-trip as
  `# **Title**`. Narrow on purpose: headings only, bold only, uniform only.
  **Invariant:** neither rule may move into `buildDocModel`.
  `test/docx-flow-identity.test.ts` pins the sha256 of DOCX flow output and
  `docxflow.ts` emits one `w:r` per `DocText`, so merging runs there moves the
  hash. That test is now the fence that matters for this area.
  **Invariant:** both emitters HOIST surrounding whitespace outside the markup,
  as `mdexport.ts`'s link case and `htmlsemantic.ts`'s anchor already do. Forced
  in Markdown — a closing `**` preceded by whitespace is not a closer, so
  `** bold **` renders its asterisks literally — and adopted in HTML, which has
  no flanking rules, only so the two agree: a run owns the separator space that
  follows it, so without it a bold word is `<b>bold </b>` against `**bold**`.
  **Note, measured rather than assumed:** the merge is pinned end to end ONLY by
  a fixture with two MCIDs on one element (`twoBoldMcids` in
  `test/export-emphasis.test.ts`). `struct.ts` already merges runs whose derived
  style matches, so a document our own writer produces never has two adjacent —
  even `**a** **b**` arrives as the single run `a b`, and an export assertion
  built on one passes with `mergeAdjacentText` stubbed to `return nodes`.
  **Note, measured:** `test/html-identity.test.ts`,
  `test/markdown-export.test.ts` and `test/docx-flow-identity.test.ts` did NOT
  move when emphasis shipped — no fixture in the html-identity set uses a bold,
  italic or oblique face, and no `via()` case uses a heading. They remain
  fences; a future move there is information, not a chore. The one test that did
  move is `test/docmodel-style.test.ts`, which asserted the retired property
  directly and now asserts its replacement.
  **Invariant:** `script` reaches the DOCX export on BOTH paths, and by two
  different routes. `docText` has two style sources — `LineSegment` (untagged,
  from `TextLine.styles`) and `StructTextNode` (tagged, from `struct.ts`'s
  `styledRuns`) — and the tagged one cannot derive script the way it derives
  emphasis: `styledRuns` sees ONE MCID, while `markScriptLevel` measures a run
  against its line. A tagged `/Span` around a footnote marker contains nothing
  but the marker, so its own size is the dominant one and a per-MCID rule marks
  nothing. `scriptByGlyph` classifies per PAGE instead and `styledRuns` looks
  the answer up — see the `struct.ts` invariants above. `docText` itself needed
  no change at all: it already spread `style.script` from whatever bag it was
  handed.
  **Invariant:** `w:vertAlign` is appended, and that is correct only because
  CT_RPr orders it AFTER `w:szCs` — the last of the properties `runXml` writes.
  Contrast `w:framePr`, which CT_PPr orders FIRST and which is therefore
  inserted. Both are asserted, since wrong order is a file Word refuses.
  That is what makes the extension invisible to the other two serializers —
  `test/html-identity.test.ts` and the Markdown snapshots staying green IS the
  evidence, and they are the fence to run before touching any of it. Emphasis is
  DERIVED from the producing font (`fontStyleOf`), never declared: a PDF records
  a face, not an emphasis.
  **Invariant:** a figure's size is the DRAWN box, from `ImageEvent.quad`, not
  the image's pixel count — a producer that placed a 2400px scan two inches wide
  said what it meant. `sizes` is parallel to `images` and never sparse: an
  unknown entry is `{ width: 0, height: 0 }`, because omitting it would shift
  every later index and mis-size the rest of a composite figure. The untagged
  path needs its own content walk keyed by stream object, since `page.Images` is
  `/Resources` order and carries no geometry at all.
  **Invariant:** page filtering and empty-node pruning live in the builder, not
  in a serializer. Two serializers deciding independently whether a node is
  empty is how two exports come to disagree about a document. Note a
  page-filtered tree does NOT exercise the prune — `onPage` rejects the other
  page's elements before the empty check is consulted, so removing the check
  leaves that case green. An element authored with no content at all is what
  pins it.
  **Invariant:** `DocFigure.tagged` records provenance because the two paths
  legitimately differ when an image will not encode: a tagged `/Figure` still
  emits its `/Alt`, since that is the accessible content, while an untagged
  bare page image emits nothing, having no alt to announce. Erasing the flag
  changes untagged output silently — every fixture's image encodes, so the
  byte-identity snapshot cannot see it.
  **Note, measured rather than assumed:** `AutoTag` ranks headings per *block*
  while this module ranks per *line*, so a heading clustered into one
  `TextBlock` with the paragraph beneath it survives the untagged path as `H1`
  and is flattened to a single `P` by `AutoTag`. The two exports therefore
  disagree on such a document, in HTML as well as Markdown. That is `AutoTag`'s
  granularity, not a defect here — do not "fix" it in `docmodel.ts`.
  **Invariant:** a link's destination rides on `DocContainer.href`, not a node
  kind of its own — `/Link` IS a standard structure type, the same reason
  `/BlockQuote` earned no kind, and a destination is an attribute exactly as
  `lang` is. Only a URI action sets it: a `GoTo`, whether spelled as an action
  or a bare `/Dest`, names a page object inside the file and has no address to
  become once the PDF is gone. The element's text is emitted either way, so an
  internal link degrades to the words it was on. An `<a>` with no `href` is
  markup that looks like a link and does nothing, so `htmlsemantic.ts` emits the
  text instead — which is also the bug that shipped from `no93.1` until
  `no93.4`, since `TAG_FOR` mapped `Link` to `a` with nothing to put in it.
  **Invariant:** on the untagged path a `/Link` annotation is resolved to the
  text it covers through `mapRegions`, never by interpolating within a fragment.
  Colour is not part of a fragment's identity, so a linked phrase inside a
  sentence is normally NOT its own fragment — a whole line commonly is one — and
  fragment granularity would find nothing to match. `splitLineLinks` then only
  ever SLICES `line.text`; rebuilding it from fragments would lose the
  synthesized inter-fragment spaces and move every existing untagged snapshot.
  A phrase occurring twice on one line is left unlinked rather than guessed at.
  **Invariant:** `DocList`/`DocListItem`/`DocCode` are the only kinds that are
  not structure types, and they exist because the model must carry a decision no
  type records: whether a list is numbered, where it starts, and whether an item
  is checked. `/BlockQuote` gets no kind — it is already a standard type.
  **Invariant:** a marker is *evidence*, never content. `/Lbl` is read for what
  it proves and then dropped, in the builder, and each serializer re-derives its
  own marker from `ordered`/`start`/`checked`. Keeping the label as content is
  how an export comes to read `• • item` — which is exactly what the pre-`no93.2`
  flattening produced. The one exception is a task's state, which HTML emits as a
  disabled checkbox because it is content rather than decoration.
  **Invariant:** U+00A0 maps back to U+0020 in `DocCode.text`, and only there.
  The substitution is `preformat`'s, made because `layoutRuns` collapses runs of
  spaces and a code block's indentation would not otherwise survive being drawn;
  undoing it is what makes the indentation survive being read back. Confined to
  code, where the character is provably a substitution rather than an author's
  choice.
- **docinfer.ts** — the untagged document-shape heuristics `docmodel.ts`'s
  geometry path is meant to run on: the list-marker grammar, monospaced-line
  detection, page metrics, per-block line classification (item / continuation /
  code / heading / text) and the three body-size heading signals. Pure by
  design — positioned lines in, classifications out — which is the split
  `floatstack.ts` and `booklet.ts` already make against the modules that draw.
  **Invariant:** nothing here may import `document.js`, `page.js` or any PDF
  object module. That is the whole reason it exists: every bullet character,
  nesting tolerance and heading rule is testable without building a PDF, and
  `test/docinfer.test.ts` drives all of it from hand-built `TextLine`s.
  **Invariant:** the marker grammar has ONE owner, `parseMarkerText`. The tagged
  path parses a `/Lbl`'s text with it and the untagged path parses a line's
  opening with it; two grammars is how an export comes to read `(3)` as a list
  in one document and as prose in the other.
  **Invariant:** a marked line forms an item only with corroboration — an
  adjacent marked line, or a following line indented to its body x. Without it
  `1990. It was a good year` is a list. A genuinely single-item list is therefore
  missed: precision bought at the cost of recall, deliberately.
  **Invariant:** the three heading signals (bold, all-caps, short-and-isolated)
  share ONE corroboration — short, a gap above, and body text below at the same
  left edge — and apply only at body size, since a size-derived rank always
  wins.
  **Note, measured rather than assumed:** the follower clause IS load-bearing,
  but it is pinned by `test/docinfer.test.ts` alone. The `no93.2` design claimed
  `test/html-identity.test.ts`'s ruled-card snapshot fenced it; that is **wrong**
  and was measured so in `no93.6`. On that page every non-table block is filtered
  out before the metrics are taken, so `Card heading` is the only line left and
  is therefore *also* the widest — the **width** gate rejects it independently.
  Removing either clause alone leaves the snapshot green; `Card heading` only
  promotes to `H1` when BOTH are removed. Two redundant defences, so breaking
  either one alone proves nothing — the same trap the `scanDelimiterRow`
  note records above. Do not cite that snapshot as covering either gate.
  **Invariant:** our own renderer's BULLET lists are not recoverable from an
  untagged page, and `test/docmodel.test.ts` asserts that rather than leaving it
  to be discovered. `flow.ts` draws a bullet and a task box as vector geometry
  (WinAnsi has no ballot-box glyph), so the page carries no marker text at all.
  An ordinal marker is ordinary text and *is* recovered — which is why the
  untagged fixtures here are hand-built content streams with the marker as text
  at the left edge (`test/helpers/build-untagged-list-pdf.ts`), the shape a
  third-party producer emits. Building them with `AddMarkdown` measures our
  renderer, not the inference.
- **zip.ts**, **ooxml.ts**, **docxpackage.ts**, **crc32.ts** — the OOXML package
  writer behind DOCX export (`8yt9`). Three layers, each ignorant of the one
  above: `zip.ts` turns entries into archive bytes over `node:zlib`'s
  `deflateRawSync` and knows nothing of OOXML; `ooxml.ts` owns
  `[Content_Types].xml` and the `.rels` graph and knows nothing of
  WordprocessingML; `docxpackage.ts` assembles the minimal `.docx` with the body
  as the seam `8yt9.2` fills. `crc32.ts` is the shared checksum, extracted from
  `pngencode.ts`, which computed the same polynomial privately.
  **Invariant:** the compression method is per ENTRY, not per archive. EPUB
  (`zwto.1`) requires its `mimetype` entry stored uncompressed, so an
  archive-wide setting would force a second container writer for a format that
  is also a ZIP.
  **Invariant:** timestamps are the fixed constant 1980-01-01, never the clock.
  Two runs over one input must give identical bytes or nothing downstream can be
  snapshot-tested — the same reason `Save()` preserves the document `/ID`.
  **Note, measured:** a reproducibility test alone does NOT pin this. Two writes
  a millisecond apart agree even when the field comes from the clock, so it
  catches one only if the run straddles a second boundary; the stored value is
  asserted directly for that reason. A mutation using `getSeconds()` passed.
  **Invariant:** overflow THROWS rather than wrapping. Past 4 GB or 65535
  entries ZIP's 32-bit fields silently produce an archive that looks well-formed
  and is not; ZIP64 is the feature that would lift the bound and is absent.
  **Invariant:** the local header and the central directory entry are built from
  ONE shared field list, so the two cannot describe the same file differently —
  a disagreement some readers tolerate and others reject.
  **Invariant:** `[Content_Types].xml` is generated from the part list, and
  `.rels` is covered by its extension default rather than an override — listing
  one as an override is a conformance error a lenient reader hides.
  **Invariant:** a relationship target resolves relative to its SOURCE part's
  directory, not the package root. Getting it wrong yields a package whose parts
  all exist and whose links all dangle, so every symptom points at the target
  while the fault is in the base.
  **Invariant:** a source with no relationships gets no `.rels` part. One
  containing nothing is legal and says nothing, and emitting it would need a
  format-specific special case inside the format-neutral layer — which is why
  the minimal `.docx` has three parts and not the four the design first listed.
  **Note:** `test/helpers/unzip.ts` is written against APPNOTE rather than
  against `zip.ts`, because a writer validated by its own reader proves only
  that the two agree. The CRC is additionally checked against published vectors
  and the payload against `node:zlib`'s `inflateRawSync` — two anchors outside
  our own code.
  **Note:** no CI here can open Word. The tests prove structural conformance to
  ECMA-376 and nothing about a particular consumer — do not read them as a
  compatibility claim.
- **docxflow.ts**, **docxtable.ts**, **docxstyles.ts**, **docxexport.ts** — DOCX
  flow mode (`Document.ToDocx`, `Page.ToDocx`), the third serializer over
  `docmodel.ts` after `htmlsemantic.ts` and `mdexport.ts`. Three are pure —
  `docxflow.ts` maps `DocNode[]` to the inner XML of `<w:body>` through injected
  image and hyperlink sinks, `docxtable.ts` maps a `Table` to `w:tbl`,
  `docxstyles.ts` generates `styles.xml` and `numbering.xml` — and
  `docxexport.ts` is the only one that touches a `Document`, the same split
  `svgdraw.ts`/`svgembed.ts` make.
  **Invariant:** every `w:t` carries `xml:space="preserve"`. A `/Link` draws
  `(the docs )` inside its own marked content, and without the attribute Word
  collapses that trailing space — rejoining the words either side into
  `Seethe docshere.`, the exact defect `spacedText` exists to prevent,
  reintroduced one layer down.
  **Invariant:** text is stripped of the characters XML 1.0 forbids *before* it
  is escaped. `escapeXml` handles `& < > "` and nothing else, and extracted PDF
  text can carry a NUL or a C0 control. One such byte does not corrupt a
  paragraph — it makes `document.xml` unparseable, so Word rejects the entire
  file with no indication of where the fault is.
  **Invariant:** the style ids live in `docxstyles.ts` and the mapper cannot
  name one that module does not define. A `w:pStyle` pointing at an undefined
  style is not an error any reader reports — Word falls back to body text, so a
  document of headings arrives looking like one long paragraph and nothing
  anywhere says why.
  **Invariant:** `docxtable.ts` takes its paragraph builder as an ARGUMENT.
  `docxflow.ts` calls it, so importing back would close a cycle — and a second
  paragraph emitter is how a cell comes to lose the `xml:space` attribute or the
  control-character strip the rest of the document has. The two unit constants
  (`EMU_PER_PT`, `TWIPS_PER_PT`) live in `docxstyles.ts` for the same reason: it
  imports neither.
  **Invariant:** `w:tcPr`'s children are schema-ORDERED, not free: `tcW`,
  `gridSpan`, `vMerge`, `tcBorders`, `shd`. Wrong order is a file Word refuses
  outright, so a new property is INSERTED at its place, never appended.
  **Invariant:** a table with any recovered cell OMITS the table-level
  `w:tblBorders` and states all four edges on every cell. Keeping both leaves
  two sources for one edge with Word's specificity rules deciding between them,
  which makes "why is this border here" unanswerable. An unrecovered table
  emits the uniform frame exactly as it did before recovery existed.
  **Invariant:** `w:sz` is in EIGHTHS of a point, clamped to Word's 2..96.
  **Invariant:** every `w:tc` contains at least one `w:p`, and an empty `w:p`
  follows every `w:tbl`. An empty cell is invalid WordprocessingML and Word
  refuses the document; two `w:tbl` elements with nothing between them merge
  into one table, and a body ending in a table has no paragraph mark for the
  section properties to attach to.
  **Invariant:** `wp:docPr@id` is unique across the document and non-zero. Word
  tolerates a duplicate in some builds and reports the file as corrupt in
  others, which makes it look like a defect that depends on the reader.
  **Invariant:** `w:startOverride` goes on the `w:num`, never on the abstract
  definition, which is shared by every list of its kind — an override there
  renumbers all of them. And one `w:numId` per list, or two sibling lists
  continue each other's numbering.
  **Invariant:** the mapper REPORTS the lists it emitted rather than a flag
  saying that it did. `numbering.xml` needs one `w:num` per list carrying that
  list's kind and start, and the mapper is the only thing that knows how many
  ids it allocated and what each meant.
  **Invariant:** image identity is the hash of the ENCODED BYTES, not the
  `PdfStream` object — `mdexport.ts`'s rule, reused rather than re-derived — and
  media parts are `store`d, never deflated, since `encodeImage` returns JPEG or
  PNG. The body closes with a `w:sectPr` stating the real page size: Word's
  default is US Letter, so an A4 document would otherwise reflow on open, a
  change made by saying nothing.
  **Invariant:** bullets are real characters (U+2022/U+25E6/U+25AA), not Word's
  conventional U+F0B7 in Symbol. That codepoint is private use and means a
  bullet only in a font present on Windows and frequently not elsewhere.
  **Note:** there is deliberately no `ToDocxAssets`. A `.docx` contains its
  images, so there is nothing for a caller to hand back; the Markdown split
  exists only because a string has nowhere to put image bytes. `DocxOptions`
  itself arrived with `8yt9.4` — the original "no option bag by design" held
  because a `.docx` also takes its page size from the document, leaving nothing
  to decide, and a second layout mode is exactly such a decision.
- **docxgroup.ts**, **docxtextbox.ts** — DOCX **textbox mode**
  (`ToDocx({ mode: 'textbox' })`), the positional counterpart to flow mode and
  the DOCX analogue of `htmlfixed.ts`. Both pure: `docxgroup.ts` is the adaptive
  merge (glyph events → positioned `TextGroup`s) and `docxtextbox.ts` maps those
  plus image placements to the `w:body` inner XML. `docxexport.ts` branches once
  between the two body producers and is still the only module here that reads a
  `Document`. Note the source: textbox mode does NOT go through `docmodel.ts`,
  which is deliberately position-free and shared by three serializers — it takes
  its own `visitContent` pass, the focused-walker habit `paths.ts` and
  `imageusage.ts` already follow.
  **Invariant:** there is ONE positioning construct, a `w:framePr` text frame.
  It is ECMA-376 Part 1 and in the main `w:` namespace, so `docxpackage.ts`'s
  root declaration (`w`, `r`, `wp`) does not change. VML `<w:pict><v:shape>`
  can express rotation but is Transitional-only and needs `v` on the root; a
  DrawingML `wps:wsp` needs `mc:AlternateContent` with a VML fallback — writing
  both other constructs anyway, plus `mc:Ignorable`. Images and the backdrop are
  frames too, wrapping the same `drawingXml` flow mode places inline: a second
  mechanism is how a page comes to place its text against one origin and its
  pictures against another.
  **Invariant:** `docxgroup.ts` groups **glyphs**, never `TextFragment`s.
  Fragments merge across colour changes by design (`fragmentsFromGlyphs` keys on
  font, size and baseline), so grouping from them paints a line the colour of
  its first word, and the boundary cannot be recovered once the fragment has
  dissolved it. Colour, size, emphasis, baseline and gap are one rule this
  module owns.
  **Invariant:** the gap threshold is what keeps a two-column page in two
  columns — `TextLine` assembles every fragment sharing a baseline, so the left
  and right columns are one line, correct for reading order and fatal here.
  **Note, measured:** it is bounded from BOTH sides and a single-column fixture
  cannot pin it, since every gap in one is below it whatever the value. The
  leader row and the gutter bound it above; an ordinary inter-word space bounds
  it below. Likewise a colour or emphasis split needs its boundary MID-RUN in
  one face at one size, or the size rule splits it and the test passes with the
  colour rule deleted.
  **Invariant:** a frame errs wide, never narrow. Word re-measures with a
  substituted face; a frame narrower than the result wraps to a second line,
  while `w:wrap="none"` makes an over-wide one displace nothing. The two errors
  are not symmetric. `w:hRule` is `atLeast` for the same reason — an overflowing
  line overlapping its neighbour is visible, a clipped one is gone.
  **Invariant:** the frame's top comes from `quad[3]`, not a font ascent. A
  group's quad already runs `baseline .. baseline + fontSize`, so its top edge is
  where Word starts the line box. `htmlfixed.ts` subtracts `ascent * dev`
  because a CSS `top` is the em-box top and it knows the substituted face's
  ascent; inventing one for a face we did not choose would be a guess.
  **Invariant:** a non-final `w:sectPr` lives inside the LAST paragraph's
  `w:pPr`; only the final section's is a direct `w:body` child. Not
  interchangeable — the wrong one is a file Word refuses, the same class of rule
  as `w:tcPr`'s ordered children. `w:pPr`'s children are ordered too
  (`w:framePr`, `w:pStyle`, `w:numPr`, `w:ind`), so `w:framePr` is INSERTED at
  its place rather than appended.
  **Invariant:** every page emits one ordinary, unframed paragraph. A framed
  paragraph is lifted out of the flow, so a page of nothing but frames has no
  flow content and its section collapses into the next. Margins are zero for the
  same reason: frames anchor to the page edge regardless, but that anchor
  paragraph does not.
  **Invariant:** the backdrop is GLYPH-LESS and the frames stay visible —
  never both drawings of the text. It renders through `renderPageGraphicsToPng`,
  the same export `htmlfixed.ts`'s `backdrop: 'raster'` uses, so neither export
  keeps its own idea of what a backdrop contains. A `page.ToImage()` here bakes
  in a second copy of every glyph, which Word then re-renders from the frame
  with a substituted face onto different pixels — invisible to a test that only
  asserts a picture frame exists, which is how it survived from `8yt9.4` to
  `tvc4`. Measured on the fixture: 690 dark pixels inside the first fragment's
  own quad before the fix, 0 after. Note the degrade differs from HTML's on
  purpose: a page that will not rasterize simply loses its backdrop here, where
  HTML must fall back to a vector backdrop WITH visible text, because dropping
  `'page'`'s backdrop would leave transparent text over nothing.
  **Invariant:** the backdrop is emitted FIRST and the drawing-id counter spans
  the whole document. Frames stack in document order, so a backdrop after the
  text hides the page; `wp:docPr@id` must be unique across `document.xml`, and a
  duplicate is a file Word calls corrupt in some builds and opens in others.
  **Invariant:** `docxflow.ts` gains vocabulary, never a branch —
  `ParaProps.frame` and `RunFmt.size`/`.color` emit nothing when unset, which is
  what keeps flow mode byte-identical. Asserted directly by
  `test/docx-flow-identity.test.ts`, which pins the sha256 of flow output. That
  is a FENCE, not a golden to refresh when it goes red.
  **Note:** textbox mode writes no `styles.xml` and no `numbering.xml` — it
  names no style id and allocates no list, and a part defining styles nobody
  uses is the same nothing as a `.rels` with no relationships.
- **epub.ts**, **epubsplit.ts**, **epubexport.ts** — EPUB 3 export (`Document.ToEpub`), the
  fourth serializer over `docmodel.ts` after `htmlsemantic.ts`, `mdexport.ts`
  and `docxflow.ts`. `epub.ts` is the OCF container and OPF package writer and
  is PURE — it imports `zip.ts` and nothing else, so mimetype placement,
  manifest/spine consistency and the OPF grammar are all testable from
  hand-built part lists; `epubexport.ts` is the only module here that reads a
  `Document`, the split `svgdraw.ts`/`svgembed.ts` already makes. Note
  `ooxml.ts` is NOT reusable here: OPC's `[Content_Types].xml` and `.rels`
  graph have no EPUB counterpart and EPUB's manifest/spine has no OPC one, so
  the two container conventions share `zip.ts` and nothing above it.
  **Invariant:** `mimetype` is the FIRST entry and is STORED. A reader
  identifies an EPUB by reading `application/epub+zip` at byte 38 — 30 bytes of
  local file header plus the 8-byte name, no extra field — without inflating
  anything, so deflating it or emitting it second leaves a valid ZIP holding
  every right part that is no longer recognisable as an EPUB. It is the one
  rule a structural "are the parts present" test cannot see, which is why it is
  asserted on the archive's RAW bytes and why both halves were confirmed by
  mutation rather than assumed.
  **Invariant:** a manifest href is relative to the OPF's own directory, not the
  archive root — the same trap `ooxml.ts` records for a relationship target. Get
  it wrong and every part exists while every link dangles, so the symptoms all
  point at the target while the fault is in the base.
  **Invariant:** every `dc:identifier` branch is deterministic — an option, then
  the trailer `/ID`, then a hash of the content. `zip.ts` fixes its timestamps
  so two runs give identical bytes, and `dcterms:modified` is the same fixed
  1980 constant; a generated UUID or a clock read would undo reproducibility for
  the whole format.
  **Invariant:** `dc:language` defaults to `und`, never `en`. A missing language
  makes the file invalid so something must be written, but claiming English
  states a fact the document never did — the refusal to invent that also keeps
  `<strong>` out of the HTML export and an info string off an exported code
  fence. **Note, measured:** `buildTaggedPdf` declares `/Lang en-US`, so it
  cannot exercise this at all; the fallback needs a fixture with NO `/Lang`, and
  a companion asserting a real `/Lang` still wins.
  **Invariant:** `epubsplit.ts` is PURE over `DocNode[]` — no `Document`, no
  `Page` — so every splitting rule is testable from hand-built nodes, the split
  `floatstack.ts` and `docinfer.ts` already make.
  **Invariant:** the split level is DERIVED (the shallowest heading level
  present), never fixed at `H1`. Our own extraction routinely produces H2-rooted
  documents — `buildTaggedPdf`'s only heading is an `H2` — and a fixed rule
  exports those as one long chapter, which is the defect the feature exists to
  fix, reintroduced for a subset of documents.
  **Invariant:** the splitter DESCENDS through lone wrapper containers before
  looking for headings, and re-wraps each chapter in them so a `/Sect`'s
  `lang` survives into every content document. Measured: the untagged geometry
  path returns a flat list, but `AddMarkdown({ tagged: true })` buries
  everything under one `/Sect` and `AutoTag` under one `/Document` — so a
  top-level-only split yields a single chapter for every TAGGED PDF, i.e. it
  fails silently on exactly the documents carrying the best structure.
  **Invariant:** content before the first heading becomes its own leading
  chapter, and the result is never empty — a headingless or empty document
  yields exactly one chapter, which is what keeps the spine and the nav
  non-empty.
  **Invariant:** ONE image sink spans every chapter, created outside the chapter
  loop. A per-chapter sink would silently write a shared picture into the
  package once per chapter — invisible in the markup, obvious only in the file
  size. Both halves are pinned, by two different fixtures and for a reason:
  the same-chapter case cannot see this one at all — a per-chapter sink leaves
  it green, measured — because `AutoTag` will not produce an image inside two
  separate chapters (it ranks headings per block, so the headings cluster into
  one). The cross-chapter half therefore needs a hand-built structure tree,
  `test/helpers/build-tagged-book-pdf.ts`: two `H1`s each with a `/Figure`
  whose `/K` is an MCID marking a `Do` of the SAME `/Im0`. Note the figure's
  `/K` must be an MCID rather than `buildTaggedPdf`'s `/OBJR`, which names an
  annotation and resolves to no image at all. Moving the sink construction
  inside the chapter loop turns that one case red — two parts — and nothing
  else in the file, markup assertions included.
  **Invariant:** the nav and the spine are built from the ONE `chapters` list,
  so they cannot disagree about how many chapters exist or what they are called.
  **Note:** no test opens a reader — a suite that needs Calibre installed is not
  hermetic, the rule `docx-package.test.ts` already follows for Word. Opening in
  calibre 7.26.0 is verified by hand and recorded in
  `docs/epub-calibre-verification.md`, which also records the trap: Calibre's
  `Detected chapter:` log comes from XPath over `h1`/`h2` and appears whether or
  not `nav.xhtml` is read at all, so only the EPUB→EPUB round trip (our titles
  appearing in Calibre's own `toc.ncx`) actually proves the navigation works.
  **Invariant:** content documents are XHTML, which is why `htmlsemantic.ts`
  self-closes its void elements and spells out boolean attributes for BOTH
  exports rather than behind a flag. One dialect, valid as HTML5 and as XHTML,
  cannot drift between the two consumers; a flag would break only EPUB and only
  in a reader. `semanticBody`'s optional `HtmlImageSink` is the other half:
  omitted it inlines `data:` URIs as before, and `epubexport.ts` passes a sink
  that registers each image as a package part.
- **html.ts**, **htmlsemantic.ts**, **htmlfixed.ts**, **htmlfont.ts**,
  **htmlfontembed.ts**, **imagehref.ts**, **sfntwrite.ts**, **woffwrite.ts** —
  HTML conversion (`Page.ToHtml` / `Document.ToHtml`). `html.ts` is the entry and
  options; **htmlsemantic.ts** serializes a `docmodel.ts` tree as reflowable
  markup (structure type → tag via `TAG_FOR`, escaping, images as data URIs
  from **imagehref.ts**, tables through `Table.toHtml()`) — it holds no walk of
  its own, and `test/html-identity.test.ts` snapshots its output so the shared
  model cannot silently move it; **htmlfixed.ts** reproduces
  positioned pages by driving `pagerender.ts`'s `interpret` into an SVG/HTML sink.
  Fonts: **htmlfont.ts** maps generic families to CSS stacks with browser-measured
  ascents; **htmlfontembed.ts** subsets and re-emits embedded programs as
  `@font-face` WOFF, assembling the sfnt with **sfntwrite.ts** (cmap/`otfFromCff`)
  and compressing it with **woffwrite.ts**.
  **Invariant (`m9on`):** a Type 1 `/FontFile` is embedded too, converted to
  OpenType-CFF by `type1cff.ts` — the same path `AddFont` takes for a `.pfb`.
  ITS GLYPH IDS MUST BE TRANSLATED. `run()` collects `gidToCp` and `advances`
  in the Type 1 program's OWN numbering (order of appearance in `/CharStrings`,
  which is what `gidForCode` answers), while `type1ToCff` RENUMBERS so
  `.notdef` is gid 0 as CFF requires — and `NimbusSans-Regular.t1` lists
  `/.notdef` LAST, so every glyph shifts by one. Both are valid glyph ids, so a
  missing remap throws nothing and renders each character as its neighbour;
  `newGidByOldGid` is the inverse map and `buildType1Sfnt` applies it.
  **Note, measured, and the reason the fixture draws 'B' rather than 'A':** in
  that font `A` is gid 0, so an un-remapped `A` asks for gid 0 — `.notdef`
  after renumbering — and cmap format 4 reports glyph 0 as ABSENT. The bug
  would surface as a missing lookup rather than as the wrong picture. `B` is
  gid 1, which IS a real glyph after renumbering (`A`), so it fails on an
  outline mismatch, which is the actual failure mode.
  **Invariant:** the conversion is LAZY — `probe()` only checks that a
  `/FontFile` exists and parsed, and `buildProgramSfnt` converts once at
  `css()` time. Interpreting every charstring of a face that may never reach
  the embed path is work for nothing.
  **Note:** a Type 1 carries no `OS/2`, so it states no `fsType` and `embed`
  behaves as `embed-all` does for one. The asymmetry with TrueType is
  structural rather than an oversight.
  **Note:** `programUnitsPerEm` consults `type1.unitsPerEm`, which comes from
  `/FontMatrix` and is not always 1000. A flat 1000 against a 2048/em face
  halves every advance — a plausible narrow face rather than an obvious fault.
  **Invariant:** `HtmlOptions.backdrop` picks what sits behind the text and the
  text treatment FOLLOWS from it: `'vector'` (inline SVG) and `'raster'`
  (glyph-less PNG) keep visible spans, `'page'` (whole-page PNG) makes them
  `color:transparent`. Never a second option — a glyph-less backdrop with
  transparent text is an invisible page, and a full-page backdrop with visible
  text draws every glyph twice, once baked in and once by the browser with a
  substituted face. One three-valued option makes both unrepresentable.
  `ToDocx({ mode: 'textbox' })` did exactly that double-draw until `tvc4`.
  **Invariant:** the key is `backdrop`, not `background`, in BOTH `HtmlOptions`
  and `DocxOptions`. `ImageOptions.background` keeps `'white' | 'transparent'` —
  that one is a background colour. Three unrelated meanings on one key across
  bags a caller mixes in a file has no compile-time guard, unlike the
  `MarkdownExportOptions` collision recorded above. DOCX's one value is
  `'raster'` and means exactly what it means in HTML — a glyph-less render with
  the text left visible over it. It does NOT offer `'page'`: that pairing needs
  transparent text, and WordprocessingML has no transparent run colour to build
  it from (`w:color` carries no alpha, and `w14:textFill` is an extension
  namespace `docxpackage.ts` deliberately does not declare). One word, one
  meaning, across both exports — the whole point of the rename (`tvc4`).
  **Invariant:** a page that will not rasterize falls back to `'vector'` —
  backdrop and visible text together, one rule for both raster modes.
  `docxexport.ts` degrades by dropping the backdrop and keeping the text, which
  is right there and wrong here: with `'page'`'s transparent text, dropping the
  backdrop leaves a blank page. The transparent-text class is therefore keyed on
  the backdrop having actually been emitted, not on the mode — measured, by
  keying it on the mode instead and watching the case go red.
  **Note, measured:** the glyph-less claim is pinned by a pixel probe INSIDE a
  glyph's own quad (taken from `GetTextFragments`, not guessed), with the
  opposite assertion on the same box for `'page'`. Asserting only that the two
  PNGs differ would pass if the suppression flag changed anything at all.
  **Invariant:** `forms: true` converts a widget and SUPPRESSES its appearance,
  one `hideWidgets` set reaching both the vector sink and the rasterizer
  (`interpret`'s option, and `renderPageBackdropToPng` for either raster
  backdrop). A widget drawn behind its own control shows the field's value
  twice — once painted, once in the control — which was `tvc4`'s defect in
  another export. Suppression is per WIDGET, so a field that does not convert
  (a push button whose `/A` is not SubmitForm/ResetForm, a widget with no
  `/Rect`) keeps its ink and is deliberately absent from `converted`.
  **Invariant:** `htmlforms.ts` is PURE — no renderer, no sink, no ink — and
  returns the markup beside the set of widgets it claimed. The set is built by
  the same pass that builds the markup rather than predicted from the field
  list, which is what makes "a field that threw keeps its appearance" true by
  construction. `pageFormControls` runs BEFORE the `interpret` pass, which needs
  that set; controls are emitted AFTER the spans so they stack above both
  layers.
  **Invariant:** a radio's `value` comes from that widget's own `/AP /N` key
  (`widgetOnState`), never `synthOnState`, and a choice's options through
  `parseOptions` + `displayOf` so an `[export, display]` entry keeps both
  halves. `tabindex` runs across the DOCUMENT, so the counter is injected —
  per-page indices would restart and interleave a multi-page form.
  **Note:** unlike Go, which restricts `InteractiveForms` to its two
  non-faithful modes, `forms` works with `backdrop: 'page'` — the restriction is
  a property of Go's rasterizer, not of the format, and our raster pass takes
  the same suppression set.
  **Note, measured:** what pins the double-draw rule is the pair of pixel probes
  inside a converted widget's own `/Rect` (converted → no ink, unconverted →
  ink) plus the `hideWidgets` SVG counts. The `<span>` guard in
  `test/html-forms-suppress.test.ts` is NOT load-bearing: `buildFormPdf`'s text
  field carries no `/AP`, so nothing paints its value either way, and neutering
  `drawAnnots`' skip leaves that case green. A fixture whose `/AP` is an empty
  stream cannot tell suppression from drawing.
  **Invariant:** the tagged walk resolves a `/Figure`'s image by **MCID**, never
  by page position or resource order. `page.Images` is `/Resources` order and
  says nothing about which figure draws what; `ImageEvent.stream` plus
  `ImageEvent.mcid` is the seam (`pageMcidImages` + `figureStreams`, both in `docmodel.ts`). Build the
  per-page MCID→images map in *one* `visitContent` pass and memoize it, or a
  page with N figures re-walks its content N times. MCID propagates into Form
  XObjects, so a figure marking a `Do` of a form still resolves.
  **Invariant:** a composite figure carries its `/Alt` on the first `<img>`
  only. Repeating it makes a screen reader announce the same description once
  per part.
  **Invariant:** a page-filtered export (`page.ToHtml()`) skips content items on
  other pages, so a figure split across a break cannot pull in the other half.
- **ccitt.ts**, **ccitt-tables.ts** — `CCITTFaxDecode` (Group 3 1D/2D, Group 4).
- **ccittencode.ts** — the Group 4 (T.6) **encoder**, behind `encodeG4` and
  `encodeTiff`'s `compression: 'g4'`. Pure.
  **Invariant:** the code TABLES are not transcribed here. `ccitt-tables.ts`
  already owns T.4's run codes and T.6's mode codes for the decoder, and this
  imports them; `findB1Index` is exported from `ccitt.ts` and shared for the
  same reason — "which changing element is opposite in colour to a0" is ONE
  question, and both `a1` (coding line) and `b1` (reference line) ask it with
  the SAME colour argument. Passing the flipped colour for `a1` selects the
  wrong parity and skips it entirely; that was the one real bug in writing this.
  **Invariant:** input is 1-bpp MSB-first with **1 = black**, which is exactly
  what `decodeCcitt` returns under `blackIs1: false`. The contract is defined by
  round trip rather than by prose, because polarity is the thing everyone gets
  backwards and a mirrored bitmap decodes perfectly while showing the negative.
  **Note, and it is why this has a size test at all:** MODE SELECTION cannot be
  checked by round trip. Any mode choice that decodes back to the same bitmap is
  correct G4, so dropping VR3 and falling through to horizontal mode round-trips
  perfectly and costs only bytes — measured, 117 → 203 on the staircase fixture,
  which is why that one asserts a size bound.
  **Note on the oracle, and it is STRONGER here than for our other writers:**
  `decodeCcitt`'s G4 path is anchored by `test/fixtures/tiff/libtiff-g4-*.tif`,
  real libtiff files with ground truth from a third decoder — so a round trip is
  checked against a reader that agrees with libtiff, unlike `gifencode.ts`,
  whose reader we also wrote.
  **Note, measured and NOT claimed:** G4 is not asserted to beat Deflate.
  Without vertical coherence Deflate wins outright on synthetic bilevel pages;
  with it the two land within 2%. Real scans favour G4 more than any fixture we
  can synthesize, but no real fax TIFF is vendored. The reason to write G4 is
  what fax and archival toolchains EXPECT to read.
  **Note:** it refuses a non-bilevel frame rather than thresholding, so
  `ToImage({ format: 'tiff', compression: 'g4' })` refuses too — a rendered page
  is 8-bit RGB, and picking a threshold is a decision about the image.
- **embeddedfile.ts**, **collection.ts** — embedded-file attachments
  (`Attachment`) and the `/Collection` portfolio layer. **pagelabels.ts** —
  `/PageLabels` ranges; named destinations live in **outline.ts**.
- **docaction.ts**, **nametree.ts** — catalog-level actions and the `/Root
  /Names` vocabulary. `docaction.ts` is `/OpenAction` and the `/Names
  /JavaScript` tree: what the DOCUMENT does, as against what activating an
  annotation does, which is `annotation.ts`'s `/A`. Both halves are small, both
  write to the catalog, and neither has anything the other lacks, so they share
  a module rather than making a two-file feature with nothing in either file.
  **Invariant:** nothing here re-derives the action grammar. `encodeAction` and
  `parseStandaloneAction` in `actions.ts` are the one owner — the same rule
  links, push buttons and field `/AA` triggers already follow — which is what
  gives this module the `/JS` stream read for free.
  **Invariant:** `nametree.ts` is a LEAF: it imports `Document` as a TYPE only,
  which is what lets `document.ts`, `embeddedfile.ts` and `docaction.ts` all
  hold it without any of them depending on another — the arrangement
  `tablegrid.ts` already has between the two table detectors.
  **Note on where it lives:** not in `outline.ts`, which is bookmarks and
  destinations. `/Dests` is only ONE of a name tree's branches, and the other
  two (`/EmbeddedFiles`, `/JavaScript`) have nothing to do with navigation.
  **Invariant:** a lookup honours `/Limits` when the node states them. A name
  tree is a B-tree and a producer is entitled to rely on that — ignoring the
  limits still finds the key by brute force on a small file and silently misses
  it on a large one, which is the worst possible failure shape.
- **signature.ts**, **signer.ts**, **sigalg.ts**, **sigappearance.ts**,
  **sigplaceholder.ts**, **incremental.ts**, **pkcs12.ts**, **docmdp.ts** —
  digital signing (`Sign`/`Certify`): CMS/PAdES build, credential sources,
  visible appearances, incremental-append vs full-rewrite, and DocMDP. Verify and
  its trust plumbing: **sigverify.ts**, **chain.ts** (cert-path), **revocation.ts**
  (OCSP/CRL), **dss.ts** (LTV `/DSS`), **rfc3161.ts** (timestamps), over
  **asn1.ts** + **cms.ts** primitives, with **cmskdf.ts** supplying the ECDH-ES
  key-agreement primitives (X9.63 KDF, `ECC-CMS-SharedInfo`, RFC 3394 AES key
  wrap) that `cms.ts` needs for EC recipient certificates.
- **encrypt.ts** / **crypto.ts** (standard handler) plus **pubsec.ts**
  (certificate-based `/Adobe.PubSec` encrypt/decrypt).
- **filters.ts**, **streamfilter.ts**, **ascii.ts**, **lzw.ts** — stream
  **encoders** (`encodeStream`, `ascii85Encode`/`asciiHexEncode`/`lzwEncode`/
  `runLengthEncode`) and the `Save({ streamFilter })` re-filter pass.
- **optimize.ts**, **glyphusage.ts**, **fontshrink.ts**, **dedup.ts**,
  **recompress.ts**, **drprune.ts**, **imageopt.ts**, **imageusage.ts**, **resample.ts** —
  `doc.Optimize()`, which shrinks the live model in place so the next `Save()`
  writes a smaller file. **optimize.ts** orchestrates the concerns and builds the
  `OptimizeReport`. The lossless three run by default: font subsetting
  (**glyphusage.ts** scans page content, `/AP` streams, tiling patterns, and
  Type3 charprocs for the glyphs each program actually shows, then
  **fontshrink.ts** blanks the rest in place — `shrinkGlyf` for TrueType,
  `shrinkCff`/`shrinkNameKeyedCff` for CID-keyed and name-keyed CFF), stream
  dedup (**dedup.ts**, content-hashed), and payload recompression
  (**recompress.ts**). Opt-in `{ images }` is **lossy**: **imageusage.ts** tracks
  the CTM to find each image's max effective DPI, **resample.ts** box-filters it
  down, and **imageopt.ts** re-encodes to JPEG.
  **Invariant:** shrinking preserves GID numbering and never renumbers — a usage
  scan that cannot prove itself complete must skip the font, not guess, since a
  wrong guess silently blanks a glyph that is actually shown.
  **drprune.ts** removes `/AcroForm /DR` entries nothing names, in every resource
  category, and deletes the objects that orphans.
  **Invariant:** the reference scan walks from the *catalog*, never
  `doc.objectEntries()`. `Form.RemoveField` leaves the unwired field dict in the
  object map for `Save()`'s mark-sweep, so scanning every object reads the `/DA`
  of the very field whose removal this pass exists to clean up after — and the
  pass silently becomes a no-op on its own motivating case.
- **jpegencode.ts**, **jpegfdct.ts**, **jpeghuffenc.ts**, **jpegcoef.ts** — the
  baseline JPEG **encoder** behind Optimize's image pass (gray/RGB/CMYK):
  forward DCT and quantization (**jpegfdct.ts**), Huffman tables and bit writing
  (**jpeghuffenc.ts**), and the back half — entropy coding, Huffman table
  selection and marker assembly — in **jpegcoef.ts**, over quantized
  coefficients rather than samples. The decode counterpart is jpeg.ts.
  **Invariant:** `jpegcoef.ts` has TWO producers and therefore exists at all:
  `jpegencode.ts` arrives after FDCT and quantization, `jpegtranscode.ts`
  arrives with coefficients it took from an existing file and never touched. A
  second copy of the entropy coder is how the two come to disagree about a table
  or a marker order — which no test asserting decoded PIXELS can see, since a
  decoder indexes Huffman tables by class and id and does not care what order
  their DHTs were written in. Measured: reordering the DHT writes reddens all
  nine hashes in `test/jpeg-encode-identity.test.ts` and leaves every case in
  `jpeg`, `jpeg-real`, `grayimage` and `grayscale-convert` green. That file is a
  FENCE recorded before the extraction, not a golden to refresh.
  **Invariant:** blocks cross that boundary in **zig-zag** order and quantization
  tables in **natural** order, and the asymmetry is the thing to get right.
  Zig-zag because JPEG entropy coding is defined over it — a run length counts
  zeros along the zig-zag — so `quantizeBlock` already writes it and `codeBlock`
  already reads it, which is what lets `encodeJpeg` cross unchanged. Natural for
  the tables because `scaleQuantTable` produces natural and the DQT writer
  re-zigzags on the way out, while `parseDQT` stores the WIRE order it read,
  which is zig-zag. Both orders appear in `jpegtranscode.ts`, running opposite
  ways, a few lines apart.
- **jpegtranscode.ts** — coefficient-domain greying (`greyJpegFromCoefficients`),
  the fast path under `ConvertToGrayscale`'s DCT branch. A YCbCr JPEG's Y channel
  **is** Rec. 601 luma, so greying one by decoding to RGB and re-encoding
  re-derives, lossily, a number the file already holds exactly: this keeps
  component 0's quantized coefficients and its quantization table verbatim, drops
  the chroma, and re-emits a one-component baseline JPEG. Pure — bytes in, bytes
  out, no PDF objects.
  **Invariant:** it **declines**, never throws, for everything — an unsupported
  shape and a malformed file alike. The caller then falls back to the sample
  route, whose own `catch` reports the failure; one error path rather than two.
  A decline is NOT a `skipped` entry: the image converts either way and `route`
  says which.
  **Invariant:** the decisive eligibility test is the colour transform, and
  getting it wrong is silent. Transform 0 means component 0 is **red**, not luma
  — a JPEG whose SOF ids are `'R'`,`'G'`,`'B'`, which libtiff writes for a
  JPEG-compressed RGB TIFF — so keeping it would emit the red channel as grey: a
  plausible-looking photograph, entirely wrong, with nothing anywhere to flag it.
  `jpegTransform` in jpeg.ts is the ONE owner, shared with `combinePlanes`.
  **Invariant:** the MCU padding is dropped. At 4:2:0 the Y plane's grid is
  `ceil(w/16)*2` blocks wide where a one-component frame needs `ceil(w/8)`, and
  those differ whenever `w mod 16` falls in 1..8 — `testorig.jpg` is 227×149 and
  lands in it on both axes. Re-emitting them yields a file that still decodes,
  just wider than its own SOF claims. **Note, measured:** a test asserting the
  output's `bpl`/`blocksPerLine` is BLIND to this — a decoder derives those from
  the SOF width, which is written from `frame.width` either way — so the fixture
  asserts pixels, over a gradient rather than a flat colour, since with a flat
  source every block is identical and a mis-walked grid changes nothing.
  **Note:** `decodeJpegFrame` exists because `decodeJpeg` built a `Frame` full of
  quantized coefficients and threw it away. It does not handle hierarchical
  JPEGs — those have no single frame — so a caller tests `isHierarchical` first.
- **grayconvert.ts**, **grayops.ts**, **grayimage.ts**, **grayshading.ts**,
  **graymesh.ts**, **grayscale.ts** — document-wide grayscale conversion
  (`doc.ConvertToGrayscale`), across page content, form XObjects, tiling
  patterns, Type 3 glyph procedures, image XObjects, inline images, shadings and
  annotations. `grayscale.ts` is the leaf holding the one greying rule (`luma`,
  Rec. 601); `grayops.ts` rewrites colour operators in a content stream;
  `grayimage.ts` converts one image XObject; `grayshading.ts` converts one
  shading and `graymesh.ts` re-splices a mesh's bit-packed vertex colour;
  `grayconvert.ts` is the only module of the six that touches a `Document` — the
  split `svgdraw.ts`/`svgembed.ts` makes. It builds the `GrayscaleReport`.
  **Invariant:** conversion is operator **NEUTRALIZATION**, not colour-space
  retargeting. Every `rg`/`k`/`sc`/`scn` becomes `g`/`G` carrying the luma of the
  colour it set, `cs` becomes `/DeviceGray`, and named `/ColorSpace` resources
  are left unreferenced for `Optimize`'s `dr` pass. That is what makes the two
  passes ORDER-INDEPENDENT: the content pass *reads* colour-space resources that
  no pass *writes*. Retargeting would have the content pass resolving spaces the
  object pass had already moved out from under it, and would leave a space shared
  between an image that converts and one that cannot self-inconsistent.
  **Invariant:** Rec. 601 rather than Rec. 709, because it is what Ghostscript
  and the rest of the PDF tooling emit — a document converted here matches the
  same document converted elsewhere — and because it is exactly JPEG's Y channel,
  which is what `jpegtranscode.ts` later cashed in.
  **Invariant:** everything non-device reaches the one rule through
  `resolveColorSpace`, the same owner `paths.ts` and glyph colour use, which is
  why ICCBased, Indexed, Separation, DeviceN, CalRGB and Lab need no cases.
  **Invariant:** the four image routes are cheapest-faithful, and `route` names
  which ran: `palette` (Indexed — rewrite the lookup table, leave sample data
  byte-identical; lossless, smaller, and the ONLY route that works below 8 bits
  per component, where a decode hands samples back still packed), `jpeg-exact`
  (jpegtranscode.ts; does not set `lossy`), `jpeg` (decode and re-encode at
  `quality`; sets `lossy`) and `flate`.
  **Invariant:** `grayimage.ts` and `grayshading.ts` take `resolve`/`inflate` as
  ARGUMENTS and never import `document.js`, so every rule is testable from a
  hand-built dict. Anything needing an object number is handed back for
  `grayconvert.ts` to `allocObject` — which is how the colour-key stencil below
  reaches the file, the split `imageembed.ts` already makes for an `/SMask`.
  **Invariant:** `graymesh.ts` is pure BIT arithmetic and takes the colour rule
  as a callback, so it never learns what a colour space is and `grayshading.ts`
  stays the one owner of "what is the luma of this colour".
  **Invariant:** a mesh's coordinates are copied as raw BIT PATTERNS and never
  pass through a float, so the geometry of the output is bit-identical and a
  re-spliced mesh cannot drift. Its `/Decode` keeps the coordinate half and its
  colour half collapses to the one grey range.
  **Invariant:** the two mesh record encodings are easy to conflate and each
  renders as a plausible mesh when read as the other. 32000-1 8.7.4.5.5 pads
  every type 4 VERTEX to a byte boundary; 8.7.4.5.6 states no such padding for
  type 5, whose vertices run continuously. A type 6/7 patch whose flag is
  non-zero shares an edge with its predecessor, so four of its control points and
  two of its four corner colours are absent from the record.
  **Invariant:** a colour-key `/Mask` is converted by recording WHICH PIXELS it
  matched as a 1-bit stencil, never by re-deriving the range. Two colours can
  share a luma — (255,0,0) and (0,130,0) both grey to 76 — so no grey range is
  faithful; but `/Mask` is defined as either a colour-key array or a stencil
  image (8.9.6.4), so the conversion stays in the same entry and is exact.
  Polarity is 1 = masked out, matching `/ImageMask` under `/Decode [0 1]`.
  **Invariant:** an **Indexed** image's colour key needs no conversion at all —
  8.9.6.4 keys raw pre-Decode samples, which for Indexed are index values, and
  the palette route leaves every index byte untouched. It was refused from
  `10u9.1` to `10u9.7` for a reason that never applied to it, because the guard
  ran before the route split.
  **Note:** `raster.ts` honours both forms of `/Mask` since `10u9.12`, so
  `test/mask-render.test.ts` verifies the conversion end to end — it renders a
  keyed image, greys it, and asserts the SAME pixels stay masked, which the
  luma collision above makes sharp. `ToSvg` still cannot: it goes through
  `imagehref.ts`, a separate path that drops `/SMask` and `/Mask` alike
  (tracked separately). Do not read a green `ToSvg` as covering any of this.
  **Invariant:** what cannot convert is reported in `skipped` with a reason
  rather than silently left in colour, and a skip is different from a route
  DECLINE — a decline still converts, by the other route. Skips: a colour-key
  `/Mask` beside an `/SMask` (32000-1 makes them mutually exclusive), a
  `/Decode` array, a filtered inline image, a mesh whose data ends mid-record.
  **Invariant:** it throws `UnsupportedFeatureError` on a signed document, which
  converting would invalidate.
- **linearize.ts** — linearized (Fast Web View) output + `verifyLinearization`.
- **node.ts** — file-based convenience wrappers. **index.ts** — public exports.

Tests live in `test/` (vitest). Most fixtures are built programmatically by the
builders in `test/helpers/`, which keeps the suite hermetic and readable.

A few are instead **real-world binaries from third-party producers**, in
`test/fixtures/`. They exist to catch the one class the builders cannot: a
shared-convention bug, where our reader and our builder agree with each other and
both disagree with the format. Each directory carries a provenance document
recording the producer and version, the exact command, SHA-256 of input and
output, and what the fixture does and does **not** cover:

| Directory | Provenance | Covers |
|---|---|---|
| `fixtures/fonts/` | `PROVENANCE.md` | WOFF2 from wawoff2 and fontTools — `glyf`, `hmtx`, and CFF-flavoured (`OTTO`) input |
| `fixtures/jpeg/` | `PROVENANCE.md` | libjpeg-turbo's own images, plus `cjpeg`-generated synthetics (incl. CMYK/YCCK) |
| `fixtures/svg-input/` | `PROVENANCE.md` | SVG→PDF **input**: an SVGO-optimized pair, a bootstrap-icons file, a d3-shape chart — path-grammar lexis our builders never write. Distinct from `fixtures/svg/`, which is PDF→SVG **output** goldens |
| `fixtures/svg-filter/` | `PROVENANCE.md` | Browser-rendered goldens for feTurbulence and the lighting primitives — ports of published reference implementations, which cannot validate themselves |
| `fixtures/svg/` | `PROVENANCE.md` | PDF→SVG **output**: headless-Chrome rasterizations of `ToSvg()` for the transparency constructs, cross-checked against resvg. Our rasterizer works from PDF semantics and the browser from our emitted markup, so agreement is independent evidence (`scripts/gen-svg-goldens.ts`, not run by `npm test`) |
| `fixtures/bmp/` | `PROVENANCE.md` | BMP **input**: seven files from GDI+ (the format owner's writer) read back by bmp-js. Corroborates the palette, 16-bit and 32-bit paths that `test/bmp.test.ts` anchored on our builder alone — measured as adding no mutation coverage over it, so read that file's two Wikipedia hex dumps as still load-bearing. Carries two shapes a builder would not emit: a 224-entry partial palette, and a `Format32bppArgb` save declaring no alpha (`test/bmp-real.test.ts`) |
| `fixtures/tiff/` | `PROVENANCE.md` | TIFF **input**: nine files from libtiff (via libvips/sharp) and utif2, with ground truth from a third decoder — libvips reading each back. The tiled-G4 file is the only shape that separates the *block* width `decodeCcitt` is told from the *image* width, a mutation `test/tiff.test.ts` leaves green. Found the `jpeg.ts` RGB-component-id bug on its first run (`test/tiff-real.test.ts`) |
| `fixtures/pdfx/` | `PROVENANCE.md` | Ghostscript-produced PDF/X-1a/X-3/X-4 for `pdfxvalidate.ts` — four conformant, one deliberately not, and the only fixtures reaching `outputIntentRule`'s registered-name branch (`test/pdfx-real.test.ts`) |
| `fixtures/corrupt/` | `PROVENANCE.md` | Damaged files for the recovery suite (`test/corrupt-real.test.ts`). The one directory where the *source* is what is third-party — a corrupt file has no producer — so Ghostscript and qpdf lay out the bytes and the damage is recorded byte for byte, alongside what each fixture salvages and loses |
| `fixtures/xfdf/` | `README.md` | Acrobat's own XFDF appearance encoding |
| `fixtures/unicode/` | — | UAX #9 / #14 conformance data from Unicode |
| `fixtures/commonmark/` | `PROVENANCE.md` | The official CommonMark 0.31.2 suite — 652 examples, run with no allowlist through the test-only oracle in `test/helpers/md-html.ts` |
| `fixtures/gfm/` | `PROVENANCE.md` | GitHub's own `spec.txt` — the 24 examples tagged with an extension name. The other 648 are a CommonMark **0.29** document and are deliberately not run |

Two rules apply to these, both learned the hard way:

- **Prove the assertions load-bearing, don't just watch them go green.** A
  fixture usually passes on the first run; that is not evidence. Break the code
  path it covers and confirm the suite goes red. Mutation testing is how the
  missing `hmtx` coverage was found in the first place — the reconstruction was
  never being called at all.
- **A differential test cannot validate the parser it runs through.** Comparing
  fixture against original puts both sides through the same code, so a bug
  cancels out and the test stays green. To check an interpreter, assert against
  something outside it (`cff.ts` charstrings are checked against `hmtx`, a table
  it never reads).

## Conventions & Patterns

- **Zero runtime dependencies** — only `node:` built-ins (`zlib`, `crypto`,
  `fs`). Do not add npm runtime deps.
- **ESM + NodeNext** — `strict` TypeScript; import specifiers carry the `.js`
  extension (e.g. `import { Page } from './page.js'`).
- **Live-mutation model** — edits act directly on the object map; `Save()`
  renumbers reachable objects 1..N (root first) and never mutates the inputs
  (remapping produces copies).
- **TDD** — land features with vitest tests and a fixture builder in
  `test/helpers/`; mirror existing builder/test style. Reach for a real-world
  fixture (above) only to validate a format against bytes we did not produce.
- **Errors** — throw `PdfParseError`, `UnsupportedFeatureError`, or
  `InvalidPasswordError` (see `errors.ts`); these are the public error types.
- **Docs** — keep `README.md` (user-facing: Features, Quick start, API overview,
  Limitations) in sync when adding or changing a public API. Per-feature design
  specs and plans live under `docs/superpowers/`.
  A new `src/*.ts` module earns an entry in the Source list above **when it
  lands**, not when someone next happens to touch that area — which is how eight
  of them came to have none at all (`2qkk`). The sweep that finds the gap:

  ```bash
  for f in src/*.ts; do b=$(basename "$f")
    grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
  done
  ```

  A module the list genuinely does not need — one whose whole story is a clause
  in a neighbour's entry — should be named in that neighbour's prose, so the
  sweep's output stays short enough to read.
