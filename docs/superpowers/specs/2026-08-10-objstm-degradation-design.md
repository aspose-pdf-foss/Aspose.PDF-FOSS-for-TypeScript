# Degrading a corrupt /ObjStm per object

Closes `dxfk.3`, the third child of epic `dxfk` (robust parsing of damaged
files). Builds on `dxfk.1` (`2026-08-07-xref-recovery-design.md`) and `dxfk.2`
(`2026-08-10-trailer-rebuild-design.md`).

`decodeObjStm` decodes an object stream as a unit. Any fault in the container
throws, and the throw takes down every object the container held — which on a
`Save({ compressed: true })` file is most of the document, including `/Root`.
This degrades the container per object: decode what survives, drop what does
not, and report the loss.

Scope boundary with the rest of the epic is unchanged: real-world damaged
binaries with a `PROVENANCE.md` are `dxfk.4`.

## What happens today

`Open` does not merely lose the objects — it throws, on a file whose
cross-reference table is perfectly intact.

Follow a compressed file whose `/ObjStm` payload is damaged. `parseEntry`
reaches a `compressed` entry, loads the container, and calls `decodeObjStm`,
which throws. Every compressed object throws with it, so `pass.failed` is
non-empty and `Open` builds an `object-parse-failure` report. That triggers the
sweep-and-rebuild in `document.ts`, which cannot help: an object inside an
`/ObjStm` carries no `N G obj` header, so the sweep cannot see it. The objects
are still in `failed`, and `document.ts:549` rethrows.

The intact xref is what makes this sharp. The file's structure is sound and one
stream's payload is damaged, and the reader refuses the whole document.

## The four faults

`decodeObjStm` throws in four places, and each has a degradation that keeps more
of the document than the throw does.

**The payload will not inflate.** `inflateStream` throws for a truncated or
corrupt payload. `inflateSync` with `finishFlush: Z_SYNC_FLUSH` returns the
prefix zlib produced before it hit the damage, verified against both damage
shapes (bytes cut off the end, and a tail overwritten in place). Every object
wholly inside that prefix is intact and correct; only the object straddling the
damage and those after it are lost. This is the fault the acceptance criteria
name, and the one that recovers the most.

**`/N` does not match the header.** The pair loop runs exactly `/N` times and
throws the moment a pair is not two numbers. Read pairs until the header stops
yielding them instead, and keep what came out.

**Correction, after implementation.** This section originally claimed that an
`/N` of 2³¹ was an unbounded allocation — a number in a dict driving a loop that
allocates per iteration — and specified a byte-derived cap on the pair count.
That was wrong. Stopping at the first non-pair token already bounds the loop,
and such a token always arrives, because `Lexer.next()` always advances or
returns `eof`. The cap was dead code: mutating it away left its test green,
which is how the error was caught. It is not implemented. The `break` carries
the guarantee, and mutating *that* to a `continue` hangs the test — so that is
where the assertion sits.

**`/First` is wrong.** Every object offset is relative to it, so a wrong `/First`
lands every parse in the middle of something else. The header's own end is a
lower bound that costs nothing to compute — the lexer is already sitting on it
when the pair loop finishes. Use it when `/First` is missing, past the end of the
data, or below the header end. A `/First` that is wrong but plausible is not
detectable and stays a best-effort parse.

**One object will not parse.** A single bad entry currently loses the other
`N - 1`. Parse each in its own `try`, record the number, keep the rest. An offset
past the surviving data is skipped without attempting it.

## Architecture

`decodeObjStm` returns what it recovered instead of throwing:

```ts
/** What one /ObjStm container yielded, and what it cost. Surfaced verbatim as
 *  RecoveryReport.objectStreams. */
export interface ObjStmDamage {
  /** Object number of the container itself. */
  container: number;
  /** Objects the container declared and this decode produced. */
  recovered: number[];
  /** Objects the container declared that did not survive the damage. */
  lost: number[];
  /** e.g. 'payload inflated to 240 bytes, header declares 7 objects' */
  detail: string;
}

/** Decode an /ObjStm into objectNumber -> PdfObject, degrading per object.
 *  `damage` is undefined when the container decoded whole. */
export function decodeObjStm(
  s: PdfStream, container: number,
): { objects: Map<number, PdfObject>; damage?: ObjStmDamage };
```

The `container` argument is new. The decoder cannot know its own object number
and the report needs it, and both call sites have it to hand.

Two callers change. `document.ts`'s `parseEntry` reads `.objects` and collects
`.damage`; `rebuild.ts`'s `expandObjectStreams` currently skips a container that
will not decode with a bare `continue` and instead registers the partial
contents, which is what makes the recovery path benefit too.

`decodeObjStm` still throws for one thing: a container that yields nothing to
work with — a payload that inflates to zero bytes, or a header from which not a
single pair could be read. There is nothing to recover and nothing to name in a
report, and both callers already handle a throw by dropping the container. A
missing `/First` is *not* in this set; it is recovered from the header end like
any other wrong value, which is only meaningful once pairs exist.

## The strictness carve-out

This is the part that changes an existing decision, so it is the part to get
right.

`document.ts:549` rethrows when an object still will not parse after the sweep,
under a deliberate rule: on a file whose xref read cleanly and whose `/Root` is a
catalog, an unparseable object is a genuine error, and the sweep was a repair
attempt rather than a licence to degrade. That rule is correct and stays.

It does not describe an object lost inside a damaged `/ObjStm`. The rule reasons
about a repair that was attempted and failed; for a compressed object the repair
was never available, because the sweep cannot see an object with no `N G obj`
header. Rethrowing there is not strictness, it is refusing a document over
damage that provably cannot be repaired — which is the behaviour `dxfk.3` exists
to remove.

So the exemption is narrow, and `BuildResult` grows a second set to keep the two
kinds of loss apart:

```ts
interface BuildResult {
  objects: Map<number, PdfObject>;
  /** Would not parse at an offset. Still fatal on a structurally sound file. */
  failed: Set<number>;
  /** Declared by a damaged /ObjStm and not recovered. Reported, never fatal. */
  lostInObjStm: Set<number>;
  repaired: number[];
  permissions: Permissions | undefined;
}
```

The rethrow condition is untouched. It reads `failed`, which no longer contains
objects of the second kind.

## What the caller sees

A damaged container produces a report even when the xref read cleanly, because
the document is lossy and silence about that is the thing the acceptance
criteria forbid:

```ts
reason: 'objstm-undecodable'
detail: 'object stream 12 decoded 3 of 7 objects'
lost:   [8, 9, 10, 11]
objectStreams: [{
  container: 12,
  recovered: [5, 6, 7],
  lost:      [8, 9, 10, 11],
  detail:    'payload inflated to 240 bytes, header declares 7 objects',
}]
```

`reason` gains `'objstm-undecodable'`, used when a damaged container is the only
fault. When the file is *also* broken in a way that already has a reason — an
unreadable `startxref`, an unparseable xref — that reason wins and
`objectStreams` rides along, since it describes damage rather than how the
cross-reference data was obtained.

`lost` keeps its documented meaning, "objects that never parsed; null in the
model", and carries both kinds of loss — it is the caller-facing list, while
`failed` is the internal set the rethrow reads. A reference to a lost object
resolves to `null`, which is what ISO 32000-1 prescribes for a reference to a
non-existent object, and what `parseEntry` already does for an entry it cannot
load.

## Boundaries

**`/Root` is not degradable.** If the damage reaches the catalog there is no
document to return and `Open` throws, as it does now — the `Document`
constructor rejects a trailer whose `/Root` is not a catalog. No new check is
needed and none is added.

**The loss cannot be backfilled.** This is the one place in the epic where
recovery is genuinely lossy, for the reason `dxfk.1` documented: an object in an
`/ObjStm` exists nowhere else in the file. `dxfk.4`'s real-world fixtures will
not change that. The report is the deliverable, not a step toward recovering the
bytes.

**Encrypted containers.** An `/ObjStm` payload is encrypted, and decryption
happens in `parseEntry` before `decodeObjStm` sees it. A truncated AES payload
may fail to decrypt at all, in which case the container throws and is dropped
whole — the same outcome as today, one layer earlier.

## Testing

A damage helper alongside the existing ones in `test/helpers/damage-pdf.ts`:

```ts
/** Overwrite the tail of an /ObjStm payload in place, preserving byte length so
 *  every xref offset stays valid and the container is the only damage. */
export function corruptObjStmPayload(pdf: Uint8Array, keepFraction: number): Uint8Array;
```

In-place corruption rather than real truncation is deliberate: cutting bytes
also invalidates the xref and the trailer, which would test the combined
recovery path and leave it unclear which mechanism saved the document. This
isolates the container as the only fault, so the assertions are about `dxfk.3`.
It belongs in `damage-helpers.test.ts`'s load-bearing list, whose contract —
"throws, or opens only by recovering" — the helper satisfies on the recovering
side.

Coverage:

- **The acceptance criterion, end to end.** A multi-page compressed document so
  damaged opens; the pages before the damage are present with their text intact;
  `doc.recovery.objectStreams` names the container and the objects it cost.
- **Unit tests on `decodeObjStm`** for each of the four faults, built directly
  as streams rather than through a document, so each fault is isolated: a
  truncated payload, an `/N` larger than the header, a `/First` past the data,
  and one unparseable entry among several good ones.
- **The hostile `/N`.** A container declaring 2³¹ objects returns the three
  objects its header actually holds. Per the correction above, the assertion is
  on the header stopping where the pairs stop; the mutation that falsifies it is
  weakening that `break`.
- **Strictness is intact.** `corruptObjectBody` on an uncompressed file still
  throws — the carve-out did not widen into a general licence to degrade. This
  is the assertion that would catch the exemption being applied too broadly, and
  the existing `dxfk.1` tests that cover it must stay green.
- **A clean file is byte-identical.** An undamaged compressed document opens
  with `recovery === undefined` and saves to the same bytes as before, so the
  partial-inflate path costs nothing on the healthy path.

Each assertion is proved load-bearing by breaking the code path it covers and
confirming the suite goes red, per the project's rule for recovery work.
