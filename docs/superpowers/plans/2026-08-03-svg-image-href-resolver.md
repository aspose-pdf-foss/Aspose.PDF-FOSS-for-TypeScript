# SVG `<image>` href Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller supply the bytes for an SVG `<image>` / `<feImage>` href the library cannot decode itself, via `resolveImage` on `AddSVGOptions`.

**Architecture:** `decodeImage` in `svgimage.ts` gains an optional resolver, consulted only after the built-in `data:` path yields nothing. The function is threaded `AddSVGOptions` → `SvgDrawOptions` → an `Emitter` field → both call sites (`drawImage`, `rasterizeFeImage`), and must be copied in `Emitter.child()` or it silently vanishes inside every forked subtree.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-03-svg-image-href-resolver-design.md`. Read it before Task 1.
- **Zero runtime dependencies**, `node:` built-ins only. **No I/O of any kind** — the whole point of the option is that the caller does the fetching.
- **Import specifiers carry the `.js` extension.**
- The resolver is **synchronous**. Do not make anything async.
- The resolver's exact type, used verbatim everywhere it appears:
  `(href: string) => Uint8Array | undefined`
- Every task ends green: `npm run typecheck` plus the task's named test files.
  The full suite runs once, in Task 4.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/svgimage.ts` (modify) | `tryBuild` helper + the resolver parameter on `decodeImage`. Pure; no threading. | 1 |
| `src/svgdraw.ts` (modify) | `SvgDrawOptions.resolveImage`, the `Emitter` field, the `child()` copy, both call sites. | 2, 3 |
| `src/svgembed.ts` (modify) | `AddSVGOptions.resolveImage`, its validation, forwarding into `drawSvg`. | 2 |
| `test/svg-image.test.ts` (modify) | Unit tests for `decodeImage`. | 1 |
| `test/svg-embed-image.test.ts` (modify) | Integration through `AddSVGObject`, incl. the pattern-tile case. | 2 |
| `test/svg-filter-render.test.ts` (modify) | The `feImage` integration case. | 3 |
| `README.md` (modify) | Three prose spots. | 4 |

---

### Task 1: `decodeImage` accepts a resolver

**Files:**
- Modify: `src/svgimage.ts:39-56` (the `decodeImage` doc comment and body)
- Test: `test/svg-image.test.ts`

**Interfaces:**
- Produces: `decodeImage(href: string, resolve?: (href: string) => Uint8Array | undefined): BuiltImage | undefined` — Tasks 2 and 3 call it with `e.resolveImage` as the second argument.
- Produces (module-private): `tryBuild(bytes: Uint8Array | undefined): BuiltImage | undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-image.test.ts`. The file already imports `decodeImage` and
`imageSize`, and already defines the `PNG()` and `b64()` helpers used here — no
new imports are needed.

```ts
describe('decodeImage — caller-supplied resolver', () => {
  it('builds from the resolver when the href is not a data: URI', () => {
    const bytes = PNG();
    const built = decodeImage('photo.png', () => bytes);
    expect(built).toBeDefined();
    expect(imageSize(built!)).toEqual({ w: 2, h: 2 });
  });

  it('does not call the resolver when the data: URI decodes', () => {
    let calls = 0;
    const built = decodeImage(
      `data:image/png;base64,${b64(PNG())}`, () => { calls++; return undefined; });
    expect(built).toBeDefined();
    expect(calls).toBe(0);
  });

  it('calls the resolver for a data: payload whose bytes are not PNG or JPEG', () => {
    // How an image/svg+xml payload arrives: it decodes to bytes, but the sniff
    // rejects them. The caller gets a shot rather than needing a second option.
    const seen: string[] = [];
    const href = 'data:image/svg+xml,%3Csvg%2F%3E';
    const built = decodeImage(href, (h) => { seen.push(h); return PNG(); });
    expect(built).toBeDefined();
    expect(seen).toEqual([href]);
  });

  it('propagates a throw from the resolver', () => {
    // A throw here is a CALLER bug. Swallowing it would surface as a silently
    // missing image plus a vague skipped: ['image'].
    expect(() => decodeImage('photo.png', () => { throw new Error('lookup failed'); }))
      .toThrow('lookup failed');
  });

  it('returns undefined when the resolver supplies bytes that are not an image', () => {
    expect(decodeImage('photo.png', () => new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('returns undefined when the resolver declines', () => {
    expect(decodeImage('photo.png', () => undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-image.test.ts`

Expected: **three** FAIL — `builds from the resolver…` and
`calls the resolver for a data: payload…` fail with "expected undefined to be
defined" (JS ignores the extra argument, so the resolver is never consulted),
and `propagates a throw…` fails with "expected function to throw". The other
three pass already: they are guards on behaviour that must not change.

`npm run typecheck` also fails here ("Expected 1 arguments, but got 2"). Vitest
strips types without checking them, so the tests still run. Both go green in
Step 4.

- [ ] **Step 3: Implement**

Replace the `decodeImage` doc comment and body in `src/svgimage.ts` with:

```ts
/** Build an Image XObject from bytes, or undefined when they are unusable.
 *
 *  buildImageXObject THROWS on unrecognized or corrupt bytes, which is right for
 *  page.AddImage and wrong here: one bad icon in a 200-element illustration must
 *  not abort the whole placement. The catch is deliberately broad — the only
 *  distinction a caller can act on is "this image did not render". */
function tryBuild(bytes: Uint8Array | undefined): BuiltImage | undefined {
  if (bytes === undefined || bytes.length === 0) return undefined;
  try {
    return buildImageXObject(bytes);
  } catch {
    return undefined;
  }
}

/** Decode an `<image>` href into an Image XObject, or undefined when it cannot
 *  be embedded.
 *
 *  The built-in `data:` path runs first. `resolve` is the caller's fallback for
 *  anything it cannot decode: a relative path, an `http:` URL, or a `data:`
 *  payload whose bytes are not PNG or JPEG — which is how an image/svg+xml one
 *  arrives, nesting an SVG being a separate feature.
 *
 *  `resolve` is called OUTSIDE tryBuild's catch, deliberately. A throw from it
 *  is a CALLER bug — a bad lookup, a missing map — and must propagate; swallowed,
 *  it becomes a silently missing image and a vague skipped: ['image']. The broad
 *  catch is for corrupt image BYTES, a different failure with a different cause. */
export function decodeImage(
  href: string, resolve?: (href: string) => Uint8Array | undefined,
): BuiltImage | undefined {
  const built = tryBuild(dataUriBytes(href));
  if (built !== undefined) return built;
  if (resolve === undefined) return undefined;
  return tryBuild(resolve(href));
}
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `npx vitest run test/svg-image.test.ts && npm run typecheck`
Expected: PASS, both, no warnings.

- [ ] **Step 5: Commit**

```bash
git add src/svgimage.ts test/svg-image.test.ts
git commit -m "feat(svg): decodeImage accepts a caller-supplied href resolver"
```

---

### Task 2: Thread `resolveImage` to `<image>` through AddSVGObject

**Files:**
- Modify: `src/svgdraw.ts:78-84` (`SvgDrawOptions`), `src/svgdraw.ts:167` (the `Emitter` field, beside `raster`), `src/svgdraw.ts:240-260` (`Emitter.child`), `src/svgdraw.ts:1482-1495` (`drawSvg`), `src/svgdraw.ts:903` (`drawImage`)
- Modify: `src/svgembed.ts:24-38` (`AddSVGOptions`), `src/svgembed.ts:173-177` (validation), `src/svgembed.ts:189-191` (the `drawSvg` call)
- Test: `test/svg-embed-image.test.ts`

**Interfaces:**
- Consumes: `decodeImage(href, resolve?)` from Task 1.
- Produces: `AddSVGOptions.resolveImage`, `SvgDrawOptions.resolveImage`, and the public `Emitter.resolveImage` field that Task 3 reads at the `feImage` call site.

- [ ] **Step 1: Write the failing tests**

1a. `test/svg-embed-image.test.ts` currently builds `DATA_URI` from an inline
`buildPngRgbWith` call and its `place()` helper hardcodes its options. Replace
the `DATA_URI` constant and the `place` signature line so the bytes are
reusable and options can be passed (mirroring the `render` helper in
`test/svg-filter-render.test.ts`):

```ts
/** A 2x2 RGB PNG: red, green / blue, yellow. */
const PNG_BYTES = buildPngRgbWith(2, 2, [
  255, 0, 0, 0, 255, 0,
  0, 0, 255, 255, 255, 0,
], 0);

/** The same image as a base64 data URI. */
const DATA_URI = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`;
```

and change the helper's first line and its `AddSVGObject` call to:

```ts
function place(src: string, opts: Record<string, unknown> = {}) {
  const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' }));
  const page = doc.Pages[0];
  const skipped = page.AddSVGObject(enc(src), [0, 0, 200, 200], { fit: 'fill', ...opts }).skipped;
```

(the rest of `place` is unchanged).

1b. Append the new describe block to the same file:

```ts
describe('AddSVGObject — resolveImage', () => {
  const REL = `<svg viewBox="0 0 200 200"><image width="40" height="40" href="photo.png"/></svg>`;

  it('embeds bytes the resolver supplies for a relative href', () => {
    const { skipped, content, xobjects } = place(REL, {
      resolveImage: (h: string) => (h === 'photo.png' ? PNG_BYTES : undefined),
    });
    expect(skipped).toEqual([]);
    expect([...(xobjects as PdfDict)].map(([k]) => k)).toEqual(['Im0']);
    expect(content).toContain('/Im0 Do');
  });

  it('still reports image when the resolver declines', () => {
    const { skipped, content } = place(REL, { resolveImage: () => undefined });
    expect(skipped).toEqual(['image']);
    expect(content).not.toContain(' Do');
  });

  it('reaches an <image> inside a pattern tile', () => {
    // A tile forks a child Emitter. A resolver not carried across the fork works
    // at the top level and silently vanishes here — and in markers, masks and
    // filter subtrees, which fork the same way.
    const { doc, formRes } = place(
      `<svg viewBox="0 0 200 200"><defs>` +
      `<pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse">` +
      `<image width="20" height="20" href="tile.png"/></pattern></defs>` +
      `<rect width="200" height="200" fill="url(#p)"/></svg>`,
      { resolveImage: () => PNG_BYTES });
    const patterns = doc.resolve(formRes.get('Pattern'));
    if (!isDict(patterns)) throw new Error('no /Pattern in the form resources');
    const tile = doc.resolve([...patterns][0][1]);
    if (!isStream(tile)) throw new Error('a tiling pattern must be a stream');
    expect(new TextDecoder('latin1').decode(tile.raw)).toContain('/Im0 Do');
  });

  it('calls the resolver once for two elements sharing an href', () => {
    let calls = 0;
    const { content } = place(
      `<svg viewBox="0 0 200 200">` +
      `<image width="10" height="10" href="a.png"/>` +
      `<image x="20" width="10" height="10" href="a.png"/></svg>`,
      { resolveImage: () => { calls++; return PNG_BYTES; } });
    expect(calls).toBe(1);
    expect(content.match(/\/Im0 Do/g)).toHaveLength(2);
  });

  it('rejects a non-function resolveImage', () => {
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' }));
    expect(() => doc.Pages[0].AddSVGObject(
      enc('<svg viewBox="0 0 200 200"/>'), [0, 0, 200, 200],
      { resolveImage: 'nope' as never })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/svg-embed-image.test.ts`

Expected: **four** FAIL. `embeds bytes the resolver supplies` fails on
`expected [ 'image' ] to deeply equal []`; `reaches an <image> inside a pattern
tile` fails because nothing resolved, so the tile drew nothing — either at the
`toContain('/Im0 Do')` assertion or earlier at the "no /Pattern in the form
resources" throw, depending on whether an empty tile still registers a pattern;
`calls the resolver once…` fails with `expected +0 to be 1`;
`rejects a non-function resolveImage` fails because nothing throws.
`still reports image when the resolver declines` passes already — it is the
guard that declining keeps today's behaviour.

- [ ] **Step 3: Implement**

3a. `src/svgdraw.ts` — add to `SvgDrawOptions`, after `raster?: SvgRasterSink;`:

```ts
  /** Caller-supplied bytes for an href the walker cannot decode itself. See
   *  decodeImage in svgimage.ts. */
  resolveImage?: (href: string) => Uint8Array | undefined;
```

3b. `src/svgdraw.ts` — add the `Emitter` field, directly after its
`raster?: SvgRasterSink;` member (near line 167):

```ts
  /** Supplied by the caller through AddSVGOptions; see decodeImage. */
  resolveImage?: (href: string) => Uint8Array | undefined;
```

3c. `src/svgdraw.ts` — in `Emitter.child()`, after `c.filterPx = this.filterPx;`:

```ts
    c.resolveImage = this.resolveImage;
```

This is the line the feature most easily ships without. `child()` forks for a
pattern tile, a marker, a mask and a filter subtree; without the copy the
resolver works at the top level and is silently absent in all four.

3d. `src/svgdraw.ts` — in `drawSvg`, after `e.raster = opts.raster;`:

```ts
  e.resolveImage = opts.resolveImage;
```

3e. `src/svgdraw.ts` — in `drawImage`, pass the resolver:

```ts
    const built = href === '' ? undefined : decodeImage(href, e.resolveImage);
```

3f. `src/svgembed.ts` — add to `AddSVGOptions`, after `filterScale?: number;`:

```ts
  /** Supply the bytes for an `<image>` or `<feImage>` href this library cannot
   *  decode itself — a relative path, an `http:` URL, or a `data:` payload whose
   *  bytes are not PNG or JPEG. Return `undefined` to decline, which reports the
   *  element in `skipped` exactly as without the option. Synchronous by design:
   *  the library performs no I/O, so fetch before the call and resolve out of a
   *  map. A throw propagates — it is a bug in the caller, not a missing image. */
  resolveImage?: (href: string) => Uint8Array | undefined;
```

3g. `src/svgembed.ts` — validate, directly after the `filterScale` check:

```ts
  const resolveImage = opts.resolveImage;
  if (resolveImage !== undefined && typeof resolveImage !== 'function')
    throw new TypeError('resolveImage must be a function');
```

3h. `src/svgembed.ts` — forward it in the `drawSvg` call:

```ts
  const { content, resources, skipped, rasterized } = drawSvg(
    root, vb, provider, streamSink(doc), imageSink(doc),
    { deviceScale: ctmScale(m), filterScale, raster: rasterSink(doc), resolveImage });
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `npx vitest run test/svg-embed-image.test.ts test/svg-image.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/svgdraw.ts src/svgembed.ts test/svg-embed-image.test.ts
git commit -m "feat(svg): resolveImage supplies bytes for an <image> href"
```

---

### Task 3: The same resolver serves `feImage`

**Files:**
- Modify: `src/svgdraw.ts:971` (the `else` branch of `rasterizeFeImage`)
- Test: `test/svg-filter-render.test.ts`

**Interfaces:**
- Consumes: `Emitter.resolveImage` (Task 2), `decodeImage(href, resolve?)` (Task 1).

- [ ] **Step 1: Write the failing test**

In `test/svg-filter-render.test.ts`, add this constant beside the existing
`RED_PNG_URI` (decoding the URI back to bytes avoids restructuring the IIFE that
builds it):

```ts
/** The same red/blue PNG as raw bytes, for a resolver to hand back. */
const RED_PNG_BYTES = new Uint8Array(Buffer.from(RED_PNG_URI.split(',')[1], 'base64'));
```

and add this case inside the existing `describe('AddSVGObject — feImage', …)`
block, after `draws unfiltered and reports an external href`:

```ts
  it('draws an external href the caller resolves', () => {
    const { png, result } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">' +
      '<feImage href="https://example.com/a.png"/></filter></defs>' +
      '<rect width="200" height="200" fill="#00ff00" filter="url(#f)"/></svg>',
      { resolveImage: () => RED_PNG_BYTES });
    expect(result.skipped).toEqual([]);
    // The image's RED row on top, as in the data: URI case: a resolver that
    // reached the wrong code path could still produce ink, but not this ink.
    expect(isRed(png, 100, 50)).toBe(true);
  });
```

The existing `draws unfiltered and reports an external href` case passes **no**
resolver and must stay green — it is the guard that the default is unchanged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/svg-filter-render.test.ts`
Expected: FAIL with `expected [ 'feImage' ] to deeply equal []` — the resolver is
threaded but `rasterizeFeImage` still calls `decodeImage` with one argument.

- [ ] **Step 3: Implement**

In `rasterizeFeImage`'s `else` branch:

```ts
    const built = decodeImage(href, e.resolveImage);
```

- [ ] **Step 4: Run the tests and the typechecker**

Run: `npx vitest run test/svg-filter-render.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/svgdraw.ts test/svg-filter-render.test.ts
git commit -m "feat(svg): resolveImage serves feImage too"
```

---

### Task 4: Prove the assertions load-bearing, then document

**Files:**
- Modify: `README.md`
- Verify: `src/svgimage.ts`, `src/svgdraw.ts` (no permanent changes)

CLAUDE.md requires this: a test that passes first try is not yet evidence. Both
mutations below target failures that are invisible in ordinary use.

- [ ] **Step 1: Mutation — the `child()` copy**

Temporarily delete `c.resolveImage = this.resolveImage;` from `Emitter.child()`.

Run: `npx vitest run test/svg-embed-image.test.ts`
Expected: RED — `reaches an <image> inside a pattern tile` throws
"no /Pattern in the form resources". The other resolveImage cases stay green,
which is exactly why this test has to exist.

Restore with `git checkout src/svgdraw.ts` and re-run to confirm green.

- [ ] **Step 2: Mutation — swallow the resolver's throw**

In `src/svgimage.ts`, temporarily replace the last line of `decodeImage` with:

```ts
  try { return tryBuild(resolve(href)); } catch { return undefined; }
```

Run: `npx vitest run test/svg-image.test.ts`
Expected: RED — `propagates a throw from the resolver` fails with "expected
function to throw". Every other test stays green, which is the point: this is
the shape a well-meaning edit would produce.

Restore with `git checkout src/svgimage.ts` and re-run to confirm green.

- [ ] **Step 3: Mutation — the feImage call site**

In `rasterizeFeImage`, temporarily drop the second argument:
`const built = decodeImage(href);`

Run: `npx vitest run test/svg-filter-render.test.ts`
Expected: RED — `draws an external href the caller resolves` fails with
`expected [ 'feImage' ] to deeply equal []`.

Restore and re-run to confirm green.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS, everything. Confirm `git diff` prints nothing — both mutated
files must be back to their Task 3 state.

- [ ] **Step 5: Update the README**

5a. Find the `<image>` sentence (search for `so the bytes have to arrive in the
document`) and replace:

```
An href that is **not** a `data:` URI — a relative path, `http:` — embeds nothing and names `image` in `result.skipped`: the library performs no I/O, so the bytes have to arrive in the document.
```

with:

```
An href that is **not** a `data:` URI — a relative path, `http:` — embeds nothing and names `image` in `result.skipped` unless you pass `opts.resolveImage`, a synchronous `(href) => Uint8Array | undefined` the library calls for any href it cannot decode itself (including a `data:` payload whose bytes are not PNG or JPEG). Returning `undefined` declines and reports as before; the library still performs no I/O of its own, so fetch the bytes first and resolve out of a map.
```

5b. Find the `feImage` sentence (search for `an external href is refused, since
the library performs no I/O`) and replace that clause with:

```
an external href is refused unless `opts.resolveImage` supplies its bytes, since the library performs no I/O
```

5c. In the API-overview table, find the `page.AddSVGObject(data, rect, opts?)`
row and insert, immediately after the `(`data:` URI PNG/JPEG → Image XObjects)`
parenthetical:

```
, with `opts.resolveImage` supplying bytes for any other href
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: opts.resolveImage supplies bytes for an SVG image href"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-1gg0.21
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

Then commit the beads state, which `bd close` writes to
`.beads/interactions.jsonl`:

```bash
git add .beads/interactions.jsonl
git commit -m "chore(bd): close 1gg0.21"
git push
```

---

## Notes for the implementer

- **Do not make anything async.** A caller who needs the network fetches before
  calling. Making the resolver async would make `AddSVGObject` async, which is a
  far larger change than this feature earns.
- **Do not move the `resolve(href)` call inside a `try`.** See Task 1 step 3 and
  Task 4 step 2. The broad catch in `tryBuild` is for corrupt image *bytes*; a
  throw from the caller's own function is a different failure and must surface.
- **Do not cache negative results.** An unresolvable href re-calls the resolver
  per element today, and the spec deliberately leaves that alone. Changing it is
  a separate behaviour change.
- **Sibling issue `1gg0.22`** (nested `image/svg+xml` payloads) is *not* in
  scope. The resolver happens to give a caller a workaround — hand back a
  rasterized PNG — but recursing into a nested SVG is its own feature.
