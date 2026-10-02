# MakeSearchable — design (`3ywf.3`)

Epic `3ywf` (AI copilots). Builds on `3ywf.2` (`AiModel`, `openAiModel`) and
the network decision `3ywf.1`: the library reaches a host only through an
object the caller constructs.

## Goal

`doc.MakeSearchable(engine, opts?)` turns pages that are only pictures into
pages whose words `GetText`, `Search`, copy-paste and indexers find. The page
must look identical: the added text is invisible (`3 Tr`) and sits exactly over
the words in the picture, so a search highlight lands on the word.

## Decisions taken in brainstorming

1. **An `OcrEngine` interface plus an adapter over `AiModel`.** Vision LLMs read
   well and box poorly; dedicated OCR (Tesseract, cloud OCR) boxes well. The
   engine is the seam, `aiOcrEngine(model)` is one implementation, and anything
   else is a few-line adapter on the caller's side — `3ywf.2`'s shape.
2. **Pages that already have text are skipped and reported** (OCRmyPDF's
   `--skip-text`). `pages` narrows the run; `force: true` OCRs anyway and ADDS a
   layer without removing any old one. A "redo" that removes an old layer is
   out of scope.
3. **A built-in glyphless font.** An embedded composite TrueType font with one
   empty glyph; each distinct character gets a code, `/ToUnicode` maps codes
   back, every code renders the empty glyph — never `.notdef`. Any script, no
   font files, validators satisfied.
4. **The stretch is baked into `Tm`**, not `Tz`: font size 1, and each span's
   text matrix maps its natural width onto its box. (Brainstorming first said
   `Tz`; the matrix form is exact and handles rotation with no special case.)
5. **Spans, not words.** The engine returns text spans, a word or a whole line.
   Uniform glyph advances spread a line's characters evenly across its box, so
   a search inside a line highlights roughly the right slice.
6. **Tagged documents get the layer as `/Artifact`**; untagged documents get
   no marked content.

## Public API

```ts
// src/ocr.ts — types only
export interface OcrImage {
  bytes: Uint8Array; mediaType: 'image/png' | 'image/jpeg';
  width: number; height: number;              // pixels
}
export interface OcrSpan {
  text: string;
  box: [x0: number, y0: number, x1: number, y1: number]; // image pixels, top-left origin, x0<x1, y0<y1
}
export interface OcrEngine {
  recognize(image: OcrImage, opts: { signal?: AbortSignal }): Promise<OcrSpan[]>;
}

// Document
MakeSearchable(engine: OcrEngine, opts?: MakeSearchableOptions): Promise<MakeSearchableReport>;

export interface MakeSearchableOptions {
  pages?: number[] | string;   // resolvePages syntax: [1, 3] or "1-5,8"; default all
  force?: boolean;             // OCR pages that already have text; default false
  dpi?: number;                // render resolution; default 200
  signal?: AbortSignal;
  onPage?: (r: MakeSearchablePage) => void;   // after each page
}
export interface MakeSearchablePage {
  page: number;                                // 1-based
  status: 'ocr' | 'skipped' | 'failed';
  reason?: 'has-text' | string;                // skipped: 'has-text'; failed: the error message
  spans: number;                               // spans written
  dropped: number;                             // spans refused (bad box, empty text)
}
export interface MakeSearchableReport { pages: MakeSearchablePage[] }

// src/aiocr.ts
export function aiOcrEngine(model: AiModel, opts?: { language?: string; maxTokens?: number }): OcrEngine;
```

## Units

| Module | Role | Depends on |
|---|---|---|
| `src/ocr.ts` | the types above | nothing |
| `src/glyphless.ts` | the glyphless font: TrueType bytes, a code assigner, and the Type0/CIDFontType2/descriptor/`/ToUnicode`/`CIDToGIDMap` objects | `sfntwrite.ts`, `types.ts` — no `Document` |
| `src/ocrlayer.ts` | spans + device matrix + codes → content-stream bytes; the pixel→user-space inverse | `ocr.ts`, `glyphless.ts` types — no `Document` |
| `src/aiocr.ts` | `aiOcrEngine` | `aimodel.ts`, `ocr.ts`, `errors.ts` |
| `src/makesearchable.ts` | orchestration; the only one touching a `Document` | the above, `pagecontent.ts`, `pagerange.ts`, `pagerender.ts` |

### `glyphless.ts`

- **The program:** a TrueType assembled with `assembleSfnt` from `head`,
  `hhea`, `maxp`, `hmtx`, `loca`, `glyf`, `cmap`, `name`, `OS/2`, `post`. Two
  glyphs: 0 `.notdef` and 1 empty, both zero-length `glyf` entries,
  `unitsPerEm` 1000, advance 500. Built once per process and reused.
- **Codes:** a `GlyphlessCodes` assigner maps each distinct Unicode string
  (one user-perceived character — a code point, so astral characters get one
  code) to a 2-byte code starting at 1, in order of first use, refusing past
  65,535 distinct characters. `encode(text)` returns the code bytes.
- **Objects:** `/Type0`, `/BaseFont /GlyphLessFont`, `/Encoding /Identity-H`,
  one `/CIDFontType2` descendant with `/CIDSystemInfo (Adobe)(Identity)0`,
  `/DW 500`, `/CIDToGIDMap` a stream of `2 × (maxCode + 1)` bytes mapping
  code 0 to GID 0 and every other code to GID 1, a descriptor with
  `/FontFile2`, flags Symbolic, and `/ToUnicode` with one `bfchar` entry per
  code (UTF-16BE, surrogate pairs for astral characters).
- **Invariant:** every code ≥ 1 maps to GID 1, never 0 — `NotdefUsed`
  (ISO 14289-2 8.4.5) does NOT exempt render mode 3.
- **Invariant:** `/ToUnicode` and `/CIDToGIDMap` are written ONCE, after
  the run, from the final assigner — so the font object is created at the
  start and filled at the end, and every page shares it.

### `ocrlayer.ts`

- **Device matrix:** `D = baseMatrix(page, 'crop') × [s, 0, 0, s, 0, 0]` with
  `s = dpi / 72` — exactly `renderCanvas`'s composition. One exported helper
  computes it and `makesearchable.ts` uses it for both the render size and the
  inverse; the renderer and the layer must not disagree about where a pixel is.
- **Per span:** with `I = D⁻¹` and box `(x0, y0, x1, y1)`:
  - origin `o = I(x0, y1)` (bottom-left of the box, the baseline),
  - along `a = I_linear(x1 − x0, 0) / natural`, where
    `natural = 0.5 × codeCount` (advance 500/1000 em, font size 1),
  - up `u = I_linear(0, −(y1 − y0))`,
  - `Tm = [a.x, a.y, u.x, u.y, o.x, o.y]`, then `<codes hex> Tj`.
- **Stream:** `BT /<key> 1 Tf 3 Tr` … one `Tm`+`Tj` per span … `ET`, wrapped by
  `wrapArtifact` when the document is tagged.
- **Refused spans** (counted in `dropped`): a box with non-finite coordinates,
  `x1 ≤ x0` or `y1 ≤ y0`, a box wholly outside the image (partly outside is
  clamped to the image), text empty or whitespace-only after NFC
  normalization. Text is NFC-normalized before encoding.

### `makesearchable.ts`

1. Validate `engine` (an object with a `recognize` function — `TypeError`),
   `dpi` (finite, > 0, ≤ 1200 — `RangeError`), `pages` via `resolvePages`.
   Throw `UnsupportedFeatureError` on a signed document: adding a content
   stream to every page invalidates the signatures, and refusing is honest.
2. Create the glyphless font objects (allocated once).
3. For each selected page in order:
   - `signal?.aborted` → throw `signal.reason` (pages already done keep their
     layer — each is a complete, valid edit, and discarding paid-for OCR is
     worse).
   - Unless `force`: `page.GetText().trim() !== ''` → `skipped`, `has-text`.
   - Render `page.ToImage({ format: 'png', scale: dpi / 72 })`; read width and
     height from the PNG header.
   - `await engine.recognize(image, { signal })`. A throw → `failed` with the
     message; the run continues. A caller abort → rethrow.
   - Validate the returned value is an array of `{ text: string, box: four
     numbers }`; anything else → `failed`.
   - Build the layer; register the font under a fresh key in the page's own
     `/Resources /Font` (`ensureOwnResources`, `ensureOwnSubdict`, `freshKey`);
     `appendContent`.
   - `onPage(record)`.
4. Fill the font's `/ToUnicode` and `/CIDToGIDMap` from the assigner (no `/W`: every code has the `/DW 500` advance). If no
   page wrote a span, the font objects are left unreferenced for `Save()`'s
   sweep.
5. `markModified()` only if some page was written.

### `aiocr.ts`

- **Request:** a system message stating the task (transcribe all visible text
  as lines, reading order, boxes on a 0–1000 grid over the image with origin
  top-left), the `language` hint when given, then the image as an
  `AiContentPart`. `schema`:
  `{ name: 'ocr_lines', schema: { type: 'object', additionalProperties: false,
  required: ['lines'], properties: { lines: { type: 'array', items: { type:
  'object', additionalProperties: false, required: ['text', 'box'],
  properties: { text: { type: 'string' }, box: { type: 'array', items:
  { type: 'number' }, minItems: 4, maxItems: 4 } } } } } } }`.
  `maxTokens` default 4096.
- **Reply:** `JSON.parse(text)`; must be `{ lines: [...] }` with each line a
  string `text` and four finite numbers in `box`. Anything else throws
  `AiServiceError('OCR reply is not the requested shape')`. Coordinates are
  scaled `× width/1000`, `× height/1000`; a box is normalized so x0 ≤ x1 and
  y0 ≤ y1. Lines map 1:1 to `OcrSpan`s.
- Never throws past what `model.complete` throws plus the shape error; the
  page-level catch in `makesearchable.ts` records it.

## Testing

No network, no real model, no OCR engine installed.

- **Geometry (the oracle):** a fake engine returns known spans; afterwards
  `page.GetTextFragments()` must report each span's text with a quad matching
  the box mapped back to points within 0.5 pt — for `/Rotate` 0, 90, 180, 270
  and an offset CropBox. The extractor is an independent implementation, so
  this checks the inverse transform against something it does not compute.
- **Invisible:** `page.ToImage()` before and after are byte-identical.
- **Scripts:** Latin, Cyrillic, CJK, Arabic, and an astral character
  round-trip through `GetText` and `doc.Search`.
- **Font:** the glyphless TrueType parses with our own `parseSfnt`; every code
  maps to GID 1; `/ToUnicode` parses with `parseCMap` back to the characters.
- **Validators:** a PDF/A-2b document stays conformant (`ValidatePdfA('2b')`
  gains no issue); a tagged document gains no `UntaggedContent` and no part-2
  font finding from `ValidatePdfUa(2)`.
- **Orchestration:** skip-has-text and its report; `force`; `pages`; a failing
  engine page recorded while the next page succeeds; abort between pages
  (completed page keeps its layer, call throws); a signed document refused;
  one shared font object across pages; unreferenced font when nothing written.
- **Spans:** zero-area, inverted, non-finite, outside-image, whitespace-only
  boxes dropped and counted; partly-outside clamped.
- **aiOcrEngine:** against a stub `AiModel` — the request carries the image
  and schema; 0–1000 scaling to pixels; inverted boxes normalized; malformed
  replies throw `AiServiceError`.
- **Mutation checks:** the inverse transform, the rotation, the `/ToUnicode`
  mapping, `3 Tr`, skip-has-text, code→GID 1.

## Documentation

README: a "Make Scanned Pages Searchable" example (`aiOcrEngine(
openAiModel(...))`, plus a few-line custom engine), API rows for every export;
CLAUDE.md Source-list entries; CHANGELOG `[Unreleased]` **Added**.

## Out of scope

Removing or replacing an existing OCR layer; deskew, despeckle or other image
cleanup; tagging OCR text as real structure; any bundled OCR engine;
concurrency across pages.
