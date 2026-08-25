# OCMD `/VE` Interpretation (3sn) — Design

Issue: `aspose-pdf-foss-for-ts-3sn` — *OCG: interpret OCMD /VE visibility expressions*.

`refMatchesLayer` (src/ocg.ts) handles OCMD `/OCGs` membership but not the `/VE`
boolean visibility-expression tree, and there is no way to resolve the visibility
of an OCMD at all. This adds `/VE` interpretation for two purposes: `RemoveLayer`
membership detection and a new visibility-resolution query.

## Background — `/VE` grammar (PDF 32000-1 §8.11.2.3)

A visibility expression `/VE` is an **array**:

- Element `[0]` is a name operator: `/And`, `/Or`, or `/Not`.
- Remaining elements are operands. Each operand is either:
  - an indirect reference to an OCG dictionary (a **leaf**), or
  - a nested `/VE` array (a sub-expression).

`/And` = all operands true; `/Or` = any operand true; `/Not` = exactly one
operand, negated. A leaf OCG evaluates to its ON/OFF state under a viewing
configuration.

When an OCMD has a `/VE`, it takes precedence over `/P`. Otherwise the `/P`
policy applies over `/OCGs`: `AnyOn` (default), `AllOn`, `AnyOff`, `AllOff`.

## Existing landscape (src/ocg.ts)

- `refMatchesLayer(doc, o, target)` (ocg.ts:29–42): true when `o` is `target`, or
  an OCMD whose `/OCGs` includes `target`. Used by `RemoveLayer` to decide whether
  a page-content block, annotation, or XObject bound to `o` should be dropped.
  Current `/OCGs` semantics: `target` matching **any** member counts as a match.
- `LayerConfig.IsVisible(layer: Layer)` (ocg.ts:188–192): reads the config's
  `/ON`, `/OFF`, and `/BaseState` for a single OCG ref.
- `sameRef`, `arrayOf`, `resolveDict` helpers already exist.
- No OCMD wrapper or OCMD-visibility API exists today.

## 1. RemoveLayer membership — extend `refMatchesLayer`

Add an internal recursive walker:

```ts
/** True when `target` appears as any leaf OCG ref in a /VE expression tree. */
function veReferencesLayer(doc: Document, ve: PdfObject | undefined, target: PdfRef): boolean {
  const a = doc.resolve(ve);
  if (!isArray(a)) return false;
  // a[0] is the operator name; operands are a[1..]
  for (let i = 1; i < a.length; i++) {
    const operand = a[i];
    if (sameRef(operand, target)) return true;
    if (isArray(doc.resolve(operand)) && veReferencesLayer(doc, operand, target)) return true;
  }
  return false;
}
```

In `refMatchesLayer`, inside the existing `OCMD` branch, after the `/OCGs`
check, also test `/VE`:

```ts
if (isName(t) && t.name === 'OCMD') {
  const ocgs = d.get('OCGs');
  if (isArray(doc.resolve(ocgs))) {
    if (arrayOf(doc, ocgs).some((g) => sameRef(g, target))) return true;
  } else if (sameRef(ocgs, target)) {
    return true;
  }
  if (veReferencesLayer(doc, d.get('VE'), target)) return true;
}
return false;
```

This mirrors `/OCGs`: if the deleted layer appears anywhere in the OCMD's
membership (list or expression), bound content is dropped by `RemoveLayer`.

Note: nested `/VE` operands are direct arrays (not indirect refs), but the walker
resolves each operand before the `isArray` test to be safe against either
encoding.

## 2. Visibility resolution — `LayerConfig.ResolveVisibility`

### Refactor: ref-keyed visibility

Extract the ON/OFF/BaseState logic into a private helper and delegate:

```ts
/** @internal Visibility of a single OCG ref under this config. */
private isRefVisible(ref: PdfRef): boolean {
  if (arrayOf(this.doc, this.Dict.get('ON')).some((r) => sameRef(r, ref))) return true;
  if (arrayOf(this.doc, this.Dict.get('OFF')).some((r) => sameRef(r, ref))) return false;
  return this.BaseState === 'ON';
}

IsVisible(layer: Layer): boolean {
  return this.isRefVisible(layer.Ref);
}
```

### `/VE` evaluator

```ts
/** @internal Evaluate a resolved /VE expression tree under this config.
 *  Malformed input (unknown operator, /Not with != 1 operand, empty) -> true. */
private evaluateVE(ve: PdfObject | undefined): boolean {
  const a = this.doc.resolve(ve);
  if (!isArray(a) || a.length === 0) return true;
  const op = this.doc.resolve(a[0]);
  const opName = isName(op) ? op.name : '';
  const operands = a.slice(1);
  const evalOperand = (o: PdfObject): boolean => {
    if (isArray(this.doc.resolve(o))) return this.evaluateVE(o);
    if (isRef(o)) return this.isRefVisible(o);
    return true; // non-ref, non-array leaf: treat as visible
  };
  if (opName === 'Not') return operands.length === 1 ? !evalOperand(operands[0]) : true;
  if (opName === 'And') return operands.every(evalOperand);
  if (opName === 'Or') return operands.some(evalOperand);
  return true; // unknown operator
}
```

### `/P` policy

```ts
/** @internal Apply an OCMD /P policy over its /OCGs members. */
private evaluatePolicy(ocmd: PdfDict): boolean {
  const members = arrayOf(this.doc, ocmd.get('OCGs'))
    .filter(isRef)
    .map((r) => this.isRefVisible(r));
  const p = this.doc.resolve(ocmd.get('P'));
  const policy = isName(p) ? p.name : 'AnyOn';
  switch (policy) {
    case 'AllOn':  return members.every((v) => v);
    case 'AnyOff': return members.some((v) => !v);
    case 'AllOff': return members.every((v) => !v);
    case 'AnyOn':
    default:       return members.some((v) => v);
  }
}
```

Note: when `/OCGs` is a single ref rather than an array, `arrayOf` returns `[]`;
`refMatchesLayer` already handles the single-ref `/OCGs` form for membership, and
single-ref-`/OCGs` OCMDs are rare. `evaluatePolicy` therefore treats an
absent/single/empty `/OCGs` as no members: `AnyOn`/`AllOff` over an empty set is
`false`/`true` respectively per `every`/`some`, and an OCMD with neither `/VE`
nor an array `/OCGs` resolves through `ResolveVisibility`'s guard below.

### Public method

```ts
/** Resolve the visibility of any /OC value under this config: an OCG (its
 *  ON/OFF/BaseState state), or an OCMD (via /VE when present, else its /P policy
 *  over /OCGs). Undefined or non-OC values are visible. */
ResolveVisibility(oc: PdfObject | undefined): boolean {
  const d = this.doc.resolve(oc);
  // undefined, or a ref/scalar that does not resolve to a dict: always visible
  if (!isDict(d)) return true;
  const t = this.doc.resolve(d.get('Type'));
  const type = isName(t) ? t.name : '';
  if (type === 'OCMD') {
    if (d.get('VE') !== undefined) return this.evaluateVE(d.get('VE'));
    return this.evaluatePolicy(d);
  }
  // /Type /OCG (or a dict without an explicit type that we treat as an OCG):
  return isRef(oc) ? this.isRefVisible(oc as PdfRef) : (this.BaseState === 'ON');
}
```

Resolution rules, restated:

- `oc` undefined / resolves to a non-dict → `true`.
- `oc` is (a ref to) an OCG dict → `isRefVisible(ref)`; an inline OCG dict with no
  ref falls back to `BaseState`.
- `oc` is (a ref to) an OCMD dict → `/VE` when present, else `/P` over `/OCGs`.

## Error handling & edge cases

- `/Not` with ≠1 operand, unknown operator, or empty `/VE` → `true` (bias toward
  showing content; never throws).
- OCMD with neither `/VE` nor array `/OCGs` → `evaluatePolicy` over an empty
  member set: `AnyOn` → `false`, but such degenerate OCMDs are not expected;
  documented, not special-cased further.
- `isRefVisible` reads only the config arrays, so `/VE` leaves need not be
  registered `Layer`s.
- `RemoveLayer` uses `/VE` only for the drop decision; it does **not** prune the
  target out of surviving OCMD `/VE`/`/OCGs` trees (pre-existing behavior for
  `/OCGs`; out of scope — possible follow-up).

## Public surface

- New method `LayerConfig.ResolveVisibility(oc: PdfObject | undefined): boolean`
  (the class is already exported). No new exported types.
- Internal helpers (`veReferencesLayer`, `isRefVisible`, `evaluateVE`,
  `evaluatePolicy`) are not exported.

## Tests (test/ocg.test.ts + a fixture helper)

Build OCMDs with `/VE` trees and `/P` policies referencing existing layers:

- `ResolveVisibility(ocgRef)` equals `IsVisible(layer)` for a plain OCG.
- `/VE` `And` / `Or` / `Not` and a nested expression; flip member states via
  `SetVisible` and assert the resolved boolean flips accordingly.
- Each `/P` policy (`AnyOn`, `AllOn`, `AnyOff`, `AllOff`) with `/VE` absent.
- `/VE` takes precedence when both `/VE` and `/P` are present.
- Malformed `/VE` (unknown operator; `/Not` with two operands) → `true`.
- `RemoveLayer` drops a page-content block / annotation / XObject bound to an
  OCMD that references the target **only via `/VE`**; verify via a Save→Open
  round-trip that the block/annotation/`/OC` is gone.

## Docs

- README: note in the Optional-content Features bullet and Limitations that OCMD
  visibility is interpreted via `/VE` expressions and `/P` policy
  (`ResolveVisibility`).

## Non-goals

- Pruning deleted layers out of surviving OCMD `/VE`/`/OCGs` trees.
- Authoring `/VE` expressions (creating OCMDs) — read/resolve only.
- Rendering or content-visibility filtering during text extraction.
