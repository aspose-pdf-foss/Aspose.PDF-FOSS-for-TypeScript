# Nested SVG `<image>` Payload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render an `<image>` whose payload is an SVG as a nested Form XObject instead of reporting it in `skipped`.

**Architecture:** `svgimage.ts` gains `decodePayload`, which discriminates raster bytes from SVG bytes over the same two-source lookup (`data:` URI, then `opts.resolveImage`) that `decodeImage` already performs. `svgdraw.ts` walks an SVG payload into an `Emitter.subdoc()` — a fork distinct from `child()`, because a nested SVG is a separate *document* and every id-keyed field must start fresh — and places the resulting form with `viewBoxFitDown`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-03-svg-nested-image-payload-design.md`. Read it before Task 1.
- **Zero runtime dependencies**, `node:` built-ins only. **No I/O.**
- **Import specifiers carry the `.js` extension.**
- `decodeImage` is **not** modified. It stays the raster-only entry and remains
  what `feImage` calls; nesting inside a filter primitive is out of scope.
- `svgdraw.ts` must not import `svgembed.ts` — that module depends on this one.
  Anything needed from there is reimplemented locally (see `nestedViewBox`).
- Every task ends green: `npm run typecheck` plus the task's named test files.
  The full suite runs once, in Task 4.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/svgimage.ts` (modify) | `ImagePayload`, `looksLikeXml`, `classify`, `decodePayload`. Pure. | 1 |
| `src/svgdraw.ts` (modify) | `svgDepth`/`svgForms` fields, `subdoc()`, `nestedViewBox`, `nestedRect`, `nestedForm`, `drawNestedSvg`, the `drawImage` branch. | 2, 3 |
| `test/svg-image.test.ts` (modify) | Unit tests for the sniff and the source chain. | 1 |
| `test/svg-embed-image.test.ts` (modify) | Integration through `AddSVGObject`. | 2, 3 |
| `README.md` (modify) | The `<image>` paragraph and the API-table row. | 4 |

## Geometry Reference (used by the integration tests)

`place()` puts the SVG into `[0, 0, 200, 200]` with `fit: 'fill'`, and every
fixture uses `viewBox="0 0 200 200"`, so the outer mapping is scale 1 and the
walker's y-down user units equal the rect's.

For `<image x="10" y="20" width="80" height="40">` with a payload of
`<svg viewBox="0 0 10 10">`:

- `viewBoxFitDown({0,0,10,10}, 80, 40, undefined)` → default `xMidYMid meet`,
  so `scale = min(80/10, 40/10) = 4`, content is 40×40, centred: `tx = 20`,
  `ty = 0`. Matrix `[4, 0, 0, 4, 20, 0]`.
- Translated by the element's `x`/`y`: **`4 0 0 4 30 20 cm`**.
- The clip is the element rect: **`10 20 80 40 re`** then `W n`.

---

### Task 1: `decodePayload` discriminates raster from SVG

**Files:**
- Modify: `src/svgimage.ts` (add after `decodeImage`; `tryBuild` and `decodeImage` are untouched)
- Test: `test/svg-image.test.ts`

**Interfaces:**
- Produces: `type ImagePayload = { kind: 'raster'; built: BuiltImage } | { kind: 'svg'; bytes: Uint8Array }` and
  `decodePayload(href: string, resolve?: (href: string) => Uint8Array | undefined): ImagePayload | undefined`.
  Task 2 calls `decodePayload` from `drawImage`.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-image.test.ts`. Add `decodePayload` to the existing
`../src/svgimage.js` import, and add these two helpers beside the existing
`PNG()` / `b64()`:

```ts
const BOM = String.fromCharCode(0xfeff);
const SVG_BYTES = new TextEncoder().encode('<svg viewBox="0 0 10 10"/>');
const svgUri = (s: string) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
```

Then the block:

```ts
describe('decodePayload', () => {
  it('classifies PNG bytes as a raster', () => {
    expect(decodePayload(`data:image/png;base64,${b64(PNG())}`)?.kind).toBe('raster');
  });

  it('classifies an image/svg+xml payload as svg', () => {
    const p = decodePayload(svgUri('<svg viewBox="0 0 10 10"/>'));
    expect(p?.kind).toBe('svg');
    expect(new TextDecoder().decode((p as { bytes: Uint8Array }).bytes)).toContain('<svg');
  });

  it('sniffs past a BOM, whitespace, an XML declaration and a comment', () => {
    for (const s of [
      BOM + '<svg viewBox="0 0 1 1"/>',
      '\n  <svg viewBox="0 0 1 1"/>',
      '<?xml version="1.0"?><svg viewBox="0 0 1 1"/>',
      '<!-- c --><svg viewBox="0 0 1 1"/>',
    ]) expect(decodePayload(svgUri(s))?.kind).toBe('svg');
  });

  it('returns undefined for bytes that are neither XML nor a raster', () => {
    expect(decodePayload('data:application/octet-stream;base64,AQID')).toBeUndefined();
  });

  it('takes svg bytes from the resolver, not only a data: URI', () => {
    expect(decodePayload('logo.svg', () => SVG_BYTES)?.kind).toBe('svg');
  });

  it('falls back to the resolver when a data: payload is junk', () => {
    // Preserves 1gg0.21's chain: a data: URI that decodes to nothing usable must
    // not shortcut the resolver.
    expect(decodePayload('data:application/octet-stream;base64,AQID', () => PNG())?.kind)
      .toBe('raster');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-image.test.ts`
Expected: all six FAIL with `TypeError: decodePayload is not a function` — the
name is imported but does not exist, and esbuild strips the type error.
`npm run typecheck` fails too ("has no exported member 'decodePayload'").

- [ ] **Step 3: Implement**

Append to `src/svgimage.ts`, after `decodeImage`:

```ts
/** A decoded `<image>` payload: a raster ready to embed, or SVG bytes for the
 *  walker to recurse into. */
export type ImagePayload =
  | { kind: 'raster'; built: BuiltImage }
  | { kind: 'svg'; bytes: Uint8Array };

/** True when the bytes open with XML rather than a raster's magic number. A
 *  UTF-8 BOM and leading whitespace are skipped; the test is for `<` rather than
 *  a literal `<svg` so an XML declaration, a DOCTYPE or a leading comment still
 *  passes. PNG and JPEG magic numbers never begin with `<`, so sniffing this
 *  before attempting a raster build is unambiguous. Whether the root element
 *  really is <svg> is settled by parsing, not here. */
function looksLikeXml(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length
         && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  return i < bytes.length && bytes[i] === 0x3c;      // '<'
}

/** One source's bytes as a payload, or undefined when they are neither. */
function classify(bytes: Uint8Array | undefined): ImagePayload | undefined {
  if (bytes === undefined || bytes.length === 0) return undefined;
  if (looksLikeXml(bytes)) return { kind: 'svg', bytes };
  const built = tryBuild(bytes);
  return built === undefined ? undefined : { kind: 'raster', built };
}

/** Decode an `<image>` href into either a raster XObject or SVG bytes to recurse
 *  into, or undefined when neither is available.
 *
 *  Mirrors decodeImage's source chain exactly — the `data:` path first, the
 *  caller's resolver as the fallback, `resolve` called outside any try so its
 *  throw propagates — and adds the raster/vector discrimination. Either source
 *  may carry either kind: a `data:image/svg+xml` URI and a resolver handing back
 *  `logo.svg` are the same case.
 *
 *  decodeImage is deliberately left alone as the raster-only entry, and remains
 *  what feImage calls: a filter primitive rasterizes its input, so nesting a
 *  vector document there is a separate feature. */
export function decodePayload(
  href: string, resolve?: (href: string) => Uint8Array | undefined,
): ImagePayload | undefined {
  const direct = classify(dataUriBytes(href));
  if (direct !== undefined) return direct;
  if (resolve === undefined) return undefined;
  return classify(resolve(href));
}
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `npx vitest run test/svg-image.test.ts && npm run typecheck`
Expected: PASS, both.

- [ ] **Step 5: Commit**

```bash
git add src/svgimage.ts test/svg-image.test.ts
git commit -m "feat(svg): decodePayload tells an SVG image payload from a raster"
```

---

### Task 2: Walk a nested payload into a sub-document form

**Files:**
- Modify: `src/svgdraw.ts` — imports (lines 9, 24, 37), `Emitter` fields (near `svgDepth`'s neighbours around line 179), `Emitter.child()` (~line 240), a new `subdoc()` method, and `drawImage` (~line 897)
- Test: `test/svg-embed-image.test.ts`

**Interfaces:**
- Consumes: `decodePayload`, `ImagePayload` (Task 1).
- Produces: `Emitter.subdoc(viewport: ViewBox): Emitter`, `Emitter.svgDepth: number`,
  `Emitter.svgForms: Map<string, PdfObject>`, and module-private
  `nestedViewBox`, `nestedRect`, `nestedForm`, `drawNestedSvg`. Task 3 edits
  `drawNestedSvg` only.

- [ ] **Step 1: Write the failing tests**

Add to `test/svg-embed-image.test.ts`. First a helper beside `PNG_BYTES`:

```ts
/** An SVG payload as a base64 data URI. */
const svgUri = (s: string) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
/** A 10x10-viewBox payload that paints a full-bleed green square. */
const NESTED = svgUri('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/></svg>');
```

Then the block:

```ts
describe('AddSVGObject — nested SVG payload', () => {
  it('draws a nested payload as a form, fitted by its own viewBox', () => {
    const { skipped, content, formRes } = place(
      `<svg viewBox="0 0 200 200"><image x="10" y="20" width="80" height="40" href="${NESTED}"/></svg>`);
    expect(skipped).toEqual([]);
    // viewBoxFitDown(10x10 -> 80x40, default xMidYMid meet): scale 4, content
    // 40x40 centred in the 80x40 box (tx 20, ty 0), then translated by x/y.
    expect(content).toContain('4 0 0 4 30 20 cm');
    expect(content).toMatch(/\/Fm\d+ Do/);
    // The form is a Form XObject in the placement's own resources, NOT an image.
    const xo = formRes.get('XObject');
    expect(xo).toBeDefined();
  });

  it('draws a nested payload the resolver supplies', () => {
    const bytes = new TextEncoder().encode(
      '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/></svg>');
    const { skipped, content } = place(
      `<svg viewBox="0 0 200 200"><image width="40" height="40" href="logo.svg"/></svg>`,
      { resolveImage: () => bytes });
    expect(skipped).toEqual([]);
    expect(content).toMatch(/\/Fm\d+ Do/);
  });

  it('does not resolve a nested url(#id) against the OUTER document', () => {
    // The one test that proves subdoc() rather than child(). `#g` exists only in
    // the outer document; with a shared `ids` index the nested <use> would find
    // it and silently draw the outer content inside the payload.
    const payload = svgUri(
      '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/>' +
      '<use href="#g"/></svg>');
    const { skipped } = place(
      `<svg viewBox="0 0 200 200"><defs>` +
      `<g id="g"><rect width="200" height="200" fill="#ff0000"/></g></defs>` +
      `<image width="40" height="40" href="${payload}"/></svg>`);
    // The nested <use> must MISS, which reports 'use'.
    expect(skipped).toEqual(['use']);
  });

  it('allocates one form for two elements sharing a payload', () => {
    const { content } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image width="40" height="40" href="${NESTED}"/>` +
      `<image x="50" width="40" height="40" href="${NESTED}"/></svg>`);
    const keys = [...content.matchAll(/\/(Fm\d+) Do/g)].map((m) => m[1]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('reports image past the nesting cap', () => {
    // Five levels: the outermost placement plus four nested payloads. The cap is
    // 4, so the innermost is refused.
    let src = '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#00ff00"/></svg>';
    for (let i = 0; i < 5; i++)
      src = `<svg viewBox="0 0 10 10"><image width="10" height="10" href="${svgUri(src)}"/></svg>`;
    const { skipped } = place(
      `<svg viewBox="0 0 200 200"><image width="40" height="40" href="${svgUri(src)}"/></svg>`);
    expect(skipped).toEqual(['image']);
  });

  it('reports image for a payload whose root is not <svg>', () => {
    const { skipped, content } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image width="40" height="40" href="${svgUri('<html><body/></html>')}"/></svg>`);
    expect(skipped).toEqual(['image']);
    expect(content).not.toContain(' Do');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-embed-image.test.ts`
Expected: **all six** FAIL. The four positive cases fail on
`expected [ 'image' ] to deeply equal []` or on the missing `/Fm… Do`, because
an SVG payload is still reported. `does not resolve a nested url(#id)` fails on
`expected [ 'image' ] to deeply equal [ 'use' ]`. `reports image past the
nesting cap` and `reports image for a payload whose root is not <svg>` pass
already — they are guards that the refusal keeps reporting the same way, and
they become load-bearing once the positive path exists.

Note: the two "reports image" cases passing here is expected and fine. Their
value is in Task 4's mutation pass, where removing the depth guard turns the
first one red.

- [ ] **Step 3: Implement**

3a. Imports. Change the three lines:

```ts
import { parseXml, type XmlNode } from './xml.js';
```
```ts
import { fitBox, parseTransform, parseViewBox, viewBoxFitDown, type ViewBox } from './svgtransform.js';
```
```ts
import { decodeImage, decodePayload, imagePlacement, imageSize } from './svgimage.js';
```

3b. `Emitter` fields, beside `markerForms`:

```ts
  /** How many nested <image> SVG payloads deep this emitter is. A data: URI
   *  cannot reference itself, so nesting is already bounded by the input's
   *  length; this bounds pathological input and stack growth, not a cycle. */
  svgDepth = 0;
  /** `${href}|${viewBox}` -> the nested SVG's form ref, shared walk-wide like
   *  `images`. The fit lives in the placing `cm`, not in the form, so one form
   *  serves every placement of the same payload at the same viewBox. */
  svgForms = new Map<string, PdfObject>();
```

3c. `Emitter.child()`, after `c.resolveImage = this.resolveImage;`:

```ts
    c.svgDepth = this.svgDepth;
    c.svgForms = this.svgForms;
```

3d. Add `subdoc()` directly after `child()`:

```ts
  /** Fork for a nested SVG DOCUMENT — an <image> whose payload is SVG — not for
   *  another stream of this one. Everything id-keyed starts FRESH: `ids` and
   *  `css` belong to the payload; `markerForms` is keyed by id, so a shared map
   *  would draw an outer #arrow for a nested one; and the four cycle guards
   *  would let an outer id in flight suppress an unrelated nested element.
   *
   *  Sinks, fonts, the two content-addressed caches and both report sets stay
   *  shared — a loss inside a nested SVG is still a loss in the outer result. */
  subdoc(viewport: ViewBox): Emitter {
    const c = new Emitter();
    c.fonts = this.fonts;
    c.streams = this.streams;
    c.imageSink = this.imageSink;
    c.images = this.images;
    c.masks = this.masks;
    c.svgForms = this.svgForms;
    c.skipped = this.skipped;
    c.rasterized = this.rasterized;
    c.raster = this.raster;
    c.filterPx = this.filterPx;
    c.resolveImage = this.resolveImage;
    c.viewport = viewport;
    c.svgDepth = this.svgDepth + 1;
    return c;
  }
```

3e. Add the nesting cap and the three helpers, directly above `drawImage`:

```ts
/** Nesting cap for <image> SVG payloads. */
const MAX_SVG_NESTING = 4;

/** The user-unit box a nested payload's content is expressed in: its viewBox,
 *  else its own width/height. Null when it declares neither, in which case the
 *  <image> rect supplies an identity mapping. Mirrors svgembed.ts's
 *  resolveViewBox, which cannot be imported — that module depends on this one. */
function nestedViewBox(attrs: Map<string, string>): ViewBox | null {
  const vb = parseViewBox(attrs.get('viewBox'));
  if (vb) return vb;
  const w = parseFloat(attrs.get('width') ?? '');
  const h = parseFloat(attrs.get('height') ?? '');
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)
    return { minX: 0, minY: 0, w, h };
  return null;
}

/** The viewport an <image> establishes for a nested payload. `x`/`y` default to
 *  0; an absent `width`/`height` takes the payload's own size, and one absent
 *  dimension derives from the other through the payload's aspect ratio — the
 *  same rule imagePlacement applies to a raster. Null when the rect has no area
 *  (SVG 1.1 §5.6 makes that a deliberate no-render, not a reported loss) or when
 *  neither the element nor the payload declares a size, which cannot be placed. */
function nestedRect(
  attrs: Map<string, string>, iw: number, ih: number,
): [number, number, number, number] | null {
  const ax = parseFloat(attrs.get('x') ?? '');
  const ay = parseFloat(attrs.get('y') ?? '');
  const x = Number.isFinite(ax) ? ax : 0;
  const y = Number.isFinite(ay) ? ay : 0;
  let w = parseFloat(attrs.get('width') ?? '');
  let h = parseFloat(attrs.get('height') ?? '');
  const hasIntrinsic = iw > 0 && ih > 0;
  if (!Number.isFinite(w) && !Number.isFinite(h)) {
    if (!hasIntrinsic) return null;
    w = iw; h = ih;
  } else if (!Number.isFinite(w)) w = hasIntrinsic ? (h * iw) / ih : h;
  else if (!Number.isFinite(h)) h = hasIntrinsic ? (w * ih) / iw : w;
  if (!(w > 0) || !(h > 0)) return null;
  return [x, y, w, h];
}

/** Build (or reuse) the Form XObject for a nested payload. Its content is in the
 *  payload's OWN box units and its /BBox is that box, so one form serves every
 *  placement — the caller composes the fit. Null when the payload draws nothing. */
function nestedForm(
  e: Emitter, href: string, root: XmlNode, box: ViewBox,
): PdfObject | null {
  const key = `${href}|${box.minX},${box.minY},${box.w},${box.h}`;
  const hit = e.svgForms.get(key);
  if (hit !== undefined) return hit;

  const g = e.subdoc(box);
  indexIds(root, g.ids);
  if (applyStylesheet(g, root)) g.skipped.add('style');
  walk(g, root, INITIAL, false, [...IDENTITY]);
  if (g.out.length === 0) return null;

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [box.minX, box.minY, box.minX + box.w, box.minY + box.h]],
    ['Matrix', [...IDENTITY]],
    ['Resources', buildResources(g)],
  ]);
  const ref = e.streams.stream(dict, g.out.join('\n'));
  e.svgForms.set(key, ref);
  return ref;
}

/** Place a nested SVG payload. The <image> rect is a new viewport, and the
 *  payload's own viewBox + preserveAspectRatio map its content into it. */
function drawNestedSvg(
  e: Emitter, n: XmlNode, href: string, bytes: Uint8Array,
  ctm: Matrix, groupOpacity: number,
): void {
  if (e.svgDepth >= MAX_SVG_NESTING) { e.skipped.add('image'); return; }
  const root = parseXml(bytes);
  if (root.name !== 'svg') { e.skipped.add('image'); return; }
  const vb = nestedViewBox(root.attrs);
  const rect = nestedRect(n.attrs, vb?.w ?? 0, vb?.h ?? 0);
  if (rect === null) return;
  const [x, y, w, h] = rect;
  // A payload declaring no box of its own maps 1:1 into the rect.
  const box = vb ?? { minX: 0, minY: 0, w, h };
  const ref = nestedForm(e, href, root, box);
  if (ref === null) { e.skipped.add('image'); return; }

  const f = viewBoxFitDown(box, w, h, root.attrs.get('preserveAspectRatio'));
  const m: Matrix = [f[0], f[1], f[2], f[3], f[4] + x, f[5] + y];
  e.out.push('q');
  if (groupOpacity < 1) e.out.push(`/${e.gsKey(groupOpacity, 1)} gs`);
  e.out.push(`${m.map(num).join(' ')} cm`);
  e.out.push(`/${e.xobjKey(ref, 'Fm')} Do`);
  e.out.push('Q');
  e.addInk({ x, y, w, h }, ctm);
  if (e.ctms) e.ctms.push(ctm);
}
```

3f. Rewrite the head of `drawImage` so an SVG payload branches off. The rest of
the function — from `const pl = imagePlacement(...)` onward — is unchanged:

```ts
function drawImage(
  e: Emitter, n: XmlNode, p: Paint, ctm: Matrix, groupOpacity: number,
): void {
  const href = (n.attrs.get('href') ?? n.attrs.get('xlink:href') ?? '').trim();
  if (href === '') { e.skipped.add('image'); return; }
  let hit = e.images.get(href);
  if (hit === undefined) {
    const payload = decodePayload(href, e.resolveImage);
    if (payload === undefined) { e.skipped.add('image'); return; }
    // A vector payload never enters `images`, which holds raster refs plus their
    // pixel size. It is re-decoded per element; `svgForms` is what stops the
    // form being allocated twice.
    if (payload.kind === 'svg') {
      drawNestedSvg(e, n, href, payload.bytes, ctm, groupOpacity);
      return;
    }
    const { w, h } = imageSize(payload.built);
    hit = { ref: e.imageSink.image(payload.built), w, h };
    e.images.set(href, hit);
  }
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `npx vitest run test/svg-embed-image.test.ts test/svg-image.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/svgdraw.ts test/svg-embed-image.test.ts
git commit -m "feat(svg): render a nested SVG <image> payload as a form"
```

---

### Task 3: Clip to the viewport, and survive a malformed payload

**Files:**
- Modify: `src/svgdraw.ts` (`drawNestedSvg` only)
- Test: `test/svg-embed-image.test.ts`

**Interfaces:**
- Consumes: everything from Task 2. Adds nothing new.

- [ ] **Step 1: Write the failing tests**

Add to the `AddSVGObject — nested SVG payload` block:

```ts
  it('clips a nested payload to the image rect', () => {
    // slice scales the content past the rect while it still lies inside the
    // payload's viewBox, so the form's /BBox alone does not contain it.
    const payload = svgUri(
      '<svg viewBox="0 0 10 10" preserveAspectRatio="xMidYMid slice">' +
      '<rect width="10" height="10" fill="#00ff00"/></svg>');
    const { content } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image x="10" y="20" width="80" height="40" href="${payload}"/></svg>`);
    expect(content).toContain('10 20 80 40 re');
    expect(content).toContain('W n');
  });

  it('reports image for a malformed payload instead of throwing', () => {
    // One bad payload in a 200-element illustration must not abort the whole
    // placement, which is the same rule decodeImage's broad catch encodes.
    const { skipped, content } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image width="40" height="40" href="${svgUri('<svg><rect')}"/></svg>`);
    expect(skipped).toEqual(['image']);
    expect(content).not.toContain(' Do');
  });

  it("surfaces a nested payload's own losses in the outer skipped", () => {
    // `skipped` is shared across the document boundary: an @media rule the CSS
    // engine drops inside the payload is still a loss in the outer result.
    const payload = svgUri(
      '<svg viewBox="0 0 10 10"><style>@media print { rect { fill: red } }</style>' +
      '<rect width="10" height="10" fill="#00ff00"/></svg>');
    const { skipped } = place(
      `<svg viewBox="0 0 200 200"><image width="40" height="40" href="${payload}"/></svg>`);
    expect(skipped).toEqual(['style']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-embed-image.test.ts`
Expected: `clips a nested payload to the image rect` FAILS on
`expected '…' to contain '10 20 80 40 re'` (no clip is emitted).
`reports image for a malformed payload instead of throwing` FAILS by **throwing**
a `PdfParseError` out of `AddSVGObject` rather than reporting.
`surfaces a nested payload's own losses` passes already — `subdoc()` shares
`skipped`, so it is a guard on Task 2's decision rather than new behaviour.

- [ ] **Step 3: Implement**

In `drawNestedSvg`, wrap the parse and emit the clip. Replace the parse line:

```ts
  let root: XmlNode;
  try {
    root = parseXml(bytes);
  } catch {
    // parseXml throws PdfParseError on malformed XML. One bad payload must not
    // abort a whole placement — the same rule tryBuild's broad catch encodes for
    // corrupt raster bytes.
    e.skipped.add('image');
    return;
  }
```

and add the clip inside the `q … Q`, before the `gs`:

```ts
  e.out.push('q');
  // A new viewport clips. /BBox alone is not enough: under `slice` the content
  // is scaled past the rect while still lying inside the payload's viewBox.
  e.out.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re`);
  e.out.push('W n');
  if (groupOpacity < 1) e.out.push(`/${e.gsKey(groupOpacity, 1)} gs`);
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `npx vitest run test/svg-embed-image.test.ts test/svg-image.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/svgdraw.ts test/svg-embed-image.test.ts
git commit -m "fix(svg): clip a nested payload to its viewport and survive bad XML"
```

---

### Task 4: Prove the assertions load-bearing, then document

**Files:**
- Modify: `README.md`
- Verify: `src/svgdraw.ts` (no permanent changes)

- [ ] **Step 1: Mutation — `child()` instead of `subdoc()`**

In `nestedForm`, temporarily replace `const g = e.subdoc(box);` with:

```ts
  const g = e.child();
  g.viewport = box;
```

Run: `npx vitest run test/svg-embed-image.test.ts`
Expected: RED — `does not resolve a nested url(#id) against the OUTER document`
fails, because the shared `ids` index lets the nested `<use>` find the outer
`#g`. This is the whole argument for `subdoc()`; if it stays green, the test is
not testing what it claims.

Restore with `git checkout src/svgdraw.ts` and re-run to confirm green.

- [ ] **Step 2: Mutation — drop the depth guard**

Temporarily delete the `if (e.svgDepth >= MAX_SVG_NESTING) …` line from
`drawNestedSvg`.

Run: `npx vitest run test/svg-embed-image.test.ts`
Expected: RED — `reports image past the nesting cap` fails with
`expected [] to deeply equal [ 'image' ]`.

Restore and re-run to confirm green.

- [ ] **Step 3: Mutation — drop the viewport clip**

Temporarily delete the two `re` / `W n` pushes from `drawNestedSvg`.

Run: `npx vitest run test/svg-embed-image.test.ts`
Expected: RED — `clips a nested payload to the image rect` fails on the missing
`10 20 80 40 re`.

Restore and re-run to confirm green.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS, everything. Confirm `git diff` prints nothing.

- [ ] **Step 5: Update the README**

5a. Find the `<image>` clause (search for `including `image/svg+xml`, is
reported the same way`) and replace:

```
A payload that is not PNG/JPEG, including `image/svg+xml`, is reported the same way;
```

with:

```
A payload that is **`image/svg+xml`** is parsed and drawn as a nested Form XObject rather than a raster: the `<image>` rect becomes a new viewport, the payload's own `viewBox` and `preserveAspectRatio` fit its content into it (the `<image>`'s own `preserveAspectRatio` is not consulted), and the result is clipped to the rect. The payload is a separate document — its ids, stylesheet and markers do not see the enclosing file's, and vice versa — while anything it could not render is still reported in the outer `skipped`. Nesting is capped at 4 levels, past which the element reports `image`; so do a malformed payload and one whose root is not `<svg>`. A payload that is neither a raster nor SVG is reported the same way;
```

5b. In the API-overview table, find the `page.AddSVGObject(data, rect, opts?)`
row and extend the `<image>` parenthetical from

```
`<image>` (`data:` URI PNG/JPEG → Image XObjects, with `opts.resolveImage` supplying bytes for any other href)
```

to

```
`<image>` (`data:` URI PNG/JPEG → Image XObjects and `image/svg+xml` → nested Form XObjects capped at 4 levels, with `opts.resolveImage` supplying bytes for any other href)
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: an image/svg+xml payload renders as a nested form"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-1gg0.22
git pull --rebase
git push
git add .beads/interactions.jsonl
git commit -m "chore(bd): close 1gg0.22"
git push
git status   # MUST show "up to date with origin"
```

---

## Notes for the implementer

- **`subdoc()` is not an optimisation of `child()`.** If you find yourself
  tempted to collapse them, re-read the table in the spec: `markerForms` is
  keyed by id, so a shared map draws the *wrong marker*, not nothing.
- **Do not touch `decodeImage`.** `feImage` calls it and must keep reporting an
  SVG payload; a filter primitive rasterizes its input.
- **Do not import `svgembed.ts` from `svgdraw.ts`** — that is a cycle.
  `nestedViewBox` deliberately duplicates `resolveViewBox` for this reason.
- **`filterPx` is copied into a `subdoc()` unchanged**, exactly as `child()` does
  for pattern tiles and marker forms. A `<filter>` inside a nested payload
  therefore rasterizes at the outer placement's scale. That approximation
  predates this change; leave it.
- A vector payload is re-decoded and re-parsed per referencing element, since
  only raster refs live in `images`. `svgForms` prevents the duplicate
  allocation, which is the part that matters. Do not "fix" this by putting a
  vector entry in `images` — that map's shape is `{ ref, w, h }` for a raster.
