# Public reusable Form XObject template API

Design for `aspose-pdf-foss-for-ts-lucg.3`, the third child of the
`Authoring breadth` epic (`lucg`). This library builds Form XObjects in eight
places and exposes no way for a caller to author one.

## Problem

A Form XObject is the format's draw-once-place-many primitive, and it is used
throughout `src/` — and nowhere by a caller:

- `compose.ts:57` (`importPageAsXObject`) turns a page into one for
  `StampWith`, `Overlay` and `NUp`.
- `svgdraw.ts` builds seven, for masks, filters, patterns and groups.
- `appearance.ts:217` and `buttonap.ts:180` build field appearances;
  `pagecontent.ts:160` builds a luminosity soft-mask group.

So the machinery is mature and entirely private. A caller who wants a
letterhead, a logo block, or a repeated badge has to redraw it per page, paying
for the content and its resources every time.

## Approach

**A new `template.ts`**, holding the `Template` class, the page-to-form
conversion and placement. `document.ts` gains only the `NewTemplate` entry
point, as it did for `NewTilingPattern`.

Two alternatives were considered:

- **Extend `compose.ts`.** It already owns `importPageAsXObject`. Rejected on
  direction: that module is *page-to-page* composition — stamp, overlay, N-up,
  resize — which runs the opposite way from an authoring primitive, and it is
  already 342 lines.
- **Reuse `importPageAsXObject` directly.** Tempting, since it converts a page
  to a form. Rejected because it routes through `importGraphInto` to deep-copy
  a resource graph from *another* document; used same-document it would
  duplicate every font and image the template touches.

## Scope

In scope:

- `Document.NewTemplate(width, height)` and the `Template` class.
- `Template.page`, `Template.PlaceOn(page, rect, opts?)`.
- Placement `fit` (`'stretch'` | `'contain'`), `opacity`, `rotation`, and
  `MarkOptions` tagging.
- Extracting `containMatrix` into `text.ts` so `placeFitted` and templates
  share one definition — and pinning that arithmetic *before* the extraction.
- README and CHANGELOG.

Out of scope, deliberately:

- **`TemplateFromPage(page)`**, capturing an existing in-tree page. The
  conversion would be the same function, so it is cheap to add later; nothing
  here forecloses it, and no one has asked.
- **Structure inside a template.** See §1.
- **Placing a template on a page of a different document.** The form's
  resources live in the template's document; a cross-document placement needs
  `importGraphInto`, which is `compose.ts`'s job and a different feature.

## Design

### 1. What a template is

`doc.NewTemplate(width, height)` returns a `Template` wrapping a **page dict
that is never registered as an object and never linked into the page tree**:

```ts
const tpl = doc.NewTemplate(200, 80);
tpl.page.AddImage(logoPng, [8, 8, 48, 48]);
tpl.page.AddText('ACME Corp.', 64, 30, { fontSize: 18 });
tpl.page.Graphics().drawLine(8, 4, 192, 4).stroke().apply();

for (const p of doc.Pages) tpl.PlaceOn(p, [40, 700, 200, 80]);
```

`tpl.page` is a real `Page` over that dict, so **every existing authoring API
works on it unchanged**. That is the whole reason for this shape: `AddText`,
`AddImage`, `AddTable`, `Graphics()`, `AddSVGObject` and `AddBarcode` all reach
the page through `appendContent(doc, page, …)` and
`ensureOwnResources(doc, page)`, and neither cares whether the dict is in the
tree. A template therefore needs no content-target refactor — the counterpart
of the resource-target seam `lucg.2` had to build.

`Page` supports this because it is a thin live wrapper: its constructor takes
`(doc, Dict, Number)` and nothing else. The template's page carries `Number 0`
— it has no position in a document that does not contain it.

**Invariant:** the page dict is a plain `Map`, never `allocObject`ed. The
content streams and image XObjects that drawing allocates *are* in the object
map, and become reachable only through the form's `/Resources` once the
template is placed. So an unplaced template contributes nothing to `Save()` —
not because a sweep removes it, but because there was never an object to
sweep. `/Parent` is absent, which `Page.Resources` already tolerates: it falls
back to the page's own dict, and `ensureOwnResources` creates one from an
undefined inherited value.

**Structure inside a template is out of scope**, and is a documented
limitation rather than a detected error. `element.MarkContent(page, …)`, and a
`tag:` passed to `AddText`, would write `/Pg` references to a page that does
not exist in the saved file. Detecting it means auditing every authoring entry
point for a tagging option; tagging is available at *placement* instead, on the
real target page, which is where a reader needs it anyway.

### 2. Lifecycle and the conversion

**The first `PlaceOn` builds the form and freezes the template.** The
conversion is direct, with no import step:

```
Type       /XObject
Subtype    /Form
FormType   1
BBox       [0, 0, width, height]
Resources  <the template page's own /Resources>
```

with the page's decoded `Contents` as the stream body.

**Invariant:** `/Matrix` is **omitted**. Identity is the PDF default, and the
template page's own space already *is* the template's space. `compose.ts`
writes an explicit `/Matrix` only because it must honour a source page's
`/Rotate`; a template has no rotation to honour.

**Invariant:** after the build, the `page` getter throws, naming the fix
("build a second template"). Silently ignoring a post-placement edit is the
failure mode worth spending a throw on — it reads as the drawing call being
broken rather than as a lifecycle mistake.

**Recorded as a known hole, with the realistic half closed.** A caller who
stashes `const p = tpl.page` before placing and draws through `p` afterwards
defeats the getter; nothing can intercept a method call on a `Page` already
handed out. The build therefore records `page.Contents.length`, and a later
`PlaceOn` throws if it no longer matches — which catches "edited through a
stashed reference, then placed again expecting the new version". An edit after
the *final* placement is still undetected, and affects nothing.

**Invariant:** an empty template is refused, not placed. A template never drawn
into would allocate a form that paints nothing wherever it is used — the same
call `lucg.2` refuses for an empty tile, for the same reason.

### 3. Placement

```ts
PlaceOn(page: Page, rect: [number, number, number, number], opts?: PlaceOptions): void
```

`rect` is `[x, y, w, h]`, matching `AddImage`'s convention.
`PlaceOptions`: `{ fit?, opacity?, rotation?, tag?, alt?, artifact? }` — the
last three being `structwrite.ts`'s existing `MarkOptions`.

**Note the rect convention differs one layer down, and the conversion is the
easiest bug in this feature to write.** `placementMatrix` — and therefore
`containMatrix` — takes `[x0, y0, x1, y1]` corners, not `[x, y, w, h]`; it
normalizes with `Math.min`/`Math.max`, so a width/height pair silently reads as
a corner and places the form in the wrong rect at the wrong size. `PlaceOn`
converts once, at its own boundary: `[x, y, x + w, y + h]`.

`NewTemplate` validates `width` and `height` as positive finite numbers, and
`PlaceOn` validates `rect` as four finite numbers with `w > 0` and `h > 0`,
`opacity` in 0..1, and `rotation` finite — all before anything is allocated,
so a rejected call leaves the document byte-identical.

- **`fit: 'stretch'`** (default) fills the rect exactly:
  `placementMatrix(bbox, IDENTITY, rect)`, which already exists in `text.ts`.
- **`fit: 'contain'`** scales uniformly and centres — the arithmetic currently
  inlined in `compose.ts`'s `placeFitted`.

**Invariant:** that contain arithmetic gets ONE owner. It is extracted as
`containMatrix(bbox, m, rect)` into `text.ts`, beside `placementMatrix` — same
inputs, same shape, and the file CLAUDE.md already describes as where "affine
matrix helpers live too" — and `placeFitted` calls it. Two copies of "scale
uniformly and centre" is how N-up and a template come to disagree about one
placement.

**Invariant:** `rotation` is degrees counter-clockwise **about the rect's
origin**, matching what `stamp.ts` documents for `AddText`. A diagonal
watermark usually wants the rect's centre instead; consistency with the
neighbouring API beats a guess about intent, and offsetting the rect gets the
other behaviour.

Emission is one buffered body, wrapped by `markDrawing` so tagging covers the
whole placement:

```
q
/GS0 gs          <- only when opacity < 1
<placement> cm
/Fm0 Do
Q
```

The form ref is registered per target page with a fresh `Fm` key, as
`placeFitted` already does. Placing one template twice on the same page yields
two `Do`s against one key.

## Testing

**`test/nup-contain.test.ts` — written BEFORE the extraction.** The existing
N-up suite does not pin the contain arithmetic: its
`'scales each cell to fit'` case puts a 200x100 source into a 200x100 cell, an
exact fit where the scale is 1 and the centring offset is 0, so a transposed or
miscentred build produces identical numbers. The `drawBorder` cases assert the
stroked *frame*, which is computed from the cell rect and not from the
placement at all.

So the new case uses a source whose aspect ratio differs from the cell, and
asserts `sx === sy` (uniform, not stretched) together with the centring
translation. Only then is `containMatrix` extracted — a verbatim move is
exactly where a green suite is most likely to be mistaken for coverage.

**`test/template.test.ts`** — the arithmetic and the model:

- `containMatrix` one vector at a time — wider-than-cell, taller-than-cell, and
  an exact fit — asserting scale and translation separately;
- the rotation composition alone, then composed with a placement;
- the identity case: no options yields the same matrix as `placementMatrix`,
  which is what makes the options provably free.

**`test/template-place.test.ts`** — end to end:

- a template placed on two pages allocates **one** form object and emits two
  `Do`s, asserted by object count after a `Save`/`Open` round trip — the whole
  argument for the feature;
- the page getter throws after the first placement, with a companion asserting
  it does *not* throw before;
- the stale-edit guard: draw through a stashed reference after placing, then
  place again, and expect a throw;
- an empty template refuses, and allocates nothing (`Save().length` unchanged);
- `opacity` emits a `gs`, `rotation` changes the matrix, and `artifact: true`
  wraps the placement — each asserted on the emitted content;
- **acceptance:** a pixel probe that the ink lands inside the placed rect and
  that a point outside it is unpainted. A test asserting only that an
  `/XObject` resource exists passes with the placement matrix entirely wrong.

Every assertion is mutation-checked before the issue closes, per the repo rule
that a fixture passing on the first run is not evidence. The three a
plausible-looking wrong implementation still satisfies are the contain scale
(uniform vs per-axis), the rotation composition order, and the build-once
freeze — each is broken deliberately and confirmed to redden its own case.

## Risks

- **The off-tree page is the load-bearing assumption.** It rests on `Page`
  being a thin wrapper over a dict, and on every authoring entry point reaching
  the page only through `appendContent` / `ensureOwnResources`. Both are true
  today and neither is currently asserted anywhere. `test/template-place.test.ts`
  exercising `AddText`, `AddImage` and `Graphics()` into a template is what
  turns that assumption into a checked one.
- **The `containMatrix` extraction has no net until the new N-up case lands**,
  which is why the ordering is stated rather than left to judgement.
- **Structure inside a template fails confusingly** rather than loudly — a
  `/Pg` pointing at a dict that was never written. Documented, not detected;
  if it bites, the fix is a guard on `Template.page` construction, not a
  redesign.
