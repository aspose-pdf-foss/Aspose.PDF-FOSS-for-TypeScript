# Cross-reference recovery: opening a damaged PDF

Closes `dxfk.1`, the first child of epic `dxfk` (robust parsing of damaged
files). Parity target: `Aspose-PDF-FOSS-for-Go` `xref_reconstruct.go`.

`xref.ts` reads classic tables, cross-reference streams and hybrid `/XRefStm`,
and has no fallback of any kind. A broken `startxref` offset, a truncated
trailer, or a table whose offsets are shifted by prepended bytes makes `Open`
throw, on files every other reader accepts. This adds a recovery path: sweep the
whole buffer for `N G obj` headers, build an offset map from what is actually
there, and merge it with whatever the cross-reference structure still gave us.

`readXref` itself is unchanged. It stays the strict fast path; recovery is a
fallback layered above it in `Document.Open`.

## Scope boundary with the rest of the epic

This issue recovers a trailer that **still exists somewhere in the file** — a
`trailer` keyword, or the dict of a `/Type /XRef` stream. Synthesizing a trailer
from scratch by identifying the `/Type /Catalog` object is `dxfk.2`. Degrading a
corrupt `/ObjStm` per-object is `dxfk.3`. Real-world damaged binaries with a
`PROVENANCE.md` are `dxfk.4`; the fixtures here are builder-made files damaged
programmatically, which keeps this suite hermetic.

## The sweep — `src/recover.ts`

A new module, not a patch to `xref.ts`: a brute-force buffer scan shares no
logic with parsing a well-formed cross-reference structure, and folding it in
would put a slow fallback inside the fast path.

```ts
export interface ObjCandidate { offset: number; gen: number; }
export interface SweepResult {
  /** Object number -> every candidate found, ascending by file offset. */
  candidates: Map<number, ObjCandidate[]>;
  /** Byte offsets just past each `trailer` keyword, latest first. */
  trailerOffsets: number[];
}
export function sweepObjects(buf: Uint8Array): SweepResult;
```

Pure byte scanning, no object parsing. Walk the buffer for the `obj` keyword,
then backtrack: whitespace, a digit run (the generation), whitespace, a digit
run (the object number). Require the byte before the object number to be
whitespace or start-of-file, and the byte after `obj` to be whitespace or a
delimiter.

Two reasons this is a byte scan rather than a regex over a decoded string: a
100 MB file should not become a 100 MB string, and the backtracking predicate
rejects `obj`-shaped byte runs inside stream data far more often than a pattern
match does.

It returns **every** candidate rather than pre-selecting a winner. Choosing
between duplicates needs the parser, which lives in `Document.Open`; keeping
`recover.ts` free of parsing is what makes it testable on hand-built byte
buffers with no PDF involved.

## Trigger and detection

Recovery runs automatically — `Open` gains no new option. Three conditions
send it down the fallback path:

| Condition, checked in the first pass | `reason` | Catches |
|---|---|---|
| `readXref` throws | `startxref-unreadable` or `xref-unparsable`, by cause | broken `startxref`, unparsable table or xref stream |
| any object fails to parse | `object-parse-failure` | offsets shifted by prepended bytes, bad offsets |
| `/Root` does not resolve to a `/Type /Catalog` | `root-not-catalog` | a shift that lands on a valid but wrong object |

The third is one lookup and it is the actual definition of a usable document.
The parse check alone misses a shift that happens to land on another object
header.

All three are evaluated on the **first** build pass, which never throws on a
per-object failure — it collects failures instead. The sweep then runs once, and
the second pass is the last word.

### Strictness is preserved for structurally sound files

What happens to an object that still will not parse after the second pass
depends on *why* we were recovering:

- `readXref` succeeded **and** `/Root` resolved to a catalog — the document is
  structurally sound, so a malformed object is a genuine error and `Open`
  throws, exactly as it does today. The sweep was a repair attempt, not a
  licence to degrade.
- anything else — the file was already known-damaged and we are explicitly in
  best-effort mode, so the object becomes `null` and is listed in
  `RecoveryReport.lost`.

This keeps today's contract intact for every file that is merely slightly bad,
while not letting three unrecoverable objects discard the 99% the sweep salvaged
from a genuinely broken one. A reference to a non-existent object is legally
null (32000-1 7.3.9), which is what makes the second branch spec-shaped rather
than a fudge.

A healthy file satisfies none of these and never sweeps. That is asserted on the
recovery flag, not on timing.

## Merge, not replace

A sweep can only ever find `offset` entries. Objects inside an `/ObjStm` carry
no `N G obj` header and are invisible to it, so a recovered map that *replaced*
`entries` would discard every `compressed` entry the cross-reference structure
knew about — losing most of a modern document because one object was damaged.

So the merge keeps every surviving xref entry, including `compressed` ones, and
overlays swept offsets only where the xref had no entry or where its entry
failed to parse. Salvage is then proportional to damage. When the xref was
entirely unreadable there is nothing to merge with and this degrades naturally
to full replacement — the genuinely lossy case that `dxfk.3` documents.

### Choosing between duplicate candidates

Last occurrence wins — highest file offset — which is what a linear reader
settles on and what append-only incremental updates imply. But the winner is
validated by parsing it, and a candidate that does not parse falls back to the
previous occurrence.

Validation happens lazily during the second build pass, not eagerly at merge
time: the merge seeds each entry with the highest-offset candidate, and on a
parse failure the builder consults the candidate list for the next one down.
Parsing every candidate of every object up front would cost a full parse of
every superseded generation in the file for no benefit.

This is why the builder holds the `SweepResult` rather than the merge folding
alternates into the entry: `XrefEntry` stays exactly as `xref.ts` declares it
today, a single offset, and the fallback chain lives entirely on the recovery
path.

Unconditional last-wins is simpler and is what most readers do, but it fails on
a tail-truncated file, where the *last* copy of an object is precisely the
broken one. That is a common damage mode, so the validation earns its cost.

A sweep cannot distinguish a live object from a freed one whose bytes are still
on disk, so this rule will revive a deleted object when nothing newer reused its
number. That is accepted rather than detected: anything unreferenced is dropped
by `Save()`'s mark-sweep.

## Trailer recovery

In order:

1. the trailer `readXref` produced, if it got that far;
2. `trailerOffsets` parsed latest-first, taking the first dict carrying `/Root`;
3. a recovered object whose dict is `/Type /XRef` — that dict *is* the trailer,
   and this is the only route for an xref-stream-only file, which has no
   `trailer` keyword anywhere.

If none yields a `/Root`, throw as today. Synthesis is `dxfk.2`.

Encrypted documents work unchanged once a trailer is recovered, since `/Encrypt`
and `/ID` ride along in it.

## The signal

```ts
export interface RecoveryReport {
  reason: 'startxref-unreadable' | 'xref-unparsable'
        | 'object-parse-failure' | 'root-not-catalog';
  /** e.g. 'startxref pointed at offset 91234, past end of file' */
  detail: string;
  /** Objects whose offset came from the sweep rather than the xref. */
  repaired: number[];
  /** Objects that never parsed; null in the model. */
  lost: number[];
}
```

on `Document` as `readonly recovery?: RecoveryReport`. Absent means a clean
parse. There is deliberately no companion `recovered: boolean` —
`doc.recovery !== undefined` says the same thing, and two spellings of one fact
drift apart.

Recovering automatically without a signal would turn a corrupt file into an
apparently-fine `Document`, and a caller verifying a signature or archiving a
file would have no way to tell salvage from a clean parse.

## Consequences elsewhere

**`Save()` is the repair story.** It mark-sweeps from `/Root` and renumbers, so
saving a recovered document writes a clean file. This is the intended workflow
and belongs in the README.

**Signing a recovered document throws.** `Sign`/`Certify` append incrementally
to preserve earlier signed bytes; on a recovered document those bytes are by
definition damaged, so the append preserves nothing meaningful. Three lines, and
it prevents producing a signed file whose signature covers a corrupt base.

**No behaviour change for structurally sound files.** A malformed object in a
file whose xref reads and whose `/Root` resolves still makes `Open` throw, as
today — see "Strictness is preserved for structurally sound files" above. The
only difference is that a sweep is now attempted first, so some files that
threw before will open, and none that opened before will throw.

The observable change is confined to files that are already damaged: those go
from throwing to opening, with `doc.recovery` describing what was salvaged and
what was lost.

## Error handling

- Sweep finds no candidates: `PdfParseError('no indirect objects found')`.
  Deliberately a different message from "objects found but no trailer" — the two
  mean very different things to a caller.
- **Recursion guard.** `parseEntry` recurses for forward refs (an indirect
  `/Length`) and memoizes only after parsing returns. Today the xref is trusted
  so cycles do not arise; a swept offset map can produce a self-referential
  `/Length` and hang. An in-progress set is needed. This is a latent bug the
  sweep exposes rather than creates.
- Cost: one O(n) pass over the buffer, on the damaged path only.

## Testing

**Unit, on `recover.ts` alone** — hand-built byte buffers, no PDF: a header at
offset 0; headers after `\r\n` and after a bare `\r`; an `obj`-shaped byte run
inside stream data rejected because the preceding byte is not whitespace;
non-zero generations; several candidates for one object number returned in file
order; `trailer` keyword offsets.

**Integration, via a new `test/helpers/damage-pdf.ts`** — named damage functions
applied to files the existing builders produce: `corruptStartxref`,
`destroyTrailer`, `prependBytes`, `truncateTail`, `truncateMidObject`.

Assertions carrying the acceptance criteria:

- healthy file: `doc.recovery === undefined`, and the page count and `GetText()`
  are unchanged from today;
- damaged file: same page count and same `GetText()` as the intact original;
- **the merge actually merges**: build with `Save({ compressed: true })`,
  corrupt one plain object's offset, and confirm objects inside `/ObjStm`s still
  resolve. This is the test that goes red if someone later simplifies the merge
  back into a replacement, so it is written first;
- tail-truncated file: the earlier good copy of the last object wins;
- **strictness holds**: a file with an intact xref and a resolvable `/Root` but
  one object corrupted in place still throws `PdfParseError`, and `doc.recovery`
  is never reached. This is the assertion that goes red if the two branches of
  the strictness rule are ever collapsed into one.

Per CLAUDE.md's fixture rule, finish by breaking the recovery path deliberately
and confirming the suite goes red. A recovery test that passes because the file
was never really damaged is the easy accident here.
