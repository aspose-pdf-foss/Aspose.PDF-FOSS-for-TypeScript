# Caller-supplied href resolver for SVG `<image>`

Issue: `1gg0.21` (epic `1gg0` — page-furniture & text-authoring parity gaps).
Deferred from `1gg0.9` (SVG `<image>` embedding).

## Problem

`page.AddSVGObject` embeds an `<image>` only when its `href` is a `data:` URI
carrying PNG or JPEG. Anything else — a relative path, an `http:` URL — embeds
nothing and names `image` in `result.skipped`. That is the right default: the
library performs no I/O, so it cannot fetch the bytes itself.

But a caller often *has* the bytes, or can get them. Today there is no way to
hand them over. The same gap closes `feImage`'s external-href refusal, which
fails for the identical reason and through the identical code path
(`decodeImage`).

## The option

```ts
/** Supply bytes for an <image> or <feImage> href the library cannot decode
 *  itself — a relative path, an http: URL, or a data: payload whose bytes are
 *  not PNG or JPEG. Return undefined to decline, which reports the element in
 *  `skipped` exactly as today. */
resolveImage?: (href: string) => Uint8Array | undefined;
```

on `AddSVGOptions`.

**Synchronous**, because `AddSVGObject` is synchronous. A caller who needs to
fetch over the network does so before the call and resolves out of a map. Making
this async would make the whole placement async, which is a far larger change
than this feature earns.

**Named `resolveImage`, not `image`.** It is a verb doing work, sitting beside
`fit`, `font` and `filterScale`; a bare `image` noun would read like data.

## Decisions

**The resolver is a fallback, not an interceptor.** The built-in `data:` path
runs first; the resolver is consulted only when it yields nothing. This covers
the relative and `http:` hrefs the issue asks for, and as a bonus gives a caller
a shot at a `data:` payload whose bytes fail the PNG/JPEG sniff — an
`image/svg+xml` one, say — without a second mechanism. Resolver-first would make
every inline `data:` image pay a callback, and would let a caller who returns
`undefined` by mistake silently disable images that already worked.

**A resolver throw propagates.** A throw from caller code is a caller bug: a bad
lookup, a missing map. Swallowing it produces a silently missing image and a
vague `skipped: ['image']`, which is very hard to debug. `decodeImage`'s existing
broad catch is for corrupt image *bytes*, which is a different failure with a
different cause.

This has a specific code shape, and getting it wrong is invisible: the resolver
must be **called outside** the `try`, with only its returned bytes passed in.
Calling it inside launders the caller's exception into the very `skipped` report
the decision exists to avoid.

**The resolver serves `feImage` too.** Both `<image>` and `feImage` reach
`decodeImage`, both refuse an external href for the same reason, and a caller
who supplies bytes for one has no reason to be denied for the other.

**`feImage` has a second gate, and it decides the reporting.** *(Corrected
during implementation; the first draft of this spec described only the two
`decodeImage` call sites and was wrong.)* `svgfilter.ts`'s `validImageHref`
refuses an external href during filter **validation**, long before
`rasterizeFeImage` runs — so passing the resolver at the call site alone changes
nothing. `resolveFilter` therefore takes a `hasImageResolver` flag: only the
resolver knows whether it has the bytes, and it is not consulted until rasterize
time, so validation cannot pre-judge an external href once one exists.

The consequence is a deliberate, documented asymmetry in what gets reported:

| Resolver | `feImage href="https://…"` | Reported |
|---|---|---|
| absent | refused at validation | `skipped: ['feImage']` |
| declines | refused at rasterization | `skipped: ['filter']`, element drawn unfiltered |
| supplies bytes | renders | `skipped: []` |

`['filter']` is the generic path every rasterize-time failure already takes.
Reporting `['feImage']` in the declining case would mean threading a reason
through `emitFiltered`'s boolean return, which no other failure needs.

## Changes

### `svgimage.ts`

`decodeImage` takes an optional resolver:

```ts
export function decodeImage(
  href: string, resolve?: (href: string) => Uint8Array | undefined,
): BuiltImage | undefined
```

Its existing `try { buildImageXObject(bytes) } catch { undefined }` is extracted
to a `tryBuild(bytes)` helper, used for the `data:` bytes and again for the
resolver's bytes. `resolve(href)` is called between the two, outside either
`try`.

### `svgdraw.ts`

`SvgDrawOptions` gains `resolveImage?`. `Emitter` gains a matching field, set in
`drawSvg`, and **copied in `Emitter.child()`** alongside `raster` and
`filterPx`. `child()` forks for a pattern tile, a marker, a mask and a filter
subtree; omitting the copy leaves the resolver working at the top level and
silently absent in all four, which is the failure mode this feature is most
likely to ship with.

Both call sites — `drawImage` and `rasterizeFeImage` — pass `e.resolveImage`.
The `resolveFilter` call passes `e.resolveImage !== undefined`.

### `svgfilter.ts`

`validImageHref(attrs)` becomes `validImageHref(attrs, hasResolver)`, accepting
any non-empty href when a resolver exists. `resolveFilter` gains a sixth
parameter, `hasImageResolver = false`, and forwards it. The default keeps every
other caller — including the pure unit tests, which pass no emitter — on the
existing behaviour.

### `svgembed.ts`

`AddSVGOptions` gains `resolveImage?`, validated as a function beside the
existing `filterScale` check and thrown as a `TypeError` before anything is
allocated. It is forwarded into the `drawSvg` options object.

### Unchanged

Reporting: a resolver that declines, or that returns bytes which are not PNG or
JPEG, still yields `skipped: ['image']`.

Caching: `e.images` is keyed by href and shared walk-wide, so a resolver is
consulted at most once per distinct href that resolves. Negative results stay
uncached, as they are today — an unresolvable href re-calls the resolver per
element. Changing that is a separate behaviour change and is out of scope.

## Testing

`test/svg-image.test.ts` (unit, no Document):

- `decodeImage('photo.png', resolver)` builds from the resolver's bytes.
- The resolver is **not** called when the `data:` URI decodes — asserted with a
  call counter, not by output alone.
- The resolver **is** called for a `data:` payload whose bytes fail the sniff.
- A resolver that throws propagates out of `decodeImage`.
- A resolver returning bytes that are not PNG/JPEG yields `undefined`, not a
  throw.

`test/svg-embed-image.test.ts` (integration, through `AddSVGObject`):

- A relative href renders: an Image XObject appears and `skipped` is empty.
- A resolver returning `undefined` still reports `skipped: ['image']`.
- **An `<image>` inside a `<pattern>` tile resolves** — the `child()` copy.
- An `feImage` with an `http:` href resolves.
- An `feImage` whose resolver **declines** reports `['filter']`, not
  `['feImage']`, and the element still draws unfiltered. The existing no-resolver
  case must stay on `['feImage']`.
- One resolver call per distinct href across two `<image>` elements sharing it.
- A non-function `resolveImage` throws `TypeError`.

Then the mutation pass CLAUDE.md requires. Each targets a failure that is
invisible in ordinary use:

- Drop `c.resolveImage` from `child()` → the `<pattern>` test must go red, and
  only that one.
- Move the resolver call inside `tryBuild`'s `try` → the propagate test must go
  red, and only that one.
- Drop the resolver argument at the `rasterizeFeImage` call site → the `feImage`
  resolve test must go red.
- Make `validImageHref` ignore `hasResolver` → both `feImage` tests must go red,
  which is what proves the second gate is load-bearing rather than incidental.

## Documentation

`README.md`, three places:

- The `<image>` sentence that reads "An href that is **not** a `data:` URI — a
  relative path, `http:` — embeds nothing and names `image` in `result.skipped`:
  the library performs no I/O, so the bytes have to arrive in the document."
  The bytes may now arrive through `opts.resolveImage` instead.
- The `feImage` sentence "an external href is refused, since the library
  performs no I/O" — which must also record that with a resolver present such an
  href reaches rasterization, so declining reports `filter` rather than
  `feImage`.
- The `AddSVGObject` row of the API-overview table.
