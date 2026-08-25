# HTML Raster Backdrop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `ToHtml({ mode: 'fixed' })` two raster backdrops beside its vector one — `'raster'` (graphics only, text stays real) and `'page'` (whole page, text goes transparent) — and rename the option key across the exports that collide on it.

**Architecture:** `htmlfixed.ts`'s existing `interpret` pass is untouched and keeps producing the spans; a raster mode adds a second, independent pass through `raster.ts` and swaps the `<img>` in for the `<svg>`. Glyph suppression is a new `raster.ts` export whose only difference from `renderPageToPng` is that `RasterSink.glyphRun` short-circuits.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-html-raster-backdrop-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every relative import carries the `.js` extension, even from a `.ts` file.
- **`backdrop` absent must be byte-identical to today.** Task 5 is the fence for this. It is the assertion that the feature is additive — never edit it to match new output.
- **Do not touch the text half.** `HtmlSink.glyphRun`'s span construction, `htmlfont.ts` and `htmlfontembed.ts` are out of scope (`kf8h.2`: "do not rebuild HtmlSink's span emission"). Task 2 changes only `finish()`.
- **`page.ToImage` and `ImageOptions` do not change.** The glyph-less render is a separate export, following `renderFormToRgba` in the same file.
- **The double-draw in DOCX is `tvc4`, not this plan.** Task 6 renames DOCX's key and value; it must not change what DOCX renders.
- Run `npm run typecheck` and `npm test` before closing. Target one file with `npx vitest run test/<name>.test.ts`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/raster.ts` (modify) | Gains `renderPageGraphicsToPng` — `renderPageToPng` with glyphs suppressed. `RasterSink` gains one private flag. |
| `src/htmlfixed.ts` (modify) | `HtmlSink.finish` splits into `svg()` + `spans()`; `fixedBody` picks a backdrop per page and degrades to vector. |
| `src/html.ts` (modify) | `HtmlOptions` gains `backdrop` + `backdropScale`; `FIXED_CSS` gains the `<img>` and transparent-span rules. |
| `src/docxexport.ts` (modify) | `background` → `backdrop`, `'raster'` → `'page'`. Mechanical. |
| `src/document.ts` (modify) | One doc comment naming the old DOCX option. |
| `test/html-raster-backdrop.test.ts` (create) | Every new behaviour: both raster modes, the pixel probes, the degrade rule. |
| `test/html.test.ts` (modify) | The byte-identity fence for `backdrop` absent. |
| `test/docx-flow-identity.test.ts`, `test/docx-textbox-media.test.ts` (modify) | Re-point to the renamed DOCX option. |

---

### Task 1: `renderPageGraphicsToPng` — the glyph-less render

**Files:**
- Modify: `src/raster.ts` (`RasterSink` at 834-1202; `renderPageToPng` at 1207)
- Create: `test/html-raster-backdrop.test.ts`

**Interfaces:**
- Consumes: `ImageOptions`, `RasterSink`, `Canvas`, `baseMatrix`, `interpret` — all already in `raster.ts`.
- Produces, relied on by Task 3:
  - `renderPageGraphicsToPng(doc: Document, page: Page, opts?: ImageOptions): Uint8Array`

- [ ] **Step 1: Write the failing test**

Create `test/html-raster-backdrop.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { renderPageGraphicsToPng } from '../src/raster.js';
import { decodePng } from './helpers/decode-png.js';

/** A4 height in points — the fixture's page, and the y-flip reference. */
const H = 842;

/** A page with one line of 36pt text and one filled red rect below it. The rect
 *  is the graphics half, the text the half a glyph-less render must drop.
 *
 *  36pt on purpose: the probes below count dark pixels inside a glyph's quad,
 *  and thin text at body size leaves too few to assert on confidently. If a
 *  probe is ever awkward, make the font BIGGER — never loosen the assertion. */
function textAndRect(): Document {
  const doc = Document.New();
  const { page } = doc.AddPage();
  page.AddText('Hello', 50, 700, { fontSize: 36 });
  const g = page.Graphics();
  g.setFillColor([1, 0, 0]).rect(50, 400, 200, 100).fill();
  g.apply();
  return doc;
}

/** Dark pixels inside a PDF-page-space box, in a PNG rendered at scale 1.
 *
 *  Renders at scale 1 so one point is one pixel, and flips y: PDF space is
 *  bottom-up, a raster top-down. `decodePng().at(x, y)` returns [r,g,b,a]. */
function darkPixelsIn(png: Uint8Array, quad: [number, number, number, number]): number {
  const img = decodePng(png);
  const [x0, y0, x1, y1] = quad;
  let n = 0;
  for (let y = Math.round(H - y1); y < Math.round(H - y0); y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) {
      if (y < 0 || y >= img.height || x < 0 || x >= img.width) continue;
      const [r, g] = img.at(x, y);
      if (r < 128 && g < 128) n++;
    }
  }
  return n;
}

/** The first text fragment's quad — where the glyphs actually landed, rather
 *  than a coordinate guessed from the AddText call. */
const glyphQuad = (doc: Document) =>
  doc.Pages[0].GetTextFragments()[0].quad as [number, number, number, number];

describe('renderPageGraphicsToPng', () => {
  it('keeps the graphics', () => {
    const doc = textAndRect();
    const img = decodePng(renderPageGraphicsToPng(doc, doc.Pages[0], { scale: 1 }));
    // Inside the red rect: page-space (150, 450) -> device (150, 842-450).
    const [r, g, b] = img.at(150, H - 450);
    expect([r, g, b]).toEqual([255, 0, 0]);
  });

  it('drops the glyphs', () => {
    // The claim itself, measured at pixels INSIDE the glyphs rather than by
    // comparing the two PNGs — "they differ" would pass if the flag changed
    // anything at all.
    const doc = textAndRect();
    const png = renderPageGraphicsToPng(doc, doc.Pages[0], { scale: 1 });
    expect(darkPixelsIn(png, glyphQuad(doc))).toBe(0);
  });

  it('page.ToImage still draws them', () => {
    // The companion that stops the above passing because the fixture is blank
    // or the quad is off the page.
    const doc = textAndRect();
    const png = doc.Pages[0].ToImage({ scale: 1 });
    expect(darkPixelsIn(png, glyphQuad(doc))).toBeGreaterThan(0);
  });
});
```

**Note:** `test/helpers/decode-png.ts` already exists and is what
`test/raster-clip.test.ts` and friends use — do not write a second PNG reader.
Its `DecodedPng` exposes `width`, `height` and `at(x, y): [r,g,b,a]`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/html-raster-backdrop.test.ts`
Expected: FAIL — `renderPageGraphicsToPng is not exported by src/raster.ts`.

- [ ] **Step 3: Implement**

In `src/raster.ts`, give `RasterSink` a suppression flag. Change its constructor
signature (it is `constructor(doc, canvas)` — find the existing one and add the
third parameter, defaulted so every current call site is unaffected):

```ts
  constructor(
    private doc: Document, private canvas: Canvas,
    /** Skip every glyph run. `renderPageGraphicsToPng`'s whole difference from
     *  `renderPageToPng`: the HTML fixed-mode `backdrop: 'raster'` layer draws
     *  its text as real HTML spans, so glyphs baked into the backdrop would be
     *  drawn twice, once here and once by the browser with a substituted face. */
    private skipGlyphs = false,
  ) {}
```

Keep whatever the existing constructor body and other parameter modifiers are —
only the new parameter is added.

Then guard `glyphRun` (currently at 1196-1198):

```ts
  glyphRun(info: TextRunInfo): void {
    if (this.skipGlyphs) return;
    rasterizeGlyphRun(this.canvas, info, this.glyphSourceFor(info), this.paintFor('fill'));
  }
```

`clipToGlyphs` is deliberately NOT guarded: it uses glyph outlines as a *clip*
for other paint, so suppressing it would drop the graphics that clip reveals,
which is exactly the content this render exists to keep.

Now refactor `renderPageToPng` so the two entries share one body. Replace the
existing `export function renderPageToPng(...)` header with a private worker
plus two exports, keeping the body verbatim except for the marked line:

```ts
function renderPage(
  doc: Document, page: Page, opts: ImageOptions, skipGlyphs: boolean,
): Uint8Array {
  // ... the existing renderPageToPng body, unchanged, up to the sink line ...
  const sink = new RasterSink(doc, canvas, skipGlyphs);   // <- only changed line
  // ... rest unchanged ...
}

/** Render one page to a PNG. */
export function renderPageToPng(
  doc: Document, page: Page, opts: ImageOptions = {}): Uint8Array {
  return renderPage(doc, page, opts, false);
}

/** Render one page's GRAPHICS to a PNG, with every glyph run suppressed.
 *
 *  Exists for `htmlfixed.ts`'s `backdrop: 'raster'`, which pairs this with real
 *  HTML text spans — the same reason `renderFormToRgba` below exists for
 *  `svgembed.ts`. `ImageOptions` gains nothing and `page.ToImage` is unchanged.
 *
 *  **Note:** `interpret` composites annotation `/AP` streams, so a `/FreeText`
 *  annotation's glyphs are suppressed here too — and emitted as spans by the
 *  caller, so the two layers stay consistent. That is why the suppression lives
 *  in the sink and not in a pre-pass over page content, which would miss them. */
export function renderPageGraphicsToPng(
  doc: Document, page: Page, opts: ImageOptions = {}): Uint8Array {
  return renderPage(doc, page, opts, true);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/html-raster-backdrop.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck and check nothing else moved**

Run: `npm run typecheck` — no output, exit 0.

Run the rasterizer's own suite, which is the evidence that defaulting
`skipGlyphs` left every existing caller alone:

```bash
npx vitest run test/raster-clip.test.ts test/raster-image.test.ts \
  test/raster-shading.test.ts test/raster-cid-encoding.test.ts \
  test/annotrender.test.ts test/jpx-render.test.ts
```

Expected: PASS, all unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/raster.ts test/html-raster-backdrop.test.ts test/helpers/png-read.ts
git commit -m "$(cat <<'EOF'
feat(raster): renderPageGraphicsToPng — a page render with glyphs suppressed

One export beside renderPageToPng, differing only in that RasterSink.glyphRun
short-circuits. For htmlfixed.ts's backdrop:'raster', which pairs a glyph-less
backdrop with real HTML text spans. ImageOptions and page.ToImage unchanged,
following renderFormToRgba's precedent in the same file.

clipToGlyphs is deliberately not suppressed: it clips OTHER paint to glyph
outlines, so dropping it would drop the graphics that clip reveals.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Split `HtmlSink.finish` into its two layers

**Files:**
- Modify: `src/htmlfixed.ts` (`finish` at ~85-88, `fixedBody` at 89-110)

**Interfaces:**
- Consumes: nothing new.
- Produces, relied on by Task 3:
  - `HtmlSink.svgLayer(width: number, height: number): string`
  - `HtmlSink.spanLayer(): string`

This task is a pure refactor: no behaviour changes and no new test. Its gate is
that the existing suite stays green.

- [ ] **Step 1: Implement**

In `src/htmlfixed.ts`, replace:

```ts
  /** The SVG backdrop followed by the positioned spans. */
  finish(width: number, height: number): string {
    return this.svg.finish(width, height) + this.spans.join('');
  }
```

with:

```ts
  /** The vector backdrop alone. A raster mode drops this and keeps the spans. */
  svgLayer(width: number, height: number): string {
    return this.svg.finish(width, height);
  }

  /** The positioned spans alone — emitted in every mode, since the text layer
   *  is what makes a fixed-mode page selectable whatever is behind it. */
  spanLayer(): string {
    return this.spans.join('');
  }
```

And in `fixedBody`, replace:

```ts
    divs.push(`<div class="pg" style="width:${fmt(width)}px;height:${fmt(height)}px">`
      + sink.finish(width, height) + `</div>`);
```

with:

```ts
    divs.push(`<div class="pg" style="width:${fmt(width)}px;height:${fmt(height)}px">`
      + sink.svgLayer(width, height) + sink.spanLayer() + `</div>`);
```

- [ ] **Step 2: Verify nothing moved**

Run: `npx vitest run test/html.test.ts test/html-identity.test.ts`
Expected: PASS, unchanged. Concatenating the two layers in the same order is
the same string, so a failure here means the split changed something and must
be investigated rather than accepted.

Run: `npm run typecheck` — no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/htmlfixed.ts
git commit -m "$(cat <<'EOF'
refactor(htmlfixed): split finish() into svgLayer() and spanLayer()

A raster backdrop replaces the SVG and keeps the spans, so the two layers have
to be separately available. Pure refactor: the call site concatenates them in
the same order, so the output is byte-identical.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The `backdrop` option and the two raster modes

**Files:**
- Modify: `src/html.ts` (`HtmlOptions` at 7-24, `FIXED_CSS` at ~38-42)
- Modify: `src/htmlfixed.ts` (imports, `fixedBody`)
- Modify: `test/html-raster-backdrop.test.ts` (append)

**Interfaces:**
- Consumes: `renderPageGraphicsToPng` (Task 1); `svgLayer`/`spanLayer` (Task 2).
- Produces: `HtmlOptions.backdrop`, `HtmlOptions.backdropScale`.

- [ ] **Step 1: Write the failing test**

Append to `test/html-raster-backdrop.test.ts`:

```ts
describe("backdrop: 'raster'", () => {
  it('emits an <img> and no <svg>', () => {
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'raster' });
    expect(html).toContain('<img src="data:image/png;base64,');
    expect(html).not.toContain('<svg');
  });

  it('keeps the text spans visible', () => {
    // The whole point of this mode over 'page': the text is real, styled HTML.
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'raster' });
    expect(html).toContain('>Hello<');
    expect(html).not.toContain('class="pg sel"');
  });
});

describe("backdrop: 'page'", () => {
  it('emits an <img> and makes the spans transparent', () => {
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'page' });
    expect(html).toContain('<img src="data:image/png;base64,');
    expect(html).toContain('class="pg sel"');
    expect(html).toContain('.sel>span{color:transparent}');
  });

  it('still emits the text, because transparent text is what makes it selectable', () => {
    // A mode that dropped the spans would be page.ToImage with extra steps.
    expect(textAndRect().ToHtml({ mode: 'fixed', backdrop: 'page' })).toContain('>Hello<');
  });
});

describe('the emitted backdrops differ in what they hold', () => {
  // Two opposite assertions on the SAME pixel box, read out of the actual
  // emitted HTML rather than by calling the renderers again — which is what
  // proves fixedBody routes each mode to the right one.
  it("'raster' bakes no glyphs into its <img>", () => {
    const doc = textAndRect();
    const html = doc.ToHtml({ mode: 'fixed', backdrop: 'raster', backdropScale: 1 });
    expect(darkPixelsIn(pngOf(html), glyphQuad(doc))).toBe(0);
  });

  it("'page' bakes them in", () => {
    const doc = textAndRect();
    const html = doc.ToHtml({ mode: 'fixed', backdrop: 'page', backdropScale: 1 });
    expect(darkPixelsIn(pngOf(html), glyphQuad(doc))).toBeGreaterThan(0);
  });
});

describe('backdropScale', () => {
  it('defaults to 2', () => {
    // Asserted through the emitted PNG's own dimensions rather than by reading
    // the option back, so it measures what shipped. The fixture page is A4:
    // 595 x 842 points.
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'page' });
    expect(decodePng(pngOf(html)).width).toBe(Math.round(595 * 2));
  });

  it('is honoured when set', () => {
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'page', backdropScale: 1 });
    expect(decodePng(pngOf(html)).width).toBe(595);
  });
});

/** The bytes of the first data:image/png in `html`. */
function pngOf(html: string): Uint8Array {
  const b64 = /<img src="data:image\/png;base64,([^"]+)"/.exec(html)![1];
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/html-raster-backdrop.test.ts`
Expected: FAIL — `backdrop` is not a known property of `HtmlOptions` (a
typecheck error inside vitest), and no `<img>` in the output.

- [ ] **Step 3: Add the options**

In `src/html.ts`, add to `HtmlOptions` after the `fonts` field:

```ts
  /** What sits behind the text in `fixed` mode. Default `'vector'`.
   *
   *  `'vector'` draws page graphics as an inline SVG; `'raster'` draws them as
   *  a PNG with no glyphs in it; `'page'` rasterizes the WHOLE page, glyphs
   *  included, and turns the text layer transparent.
   *
   *  **Invariant:** the text treatment follows from this value and is never a
   *  separate option. A glyph-less backdrop needs visible text or the page has
   *  none; a full-page backdrop needs transparent text or every glyph is drawn
   *  twice — once baked in, once by the browser with a substituted face. The
   *  other two combinations are an invisible page and a double-drawn one, and
   *  a single three-valued option makes both unrepresentable. */
  backdrop?: 'vector' | 'raster' | 'page';
  /** Multiplier on the 72-DPI point size for a raster backdrop. Default 2, so
   *  the page is crisp on a HiDPI display at 100% zoom — the size at which a
   *  fixed-mode page is actually read. No width/height: they let a caller
   *  produce a raster whose aspect ratio does not match the page. */
  backdropScale?: number;
```

And extend `FIXED_CSS`:

```ts
const FIXED_CSS = [
  '.pg{position:relative;background:#fff;margin:0 auto 8px;overflow:hidden}',
  '.pg>svg{position:absolute;left:0;top:0}',
  '.pg>img{position:absolute;left:0;top:0;width:100%;height:100%}',
  '.pg>span{position:absolute;white-space:pre;line-height:1;transform-origin:0 0}',
  // backdrop:'page' only. The glyphs are already in the raster, so the spans
  // exist purely to be selected and found — painting them would double-draw.
  '.sel>span{color:transparent}',
].join('');
```

- [ ] **Step 4: Wire `fixedBody`**

In `src/htmlfixed.ts`, add to the imports:

```ts
import { renderPageGraphicsToPng } from './raster.js';
```

`page.ToImage` is a method, so the `'page'` render needs no import.

Replace the body of the `for (const page of pages)` loop's tail — the
`divs.push(...)` line from Task 2 — with:

```ts
    const kind = opts.backdrop ?? 'vector';
    let backdrop = '';
    if (kind !== 'vector') {
      const img = { scale: opts.backdropScale ?? 2, box, annotations: opts.annotations };
      try {
        const png = kind === 'page'
          ? page.ToImage(img)
          : renderPageGraphicsToPng(doc, page, img);
        backdrop = `<img src="data:image/png;base64,${Buffer.from(png).toString('base64')}">`;
      } catch {
        // **Invariant:** a page that will not rasterize falls back to 'vector',
        // both raster modes, one rule. docxexport.ts degrades by dropping the
        // backdrop and keeping the text, which is right there and wrong here:
        // in 'page' mode the text is transparent, so dropping the backdrop
        // leaves a BLANK page. Falling back restores the backdrop and the
        // visible text together — and costs nothing, because the vector
        // backdrop comes from the interpret pass that has already run.
      }
    }
    const sel = backdrop && kind === 'page' ? ' sel' : '';
    divs.push(`<div class="pg${sel}" style="width:${fmt(width)}px;height:${fmt(height)}px">`
      + (backdrop || sink.svgLayer(width, height)) + sink.spanLayer() + `</div>`);
```

Two things in that block are load-bearing and easy to "tidy" wrongly:

- **`sel` is keyed on `backdrop` being non-empty, not on `kind` alone.** A
  degraded `'page'` page must not carry the transparent-text class, or the
  fallback produces the blank page it exists to prevent. Task 4 proves this.
- **`img` does not pass `background`.** `renderPageToPng` already defaults it to
  `'white'`, which is what both raster modes want: `.pg` paints `background:#fff`
  behind the image, so an RGBA PNG would carry an alpha channel for an invisible
  difference at a cost in bytes. Passing `'transparent'` is the tempting change
  and is wrong.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/html-raster-backdrop.test.ts`
Expected: PASS, 11 tests.

Run: `npm run typecheck` — no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/html.ts src/htmlfixed.ts test/html-raster-backdrop.test.ts
git commit -m "$(cat <<'EOF'
feat(html): raster backdrops for fixed mode (kf8h.2)

backdrop: 'vector' | 'raster' | 'page', default 'vector'. 'raster' draws page
graphics as a glyph-less PNG and keeps real text spans; 'page' rasterizes the
whole page and turns the spans transparent, still selectable and findable.
Text treatment follows from the value rather than being a second option, so
the invisible-page and double-drawn combinations are unrepresentable.

With kf8h.3 already done, these plus mode:'semantic' cover all four modes Go
ships.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The degrade rule

**Files:**
- Modify: `test/html-raster-backdrop.test.ts` (append)

Task 3 wrote the fallback. This task proves it, because an untested `catch` is
indistinguishable from a `catch` that never runs.

**Interfaces:**
- Consumes: everything from Task 3.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Add `vi` to the existing vitest import at the TOP of
`test/html-raster-backdrop.test.ts` — `import { describe, it, expect, vi } from
'vitest';` — then append:

```ts
describe('a page that will not rasterize', () => {
  it('falls back to vector rather than emitting a blank page', () => {
    // The failure this rule exists to prevent: dropping only the backdrop, as
    // docxexport.ts does, leaves transparent text over nothing.
    //
    // `page.ToImage` is spied rather than mocked because doc.Pages[0] is a
    // STABLE object — measured — so the spy reaches the very instance fixedBody
    // calls. That is not true of `renderPageGraphicsToPng`, which htmlfixed.ts
    // holds as a direct ESM import binding that vi.spyOn on the namespace
    // cannot replace; the 'raster' half of this rule is covered by the shared
    // code path rather than by a second spy, since both modes run the same
    // try/catch and the same fallback expression.
    const doc = textAndRect();
    const spy = vi.spyOn(doc.Pages[0], 'ToImage').mockImplementation(() => {
      throw new Error('synthetic rasterizer failure');
    });
    const html = doc.ToHtml({ mode: 'fixed', backdrop: 'page' });
    spy.mockRestore();

    expect(html).toContain('<svg');               // the vector backdrop is back
    expect(html).not.toContain('class="pg sel"'); // and the text is visible
    expect(html).toContain('>Hello<');
  });

  it('a page that rasterizes fine is unaffected by the fallback path', () => {
    // Guards the above against passing because the fixture never rasterizes.
    const html = textAndRect().ToHtml({ mode: 'fixed', backdrop: 'page' });
    expect(html).toContain('<img');
    expect(html).toContain('class="pg sel"');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/html-raster-backdrop.test.ts`
Expected: PASS, 13 tests.

If `vi.spyOn` on the `Page` instance does not take, do NOT weaken the
assertions to make them pass. Reach for `vi.mock('../src/raster.js')` with
`importActual`, or build a document whose page genuinely fails to rasterize, and
record in the commit message which route you took.

- [ ] **Step 3: Prove the rule load-bearing**

In `src/htmlfixed.ts`, temporarily change the `sel` line to key on `kind` alone:

```ts
    const sel = kind === 'page' ? ' sel' : '';   // TEMPORARY — must go red
```

Run: `npx vitest run test/html-raster-backdrop.test.ts`
Expected: FAIL on "falls back to vector rather than emitting a blank page" —
the degraded page carries `class="pg sel"`, so its text is transparent over a
vector backdrop it cannot see through.

Restore the line exactly as Task 3 wrote it, re-run (13 pass), and confirm
`git diff src/htmlfixed.ts` is empty.

- [ ] **Step 4: Commit**

```bash
git add test/html-raster-backdrop.test.ts
git commit -m "$(cat <<'EOF'
test(html): pin the raster-backdrop degrade rule

A page that will not rasterize falls back to vector — backdrop AND visible text
together. Dropping only the backdrop, which is what docxexport.ts does, leaves
transparent text over nothing in 'page' mode: a blank page.

Confirmed load-bearing by keying the transparent-text class on the mode rather
than on the backdrop actually being emitted, which turns the case red.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The byte-identity fence

**Files:**
- Modify: `test/html.test.ts` (append)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the fence**

Append to `test/html.test.ts` — matching that file's existing import style,
adding only what is missing:

```ts
describe('backdrop is additive (kf8h.2)', () => {
  /** A page with text, vector graphics and an image — enough that a stray
   *  change to the backdrop path would show. */
  function page(): Document {
    const doc = Document.New();
    const { page } = doc.AddPage();
    page.AddText('Fence', 50, 700, { fontSize: 18 });
    const g = page.Graphics();
    g.setFillColor([0, 0, 1]).rect(50, 400, 120, 80).fill();
    g.apply();
    return doc;
  }

  it('omitting backdrop is byte-identical to passing vector', () => {
    // The fence: `backdrop` absent must behave exactly as it did before the
    // option existed. This is not a golden to refresh — a failure means the
    // feature stopped being additive.
    expect(page().ToHtml({ mode: 'fixed' }))
      .toBe(page().ToHtml({ mode: 'fixed', backdrop: 'vector' }));
  });

  it('the default output still contains its SVG backdrop and no image', () => {
    const html = page().ToHtml({ mode: 'fixed' });
    expect(html).toContain('<svg');
    expect(html).not.toContain('<img');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/html.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: PASS with no expectation edits. `test/html-identity.test.ts` is a
snapshot of the SEMANTIC export and must not move; if it does, stop and report
the diff rather than refreshing it.

- [ ] **Step 4: Commit**

```bash
git add test/html.test.ts
git commit -m "$(cat <<'EOF'
test(html): fence that backdrop is additive

`backdrop` absent must equal `backdrop: 'vector'` byte for byte. A fence, not
a golden — a failure means the option stopped being additive.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Rename the DOCX option

**Files:**
- Modify: `src/docxexport.ts` (24, 174, 185)
- Modify: `src/document.ts` (974, a doc comment)
- Modify: `test/docx-flow-identity.test.ts:31`, `test/docx-textbox-media.test.ts:56,79`

**Interfaces:**
- Consumes: nothing.
- Produces: `DocxOptions.backdrop?: 'none' | 'page'`.

This is mechanical and must change no rendered output. The DOCX double-draw is
`tvc4` and is deliberately left in place.

- [ ] **Step 1: Rename the option**

In `src/docxexport.ts` line 24, replace the `background` field with:

```ts
  /** Full-page raster behind the frames, in `textbox` mode. Default `'none'`.
   *
   *  `backdrop`, not `background`: `ImageOptions.background` already means
   *  `'white' | 'transparent'`, so a second meaning on a bag callers use in the
   *  same file has no compile-time guard. `'page'`, not `'raster'`, so the
   *  value agrees with `HtmlOptions.backdrop` — there `'raster'` means a
   *  GLYPH-LESS render and `'page'` the whole page, and this is the whole page.
   *
   *  **Known defect (`tvc4`):** the frames drawn over this raster are visible,
   *  so every glyph is drawn twice — once baked in, once re-rendered by Word
   *  with a substituted face. Renaming the option does not fix it. */
  backdrop?: 'none' | 'page';
```

At line 185, change the test:

```ts
  if (opts.backdrop === 'page') {
```

At line 174, update the comment's mention of `background: 'raster'` to
`backdrop: 'page'`.

- [ ] **Step 2: Update the doc comment in document.ts**

At `src/document.ts:974`, the comment mentions `` `background: 'raster'` ``.
Change it to `` `backdrop: 'page'` ``. Read the surrounding sentence first and
keep it grammatical.

- [ ] **Step 3: Re-point the tests**

`test/docx-flow-identity.test.ts:31` — `background: 'raster'` → `backdrop: 'page'`.
`test/docx-textbox-media.test.ts:56` and `:79` — the same.

- [ ] **Step 4: Verify**

Run: `npm run typecheck`
Expected: no output, exit 0. A missed call site is a compile error, which is
the point of renaming the key rather than accepting a second value.

Run: `npx vitest run test/docx-flow-identity.test.ts test/docx-textbox-media.test.ts`
Expected: PASS. **`docx-flow-identity` pins a sha256 and must not move** — the
rename changes an option name, never a byte of output. If that hash moves, stop:
something changed what DOCX renders, which this task must not do.

- [ ] **Step 5: Commit**

```bash
git add src/docxexport.ts src/document.ts test/docx-flow-identity.test.ts test/docx-textbox-media.test.ts
git commit -m "$(cat <<'EOF'
refactor(docx)!: background -> backdrop, 'raster' -> 'page'

ImageOptions.background already means 'white' | 'transparent', and HtmlOptions
now needs a third meaning, so the key is renamed everywhere it means "what sits
behind the content". The value follows: leaving 'raster' would make
backdrop:'raster' mean glyph-less in HTML and full-page in DOCX.

BREAKING for ToDocx callers. Package is 0.0.0. Renders identically —
docx-flow-identity's sha256 is unchanged.

Does not fix tvc4, the double-draw this option's semantics carry.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md` (the `html.ts`/`htmlfixed.ts` entry, and the `raster.ts` mention)
- Modify: `README.md` (HTML export section; DOCX option mention)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Find the entries**

```bash
grep -n "htmlfixed.ts" CLAUDE.md
grep -n "renderPageToPng\|raster.ts" CLAUDE.md | head
```

The four README sites, located while writing this plan — confirm each with
`grep -n` before editing, since line numbers drift:

| ~line | What it is |
|---|---|
| 64 | The `Export (PDF → HTML)` feature paragraph, which describes `mode: 'fixed'` as "an SVG vector backdrop" |
| 1957 | The `doc.ToHtml(options?)` API-table row |
| 1962 | The `doc.ToDocx(options?)` row, which names `background: 'raster'` |
| 2131 | The **HTML export** limitations bullet |

- [ ] **Step 2: Add the invariants to CLAUDE.md**

In the `html.ts`/`htmlsemantic.ts`/`htmlfixed.ts` bullet, append:

```markdown
  **Invariant:** `HtmlOptions.backdrop` picks what sits behind the text and the
  text treatment FOLLOWS from it: `'vector'` (inline SVG) and `'raster'`
  (glyph-less PNG) keep visible spans, `'page'` (whole-page PNG) makes them
  `color:transparent`. Never a second option — a glyph-less backdrop with
  transparent text is an invisible page, and a full-page backdrop with visible
  text draws every glyph twice, once baked in and once by the browser with a
  substituted face. One three-valued option makes both unrepresentable.
  `ToDocx({ mode: 'textbox' })` does exactly that double-draw today (`tvc4`).
  **Invariant:** the key is `backdrop`, not `background`, in BOTH
  `HtmlOptions` and `DocxOptions`. `ImageOptions.background` keeps
  `'white' | 'transparent'` — that one is a background colour. Three unrelated
  meanings on one key across bags callers mix in a file has no compile-time
  guard, unlike the `MarkdownExportOptions` collision recorded above. DOCX's
  value is `'page'` rather than `'raster'` for the same reason: in HTML
  `'raster'` means glyph-less.
  **Invariant:** a page that will not rasterize falls back to `'vector'` —
  backdrop and visible text together, one rule for both raster modes.
  `docxexport.ts` degrades by dropping the backdrop and keeping the text, which
  is right there and wrong here: with `'page'`'s transparent text, dropping the
  backdrop leaves a blank page. The transparent-text class is therefore keyed on
  the backdrop having actually been emitted, not on the mode.
  **Note, measured:** the glyph-less claim is pinned by a pixel probe INSIDE a
  glyph's own quad (from `GetTextFragments`), with the opposite assertion on the
  same box for `'page'`. Asserting only that the two PNGs differ would pass if
  the suppression flag changed anything at all.
```

In the `raster.ts` mention, append:

```markdown
  `renderPageGraphicsToPng` is `renderPageToPng` with `RasterSink.glyphRun`
  suppressed, for `htmlfixed.ts`'s `backdrop: 'raster'` — a separate export
  rather than an `ImageOptions` flag, as `renderFormToRgba` already is for
  `svgembed.ts`. `clipToGlyphs` is deliberately NOT suppressed: it clips other
  paint to glyph outlines, so dropping it would drop the graphics that clip
  reveals. The suppression lives in the sink because `interpret` composites
  annotation `/AP` streams — a `/FreeText`'s glyphs must be dropped here and
  emitted as spans by the caller, which a pre-pass over page content would miss.
```

- [ ] **Step 3: Update README.md**

**At ~64**, the sentence describing fixed mode ends "…one `interpret` pass so
text is never double-drawn." Insert after it:

> `backdrop` chooses what sits behind that text: `'vector'` (default) is the
> inline SVG just described, `'raster'` swaps it for a PNG of the page's
> graphics with no glyphs in it, and `'page'` rasterizes the whole page — glyphs
> included — and turns the text layer transparent, so it stays selectable and
> findable over a pixel-exact backdrop. A raster is exact by construction for
> the constructs SVG cannot express (a non-isolated group that blends
> internally, knockout groups, JBIG2), and bounds output size for a
> graphics-heavy page. `backdropScale` (default 2) multiplies the 72-DPI point
> size. The text treatment follows from `backdrop` and is never a separate
> option — the two other combinations are an invisible page and a double-drawn
> one. A page that fails to rasterize falls back to the vector backdrop with
> visible text.

**At ~1957**, extend the `doc.ToHtml` row's `mode: 'fixed'` parenthetical, which
currently reads "(positioned text over an SVG vector backdrop, with optional
`fonts: 'embed'` \| `'embed-all'` `@font-face` embedding)":

> (positioned text over a `backdrop: 'vector'` SVG (default), a `'raster'`
> glyph-less PNG, or a `'page'` full-page PNG with transparent selectable text;
> `backdropScale` defaults to 2; with optional `fonts: 'embed'` \|
> `'embed-all'` `@font-face` embedding)

**At ~1962**, in the `doc.ToDocx` row, change `` `background: 'raster'` for a
rendered page backdrop `` to `` `backdrop: 'page'` for a rendered page
backdrop ``.

**At ~2131**, the HTML export limitations bullet describes fixed mode as
"visual reproduction with absolutely positioned text over a vector backdrop".
Change "over a vector backdrop" to "over a vector or raster backdrop", and
append to that bullet:

> A raster backdrop is a second pass through the rasterizer, so a raster-backed
> page costs one extra interpretation of its content and produces a much larger
> file than the vector default; `backdropScale` is the only lever on its size,
> since exposing width/height would let the raster's aspect ratio diverge from
> the page's.

- [ ] **Step 4: Full verification**

Run: `npm test` — PASS, no expectation edits.
Run: `npm run typecheck` — no output, exit 0.

- [ ] **Step 5: Commit and close**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: HTML raster backdrops and the backdrop/background rename

Records why the text treatment is derived rather than chosen, why the degrade
falls back to vector rather than dropping the backdrop, and why the glyph-less
claim needs a pixel probe rather than a PNG comparison.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
bd close aspose-pdf-foss-for-ts-kf8h.2
```

---

## Notes for the implementer

**The fences.** `test/html.test.ts`'s new byte-identity case, the untouched
`test/html-identity.test.ts` snapshot, and `test/docx-flow-identity.test.ts`'s
sha256. None should move. Never run `vitest -u`, and never edit an expectation
to match new output — a red fence is information.

**On the pixel probes.** Task 1's "drops the glyphs" and Task 3's two opposite
assertions are the only things separating this feature from one that silently
does nothing. They read a box taken from `GetTextFragments`, not a guessed
coordinate. If a probe is awkward because the fixture's text is thin, make the
font BIGGER rather than loosening the assertion — 36pt is already chosen for
that reason.

**Where NOT to make changes.** `HtmlSink.glyphRun`'s span construction,
`htmlfont.ts`, `htmlfontembed.ts`. If you find yourself editing them, stop: the
spec's claim is that the text layer needs no change, and a change there means
the shape was wrong and needs re-deciding rather than patching.

**`tvc4` is out of scope.** Task 6 renames DOCX's option; it must not change
what DOCX renders. `docx-flow-identity`'s sha256 is the proof.
