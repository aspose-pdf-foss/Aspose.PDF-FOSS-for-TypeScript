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
streams, the SVG inputs, the headless-Chrome SVG and filter goldens, the
WCS ICC goldens, and `gen:dfont`'s FontForge-written Macintosh suitcase) and
are likewise never run by the suite — it reads what they produced. Each needs
a tool that is NOT a dependency: headless Chrome, `mscms.dll`, FontForge.

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
  hybrid `/XRefStm`.
  **Invariant:** a FREE entry is recorded as `{ type: 'free', gen }`, never
  dropped, and it must OCCUPY the slot. The merge is newest-wins by "already
  present", so a dropped tombstone lets an OLDER section's offset entry fill
  the gap and a superseded object comes back from the dead — which is why a
  separate `freed` set cannot work: "freed in a newer section beats `n` in an
  older" and "`n` in a newer beats freed in an older" IS the newest-wins rule
  the map already implements. `document.ts`'s parse loop then skips a free
  entry BEFORE the offset/compressed split, which is a two-way branch that
  would otherwise read it as compressed and dereference a missing `streamObj`.
  **Note what this cost before `2yvi`:** the resurrected object was invisible
  to `Save()`, whose mark-sweep drops it as unreachable — so the symptom was
  not a corrupt file but a false REPORT. `objectEntries()` feeds
  `validatectx.ts`'s all-objects scan, so a document whose author had correctly
  deleted a prohibited stream still failed PDF/A validation for it. Measured:
  one `/LZWDecode` violation before freeing and one after, where qpdf says the
  object is gone.
  **Note:** recording free entries makes object 0 visible for the first time —
  every classic table opens with `0000000000 65535 f`, the free-list head, and
  a compressed save emits it as a type-0 row. It reaches `entries` and
  deliberately produces no OBJECT, which is what keeps the all-objects scans
  unchanged.
  **Note, measured:** the two readers are SEPARATE and the stream one is
  covered by exactly one case. Dropping `readXrefStream`'s `f0 === 0` branch
  reddens NOTHING against classic-table fixtures — `Save({ incremental: true })`
  refuses `compressed`, so no test can append a stream section — and it is
  pinned only by asserting object 0 on a `Save({ compressed: true })` document.
  It also reports the `/Prev` chain as `XrefResult.revisions`
  (`doc.Revisions`, `doc.hasIncrementalUpdates`), each carrying the byte length
  of the file as of that revision.
  **Invariant:** the chain is reported from the walk `readXref` ALREADY makes,
  never from a second scan — two walks is how a document comes to disagree with
  itself about how many revisions it has.
  **Invariant:** revisions are OLDEST FIRST, so the index is the revision
  number and `[0]` is the document as originally written. The walk itself runs
  newest first, because that is the direction `/Prev` points, so the list is
  reversed on the way out.
  **Invariant:** a revision's end is scanned from the section's PARSED END
  (`Section.end`), never from its offset. A cross-reference STREAM's payload is
  binary that may contain the bytes `%%EOF`, and scanning from the offset finds
  that and reports a truncated revision — measured at 391 bytes where 432 was
  right. **Note the fixture this needed:** `Save({ compressed: true })` emits a
  DEFLATED payload that happens never to contain the marker, so the obvious
  compressed test leaves the mutation GREEN; the case that pins it hand-builds
  an UNCOMPRESSED xref stream whose rows spell the marker, in two extra rows
  whose type bytes are neither 1 nor 2 so `readXrefStream` skips them.
  **Note:** the list is EMPTY rather than one-entry when the cross-reference
  structure had to be rebuilt — there the chain is precisely what could not be
  read, so empty says "we do not know" where `[one]` would claim "never
  updated". A document recovered only at the OBJECT level keeps its revisions,
  since its xref chain read fine. **objstm.ts** — object stream (`/ObjStm`) decoding.
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
  **Invariant (`909q`):** the `%PDF-x.y` header is `headerVersion()`'s answer —
  the catalog `/Version`, else 1.7 — in EVERY write path, the sign-on-save one
  included. It is threaded as a `ver` parameter rather than read inside each
  writer, because `serializeSignedDocument` and `serializeDocument` are separate
  entry points over the same five writers. `serializeClassicSigned` hardcoded
  `'%PDF-1.7'` until `909q`, so signing silently overwrote the document's own
  declared version. **Note which flow makes that reachable, since a hardcoded
  header sounds harmless:** `choosePath()` takes the full rewrite whenever the
  document is `modified`, and every `ConvertToPdfA` calls `markModified()` — so
  convert-then-sign is exactly the path that lands there, and it breached the
  version rule the conversion had just satisfied, in both directions (PDF/A-4
  demands 2.n, PDF/A-1 forbids anything above 1.4).
  **Invariant:** the header is inside the SIGNED byte range, so the version is
  chosen where the placeholder is laid out and never patched afterwards —
  patching it would move the digest out from under `/ByteRange`.
  **Note the deliberate asymmetry:** the INCREMENTAL signing path
  (`incremental.ts`) emits no header at all and must not, since an append may
  not rewrite a byte of its base — including a header that disagrees with the
  catalog. `test/sign-header-version.test.ts` asserts that from the other side,
  as a byte-identical prefix.
- **incrementaldelta.ts** — what an incremental update must write, relative to
  the document as opened: `diffObjects(baseline, live)` returning `replaced`,
  `added` and `freed` object numbers. A pure leaf over `types.js` and
  `serialize.js` — no `Document`, no `node:` import — so every rule is testable
  from hand-built maps with no PDF built.
  **Invariant:** the delta is decided by comparing CANONICAL SERIALIZATIONS,
  never by trusting a mutation report. `Page.Dict`, `Annotation.Dict` and
  `Field.Dict` are public live `Map`s, so `page.Dict.set('Rotate', 90)` mutates
  the document and reports nothing — no discipline at the 64 `markModified()`
  sites can close that while `Dict` is public. Equality is byte-equality of
  `serializeObject`'s output with BOTH sides through the same serializer:
  comparing against the original file bytes instead reports every object as
  changed, because the parse-serialize round trip is lossy in SPELLING (number
  formatting, string escaping, dict spacing) and faithful in content.
  **Invariant:** it fails in the SAFE direction. A dict whose keys were deleted
  and re-added serializes in a new order and is reported changed — verbose,
  never silent — where a dirty set that missed a mutation writes too little and
  the appended revision silently omits the edit. Same allowlist-not-denylist
  posture `content.ts`'s `NON_MARKING` takes, and it is asserted directly so it
  stays a decision rather than being "fixed" into a semantic comparison.
  **Note, measured, and it covers NOTHING — the obvious reading is wrong:**
  absence is tested with `Map.has` rather than by comparing `get` against
  `undefined`, on the reasoning that `null` is a valid `PdfObject` and would
  otherwise read as absent. That reasoning is FALSE and the mutation reddens
  nothing: `Map.get` returns `undefined` only for a key mapped to literal
  `undefined`, which `PdfObject` excludes, so the two forms provably cannot
  differ. The `has` form stays as the honest spelling of the question and as
  defence against an untyped caller, and the stored-null case stays asserted —
  but it is held by the TYPE, not by the suite. Do not cite it as covered.
  **Note, measured:** the other three mutations redden. Neutering the byte
  comparison reddens six cases across both consumers, and mark-sweeping the
  delta reddens exactly one — the orphan-retention case — which is what shows
  the reachability rule is pinned on its own rather than as a side effect.
  Hardcoding `incremental.ts`'s `prevGen` to 0 reddened NOTHING until
  `test/incremental.test.ts` grew `buildGen1Pdf`: every fixture in the suite
  sits at generation 0, where reading the previous xref and hardcoding 0 give
  the same answer, so the generation fix was unfalsifiable by construction.
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
- **imagedecode.ts** — stream-level image decoding: which codec an image
  XObject uses (`filterName`) and its decoded samples (`decodeImageStream`),
  moved VERBATIM out of `image.ts` by `72nc.5`. `ImageInfo.Filter` and
  `.Decode()` delegate here and are otherwise unchanged.
  **Invariant, and it is the whole reason the module exists:** it is a LEAF and
  must NOT import `image.js`. `ImageInfo.Save` delegates to `imagehref.ts`,
  while `imagehref.ts` and `imagergba.ts` each used to construct a throwaway
  `ImageInfo` purely to reach `.Width`/`.Filter`/`.Decode()` — so that method
  would have closed the codebase's FIRST import cycle, through two modules.
  **Measured, and it is why this was worth doing rather than shrugging at:** a
  sweep over every module in `src/` finds ZERO value-import 2-cycles, so one
  here would have been a genuine first rather than a style quibble, and
  `imageedit.ts`'s own invariant already records avoiding exactly this shape.
  The sweep is worth re-running before adding any edge back toward a facade:

  ```bash
  node -e 'const fs=require("fs");const f=fs.readdirSync("src").filter(x=>x.endsWith(".ts"));
  const m={};for(const a of f){const s=fs.readFileSync("src/"+a,"utf8");const t=new Set();
  for(const x of s.matchAll(/^import\s+(?!type\s)[\s\S]*?from\s+"\.\/([a-z0-9]+)\.js"/gm))t.add(x[1]+".ts");m[a]=t;}
  for(const a of f)for(const b of m[a])if(m[b]?.has(a)&&a<b)console.log("CYCLE",a,b);'
  ```

  **Note:** it is the same extraction `colornames.ts`, `preformat.ts`,
  `bordersides.ts`, `resprune.ts` and `datauri.ts` each already made — two
  consumers that must not reach each other through a third — and like those it
  keeps the ORIGINAL import path working, since `ImageInfo` still answers
  `.Decode()`.
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
  **Invariant (`zch2.11`):** an INLINE ATOMIC — an image among words — is a
  U+FFFC OBJECT REPLACEMENT CHARACTER in the concatenated text, which is what
  Unicode defines that character for. `LayoutRun` is a union and an atomic run
  contributes exactly one character, so `owner`, the unit builder, the UAX #14
  search, `piecesOf` and the remainder reconstruction all work UNCHANGED.
  `zch2.11`'s own issue predicted that all of those "need a non-text unit";
  they do not, and the prediction is recorded because acting on it would have
  been a rewrite. It also gets the CSS answer for free: U+FFFC is a non-space
  character, so `a<img>b` is one unbreakable word and `a <img> b` is three.
  **Invariant:** the placeholder NEVER reaches a `driver.encode` or a line's
  `text` — the segment mapper replaces it with `''` and carries the box on
  `LaidSegment.atomic`. A driver asked to encode it draws a glyph nobody asked
  for.
  **Invariant, and it was a live bug for one commit:** a separator space
  FOLLOWING an atomic is attributed to the nearest TEXT run, not to the
  atomic. `piecesOf` merges adjacent same-run pieces, so a space attributed to
  the atomic joined the atomic's own piece — whose text the segment mapper
  discards — and vanished from both the width and the page. `spaceRun` is the
  one owner of that rule, read by `spaceWidth` (which measures the space) and
  `piecesOf` (which emits it); two answers there is how a line comes to
  measure 10 where it draws 11.
  **Invariant:** an atomic wider than the box CLAMPS to the box width with the
  aspect preserved — the rule `flow.ts`'s `image()` already applies to a block
  image, so it is one rule and not two. It happens in `layoutRuns` because
  that is the only place that knows `boxWidth`, and the CLAMPED height is what
  the band must see. The parameter is `readonly` and the clamp binds a fresh
  array: `stamp.ts` reuses the same `ResolvedRun.layout` objects for
  `segmentBoxes` and the painter, so writing through would resize the image on
  every re-flow.
  **Note:** `LaidLine.maxFontSize` KEPT ITS NAME while gaining a second
  meaning — it is the line's ASCENT, which a baseline-aligned atomic's height
  can now set. Four modules read it and a rename is churn with no test behind
  it.
  **Invariant (`zch2.11`), and it is the finding the issue itself missed:**
  `buildRunBlockBody` emits NO per-segment `Td` — its own comment says "`Tj`
  advances the pen by the string's own width". An atomic emits no `Tj`, so
  without an explicit `[ -N ] TJ` kern the pen does not move and the text
  after an image OVERPRINTS it. `N = width * 1000 / fontSize` of the font in
  force, borrowed from the neighbouring run because an atomic has none; a
  block that OPENS with an atomic has set no `Tf` yet and falls back to the
  block size. The image itself cannot go inside `BT…ET` and draws through the
  existing `drawBuiltImage` — no refactor of `imageembed.ts` — appended after
  the text body, which is unobservable because an inline atomic's box never
  overlaps the glyphs it sits between.
  **Invariant:** atomics travel in a channel PARALLEL to `TextRun[]`
  (`TextBlockOptions.atomics`, `FlowParagraphOptions.atomics`), so
  `textdecor.ts`'s `TextRun` does NOT change and every existing consumer —
  `mdruns.ts`, `tableauthor.ts`, `flowtable.ts`, `docmodel.ts` — is
  byte-identical by construction rather than by test. `weaveAtomics` is shared
  by `flowTextBlock` and `measureTextBlock` for the reason they already share
  `resolveRuns`: a second weave is how a paragraph measures one way and paints
  another.
  **Invariant, and it is the trap:** `sliceContent` RE-BASES each remaining
  atomic's `beforeRun` onto the sliced run list, and `flow.ts`'s `TextElement`
  builds its continuation with `{ ...this.opts, atomics: remainderAtomics }`
  rather than `this.opts`. The originals index the ORIGINAL runs, so carrying
  them forward puts an image at the wrong place — or off the end, where it
  vanishes at a column break. `sliceRuns` was REPLACED rather than kept
  beside it: two remainder rebuilders is the drift this repo keeps recording.
  **Note, measured the hard way:** a fixture for that rule needs run 0 FULLY
  CONSUMED in the first column, so the remainder's list is shorter and the
  re-based index genuinely differs. Two earlier fixtures did not discriminate
  — one overflowed entirely (so the indices coincided) and one asserted
  `beforeRun <= remainder.length`, a BOUND the un-rebased index also
  satisfies. Both left the mutation green.
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
  **Invariant (`092q`):** `FlowListItem.atomics` is PER ITEM, because
  `beforeRun` indexes that item's own run list and nothing else. It cannot ride
  `bodyOptions`, which is keyed on the LIST — so `ListItemElement.bodyOpts()`
  is the single definition that keeps `measure` and `place` from drifting, for
  the same reason `bodyOptions` itself is one. **Measured load-bearing:** with
  a 20pt image inside an already-taller band the two agree whatever the code
  does, so the mutation reddened NOTHING until `test/flow-atomics.test.ts`
  grew a 60pt image in a 12pt block — the case where the line band genuinely
  has to grow.
  **Invariant (`092q`), and it is the same trap `TextElement` records:** a
  continuation is handed `remainderAtomics`, re-based onto the sliced run list
  by `sliceContent`, NEVER `this.atomics`. **Measured, and the fixture shape is
  load-bearing three ways:** it needs MANY STYLED RUNS EARLY so the first
  column consumes whole runs and the remainder's list is genuinely shorter (a
  single-run item cannot discriminate — `beforeRun` is the same small number
  either way), and the image must sit MID-TAIL with words after it, since an
  overshooting index lands a TRAILING image where it belonged anyway. Got
  right, the picture VANISHES under the mutation — zero draws across both
  pages.
  **Invariant (`092q`):** an item that is NOTHING but an image draws. Its run
  list is EMPTY, so the emptiness test is `drawsNothing()` — text empty AND no
  atomics — not `isEmptyFlowText` alone; read the latter way such an item gets
  no `/LI` and no `/LBody`, and since the marker is drawn only once the body
  has painted, no bullet either.
  Note the two placements are different features on one box: `AddFloatBox` is a
  *side* float (narrows the channel, needs floatstack's band bookkeeping),
  `AddFloatingBox` is *in-flow* (consumes the band outright, excludes nothing,
  and never splits — a callout broken across a column reads as a fault, and a
  box's border and background have no defined way to continue).
  **Invariant (`zch2.16`):** content taller than an EMPTY column renders rather
  than refusing the document. An image SCALES (`shrinkToFit`, implemented only
  by `ImageElement`, which is the one element type with an aspect ratio and no
  other meaning); anything else DRAWS PAST the column bottom. `Render` used to
  throw here, and `doc.AddHtml('<img …>')` reached it for any image whose own
  aspect exceeded the column's — measured at 1.548 on a default A4 flow, so a
  9:16 phone photo refused the whole document.
  **Invariant (`zch2.16`), and it is the one a single-element fixture cannot
  see:** the shrink is asked ONLY where the alternative is refusing the
  document — at a column start, or with nothing yet placed into a rect. A tall
  image near a column FOOT must move to the next column at full size; shrink at
  every `place()` and a picture's size depends on what precedes it.
  **Invariant (`zch2.16`):** a shrink is accepted only when the replacement
  actually FITS — the termination proof, since one still too tall would be
  asked again at the same column start forever. `zch2.15`'s "a tail is accepted
  only when something was painted" is the same shape. **Note, measured:** NO
  element in `src/` can violate it — `resolveSize`'s clamp guarantees the
  replacement fits and `ImageElement` is the only implementor — so dropping the
  guard reddened NOTHING until `test/flow-overtall.test.ts` grew a hand-built
  element whose `shrinkToFit` LIES. With the guard dropped that case HANGS,
  which is the failure the rule exists to prevent and is why it is a fixture
  rather than a comment.
  **Invariant (`zch2.16`):** the overflow budget is a large FINITE probe, never
  `Infinity`. `place` builds its rect from `availHeight` and `stamp.ts` refuses
  a non-finite rect, so `measure` at the probe reports the element's NATURAL
  height and that is what it is given — which also keeps the emitted rect tight
  rather than astronomically tall. The design said `Infinity`; it throws.
  **Invariant (`zch2.16`):** `ImageElement.resolveSize` clamps HEIGHT beside
  WIDTH, and the two live in ONE function because it answers "how big is this
  drawn" — a second site would let them disagree. `availHeight` defaults to
  Infinity, so `measure` and `place` are byte-identical to before and only
  `shrinkToFit` passes a budget.
  **Invariant (`zch2.16`):** `cssframe.ts`'s `BoxElement` FORWARDS
  `shrinkToFit`. `frameBoxes` wraps every non-float element, so without it the
  shrink never reaches the image inside and every HTML picture overflows where
  it should scale.
  **Note (`zch2.16`), a deliberate asymmetry:** `flowplace.ts` shrinks but
  never overflows. A rect has a real answer `Render` does not — `remainder` —
  so an unscalable element is handed back rather than drawn outside the box the
  caller asked for.
  **Invariant (`zch2.16`):** the engine learns NO HTML vocabulary. It holds a
  `FlowElement` and a `FloatContent`, never an `HtmlElement`, and
  `NotRendered.el` IS an `HtmlElement` — so `flow.ts` provably cannot build one
  of these records. `onCompromise` and `onDegraded` are bare callbacks and
  `cssflow.ts` closes over the element. `onCompromise` is the ONE non-readonly
  member of `FlowElement`, because the builders are shared with Markdown and
  hand-built flows and must not grow an HTML-shaped option.
  **Invariant (`zch2.16`), and BOTH halves were live bugs the plan did not
  foresee:** a compromise is attributed to the INNERMOST element that produced
  the flow element. `mapBox` RECURSES, so assigning `onCompromise`
  unconditionally lets each ancestor overwrite its children and every
  compromise in every document is reported against `<html>`; and `cssframe.ts`
  wraps every element, so a fresh wrapper arrives unclaimed at each ancestor
  and the same thing happens by a second route. `attribute` claims only an
  element nobody has claimed, and `BoxElement` forwards `onCompromise` to its
  inner element so that check reads THROUGH the frame. A lone image is
  attributed to the `<img>` rather than to the block that lowered it, since
  `imageElement` runs inside its CONTAINER's `mapBoxInner`. All three are
  mutation-checked.
  **Note (`zch2.16`), measured and NOT covered:** `cssflow.ts`'s `once`
  de-duplication reddens NOTHING, and the design's premise for it is wrong. It
  predicted "a retry after a column advance re-enters the float branch", but a
  float that does not fit is DEFERRED to the next column before it is ever
  offered a split, so the degrade is only ever reached with `atColumnStart`
  true — traced, for every filler length from 0 to 390 paragraphs — and the
  fall-through then always draws. Nothing can fire twice today. Retained
  because the rule is sound and one box must stay one record if that deferral
  ever changes; do not read the green suite as covering it.
  **Invariant (`zch2.16`):** `doc.AddHtml` and `page.AddHtml` return a FRESH
  `[...skipped, ...late]`; `flow.AddHtml`'s array is never appended to after it
  is handed back. A Flow caller uses `HtmlFlowOptions.onNotRendered`, which is
  the only channel that can fire at the right time when Add and Render are
  separate calls. **Note the mutation that tests this is not the obvious one:**
  making `document.ts` push into `skipped` reddens nothing, because that array
  is internal to the call. What is observable is `cssflow.ts` pushing a late
  record into `c.skipped` — the array `flow.AddHtml` already handed back —
  which reddens two cases.
  **Invariant (`zch2.16`):** `'overflow'` is its OWN construct, not a reuse of
  `'text'` — that name means a glyph the resolved face cannot draw and is
  shared with `svgdraw.ts`, while an overflowing block drew every character
  perfectly. `CONSTRUCTS` is 21.
  **Note (`zch2.16`), and it is what a fixture for the float degrade must get
  right:** since `zch2.15` a float that merely overflows a column SPLITS, and
  since this issue an over-tall image inside one simply SCALES — so reaching
  the degrade at all takes content that can neither fit nor fragment, such as a
  single unbreakable 900px line. The design's own float fixture was an
  over-tall image and reached nothing.
- **flowfloat.ts** — a CSS float as the flow engine sees it (`zch2.10`):
  `elementFloat`, a `FloatContent` over an ordinary `FlowElement[]` painted
  through `placeElements`, and `floatElement`, the wrapper element that carries
  the marker.
  **Invariant:** `FloatContent` has FOUR REQUIRED members — `width`, `spacing`,
  `measure()`, `paintAt()` — and `FloatingBox` satisfies every one UNEDITED.
  Since `zch2.15` there is one OPTIONAL fifth, `splitPaint`, which only
  `elementFloat` implements; `FloatingBox` declines it and keeps its documented
  refusal to split, so it is STILL edited not at all.
  That is what lets a CSS float join the existing float branch in `flow.ts`
  instead of adding a second one; a required edit to `FloatingBox` means the
  seam is wrong. `FloatItem.box` widened to it, and `floatOf` reads a float off
  either an explicit `FloatItem` or an element carrying `FlowElement.float`.
  **Invariant, and it is the nicest property here: DEGRADING IS FREE.** Because
  the marker rides ON a `FlowElement`, a float the engine declines to place is
  just an element with a marker it ignores — it places in flow by the ordinary
  path, frame and content intact, so there is no fallback rendering path to
  write. `degradeOnOverflow` is what selects it; `FloatingBox` sets nothing and
  keeps throwing, which is its documented contract.
  **Invariant:** `elementFloat` is INJECTED into `cssflow.ts` through
  `CssFlowOptions.makeFloat`, never constructed there. `placeElements` needs a
  `Document`; `FloatingBox` captures one at construction; `Page.doc` is PRIVATE
  and `paintAt` takes only a `Page` — so the adapter must capture one too, and
  `cssflow.ts` is a pure leaf that may not import `document.js`. The Document
  it captures MUST be the one the page belongs to: a throwaway one paints the
  float onto a page of a different document and its text never appears, which
  is exactly how `cssflow-report.test.ts`'s helper failed first.
  **Invariant:** a float box lowers to exactly ONE wrapper element. A marker on
  the first of several would leave the rest in the queue to be placed a second
  time.
  **Invariant, and `zch2.15`'s own issue predicted the opposite:** the wrapper
  DOES hold a group, and splitting did NOT force it to become a decorator over
  one child. The hazard "a container never holds and paginates its children"
  names a container with its OWN pagination loop; `placeElements` is not a
  second loop but the shared one, extracted in `zch2.5` so a caller can lay
  elements into ONE rect and get the overflow back, so a container that
  delegates to it is not what the rule forbids. The wrapper is unchanged.
  **Invariant (`zch2.15`):** a float splits ONLY when it cannot fit an EMPTY
  column. One that fits a column on its own still defers whole, which is what
  browsers do in paged media — push to the next fragmentainer, fragment only if
  it cannot. So splitting replaced the degrade path and moved nothing `zch2.10`
  shipped.
  **Invariant (`zch2.15`):** the excluded band comes from the height PAINTED,
  never from `measure()`. The engine discarded `paintAt`'s return value and
  after a split the two differ, so reading the measure narrows the channel past
  the column bottom for every element below. **Note the fixture, measured the
  hard way:** the body beside the float must OVERFLOW the painted band. A
  paragraph that fits inside it whole is indented on every line under BOTH
  readings, so the case measures nothing — the first version of it did exactly
  that and passed with the bug in place.
  **Invariant (`zch2.15`):** a tail is accepted only when something was
  PAINTED, which is the termination proof — every split consumes drawn content,
  so the tail is strictly shorter than what produced it. Content that cannot
  fragment at all reports `height: 0`, the call has had no effect, and the
  degrade is still clean.
  **Note (`zch2.15`), and it is a deliberate asymmetry:** `flowplace.ts` does
  NOT split. One rect has no next column, so a split head would paint and the
  tail would land in a `remainder` most callers of `page.AddHtml` never
  re-place — half a float drawn and the rest silently gone, strictly worse than
  degrading to in-flow, which draws everything. Pinned in
  `test/flowplace-floats.test.ts` so it reads as a decision.
  **Note, measured:** all SEVEN mutations aimed at `zch2.15` redden something,
  so nothing here rests on reasoning alone — which matters more than usual,
  because there is NO oracle: `test/fixtures/css-box/` sees used widths and
  collapsed gaps and nothing positional. Two are worth naming. Building the
  tail over the original `elements` rather than the REMAINDER does not fail, it
  HANGS — the tail is then the same content and the split never terminates.
  And giving `splitPaint` the measured height instead of the budget reddens
  five cases across three files, because it collapses `splitPaint` back into
  `paintAt`.
  **Invariant:** `measure()` and `paintAt()` run the same placement arithmetic
  (`measureElements` shares `placeElements`' gap rule), so the two agree by
  construction.
  **Invariant (`cssframe.ts`):** `frameBoxes` passes a float through UNWRAPPED.
  A float is out of flow, so the container's per-child frame slicing does not
  apply to it, and excluding it keeps the container's top and bottom insets on
  the elements actually in flow. Wrong, the wrapper SWALLOWS the marker and
  every float — nested in `body`, which is to say all of them — lays out in
  flow while reporting nothing. That was a live bug for one commit.
  **Invariant (`cssresolve.ts`):** CSS 2.1 §10.3.3 governs a block-level
  element IN NORMAL FLOW, so a float skips it entirely and uses §10.3.5:
  shrink-to-fit or stated width, and an `auto` margin is 0. Running §10.3.3 for
  a float reaches its over-constrained branch and hands `margin-right` the
  whole leftover column — 326pt for a 150px float in a 601px container, which
  is both an absurd excluded band and a NEGATIVE content width for the float's
  own contents, so it measures 0 and draws nothing. Nothing read those margins
  before `zch2.10`.
  **Note, measured:** all 11 mutations aimed at these rules redden something.
  Two needed their fixtures rebuilt first and are recorded because the first
  versions measured NOTHING. The shrink-to-fit case bounded the body's x
  loosely ("between 72 and 200"), which accepts both the shrunk float (90.4,
  beside it) and the full-width one (78, below it); it compares against a
  no-float baseline now. And `measureElements`' inter-element gaps are
  invisible to any single-paragraph float, so the fixture holds two paragraphs
  with stated spacing.
  **Note on the oracle, and it covers HALF:** `test/fixtures/css-box/` gained
  three float fixtures, so a float's stated WIDTH is browser-checked. Its
  shrink-to-fit width is NOT — that depends on font metrics, and Chrome renders
  the UA serif while the suite stubs Helvetica. Nor are its MARGINS: reverting
  the §10.3.5 fix above reddens NOTHING in that corpus and two cases in
  `test/css-float.test.ts`, because the corpus compares content widths and the
  bug was in margins. Placement is not observable through `getComputedStyle`
  at all.
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
  **Invariant (`zch2.10`):** `flowplace.ts` does band bookkeeping too, from the
  same pure `floatstack.ts` — `insetsAt` to narrow the channel, `nextBoundary`
  to cap an element beside a float, `pruneFloats`, `resolveFloatTop`. One rect
  makes it the SIMPLER half: there is no next column to carry to, so a float
  that does not fit is simply not floated and falls through to ordinary
  placement. Text beside a float RESUMES AT FULL WIDTH below the band — the
  remainder is re-queued at the boundary rather than ending the rect — which is
  what `page.AddHtml` needed to place floats at all, and `zch2.5`'s rule that
  the three entry points are one implementation is why it has them.
  **Invariant:** `measureElements` shares the place loop's gap rule
  (`spaceAfter + paragraphSpacing + spaceBefore`, dropped above the first), so
  a float cannot measure one way and paint another. It skips an element that
  measures 0 rather than spacing around it — "nothing to draw" since `zch2.13`,
  and charging a gap for it would leave a hole where an unencodable paragraph
  used to be.
  **Invariant (`zch2.13`):** `measure`'s `fits` means NOTHING IS LEFT OVER, and
  deliberately NOT "and something was drawn". Every producer wrote
  `remainder === null && usedHeight > 0`, which conflates *empty* with *did not
  fit here* — and only the second may mean retry, so an element with nothing to
  draw asked for a column it could not have and `flow.ts` threw
  `element does not fit in an empty column`. The everyday way in is a
  Standard-14 fallback face: `encodeWinAnsi` DROPS what it cannot encode, so an
  all-Cyrillic paragraph measures 0 wide, and `AddHtml('<p>При</p>')` refused
  the whole document. The fix must hold for a CHAIN — a `<div>` around a `<p>`
  is a `BoxElement` around a `BoxElement`, and `cssframe.ts` passes the inner
  verdict through, which is why fixing `TextElement` alone left it throwing.
  **Invariant:** the ONE consumer that genuinely wants "and drew something" is
  flow.ts's keep-with-next lookahead, which tests `usedHeight` itself. Measured
  load-bearing: without it an undrawable heading pushes the content under it to
  a second page.
  **Note, measured and NOT covered:** `CodeBlockElement.measure`'s half of the
  same rule reddens NOTHING. `<pre>` in the CSS stack is an ordinary block with
  `white-space: pre` (`preformat` in `cssinline.ts`), so nothing wraps a
  `CodeBlockElement` in anything that decides from `measure` — Markdown's
  `place` already handled the discard. Retained so `measure` and `place` agree,
  which is this module's own stated rule; do not read the green suite as
  covering it.
  **Note:** text dropped for want of a glyph is still ABSENT from `skipped`, so
  such a page comes out blank with nothing said. Tracked as `zch2.14`: the
  report vocabulary is `htmlreport.ts`'s while the loss reaches Markdown and
  hand-built flows equally.
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
  still contributes its text where it has any — a table, raw HTML, an
  unresolvable image. Visible content beats a silently dropped subtree, the rule
  `svgdraw.ts` already sets. `MdList.tight` is the one mapping input no HTML
  oracle can see, which is why the loose-versus-tight spacing is asserted on
  rendered heights.
  **Invariant (`z77w`), and it REVERSES what that list used to say:** an image
  AMONG WORDS is DRAWN, as a `FlowAtomic` on the line, where it used to be
  reported and flattened to its alt text. A LONE image in its own paragraph
  still takes the block-figure path — `loneImage` is untouched, exactly as
  `cssflow.ts` keeps its own lone path — so the two shapes stay different
  features rather than one.
  **Invariant:** the resolver is INJECTED (`RunContext.atomic`), the seam
  `cssinline.ts` takes for `resolveFamily`: resolving a destination needs the
  caller's `resolveImage`, and `mdruns.ts` must stay a pure leaf. It is asked
  exactly ONCE per image, which is why the fall-back-to-alt-text decision is
  made INSIDE the walk rather than by re-resolving afterwards — a descriptor
  emitted first and resolved later cannot splice the alt text back at the
  right run index without shifting every later `beforeRun`.
  **Invariant, and it is the rule that renders WRONGLY rather than failing:**
  an atomic is a MERGE BARRIER. It records the run index it sits BEFORE, so
  `push` drops its `lastKey` after one — let `a` and `b` in `a![](x)b` merge
  into a single run and the image claims to precede index 0, moving the
  picture to the front of the line, and precisely when the two texts are
  identically styled. `cssinline.ts` records the same rule.
  **Invariant:** the atomics channel is a property of the CALLER, not a rule
  repeated in `mdruns.ts` — and since `dsw8` EVERY block that can hold inline
  text passes a resolver: a paragraph, a heading, a list item and a table
  cell. `mdruns.ts` itself never changed across the three issues, which is
  what that invariant buys.
  **Note, and it is the sharpest instance in this repo of a STALE DOC COMMENT
  costing real work:** `dsw8` was filed asserting a cell's height was
  `max(1, lineCount) * leading`, a model that could not express a line an
  image made taller, and scoped as a replacement of the table height model.
  That was `measure`'s own doc comment; the CODE had already been summing
  per-line BANDS out of `layoutRuns`. The real change was plumbing, and the
  comment is now corrected in place. Read the code before believing a comment
  about the code.
  **Note:** an image in an item's leading paragraph is an ATOMIC on the item's
  line and is NOT lifted to a block figure the way a top-level paragraph's
  lone image is — a figure fills the column width, which inside a list item
  would tower over the marker beside it. An image in one of the item's FURTHER
  blocks needs nothing special: those go through `blockElements` and so
  through `paragraphElements`.
  **Invariant:** an inline image draws at **0.75pt per intrinsic PIXEL**, the
  96-dpi convention, so `![a](x)` and the `<img src=x>` `AddHtml` renders come
  out the same size. **Note this is NOT `cssflow.ts`'s CSS px → pt rule**,
  whose "here and nowhere else" is about the CSS px UNIT: Markdown has no CSS,
  and what converts here is an image's own pixel count — which `docxflow.ts`
  already reads the same way. Two rules sharing a constant are not one rule.
  A BLOCK figure is deliberately different and unchanged, `ImageElement`
  defaulting its width to the whole region.
  **Note, measured, and it covers NOTHING:** narrowing an empty atomics list
  to `undefined` before handing it to `paragraph()` is COSMETIC. Verified on
  emitted page bytes rather than inferred — `resolveAtomics([])` allocates no
  XObject and weaves nothing, so the two hash identically and the mutation
  reddens not one case. Retained as the clearer statement; do not cite the
  green suite as covering it.
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
- **htmltoken.ts**, **htmlcharref.ts** — the WHATWG HTML tokenizer
  (HTML Standard §13.2.5), a literal transcription: one branch per spec state,
  named as the spec names it, over a pull model (`next`/`setState`) that tree
  construction steers for RCDATA, RAWTEXT, script data and PLAINTEXT.
  `htmlcharref.ts` is the character-reference sub-machine, its own module
  because it is self-contained and returning offsets lets the caller turn them
  into columns with the cursor it already has. Note the direction against
  `htmlsemantic.ts` and `htmlfixed.ts`, which are PDF→HTML and share no code
  with this. Nothing here produces PDF, and nothing here is public API yet —
  `parseHtml` arrives with tree construction (`zch2.1.2`).
  **Invariant:** it NEVER throws. Every string is a valid HTML document — the
  spec mandates a recovery for every parse error by construction — so parse
  errors are values on `errors`, never control flow. This is `markdown.ts`'s
  rule and the exact opposite of `parseXml`, which throws `PdfParseError`; the
  contrast otherwise reads as an oversight and gets "fixed".
  **Invariant:** both are pure leaves. No `Document`, no PDF object, no `node:`
  import; they take a `string`. Character-encoding detection from bytes is a
  separate decision, tracked as `zch2.8`.
  **Invariant:** neither `xml.ts` nor `mdscan.ts` is reused, and the reasons are
  opposite. `parseXml` is one closure-based recursive descent that throws on a
  mismatched end tag, demands quoted attribute values and strips namespace
  prefixes — every rule the inverse of what HTML5 needs. `scanHtmlTag` is
  CommonMark's grammar, returns only an end index, and produces no name and no
  attributes; it also REJECTS inputs HTML5 accepts, on purpose. Two grammars
  sharing a name, as `tablegrid.ts` and `tablespan.ts` do.
  **Invariant:** the named character reference state matches BOTH spellings,
  which is why `gen-entities.mjs` now emits the 106 legacy names beside the
  2125-entry table. Measured against `entities.json`: every legacy name is ALSO
  a semicolon key with an identical value, so this is a SPELLING PERMISSION
  rather than a second table — `allowsMissingSemicolon` is a predicate and
  `namedEntity` still answers for every name. In an attribute a semicolon-less
  match followed by `=` or an alphanumeric is NOT replaced and the consumed
  text is flushed LITERALLY, so `?a=1&copy=2` keeps its query string while the
  same bytes in text give `©`. CommonMark reads the values and never the
  predicate, so its output cannot move; `test/commonmark-spec.test.ts`'s 652
  cases are that fence.
  **Invariant:** the longest-match scan CONTINUES past a name that is in the
  table but unusable here, rather than bailing out. `notin` is spelled only
  with its semicolon, so an unterminated `&notin` falls back to the legacy
  `&not` and yields `¬in`.
  **Invariant:** RCDATA resolves character references and RAWTEXT, script data
  and PLAINTEXT do not — one `case` label apart, and no rendering reveals the
  difference until a `<title>` shows the five literal characters `&amp;`. NUL
  likewise differs by content model rather than globally.
  **Invariant:** a non-matching end tag in a content model is not a tag at all:
  the buffered `</name` is emitted as CHARACTERS and the model resumes, which
  is what keeps a `</div>` inside a `<textarea>` visible.
  **Invariant:** §13.2.3.5's input-stream errors — a surrogate, a noncharacter,
  a non-whitespace control — belong to the INPUT STREAM and not to any state,
  so they are found in one pass up front and interleaved by source index. The
  ordering is load-bearing: `<!\u000B` expects the control error BEFORE markup
  declaration open's `incorrectly-opened-comment`, at the same column, because
  the character has entered the stream even though that state only PEEKED at
  it. Reporting them from `consume` instead put them the wrong way round and
  made a reconsumed character report twice.
  **Two position rules that read backwards, and both were asserted WRONGLY here
  before the vendored suite corrected them** — the sharpest evidence in this
  repo for why real-world fixtures exist, since both hand-written tests passed
  with both halves ours. Columns count UTF-16 CODE UNITS, so an astral
  character advances by two. And the two markup-declaration-open errors report
  at different ends of what they looked at: `cdata-in-html-content` at the LAST
  character of the `[CDATA[` it consumed (col 9), `incorrectly-opened-comment`
  at the one character it merely peeked (col 3).
  **Invariant (`zch2.9`):** `<?target data?>` is a PROCESSING INSTRUCTION, not
  a bogus comment. whatwg/html#12118 merged 2026-06-25, adding five states
  (§13.2.5.72-76) and DELETING
  `unexpected-question-mark-instead-of-tag-name` from the tag open state — so
  a `?` there now reports no parse error at all. A target may START with an
  ASCII alpha or U+005F, which is WIDER than the tag-name rule it otherwise
  mirrors, and continues with alphanumerics, `-` and `_`.
  **Invariant:** `xml` and `xml-stylesheet` are blocklisted, ANCHORED — a
  prefix test would refuse `xmlfoo`, which is a perfectly good target. They
  fall back to a bogus comment, as does a target that is not a name.
  **Invariant, and it is the detail the spec's own summary gets wrong:** every
  fallback KEEPS the leading `?` plus whatever the target consumed, so
  `<?xml version="1.0">` reads back as `<!-- ?xml version="1.0" -->`. Tag open
  swallowed that `?`, so `fallBackToComment` re-supplies it rather than
  reconsuming it. Dropping it yields a plausible comment and the wrong one;
  WPT pins it.
  **Invariant:** only `?>` closes — a lone `?` is data, which is the whole
  reason the "questionable" state exists — while a BARE `>` closes too, which
  is the bogus-comment behaviour this replaced and is why `<?t a>b` leaves `b`
  as text rather than swallowing the document.
  **Invariant:** at EOF the spec emits the EOF token and NEVER the buffer, so
  an unterminated `<?` leaves nothing at all — not a PI, and not the comment
  the old reading would have left. Both corpora agree on this from opposite
  sides.
  **Note on the oracle, and it is now SPLIT (`zch2.9`):** the tokenizer suite
  is `html5lib-tests/tokenizer`, the suite browser engines share — 6,995 of
  7,033 cases green, with the mutation results recorded in
  `test/fixtures/html5lib/PROVENANCE.md`. `xmlViolation.test` is excluded
  STRUCTURALLY, by its `xmlViolationTests` root key rather than by file name.
  The other 38 are excluded because that pin PREDATES #12118 and cannot be
  advanced — its newest commit IS ours, dated one day after the merge, with
  nothing since — so on `<?` we follow the WPT corpus, which postdates the
  change and whose 88 PI cases now all pass. Do NOT "fix" the 38 by reverting
  the tokenizer; that trades a maintained oracle for a dormant one.
- **htmlencoding.ts** — what encoding a sequence of HTML bytes is in
  (`zch2.8`): `bomEncoding`, `encodingFromLabel`, `metaEncoding`,
  `decodeHtmlBytes`. A pure leaf importing NOTHING — not even `htmldom.js` —
  so every rule is testable from byte arrays with no tree and no PDF. It never
  throws.
  **Invariant, and it is why this module is 80 lines rather than 800:** THE
  ENCODING STANDARD'S LABEL TABLE IS NOT TRANSCRIBED. `TextDecoder` already
  implements it — ~230 labels over ~40 encodings, whitespace stripped and case
  folded — so `new TextDecoder(label)` IS the "get an encoding" step and the
  decoder both, and `.encoding` is the canonical name. Measured rather than
  assumed: `cp1251`/`x-cp1251` → `windows-1251`, `ms_kanji` → `shift_jis`, and
  `iso-8859-1`/`us-ascii` → `windows-1252` — the standard's deliberate legacy
  aliases, not approximations. A second table is a second answer to "what does
  `cp1251` mean".
  **Note what that borrows:** `TextDecoder`'s legacy coverage is
  ICU-DEPENDENT. On a `small-icu` Node almost every legacy label is rejected,
  which reads here as an unknown label — the declaration is ignored and the
  current encoding stands. A degrade, never a throw, and the first
  environment-dependent behaviour in the library, so it is documented rather
  than left to be discovered.
  **Invariant:** a BOM is honoured AS IT STANDS while a META-derived UTF-16 is
  rewritten to UTF-8 (and `x-user-defined` to windows-1252). The two rewrites
  are §13.2.3.3's and belong to the meta path ALONE — applied to a BOM they
  decode a UTF-16 document to mojibake. Both directions are mutation-checked.
  **Invariant:** an invalid `charset` attribute FALLS THROUGH to
  `http-equiv`, because the in-head rule reads "charset, and getting an
  encoding returns an encoding, OTHERWISE http-equiv". A junk `charset` must
  not shadow a good declaration beside it.
  **Note:** the `content=` scan RESTARTS one character on rather than giving
  up when what follows `charset` is not `=`, so `charsetish; charset=koi8-r`
  still finds the real declaration.
  **Note:** the `replacement` encoding is unreachable — `TextDecoder` rejects
  its labels (`iso-2022-kr`, `hz-gb-2312`) outright — so they are declined and
  the current encoding stands, where the standard decodes the whole stream to
  one U+FFFD. The safer of two wrong answers.
- **htmldom.ts**, **htmlstack.ts**, **htmlforeign.ts**, **htmltree.ts** — HTML5
  tree construction
  (HTML Standard §13.2.6), the half that turns `htmltoken.ts`'s token stream
  into a node tree. `htmldom.ts` is the node model, `htmlstack.ts` the stack of
  open elements and the active formatting elements, `htmlforeign.ts` the SVG
  and MathML adjustment tables and integration-point predicates, `htmltree.ts`
  all 21 insertion modes §13.2.6.4 defines, plus the adoption agency, foster
  parenting and implied end tags. Note the direction against `htmlsemantic.ts`, which is
  PDF→HTML. Nothing here produces PDF. `parseHtml` IS public API as of
  `zch2.1.3.3`, which withheld it no longer; `parseHtmlFragment` deliberately
  is not.
  **Invariant:** all four are pure leaves and none throws — `htmlstack.ts` in
  particular must not import `htmltree.ts`, which is what keeps every scope
  predicate assertable from a hand-built element list.
  **Invariant:** `htmlforeign.ts` holds DATA and PREDICATES only, importing
  `htmldom.js` for types and nothing else. The token RULES stay in
  `htmltree.ts`, because they insert elements, pop the stack and reconstruct
  formatting; moving them out needs either a wide seam of injected callbacks or
  an import back that closes a cycle. Its five tables carry asserted SIZES (37,
  58, 1, 11, 44), so a half-transcribed table is a red build rather than a
  silently mis-cased element that still renders. Three rows read like typos and
  are not: MathML's table has exactly ONE entry, `xmlns` is the one foreign
  attribute whose key equals its value because it has no prefix, and the SVG
  integration points are the ADJUSTED spellings, since that is what the element
  carries by the time the predicate is asked.
  **Invariant:** an adjusted foreign attribute is stored under its html5lib
  DISPLAY key — `xlink:href` becomes `xlink href`. Sound rather than
  convenient: whitespace terminates an attribute name in the tokenizer, so no
  document can produce a literal key that collides, and the serializer's
  existing sort then already produces the corpus's order.
  **Invariant:** `special` and the four scope terminator lists key on
  `(ns, name)`, never a bare name. An SVG `title` terminates a scope and so
  does an HTML `<title>` — but MathML `mi` does and an HTML `<mi>` does not, so
  a name-only test is wrong in BOTH directions. What it breaks is the adoption
  agency's choice of furthest block: a mis-nested tree that still renders.
  **Note, measured, and thinner than the others:** that rule is held by ONE
  vendored case (`adoption01`) plus the unit assertions — a document has to
  mis-nest formatting ACROSS a foreign boundary to expose it. Do not read the
  wide margins on the neighbouring rules as covering this one.
  **Invariant:** every "pop until an element with this tag name" means an HTML
  ELEMENT with that tag name — `popUntilName`, `popUntilOneOf`, both
  implied-end-tag walks, the `li` and `dd`/`dt` scans, "any other end tag" and
  the adoption agency's first test. `<td><svg><td>` puts an SVG `td` above the
  HTML one, so a name-only match stops at the wrong element and strands the
  entire SVG subtree on the stack. The design and the plan for `zch2.1.3.1`
  both missed this and ONE vendored case caught it, which is what
  `namespace-sensitivity.dat` exists for.
  **Invariant:** an element created in foreign content takes the ADJUSTED
  CURRENT NODE's namespace, never one derived from its own name. That is what
  puts `<g>` in SVG with no table of SVG element names, and an unknown element
  inside `<math>` in MathML.
  **Invariant:** the tokenizer's `adjustedCurrentNodeIsForeign` is a CALLBACK
  asked at the moment `<![CDATA[` is seen, never a flag kept in sync. The stack
  changes between tokens, so a cached answer is right until a `<svg>` opens
  mid-stream — exactly the document it exists for. Its default is `() => false`,
  which is what holds the 7,032 tokenizer cases still.
  **Note:** the self-closing flag is read in foreign content and nowhere else.
  `zch2.1.2` ignored it entirely and was right to — no HTML element's parsing
  depends on it — but `<svg/>` is an empty element while `<svg>` swallows the
  rest of the document.
  **Note:** a NUL in foreign content is inserted as U+FFFD, where "in body"
  ignores it. One `case` label apart, and no rendering reveals the difference
  until a document carries one; all 9 cases that cover it are in
  `plain-text-unsafe.dat`.
  **Note:** the foreign end-tag walk tests "is this the topmost element"
  BEFORE the name match, which is not the obvious order and means an end tag
  naming the bottom of the stack returns rather than popping it.
  **Invariant:** a template's children live in its `content` FRAGMENT, never
  among its own children, and the fragment is a real node rather than a second
  array. A template's content is not part of the document — CSS must not match
  into it and `zch2.2`'s traversal must not walk it — so a separate node makes
  that structural rather than a rule every consumer has to remember, and it
  gives `appendChild`/`removeChild` a real parent to point at. `content` is
  ABSENT rather than empty on every other element. `HtmlChild` deliberately
  does NOT include it: a fragment is never anybody's child, exactly as a
  document is not.
  **Invariant:** foster parenting searches for the last TEMPLATE OR TABLE on
  the stack, not the last table, and accepts a FRAGMENT as that element's
  parent — which is what it is whenever the table was opened inside a
  template. The first half was a live bug from `zch2.1.2` until `zch2.1.3.2`
  made it reachable; without the second, text fosters to the END of a
  template's content instead of before the table.
  **Invariant:** "original insertion mode" is ONE variable but the TEMPLATE
  insertion mode is a STACK, and the difference is real: a template can nest
  inside a table cell inside another template, and each level has to remember
  what it was doing. Measured at 13 vendored cases.
  **Invariant:** IN-BODY's end-of-file consults the template insertion-mode
  stack — the only place outside "in template" that does, and the whole reason
  an unclosed `<template>` still gets a `<body>`. "In template" redirects
  nearly every start tag to "in body", so by EOF the insertion mode is usually
  `InBody` and without this clause the template unwind never runs. 20 cases.
  **Invariant:** in-body's `<html>` and `<body>` start tags IGNORE the token
  outright when a template is open, rather than merging attributes onto the
  element — `<template><html b=c>` would otherwise write `b="c"` onto the real
  `html` element. `<frameset>`'s prose mentions templates too but needs no
  guard: `<template>` sets frameset-ok to "not ok", which already refuses it.
  **Note:** with `InTemplate`, `htmltree.ts` implements all 21 modes
  §13.2.6.4 defines, and `generateImpliedEndTagsThoroughly` — which shipped
  unreached in `zch2.1.2` — has its one and only caller in `</template>`.
  **Note, measured, and it covers NOTHING:** swapping that thorough call for
  the ordinary variant reddens **zero** vendored cases. The thorough list's
  extra names are the table-section tags, and no case has one open when a
  `</template>` arrives, so the rule is held by the spec alone. This is a
  DIFFERENT claim from `zch2.1.2`'s measurement that using the thorough list
  *everywhere* reddens 83 cases — that one is covered, this one is not.
  **Note on two spec branches deliberately absent:** the `<template>` start
  tag is fourteen steps, eleven of them DECLARATIVE SHADOW DOM, gated on a
  parser flag that is false for anything that is not a browser — and the
  spec's own first sub-step then says "insert an HTML element for the token
  and return", which is the collapsed form written here. `</template>`'s
  INSERTION-TARGET unwind is null unless something reads a template's `for`
  attribute, and nothing does. Both measured unreachable: the corpus contains
  zero cases mentioning either. Neither gets a flag or a stub.
  **Invariant:** `adjustedCurrentNode` is the fragment CONTEXT element when the
  stack of open elements holds exactly one, and the current node otherwise. It
  returned the current node from `zch2.1.3.1` until `zch2.1.3.3`, named
  correctly on purpose so fragments would not have to find its call sites.
  **Note, measured:** only **20** cases can tell the two apart, not the 67 that
  have a foreign context — for most of them the first token pushes an element
  before anything consults the adjusted node, after which the two agree.
  `foreign-fragment.dat` is where the distinction actually lives.
  **Invariant:** the fragment context element is NEVER pushed onto the stack of
  open elements — the synthetic `html` root is the whole stack. That is what
  makes the context's own end tag close nothing, which
  `foreign-fragment.dat#4` asserts directly.
  **Invariant:** there are exactly FOUR "fragment context element is" guards in
  §13.2.6 that apply here, and missing any one is silent. `resetInsertionMode`
  substitutes the context at the bottom of the stack — measured the widest at
  194 cases, because it decides the STARTING insertion mode for every fragment
  parse, not just the table contexts. In-body's `<input>` and `<select>` ignore
  the token outright when the context is a `select`. After-body's `</html>`
  IGNORES the token rather than switching to "after after body" — switching
  sends the comment that follows to the Document, which a fragment never
  serializes. And in-frameset's `</frameset>` never leaves the mode, since
  there is no outer document for "after frameset" to be after.
  **Invariant:** `parseHtml(src): HtmlDocument` is the whole public surface,
  and `parseHtmlFragment` is implemented, fully tested and NOT exported —
  nothing in this epic can call it, since `zch2.5`'s entry points take a PDF
  target rather than an HTML element and so have no context to pass. The
  mutation helpers stay internal for the same class of reason: exporting them
  would commit this library to a DOM-editing API before anyone has asked for
  one. `test/html-public-api.test.ts` asserts the absences BY NAME, so they are
  a decision the suite enforces rather than an oversight.
  **Invariant (`zch2.8`):** `parseHtmlBytes` is a SIBLING of `parseHtml`, not a
  widening of it. `parseHtml(string)` is what 8,862 vendored cases anchor and
  it must not move — which is exactly what `TreeBuilder.tentativeEncoding`
  guarantees: the in-head `<meta>` rule fires only for a parse that HAS one,
  and `parseHtml` never sets one, so the string path is byte-identical BY
  CONSTRUCTION rather than by test. Measured load-bearing: dropping that guard
  reddens 18 corpus cases.
  **Invariant:** there is NO PRESCAN, and that is a decision rather than an
  omission. HTML's prescan is an optimization for a STREAMING parser — it lets
  a browser tokenize before it has seen a `<meta>`, and gives up after 1024
  bytes. With the whole buffer in hand, tree construction's own
  change-the-encoding rule reaches the same answer for every document, and
  reaches it for a `<meta>` PAST that window, which a browser misses. A
  divergence in mechanism that converges in result.
  **Invariant:** the first pass finds that `<meta>` because tags and attribute
  names are ASCII and UTF-8's decoder is NON-FATAL — a windows-1251 body
  decodes to U+FFFD noise around perfectly intact tag structure. Nothing about
  the restart works without that.
  **Invariant:** AT MOST ONE restart, and it is a PROOF rather than a limit:
  the second pass runs with certain confidence (no `tentativeEncoding`), so
  the rule cannot fire again. Relatedly, a `<meta>` naming the encoding
  already in force SETTLES the confidence rather than merely changing nothing
  — without that a following, contradicting `<meta>` restarts a parse the
  first had already vouched for.
  **Note:** the one insertion site (`inHead`'s `<meta>` case) covers every
  mode, because "after head", "in body" and "in template" all redirect there.
  §13.2.6.4.7 spells that out for `<meta>`, so a body `<meta>` DOES change the
  encoding — the obvious reading, that the rule lives in head and a body meta
  is too late, is wrong, and this repo's own test asserted it that way before
  the spec corrected it.
  **Note on coverage:** BOTH vendored corpora are string-level by
  construction and cover none of this. The one case that could discriminate —
  `tests19.dat`'s 300-byte comment pushing `<meta charset>` past 1024 bytes —
  is a TREE test asserting only where the element lands. Held by
  `test/html-encoding.test.ts` and `test/html-parse-bytes.test.ts` alone.
  **Invariant:** `parseHtml` returns the tree alone, never a result object with
  an error list. Every HTML string is a valid document by construction, so a
  parse error is never actionable for a caller rendering a PDF; the list a
  caller CAN act on is `zch2.7`'s "what could not be rendered". Widening a
  return type later is additive, narrowing is not.
  **Note, and BOTH reddened nothing:** §13.4's form-element-pointer walk is
  unreachable — a `.dat` context element is synthesized with no ancestors, so
  it always finds nothing, which was known before the mutation was run. And
  the template-context push is redundant for the only case that could exercise
  it: `template.dat#108` is the corpus's single `template` context and its
  input opens its OWN `<template>`, which pushes the mode through the in-head
  rule regardless. Both are held by the spec, not by this suite.
  **Invariant:** `htmldom.ts`'s `appendChild` and `insertBefore` DETACH from the
  current parent first. The adoption agency moves live nodes, and a node
  reachable from two parents is a cycle that hangs the serializer rather than
  failing an assertion.
  **Invariant:** TWENTY insertion modes and FOUR scopes, not the 22 and 5 that
  `zch2.1.2`'s design and plan both named. The HTML Standard has REMOVED "in
  select" and "in select in table" (the customizable-select change): §13.2.6.4
  runs .1 to .21, a `<select>`'s content is parsed by "in body" — which grew
  `select`/`option`/`optgroup` clauses and a `select`-in-scope test on `<hr>`
  and `<input>` — and `select` has moved into the DEFAULT scope's terminator
  list, a reversal, since select scope used to be *inverted*. Seventeen
  vendored cases fail against the older reading, which is what settled it. The
  block END-tag list is still not the start-tag list: it adds `button`,
  `listing`, `pre` and now `select`.
  **Invariant:** foster parenting inserts BEFORE the table, never into it.
  Wrong, stray content lands inside the table and still displays — measured, 73
  vendored cases.
  **Invariant:** "original insertion mode" is ONE variable, not a stack, and
  this is held by the SPEC rather than by the suite: making it a stack reddens
  **nothing**, across all 1,317 cases. Recorded as an uncovered rule rather
  than left to be discovered.
  **Note, measured:** the thorough variant of implied end tags is unreachable
  today — `</template>` is its only spec call site and templates are
  `zch2.1.3` — but the pair ships anyway, because using the thorough list for
  both reddens 83 cases.
  **Note on the oracle, and it is NOT html5lib-tests:** anchored by
  web-platform-tests' `html/syntax/parsing/resources`, because html5lib-tests
  no longer carries tree-construction at all — its README records that the
  tests "are now solely maintained on web-platform-tests". Vendored under
  `test/fixtures/wpt/`, a separate directory because these fixtures are named
  for who produced the bytes. 1,918 of 1,936 cases run; the rest are scripted
  (the flag is off) or `<selectedcontent>` (whose expected tree holds text the
  ELEMENT clones in, not the parser). That last exclusion is PERMANENT rather
  than a gap: `4h3p` closed on the finding that the RENDER already agrees —
  `selectedOptionText` implements the same selected-else-first rule the four
  cases turn on, so all four draw what Chrome shows, and only emphasis inside
  a customizable-select is flattened. Pinned in
  `test/htmlreport-render.test.ts`, since the corpus provably cannot report a
  regression in behaviour it excludes. Every exclusion is a COMPUTED
  predicate over the case, never a file list, and the bucket counts are
  asserted — so a case cannot be reclassified to dodge a failure.
  **Note (`zch2.9`), and it is the only bucket retired because the SPEC moved
  rather than because we implemented more:** the 88 processing-instruction
  cases used to be excluded, on the reading that the two vendored corpora were
  pinned to different spec eras. Confirmed and acted on — whatwg/html#12118
  merged 2026-06-25 — so `<?target data?>` is a real PI, all 88 run, and the
  DISAGREEMENT MOVED to the html5lib tokenizer corpus, where 38 cases are now
  excluded instead. That pin cannot be advanced: its newest commit IS ours,
  dated one day after the merge, with nothing since.
- **csstoken.ts**, **cssparse.ts** — CSS Syntax Level 3: the tokenizer (§4)
  and the component-value parser (§5). `csstoken.ts` is a pure
  `string → CssToken[]` function that knows nothing of blocks or rules;
  `cssparse.ts` is eight entry points over those tokens and never re-reads a
  character. Note the direction against `svgcss.ts`, which is a much smaller
  CSS subset for SVG `<style>` elements and shares no code with this.
  Nothing here produces PDF and nothing is exported from `index.ts`.
  **Invariant:** both are pure leaves and neither throws — no `Document`, no
  PDF object, no `node:` import, and no `htmldom.js`. String in, structure
  out. Collecting `<style>` element text is a walk over `HtmlElement` and so
  `zch2.2.3`'s, deliberately not here; the issue text originally put it in
  this module and was corrected before any code was written.
  **Invariant:** the tokenizer emits FLAT `function`, `open` and `close`
  tokens and nesting is built in `cssparse.ts`. That is what lets `tokenize`
  stay a pure `string → CssToken[]` with no recursion — and it obliges the
  parser: NO `open` or `close` token ever reaches parser output. A matched
  pair becomes a block or a function; an unmatched close becomes an error
  value.
  **Invariant:** a number carries its REPRESENTATION and a type flag beside
  its value. `1` and `1.0` have equal values and differ only in the flag;
  `+1` and `1` differ only in the representation. Measured: forcing the flag
  reddens 10 cases and replacing the representation reddens 14.
  **Invariant:** NEGATIVE ZERO is normalised to `+0`. `Number('-0')` is `-0`
  and the corpus expects `+0` — and the difference is INVISIBLE to every
  ordinary check, because `JSON.stringify` renders both as `"0"` while a
  deep-equality assertion uses `Object.is` and fails. It is the only rule here
  with no hand-built cover, held by 4 corpus cases alone.
  **Invariant:** `url(` is a url-token whose value runs to the closing paren
  with no quoting, while `url (` is an ident then a function and `url("a")` is
  a function too. A tokenizer that treats `url` as a name everywhere produces
  a plausible token stream that is wrong for every unquoted URL.
  **Invariant:** the four EOF-and-damage kinds are distinct and none may
  collapse into a good token. `bad-string` ends at the newline that broke it
  and DISCARDS what it had; `bad-url` consumes to the closing paren and
  discards too; but `eof-in-string` and `eof-in-url` emit the SALVAGED VALUE
  and then the error — `'eof` is `["string","eof"]` followed by
  `eof-in-string`. The hand-built test asserted that backwards and the corpus
  corrected it.
  **Invariant:** a TRAILING BACKSLASH is a valid escape. The rule is "a
  backslash whose next code point is not a newline", and EOF is not a
  newline, so it yields U+FFFD inside the name being consumed rather than
  ending the name and leaving a delim. Requiring a following character reddens
  four cases.
  **Invariant:** U+007F is in the non-printable set that makes a `bad-url`,
  and it is invisible in every view of the corpus: `JSON.stringify` escapes
  control points below U+0020 and leaves DEL raw, so `url(<DEL>)` reads on
  screen as the perfectly valid `url()`.
  **Invariant:** `parseBlocksContents` is NOT `parseDeclarationList` under
  another name. A run beginning with an ident may be a declaration or a
  qualified rule — `a:hover { }` opens exactly like a declaration — and a
  qualified rule ENDS at its block, so `a b{c:d}e:f` is a rule followed by a
  declaration. The choice is made from the delimited run, never by rewinding
  the cursor: rewinding re-consumes past the `;` that ended the run and loses
  everything after it.
  **Invariant, and it is a DECISION rather than an oversight:** the tokenizer
  implements the CORPUS's spec era, not the current editor's draft. It emits
  `unicode-range`, the five match tokens (`~=` `|=` `^=` `$=` `*=`) and the
  column token (`||`), all of which the live draft has removed from the
  tokenizer. Eleven of the 149 vendored cases turn on it. It keeps the corpus
  running whole with no bucket; `zch2.9` already records this repo following a
  pinned oracle against a newer spec; and it hands `zch2.2.2` an attribute
  selector as one `^=` token rather than two delims to rejoin. Two mutations
  exist so that "fixing" it toward the live draft reddens immediately, at 3
  and 10 cases.
  **Note on the oracle, and on its LIMITS:** anchored by CourtBouillon's
  `css-parsing-tests`, 149 cases across 8 files, all green with no allowlist.
  That is a real anchor and it is an order of magnitude smaller than the HTML
  corpora — 7,032 tokenizer cases and 1,936 tree-construction cases. It turned
  out to be DENSE rather than thin: every one of eleven mutations reddened
  something, where `zch2.1` produced four empty results across four issues,
  because 50 of the 149 cases pack dozens of tokens into a single input.
  **Note, and it is the thing to remember when the sibling lands:**
  `zch2.2.2` (selectors) and `zch2.2.3` (the cascade) have no VENDORED oracle
  at all. WPT ships reftests and `testharness.js` there, both needing a
  renderer or a JavaScript engine. This note used to say their suites are
  therefore hand-built and must not be read as conformance — half of that has
  since been overtaken: `zch2.2.2` GENERATES one instead, by driving headless
  Chrome (`scripts/gen-selector-goldens.ts`), which is `test/fixtures/svg/`'s
  arrangement and is real evidence. It corrected two rules on its first run.
  `zch2.2.3` remains hand-built until someone does the same for it.
- **cssselect.ts** — CSS selectors: parsing, matching and specificity
  (Selectors Level 4). Takes a qualified rule's prelude as `CssValue[]` and
  never re-reads a character; matches right-to-left over `htmldom.ts`'s parent
  pointers, which is what those pointers were landed for. Nothing here
  produces PDF and nothing is exported from `index.ts` — `zch2.2.3` is the
  only consumer.
  **Invariant:** a pure leaf, and it must NOT import `svgcss.ts`. That module
  is a selector engine too and the two share NO code, on purpose: it takes a
  raw STRING and finds selectors with regexes (it predates any CSS tokenizer
  here), it walks `XmlNode`, which has no parent pointers, so its matcher
  threads an explicit ancestors array, and SVG is case-sensitive XML where
  HTML is not. Six SVG modules and a browser-rendered golden set depend on it.
  Two grammars sharing a name — the `tablegrid.ts`/`tablespan.ts` and
  `mdscan.ts`/`htmltoken.ts` idiom.
  **Invariant:** it never throws. An unsupported selector is a `null` return
  and the caller drops the RULE — which is CSS's own behaviour, not a
  degradation we invented — and ONE invalid selector invalidates the WHOLE
  list, because the surviving half of a partly-applied rule is
  indistinguishable from a correct render. That rule is what makes the two
  entries below matter rather than being pedantry: anything wrongly called
  invalid costs its whole stylesheet rule.
  **Invariant:** a dynamic pseudo-class (`:hover`, `:visited`, `:target`, …)
  is KNOWN AND NEVER MATCHES, which is not the same as unsupported. Unknown
  invalidates the list, so `a, a:hover { color: blue }` would drop its `a`
  half and the document render unstyled rather than merely un-hovered.
  `:link` is the exception and DOES match: an `href` is a fact about the
  document rather than about a pointer. **Note, measured:** Blink's answer for
  `a:hover` alone is also "matches nothing", so the corpus cannot see this —
  only the shared-list case in `test/cssselect-logical.test.ts` can, and it is
  the sharper half of the mutation, reddening three cases there while the
  `a:hover`-alone case stays green.
  **Invariant:** `Compound.ids` is a LIST, mirroring `classes`, and EVERY id
  must match. `#a#b` is valid CSS that matches nothing — the grammar admits
  it and an element has one id — so rejecting a second id turns a
  never-matching selector into an INVALID one, and by the rule above `p, #a#b`
  then loses its `p` half. Keeping only the first id instead is WORSE than
  that rejection: `#x#other` would match `<p id=x>` and render wrongly rather
  than not at all. All three halves are pinned separately, and the middle one
  by Blink as well.
  **Invariant:** a pseudo-element is parsed and RECORDED on the compound, and
  matches no real element. That is what lets `zch2.3`/`zch2.4` pick up
  generated content without re-parsing, and it keeps a `::before` rule from
  invalidating a list it shares.
  **Invariant:** specificity is a TUPLE compared lexicographically, not
  `svgcss.ts`'s packed `a*10000 + b*100 + c`. Packing needs a documented
  no-carry bound; a tuple needs none, and `:is()`'s "maximum of its arguments"
  is then a plain lexicographic max rather than a claim about the packing
  preserving order. `:where()` contributes NOTHING whatever its arguments, and
  `:is()`/`:not()` take a MAXIMUM rather than a sum — both produce a
  perfectly plausible cascade when wrong.
  **Invariant, and the OBVIOUS READING IS WRONG — this is the one to
  remember:** a type name folds ASCII case against EVERY element, foreign ones
  included. The natural rule, which this issue's design and its implementation
  plan both stated and which three hand-written tests here asserted, is that
  folding is for HTML elements while a foreign one is compared exactly, so
  `lineargradient` would not match SVG `<linearGradient>`. That is XML's rule.
  In an HTML document Blink matches `linearGradient`, `lineargradient` and
  `LINEARGRADIENT` alike — through `querySelectorAll`, `Element.matches` AND
  the stylesheet cascade — while `clippath` still misses, so it is genuinely
  folding rather than a wildcard; the same probe against an `application/xml`
  document matches only the exact spelling. `parseHtml` produces nothing but
  HTML documents, so one folded spelling is the whole model and the second
  field a first attempt added for this was deleted again. An attribute NAME
  folds while its VALUE does not, and `#id` and `.class` fold only in QUIRKS
  mode — `HtmlDocument.quirks` is computed by `htmltree.ts` from §13.2.6.4.1
  and, before this module, was read by exactly one line of parsing logic.
  **Invariant:** `^=`, `$=` and `*=` never match an EMPTY value. Without the
  guard `[href^=""]` matches every element that has an `href`, which reads as
  a working selector rather than a fault.
  **Note, and it is the trap this module was hardest to get right:** four
  An+B forms are a SINGLE token, because `n-1` is a valid CSS name. `2n-1` is
  a dimension whose UNIT is `n-1`, not a dimension followed by a number, and
  `n-1` is one ident. A parser written from the obvious reading handles
  `2n+1` and mis-handles `2n-1` — which is `odd` shifted by one, so a striped
  table still looks striped and only the first row is wrong.
  **Note:** the template boundary needs NO special case. `htmltree.ts`
  assigns `el.content = createFragment()` and `createFragment` leaves
  `parent` null, so the chain from an element inside a template runs element →
  fragment → `null` and never reaches the document; `selectAll` declines to
  descend on the way down. Structural in both directions, which is a property
  of two files agreeing rather than of one line, so it is asserted directly.
  **Note on the oracle, and it is GENERATED rather than vendored:** there is
  no data-driven selector corpus to vendor — WPT ships reftests and
  `testharness.js`, both needing a renderer or a JavaScript engine. So
  `scripts/gen-selector-goldens.ts` drives headless Chrome and commits what it
  said, the way `test/fixtures/svg/` already works, and cheaply, because a
  selector's answer is a list of elements rather than a bitmap. Two golden
  kinds: 549 match sets from `querySelectorAll`, and 6 specificity CONTESTS
  resolved by `getComputedStyle`, which is the only way to observe a number no
  API reports. It corrected TWO rules on its first run — the type-name fold
  above, and a contest of its own that measured which rule APPLIED rather than
  which was more specific, since `:not(#t)` cannot match `<p id=t>` at all;
  the generator now requires `el.matches()` for both selectors before
  recording one. `test/fixtures/css-selectors/PROVENANCE.md` records the
  ceiling — one engine with no second to arbitrate, a child-index path
  computed on both sides (which is why the harness carries a
  deliberate-mismatch test), and four rules it provably cannot see, each
  measured by mutation and each naming the unit test that holds it instead.
  **Note, measured:** all fourteen mutations run against this module reddened
  something, so nothing here is held by the spec alone. Three are corpus-blind
  and say so in PROVENANCE: summing `:is()`'s arguments, descending into
  template content, and counting an attribute selector as a type — that last
  one because a contest is a one-sided bound, so a mutation that collapses a
  real difference into a TIE still satisfies it.
  **Invariant (`zch2.2.4`):** a `:has()` argument is a RELATIVE selector, and
  it is stored as an ordinary `ComplexSelector` with the anchor PREPENDED —
  `:has(> div p)` becomes `:scope > div p`, `parts[0]` being a synthetic
  compound holding the one `Pseudo` kind no author can write. That is the
  whole trick: the existing right-to-left `matchFrom` then does the anchoring,
  backtracking included, and this module gains no second matching algorithm.
  The plausible alternative — "does some descendant match `div p`" — is WRONG
  and reports every div with a `p` anywhere below it rather than one whose own
  CHILD div holds the `p`; `div:has(> div p)` on a two-deep chain is the case
  that separates them, and it is in the Blink corpus.
  **Invariant:** the anchor weighs `[0, 0, 0]`. Selectors 4 counts a `:has()`
  as its most specific ARGUMENT — it joins `:is()`/`:not()` in the max group —
  and the implicit `:scope` is not part of what the author wrote. Left to the
  default branch it weighs a phantom class, making `div:has(> p)` report
  `[0, 1, 2]` for `[0, 0, 2]`: a plausible number, and one a Blink contest
  catches by itself, since `[0, 0, 2]` LOSES to `.c` where `[0, 1, 2]` wins.
  **Invariant:** `:has()` is NON-forgiving, and a nested `:has()` or a
  pseudo-element inside one is refused — which invalidates the whole list, as
  every other refusal here does. That is the CURRENT reading: Selectors 4
  changed `:has()` from a forgiving argument list after the forgiving one
  broke feature detection, and Blink agrees — measured, it refuses
  `div:has(p:has(span))` on all 11 corpus documents. The `inHas` flag rides
  through `:is()`/`:not()`/`:where()`, so `:has(:is(p:has(x)))` is refused by
  the same rule rather than by a second one.
  **Note on the cost, MEASURED and left unguarded:** the driver is nesting
  DEPTH, not the element count, and it is worse than the quadratic `zch2.2.2`
  predicted. `csscascade.ts` asks every rule about every element, a `:has()`
  walks the anchor's subtree, and each candidate's match then walks back UP
  the ancestor chain — so at a fixed 4,000 elements the cost is roughly
  quadratic in depth (31 ms at depth 10, 187 at 80, 2,738 at 320), and an
  all-nested chain, where depth IS the element count, is cubic (7.4 s for
  1,000 divs). Real markup nests 10-20 deep, where 4,000 elements cost ~35 ms;
  nothing throws at any depth; and a visit budget would buy the bound by
  answering a selector WRONGLY on a large document. `test/cssselect-has-cost.test.ts`
  records the numbers and fences the realistic shape.
  **Note, measured, and it covers NOTHING:** narrowing the descendant lead's
  candidates to the anchor's subtree is a COST measure only — `matchFrom`
  rejects everything outside it anyway, so widening the pool to the whole
  document reddens nothing at all. The SIBLING pool is different and IS
  load-bearing: a `+` or `~` subject is not below the anchor, so searching the
  subtree finds nothing whatever. Likewise the anchor's self-exclusion is held
  by the anchoring rather than by the `descendants` generator — yielding the
  anchor too reddens nothing, so `p:has(p)`'s test does not cover that line.
  **Invariant (`zch2.2.5`):** `:lang()` and `:dir()` are answered from the
  DOM, through `htmllang.ts`, and `matches()` gained no parameter for them.
  The issue was filed on the belief that both "need the inherited lang, which
  is the cascade's rather than the selector engine's" — that is WRONG, and
  worth recording because it delayed the work: `lang` and `dir` are HTML
  ATTRIBUTES inherited through parent pointers, and `ComputedStyle` carries
  neither among its 43 longhands. The cascade is not involved at all.
  **Invariant:** an unknown `:dir()` value is VALID and matches nothing, while
  an EMPTY `:dir()` or `:lang()` argument is INVALID. The two refusals differ
  on purpose — a direction we do not know is Selectors 4's never-matching,
  where an unfinished selector is a parse error — and getting the first wrong
  costs the whole selector list, so `p, p:dir(sideways)` would drop its `p`
  half and render unstyled.
  **Invariant:** an element with NO language in scope matches no `:lang()`
  range. Having no language is not the same as having any.
  **Invariant, and it is NARROWER than Selectors 4 on purpose:** `:lang()`
  accepts ONE unquoted ident. The spec writes `<language-range>#` — a comma
  list whose members may be strings and carry `*` wildcards — but Chrome 152
  refuses every one of those forms, `:lang("en")` included; measured, not
  assumed. Accepting them would make us style content every browser leaves
  unstyled, since an unsupported selector invalidates its whole list, and the
  Blink corpus could not see the divergence because Blink REFUSES those
  selectors rather than answering them. The RFC 4647 matcher in `htmllang.ts`
  is unaffected and still wildcard-capable: what narrowed is the syntax an
  author may write, not how a tag is compared.
  **Note:** the unsupported-selector stand-in in `csscascade.ts`'s and
  `cssselect-logical.ts`'s tests is now an UNKNOWN NAME (`:nonsense`) rather
  than a real pseudo-class. It had already moved twice — `:has()` until
  `zch2.2.4`, `:lang()` until `zch2.2.5` — and a name no spec will define
  cannot be overtaken a third time.
- **htmllang.ts** — the two things HTML says about a node that the DOM
  INHERITS rather than the cascade computes: `nodeLanguage` and
  `nodeDirection`, plus `langMatches`. A pure leaf over `htmldom.js` and
  `bidi.js`.
  **Invariant, and `zch2.2.5` was filed on the opposite belief:** NEITHER IS A
  CSS PROPERTY. That issue recorded `:lang()`/`:dir()` as needing "the
  inherited lang, which is the cascade's rather than the selector engine's",
  and waited on `zch2.2.3` for it — but `lang` and `dir` are HTML ATTRIBUTES
  inherited through parent pointers, and `ComputedStyle` carries neither among
  its 43 longhands. The cascade is not involved, and `matches()` gained no
  parameter. Recorded because the misdiagnosis is what delayed the work.
  **Invariant:** its own module rather than part of `cssselect.ts`, because
  `nodeDirection` needs `bidi.js` where `cssselect.ts` is a leaf over
  `htmldom.js` and `cssparse.js` alone — and because every rule here is then
  drivable from a hand-built DOM with no stylesheet.
  **Invariant:** an empty `lang=""` means UNKNOWN and stops the walk. A
  document setting it on a quotation inside an English page is declining to
  state that quotation's language, so inheriting `en` past it would be a claim
  the document refused to make.
  **Invariant:** `langMatches` is RFC 4647 §3.3.2 extended filtering, and its
  two subtle halves each render plausibly when wrong. The match must fall on a
  SUBTAG BOUNDARY — `startsWith` says `lang="english"` matches `:lang(en)` —
  and a SINGLETON subtag may NEVER be skipped, a one-character subtag being
  the start of an extension.
  **Invariant:** `dir=auto` is RESOLVED through `bidi.paragraphLevel` (UAX #9
  P2/P3, the first-strong rule) rather than defaulted to `ltr`. Defaulting
  gives a plausible wrong answer for every Arabic or Hebrew document using it.
  `<bdi>` with no `dir` is `auto` — that is what the element is for.
  **Invariant:** the auto scan SKIPS a descendant that states its own `dir`,
  and skips `script`/`style` content. That subtree is governed by its own
  direction, so letting it decide the ancestor's inverts both — and it is the
  everyday shape, since `auto` is used exactly where a subtree of known
  direction sits inside text of unknown direction.
- **colornames.ts** — the 148 CSS named colours (the 147 X11 names plus
  `rebeccapurple`), as a `ReadonlyMap` of 0..1 triples. A leaf importing
  NOTHING, shared by two stacks that must not depend on each other:
  `svgstyle.ts` parses SVG paint out of strings, `cssvalue.ts` parses CSS out
  of `CssValue[]`. The parsers cannot be shared and the DATA must not be
  duplicated — a second copy is how the two would come to disagree about one
  colour in a document containing inline SVG.
  **Invariant:** `transparent` is NOT in the table. It is `rgba(0,0,0,0)`
  rather than a named colour and carries an alpha the table has no room for;
  the two callers handle it differently and both correctly — `svgstyle.ts`
  returns null (do not paint), `cssvalue.ts` returns a colour with `a: 0`.
- **cssvalue.ts**, **cssprop.ts**, **cssshorthand.ts**, **cssua.ts**,
  **csscascade.ts**, **csscompute.ts** — the CSS cascade (`zch2.2.3`):
  declarations in, computed style out. All six are pure leaves; none imports
  `document.js`, `page.js`, any PDF object module, any `node:` module,
  `svgcss.js` or `svgstyle.js`, and none throws. Nothing is exported from
  `index.ts` — `zch2.3` is the next consumer.
  **Invariant:** the property set is bounded by what `zch2.3`, `zch2.4` and
  `zch2.6` will consume, not by CSS. **43** longhands, asserted, so a
  half-pasted table is a red build; a property outside them is recorded as
  `unknown-property` for `zch2.7` rather than dropped, which is what makes
  "we do not implement flexbox" reportable instead of invisible.
  **Invariant (`zch2.2.6`):** `LengthPct` is ONE shape,
  `{ px, pct }`, not the `{px} | {pct}` union it was — forced by the math
  functions, since `calc(100% - 20px)` is neither arm. A THIRD arm would have
  been worse than converting: every `'px' in v` test already written would
  have matched it and silently dropped the percentage. Read it through
  `resolveLengthPct` and `fixedPx`, never by hand, which is what keeps one
  owner for "resolve a length-percentage against a basis"; the second arm,
  `{ expr }`, is the rare retained `min()`/`max()`/`clamp()` a percentage
  reaches. **Note the trap it left, which the COMPILER could not catch:**
  `PropDef.initial` is typed `unknown`, so nine properties went on saying
  `{ px: 0 }` with tsc silent and every box in every document coming out NaN
  wide. They share the typed constant `ZERO_LENGTH` now, so the next change to
  this type is a compile error rather than 77 failing tests.
  **Note, and it had never fired:** `test/helpers/cascade-goldens.ts` excluded
  percentages from the corpus by testing `'px' in v`, which now matches
  EVERYTHING; it asks `fixedPx` instead. The old form was correct only because
  no fixture declared a percentage.
  **Invariant:** units are CSS **px** throughout, and the single `× 0.75` to
  points belongs to `zch2.4`. Decided on the oracle rather than on taste:
  `getComputedStyle` reports px, so a golden comparison is an exact equality
  where a points model would put a multiply and a tolerance between every
  pair — making a unit bug indistinguishable from a conversion bug.
  **Invariant:** SIX cascade tiers — UA normal, author normal, author
  `style=`, author `!important`, `style=` `!important`, UA `!important`. CSS
  Cascade 5 sorts by origin+importance, then context, then element-attachment,
  then specificity, then order; with no user origin and no shadow context the
  first and third flatten to one ordinal. The flattening is the point: the
  shortcut "a `style=` declaration has infinite specificity" is RIGHT that
  `style=` beats any selector at equal importance and WRONG that a normal
  `style=` beats an `!important` stylesheet rule.
  **Note, measured, and the fixture for it needs care:** collapsing tiers 2
  and 3 reddens ONLY the two `2 < 3` cases and collapsing 3 and 4 reddens ONLY
  `3 < 4` — neither touches the other, which is the whole argument for six
  tiers. The `3 < 4` case must use a `*` selector: with `p` the rule carries
  specificity `[0,0,1]` against an inline block's `[0,0,0]`, so a collapsed
  tier still lets it win on specificity and the mutation reddens NOTHING. That
  was the first version, and it measured nothing.
  **Invariant (`zch2.2.7`):** a CUSTOM PROPERTY is matched on the RAW name,
  before `toLonghands` folds it — a custom property is the one name in CSS
  that is case-sensitive, so `--Foo` and `--foo` are different properties and
  the fold would silently merge them. A name of exactly `--` is NOT one, and
  falls through to the ordinary unknown-property report, which is Chrome's
  answer too.
  **Invariant (`zch2.2.7`):** a shorthand whose value contains a `var()`
  becomes one PENDING entry per longhand it governs, checked before
  `expandShorthand` — which cannot read a raw `var()` and would report the
  declaration unparsable. The pendings sort as ordinary longhands, so the
  expand-before-the-sort invariant below survives untouched, and re-expansion
  happens once the element's environment is known. Failure there costs THAT
  longhand alone, which is what makes `border: var(--w) dashed blue` still
  set the style and colour.
  **Invariant (`zch2.2.7`), and it was a real bug caught by the mutation
  sweep:** `csscompute.ts` reads the CSS-WIDE KEYWORDS off the RAW declared
  value and never off the substituted one. Measured against Chrome,
  `--x: initial; color: var(--x)` computes to the INHERITED colour rather
  than to `color`'s initial black — a keyword arriving by substitution is not
  a keyword, and leaves the declaration invalid at computed-value time
  instead. Testing the substituted value gets `inherit` right BY LUCK and
  `initial` wrong, which is exactly how it shipped for one commit.
  **Invariant:** shorthands expand in `csscascade.ts` BEFORE the sort, because
  the cascade sorts longhands only. `p { margin: 0; margin-top: 5px }` yields
  5px and the reverse yields 0; expanding afterwards yields 0 both times, a
  wrong answer indistinguishable from a right one without the reversed pair.
  **Invariant:** an unmentioned sub-longhand of a shorthand is emitted with a
  synthetic `initial` ident rather than modelled by a second concept, so
  `border: 1px` resets style and colour through the CSS-wide keyword machinery
  that already exists. One reset rule, not two.
  **Invariant:** the cascade keeps the UA winner BESIDE the final winner, so
  `revert` is a lookup rather than a second pass over the same rule list — two
  passes being two things that can drift.
  **Invariant:** ORDER inside `csscompute.ts` is load-bearing twice.
  `font-size` computes FIRST, because every other property's `em` resolves
  against it; `color` computes SECOND, because `currentColor` — which is also
  the INITIAL value of the three border and decoration colour properties —
  resolves against it. **Note the mutation that tests this is not the obvious
  one:** letting `color` be recomputed in the main loop is a NO-OP, since it
  recomputes from identical inputs and reddens nothing. The real mutation is
  passing the PARENT's colour into the main-loop context, which reddens the
  `currentColor` cases and the corpus.
  **Invariant, and it is the one that compounds:** `font-size` is the ONLY
  property whose relative values resolve against the PARENT's computed size;
  every other property resolves against the element's own. One rule for both
  is wrong on exactly one property, and it is the property whose error
  multiplies down the tree — a nested document ends up off by a factor rather
  than by a pixel.
  **Invariant:** `line-height: 1.5` and `line-height: 150%` are different
  values, not two spellings. A number computes to a number and inherits as
  one, so each descendant multiplies by its own size; a percentage computes to
  px and inherits as that px. A single-font-size document cannot tell them
  apart, so the fixture nests a differently-sized child.
  **Invariant:** a percentage `margin`, `padding` or `width` STAYS a
  percentage in the computed value — it resolves against the containing block,
  which is `zch2.3`'s to know. Those fields are `px | pct`, and this is also
  why the oracle cannot compare them: `getComputedStyle` returns the used px.
  **Invariant:** `border-collapse` and `border-spacing` ARE inherited, so that
  setting them on a container reaches the table. It reads wrong and has its
  own test. **Note the surprising half, also pinned:** an inherited property
  is inherited only where the element has NO declaration of its own, and the
  UA sheet declares both on `table` directly — so wrapping a table in a
  collapsing container does NOT collapse it, and an author must target the
  table. Browsers agree.
  **Invariant:** `text-decoration` is NOT inherited: it propagates visually to
  in-flow descendants, which is a rendering rule `zch2.4` owns, and modelling
  it as inheritance would let a descendant that sets its own wrongly win.
  Expect "underline did not reach the `<span>`" to be misfiled here.
  **Invariant:** `@media` honours TYPES only. A feature is detected
  STRUCTURALLY — a `(` block in the query, no string matching anywhere — and
  is recorded rather than dropped; evaluating one needs a viewport this stack
  deliberately does not have, which is also why `vw`/`vh` are refused.
  Dropping every `@media`, as `svgcss.ts` does, would render a document whose
  whole print stylesheet sits inside `@media print` completely unstyled.
  **Invariant:** the collection walk does NOT descend into a `<template>`'s
  content, the same structural rule `selectAll` follows: a template's content
  is not part of the document, so a `<style>` inside one styles nothing.
  **Two traps in what `cssparse.ts` hands over, both measured:** `!important`
  is already stripped from a value but a trailing whitespace token is not, and
  every value carries a LEADING whitespace token from after the colon — so
  `trimWs` trims BOTH ends and a consumer matching on `value.length` is wrong
  twice without it. And `color:` is a VALID declaration whose value is `[]`,
  so every property helper rejects an empty value first or `color:` sets a
  colour.
  **Note, and it is the exact INVERSE of `cssselect.ts`'s trap:** a `hash`
  token carries `id: true` only when its name is an identifier, so `#123456`
  and `#1a2b3c` are `id: false` while `#abc` and `#a1b2c3` are `id: true`. An
  id SELECTOR must require the flag — `#123456` is not a valid id selector —
  and a COLOUR must ignore it entirely, or the commonest spelling of a hex
  colour silently stops parsing. Two modules, opposite rules, one token; do
  not copy either into the other.
  **Note on the oracle, GENERATED rather than vendored:** WPT's cascade tests
  are `testharness.js` and need a JavaScript engine, so
  `scripts/gen-cascade-goldens.ts` drives headless Chrome and commits what it
  said — with `emulateMediaType('print')`, without which Chrome is a screen
  user agent and the `@media print` case records the wrong answer while
  looking healthy. 203 comparisons over 14 documents, and it compares only the
  properties each fixture DECLARES: our UA sheet is transcribed from HTML §15
  and Chrome's is Chrome's, so a full comparison would mismatch on every
  element nobody styled.
  **Note on the largest untested surface here, named rather than discovered
  later:** the UA sheet is OUTSIDE the corpus entirely. It is a transcription
  checked against HTML §15 by a human reading it, and it is the first thing to
  re-examine if `zch2.5` produces documents that look wrong in ways the unit
  tests do not explain. `test/fixtures/css-cascade/PROVENANCE.md` records the
  rest of the ceiling — including that a `border-width` is compared only where
  its `border-style` is not `none`, Chrome reporting the USED 0 there against
  our computed `medium`.
  **Out of scope and tracked:** `@property` and registered custom properties,
  `env()`, and animation of custom properties — each a feature of its own
  rather than a corner of `zch2.2.7`.
  **Note, measured in `zch2.2.6` and recorded because breaking either half
  alone proves NOTHING:** `computeFontSize` resolving against
  `c.parentFontSize` is REDUNDANT with `csscompute.ts` handing that same
  number in as `fontSize` (csscompute.ts:108). Mutating either one on its own
  leaves the whole suite green; only mutating BOTH reddens, and then exactly
  one case. Two defences for one rule — do not read the green suite as
  covering the cssprop.ts half, and do not "simplify" either away.
- **cssvar.ts** — CSS custom properties and `var()` (CSS Variables 1),
  `zch2.2.7`. A pure leaf over `cssparse.js`/`csstoken.js` types plus
  `cssshorthand.js`; it never throws, and `csscascade.ts` and `csscompute.ts`
  both import it while it imports neither, so the edges close no cycle.
  **Invariant:** substitution is TOKEN-LEVEL and runs before any grammar sees
  the value. Not a preference — measured: `--op: + 5px` with
  `calc(10px var(--op))` computes to 15px in Chrome, so a variable is a
  FRAGMENT of a value rather than a value. That is also what makes
  `csscalc.ts` and every other consumer work with no change at all.
  **Invariant:** the environment holds ALREADY-SUBSTITUTED values, which is
  what lets `substituteValue` splice rather than recurse — and it is why the
  billion-laughs guard belongs to `customPropEnv` rather than to
  substitution. A raw `var()` reaching the map is spliced as the tokens it
  is; the plan for this issue assumed the opposite and put the guard in the
  wrong place.
  **Invariant, and the OBVIOUS IMPLEMENTATION IS WRONG THREE WAYS:** cycles
  are found on a DEPENDENCY GRAPH, not with a resolution stack. Nodes are the
  names declared on THIS element and edges are every `var()` name reachable
  in a value, FALLBACKS INCLUDED — so `--a: var(--b, blue)` with
  `--b: var(--a)` is a cycle and computes to nothing rather than to blue, and
  `--a: var(--a, blue)` is a self-cycle. Third and worst, A NAME DECLARED ON
  THIS ELEMENT NEVER SEES ITS OWN INHERITED VALUE: seeding the resolution map
  from the parent makes `--a: var(--a)` quietly resolve to the parent's
  `--a`, where Chrome says self-cycle. All three measured; the parent's entry
  for every declared name is deleted before resolution and put back only as
  that name's own resolved value.
  **Note:** a name that merely DEPENDS on a cycle member is not itself in one
  — its fallback fires normally — so the marking is strictly the members.
  Reachability is asked per name, O(n²) over a handful of properties; Tarjan
  is the general answer and is not worth its own correctness risk here.
  **Invariant:** the fallback fires only when the referenced property is
  GUARANTEED-INVALID — undefined, cyclic, or over budget — and NEVER when the
  substituted result merely fails the property's grammar. Measured:
  `--x: 10px; color: var(--x, red)` INHERITS rather than going red. Both
  readings render a perfectly plausible page.
  **Invariant:** an EMPTY custom property is valid, substitutes nothing, and
  is not guaranteed-invalid, so it does not trigger the fallback either. The
  declaration usually then fails on its own, which is a different route to
  the same place.
  **Invariant:** the fallback is everything after the FIRST top-level comma,
  commas included — `var(--nope, Georgia, serif)` has a two-family fallback,
  not a malformed three-argument call.
  **Invariant, a DELIBERATE DIVERGENCE:** the expansion budget is 65,536
  tokens per declaration. Measured, Chrome expanded a 100,000-token
  billion-laughs and survived, so input between the two figures renders there
  and is refused here. No real document is near either, and the alternative is
  an unbounded expansion in a library whose consumers hand it files they did
  not write — the failure `lexer.ts`'s own invariant exists to prevent. A
  cycle check cannot see that shape: it has no cycle.
  **Note, measured:** every one of the sixteen mutations run against this
  module and its two consumers reddened something, the identity-reuse fast
  path included — so nothing here rests on the spec alone.
- **csscalc.ts** — the CSS math functions `calc()`, `min()`, `max()` and
  `clamp()` (CSS Values 4 §10), added by `zch2.2.6`. A pure leaf over
  `cssparse.js`/`csstoken.js` types that never throws; `cssvalue.ts` imports
  it and it imports nothing back, so the edge closes no cycle.
  **Invariant:** it owns the DIMENSION TABLE. `lengthOf` used to hold it, and
  a second copy would be two answers to "how many px is 1pt" — but `calc(1pt)`
  and `1pt` are the same value, so one owner is forced rather than tidy.
  **Invariant, and it is the decision the whole issue turns on:** a
  length-percentage reduces to the LINEAR form `A px + B %`, which CSS Values
  4 §10.9 says every such math function reduces to. A `calc()` is a sum of
  products and so is ALWAYS linear; a `min()`/`max()`/`clamp()` is linear only
  when no percentage reaches it, since which argument wins otherwise depends
  on the basis. The `sum`/`scale`/`fn` node kinds exist for that one case and
  are built ONLY when the fold cannot happen, so a document with no
  percentage-bearing comparison in it never sees anything but `lin`.
  **Invariant:** TWO types, number and length-percentage, because these sites
  have no angles or times. `+`/`-` demand matching types, `*` demands a number
  on one side, `/` demands one on the right, and `min`/`max`/`clamp` demand
  one type across every argument. That algebra is also what refuses
  `width: calc(5)` — the result is a number, not a length — so `lengthOf`'s
  existing "a bare non-zero number is not a length" rule holds inside a math
  function without a second rule saying so.
  **Invariant:** a number-typed subtree can hold NO percentage, which every
  rule above enforces. That is what makes a divisor fully known at parse time,
  so a zero divisor is decided there rather than becoming a resolve-time
  surprise on some containing blocks and not others.
  **Invariant, a DELIBERATE DIVERGENCE from Chrome, and the oracle is what
  found it:** division by zero is REFUSED. CSS Values 3 made it invalid;
  Values 4 §10.9 makes it infinity and clamps at §10.12, and Chrome/152
  follows Values 4 — measured, `margin-top: calc(10px / 0)` computes there to
  33554432px (2^25). We refuse because an infinite length reaches `stamp.ts`,
  which throws on a non-finite rect, and matching Chrome would mean adopting
  the clamp too for an expression no document means; a refused declaration
  falls back to the initial or inherited value, which renders. The case is OUT
  of the cascade corpus rather than allowlisted inside it, since that corpus
  running whole is worth more than one fixture.
  **Note, and the obvious single explanation is WRONG for half of it:** CSS
  requires whitespace on both sides of `+` and `-`, and FOUR separate
  mechanisms enforce it here. `calc(1px-2px)` is ONE dimension whose unit is
  `px-2px` — `-` is a name character — so no operator is ever seen and the
  unit table refuses it; `calc(1px -2px)` is two dimensions and no operator;
  `calc(1px+ 2px)` is refused by the whitespace-BEFORE check; and
  `calc(1px +(2px))` is the ONLY input the whitespace-AFTER check catches,
  every other unspaced spelling having already gone. Each has its own case in
  `test/csscalc.test.ts`, because one fixture leaves three mechanisms
  unmeasured — this repo's own note said "the tokenizer folds the sign into
  the number" for all of them and was wrong.
  **Note, measured:** all 16 mutations aimed at this module redden something,
  and five of them redden the Chrome corpus, so nothing here rests on the spec
  alone. A fixture for `clamp()` needs its bounds INVERTED
  (`clamp(40px, 2px, 10px)`): with them the right way round both readings of
  the argument order agree, and the mutation survives.
- **linebox.ts** — where a line's baseline sits and how tall its band is
  (`zch2.11`): `lineBox(items, leading, blockFontSize)` over `LineItem`s
  carrying an ascent, a height and an alignment.
  **Invariant:** it imports NOTHING and knows no font, so every rule is
  testable from plain numbers with no PDF built — the split `floatstack.ts`,
  `booklet.ts`, `tablespan.ts` and `docinfer.ts` each already make, for the
  same reason: this is geometry that is silently wrong when reversed. It never
  throws.
  **Invariant, and it is `zch2.11`'s acceptance criterion:** with no atomic
  items it COLLAPSES to the arithmetic `layout.ts` had before — `ascent` is
  the largest font size and `height` is
  `max(leading, ascent * leading / blockFontSize)`. That is what makes
  `test/rich-runs-identity.test.ts`'s four hashes hold BY CONSTRUCTION rather
  than by tolerance, and it is why the fence never moved across the six
  commits that built this.
  **Invariant:** `ascent` counts only BASELINE-aligned items, and a `top`- or
  `bottom`-aligned box contributes 0 to it while raising the band through the
  third term of the `max`. Those align to the BAND, not the baseline, so they
  make a line taller without moving its text — the two-term model
  `vertical-align: top` forces and the reason `middle` was excluded rather
  than approximated.
  **Invariant:** a line with no baseline-aligned item falls back to
  `blockFontSize`, so a blank line keeps ordinary leading rather than
  collapsing to nothing.
  **Note, measured:** all four mutations aimed at this module redden
  something, and three of them redden `layout.ts`'s tests too.
- **preformat.ts** — `preformat` and `expandTabs`, the rule that lets
  indentation survive being drawn. A leaf importing NOTHING, extracted from
  `flowblock.ts` so `cssinline.ts` can reach it: `flowblock.ts` imports
  `pagecontent.js` and `serialize.js`, so a pure CSS leaf cannot.
  `flowblock.ts` re-exports it, keeping `mdflow.ts`'s import path unchanged.
  **Invariant:** the substitution is U+00A0 and it exists because `layoutRuns`
  COLLAPSES runs of spaces, which is fatal to indentation. A SINGLE interior
  space is left alone — it is an ordinary word separator and must stay
  breakable, or a long preformatted line could never wrap at all.
- **htmlreport.ts** — what an HTML document asked for that we could not fully
  draw (`zch2.7`): the `NotRendered` record, the construct vocabulary,
  `describe`, `elementPolicy` and `selectedOptionText`. A pure leaf over
  `htmldom.js` that never throws and imports none of its four consumers
  (`cssbox.ts`, `cssinline.ts`, `csstable.ts`, `cssflow.ts`). `CONSTRUCTS` is
  **21**, asserted by size, and `'overflow'` (`zch2.16`) is the newest — see
  `flow.ts` for why it is not a reuse of `'text'`.
  **Invariant:** it is `html*` rather than `css*` despite the CSS stack being
  its only consumer. It is keyed on HTML element names and encodes HTML's own
  content models, and it sits beside `htmllang.ts` — the existing precedent
  for an HTML fact as a pure leaf. Naming it `cssreport.ts` would say the
  policy is a CSS one and send the next reader to the cascade.
  **Invariant:** a module of its own rather than a section of `cssprop.ts`,
  because TWO walks need the policy and neither may import the other.
  `cssbox.ts` must not descend into a block-level `<iframe>`; `cssinline.ts`
  has its own separate `visit` and must not descend into an inline one. The
  forcing argument behind `colornames.ts`, `preformat.ts` and
  `bordersides.ts` — and it is load-bearing in BOTH directions: deleting
  either call site reddens only the cases that route through that walk.
  **Invariant:** TWO kinds, `dropped` and `degraded`. A third, `leaked`, was
  considered and dropped — once the per-element policy is in place nothing
  leaks knowingly, so no site could produce one, and a kind nobody emits is a
  case every consumer switches on for nothing.
  **Invariant:** the policy is keyed by NAMESPACE for foreign content and by
  TAG NAME for HTML. A whole subtree is foreign rather than one element, and
  a name-keyed test would fire on an HTML element that merely shares a name
  with an SVG one.
  **Invariant:** the leak rule is PER ELEMENT, by what the content MEANS, and
  HTML already draws the distinction. `<object>`, `<video>`, `<audio>` and
  `<canvas>` children ARE fallback content a browser renders when the thing
  cannot load, so they are kept and reported `degraded`; `<iframe>` children
  are, in the spec's words, "ignored by conforming user agents", so emitting
  them is a divergence and they are suppressed. A uniform "never lose words"
  rule renders text no browser shows; a uniform "suppress everything" rule
  blanks a page whose content sits in `<object>` fallback.
  **Invariant:** `input` and `select` are deliberately ABSENT from the policy
  table — their text is SELECTED rather than kept or suppressed, so
  `cssinline.ts` owns them outright and an entry here would be a second
  statement about one element that could drift from the first.
  **Invariant:** `<select>` yields ONE option, the one carrying `selected`
  else the first. Emitting every option turns a three-choice dropdown into
  three lines of body text — a document that looks plausible and says
  something the source does not.
  **Note, measured and NOT covered:** using `in` instead of
  `hasOwnProperty` in the policy lookup reddens NOTHING, because no fixture
  names an element `constructor`. Retained because the rule is sound —
  `predefcmap.ts` records the same hazard for a name that comes from a
  document — but do not read the green suite as covering it.
  **Note, measured:** every other mutation aimed at this module and its four
  consumers reddens something — 20 of 21 across the sweep.
- **cssinline.ts**, **cssbox.ts**, **cssresolve.ts**, **cssmargin.ts** — the
  box model (`zch2.3`): the styled tree to a box tree, and the arithmetic to
  resolve one against a containing-block width. All four are pure leaves and
  none throws. Nothing is exported from `index.ts` — `zch2.4` is the next
  consumer.
  **Invariant, and it is the decision the whole issue turns on: IT POSITIONS
  NOTHING.** No x, no y, no line break, no page break. `zch2.4` maps each box
  to a `FlowElement` and `flow.ts` stacks and paginates exactly as it does for
  Markdown — which is what makes that issue's "mirror mdflow.ts, hand back a
  flat array" possible, and what keeps the existing pagination, keep-with-next
  and column budget working unchanged. A full layout engine was considered and
  rejected: it would duplicate both.
  **Invariant:** `resolveBoxes` takes a WIDTH as an argument rather than
  baking one in, and that is forced rather than preferred. A percentage margin
  resolves against the containing block's WIDTH — vertical margins included,
  which is the part that surprises — so nothing can be precomputed. `flow.ts`
  supplies it at `place()` time.
  **Invariant:** a border edge's USED width is 0 when its style is `none` or
  `hidden` (CSS 2.1 §8.5.3), however wide the computed value. This is not a
  nicety: the initial `border-width` is `medium` (3px) and the initial
  `border-style` is `none`, so every box that states no border carries a
  computed 3px per edge, and adding it takes 6px off the content width of
  EVERY element in EVERY document. Measured — 794 where 800 was right, on the
  first run of `test/cssresolve.test.ts`. It is also why
  `test/fixtures/css-cascade/PROVENANCE.md` had to exclude `border-width`
  from that corpus.
  **Invariant, the rule `cssbox.ts` exists for:** a block container holds
  EITHER only block-level children OR exactly one inline formatting context,
  and a mixed container's inline runs are wrapped in ANONYMOUS block boxes.
  An anonymous box carries its PARENT's computed style and no element — a
  fresh initial style would reset the font and colour of every mixed container
  in a document.
  **Note, measured, and it is the redundant-defences trap:** two rules here
  are each held by a CONJUNCTION rather than by any one line, so breaking
  either half alone proves nothing. A whitespace-only text node between two
  blocks makes no anonymous box because `contributesInline` skips it AND
  because `flush` drops a box whose runs came back empty after `cssinline.ts`
  trims — mutate either and the suite stays GREEN; mutate both and
  "makes NO anonymous box for whitespace between two blocks" reddens.
  `display: none` generates no box because `boxFor` returns null, AND because
  `contributesInline` excludes it, AND because `isBlockLevel` does not admit
  it — all three must go before the three cases that cover it redden. Do not
  read a green suite as evidence that any single one of those lines is
  unnecessary.
  **Invariant (`zch2.6`):** a table box carries ROWS and CELLS, and a cell's
  content is built by the SAME function a paragraph's is — `contentOf`, which
  `zch2.6` extracted out of `boxFor` for exactly this. A second content
  builder is how a cell comes to render bold where a paragraph renders code;
  `mdflow.ts` records the same rule for its own cells. `csstable.ts` maps the
  result to a `TableBuilder`.
  **Invariant:** CSS 2.1 §17.2.1's anonymous fixup earns its place on
  `display: table-*`, NOT on `<table>` markup. `htmltree.ts` already produces
  well-formed `table > tbody > tr > td`, so real HTML needs almost none of it
  — what needs it is a div tree given table displays by CSS, which is why both
  fixtures for it are `<div style="display:table">`. `boxFor` runs
  `collectRows` over the element ITSELF, so a stray `display: table-cell`
  reached directly lands in an anonymous row with no second entry point.
  **Invariant (`zch2.7`):** `boxFor` applies `htmlreport.ts`'s content policy
  and, on `suppress`, returns a BOX WITH NO CONTENT rather than no box — the
  element is still a replaced box that occupies its margins, unlike
  `display: none`. `cssmargin.ts`'s `isEmpty` then treats it as an empty
  block, which is what a browser does with an iframe it cannot load. This is
  the block-level half of a rule `cssinline.ts` applies for the inline case;
  an element here is inline by DEFAULT, so only `display: block` reaches it,
  and a policy applied in one walk is silent for the other.
  **Invariant:** a cell's `header` is decided by the SECTION as well as the
  tag — a `<td>` inside a `<thead>` is a header, because a `<thead>` is what
  repeats atop each page of a paginated table whatever its cells are called.
  **Note, measured:** with every `<thead>` fixture written with `<th>`, the
  section half of that rule is UNREACHABLE and deleting it reddens nothing;
  `test/cssbox.test.ts`'s "marks a td inside a thead as a header too" is the
  only case that covers it.
  **Invariant:** a junk `colspan`/`rowspan` clamps to 1. A `NaN` reaches
  `TableBuilder` and corrupts the whole grid, where 1 is the cell the author
  meant.
  **Invariant:** the CAPTION comes out of the row flow onto `TableBox.caption`
  and is emitted as ordinary block content. `TableBuilder` has no caption
  vocabulary, so leaving it among the rows would make it a data row and
  dropping it would lose its text.
  **Invariant:** `cssinline.ts` adds NO wrapping engine. An IFC lowers to the
  `TextRun[]` model `textdecor.ts` defines and `layoutRuns` wraps it — the
  one-wrapping-engine rule, which also buys justification, per-line leading
  and `runlink.ts`'s link-rect geometry. A run's merge key folds in the LINK
  DESTINATION, because two adjacent links style identically and merging would
  point the whole phrase at the second URI; `mdruns.ts` records the same rule.
  **Invariant (`zch2.6`, MOVED by `zch2.7`):** a FRAGMENT-only `href` gets NO
  link. A `/URI` action pointing at `#intro` is a link that looks clickable
  and does nothing in a viewer, which is worse than no link; resolving one
  needs an id-to-destination map built after placement. It is reported on the
  CONSTRUCT report as `link`/`degraded` — `zch2.6` parked it on `unsupported`
  as `unparsable-value` and recorded that `zch2.7` could widen it, and it did:
  a link we DECLINED to make is a construct we did not render, not a
  declaration we could not parse. Note an href that merely CONTAINS a hash
  still links.
  **Invariant (`zch2.7`):** `<input>`'s value is DRAWN — it drew nothing at
  all before — except for `type=hidden` and `type=password`, which draw
  nothing and report `dropped`. The password refusal is not a new rule:
  `CLAUDE.md` records under `formfield.ts` that "a password field's value must
  never reach a content stream", because flattening bakes the plaintext into
  permanent page content where no viewer will ever mask it again. An HTML
  password value is the same disclosure by a different route.
  **Invariant (`zch2.11`), TWO rules where there was one:** an `<img>` reports
  `vertical-align` only for a value OUTSIDE `baseline`/`top`/`bottom`, because
  those three are implemented for an atomic; a non-atomic inline still reports
  every non-baseline value, because for text none of them are implemented. A
  single widened rule satisfies either fixture alone, so both are asserted.
  Note the img branch RETURNS, so its check sits inside that branch rather
  than in the block below — before `zch2.11` an `<img>` reported nothing at
  all.
  **Invariant (`zch2.7`):** `visit` is reached ONLY for non-block-level nodes
  — `contentOf` routes block-level children to `boxFor` — which is why the
  three "computed and never read" reports (`inline-block`, `vertical-align`,
  inline padding) need no display check. Those three have ZERO consumers
  outside `cssprop.ts`'s table, so they get no backstop from the cascade's
  unknown-property report, which fires only for a name outside the 43
  longhands: without these they are silent by omission rather than by
  decision. Only a STATED padding reports, since the initial is 0 on every
  side and reporting the initial would put a record on every element in every
  document.
  **Note, and the difference is easy to get backwards:** `runlink.ts` emits
  ONE `/Link` STRUCTURE element per linked run — two would have a screen
  reader announce it twice — but one ANNOTATION per LINE the link occupies,
  because a rect is a rectangle and a wrapped link is not. A test asserting
  "one annotation for a link broken across a line" is asserting the wrong one
  of those, and this repo's own plan for `zch2.6` did.
  **Invariant:** an ATOMIC INLINE IS A MERGE BARRIER. An atomic records
  `beforeRun: runs.length`, so the text after it must start a new run —
  otherwise `a<img>b` merges into the single run `ab` whose index 0 the image
  claims to precede, moving the picture to the front of the line. The two
  texts are identically styled precisely when it bites.
  **Invariant:** `resolveFamily` and `measure` are both INJECTED, the seam
  `colorimage.ts` uses for `resolve`/`inflate`. `fontFamily` is a list of NAMES
  and `TextRun.font` is an `AuthoringFont`, and bridging them needs
  `Document.LoadFontByName`; shrink-to-fit needs `layoutRuns`. Either import
  would put a font stack inside a pure leaf.
  **Invariant:** margin collapsing combines the largest POSITIVE plus the most
  NEGATIVE, NOT `Math.max`. 40px against −10px is 30px, and a document with no
  negative margins cannot tell the two readings apart.
  **Invariant, and the corpus found it when no hand-written test had:** an
  EMPTY block's collapsed margin is spent ONCE. Such a block occupies no
  vertical space, so its top and bottom margins are still adjoining everything
  on both sides and the whole run is ONE margin; emitting it before the
  zero-height box AND again after gives 60px where 30px is right. The unit
  test asserted the same wrong pair, which is exactly why only an outside
  answer could catch it.
  **Invariant:** `collapseMargins` returns the gap BEFORE each box and always
  0 for the first, whose own top margin escapes its parent under rule 2 —
  counting it here as well would double the space above it. A box that does
  NOT collapse (a float, a cleared box) contributes its own top margin and
  combines with nothing on either side.
  **Note:** clearance is a deliberate SIMPLIFICATION. Real clearance depends
  on where the floats are, and a cleared box whose clearance turns out to be
  zero would collapse in a browser; this module has no float positions, takes
  the conservative reading that a cleared box never collapses, and leaves the
  actual clearing to `floatstack.ts` through the `clear` `zch2.4` passes to
  Flow.
  **Note, measured, and it covers NOTHING here:** treating `height` as an
  exact height rather than a MINIMUM cannot be expressed in this module at
  all — `minHeight` is a number reported by `zch2.3` and CONSUMED by
  `zch2.4`, which decides whether a box may exceed it. Held by that issue,
  and noted on it.
  **Note on the shape `zch2.4` depends on:** `flow.ts` ADDS
  `spaceAfter + paragraphSpacing + spaceBefore` between consecutive elements
  rather than collapsing, so `zch2.4` sets `paragraphSpacing: 0`, puts the
  whole gap in `spaceBefore`, and zeroes every `spaceAfter`. Flow's additive
  rule then reproduces the collapsed result exactly, with no change to Flow —
  which is the whole premise of the epic.
  **Note on the oracle, GENERATED rather than vendored:**
  `scripts/gen-box-goldens.ts` drives headless Chrome and records exactly two
  numbers per element — the used content width, and the collapsed gap to the
  previous sibling. `getComputedStyle(el).width` IS the used CONTENT width
  (measured: 770px for a block in an 800px container with 10px padding and 5px
  borders, whose `getBoundingClientRect().width` is 800), and the sibling gap
  is the ONLY way to observe collapsing at all — Chrome reports the SPECIFIED
  margin through the CSSOM and never the collapsed one, so `zch2.2.3`'s
  computed-style corpus could not have tested this rule set. The suite
  compares CUMULATIVE offsets rather than per-sibling gaps, because a
  zero-height box is not placed within the collapsed margin it sits in.
  **Note on the ceiling, and it is the part a reader will get wrong:**
  ABSOLUTE POSITIONS ARE OUTSIDE THE CORPUS, because we produce none. So are
  floats, line breaking, inline geometry and clearance.
  `test/fixtures/css-box/PROVENANCE.md` says so at the top.
- **cssflow.ts**, **cssframe.ts** — the styled box tree lowered to
  `FlowElement[]` (`zch2.4`). `cssflow.ts` is the mapper and owns nothing
  else: it knows about columns, rects and pagination not at all, which is what
  makes `zch2.5`'s three entry points one implementation — `mdflow.ts`'s shape
  for `mdflow.ts`'s reason. `cssframe.ts` is the `BoxElement` decorator, its
  own module because it PAINTS and so cannot be the pure leaf the four
  `zch2.3` modules are; it imports the protocol from `flowelement.ts`, never
  `flow.ts`, the split `flowblock.ts` already makes.
  **Invariant:** resolution happens at BUILD time, against a width the caller
  supplies — NOT at `place()` time, which `zch2.3`'s design proposed. Three
  call sites read `spaceBefore` before `place()` ever runs
  (`flowplace.ts:63`, `flow.ts:1298`, and `flow.ts:1330`'s keep-with-next
  lookahead, which reads the NEXT element's), so a gap computed inside
  `place()` can never reach the engine. Every entry point has a width: a Flow
  knows its column width, `page.AddHtml` is given a rect.
  **Invariant:** the collapsed gap goes ENTIRELY in `spaceBefore`, because
  `flow.ts` ADDS `spaceAfter + paragraphSpacing + spaceBefore` rather than
  collapsing. THE CALLER MUST PLACE WITH `paragraphSpacing: 0`. A fixture for
  this needs TWO DIFFERENT GAPS in one list: a uniform list totals identically
  under `spaceAfter` and cannot tell the readings apart.
  **Invariant:** a wrapper ADDS its box's gap to the inner element's own
  spacing rather than REPLACING it — `quote()`'s rule, and load-bearing in
  both directions. The gaps BETWEEN a container's children are computed on
  those children and ride on their own decorators, so a wrapper reporting only
  its own reports 0 for every one of them and flattens the document; and
  `list()` expresses item spacing the same way, so swallowing it flattens
  every list. Measured: it shipped wrong and four cases caught it at once.
  **Invariant:** CSS px → points (× 0.75) crosses HERE and nowhere else, and
  it includes every `TextRun.fontSize` — `cssinline.ts` emits px because it
  reads `ComputedStyle.fontSize` directly. Miss that one and all text renders
  33% too large, which reads as a style choice rather than a fault.
  **Invariant:** a container never holds and paginates its children, so a
  block box lowers to ONE `BoxElement` per element its subtree produced. A
  split box needs no special case and a nested box is the decorator wrapping
  itself — `QuotedElement`'s shape.
  **Invariant:** `insetTop` and the top border belong to the FIRST slice,
  `insetBottom` and the bottom border to the LAST, and the side borders draw
  on every slice. Drop the flags and a split box draws its top border twice
  and its bottom never.
  **Invariant, and it is the one the obvious implementation gets wrong:** a
  box that does NOT end in this column owes NO bottom inset, and the room
  reserved for it goes back to the content. The first build charged it on both
  the slice that was `last` when it began AND on the continuation, so a split
  box paid twice. The re-probe has a guard of its own: if the returned room
  makes the content fit, the inset has nowhere to go and the box must still
  split, so the narrower probe stands.
  **Invariant:** the background and borders are painted BEFORE the inner
  element draws, which is why `place()` measures first — `CodeBlockElement`'s
  route, and for the same reason: paint after and the fill covers the text.
  **Invariant:** `minHeight` is a MINIMUM and content taller than a stated
  height makes the box taller. `zch2.3` reports the number and provably cannot
  test the rule, so it lands here. A fixture whose content FITS measures
  nothing — a clipping build and a growing build agree there.
  **Invariant:** the shortfall is computed against a holder SHARED by every
  decorator of one box, a continuation included. Per-element state pads each
  slice to the full minimum, so a three-child 100pt box comes out 300. Third
  instance of the pattern behind a list item's marker, a split table's
  `TableTagger` and `QuoteStruct`.
  **Note:** `measure()` IGNORES `minHeight` and so under-reports for such a
  box — the padding reads the holder's running total, which a non-destructive
  dry run must not touch. Its only consumer is keep-with-next.
  **Invariant:** a heading is routed through `heading()` with the cascade's
  font and size passed EXPLICITLY, so the builder's own defaults never
  double-apply on top of the UA sheet's. What that buys is `/H1`..`/H6` and
  `keepWithNextEligible`; under `paragraph()` both are SILENT losses, since
  the rendering is identical. The level comes from the TAG — a DOM fact, since
  no computed property says "this is a heading". **Note the fixture:** `h1`
  cannot separate the two, the UA sheet's `2em` being 24pt and the builder's
  default also 24pt; `h3` can, at `1.17em` = 14.04pt against a flat 14.
  **Invariant:** a RUN of consecutive `display: list-item` siblings becomes
  ONE `list()`, because `list()` owns the ordinal counter and one call per
  item restarts it — every marker then reads `1.`. Nesting falls out of
  `FlowListItem.blocks` rather than `items`, so there is one path rather than
  two. Keying on `display: list-item` rather than the `ul`/`ol` tag is what
  makes the property work on an arbitrary element, and it costs nothing.
  **Invariant:** a construct that does not render names itself in `skipped`
  and still contributes its text — `svgdraw.ts`'s rule, applied early here
  because it is free. `'table'` LEFT the report in `zch2.6`, and that is
  asserted directly: a construct leaving is worth pinning too, since a caller
  reads the report to tell a dropped construct from an empty document.
  **Invariant (`zch2.7`):** `skipped` is `NotRendered[]`, not `string[]` — see
  `htmlreport.ts` for the record and the vocabulary. `describeNotRendered`
  recovers the old flat strings for a caller that only logs. Markdown's
  `skipped` stays `string[]`, and the ASYMMETRY IS DELIBERATE:
  `NotRendered.el` is an `HtmlElement` and Markdown has `MdNode`, so a shared
  type would carry a field always `undefined` for half its callers, and
  Markdown is `gl6o`'s epic.
  **Invariant (`zch2.7`, widened by `zch2.16`):** ORDER is by PHASE, then
  document order within a phase — there are now THREE phases, and everything
  found while BUILDING boxes precedes everything found while LOWERING them,
  which in turn precedes everything found while PLACING them. Each of the
  first two walks the whole tree; the third is the engine's, and its records
  reach `skipped` only through the two entry points that place before they
  return (`doc.AddHtml`, `page.AddHtml`). A true global
  document order would need a preorder index on every element carried on
  every record, for a guarantee no caller has asked for. Recorded as a
  decision so it is not read as an oversight; the retrofit is cheap only
  during `computeStyles`'s existing walk.
  **Invariant (`zch2.6`):** a table's CAPTION is emitted BEFORE the table and
  is resolved HERE rather than through `mapSiblings`, so that the table's own
  collapsed gap lands on whichever of the two comes first — `mapSiblings`
  zeroes the gap above its first box, which would drop it. Both halves are
  pinned: charging the gap to neither and charging it to both each redden
  exactly one case. **Note:** ORDER is asserted on the caption's y against the
  first row's, because element COUNT cannot see it — a caption emitted after
  the table still gives two elements.
  **Invariant (`zch2.6`):** a LONE image renders as a figure; one sharing its
  line with text is still reported, because `layoutRuns` cannot place an
  atomic inside a line. "Lone" means no MEANINGFUL runs — but **note,
  measured:** demanding `runs.length === 0` instead reddens NOTHING, because
  `cssinline.ts` trims the context's outer edges and then filters every empty
  run, so a lone atomic provably arrives with no whitespace run left. Two
  redundant defences; breaking either alone proves nothing. What IS covered is
  the multi-atomic guard: accepting more than one atomic renders the first and
  silently loses the second.
  **Invariant:** `resolveImage` is INJECTED and `data:` URIs need it not at
  all — `datauri.ts` handles those. A src it declines is reported and the rest
  of the document renders; `imageElement` catches `buildImageXObject`'s throw
  for the same reason, since a mapper whose whole contract is that damage is a
  value must not let one escape.
  **Invariant (`zch2.11`):** `resolveImage` is asked ONCE per image. A LONE
  image tries the block-figure path first, and when that fails it reports and
  falls through to the text WITHOUT atomics — `atomicsOf` would otherwise ask
  for the same src a second time. Invisible in the output, since the report
  and the render are identical either way, but a resolver that fetches would
  do the work twice. Found by an existing `zch2.6` case going red.
  **Invariant (`zch2.11`):** an `<img>` among words is an ATOMIC and renders;
  only one that will not resolve is still reported. A LONE image stays on the
  block-figure path, so `zch2.6`'s rule is untouched. `atomicBox` does the CSS
  sizing — stated `width`/`height` win, else the intrinsic pixels as CSS px,
  aspect preserved when only one is stated — and the `x 0.75` crosses there,
  once, which is why `imageembed.ts` exports `imageSize` (a header read, not a
  decode) rather than this module building an XObject it may not touch.
  **Note, measured, and the trap is that the obvious fixture tests something
  else:** `mapSiblings` carries a gap forward across a box that produced no
  ELEMENT, and an empty `<div>` does NOT exercise it — `cssmargin.ts` already
  handles an empty block by pushing a 0 gap and continuing the pending run, so
  that shape never reaches the carry and passes with it deleted. A ROW-LESS
  TABLE is the fixture: `isEmpty` returns false for ANY table box
  (cssmargin.ts:80), so a real gap is emitted against a box that then produces
  nothing. That fixture was a SKIPPED table until `zch2.6` made tables render.
  Both cases are in the suite, the `div` one labelled as `zch2.3`'s rule
  reaching through.
  **Note, measured and NOT covered:** a table's `clear` is passed to
  `table()` and dropping it reddens nothing. Clearance only shows against a
  float, and float PLACEMENT is `zch2.10`'s, so there is nothing to clear
  past yet.
  **Note:** the root box's escaped top margin is DROPPED. `body { margin: 8px }`
  collapses up and out under rule 2, and both engines drop `spaceBefore` above
  the first element anyway. Consistent with Flow, a divergence from a browser.
  **Note on the oracle, and it is thinner than every CSS issue before it:**
  there is NONE. `zch2.3`'s headless-Chrome corpus measures used widths and
  collapsed gaps and stops short of anything positional; which builder a box
  goes through, where the ink lands and how a split box frames itself are not
  observable through `getComputedStyle` at all. Every rule here is held by a
  hand-built case and a mutation — all ten reddened something. `zch2.5` is
  where an end-to-end comparison becomes possible.
- **csstable.ts** — a CSS `TableBox` to a `TableBuilder` (`zch2.6`). A pure
  leaf: `cssbox.js`, `cssprop.js` and `textdecor.js` for types, `cssvalue.js`
  for `fixedPx`, `tableauthor.js` for the builder and `bordersides.js` for the
  edge flags — no `Document`, no PDF object module, no `node:` import, which
  is what lets every rule be tested from a hand-built box tree. Nothing is
  exported from `index.ts`.
  **Invariant:** `toPt` and `scaleRuns` are INJECTED rather than computed
  here, because CLAUDE.md records that the px → pt × 0.75 crosses in
  `cssflow.ts` and NOWHERE else. A second site is a second thing to get wrong,
  and `cssinline.ts` emits every `TextRun.fontSize` in px.
  **Invariant:** it NEVER throws. A table it cannot build is `null` — which is
  what a table with NO ROWS gets, since `TableBuilder` has no meaning with an
  empty grid and `flowtable.ts` would index `grid[0]`. Every number handed to
  the authoring layer is guarded first: `addCell` validates `fontSize` as
  strictly POSITIVE and CSS admits `font-size: 0`, so `positive()` returns
  undefined there and the builder's own default applies.
  **Invariant:** only the LEADING run of header rows can go through
  `setRepeatingRowsCount`, and a leading header cell then carries NO explicit
  `header` — `CellOptions.header` already defaults to "cells in the
  repeating-header rows are column headers", and saying both is two statements
  that can drift (`mdflow.ts`'s rule). A header row ANYWHERE ELSE — a
  `<tfoot>`'s `<th>` — gets an explicit `header: 'column'` instead, because
  the repeating-header default provably cannot reach it.
  **Invariant (`zch2.7`):** a NESTED table flattens its cells' text into the
  outer cell and reports `table`/`degraded`. It was LOST outright from
  `zch2.6` until `zch2.7` — `collectBox` returned early for a table box, so
  `<td>outer<table>…INNER…</table></td>` drew only `outer`. A regression
  against this epic's own rule, found by probing rather than by a test.
  **Invariant:** a cell holding BLOCK content FLATTENS to its runs and is
  reported once as `table-cell-blocks`. `addCell` takes `string | TextRun[]`,
  so a cell containing a `<p>` and a `<ul>` cannot be represented; losing the
  text instead would break the rule that a construct which does not render
  still contributes what it has. A hard break separates sibling blocks —
  without it `<td><p>alpha</p><p>beta</p></td>` reads `alphabeta`, which is
  not a degraded rendering but a different word, and `addCell` already splits
  a cell's text on a newline so it costs no new vocabulary.
  **Invariant:** only `outerBorder` is seeded from the table's own border,
  never `TableDefaults.border`. That field is the per-CELL default, so seeding
  it would draw a grid where CSS draws one frame: `table { border: 1px }` says
  nothing about `td`.
  **Invariant:** a border edge's USED width is 0 when its style is `none` or
  `hidden` (CSS 2.1 §8.5.3) — `cssresolve.ts`'s rule, and it bites here for
  the same reason: the initial `border-style` is `none` while the initial
  `border-width` is `medium` (3px), so a cell that states no border would
  otherwise be drawn boxed. `BorderInfo` carries ONE width and ONE colour plus
  per-edge flags, so four edges that DIFFER collapse to the first painted one
  — a limitation of the authoring type rather than a dropped construct, hence
  documented rather than reported per cell.
  **Note:** CSS column widths are a follow-up; `autoFitColumns()` is what runs
  today. Mixing stated and auto columns is what `resolveColumnWidths`'s
  `ColumnWidth` specs are for, and guessing silently mis-sizes every column
  rather than failing.
  **Note, measured:** all eleven mutations aimed at this module redden
  something, the border rule included — the plan predicted that one would be
  uncovered, and `test/csstable.test.ts`'s "paints the edges a cell border
  states and no others" closes it.
- **datauri.ts** — decoding a `data:` URI's payload (`zch2.6`). A pure leaf
  importing NOTHING.
  **Invariant:** it never throws — a payload it cannot decode is `undefined`,
  including a malformed one, which is a destination we cannot resolve rather
  than an error.
  **Invariant:** ONE owner. `mdflow.ts` held this privately and `cssflow.ts`
  needed it too; two copies is how they would come to disagree about one
  payload. The extraction `colornames.ts`, `preformat.ts` and
  `bordersides.ts` each already made — and the move kept the identifier name
  so `mdflow.ts`'s one call site did not change, with
  `test/markdown-flow.test.ts` as the fence that it moved nothing.
- **htmlflow.ts**, **cssfont.ts** — the three HTML entry points (`zch2.5`) and
  the font bridge under them. `htmlflow.ts` is `htmlElements`, the one
  implementation `flow.AddHtml`, `page.AddHtml` and `doc.AddHtml` all wrap —
  `mdflow.ts`'s shape for `mdflow.ts`'s reason. `cssfont.ts` is the
  `FamilyResolver` every module below deferred here, and it is the ONLY module
  in the CSS stack allowed to import `document.js`.
  **Invariant:** `htmlElements` takes a `Document` and a WIDTH where
  `markdownElements` takes neither, and both are forced. Fonts come from
  `LoadFontFamily`; and `zch2.4` resolves boxes at BUILD time, so the width
  must be known then. A Markdown element carries no resolved geometry and is
  width-independent until it places.
  **Invariant:** the width is POSITIONAL, not an option, so no caller of the
  three entry points passes one — the flow supplies `columnWidth`, the page
  `rect[2]`, the document by building a `Flow`. A width in the shared options
  bag could be passed twice and disagree.
  **Note, measured, and it is the trap when testing any of this:** an HTML
  test that measures TEXT WRAPPING cannot see the build width at all, and
  stays green with the wrong number handed to the mapper. `BoxElement` derives
  its inner width from the PLACEMENT context — deliberately, so a caller
  handing a different width degrades rather than overflowing — so wrapping is
  placement-driven. What the build width decides is PERCENTAGE resolution, so
  a `margin-left: 25%` is the fixture that sees it. Both width mutations
  reddened NOTHING against wrapping fixtures and exactly one case each after
  the rewrite.
  **Invariant:** the option bag is `HtmlFlowOptions`, NOT `HtmlOptions` —
  `html.ts` already exports that for `ToHtml`, the opposite direction. The
  collision `mdexport.ts` records for `MarkdownExportOptions`, and it is a
  compile error only because both are exported from `index.ts`.
  **Invariant:** `LoadFontFamily` is REUSED rather than reimplemented, and it
  fits exactly: it already walks a family chain and returns
  `{ regular, bold?, italic?, boldItalic? }`, structurally identical to
  `MarkdownFontFamily` — no coincidence, since its own docs say the result is
  ready for `AddMarkdown({ style: { font } })`. Feeding it to
  `mdstyle.resolveFamily` keeps ONE owner for "an unstated face falls back to
  regular".
  **Invariant:** a generic keyword is NEVER offered to `LoadFontFamily` — no
  installed family is called `serif` — and the FIRST generic in the list wins.
  **Note, and it will read as a regression:** a plain `<p>` renders in TIMES,
  not Helvetica. The UA sheet declares `html { font-family: serif }` and
  `font-family` inherits, so `serif` is what an unstyled document computes.
  Browser-correct; every `zch2.4` test stubbed Helvetica for every list and so
  cannot see it.
  **Note:** an unresolvable named family in a list with NO generic falls back
  to sans-serif. `font-family: Garamond` alone admits no principled answer, and
  a name-to-class table can never be complete — the shape `rebuild.ts` already
  rejects for identifying `/Info`. Asserted directly so it stays a decision.
  **Invariant:** the resolver is memoized per DOCUMENT (a `WeakMap`) and its
  answers per family list, keyed on the list joined by **NUL**. `buildBoxes`
  asks once per element. Per document rather than globally because a resolver
  closes over that document's registered folders, so sharing one would leak
  one document's fonts into another; and NUL rather than a space because under
  a space `['Alpha', 'Sans']` and `['Alpha Sans']` key IDENTICALLY — a
  two-family chain against one two-word family, which resolve differently.
  **Invariant:** the `<title>` default is `doc.AddHtml`'s ALONE.
  `Flow.AddHtml` and `Page.AddHtml` append to a document whose title is someone
  else's business — `doc.AddMarkdown`'s own stated rule, and why it is the only
  one of the three that accepts `title`. An explicit option always wins, and a
  BLANK `<title>` yields undefined rather than `''`: `SetMetadata({ title: '' })`
  would write an empty `/Info /Title`, worse than leaving the document's own
  alone.
  **Invariant:** `doc.AddHtml` parses ONCE and hands the tree to
  `flow.AddHtml`, which is what `src: string | HtmlDocument` is for. It reads
  the title from the same tree the flow lowers.
  **Invariant:** THE CALLER MUST PLACE WITH `paragraphSpacing: 0`. Measured:
  both `normalizeFlowOptions` and `page.AddMarkdown`'s own option already
  default it to 0, so the contract holds for everyone who says nothing; a
  caller who sets it gets it added between every HTML element too, which is
  their statement and is documented rather than overridden.
  **Invariant (`zch2.6`):** `HtmlFlowOptions.resolveImage` takes HTML's
  `(src, alt)` where `mdflow.ts`'s takes Markdown's `(destination, title)` —
  the same PATTERN, deliberately not the same arity, since the two formats
  name different things. It is validated as a function at the entry point, as
  `resolveFamily` already is, and a `data:` URI needs it not at all.
  **Note on the oracle:** the equivalence test compares EXTRACTED TEXT, not
  geometry. It proves the three share a mapper; it says nothing about whether
  the mapping is right, which is `zch2.4`'s question and is held there by
  hand-built cases with no oracle at all. All twelve mutations here reddened
  something.
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
  **Invariant (`72nc.8`):** `imageKey` is the ONE owner of "are these two
  images the same" — a sha256 of the ENCODED BYTES, never the `PdfStream`
  object, since a merged document holds distinct stream objects with identical
  content. It lives here, beside `encodeImage` that produces an encoded image
  and `imageExtension` that names one. **Note what forced the extraction:**
  `mdexport.ts` and `docxexport.ts` had each written the same three lines out,
  and docxexport.ts's own comment already claimed the rule was "mdexport.ts's
  rule, reused rather than re-derived" — which it was not. `node.ts`'s image
  extractor would have been the third copy. Measured: neutering `imageKey`
  reddens all three consumers.
  **Invariant:** `imagehref.ts` has one decoder. `encodeImage` returns bytes plus
  a media type — which is what tells the external path its extension, a `.png`
  holding JPEG bytes being a file no viewer opens — and `imageHref` is the base64
  wrapper over it, so the inline and external paths cannot disagree about what an
  image is.
  **Invariant (`72nc.5`):** `ImageInfo.Save` is that SAME encoder, reached
  through an optional fourth argument on `encodeImage` rather than a second
  function beside it — which is what makes the five existing callers
  byte-identical BY CONSTRUCTION rather than by test (`html-identity`,
  `grayscale-identity` and `docx-flow-identity` are the fences, and none moved).
  **Invariant:** with no `format` the encoding is FAITHFUL — an unmasked
  `DCTDecode` hands back its embedded bytes verbatim, so extraction costs no
  generation loss. A NAMED format the faithful encoding already satisfies
  changes nothing, which is what keeps `Save({ format: 'png' })` on a Flate
  image byte-identical to `Save()` and is also the cheaper answer.
  **Invariant:** naming an OPAQUE format IS the request to flatten, so
  `format: 'jpeg'` composites alpha onto WHITE — the page a viewer would show
  the picture against, deliberately not the stencil `fill`, which is the colour
  an `/ImageMask` paints with. Refusing instead (`raster.ts`'s posture for
  `background: 'transparent'`) would make one loop over `page.Images` throw on
  whichever images happen to carry a mask; there the caller ASKED for
  transparency, here it is a property of the document.
  **Invariant:** `Save` THROWS where `encodeImage` returns undefined. Its other
  callers are rendering a whole document, where skipping one damaged picture is
  right; a caller asking for THIS image wants to be told. The format check runs
  BEFORE any decoding, so a rejected call costs nothing.
  **Note, measured, and the reasoning is the interesting half:** the re-encode
  path writes an opaque picture WITHOUT an alpha channel, a third of the bytes,
  and that is the common case rather than a corner — the branch is reached only
  when the faithful encoding was a JPEG, so extracting a photo as PNG is
  precisely what takes it. It follows that `reencode`'s RGBA arm is UNREACHABLE
  today: every transparent image is handled by the faithful path before a
  re-encode is ever considered, so forcing that arm to RGB reddens NOTHING.
  Retained as defence, and recorded rather than left to be discovered — do not
  read the green suite as covering it.
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
- **textcoverage.ts** — what of a piece of text the resolved face cannot draw
  (`zch2.14`). A pure leaf: `encoding.js` and `embeddedfont.js` by value,
  `AuthoringFont`/`TextRun`/`FontDriver` as types — the shape `textdecor.ts`
  already has. It never throws, and `undefined` means fully drawable.
  **Invariant:** the per-character question goes through each owner's OWN
  predicate (`EmbeddedFont.probe`, `encodeWinAnsi`), never a reach-through to
  `font.sfnt.cmapLookup` — which `stamp.ts` does and a leaf should not.
  **Invariant:** `\n`, `\r` and `\t` are EXCLUDED, and that is the feature
  rather than a detail. Measured: `encodeWinAnsi` drops all three, so `a\nb`
  probes 2 of its 3 codepoints and every code block and every hard-broken
  paragraph in every document would carry a `degraded` record.
  **Invariant:** a SHAPED block gets the all-or-nothing answer only. A shaper
  legitimately consumes joiners and format characters, so a per-character scan
  reports loss where the shaper did its job.
  **Invariant, and the two are NOT one function:** `coverageOf` skips
  structure because it answers "what did the author ask for that will not
  appear"; `drawsNothing` counts it because it answers the painter's "will any
  bytes be emitted", for which a lone newline IS nothing. Collapsing them
  sends an empty line to the painter and moves bytes.
  **Invariant:** `lost` is DISTINCT characters, capped at 32. A page of
  Cyrillic must not become a report field.
- **textextents.ts** — max-content and min-content widths of a piece of text
  (`zch2.10`). A pure leaf, extracted from `tableauthor.ts` because a CSS
  float's shrink-to-fit asks the same question a table column's auto-fit does,
  and two copies is two answers to "how wide does this content want to be".
  **Invariant:** LINES rather than the whole string. `addCell` takes arbitrary
  text and `mdruns.ts` maps a hard break to `'\n'`, so measuring across one
  would demand a box wide enough for every line at once.
  **Invariant:** words are found on the CONCATENATED run text, because a word
  may span a run boundary (`**bold**text` is one word) — the rule `layoutRuns`
  already uses for break opportunities — while each piece is still measured at
  its own run's font. Only U+0020 and `'\n'` break, so the U+00A0 a code block
  paints for indentation keeps its line intact.
  **Invariant:** its measuring driver records NO glyph usage (`encode` returns
  empty bytes, which measurement ignores), so asking how wide an embedded font
  wants to be does not retain glyphs for text that may never be drawn.
  **Note:** `measuringDriverFor` is DUPLICATED here and in `tableauthor.ts`,
  which keeps its own because two more callers there (its row-height walk) need
  it. Six lines, and not a rule that can drift — a driver that measures like the
  real font and encodes nothing is those six lines in both places or it is
  broken in one, which its own callers show immediately.
  **Invariant:** the sink is CONSUMED by whoever detects and never forwarded.
  The builders (`paragraph`, `heading`, `list`, `codeBlock`) detect at BUILD
  time; `stampText`/`stampTextBlock` detect for a DIRECT page-level draw, where
  the call IS the paint; and `flowTextBlock`/`measureTextBlock`/`wrapLines`
  detect NOTHING, because the engine measures speculatively many times per
  element. `table()` and `page.AddTable` are the two table sites — a cell's
  font comes from `resolveCellStyle`'s cascade and never reaches a flow builder.
  **Note, measured, and TWO of the ten mutations were redundant defences:**
  `paragraphOptions`'s field WHITELIST is said to be what stops a flowed
  paragraph reporting twice — but forwarding `onUndrawable` through it reddens
  NOTHING, because `flowTextBlock` does not fire the sink at all. Adding a fire
  there reddens one case. Two defences for one rule; breaking either alone
  proves nothing, and do not "simplify" either away.
  **Note, measured, and UNOBSERVABLE rather than merely uncovered:** `codeBlock`
  reports the PREFORMATTED text, since that is what reaches the driver — but
  judging the raw text instead reddens nothing, and cannot. `preformat` changes
  only spaces (to U+00A0) and tabs; tabs are excluded as structure either way,
  and every face this suite has encodes space and U+00A0 alike (measured, for
  Helvetica and the embedded Type 1). A font with a glyph for space and none
  for U+00A0 would separate them; none is vendored.
  **Note:** the per-run rule needs TWO faces of DIFFERENT coverage, so it cannot
  be built from the Standard-14 set — all 12 share one WinAnsi table. U+0131
  (dotless i) is the discriminator: WinAnsi has no code for it and
  `NimbusSans-Regular.t1` does. The first fixture for this rule used two
  Standard-14 faces and measured nothing.
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
  **Invariant (`dsw8`):** a cell's height is the SUM OF ITS LINE BANDS, never
  `lineCount * leading`. `measure`'s doc comment said the latter long after the
  code stopped doing it, and that staleness cost a whole misfiled issue — one
  proposing to replace a height model that had already been replaced. A band is
  as tall as its tallest content, so a larger run, or an inline image, grows the
  row on its own.
  **Invariant (`dsw8`):** `CellOptions.atomics` are boxes among the cell's runs
  — an image ON a line of cell text — and they are DISTINCT from
  `CellBuilder.setImage`, which is ONE picture aspect-fit to the whole cell box
  and painted UNDER the text. A cell may carry both, which is asserted.
  **Invariant (`dsw8`), and it is what makes the feature small AND safe:**
  measure and paint share ONE interleaving, `layout.ts`'s `weaveByBeforeRun`.
  `stamp.ts` weaves `ResolvedRun`s to paint and this module weaves bare
  `LayoutRun`s to measure, so the ORDER is the one thing they must agree on;
  a second copy is how a cell comes to be sized against one arrangement and
  drawn with another. Measured: reversing the order in that one function
  reddens both consumers.
  **Invariant (`dsw8`):** `resolveAtomics` lives in `stamp.ts`, not `flow.ts`,
  because THREE callers need it — a paragraph, a list item and a cell — and
  this module cannot reach `flow.ts`: `flow.ts` → `flowtable.ts` →
  `tableauthor.ts`, so that edge would close a cycle. `flow.ts`'s public
  `FlowAtomic` is now an alias of `stamp.ts`'s `AtomicSpec`, so the authoring
  name is unchanged.
  **Note:** auto-fit sees an atomic's width through `textExtents`, and the rule
  is deliberately APPROXIMATE in the safe direction — max-content adds every
  atomic's width, min-content takes the widest as a FLOOR. An atomic is U+FFFC
  to the wrapping engine, a non-space character, so `a<img>b` is truly one
  unbreakable unit and the real min-content can be wider; erring narrow is safe
  because `layoutRuns` CLAMPS an atomic wider than its box, shrinking the
  picture rather than overflowing the column.
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
- **svgserialize.ts** — an inline `<svg>` subtree back to XML markup
  (`zch2.12`). A pure leaf over `htmldom.js` and `htmlforeign.js` that never
  throws. Note the DIRECTION: this is HTML DOM → markup so the SVG IMPORTER can
  read it, and it shares no code with `htmlsemantic.ts` (PDF → HTML) or
  `svgrender.ts` (PDF → SVG).
  **Why it exists:** `addSvgObject` takes SOURCE BYTES and `svgdraw.ts` walks an
  `xml.ts` tree, while the HTML parser produced `HtmlElement`s. There is no path
  between them, so "render it through the existing importer" needs this step —
  which `zch2.12`'s issue treated as free.
  **Invariant:** it UNDOES two tree-construction adjustments, both silent when
  missed. An adjusted foreign attribute is stored under a DISPLAY key with a
  SPACE (`xlink href`, `htmlforeign.ts:87`), which is not a name `parseXml` can
  read; and element and attribute names are ALREADY case-adjusted
  (`linearGradient`, `viewBox`), so they are emitted AS STORED — lower-casing
  them, the obvious move when writing XML from an HTML DOM, breaks every
  gradient and every viewBox.
  **Note:** no `xmlns` is added, verified against the real importer rather than
  assumed — `page.AddSVGObject` renders namespace-less markup, because
  `parseXml` strips namespace prefixes and `svgembed.ts` checks the root name
  only. Adding one would make this a rewrite rather than a round trip.
  **Note:** the output is validated by its CONSUMER. `parseXml` is strict, so a
  serializer bug surfaces as a `PdfParseError` at the parse rather than as a
  silently wrong drawing — which is why the round trip is the test that matters.
  **Invariant (`zch2.12`):** an inline `<svg>` is an ATOMIC, not a box kind.
  It is `display: inline` by DEFAULT, so it never reaches `cssbox.ts`'s
  `boxFor` — `visit` handles non-block-level nodes and only block-level
  children are routed there. A first attempt added a block box kind and
  produced NO box whatsoever for a top-level `<svg>`: body came back with no
  children and an empty report. `AtomicInline.kind` is `'image' | 'svg'`, and
  BOTH walks produce the same atomic — `cssinline.ts` for the inline case,
  `cssbox.ts` for a `display: block` one, which must NOT walk its children
  because that is exactly the leak `zch2.7` closed.
  **Invariant:** `renderSvg` is INJECTED into `cssflow.ts` and called at BUILD
  time. Build time is the whole point: the importer reports what it could not
  draw only when it imports, and `AddHtml` hands `skipped` back before anything
  is placed — `zch2.14`'s timing limit. Both of its lists fold in as
  `construct: 'svg'`, `dropped` when nothing imported and `degraded` otherwise;
  rasterization is `degraded` because it is resolution-bound and its text stops
  being extractable, which is "drawn, but not as specified".
  **Invariant:** `svgFigure` lives in `cssframe.ts` because it PAINTS — the
  split that module already makes for `BoxElement` — and a figure NEVER splits:
  too tall for the column means the next column.
  **Note, measured:** 9 of 12 mutations aimed at these rules redden. Four
  needed the sizing fixtures REBUILT first: rewriting the box test for the
  atomic shape dropped four of the five measured sizing rows, so attribute
  widths, CSS precedence, the percentage rule and the px→pt conversion were all
  unmeasured for a while.
  **Note, measured and NOT covered — three, each recorded rather than
  removed.** Dropping the `svg` row from `elementPolicy` reddens NOTHING: both
  walks intercept an `<svg>` BEFORE the policy is consulted, so the row was
  already dead. It stays removed because leaving it would claim `<svg>` is
  suppressed when it is not, and would silently re-suppress if the interception
  ever moved. `buildSvgForm` ignoring its `size` argument reddens nothing
  either — the size reaches only `resolveViewBox`'s fallback (an `<svg>` with
  neither a viewBox nor width/height attributes) and a rasterized filter's
  device scale, and no fixture asserts either. And the `svg`/`dropped` report
  for a failed import is unreached: no input was found that the serializer
  produces and `parseXml` then refuses, so that path is defensive.
  **Note on the oracle, and it is NONE:** the sizing table is measured against
  Chrome/152 and lives in the spec, but it is NOT in
  `test/fixtures/css-box/`. Five fixtures were added there, regenerated, and
  then found to pin nothing — an `<svg>` is an atomic, so the harness produces
  no row for it and its `if (mine === undefined) continue` skips every one.
  They were reverted; `test/fixtures/css-box/PROVENANCE.md` records why.
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
  **Note (`6t2v.5`), a SCOPE DECISION rather than a gap — do not "finish" it:**
  MULTIMEDIA is out of scope. `/Screen` annotations and `/Rendition` actions
  embed audio and video; almost no viewer honours them and Node has nothing to
  play them with, so no typed constructor will be added. They read back as a
  base `Annotation` and round-trip like any other, which is the whole contract.
  README's Limitations says so, so the absence is stated rather than inferred.
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
- **crypto.ts** additionally owns `CryptKeys` and `isSignatureDict`, the two
  things preserving a document's encryption needs (`0cr3`).
  **Invariant:** the `/Encrypt` dict is COPIED VERBATIM and encryption is never
  RE-DERIVED. `EncryptOptions` needs an owner password, which is hashed into
  `/O` and unrecoverable, and `buildEncryptor` defaults
  `ownerPassword ?? userPassword` — so carrying encryption forward by
  re-deriving would SILENTLY EQUATE the owner and user passwords, a permissions
  downgrade shipped as a confidentiality fix. `buildEncryptorFromKeys` reuses
  the key `buildDecryptor` already computed instead. Confirmed externally: qpdf
  validates the empty password against BOTH `/O` and `/U` on the
  `encrypted-preserved` golden, which a rebuilt `/O` could not satisfy.
  **Invariant:** preserving requires `/ID`. For R≤4 the file key hashes
  `/ID[0]`, and `resolveIds` falls back to a fresh random one when the trailer
  names none — which with a retained key yields a file NOTHING can decrypt.
  `Save` refuses rather than producing it.
  **Invariant:** a signature's `/Contents` is EXEMPT from encryption (32000-1
  7.6.2) in BOTH directions — never encrypted on write, never DECRYPTED on
  read. The read half was missing and PREDATES this work: `decryptObject`
  decrypted it, so any encrypted signed document from any producer was
  corrupted on open. Either half being wrong is silent and yields an
  unverifiable signature rather than an error, which is why the two are
  asserted from opposite sides — the signature must VERIFY while `/Name` must
  NOT appear in cleartext.
  **Note, measured:** the WRITE-side exemption in `makeEncryptor` is reached
  only by re-encrypting a document that ALREADY carries a signature — signing
  builds its dict as raw text and bypasses it — so it reddened NOTHING until
  `test/sign-encrypted.test.ts` grew that case.
- **encrypt.ts** — standard security handler encryption on `Save`
  (`Save({ encrypt })`: RC4, AES-128, AES-256), the write counterpart to
  crypto.ts.
- **xmp.ts** — read (`GetXmp`) and build (`SetXmp`) the `/Root /Metadata` XMP
  packet with a dependency-free scan, mirroring shared fields with `/Info`.
  **Invariant (`ugxr`):** an attribute's value is matched with `*`, never `+` —
  a present-but-EMPTY property is not an absent one. Every value regex here and
  in `pdfavalidate.ts`'s `pdfaIdValue` and `pdfxvalidate.ts`'s `xmpVersion`
  follows it. **Note where the bug hid, because it is the sharpest example in
  this repo of one module answering a question two ways:** `scalar` had always
  matched `([^"]*)`, so `pdf:Producer=""` read back as `''`, while the five
  IDENTIFICATION fields used `+` and read `''` as absent. The two forms only
  diverge where ABSENCE IS ITSELF THE DECLARATION — ISO 19005-4 6.7.3-3 spells
  the PDF/A-4 base conformance by genuine absence — so a file declaring
  `pdfaid:conformance=""` passed `ValidatePdfA('4')`. Everywhere else an empty
  value fails the same comparison an absent one did, which is why widening
  changes MESSAGE TEXT and nothing else across parts 1-3 and PDF/X.
  **Invariant (`ugxr`):** a numeric identification field reads an empty value as
  **NaN**, never `Number('')`'s 0 — a 0 reads as a document CLAIMING part 0.
  Junk (`part="x"`) already yielded NaN, so empty and junk get ONE rule.
  **Note, measured:** the five reads go through `idValue`/`idNumber` rather than
  ten inline regexes, because five copies of the widened pattern is how they
  would drift apart again — which is exactly how this bug existed.
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
- **artifact.ts** — `page.Artifacts`: the `/Artifact` marked-content scopes a
  page declares (32000-1 14.8.2.2). The READ side of a vocabulary this library
  previously only WROTE — `wrapArtifact`, `PageGraphics.BeginArtifact`, the
  `artifact: true` option on every vector producer, `AutoTag`'s undescribed
  images.
  **Invariant:** it MEASURES NOTHING ITSELF. Glyph, image and path extents are
  `text.ts`'s answers, subscribed to through `visitContent` — which is also the
  one owner of the marked-content stack, so "which scope is open" is decided
  once. A private walk here would need the whole text state machine (fonts,
  `Tf`, `Tm`, `TJ`) to place a glyph, and would be a second answer to a
  question `GetPaths` and `GetText` already agree on. That is what `zch2`-style
  focused walkers like `paths.ts` do NOT do, and the difference is the reason:
  `paths.ts` re-derives geometry it alone needs, where an artifact's extent is
  geometry three other modules already compute.
  **Invariant (`text.ts`):** the three ink events carry `artifactScope`, the
  ADDRESS of the innermost open artifact, beside the pre-existing `artifact`
  boolean — that boolean says THAT content is decoration and cannot say WHICH
  scope declared it, so attribution is impossible from it. The precedent is
  `PathEvent` gaining `mcid`/`artifact` for `hdsx` so `structvalidate.ts` could
  subscribe at all. `ArtifactEvent` fires at the OPENING op, which is what
  makes an artifact enclosing NOTHING reportable — the one shape a consumer
  reading only ink events provably cannot see.
  **Invariant:** a declared `/BBox` wins and is reported VERBATIM, never pushed
  through the CTM. 14.8.2.2 says default user space, so a producer is taken at
  its word; transforming would be a second rule that is wrong whenever a `cm`
  merely preceded the `BMC`. The residue — a `/BBox` declared INSIDE a form,
  in that form's own coordinates — is documented in README as a limit rather
  than guessed at. Absent a declaration the extent is MEASURED, and
  `bboxSource` is what says which of the two a caller is holding.
  **Invariant:** an outer scope's measured extent UNIONS its nested scopes' —
  an inner artifact is inside the outer one geometrically as well as
  syntactically. One reverse pass over the records does it, which is sound
  because a parent always opens before its child.
  **Invariant:** the scope key joins `path`, `streamIndex` and `opIndex` on a
  separator, because concatenating them raw COLLIDES: `['A']`/0/12 and
  `['A0']`/1/2 both spell `A012`. Pinned by a fixture whose page and form
  artifacts both sit at stream 0, op 0.
  **Note, measured:** all 17 mutations aimed at this module and its `text.ts`
  half redden. THREE needed fixtures built for them first, and each names a
  real gap rather than a spurious mutation — no fixture had an IMAGE or TEXT
  inside an artifact (every one drew paths), none put a non-edge name in
  `/Attached`, and none made two scopes collide on address. Do not read a
  path-only fixture as covering the glyph or image attribution.
  **Note:** `Remove` is deliberately absent and the writer is unchanged —
  teaching `wrapArtifact` to declare a `/Type` would move bytes in every tagged
  document we write, and no caller has asked.
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
  faces a file holds. Same seam `colorimage.ts` takes `resolve`/`inflate`
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
  **Note (`l1my.7`), and the gap it replaced was total:** there IS now a real
  suitcase, `test/fixtures/fonts/LiberationSans.dfont` — four OFL Liberation
  faces wrapped by FONTFORGE, a container writer we did not write, so its
  resource map is somebody else's reading of Inside Macintosh rather than a
  second copy of ours. **Apple's own suitcases CANNOT be vendored** (`Monaco`,
  `Geneva`, `Courier` are Apple copyright with no grant — `RSWOP.icm`'s
  objection, and unlike a golden TABLE our tests need the BYTES), which is why
  the payload is one the repo already licenses; the payload's identity does not
  matter, since what is under test is the container around it.
  **Note, measured, and TWO of the five rules are still NOT anchored — no
  FontForge output can anchor them:** it emits `sfnt` as type 0 and `FOND` as
  type 1, so reading the type count RAW still yields type 0, and taking type 0
  BLINDLY still lands on `sfnt`. Both mutations survive the real file and are
  held by `dfont.test.ts` alone (9 and 2 cases), whose hand-built suitcases can
  order the types freely *because* they are hand-built. The other three rules
  redden on the real file at 2, 5 and 2. A real Apple suitcase, carrying `FOND`
  and often `NFNT` and `POST`, might order its types the other way — that is the
  whole of what remains, where before it was the whole rule set.
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
  **Invariant (`72nc.1`):** PDF/A-4 has NO accessibility level. ISO 19005-4 has
  no clause 6.8, so `'4a'` is *unrepresentable* rather than unsupported, and
  `validatePdfA`'s `lvl === 'a'` PDF/UA chain provably cannot fire at part 4.
  Expect "why doesn't PDF/A-4 check tagging" to be filed as a bug; it is the
  standard's decision, and tagging is declared separately through PDF/UA.
  **Invariant (`72nc.1`), and it is the trap:** PDF/A-4's rule set is NOT a
  superset of parts 1–3 — it INVERTS four rules, which must go SILENT at part 4.
  `/ToUnicode` has no presence requirement (only a content constraint if one
  exists); `/CIDSet` and `/CharSet` have no rule at all; JavaScript actions are
  PERMITTED; and `/Info` is near-banned, so the `/Info`-versus-XMP consistency
  check has nothing left to compare. A document that fails at `'2u'` can pass at
  `'4'` for the same reason. The `/ToUnicode` one contradicts the widespread
  "PDF/A-4 ≈ PDF/A-2u" folklore.
  **Invariant (`72nc.1`):** each inversion is pinned by a CROSS-PART PAIR in
  `test/pdfa4-validate.test.ts` — the fixture must report at its part-1/2/3 level
  AND stay silent at `'4'`. A single-part assertion provably cannot tell a rule
  that correctly went quiet from one that was never wired up, which is the
  failure mode this file is otherwise most exposed to. **Note the `/CIDSet` pair
  reads `Issues` rather than `Errors` on BOTH halves:** that rule is an error
  only at part 1 and a warning at parts 2/3, so an `Errors`-only assertion finds
  nothing at `'2b'` and measures nothing. The first version did exactly that.
  **Invariant (`72nc.1`):** the part-4 checks that ALSO apply to parts 1–3
  (`/Requirements`, `/NeedsRendering`, `/PresSteps`, `/TR`, `/HTO`, halftone
  types, `/Alternates`, `/OPI`, `BitsPerComponent`, filespec `/F`+`/UF`+
  `/AFRelationship`) are gated at `ctx.part === 4` DELIBERATELY, tracked as
  their own issue. Not tidiness: `ConvertToPdfA` re-runs `ValidatePdfA` and
  mirrors it into `unresolved`/`passed`, so widening a rule to parts 1–3
  silently changes the outcome of a shipped feature. `test/pdfavalidate.test.ts`
  and `test/pdfaconvert.test.ts` passing UNEDITED is the fence for that claim.
  **Note on the anchor, and it is a TRANSCRIPTION rather than a differential
  test:** the part-4 rules come from veraPDF's published validation profiles
  (`veraPDF/veraPDF-validation-profiles`, `integration` branch,
  `PDF_A/PDFA-4{,E,F}.xml`, fetched 2026-09-04). veraPDF is not installed and a
  profile is a rule list rather than bytes, so unlike `test/fixtures/pdfx/` there
  is NO runnable oracle. The suite proves the implementation agrees with our
  reading of the profile; it proves nothing about whether either matches
  ISO 19005-4. Do not read a green suite as conformance evidence.
  **Note, three deliberate divergences, each recorded in the source:**
  `psXObjectRule` fires at part 4 though the profile has no such rule, because
  PDF 2.0 removed PostScript XObjects — a hit can only be a real defect.
  `ocConfigRule` implements 6.10-1 and 6.10-2 but not 6.10-3 (`/Order` naming
  every OCG). And `transparencyBlendingSpaceRule` detects transparency only from
  a page's own `/Group /S /Transparency`, never from an ExtGState soft mask,
  because `extGStates()` is document-wide.
  **Note, measured, and THREE fixtures had to be rebuilt because the obvious one
  measures nothing — this is the densest cluster of the redundant-defence trap
  in the repo.** A `/PieceInfo` case whose `/Info` carries a `/Title` also trips
  the "only `/ModDate`" branch, so the `/PieceInfo` mutation stayed green; it
  needs an `/Info` holding ONLY `/ModDate`. A halftone dictionary carrying both
  a bad type AND a `/HalftoneName` passes with either branch deleted, so the two
  need separate dictionaries. And an embedded-file spec missing `/UF`,
  `/AFRelationship` AND `/Subtype` still reports with any single branch deleted,
  so `noUf` and `noMime` each omit exactly one thing. Every other mutation
  across the nine tasks reddened first time.
  **Invariant (`72nc.2`):** part 4 joins the ONE `PASSES` array, gated with
  `if (ctx.part === 4)`. A second `PASSES_A4` table would duplicate the ~8
  passes identical across eras, and "two copies is how they come to disagree"
  is this repo's most-recorded failure.
  **Invariant (`72nc.2`), and it is the ordering mistake the design exists to
  prevent:** `identificationPass` runs BEFORE `infoPass`, which is why the
  latter is LAST in `PASSES`. It reads `/Info` through `GetMetadata()` to
  mirror title, author, subject, keywords and `/ModDate` into XMP; strip
  `/Info` first and the mirror silently comes out empty — a loss invisible in
  the converted file, which validates either way. Measured: moving `infoPass`
  to the front reddens 8 cases.
  **Invariant (`72nc.2`), and the design got this half WRONG:** `infoPass` has
  TWO branches, because reducing `/Info` to `/ModDate` is legal ONLY beside a
  catalog `/PieceInfo`. `infoRestrictionRule` reports a present `/Info` without
  one whatever the dictionary holds — `test/pdfa4-validate.test.ts` pins
  exactly that, with a `/ModDate`-only `/Info` — so a reduce-only pass could
  never reach `passed === true` for a document that has no `/PieceInfo`, which
  is essentially every real document. With a `/PieceInfo` it reduces; without
  one it DELETES, which discards nothing because the mirror already ran.
  **Note (`72nc.2`), and it is why the pass is mandatory rather than
  conditional:** `SetXmp` calls `ensureInfo()` unconditionally, so
  `identificationPass` CREATES an `/Info` for a document that had none — and an
  empty `/Info` with no `/PieceInfo` is still an `InfoRestriction` error.
  Measured on the clean part-4 fixture, whose `/Info` is absent by design.
  **Invariant (`72nc.2`):** `preserve: ['info']` is the one new
  `ConvertCategory`. Everything else part 4 adds is either non-destructive
  normalisation or falls under a category that already exists — which is also
  why `embeddedFilesPass`'s part-4 half is NOT gated on `'embeddedFiles'`: that
  category names destructive removals, and part 4 never removes an attachment.
  **Invariant (`72nc.2`):** a MIME `/Subtype` is built through `name()` from the
  RAW text and escaped by the serializer (`/application#2foctet-stream`).
  Pre-escaping double-escapes; a bare `/application/octet-stream` is not one
  name. Asserted on saved bytes.
  **Invariant (`72nc.2`):** `versionPass` RAISES to `2.0` at part 4 where parts
  1-3 lower to a ceiling — 6.1.2-1 is an exact major, so a perfectly good PDF
  1.7 file is simply not PDF/A-4.
  **Note (`72nc.2`):** `TransparencyBlendingSpace` gets no pass and needs none.
  `outputIntentPass` adds a PDF/A output intent whenever there is none, and
  6.2.9-2 fires only when there is none, so the rule is unreachable after
  conversion by construction. Asserted directly so it reads as reasoning rather
  than as a pass somebody forgot.
  **Note (`72nc.2`), measured, and it is the sharpest instance here of an
  assertion that cannot see what it claims to:** the mutation writing
  `pdfaid:conformance=""` at the part-4 base level reddened NOTHING at first.
  Both `pdfaIdValue` and `readXmp` match `["']([^"']+)["']`, so an EMPTY
  attribute reads back as ABSENT to the validator and to `GetXmp` alike, and
  `expect(xmp.pdfaConformance).toBeUndefined()` passes either way. The case
  asserts the emitted PACKET now. That the validator cannot see an empty
  conformance is a real gap in `72nc.1`'s rule and is filed separately rather
  than widened here.
  **Note on the oracle (`72nc.2`), and it is sharper than it was for
  validation:** there is NONE that runs here. Conversion is verified against
  our own validator, itself a transcription of veraPDF's profiles, so the two
  halves now agree with each other BY CONSTRUCTION. Do not read a green suite
  as evidence that a certified validator would pass the output.
  **Note, measured:** all 16 mutations aimed at `72nc.2` redden something, the
  conformance one only after the packet assertion above was added.
  **Invariant (`pjy7`):** a rule applies at exactly the parts whose veraPDF
  profile carries it, and cites THAT standard's clause through `partClause` —
  the same test is numbered 6.2.4 in 19005-1, 6.2.8 in -2/-3 and 6.2.7.1 in -4,
  so a widened rule that keeps citing -4 reports the right defect against the
  wrong document. Nine rules widened; `/HTO`, `ocConfigRule`,
  `toUnicodeContentRule`, `requirementsRule`, `alternatePresentationsRule`,
  `permissionsRule`, `infoRestrictionRule`, `embeddedFileSpecRule` and the
  surplus-output-intent count stay part-4-only, each because the older profiles
  carry no such test.
  **Invariant (`pjy7`), and it reads backwards:** parts 1-3 are STRICTER than
  part 4 on Widget actions. ISO 19005-1 6.6.1-3/6.6.2-1 and -2/-3 6.4.1-1 ban
  a Widget's `/A` AND its `/AA`; 19005-4 6.4.1-1 bans `/A` alone and 6.6.3-1
  exempts the additional actions "whose triggers are the form's". Widening part
  4 to match reports a document ISO 19005-4 permits.
  **Invariant (`pjy7`):** `permittedBpc` excludes 16 at part 1 — PDF 1.4 had no
  16-bit images — so this is the ONE check that can fail a document at an
  EARLIER part than it passes at a later one, and the one genuinely new failure
  the backport introduced.
  **Invariant (`pjy7`):** `destProfileRefExempt` — parts 2/3 permit
  `/DestOutputProfileRef` on a `GTS_PDFX` intent (their test is
  `S != 'GTS_PDFX' || …`) and part 4 does not. Those standards allow a PDF/X
  intent beside the PDF/A one, and the key is legal there.
  **Invariant (`pjy7`):** the converter passes read the SAME helpers the rules
  do (`permittedBpc`, `destProfileRefExempt`, `widgetActionKeys`, exported from
  `pdfavalidate.ts`). A pass deciding its own parts is how a converter comes to
  fix what the validator does not report — which happened anyway for
  `/NeedsRendering`, whose rule widened while its pass stayed gated, and was
  caught only by the messy-document acceptance case rather than by any
  single-rule test.
  **Note (`pjy7`):** the passes are `graphicsKeysPass`, `outputIntentKeysPass`,
  `annotKeysPass` and `catalogKeysPass`; only `ocConfigPass` is still
  part-4-only throughout. `catalogKeysPass` scopes PER KEY, since
  `/NeedsRendering` backports and its three neighbours do not.
  **Note (`pjy7`), and it is the sharpest example here of a bug hiding behind
  a fixture gap:** widening the rules gave part 1 an ExtGState for the first
  time, which immediately exposed a PRE-EXISTING false positive in
  `transparencyRule` — `ctx.R(dict.get('SMask'))` returns `null` for an absent
  key and `null !== undefined`, so every part-1 ExtGState reported a soft mask
  it did not have. The same trap this file already records two entries up for
  PDF/X. Presence is tested on the RAW dict now.
  **Note, measured:** all 15 mutations aimed at `pjy7` redden something,
  including both directions of each of the three divergences.
  **Note on the fence, and it differs from `72nc.1`'s and `72nc.2`'s:** four
  pre-existing cases moved, and all four were the same category — cases
  asserting the GATING this issue reverses, rather than stale fixtures or the
  backport reaching too far. Each was repointed at what genuinely stays
  part-4-only rather than deleted, so those files still record where the
  boundary sits.
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
  `colorimage.ts`, so a greyed document cannot mask differently from the
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
- **xfapacket.ts**, **xfatemplate.ts**, **xfadata.ts**, **xfageom.ts**,
  **xfaconvert.ts** — XFA read and flatten to AcroForm (`6t2v.3`),
  `doc.ConvertXfaToAcroForm()`. Four pure modules and one that touches a
  `Document`, the `svgdraw.ts`/`svgembed.ts` split: `xfapacket.ts` decodes
  `/AcroForm /XFA`, `xfatemplate.ts` models the `template` packet's field set,
  `xfadata.ts` binds values out of `datasets`, `xfageom.ts` is the arithmetic,
  and `xfaconvert.ts` alone allocates.
  **The finding the whole feature rests on, because the issue was filed without
  it:** XFA geometry is not all-or-nothing. `6t2v.3` proposed "read plus
  flatten, minus the dynamic layout engine", which is close to an empty set —
  a static or hybrid form ALREADY carries a complete AcroForm this library
  reads today, so there is nothing to flatten, while a dynamic form carries no
  field geometry anywhere, so there is nothing to flatten TO. What rescues it
  is that a `<subform>` carries a `layout` attribute and `layout="position"`
  STATES absolute `x`/`y`/`w`/`h` on its children. So static and XFAF forms
  have their rects in the template, and only the flow layouts need the engine.
  **Invariant:** `xfageom.ts` imports NOTHING — the `floatstack.ts` /
  `booklet.ts` / `tablespan.ts` split, for their reason: geometry that is
  silently wrong when reversed must be testable from numbers with no PDF built.
  `xfatemplate.ts` and `xfadata.ts` import `xml.js` alone; `xfapacket.ts` takes
  `resolve`/`inflate` as ARGUMENTS, the `colorimage.ts` seam. None of the four
  throws.
  **Invariant: `px`, `pc` and `em` are REFUSED, not converted.** Their readings
  are not transcribed from the XFA specification here, and this repo's own rule
  is that a number nobody has checked against the standard does not ship —
  `ccitt-tables.ts` and the JBIG2 SLTP constants set that. A wrong `px` moves an
  A4 edge by tens of points while still rendering a plausible page, which is the
  failure shape the whole design guards against. `pc` is very probably 12pt, and
  that is exactly why it must not ship on recall. A refused unit degrades the
  field and is reported. **Do not "fix" this from memory**; only a transcription
  with the clause cited beside the constant may add one.
  **Invariant: the medium must agree with the page.** Before any field on a page
  is given a rect, the `<pageArea>`'s declared `<medium>` is compared against
  that page's CropBox — `orientation="landscape"` swapping short and long — and
  a mismatch over **1pt on either axis** degrades EVERY field on the page. This
  is the check that makes the rest trustworthy: it asserts against a number we
  did not compute, so one comparison catches a unit error, an orientation swap
  and a wrong page mapping alike. An ABSENT medium is a refusal, not a pass —
  there is nothing to check against. 1pt is tight enough that the smallest unit
  error cannot pass and loose enough to absorb `8.5in` rounded to three
  decimals. **Measured:** neutering it reddens 3.
  **Invariant: never an approximate rect.** Every geometry failure — an unknown
  unit, a flowed ancestor, a medium mismatch, a `rotate`, an unresolvable page —
  yields a geometry-less field PLUS a report entry. Nothing estimates a position
  from a sibling, a caption or a flow order.
  **Invariant, and it is the one interpretation this work adds beyond the
  design — do not read it as arbitrary:** a field earns geometry only when EVERY
  container in its chain is `layout="position"`, and **the chain starts BELOW
  the subform carrying the `<pageSet>`**. LiveCycle's root `<subform>` is
  routinely `layout="tb"`, because that flow breaks PAGES rather than placing
  FIELDS — so read from the document root, the rule degrades every field of
  every LiveCycle form and the feature converts nothing. The rule is then
  applied to that chain verbatim, including to unknown layouts, which are
  refused as an allowlist the way `content.ts`'s `NON_MARKING` is.
  **Note this is now MEASURED, not merely reasoned:** IRS f1040's root subform
  is `layout="tb"`, and the oracle places 151 fields from it. Read from the
  document root it would place zero.
  **Invariant:** the synthesized name IS the SOM expression, occurrence indices
  included (`form1[0].Page1[0].f1_01[0]`). Not cosmetic: that is exactly what
  LiveCycle writes into a hybrid's `/AcroForm`, so reconciling the two halves is
  name EQUALITY rather than a heuristic, and an FDF exported from a converted
  document stays interchangeable with Acrobat's. An anonymous container is
  transparent to the path, as SOM defines it.
  **Invariant:** the `save="1"` `<items>` list is the EXPORT half and `/Opt` is
  written through `choiceopt.ts`, the one owner of that grammar. **Note the
  fixture for it must put the DISPLAY list first**: with `save="1"` on the first
  list, "the save list" and "the first list" are the same list and hard-coding
  the halves by position reddens NOTHING. Measured — it passed that way.
  **Invariant:** values come from `datasets` and the template `<value>` is
  `/DV`. Conflating them destroys the difference between what a form was
  authored with and what someone entered, which for the filled archived forms
  this feature exists to open is the entire content. A fixture whose default and
  datum AGREE cannot see the swap.
  **Note, and the first implementation had this bug:** a `<value>`'s content is
  in its TYPED CHILD (`<text>`, `<integer>`, `<decimal>`, `<exData>`), and
  `XmlNode.text` is the DIRECT text content — so the obvious `valueEl.text` is
  empty for every real form and silently loses every default in the document.
  **Invariant:** `xfapacket.ts` owns the `parseXml` throw boundary. `parseXml`
  throws `PdfParseError` and four other callers depend on that strictness, so
  damage becomes a value HERE rather than by loosening `xml.ts` —
  `markdown.ts`'s and `htmltoken.ts`'s "damage is a value, never control flow",
  applied at the boundary. A per-packet failure is MANDATORY rather than tidy:
  the XDP wrapper's `preamble` and `postamble` are text fragments, so they never
  parse, and refusing the whole `/XFA` for them would refuse every array-form
  document in existence.
  **Invariant: plan fully, then apply.** `buildXfaPlan` classifies every field
  ALLOCATING NOTHING — `formcreate.ts`'s own rule scaled from one field to a
  document — so a form we cannot convert leaves the file byte-identical, which
  is asserted by saving before and after.
  **Invariant:** a positioned field goes through `createField` and an
  `<exclGroup>` through `addRadioGroup`, so the widget dict, the `/AP`
  generation and the `/Annots` wiring are reused rather than rewritten. A bare
  field is appended through `resolvePath(...).container.push` and **NOT**
  `appendField`, which appends to `/AcroForm /Fields` directly and would flatten
  every hierarchical SOM path onto the root.
  **Invariant:** an `<exclGroup>` is ALL-OR-NOTHING. If any member lacks
  geometry the whole group goes bare — a radio group with some widgets placed
  and some not is not a degraded control but a broken one.
  **Invariant:** `dataOnly` distinguishes "converted to data and renders
  nothing" from "converted NOTHING at all", which are different answers. It is
  recomputed AFTER the apply loop, or a field that fell back to bare there
  leaves the flag saying the document renders when it does not.
  **Invariant:** `/XFA` and `/NeedsRendering` go only when something actually
  converted, because removal is one-way and discards the only description of
  everything refused. It destroys nothing immediately — it orphans the packet
  streams and `Save()`'s mark-sweep drops them, so a caller who dislikes the
  report can simply not save. **Note the guard needs a fixture that PLANS
  entries which then all FAIL**: the obvious "converted nothing" document
  returns early, before the removal is reached, and leaves the mutation green.
  **Invariant:** exactly ONE throw, `UnsupportedFeatureError` on a signed
  document, and it runs BEFORE the plan is built so a rejected call does no work.
  `docmdp.ts` permits `/AcroForm /Fields` to change for FILLING
  (`ACROFORM_ALLOWED`), and adding two hundred fields is not filling — a
  certification would read as violated, so refusing is honest where producing a
  document whose signature silently fails is not.
  **Note, measured, and it covers NOTHING:** the positioned-to-bare fallback in
  the apply loop reddens nothing, structurally rather than for want of a
  fixture. Of everything `createField` throws on, the plan phase has already
  excluded all but a path conflict, and a conflict fails `applyBare` for the
  same reason. Retained as defence — the plan phase's guarantees are the only
  thing making it dead.
  **Note on scope, each deliberate:** no dynamic layout engine, no approximate
  geometry, no XFA scripting (`<validate nullTest>` is read as a FLAG, never
  run), no writing XFA back, and `<signature>`/`<imageEdit>`/`<barcode>` are
  refused and reported rather than synthesized — the signature refusal matching
  `formfield.ts`'s existing rule that a signature field is not creatable.
  **Note:** `pdfaconvert.ts` is untouched. It deletes `/XFA` outright today
  (`pdfaconvert.ts:452`), so the useful order is `ConvertXfaToAcroForm` THEN
  `ConvertToPdfA` — the fields survive as a real AcroForm and the PDF/A rule is
  satisfied for free. That is documentation; touching the converter would move
  existing bytes and tests for no gain.
  **Note, a consequence rather than a change:** `drprune.ts` skips any document
  carrying `/XFA` (`drprune.ts:219`), because an XFA packet can name `/DR` faces
  no scan reads. A converted document has no `/XFA`, so it becomes prunable.
  **Invariant, and the ORACLE FOUND IT — the design missed it entirely:** a
  field's widget covers the field box MINUS its `<caption>` reserve, on the side
  `placement` names (default left; `presence="hidden"` reserves nothing). A
  caption is the LABEL drawn beside the input, and LiveCycle's own `/AcroForm`
  places the widget over the edit region alone. Measured on IRS f1040:
  `f1_01` is 280.8pt wide with `reserve="68.0156mm"` (192.8pt), and Adobe's
  rect is exactly 88pt. Ignore it and every captioned field is drawn across its
  own label — worst error 229pt before the fix, 12pt after. A reserve that
  swallows the field, or a `placement` outside the four, DEGRADES rather than
  emitting a rect nobody can justify.
  **Invariant (`mw1m`), the SECOND thing the oracle found, and it REVERSES the
  bug it was filed as:** the remaining point-or-two is the field's own
  `<margin>` insets, and the `<border>` contributes NOTHING. That bug supposed
  the half-point was "a 1pt border the widget is inset by half of"; it is
  `topInset="0.1764mm"` read literally. What settles it is a SWEEP rather than
  one field — over all 54 distinct `textEdit` declaration shapes in f1040 the
  width error was exactly `leftInset + rightInset` and the height error exactly
  `topInset + bottomInset`, with NO exception, while border edge thickness
  varied independently across those same rows and moved nothing (`f2_01` carries
  a visible `0.3528mm` edge and matches Adobe exactly). Worst error 12pt → 6.4pt
  and EXACT matches 53 → 105 of 151. Do not add a border inset back without a
  corpus that shows one.
  **Note the margin is the field's DIRECT `<margin>` child.** A real LiveCycle
  field carries a SECOND one inside `<ui><textEdit>` — f1_03 carries both, the
  nested one empty — so a search of the subtree drops every inset in the form.
  Measured: reading the nested one reddens 5.
  **Note what the corpus provably CANNOT say:** the ORDER of the caption and
  margin subtractions. Both take fixed amounts off named edges, so the rect is
  identical either way, and f1040 never pairs a caption with an inset on the
  SAME edge; only the two refusal guards differ, each testing the room left at
  its own step. Do not write an ordering invariant here.
  **Note, measured, and it is why the oracle gained an EXACT count beside its
  1pt bound:** a 1pt bound is BLIND to an inset rule that is merely close.
  Applying the insets 0.1pt short leaves `within1` passing and collapses the
  exact count from 105 to 7 — so the bound alone would have accepted a wrong
  rule that looked right.
  **Invariant (`17vo`), the THIRD thing the oracle found:** a `<checkButton
  size>` states the BUTTON's own box, which is smaller than the field's, and
  the widget is that button rather than the edit region it sits in. Every one
  of Adobe's 54 button rects across BOTH vendored forms is exactly 8x8 for
  `size="2.8222mm"`, where the reduced field box is commonly 12x12 — so a
  converted checkbox was drawn half again too large. An ABSENT size leaves the
  edit region standing rather than inventing a default, which is the same
  refusal `px`/`pc`/`em` get; a size larger than its region CLAMPS to it,
  because a button that grew past the field would overlap whatever sits beside
  it.
  **Invariant (`17vo`), and the HORIZONTAL half is MEASURED rather than
  derived — it is not one default but TWO:** no field in either form states
  `hAlign`, so every observed case is the default, and a caption on the RIGHT
  puts the button flush LEFT while a caption on the left — or none at all —
  puts it flush RIGHT. What settles it is fw9, a form we do not even PLACE
  (its `pageArea` count cannot be matched) but whose Adobe rects are still in
  its `/AcroForm`: three of its buttons share `x="14.4"` and all three rects
  begin at exactly 73.0, and of the four pairings only this one makes a
  caption-right field and a caption-less one land on the same edge. It then
  reproduces all 8 of that form's buttons on BOTH axes from a single page
  origin of 57.6. Vertical placement is the field `<para vAlign>`, whose two
  non-default values are both in the corpus (f1040's `c1_1` is `bottom`, the
  rest `middle`).
  **Note the `<para>` is the FIELD's direct child**, never the one inside
  `<caption>` — `c1_1` carries both and they are free to disagree. Same
  direct-child rule the margin follows; measured, reading the caption's
  reddens 2.
  **Note what the corpus does NOT contain, so these are unmeasured:** a stated
  `hAlign` (honoured, and it outranks the default), a caption placed `top` or
  `bottom`, and a LEFT caption with a non-zero reserve. The last two fall under
  the `right` default by the same rule.
  **Note, measured, and it was a redundant defence until the test was fixed:**
  `buttonSize` is read only for a `checkButton` ui, AND `xfaconvert.ts` calls
  `buttonBox` only for that kind — so breaking either alone proves nothing.
  The template test has to put a `size` on a `<textEdit>` for the parse-side
  guard to be measurable at all; with a bare `<textEdit/>` the read returns
  undefined either way and the mutation stayed green.
  **Note on the oracle, and it is REAL:** `test/fixtures/xfa/` holds two hybrid
  LiveCycle Designer 6.5 forms (IRS f1040 and fw9, US federal works). A static
  XFA form carries TWO INDEPENDENT descriptions of one field set — the template,
  and the `/AcroForm` LiveCycle generated from it — so `test/xfa-real.test.ts`
  strips `/AcroForm /Fields` in a copy, converts from the template ALONE, and
  compares names, types and RECTS against numbers we did not compute. It
  reproduces all 199 of f1040's names exactly, and since `17vo` ALL 151 placed
  rects EXACTLY — worst 0.0006pt, which is floating-point residue from the
  mm-to-pt conversions and nothing else. It is what CONFIRMED the layout-chain
  reading above: f1040's root subform is `layout="tb"`, so read from the
  document root the positioned route would place ZERO fields, and it places 151.
  **Note the assertion is an EQUALITY now**, and it fences three rules at once:
  break the caption rule and the count collapses to about 1, the margin rule
  and it falls to 53 (worst 12pt), the check-button rule and it falls to 105
  (worst 6.4pt).
  **Note fw9 is an ORACLE TOO, for the geometry it refuses to place.** We
  decline that form (its `pageArea` count cannot be matched), so no test
  compares our rects there — but its `/AcroForm` still holds Adobe's, and they
  are what settled `17vo`'s horizontal rule and independently confirmed the 8x8
  size. A form in the `dataOnly` path is still evidence about the arithmetic.
  **Its ceiling, and PROVENANCE states it:** ONE producer, so this is evidence
  for the forms it covers and NOT conformance — no second XFA implementation
  arbitrates our output. Positioned layout only. NO residual geometry rule
  remains.
  `px`/`pc`, non-`topLeft` anchors and `<occur>` appear in neither fixture and
  stay builder-covered only.
- **viewerprefs.ts** — the catalog `/ViewerPreferences` dictionary, 32000-1
  Table 150 in full (`72nc.3`): how a producer says a document should OPEN and
  PRINT. A leaf importing `Document` as a TYPE only, `docaction.ts`'s
  arrangement, so every rule is drivable from a hand-built catalog. It never
  throws on READ.
  **Note (`6t2v.5`), a SCOPE DECISION and the reason this module is the whole
  of "printing":** there is NO printing subsystem and there will not be one.
  Java's `PdfPrinterSettings`/`PrintPaperSize`/`DuplexKind` exist because they
  map onto `java.awt.print`, and Node has nothing to map onto — driving a
  device is the host application's job. What a DOCUMENT may say about printing
  is print INTENT, which is exactly the seven Table 150 entries here
  (`PrintArea`, `PrintClip`, `PrintScaling`, `Duplex`, `PickTrayByPDFSize`,
  `NumCopies`, `PrintPageRange`). Expect "add printing" to be proposed; the
  answer is that it already ships, spelled as intent. README says so too.
  **Invariant:** it is the ONE owner of the dictionary. `/DisplayDocTitle` was
  reachable before this module and its ensure-the-dict dance had been
  hand-rolled in THREE places (`document.ts`, `autotag.ts`, and through the
  property in `pdfuaconvert.ts`) — which is how three callers come to disagree
  about whether an empty `<< >>` may be left behind. `Document.DisplayDocTitle`
  keeps its signature, since PDF/UA reaches for exactly that flag, and delegates.
  **Invariant:** the getter reports only what the document STATES. An unstated
  entry is `undefined`, never the spec default — the present-versus-absent rule
  `parseSimpleWidths` records for `/MissingWidth`, and the reason a stated
  `false` stays distinguishable from silence. Defaulting also makes a round trip
  write keys the document never had.
  **Invariant, and the two halves only work together:** READ LENIENTLY, WRITE
  NARROWLY. A value of the wrong type, a name outside its enumeration or a
  malformed `/PrintPageRange` reads as `undefined` rather than throwing
  (`GetXmp`'s rule); the merge then touches ONLY the keys the update states, so
  what the reader declined is still in the file afterwards. Lenient reading
  alone is how a read-modify-write comes to strip PDF 2.0's `/Enforce` — which
  is deliberately not modelled here, being Table 150 of no edition and a
  constraint on a VIEWER rather than a preference.
  **Invariant:** `undefined` leaves, `null` deletes, a value sets —
  `MetadataUpdate`'s convention, not a second one.
  **Invariant:** `/PrintPageRange` is inclusive 1-based `[first, last]` PAIRS,
  not the flat wire array. An odd-length or descending flat array is exactly the
  mistake that produces a plausible wrong PRINT JOB rather than an error; the
  writer flattens and the reader re-pairs.
  **Note the deliberate ASYMMETRY on that range:** the writer range-checks each
  pair against `doc.Pages.length` (`setOpenDestination`'s rule) while the reader
  does not. A document split out of a longer one legitimately carries a range
  past its own end, so reading reports what the PRODUCER said where writing must
  not manufacture a range no dialog can honour. It reads like an inconsistency,
  so it is asserted directly.
  **Invariant:** the whole update is validated BEFORE a single key is written,
  so a rejected call leaves the document byte-identical (`formcreate.ts`'s rule).
  `TypeError` for the wrong KIND of thing, `RangeError` for outside the allowed
  SET — the same split. Measured load-bearing: validating as we write reddens
  four cases.
  **Note, MEASURED, and it is the redundant-defence trap in miniature:** THREE
  guards keep an empty `<< >>` out of the catalog — the empty-update return, the
  pure-delete return and the prune — and ANY TWO can be deleted with
  `test/viewer-prefs.test.ts` still green. Only removing all three reddens. They
  are kept because they answer different questions: the first two also decline to
  call `markModified()` for a call that changed nothing, which nothing in the
  suite can see, and only the prune reaches the delete-the-last-of-several case.
  Breaking any one alone proves nothing — do not read the green suite as
  covering any of them, and do not "simplify" one away.
  **Note, measured, and two more that cover NOTHING.** `readPageRange`'s
  odd-length test is redundant and provably CANNOT be otherwise: an odd array
  always ends unpaired and `doc.resolve(undefined)` is `null`, which
  `isPositiveInt` rejects — while the `length === 0` half beside it IS
  load-bearing, since an empty array otherwise reads back as an empty range
  list. And the writer's pair-SHAPE check is redundant with the integer check
  that follows, a flat `[1, 4]` failing either way because `(1)[0]` is not an
  integer. Both retained as the honest spelling of their rules.
  **Note:** the `autotag.ts` fold is a DE-DUPLICATION and reverting it reddens
  nothing, correctly — the two spellings write the same key. What that case pins
  is that `AutoTag({ title })` still reaches the flag at all.
  **Note, measured:** every other mutation aimed at this module reddens —
  11 of 16 across the sweep, with the five green ones each accounted for above.
- **pagemode.ts** — the two catalog entries that say how a document should
  OPEN: `/PageMode` and `/PageLayout`, 32000-1 Table 28 (`72nc.7`). A leaf
  importing `Document` as a TYPE only, `viewerprefs.ts`'s arrangement, so every
  rule is drivable from a hand-built catalog. It never throws on READ.
  **Invariant, and it is why the module exists rather than being two accessors
  in `document.ts`:** it OWNS the page-mode vocabulary, and `viewerprefs.ts`
  reaches for it. `/NonFullScreenPageMode` IS "a page mode that is not full
  screen" — Table 150's four names are Table 28's six minus two — so its public
  type is `Exclude<PageMode, 'FullScreen' | 'UseAttachments'>` and its permitted
  list is `PAGE_MODES.filter(...)`. The type half is checked by the COMPILER,
  which a hand-copied list of four never was. Measured: giving `viewerprefs.ts`
  its own list back reddens.
  **Note the direction of that edge:** `viewerprefs.ts` → `pagemode.ts`, never
  back. These keys are NOT in the `/ViewerPreferences` dictionary, so a
  `viewerprefs.ts` holding them contradicts its own opening line; and the
  extraction is the one `colornames.ts`, `preformat.ts` and `bordersides.ts`
  each already made — a shared vocabulary in a leaf both consumers may reach.
  **Invariant:** every rule here is BORROWED from `setViewerPreferences` rather
  than invented, which is the point of the neighbouring module existing.
  Reports only what the document STATES (`undefined`, never the `UseNone`/
  `SinglePage` default — the present-versus-absent rule); reads LENIENTLY (a
  name outside the enumeration, or a value that is not a name, reads as absent);
  validates the WHOLE write before touching the catalog, `TypeError` for the
  wrong KIND and `RangeError` for outside the SET, so a rejected assignment
  leaves the document byte-identical.
  **Invariant, and a save alone provably cannot see it:** deleting a key the
  catalog HAS NOT GOT touches nothing and does NOT `markModified()`. A full
  rewrite of an untouched model reproduces the same bytes either way, so the
  byte-identity assertion is blind to this. What it costs is the SIGN path:
  `choosePath()` takes the incremental append only for an UNMODIFIED base, so a
  no-op delete that marks the document modified silently turns a sign-on-save
  into a full rewrite — which rewrites bytes an earlier signature covered.
  `test/page-mode.test.ts` signs and asserts the base survives as a
  byte-identical prefix; that case is the only thing in the suite that reddens.
  **Note, measured, and it covers NOTHING — the obvious reading is wrong:** the
  `isName` half of the read is a TYPE-level necessity, not a runtime guard, and
  dropping it reddens nothing and PROVABLY cannot. No other `PdfObject` shape
  carries a `name` property — a dict is a `Map`, a stream is `{ dict, raw }`, a
  ref, string and array have none — so `.name` is `undefined` for all of them
  and no enumeration contains `undefined`. The enumeration test alone decides
  every case. Same class as `incrementaldelta.ts`'s `Map.has` note; do not cite
  the non-name fixture as covering it.
  **Note:** `/PageLayout` shipped BESIDE `/PageMode` although `72nc.7` asked for
  the latter alone — same table, same shape, one set of tests, and shipping one
  would have left the other as an identical follow-up.
  **Note, measured:** 10 of 11 mutations redden; the eleventh is the `isName`
  one above.
- **pagetransition.ts** — a page's `/Trans` transition dictionary, 32000-1
  Table 165 in full, and the `/Dur` beside it (`72nc.4`): what a viewer plays on
  ARRIVING at this page in a presentation, and how long the page then stays.
  A leaf importing `Document` as a TYPE only, `viewerprefs.ts`'s arrangement, so
  every rule is drivable from a hand-built page dict. It never throws on READ.
  **Invariant:** neither key is INHERITABLE. Table 30 makes only `/Resources`,
  `/MediaBox`, `/CropBox` and `/Rotate` inheritable, so both read from the
  page's OWN dict — reaching for `Page.inherited`, which sits right beside these
  accessors and is what the four boxes use, gives every page in a document the
  transition somebody set on the `/Pages` node.
  **Invariant, and it is a DELIBERATE divergence from `viewerprefs.ts`:** the
  write REPLACES the dictionary WHOLLY where `setViewerPreferences` merges. That
  module's narrow write exists because `/ViewerPreferences` is a large shared
  dictionary in which an entry we do not model must survive a
  read-modify-write; `/Trans` is a UNIT — a style plus THAT STYLE's parameters —
  so a merge leaves a stale `/SS`, or a Glitter-only 315, beside a newly-set
  style. It is also what keeps the two style-dependent checks SELF-CONTAINED:
  they read the object handed in and never the document.
  **Invariant:** a present but EMPTY `/Trans` reads as `{}` where an absent one
  reads as `undefined`. Presence is itself the statement that this page has a
  transition — the spec's defaults then describe it, which is a Replace — so
  collapsing the two loses a fact the file states. The same asymmetry governs
  the write: `page.Transition = {}` emits the dictionary.
  **Invariant:** a value the STATED style does not admit is refused, while a
  merely INAPPLICABLE key is written as given. 315 is Glitter's alone and the
  name `None` is Fly's alone (Table 165), so either elsewhere is a value no
  viewer honours and renders as a plain transition rather than as an error — but
  an `/SS` on a Wipe is simply ignored, and refusing it would force a caller to
  clear keys on every style change.
  **Invariant:** `/Di` is a number OR the one name `/None`, and the read must
  test that name rather than merely accept a name. **Measured, and it was a real
  gap the mutation sweep found:** with the read admitting any name, `/Di /Left`
  came back as `direction: 'Left'` — past the union type — and NOTHING reddened,
  because the fixtures seeded a bad `/Dm` and `/M` but only a bad *number* for
  `/Di`. `test/page-transition.test.ts`'s "drops a /Di naming anything but None"
  is the only case that covers it.
  **Note, and the collision is in the English rather than in the file:**
  `PageTransition.duration` is `/D`, how long the EFFECT runs, while
  `Page.Duration` is `/Dur`, how long the PAGE is shown before advancing. A
  viewer honours both, and swapping them is invisible in any single rendering.
  `/Dur` is a sibling key of `/Trans` rather than an entry inside it, so it is
  its own accessor — auto-advance with no transition is perfectly legal, and
  folding it in would misdescribe the file.
  **Note:** `/PageMode /FullScreen`, the catalog entry that makes a viewer
  actually PRESENT the document, is not here and is not modelled anywhere — so
  these two keys describe a slide deck that a viewer still opens as a document.
  Tracked as `72nc.7`, being catalog work.
  **Note, measured:** all seven mutations aimed at this module redden, the
  `/Di` one only after the case above was added.
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
- **colorconvert.ts**, **colorops.ts**, **colorimage.ts**, **colorshading.ts**,
  **colormesh.ts**, **colorrule.ts** — document-wide colour conversion
  (`doc.ConvertToGrayscale`), across page content, form XObjects, tiling
  patterns, Type 3 glyph procedures, image XObjects, inline images, shadings and
  annotations. `colorrule.ts` is the leaf holding the one conversion rule
  (`convertComps`, over `luma` Rec. 601 and `rgbToCmyk`); `colorops.ts` rewrites
  colour operators in a content stream;
  `colorimage.ts` converts one image XObject; `colorshading.ts` converts one
  shading and `colormesh.ts` re-splices a mesh's bit-packed vertex colour;
  `colorconvert.ts` is the only module of the six that touches a `Document` — the
  split `svgdraw.ts`/`svgembed.ts` makes. It builds the `GrayscaleReport`.
  **Invariant (`85l8.1`):** the walk takes a `TargetSpace` — `'gray' | 'rgb' |
  'cmyk'` — and every module has a general entry plus a gray SPECIALIZATION
  that keeps the existing name (`colorOps`/`grayscaleOps`,
  `convertImageSpace`/`grayscaleImage`, `convertShadingSpace`/
  `grayscaleShading`, `convertColors`/`convertToGrayscale`). The wrappers are
  what let the seven pre-existing test files keep asserting the gray path
  unedited — `colormesh.ts` is the one exception, since `respliceMesh`'s
  callback genuinely changed arity, and only its three callback sites moved.
  `doc.ConvertColors` is deliberately NOT public here; that is `85l8.2`, and
  `convertColors` is exported from the module so the cmyk and rgb paths are
  falsifiable now rather than dead code awaiting a caller.
  **Invariant (`85l8.1`):** `rgbToCmyk` lives in `colorrule.ts`, not in
  `pdfxcolor.ts` where it was written, because two callers need it and
  `pdfxcolor.ts` imports `EditableContent` — importing it from the leaf would
  drag the page-content machinery into the one file every colour rule is tested
  from. `pdfxcolor.ts` re-exports it AND imports it locally beside that
  (`export … from` creates no local binding), so its import path is unchanged.
  **Invariant (`85l8.1`):** the `jpeg-exact` route is GRAY ONLY, and that is
  structural rather than policy — it works because a YCbCr JPEG's Y channel IS
  Rec. 601 luma, and no such identity exists for rgb or cmyk. Measured:
  dropping the `to === 'gray'` gate reddens exactly two cmyk cases.
  **Invariant:** conversion is operator **NEUTRALIZATION**, not colour-space
  retargeting. Every `rg`/`k`/`sc`/`scn` becomes the target's operator carrying
  the converted colour, `cs` becomes the target's name, and named
  `/ColorSpace` resources
  are left unreferenced for `Optimize`'s `dr` pass. That is what makes the two
  passes ORDER-INDEPENDENT: the content pass *reads* colour-space resources that
  no pass *writes*. Retargeting would have the content pass resolving spaces the
  object pass had already moved out from under it, and would leave a space shared
  between an image that converts and one that cannot self-inconsistent.
  **Invariant (`85l8.1`):** a source ALREADY in the target space is returned
  untouched by `convertComps`, and that is the byte-identity property rather
  than an optimization — the Rec. 601 weights sum to 0.9999999999999999, so a
  grey pivoted through RGB comes back one ulp low and every grey operand in the
  document is re-rounded. **Note, measured, and it covers NOTHING:** the RGB
  arm of that short-circuit is not load-bearing, since `rgbPivot` returns an
  rgb source raw and `clamp01` is the identity in range — disabling it for rgb
  ALONE leaves the whole suite green, where disabling it outright reddens the
  gray and cmyk cases. Do not read the green suite as covering it.
  **Note on the fence, and the obvious reading is wrong:**
  `test/grayscale-identity.test.ts` hashes `Save()` output for five fixtures.
  It does NOT uniquely catch a broken colour rule — routing `grayOf`'s gray arm
  through `luma(g, g, g)` reddens `grayscale-core.test.ts` and leaves every
  hash GREEN, because `colorops.ts` short-circuits before ever calling it with a
  gray space. What it catches ALONE is an INCIDENTAL ENCODING change: making
  `convertContent` re-deflate its output reddens one case there and nothing in
  the other seven files. That is the class it exists for. Its fixtures reach
  the `flate` and `jpeg-exact` routes, two shadings, one mesh and a colour-key
  `/Mask` — NOT the `jpeg` or `palette` routes, so a JPEG quality change
  reddens nothing there.
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
  **Invariant:** `colorimage.ts` and `colorshading.ts` take `resolve`/`inflate` as
  ARGUMENTS and never import `document.js`, so every rule is testable from a
  hand-built dict. Anything needing an object number is handed back for
  `colorconvert.ts` to `allocObject` — which is how the colour-key stencil below
  reaches the file, the split `imageembed.ts` already makes for an `/SMask`.
  **Invariant:** `colormesh.ts` is pure BIT arithmetic and takes the colour rule
  as a callback, so it never learns what a colour space is and `colorshading.ts`
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
  **Note, and this entry ASSERTED IT FOR SIX COMMITS BEFORE IT WAS TRUE:** the
  inline-image half of that list did not exist until `85l8.4`. `colorops.ts`
  had no skip channel at all, so every inline-image decline was invisible and
  `test/convert-colors.test.ts` asserted `skipped: []` for a document whose
  `BI` was still drawing full colour. Recorded because the entry read as
  covered, which is how it stayed unimplemented.
  **Invariant (`85l8.4`):** an inline image reports through
  `GrayOpsResult.skipped` — reasons only, attributed to a containing stream by
  `colorconvert.ts` — because an inline image lives in the content stream and
  in no object, so `colorimage.ts` provably cannot see one and this is the only
  place that can report it. `what` is `'inline-image'` rather than `'image'`,
  since `objNum` names the stream that DREW it and there is no object to
  address; folding it into `'content'` would claim the stream failed to parse.
  **Invariant (`85l8.6`):** an `inline-image` skip carries `opIndex`, the index
  of its `BI` within the stream `objNum` names, and NO other kind does — those
  address an object rather than an op inside one. `colorops.ts` reports the
  index relative to its OWN op list, which is what lets it stay a leaf that
  knows no object numbers.
  **Invariant (`85l8.6`), and it is why this is not a `ContentAddr`:** that
  type exists in `inlineimage.ts` and `InlineImageInfo.Addr` is public, but it
  cannot describe these skips. Its `path` is an XOBJECT chain — `cowXObject`
  resolves every segment through `/Resources /XObject` — while `collectScopes`
  also walks tiling patterns, Type 3 `/CharProcs` and ExtGState `/SMask /G`
  groups, any of which may hold a `BI` and none of which such a path can name;
  a `ContentAddr` field would be silently absent for three of the five scope
  kinds. It is also PAGE-relative where the scope walk dedupes by object
  number — the correctness rule that keeps a form reached from two pages
  rewritten once — so a shared form has no single page to name. Do not "fix"
  this into a `ContentAddr`.
  **Invariant (`85l8.4`), and it is what keeps `skipped: []` meaningful:** the
  TARGET check outranks every reason. `/CS` is in the dict rather than the
  payload, so an image already in the target space needs nothing decoded and
  cannot fail to convert however it is coded — put the filter test first, as
  the pre-`85l8.4` order did, and every filtered gray inline image reports a
  skip under `to: 'gray'` for work there was none of.
  `build-inline-image-pdf.ts` writes every inline image as `/F /AHx`, so that
  fixture is the one that shows it: two skips converting to cmyk, ONE
  converting to gray. A case asserting only the cmyk count cannot tell the rule
  from its absence.
  **Invariant (`85l8.4`):** an annotation colour array of an illegal WIDTH is
  reported and LEFT, never guessed at. 32000-1 12.5.2 gives `/C`, `/IC`,
  `/MK /BG` and `/MK /BC` their space by length — 1 gray, 3 RGB, 4 CMYK — and
  any other width used to fall through to the RGB arm, so `/C [0.25 0.5]` was
  rewritten as RGB with blue 0 and an array holding no numbers was left with
  nothing said. An EMPTY array is the exception and stays silent: it is legal
  and means *no colour*, so a record there fires on every annotation that asked
  for no border. This is also what makes `what: 'annotation'` reachable — the
  kind was declared from the start and emitted by nothing.
  **Note, measured:** all seven mutations aimed at these rules redden. Two are
  worth naming, both because the obvious fixture misses them: pushing the
  inline skip AFTER `convertContent`'s `changed === 0` bail reddens three cases
  — a stream whose only colour is a declining inline image changes nothing, and
  is precisely the stream whose skip must be heard — and reporting the
  already-in-target decline reddens three, which is the silence rule above.
  **Note:** `greyDA`'s `catch` is UNREACHABLE and no skip is reported from it.
  `content.ts` contains no `throw` and `Lexer.next()` never throws, so
  `parseContentStream` provably cannot fail; `convertContent`'s catch is a
  different matter and IS reachable, since it wraps `inflateStream` too. The
  `/DA` catch stays as defence, and as the shape every other parse site here
  takes.
  **Invariant (`85l8.5`):** page resources are read through `page.Resources`,
  NEVER `page.Dict.get('Resources')`. `/Resources` is an INHERITABLE page
  attribute (32000-1 7.7.3.4) and the raw read misses one held on the `/Pages`
  node — where Ghostscript, Word and others put it. This module was the only
  one in `src/` still getting it wrong, and it degraded the WHOLE pass rather
  than one lookup: `collectScopes` never reached the form XObjects, tiling
  patterns, Type 3 charprocs or SMask groups hanging off those resources, so a
  greyscaled document went on painting pure blue; named shadings were never
  converted; and every `cs` fell to the unknown branch. `skipped` was `[]`
  throughout. It PREDATES `85l8.1` — `ConvertToGrayscale` always did this — so
  do not read it as fallout from the target parameter.
  **Note, measured, and the redundancy is real:** `convertShadings` has its own
  page loop reading the same thing, and fixing it reddens NOTHING on any
  document that has content — `collectScopes` already contributes the page's
  resources to the shading set. It is load-bearing for exactly one shape, a
  page with NO `/Contents`, which produces no scope at all;
  `buildInheritedShadingOnlyPdf` exists for it and is the only case that goes
  red. Two defences for one rule: breaking either alone proves nothing.
  **Invariant (`85l8.5`):** a `cs`/`CS` naming a space no lookup resolves is
  REFUSED, not guessed. The operator and every `sc`/`scn` under it are left
  exactly as written and the resource key comes back on
  `GrayOpsResult.unresolvedSpaces` — a `Set` of NAMES, `patternSpaces`' shape,
  so the leaf hands back what it found and `colorconvert.ts` owns the report
  wording. The old `?? GRAY` fallback was wrong in two ways at once: to a
  non-gray target the following `sc 1 0 0` was read as ONE grey component and
  came out `1 1 1 rg`, pure white; to gray the `cs` was retargeted while
  `isTarget` left the `sc` alone, emitting `/DeviceGray cs 1 0 0 sc` — three
  operands in a one-component space, malformed rather than merely wrong.
  **Note:** `'unknown'` is LOCAL to `colorops.ts` (`StateSpace`), deliberately
  not a `GraySpace` kind. `colorrule.ts` is the leaf every colour rule is
  tested from and `colorimage.ts`/`colorshading.ts` resolve their space from a
  dict they were handed, so neither can ever construct one — a kind only one of
  three consumers can produce is a case the other two carry for nothing.
  **Note:** this is the ONE `skipped` entry meaning colour SURVIVES in the
  output, so the postcondition is "every colour is the target EXCEPT what
  `skipped` names". README says so too.
  **Invariant (`85l8.3`):** the RGB→CMYK leg is REPLACEABLE by the caller
  (`ConvertColorsOptions.transform`, a `CmykTransform` in `colorrule.ts`), and
  it replaces that leg ALONE — never the pivot. Every source space still
  reaches RGB through `rgbPivot`, so a transform sees the same triple whatever
  the document declared, and a gray or rgb target never consults it. This does
  NOT make the library colour managed: the default is the same naive
  maximum-black `rgbToCmyk`, and with no transform the output is byte-identical
  (`grayscale-identity` is the fence).
  **Invariant:** it is threaded to EVERY leg — content operators, inline
  images, image samples (`GrayImageOptions.toCmyk`), shading functions, mesh
  vertices and annotation colour arrays. Stopping at the operators leaves naive
  ink in every picture, which is the defect a colour-managed caller is trying
  to avoid. Each leg is mutation-checked SEPARATELY, because a fixture
  exercising only operators leaves the other four unmeasured.
  **Invariant:** validated ONCE, before anything converts, so a rejected call
  leaves the document byte-identical — `checkTarget`'s rule. `TypeError` for a
  non-function or a return that is not four finite numbers (wrong KIND of
  thing), `RangeError` for a target with no cmyk leg (outside the allowed SET)
  — `formcreate.ts`'s split. Silently ignoring it for `to: 'gray'` is the trap
  `textedit.ts` records for `region`.
  **Invariant, and BOTH halves are separately load-bearing:** every result is
  also clamped on the way out, testing FINITENESS as well as range. The probe
  cannot prove a transform well behaved for inputs it did not try, and
  `clamp01(NaN)` is `NaN` — so a range-only clamp lets a `NaN` reach a content
  stream, which is a CORRUPT FILE rather than a wrong colour. Measured:
  dropping the clamp reddens one case, and weakening it to range-only reddens
  one too.
  **Note on the fixture, found by a failing run:** a case for the clamp must
  misbehave for a colour the PROBE does not use. The probe corners are black,
  white, RED and mid-grey, so a transform that misbehaves for red is rejected
  up front and the case measures the wrong guard; the fixture keys on blue.
  **Note:** no `/OutputIntent` is written and none should be. Its subtype is a
  standards CLAIM (`GTS_PDFX`, `GTS_PDFA1`), and asserting PDF/X conformance
  from a plain colour conversion would be false; `pdfxconvert.ts` and
  `pdfaconvert.ts` own that through a conversion context this module cannot
  reach. Declaring which output condition the numbers are FOR is
  `ConvertToPdfX`'s job. `pdfxcolor.ts`'s `rewriteRgbToCmyk` likewise keeps the
  naive transform: it is PDF/X remediation with its own opt-in and its own
  caller.
  **Note on what this is NOT:** there is no ICC engine here and no profile is
  parsed — `colorspace.ts` still reads an ICCBased space through `/N` and
  `/Alternate` alone, and `srgb.ts` is an opaque blob we embed. A real
  destination-profile transform (B2A LUTs, PCS, rendering intents) is its own
  subsystem and its own issue, and should not land without an oracle: colour
  errors are silent, and checking our own arithmetic against itself is exactly
  what this repo's real-world fixtures exist to prevent.
  **Invariant:** it throws `UnsupportedFeatureError` on a signed document, which
  converting would invalidate.
- **icc.ts** — the ICC profile container (`85l8.7.1`): header, tag table, and
  the `XYZ ` and `curv` tag types. A pure leaf importing only `errors.js` —
  bytes in, structure out, no `Document` and no colour conversion; `icclut.ts`
  and `icctransform.ts` (`85l8.7.2`) build the transform on top.
  **Invariant:** a parser REPORTS what the file says and never corrects it.
  The vendored sRGB profile declares a D65 media white point where its own
  colorants sum to D50 — a known quirk of that file, asserted in the suite so
  it reads as recorded rather than as a reader bug.
  **Invariant:** tag bounds are checked ONCE, in `parseIccProfile`, not in each
  tag reader: a tag running past the buffer is an out-of-bounds read rather
  than a wrong colour.
  **Invariant:** a four-character signature keeps its padding. `'RGB '` and
  `'Lab '` are signatures rather than words, and a trimmed one stops comparing
  equal to the constants `85l8.7.2` matches on.
  **Invariant:** `iccTag` is a linear scan over an array, NOT a Map lookup. The
  signature comes from a file, so a Map keyed by it would need
  `hasOwnProperty` to keep `constructor` from finding
  `Object.prototype.constructor` — `predefcmap.ts`'s hazard, and seventeen
  tags do not need an index.
  **Note, and each is silent when wrong:** header byte 9 packs minor and
  bugfix in two nibbles (read raw it reports version 16 for 1.0);
  `s15Fixed16` is SIGNED 16.16; and a `curv` tag's COUNT selects three
  meanings — 0 identity, 1 a u8Fixed8 GAMMA where 0x0100 is 1.0, n a table.
  Both of the last two are mutation-checked.
  **Note, and it is a real-world shape a synthetic fixture would miss:** the
  sRGB profile's `rTRC`, `gTRC` and `bTRC` all point at offset 1084 — three
  tags SHARING one data block, which ICC permits to avoid storing an identical
  curve three times. A reader that assumed tags partition the file gets two of
  the three wrong.
  **Note on the oracle:** there is none, and none is needed. Every rule is
  checked against the sRGB profile already vendored in `srgb.ts`, and the
  `s15Fixed16` reader is anchored OUTSIDE this code by summing the three
  colorants to the published D50 illuminant — the rule that to check an
  interpreter you assert against something it does not compute.
- **icclut.ts**, **icctransform.ts** — an ICC destination profile as a real
  `CmykTransform` (`85l8.7.2`). `icclut.ts` reads and evaluates the
  `mft2`/`mft1` LUT pipeline; `icctransform.ts` composes sRGB → PCS → CMYK and
  exposes `iccCmykTransform`, the only thing here `index.ts` exports. Both are
  pure leaves over `icc.ts`; `85l8.3` already threads a `CmykTransform` to
  every leg of the colour walk, so this added NO plumbing.
  **Invariant:** the SOURCE leg is written out, never parsed from `srgb.ts`.
  sRGB is defined by a specification rather than by a file, which keeps the
  whole feature dependent on exactly ONE profile — the caller's destination.
  **Invariant:** every refusal happens in the FACTORY, before any colour
  converts, so a declined profile leaves the document byte-identical —
  `checkTarget`'s rule. Declined rather than mis-read: v4 (its `B2A` is an
  `mBA ` with a different element order), absolute colorimetric (no `B2A` tag
  of its own), a non-CMYK device space, a non-Lab PCS, a missing `B2A`.
  **Invariant (`m3gs`), and it REVERSES what `85l8.7.2` shipped:**
  interpolation is TETRAHEDRAL for three inputs and MULTILINEAR otherwise.
  Trilinear was the original choice, on the reasoning that its arithmetic
  reads straight off the spec — but no spec text settles the method, and
  measurement does: WCS is tetrahedral, and littlecms and Adobe's CMM
  subdivide the same way. Through a purpose-built CURVED profile the old walk
  missed WCS by **4.0e-2**, four percentage points of ink, where tetrahedral
  tracks it to 4.8e-3.
  **Note the split is on the INPUT COUNT rather than a flag,** because a
  tetrahedral decomposition is a property of the CUBE and has no 4-input
  counterpart. `icctransform.ts` evaluates the `B2A` direction only, so the
  multilinear arm is unreachable through the public API and is held by a
  hand-built case in `test/icclut.test.ts` alone.
  **Note, measured, and do NOT read the 4% as the error on a real file:** the
  gap falls as the SQUARE of the cell size — 1.9e-1 at grid 2, 7.0e-2 (3),
  2.1e-2 (5), 5.3e-3 (9), 1.4e-3 (17), 3.3e-4 (33). A real profile's `B2A0`
  is grid 17, so the practical change to output is about a tenth of a
  percent. The reason to make it is agreement with the reference, not the
  magnitude.
  **Invariant, and it is why a SECOND fixture had to exist before the method
  could be touched at all:** every interpolation method agrees EXACTLY on an
  affine CLUT, so `synthetic-cmyk.icc` is structurally blind to the one rule
  it was designed around — measured at 1.1e-16, one ulp, and all 29 of its
  exact goldens held UNEDITED through the change. They are the FENCE for it,
  not the evidence. `synthetic-curved-cmyk.icc` (grid 3, cross terms, a pure
  `u*v*w` term in K) is what carries the evidence, and it is the ONE
  comparison in this feature with a tolerance — 6e-3, stated from the worst
  measured residual. That tolerance is itself pinned: the suite walks the
  SAME LUT multilinearly and asserts the result lands in [3.5e-2, 4.5e-2], so
  the margin provably cannot absorb the method.
  **Note:** the curved fixture is grid 3 for a second reason worth its own
  line — with grid 2 the cell origin is ALWAYS 0, so
  `Math.min(Math.floor(q), grid - 2)` is unreachable arithmetic and the
  affine fixture cannot test cell selection either.
  **Invariant:** the CLUT's FIRST input channel varies SLOWEST. Measured:
  reversing the stride reddens three cases, which the fixture's
  one-input-per-output design exists to catch.
  **Invariant, and it was got WRONG TWICE — read this before touching
  `labToV2`:** `L* 100` reaches the LUT at the FULL input range, while `a*`
  and `b*` use the legacy `(v + 128) × 256` over 0..0xFFFF. The asymmetry
  reads like an inconsistency and is what WCS does. The plausible wrong
  reading for L is `× 65280/65535`, because ICC v2 genuinely does store Lab
  with `0xFF00` as full scale — it costs 0.383% on every colour, proportional
  to L\*, zero at black and worst at white, which is a uniformly
  slightly-light document nobody notices without a reference. The plausible
  wrong reading for a/b is `/255`, off by 2e-3 where the right one matches to
  1e-4. BOTH were caught by the golden comparison and by NO hand-written case:
  a hand-written case asserts the rule its author believed, which is the
  argument for the oracle in miniature.
  **Note on the oracle:** Windows Color System (`mscms.dll`), through TWO
  profiles `scripts/gen-icc-fixture.mjs` AUTHORS rather than vendors —
  `RSWOP.icm` is Microsoft copyright and our engine needs profile bytes at
  TEST time, so vendoring would cost the suite its hermeticity. ICC requires an
  N-component output profile to carry all three intents plus `gamt`, and WCS
  enforces it: a five-tag profile gets `ERROR_INVALID_PROFILE`.
  `test/fixtures/icc/PROVENANCE.md` records the ceiling — one CMS with no
  second to arbitrate, which since `m3gs` includes the choice of
  interpolation method, since no spec text settles it; nothing said about
  real-world v4 or `para` or grid-17 profiles; `mft1` exercised by no real
  profile at all; and the 4-input multilinear arm reached by no profile here.
  It also records the one residual that is measured but NOT fully explained —
  4.8e-3 on the curved fixture, mechanically tied to the L\* cell boundary
  where that CLUT's C ramp trebles in slope, with the three worst samples the
  three nearest it in order of distance, but of a magnitude the affine
  fixture's Lab agreement does not account for.
- **linearize.ts** — linearized (Fast Web View) output + `verifyLinearization`.
- **node.ts** — file-based convenience wrappers, and the only module that
  reaches `node:fs` on behalf of a caller. Every wrapper but one is PDF-in;
  `htmlFileToPdf` (`zch2.8`) is the exception and the only entry point in the
  library that reads HTML from a file.
  **Invariant:** it resolves a relative `<img src>` from the input's own
  directory and CONFINES it there — a URL scheme, an absolute path, and
  anything that climbs out with `..` are refused, and a refused src lands in
  `skipped` like any other construct that did not render. The `..` test runs
  AFTER resolution, since `a/../../b` escapes while starting with neither `/`
  nor `..`. A caller-supplied `resolveImage` wins outright, so the default is
  a convenience rather than a policy.
  **Note, measured, and it covers NOTHING:** deleting the URL-SCHEME test
  reddens no case. `resolve(base, 'https://…')` lands INSIDE `base` (a
  directory named `https:`), so the confinement admits it and the read then
  fails only because no such file exists — the same `undefined`, by luck. It
  stays because "no file is there" is not a safety property, and a colon is
  illegal in a Windows filename so no portable fixture can separate the two.
  **Invariant:** `encoding` and `resolveImage` are destructured OUT before the
  rest of the options are forwarded to `AddHtml` — the rule `textedit.ts`
  already records for `region`, so a key this module owns cannot reach a
  consumer that would silently accept it.
  **Invariant (`72nc.8`):** `saveImagesFile` turns
  `ImageInfo.Save`'s `{ bytes, mediaType }` into files, and it exists because
  the caller's own loop gets ONE step wrong: the extension. It always comes
  from the encoder's media type, never from the source image — JPEG bytes under
  a `.png` are a file no viewer opens, which is the mistake the media type
  exists to prevent, so it is prevented once here rather than at every call
  site.
  **Invariant:** ONE file per DISTINCT picture, through `imagehref.ts`'s
  `imageKey` rather than a fourth copy of the hashing rule. A logo drawn on
  forty pages is one XObject reached from forty resource dicts, and a merged
  document holds forty distinct stream objects with identical content — keyed on
  the object, both write forty files. **Note the fixture:** two `AddImage` calls
  with the SAME bytes, which is exactly the merged-document shape; one shared
  `ImageInfo` would dedup under either reading and measure nothing.
  **Invariant:** it returns `{ written, skipped }` where every neighbour in this
  module returns `string[]`, and the asymmetry is the point. `ImageInfo.Save`
  THROWS for an image it cannot encode — right for a caller asking about ONE
  image — but this caller is asking for all of them, which is `encodeImage`'s
  situation, where a damaged picture must cost itself and not the run
  (`imagepages.ts`, `svgdraw.ts`). A bare path list would then lose three
  pictures out of two hundred with nothing anywhere saying so. It is the first
  helper here with a PER-ITEM failure mode, which is why it is the first with a
  report. Both halves are pinned: rethrowing reddens, and swallowing reddens.
  **Note:** it does NOT copy `imagepages.ts`'s throw-when-nothing-decoded. A
  document with no images returns two empty arrays and an empty directory, which
  is a true answer rather than a failure.
  **Note:** inline `BI … EI` images are structurally out of reach, not silently
  missed — one occupies no `/XObject` entry, so `page.Images` never sees it, and
  `InlineImageInfo` has no `Save`. Documented in README as a limit.
  **Note:** no page filter. The task the issue names is the whole document, and
  `pages` is additive later.
  **Note, measured:** all 11 mutations aimed at this redden.
  **index.ts** — public exports.

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
| `fixtures/fonts/` | `PROVENANCE.md` | WOFF2 from wawoff2 and fontTools — `glyf`, `hmtx`, and CFF-flavoured (`OTTO`) input — plus `LiberationSans.dfont`, a Macintosh suitcase written by FontForge, since Apple`s own cannot be vendored. Two of its five container rules stay unanchored and PROVENANCE says which |
| `fixtures/jpeg/` | `PROVENANCE.md` | libjpeg-turbo's own images, plus `cjpeg`-generated synthetics (incl. CMYK/YCCK) |
| `fixtures/svg-input/` | `PROVENANCE.md` | SVG→PDF **input**: an SVGO-optimized pair, a bootstrap-icons file, a d3-shape chart — path-grammar lexis our builders never write. Distinct from `fixtures/svg/`, which is PDF→SVG **output** goldens |
| `fixtures/svg-filter/` | `PROVENANCE.md` | Browser-rendered goldens for feTurbulence and the lighting primitives — ports of published reference implementations, which cannot validate themselves |
| `fixtures/svg/` | `PROVENANCE.md` | PDF→SVG **output**: headless-Chrome rasterizations of `ToSvg()` for the transparency constructs, cross-checked against resvg. Our rasterizer works from PDF semantics and the browser from our emitted markup, so agreement is independent evidence (`scripts/gen-svg-goldens.ts`, not run by `npm test`) |
| `fixtures/bmp/` | `PROVENANCE.md` | BMP **input**: seven files from GDI+ (the format owner's writer) read back by bmp-js. Corroborates the palette, 16-bit and 32-bit paths that `test/bmp.test.ts` anchored on our builder alone — measured as adding no mutation coverage over it, so read that file's two Wikipedia hex dumps as still load-bearing. Carries two shapes a builder would not emit: a 224-entry partial palette, and a `Format32bppArgb` save declaring no alpha (`test/bmp-real.test.ts`) |
| `fixtures/tiff/` | `PROVENANCE.md` | TIFF **input**: nine files from libtiff (via libvips/sharp) and utif2, with ground truth from a third decoder — libvips reading each back. The tiled-G4 file is the only shape that separates the *block* width `decodeCcitt` is told from the *image* width, a mutation `test/tiff.test.ts` leaves green. Found the `jpeg.ts` RGB-component-id bug on its first run (`test/tiff-real.test.ts`) |
| `fixtures/pdfx/` | `PROVENANCE.md` | Ghostscript-produced PDF/X-1a/X-3/X-4 for `pdfxvalidate.ts` — four conformant, one deliberately not, and the only fixtures reaching `outputIntentRule`'s registered-name branch (`test/pdfx-real.test.ts`) |
| `fixtures/corrupt/` | `PROVENANCE.md` | Damaged files for the recovery suite (`test/corrupt-real.test.ts`). The one directory where the *source* is what is third-party — a corrupt file has no producer — so Ghostscript and qpdf lay out the bytes and the damage is recorded byte for byte, alongside what each fixture salvages and loses |
| `fixtures/qpdf/` | `PROVENANCE.md` | Outputs of `Save({ incremental: true })` that **qpdf 12.3.2** called clean, with its `--check` and `--show-xref` reports beside them. The incremental writer is otherwise read back only through our OWN parser, so an append our reader tolerates and the format does not is invisible; qpdf is a separate implementation. Its sharpest case is `freed-object`, the one shape our reader provably cannot check, since `readXref` drops free entries (`2yvi`) — qpdf honours the `f` entry, which is also what proves that bug is a READER bug. `test/qpdf-goldens.test.ts` asserts byte-identity and runs no qpdf, so CI needs nothing installed (`scripts/gen-qpdf-goldens.ts`, not run by `npm test`) |
| `fixtures/xfa/` | `PROVENANCE.md` | Hybrid XFA forms from **Adobe LiveCycle Designer 6.5** (IRS f1040 and fw9, US federal works). A static XFA form carries TWO independent descriptions of one field set — the template, and the `/AcroForm` LiveCycle generated from it — so `test/xfa-real.test.ts` strips `/AcroForm /Fields` in a copy, converts from the template ALONE, and compares names and RECTS against what Adobe wrote. It found the `<caption>` reserve rule the design had missed (worst rect error 229pt → 12pt) and confirmed where the layout chain begins, which no hand-built fixture could. One producer, so evidence rather than conformance (`test/xfa-real.test.ts`) |
| `fixtures/xfdf/` | `README.md` | Acrobat's own XFDF appearance encoding |
| `fixtures/unicode/` | — | UAX #9 / #14 conformance data from Unicode |
| `fixtures/commonmark/` | `PROVENANCE.md` | The official CommonMark 0.31.2 suite — 652 examples, run with no allowlist through the test-only oracle in `test/helpers/md-html.ts` |
| `fixtures/gfm/` | `PROVENANCE.md` | GitHub's own `spec.txt` — the 24 examples tagged with an extension name. The other 648 are a CommonMark **0.29** document and are deliberately not run |
| `fixtures/html5lib/` | `PROVENANCE.md` | The official html5lib-tests tokenizer suite — 6,995 of 7,033 cases over every state, both character-reference spellings, and the parse-error vocabulary with positions. The suite browser engines share, so it catches the class our own builders cannot: it CORRECTED two position rules this repo had asserted the wrong way round in its own tests. Since `zch2.9` it is also the STALE half of a spec disagreement: 38 cases assert the pre-#12118 reading of `<?`, this pin is one day newer than that merge and upstream is dormant, so they are excluded by a computed predicate |
| `fixtures/css-parsing/` | `PROVENANCE.md` | CSS Syntax 3's conformance corpus, from CourtBouillon — 149 cases in 8 files, all run with no allowlist. Records a SPEC-ERA decision: the corpus still tokenizes `unicode-range` and the match tokens, which the current editor's draft removed, and we follow the corpus. Records two places the corpus README contradicts its own data, where the data wins. Caught five rules the plan did not name, three of them invisible to a diff of serialized output |
| `fixtures/wpt/` | `PROVENANCE.md` | The HTML tree-construction corpus, from web-platform-tests — html5lib-tests no longer carries it. 1,936 cases in asserted buckets, 1,918 run here. It CORRECTED the spec reading this issue was designed against: there is no "in select" insertion mode and no select scope any more. Since `zch2.9` it is the corpus we FOLLOW on processing instructions — whatwg/html#12118 merged 2026-06-25 and this pin postdates it, where the html5lib tokenizer pin does not. One disagreement is left and is PERMANENT, over `<selectedcontent>`, whose expected tree holds text the element clones in rather than the parser — confined to the TREE, since `4h3p` measured that the render already draws what Chrome shows |

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
- **Docs** — keep `README.md` (user-facing: **Key Capabilities**, **Quick
  Start**, **Additional Examples**, **API Reference**, **Scope and
  Limitations**) in sync when adding or changing a public API. Per-feature
  design specs and plans live under `docs/superpowers/`.
  **Note the section names above are the GITHUB-facing ones and changed with
  the file:** `README.md` was replaced by what had been `README.gh.md`, so the
  old headings (Features, Quick start, API overview, Limitations) are gone and
  a search for them finds nothing. Its example headings are IMPERATIVE — "Set
  Viewer Preferences", "Extract Text" — rather than noun phrases, and the API
  Reference is split into typed tables (Core API, Annotations, Forms, Text, …)
  plus a types table whose rows are several ALPHABETICAL RUNS concatenated,
  not one sorted list; inserting a row by scanning for the first name that
  sorts higher lands it in the wrong table.
  A new `src/*.ts` module earns an entry in the Source list above **when it
  lands**, not when someone next happens to touch that area — which is how eight
  of them came to have none at all (`2qkk`). The sweep that finds the gap:

  ```bash
  for f in src/*.ts; do b=$(basename "$f")
    grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
  done
  ```

  **The output is EMPTY on a clean tree**, so a non-empty result means work.
  That property is the whole value of the check: a sweep with permanent false
  positives trains its reader to ignore it, which is not hypothetical — the
  previous version matched a **bold** entry only, so it reported the five
  modules below on every run, and three separate sessions read those as real
  documentation debt and said so to the user before checking `2qkk` (`67mt`).

  A module the list genuinely does not need — one whose whole story is a clause
  in a neighbour's entry — should be named in that neighbour's prose, which is
  why the match accepts a name in **bold** or in `backticks` alike. Five are
  deliberately in that position: `colorkey.ts` (under raster.ts), `errors.ts`
  (under Conventions), `formremove.ts` (under struct.ts), `htmlforms.ts`
  (under html.ts) and `tabletag.ts` (under tableauthor.ts).

  **Do NOT "simplify" this to a bare `grep -q "$b"`.** `67mt` proposed exactly
  that and it is worse than the bug: module names collide as SUFFIXES — 20-odd
  pairs, including `flow.ts` inside `cssflow.ts`/`docxflow.ts`/`htmlflow.ts`/
  `mdflow.ts`, and `font.ts` inside four more — so a bare match makes the
  sweep structurally incapable of ever reporting `flow.ts`, `font.ts`,
  `cmap.ts`, `content.ts` or `appearance.ts`. That trades five visible false
  positives for silent false negatives. The delimiter is what prevents it:
  measured, a bare match "finds" the undocumented `ap.ts` inside `cmap.ts`
  while the delimited one correctly reports it missing.
