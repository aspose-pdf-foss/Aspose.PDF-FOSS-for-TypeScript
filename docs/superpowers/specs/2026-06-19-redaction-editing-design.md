# Phase 4 — Redaction & Editing (design)

Content-authoring roadmap **Phase 4**, the most complex and security-sensitive
phase. Beads epic `aspose-pdf-foss-for-ts-638`; this spec is child `638.1` and
blocks every other child. Roadmap source:
`docs/superpowers/specs/2026-06-17-content-authoring-design.md`.

Phase 4 breaks the library's long-standing **write-only-authoring** boundary:
until now we appended to content streams but never edited existing content. This
phase reads existing content back, removes or replaces parts of it, and bakes
interactive objects into static content.

## Scope

Three tracks over a shared foundation:

1. **Redaction** — true removal of text and image content under page-space
   rectangles, plus resource and (optional) metadata sanitization. Not a cover
   box: the underlying content is gone from the saved file.
2. **Flatten** — bake form-field and annotation `/AP` appearances into page
   content and drop the interactive objects.
3. **Text search/replace** — locate text and substitute it, constrained to the
   same font and encoding with no layout reflow.

Redaction and search/replace both require **editing existing content streams**;
the shared foundation (F1 + F2) provides that and blocks both tracks. Flatten
only appends, so it depends on this spec alone.

### Key decisions (resolved during design)

- **Shared Form XObjects → copy-on-write.** When an edit targets content drawn
  through a Form XObject (which may be shared across pages), clone the XObject
  for the affected page and edit the copy. Other pages are never mutated.
- **Partially-covered images → throw.** An image fully inside a redaction rect
  is removed; an image only partially covered raises `UnsupportedFeatureError`
  (clipping/re-encoding is out of scope). No silent partial leak.
- **Redaction regions are explicit rectangles.** `Redact(rects, opts)` takes
  page-space rectangles. "Redact every match of X" composes the S1 search track
  in a later phase; the R-track stays independent of the S-track.

### Dependencies (all shipped on `main`)

Phases 1–3 (drawing/`PageGraphics`, image embed, content splicing, form
appearance generation, annotations + `/AP`, XMP) and coordinate text extraction
(`text.ts`, `font.ts`, `content.ts`).

## Existing machinery this builds on

- `content.ts` — `parseContentStream(bytes) → ContentOp[]` and
  `serializeContentStream(ops) → bytes`. The serializer is **re-parse-stable**,
  not byte-identical: re-parsing its output yields the same ops. This is the
  op-level core of F1.
- `text.ts` — the content walker (`walk`) that threads the CTM/text-state
  machine, decodes show ops via `TextFont`, descends into Form XObjects, and
  emits positioned `Run`s. Today it discards which op produced each run; F2
  extends it to retain provenance. Affine-matrix helpers (`mul`/`apply`/
  `translate`/`vscale`) live here.
- `font.ts` — `TextFont.decodeRun` (code→Unicode + aggregate advance) and
  `glyphWidth` (per-code advance, needed for per-glyph boxes in F2). Decoding is
  one-directional today; S2 adds the inverse for simple fonts.
- `pagecontent.ts` — `appendContent` (q/Q-wrapped splicing), `ensureOwnResources`
  /`ensureOwnSubdict` (copy-on-write of inherited resource dicts),
  `registerExtGState`, `freshKey`. Reused by R4 box paint and the flatten track.
- `page.ts` — `Page.Contents` (joined, inflated content bytes), `Page.Resources`
  (inherited-aware).
- `document.ts` — `Save()` mark-sweeps from `/Root`+`/Info`, so objects that
  become unreachable after an edit are dropped automatically. `ClearMetadata()`
  clears both `/Info` and the XMP packet (reused by R3's metadata scrub).
- `errors.ts` — `PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError`.

## Foundation

### F1 — content-stream rewriter (`editcontent.ts`, `EditableContent`)

Represents a page's editable content as a **per-stream op list**:

- **Read.** Normalize `/Contents` to its ordered stream objects; parse each with
  `parseContentStream` into its own `ContentOp[]`. Edits address an op by
  `(streamIndex, opIndex)`.
- **Edit.** `removeOp`/`replaceOps` mutate a stream's op list in place. The op
  model is immutable (`ContentOp` is readonly), so edits produce new op arrays.
- **Write back.** For each modified stream, `serializeContentStream` the new ops
  into bytes and store them in a **fresh, page-owned** stream object (never
  mutate a possibly-shared input stream). Unmodified streams are left untouched.
- **Copy-on-write for XObjects.** When an edit targets content inside a Form
  XObject reached via `Do`, clone the XObject to a new object number, copy-on-
  write the page's `/Resources` (`ensureOwnResources`/`ensureOwnSubdict`) and
  repoint the `XObject` entry's name to the clone, then edit the clone's content
  stream. Recurse for nested XObjects, carrying the COW path so each level edits
  a page-local copy. A clone is made at most once per (page, XObject) edit pass.

Re-serialization rewrites a whole stream (re-parse-stable, not byte-identical);
acceptable because we are deliberately changing that stream's content.

### F2 — region → glyph/image mapping (provenance walk)

Refactor `text.ts`'s `walk` into a reusable **visitor** that yields events as it
threads the existing CTM/text-state machine:

- `glyph` events: `{ deviceQuad, streamIndex, opIndex, elementIndex?, byteRange }`
  — `elementIndex` identifies the string within a `TJ` array; `byteRange` is the
  glyph's code-byte span within that show string. Per-glyph device quads use
  `glyphWidth` to advance one code at a time (finer than `decodeRun`).
- `image` events: `{ deviceQuad, streamIndex, opIndex, kind: 'xobject' | 'inline' }`
  for `Do` image XObjects and `BI…EI` inline images, with the same provenance.

Both events carry the **COW path** (the chain of XObject names descended into),
so F1 knows which stream — page content or a specific XObject — an edit targets.

`extractText` is rewritten as a thin consumer of this visitor (collect `glyph`
text into `Run`s → `assembleLines`), keeping a single walker. A second consumer,
`mapRegions(rects) → Hit[]`, returns the glyph and image events whose
`deviceQuad` intersects any of the given page-space rects.

This is the targeted refactor the brainstorming guidance calls for: one walker,
two consumers, no duplicated state machine.

## Redaction track (`redact.ts`)

### R1 — glyph-level text removal

Collect F2 `glyph` hits inside the redaction rects; group by
`(cowPath, streamIndex, opIndex)`. For each affected show op, rewrite it to drop
the covered glyphs while preserving the positioning of survivors:

- A glyph whose device quad **intersects** a rect is removed (conservative — any
  overlap removes the whole glyph).
- `Tj`/`'`/`"`: split into a `TJ` (or a sequence of show ops) where removed runs
  become numeric adjustments equal to their text-space advance, so following
  glyphs keep their original positions.
- `TJ`: drop or split covered string elements, inserting a numeric shift equal to
  the removed advance.

Output goes through F1 (`replaceOps`), targeting the correct stream/clone.

### R2 — image removal

For each F2 `image` hit:

- **Fully inside** a rect → remove the draw. For a `Do`, remove the `Do` op; if a
  `q…cm…Do…Q` group exists solely to place this image, remove the group,
  otherwise leave surrounding state ops intact. For an inline image, remove the
  `BI…EI` op.
- **Partial overlap** → throw `UnsupportedFeatureError` (clipping is out of
  scope).

### R3 — resource & metadata sanitization

After R1/R2:

- Recompute the resource names still referenced by the surviving ops of each
  edited stream (`Tf` → Font, `Do` → XObject, `gs` → ExtGState, etc.). Delete
  unused entries from the page's COW'd `/Resources` sub-dicts. Objects that
  thereby become unreachable are swept by `Save()`; objects still referenced by
  other pages stay reachable and are kept. This is what makes removed text
  unrecoverable from leftover resources.
- Optional `scrubMetadata` flag → call `ClearMetadata()` to drop `/Info` + XMP.

### R4 — redaction box painting

Paint an opaque filled rectangle (default black; configurable fill color) over
each rect via `appendContent` + the `PageGraphics` layer. Appended **after**
removal so the marker sits on top of remaining content.

### R5 — public API + verification

```ts
page.Redact(rects: Rect[], opts?: RedactOptions): void   // Rect = [x0,y0,x1,y1]
doc.Redact(page: number, rects: Rect[], opts?): void     // convenience
// RedactOptions: { color?: [r,g,b]; scrubMetadata?: boolean }
```

Orchestration: `F2.mapRegions` → R1 text removal → R2 image removal → R3
sanitize → R4 box paint, all through one F1 edit pass (single write-back).

**Verification (the redaction guarantee):** integration tests assert that for a
redacted region (a) `GetText()` returns none of the removed text, and (b) a raw
scan of the **inflated** content streams of `Save()` output contains none of the
removed text bytes. The COW fixture (text drawn via an XObject shared by two
pages) proves the other page still renders the original text.

## Flatten track (`flatten.ts`)

### L1 — flatten annotations

For each page annotation with an `/AP /N` appearance:

- Register the appearance Form XObject in the page's COW'd `/Resources`
  (`XObject`), under a fresh key.
- Append a draw that maps the XObject's `/BBox` (through its `/Matrix`) onto the
  annotation `/Rect` — the algorithm PDF viewers use: transform the BBox by the
  Matrix, then scale/translate the transformed bounding box to the Rect.
- Remove the annotation from `/Annots`.

Skip annotations flagged Hidden or NoView. Transparency/blend-mode fidelity is
best-effort, consistent with the Phase 3 non-goal.

### L2 — flatten form fields

Call `Form.GenerateAppearances()` to ensure every widget has an `/AP`, flatten
the widget annotations via the L1 mechanism, then remove the AcroForm
(`/Root /AcroForm`) and the widget annotations from their pages.

### L3 — public API

```ts
doc.FlattenAnnotations(): void   // all pages
doc.FlattenForm(): void          // fields → static content, drop AcroForm
```

Tests confirm appearances render in page content and that `/Annots` / AcroForm
are gone after Save/Open.

## Search/replace track (`textedit.ts`)

### S1 — text search

Over F2's positioned glyphs (reusing word/line assembly), find matches for a
string or `RegExp` and return them as `{ text, quads, hits }`, where `hits`
carries op provenance for S2.

### S2 — constrained text replace

Replace the matched glyphs' code bytes in place with the replacement re-encoded
in the **same font and encoding**:

- Invert simple-font encodings (WinAnsi/MacRoman/Standard/PDFDoc and
  `/Differences`) to map replacement characters → codes.
- Type0/Identity-H or any character not representable in the font's encoding →
  throw `UnsupportedFeatureError`.
- **No reflow:** original positioning ops are preserved, so a replacement of
  different width may overlap or leave a gap. This is documented, not corrected.

Edits go through F1.

### S3 — public API

```ts
page.ReplaceText(find: string | RegExp, replacement: string, opts?): void
doc.ReplaceText(find: string | RegExp, replacement: string, opts?): void
```

Tests confirm the replacement is extractable via `GetText()` and the original is
gone, round-tripping through Save/Open.

## Errors

- `UnsupportedFeatureError` — partially-covered image in redaction; replacement
  text not representable in the target font's encoding (incl. Type0).
- `TypeError` — malformed rectangles or arguments (non-finite numbers, wrong
  arity), consistent with the rest of the public API.

## Testing strategy

Per-issue vitest TDD with programmatic fixture builders in `test/helpers/`:

- Content with **direct** page text (baseline redaction/replace).
- Text drawn through a **Form XObject shared by two pages** (proves COW
  isolation — the unredacted page keeps its text).
- Pages with image XObjects and inline images (full-cover removal; partial-cover
  throw).
- Annotations with `/AP` and AcroForm fields (flatten).

Every track asserts a Save/Open round-trip. Redaction additionally asserts the
raw-byte-scan guarantee on inflated content.

## Non-goals (Phase 4)

- Text **reflow** / re-layout after replacement; font subsetting or embedding
  changes.
- **Partial-image** clipping or re-encoding (partial overlap throws).
- Redaction driven by a **text query** (composes S1 in a later phase; Phase 4 is
  rectangle-driven).
- OCR or redaction of **rasterized** text inside images.
- Blend-mode / soft-mask fidelity when flattening (best-effort appearance only).

## Module / file layout

| Module | Track | Responsibility |
|---|---|---|
| `editcontent.ts` | F1 | `EditableContent`: per-stream op lists, edit, write-back, XObject COW |
| `text.ts` (refactor) | F2 | content visitor with glyph/image provenance; `extractText` + `mapRegions` consumers |
| `redact.ts` | R1–R5 | glyph removal, image removal, sanitize, box paint, `Redact` API |
| `flatten.ts` | L1–L3 | flatten annotations + form fields, `Flatten*` API |
| `textedit.ts` | S1–S3 | search, constrained replace, `ReplaceText` API |

Each implementation issue (`638.2`–`638.14`) follows the repo's
spec → plan → implementation cycle; this document is their shared spec.
