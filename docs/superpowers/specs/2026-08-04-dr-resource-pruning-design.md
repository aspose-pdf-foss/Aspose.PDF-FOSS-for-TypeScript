# Pruning unused /AcroForm /DR resources in Optimize

Closes `h7g5`. Picks up what `2026-08-04-form-field-removal-design.md` deferred
under "Not covered, deliberately": field creation registers a face through
`ensureDRFont` (`fieldstyle.ts`) and nothing ever removes one, so a document that
has had fields created and removed carries `/DR` entries no field names any more.
They stay reachable from `/Root`, so `Save()` keeps writing them and the font
programs they point at.

Removal has no business deleting a resource the next `Add*` might reuse.
`Optimize` is the module that already decides what is unused, so this is a pass
there — beside `dedup` and `recompress`, not inside `removeField`.

## API

```ts
doc.Optimize({ dr: false });   // opt out; default true
```

```ts
interface OptimizeOptions { …; dr?: boolean }

interface OptimizeReport {
  …;
  dr: {
    /** Qualified keys removed, e.g. 'Font/TiBo'. Empty when nothing was. */
    removed: string[];
    bytesSaved: number;
    /** Set when the pass declined to run. `removed` is then empty. */
    skipped?: string;
  };
}
```

Default on, with `fonts` / `dedup` / `compress`: the pass removes only what
nothing in the document can name, so output renders identically. `report.lossy`
is unaffected. `dr.bytesSaved` folds into the top-level `bytesSaved`.

`removed` names keys rather than counting them because that is what a caller
needs when the pass under-delivers — the same reason `report.skipped` carries a
reason per font.

## Module

New `src/drprune.ts`, exporting `pruneDefaultResources(doc): DrPruneResult`.

`fieldstyle.ts` writes `/DR` and `da.ts` reads it, but neither decides what is
unused, and `optimize.ts` is already an orchestrator rather than an implementer
(`dedup.ts`, `recompress.ts`, `glyphusage.ts` + `fontshrink.ts`). The reference
scan is the substance here and it belongs in one file with the prune it feeds.

## Order

The prune runs **first**, ahead of images → fonts → dedup → compress.

This is load-bearing, not tidiness. Run it last and `optimizeFonts` shrinks a
program the prune is about to orphan and `recompressStreams` re-deflates a stream
that will never be written — both of them reporting `bytesSaved` for bytes the
output file never contained. Running first also means the reachability diff below
is taken against a graph no other pass has churned.

## What counts as a reference

Every category dict in `/DR` is prunable: `/Font`, `/XObject`, `/ExtGState`,
`/ColorSpace`, `/Pattern`, `/Shading`, `/Properties`. `/ProcSet` is an array of
names, not a resource dict, and is left alone.

One collector produces `(category, name)` pairs from a content-stream fragment,
over the operators that name a resource:

| Operator | Category |
|---|---|
| `Tf` | `Font` |
| `Do` | `XObject` |
| `gs` | `ExtGState` |
| `cs`, `CS` | `ColorSpace` (a name that is not a device/pattern space) |
| `scn`, `SCN` | `Pattern` (when the last operand is a name) |
| `sh` | `Shading` |
| `BDC` | `Properties` (when the property-list operand is a name) |
| `BI` | `ColorSpace` (an inline image's `/CS`/`/ColorSpace` name that is not a device space) |

`content.ts` surfaces an inline image as a `BI` op carrying `inlineImage.dict`,
so its `/CS` is readable without a second parser.

Two sources feed it:

1. **Every `/DA` string** — the `/AcroForm` default, every field's, every
   widget's, and every `FreeText` annotation's. A `/DA` is a content-stream
   fragment and resolves against `/DR` by definition (32000-1 12.7.3.3), which is
   what makes one collector serve both sources.
2. **Every `/AP` stream** (`/N`, `/D`, `/R`, including the sub-dictionary form),
   charging to `/DR` every name the stream's **own `/Resources` does not
   resolve**.

Rule 2 is deliberately wider than "streams with no `/Resources` at all". A stream
carrying `/Resources` with only a `/Font` still has nowhere but `/DR` to resolve
the `/ExtGState` it names, and the wider rule is the same code — a resource-less
stream is just the case where nothing resolves. An empty field's `/Tx BMC EMC`
names nothing either way, so the common resource-less appearance does not block
the pass.

A third source falls out of the first two once `/DR` holds more than fonts: a
`/DR` entry can *be* a content stream — a form XObject, a tiling pattern — naming
further `/DR` entries. Those are charged too, for **kept entries only**, iterated
to a fixpoint. Kept-only is what keeps the pass idempotent: charging an entry the
same run is about to delete would keep a resource alive for a stream that is
going away, and the next `Optimize` would remove more than this one did.

**We do not verify that a viewer actually resolves rule 2 that way.** Form
XObject resources are meant to be self-contained; a name a stream cannot resolve
locally is already relying on producer-specific fallback. Keeping those entries
costs a few hundred bytes and dropping one silently changes what a viewer draws.

## Vetoes

Both leave the document untouched, set `dr.skipped`, and leave `removed` empty.

- **An `/AP` stream that will not decode or parse.** The fonts pass's rule
  (`glyphusage.ts`): a scan that cannot prove itself complete must skip rather
  than guess, since the guess fails silently and visually.
- **`/AcroForm /XFA` present.** An XFA packet names `/DR` faces, and `txgg`
  documented that we never read the packet. A scan that structurally cannot see
  those references must not be treated as complete. Mutating a hybrid document is
  fine (that is the `txgg` decision) — concluding that something in it is *unused*
  is not.

`Optimize` already throws `UnsupportedFeatureError` on a signed document, so
signatures need nothing here.

## Algorithm

1. Resolve `/AcroForm /DR`. Absent or not a dict → nothing to do.
2. Check the vetoes; on either, return with `skipped` set.
3. Collect references from every `/DA` and every `/AP` stream.
4. Snapshot the reachable object set: walk refs from `/Root` (+ `/Info`) with
   `refsIn` from `serializer.ts`.
5. Delete every entry of every prunable category dict whose `(category, name)`
   pair no reference matched — a name collected for `/Font` does not keep an
   `/XObject` of the same name. Then delete a category dict the prune emptied,
   and `/DR` itself if
   that emptied it — an empty `/DR <<>>` is a leftover, and the next `Add*`
   bootstraps it again through `ensureDRFont`.
6. Re-walk reachability. `bytesSaved` is the summed raw payload of the streams in
   `before \ after`; a program some page font still reaches is in `after` and
   counts zero.
7. `deleteObject` every object in `before \ after`.
8. `doc.markModified()` (`optimizeDocument` already does this at the end).

Step 7 is what keeps the later passes honest: an orphaned stream left in the
object map is still walked by `dedup` and `recompress`, which would report bytes
saved on an object `Save()` was going to drop anyway. It is a mark-sweep confined
to what this pass orphaned — objects already unreachable before step 4 are left
alone, since collecting those is `Save()`'s job and a different feature.

`bytesSaved` counts stream payloads only, not the dict bytes of a font dict with
no embedded program. That matches the existing report, whose top-level
`bytesSaved` is already documented as an estimated sum of per-stream deltas.

## Testing

`test/optimize-dr.test.ts`, with a builder in `test/helpers/` producing an
AcroForm whose `/DR` carries both referenced and unreferenced entries, and an
embedded program under one of them so the byte accounting is observable.

| Test | Asserts |
|---|---|
| unreferenced face | `/DR /Font /TiBo` gone, `removed` names `Font/TiBo` |
| field `/DA` | the face a field's `/DA` names survives |
| AcroForm `/DA` | a face only the AcroForm-level `/DA` names survives |
| widget `/DA` | a face only a widget's `/DA` names survives |
| FreeText `/DA` | a face only a `FreeText` annotation's `/DA` names survives |
| resource-less `/AP` | a face only a `/Resources`-free `/AP` stream's `Tf` names survives |
| partial `/Resources` | an `/ExtGState` an `/AP` names but its own `/Resources` lacks survives |
| non-font categories | an unreferenced `/DR /XObject` entry is removed |
| `/DR` stream source | a face named only by a kept `/DR` form XObject survives |
| byte accounting | `bytesSaved` covers the orphaned program; a program a page font also reaches contributes zero |
| empties | a `/Font` dict and a `/DR` emptied by the prune are deleted |
| veto: bad `/AP` | undecodable appearance → `skipped` set, `Save()` byte-identical |
| veto: `/XFA` | hybrid document → `skipped` set, `Save()` byte-identical |
| opt-out | `{ dr: false }` leaves `/DR` alone and `removed` empty |
| idempotent | a second `Optimize()` removes nothing further |
| end to end | `RemoveField` then `Optimize` drops the face that field's creation added, and the saved file re-opens with the surviving field still rendering |

The end-to-end row is the issue's motivating case and the one that would regress
silently: every other row can pass while creation and removal drift apart.
