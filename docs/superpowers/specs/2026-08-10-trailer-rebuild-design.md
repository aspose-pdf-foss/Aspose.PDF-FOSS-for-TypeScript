# Rebuilding a trailer from recovered objects

Closes `dxfk.2`, the second child of epic `dxfk` (robust parsing of damaged
files). Builds directly on `dxfk.1`, whose design is
`2026-08-07-xref-recovery-design.md`.

`dxfk.1` recovers a trailer that **still exists somewhere in the file** — a
`trailer` keyword, or the dict of a `/Type /XRef` stream. When neither survives,
`Document.Open` throws `objects found but no trailer with a /Root`, even though
the sweep salvaged every object in the document. This adds the last step:
identify `/Root` and `/Info` from the recovered objects themselves and
synthesize a trailer around them.

Scope boundary with the rest of the epic is unchanged. Degrading a corrupt
`/ObjStm` per-object is `dxfk.3`; real-world damaged binaries with a
`PROVENANCE.md` are `dxfk.4`.

## A gap this exposes first

On the sweep-only path the merged entry map contains nothing but swept `offset`
entries. Objects inside an `/ObjStm` carry no `N G obj` header, so the sweep
cannot see them — and nothing expands the containers it *does* see. For any file
`Save({ compressed: true })` produced, `/Root` and `/Pages` therefore resolve to
`null` today, which is a live bug independent of synthesis: `corruptStartxref`
on a compressed file does not open.

Synthesis alone cannot fix it, because in that map there is no catalog *object*
to find. So expansion lands here rather than in `dxfk.3`, whose subject is a
container that will not decode — a different concern.

## Architecture

A new module, `src/rebuild.ts`: the parsing half of recovery, paired with
`recover.ts`'s pure byte sweep. It takes plain maps and callbacks and never
touches a `Document`, which is what keeps it testable without building a file.

```ts
/** Register every object an /ObjStm container declares. Returns what it added. */
export function expandObjectStreams(
  entries: Map<number, XrefEntry>,
  load: (num: number) => PdfObject,
): number[];

/** Find the /Encrypt dict by shape, for a file that lost the reference to it. */
export function findEncryptDict(
  entries: Map<number, XrefEntry>,
  loadRaw: (num: number) => PdfObject,
): { num: number; dict: PdfDict } | undefined;

/** What synthesis chose; surfaced verbatim as RecoveryReport.trailer. */
export interface TrailerChoice {
  root: number;
  /** Every /Type /Catalog found, so a caller can see the ambiguity. */
  rootCandidates: number[];
  info?: number;
  infoSource?: 'info-dict' | 'xmp';
}

/** Choose /Root and /Info and build a trailer around them. */
export function rebuildTrailer(
  objects: Map<number, PdfObject>,
  entries: Map<number, XrefEntry>,
  encrypt: { num: number } | undefined,
): { trailer: PdfDict; chosen: TrailerChoice };
```

`TrailerChoice` is declared here and re-exported through `RecoveryReport`
rather than duplicated, so the two spellings cannot drift.

### Ordering

Synthesis needs parsed objects; `Document.build` needs a trailer up front. The
apparent circularity resolves because **the trailer's only role inside `build`
is `/Encrypt` and `/ID`** — nothing else is read. So a *provisional* trailer
carrying only `/Encrypt` is enough to parse the whole document, and the real
trailer is assembled afterwards from what that parse produced.

The `xrefFailure` branch of `Open` becomes:

1. `sweepObjects` → `merged`, last-wins offsets (unchanged from `dxfk.1`);
2. `recoverTrailer` — now returns `undefined` instead of throwing;
3. if it found nothing: `findEncryptDict`, giving a provisional `{ Encrypt }`
   or `{}`;
4. one `Document.build` pass, which expands `/ObjStm` containers internally;
5. if step 2 found nothing: `rebuildTrailer` over that pass's objects.

One build pass, no re-parse. A surviving trailer always wins: synthesis runs
only when step 2 comes back empty, so no file that opens today changes
behaviour.

## Object-stream expansion

Inside `build`, on the recovery path only, immediately after the decryptor
exists. Walk a snapshot of the offset entries, `parseEntry` each, and for every
`/Type /ObjStm` stream add a `compressed` entry for each object number its
header declares.

The placement is forced by encryption. An `/ObjStm` payload is encrypted, so
expansion cannot precede the decryptor; the `/Encrypt` dict is never itself
encrypted and in practice is never compressed, so finding it can. That is the
only ordering that works for both an encrypted and a plain file.

A swept `offset` entry wins over a compressed one for the same object number: it
was found literally in the file, whereas the container's header is a claim about
what it contains. A container that will not decode is skipped rather than fatal
— per-object degradation of a broken container is `dxfk.3`.

Expansion mutates the `merged` map in place. That map is freshly constructed on
the recovery path and belongs to nobody else, and mutating it is what lets
`Open` report the added numbers in `repaired`.

## Choosing `/Root`

Collect every object whose dict is `/Type /Catalog`, then:

1. keep those whose `/Pages` resolves to a `/Type /Pages` dict;
2. among survivors, **highest file offset wins** — the container's offset for a
   compressed catalog;
3. if none survives step 1, fall back to plain highest-offset.

Step 2 matches `dxfk.1`'s last-wins rule and append-only incremental-update
semantics. Step 1 exists for the same reason `dxfk.1` validates its duplicate
candidates: on a tail-truncated file the *newest* catalog is precisely the
broken one, and unconditional last-wins picks it every time.

Step 3 is deliberate. A document whose page tree is damaged should still open
with whatever catalog exists, carrying the damage in `doc.recovery`, rather than
throwing — the whole premise of the recovery path is that partial salvage beats
nothing.

With no catalog at all, `PdfParseError('no /Type /Catalog object found')`. That
is a **third** message, not a replacement: `dxfk.1`'s two say very different
things to a caller and both must survive. `'no indirect objects found'` still
fires first, on an empty sweep, before any build pass; `'objects found but no
trailer with a /Root'` no longer fires at all, since that is now precisely the
case synthesis handles. The three form a ladder — nothing in the file, objects
but no catalog, catalog found.

## Choosing `/Info`

`/Info` has no `/Type`, so it must be matched on shape. The decisive signal is
structural rather than lexical: **a valid document never reaches `/Info` from
the catalog graph**. It hangs off the trailer alone.

So: walk the reachable set from the chosen `/Root`, then score every dict
outside it that has no `/Type` and carries at least one of `/Producer`,
`/Creator`, `/CreationDate`, `/ModDate`, `/Title`, `/Author`, `/Subject`,
`/Keywords`. Rank by how many it carries, tie-break on highest offset.

Reachability is what stops an outline item from winning — an outline item has
`/Title` and no `/Type`, so a key-set test alone matches it, and an exclusion
list of other-dict shapes would have to stay ahead of every construct in the
format.

### XMP fallback

When nothing scores, read `/Root /Metadata` and build a fresh `/Info` object
through the existing chain: `readXmp` → `mirrorXmpToMeta` → `applyUpdate`. The
new dict is allocated a fresh object number and added to the model before the
`Document` is constructed.

This adds no metadata vocabulary — `xmp.ts` already mirrors these fields in both
directions for `SetXmp`, and this reuses that mapping unchanged. It is a second
source of truth on a path that is already guessing, which is acceptable
precisely because the path is explicitly best-effort and reports what it did.

## Encryption without a trailer

A file that lost its trailer lost the `/Encrypt` reference and the `/ID` array
together. Recovering the reference is easy: the `/Encrypt` dict is an indirect
object identifiable by shape — a dict with no `/Type` whose `/Filter` is
`/Standard` (then requiring `/V`, `/R`, `/O`, `/U`, `/P`) or `/Adobe.PubSec`
(then requiring `/Recipients`, or a `/CF` whose crypt filter carries one).
`/ID` is the real question, and the answer differs by handler and revision.

| Handler | `/ID` needed? | Outcome |
|---|---|---|
| Standard, R ≥ 5 (AES-256) | no — `fileKeyR56` derives from `/U`'s salts | recovers fully |
| `/Adobe.PubSec` | no — key comes from the recipient's CMS | recovers fully |
| Standard, R ≤ 4 (RC4, AES-128) | yes — `fileKeyR234` hashes `id0` | `PdfParseError` |

The R ≤ 4 message names the actual cause:

> cannot recover an encrypted document (revision N): /ID was lost with the
> trailer and is required to derive the file key

Today that path reaches `validateUserR234` with an empty `id0`, fails the
comparison and throws `InvalidPasswordError` — on a correct password. Reporting
a wrong password for a problem that has nothing to do with the password sends
the caller hunting in the wrong place, which is the concrete form of the issue's
"detect it and fail with a clear error rather than producing a `Document` full
of undecrypted streams".

`PdfParseError` rather than `UnsupportedFeatureError`: the feature is supported,
the file is damaged.

## The signal

`RecoveryReport` gains one optional field, present only when the trailer was
synthesized:

```ts
  /** Present when no trailer survived and one was rebuilt from the objects. */
  trailer?: TrailerChoice;
```

`reason` is unchanged and still describes why recovery started
(`startxref-unreadable` or `xref-unparsable`); synthesis is a deeper level of
damage *within* those, not a fourth cause. `rootCandidates` carries the
acceptance criterion that a multi-candidate choice is visible and not merely
deterministic — a caller archiving a file can tell "one catalog, obvious" from
"three catalogs, we picked the last".

## Testing

Existing helpers cover the damage. `destroyTrailer` already forces this path on
a classic file; `corruptObjectBody` on the xref-stream object plus
`corruptStartxref` forces it on a compressed one.

- **The inversion.** `xref-recovery.test.ts`'s `'refuses a file with no trailer,
  leaving synthesis to dxfk.2'` now opens: the page tree walks and
  `GetMetadata()` matches the intact original. That test is rewritten in place,
  since it is the literal statement of what this issue changes.
- **Expansion is load-bearing.** A compressed file with its xref stream
  destroyed walks its page tree. Red if `/ObjStm` expansion is ever removed.
- **Duplicate catalogs.** An appended incremental update carrying a second
  catalog: the later one wins. With that later one truncated: the earlier
  validated one wins.
- **`/Info` against a decoy.** A document with outline items — which carry
  `/Title` and no `/Type` — resolves to the real `/Info`, not an outline item.
- **XMP fallback.** No `/Info` dict, XMP present: `GetMetadata()` returns the
  XMP values and `infoSource === 'xmp'`.
- **Encryption.** AES-256 with the trailer destroyed opens with the password.
  RC4 and AES-128 throw `PdfParseError` naming `/ID` — asserted as *not*
  `InvalidPasswordError`, since that is the regression the message exists to
  prevent.
- **Unit, on `rebuild.ts` alone.** `expandObjectStreams` with a fake loader;
  catalog ranking over hand-built object maps; the `/Info` scorer against a
  reachable decoy. No PDF involved.

Per CLAUDE.md's fixture rule, finish by breaking each path deliberately and
confirming the suite goes red. A synthesis test that passes because a trailer
was still findable is the easy accident here — every fixture must be asserted to
throw before the change.

## Consequences elsewhere

**No behaviour change for any file that opens today.** Synthesis runs only where
`Open` currently throws. `/ObjStm` expansion runs only on the recovery path, and
only adds entries the map did not have.

**`Save()` remains the repair story**, unchanged: mark-sweep from `/Root` writes
a clean file with a real trailer, and `Sign` still refuses a recovered document.

**README.** The recovery paragraph gains a sentence on trailer synthesis and the
R ≤ 4 encrypted limitation.
