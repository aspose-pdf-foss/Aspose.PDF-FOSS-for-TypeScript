# XFA static chrome as page content (164g.4)

## Problem

`ConvertXfaToAcroForm` replaces a DYNAMIC document's placeholder pages
("Please wait...") with freshly created ones and places the converted widgets on
them (164g.3). Those pages carry nothing else. Every label, rule, box, fill and
caption the template draws is absent, so a converted DD 1494 is 14 pages of
floating input boxes.

The three vendored dynamic forms are not marginal cases:

| | DD 1494 | DD 2875 | OPM 1644 |
|---|---|---|---|
| draws | 135 | 41 | 45 |
| borders on fields, subforms, draws | ~450 | ~120 | ~120 |
| field captions | ~250 | ~70 | ~30 |

Draws are text, rich text (`exData`), `line` and `rectangle`; borders carry
fills, corners, and raised or lowered 3-D edges.

## Scope

**In:** chrome painted on the pages the converter CREATES for a dynamic
document — draws (`text`, `exData`, `line`, `rectangle`), borders of fields,
draws, subforms and exclusion groups (edges, corners, fills), field captions,
and master-page chrome on every page using that page area. Widget borders go
into the widget dictionary (`/MK`, `/BS`), including `lowered` and `raised` as
AcroForm Inset and Beveled.

**Out, and why:**

- **Hybrid documents.** All six vendored hybrids already carry Designer's
  rendering of the chrome in their page content (their text extracts the
  labels). Painting it again draws everything twice. Hybrid pages are left
  byte-identical.
- **Gradient, pattern and stipple fills; `arc` and `image` draws;
  `break="open"` borders split across pages; `etched` and `embossed` edges.**
  None occurs in the corpus. Each is reported; the 3-D two are painted solid.
- **Tagging.** Converted dynamic documents are untagged today; tagging the
  chrome needs a structure model of the XFA tree, which is its own issue.

## Sources

Rules are transcribed from the **XFA Specification 3.3** (`xfa_spec_3_3.pdf`,
Internet Archive snapshot 20160329145223 of
`partners.adobe.com/public/developer/en/xml/xfa_spec_3_3.pdf`, SHA-256
`a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`), cited by
page. Not vendored.

- **Borders** (ch. 2, p. 38): edges in the order top, right, bottom, left and
  corners top-left, top-right, bottom-right, bottom-left; fewer than four
  reuses the last; no corner at all means default corners; no edge at all
  means the border is not stroked but may still be filled. The widget draws
  on top of the border and of the fill.
- **`<border>`** (p. 629-630): `hand` — `even` centres the stroke on the
  vector, `left` puts it immediately outside, `right` immediately inside;
  `presence`; `break`; its own `<margin>` insets it.
- **`<corner>`** (p. 663-665): `radius` (default 0), `join` square or round,
  `inverted`, `stroke`, `thickness` (default 0.5pt), colour default black. Each
  edge is trimmed from its end points by the corner radius whatever the
  corner's other properties.
- **`<edge>`** (p. 687-689): `stroke`, `thickness` (0.5pt), `cap` (applies to
  lines only, never to border or rectangle edges), colour default black.
- **Box model** (ch. 2, p. 49-51): the nominal content region is the nominal
  extent less the container's margins; the caption occupies part of it, sized
  by `reserve` on its `placement` side.
- **`<caption>`** (p. 643), **`<fill>`** (p. 734; an empty `<fill>` is solid
  white, p. 39), **`<font>`** (p. 741), **`<line>`** (p. 768: `slope` `\` is
  top-left to bottom-right, `/` bottom-left to top-right), **`<para>`**
  (p. 800: `hAlign`, `vAlign`), **`<rectangle>`** (p. 824).

**A recorded conflict.** p. 38 says a thicker stroke "spreads further toward
the inside" so the border fits within the nominal extent. The element
reference (p. 630) makes that the `right` hand and the default `even`. We follow
the element reference, which is also what pdf.js does (`createWrapper`), and
note the conflict at the code site.

**The 3-D edges.** XFA 3.3 describes `lowered`, `raised`, `etched` and
`embossed` in one sentence each ("the line appears to enclose a lowered
region") with no colours and no geometry. Every 3-D edge in the corpus is on a
WIDGET — an edit region's `<ui>/<*>/<border>` or a push button's field border
— so they map onto AcroForm's own 3-D border styles, Inset (`/S /I`) and
Beveled (`/S /B`), which `appearance.ts` already renders (`bevelOps`). No
hand-invented bevel is drawn.

## Design

### 1. Layout reports what it placed

`layoutPage` and `layoutPages` gain a second output, `PlacedNode[]`: every
placed node of every kind — field, draw, subform, area, exclGroup — as
`{ node, box }`, in DOCUMENT order. The field map is unchanged. The engine
already computes these boxes; this stops discarding them. A refused node is
absent, so its chrome is absent and it is already reported.

### 2. The template's chrome on the layout tree

`LayoutNode` gains an optional `chrome`, read by `xfatemplate.ts`:

- `border` — the node's own `<border>`: edges, corners, fill, margin, `hand`,
  `presence`, `break`.
- `widgetBorder` — a field's `<ui>/<*>/<border>`, kept apart because it
  belongs to the widget (section 6), and for a push button its field border.
- `geometry` — a `line` or `rectangle` draw's edges, corners, hand and slope.
- `presence` — `invisible` takes space and paints nothing (p. 630); `hidden`
  and `inactive` are already not placed.

The caption and the draw's text are already on `LeafText`.

### 3. `xfachrome.ts` — placed nodes to paint operations (pure)

Imports types only. Input: a placed node and its chrome; output: a flat list
of `{ kind: 'fill' | 'stroke' | 'text', ... }` in page points. It owns:

- edge and corner repetition (p. 38);
- stroke placement on the nominal extent less the border's margin, positioned
  by `hand` (p. 629-630);
- the corner trim, `join`, `inverted` and `radius` (p. 663-664);
- dash arrays for `dashed`, `dotted`, `dashDot`, `dashDotDot`, scaled by
  thickness;
- a `line` draw by `slope`, a zero-width or zero-height one as a rule; a
  `rectangle` through the SAME border engine, so corners and hands have one
  owner;
- text placement (section 4).

### 4. Text

`xfatext.ts` gains `layoutLeaf`, returning the lines `measureLeaf` already
breaks through `layoutRuns`, with baselines and per-run faces. `measureLeaf`
becomes the extent of that result, so ink and layout box are one computation.

`xfarich.ts` gains fields that measurement ignores, so every layout golden is
unchanged by construction: per paragraph `hAlign` (left, center, right,
justify, justifyAll; `radix` already refuses); per leaf `vAlign` (top, middle,
bottom); per run colour (`<font><fill><color>`, rich-text `color`),
`underline` and `lineThrough` (`<font>` attributes, rich-text
`text-decoration`). An unreadable colour or alignment falls back to black or
left/top and is recorded in `warnings`.

- **A draw's text** sits in its nominal extent less its `<margin>`, aligned per
  line by `hAlign` and as a block by `vAlign`.
- **A field's caption** sits in the caption region: the band of the nominal
  content region on the `placement` side, `reserve` deep. It is computed by the
  SAME function as `editRegion`, so caption and widget are exact complements.
  The caption's own `<margin>` and `<para>` inset and align its text. No
  caption, or `presence="hidden"` on it, paints none.
- **A field's value is never chrome.** It is the widget's appearance. A
  password value therefore never reaches page content.

Text is written one `BT … ET` per leaf in the face that measured each run;
decoration uses `textdecor.ts`'s `decorRects`; justification uses `Tw` as
`stamp.ts` does.

### 5. `xfapaint.ts` — the only module holding a `Document`

- Body chrome: one content stream appended per created page, nodes in
  document order. Per node: fill, edges and corners, draw geometry, text.
- Master-page chrome: each page area is laid out once (d3mq); its paint list
  becomes ONE Form XObject, placed on every page using that page area, before
  the body stream.
- Fonts: the Standard-14 face for the Arial, Times New Roman and Courier New
  substitutes, whose advances equal the Liberation metrics that measured them;
  a face embedded in the source PDF or found in a registered folder is
  embedded through `AddFont`. A face nothing resolves already refuses the leaf
  at layout.

Widgets are annotations and draw on top, which is p. 38's "the widget always
draws on top".

### 6. Widget borders

In `xfaconvert.ts`'s apply step, a field's `widgetBorder` becomes `/MK /BC`
(edge colour), `/MK /BG` (fill colour) and `/BS` through `fieldstyle.ts`'s
writer. `/W` is the edge thickness. `/S`:

| edge `stroke` | `/S` |
|---|---|
| `solid` | `S` |
| `dashed`, `dotted`, `dashDot`, `dashDotDot` | `D` |
| `lowered` | `I` |
| `raised` | `B` |
| `etched`, `embossed` | `S`, reported degraded |

A widget whose template states no border gains nothing.

### 7. Reporting

`skipped` gains `what: 'chrome'`, one entry per node and construct, named by
SOM name or label: a degraded 3-D edge, an unsupported fill, an `arc` or
`image` draw, an open border across a page split. `report.chromePages` counts
pages painted; 0 for a hybrid or a data-only conversion.

## Oracle

**pdf.js structural goldens** (`chrome-goldens.json`, from
`scripts/gen-xfa-goldens.ts`, not run by `npm test`). For each dynamic form
and each page pdf.js 6.3.289 renders: every `.xfaBorder` div (page, box,
per-edge width, style, colour, radius), every draw (page, box, kind,
`textContent`), every caption (page, box, `textContent`). Unnamed nodes are
joined by page and document order, which both engines walk.

`test/xfa-chrome-oracle.test.ts` compares:

- **border boxes** — our stroked rect, read back through `page.GetPaths()`,
  against pdf.js's border box, within one layout unit per row above (the
  existing tolerance: box positions come from the layout pdf.js already
  agrees with); edge widths and colours exactly;
- **text** — glyphs from `GetTextFragments` whose centroid falls in pdf.js's
  box spell its `textContent`, whitespace collapsed. Glyph positions inside
  the box are NOT compared: pdf.js shapes with browser fonts;
- **counts**, pinned exactly per form.

**Adobe for the widget mapping.** The mapper is pure; a test runs it over the
templates of f1040's three bordered text fields and DD 1155's Reset button
and compares with the `/MK` and `/BS` Adobe wrote (`/BC [0.2 0.2 0.2]`,
`/W 1`, `/S /S`; `/BC [0 0 0]`, `/W 1`, `/S /S`). The `lowered` and `raised`
rows have NO Adobe instance — the corpus's only ones are on hidden page
counters Adobe never renders — and rest on 32000-1's Inset and Beveled and on
unit cases.

**Ceiling.** pdf.js is a reimplementation, not Adobe: evidence, not
conformance. Nothing compares stroke rendering, fills or 3-D shading as
pixels.

## Fences

- Converting each of the six vendored hybrids leaves every page's
  `/Contents` byte-identical.
- The existing layout, pagination and field goldens do not move.
- `test/xfaconvert-*` cases pass unedited; a created widget gains `/MK`/`/BS`
  only where its template states a border.

## Mutations the plan must run

Each must redden at least one case: `hand` defaulting to `right`; the edge
list not repeating its last element; no corner trim; the caption region from
the nominal extent instead of the content region; painting a field's value;
`vAlign` ignored; master chrome painted per page instead of one shared
XObject; `lowered` mapped to `S`; paint order with text before fill; a
`presence="invisible"` node painted; `PlacedNode` in reverse order.
