# XFA `<occur>` and data-driven repetition (`164g.2`)

A subform carrying `<occur>` may appear more than once. Today `xfatemplate.ts`
reduces any such subform (`max` other than 1) to a synthetic `'occur'` layout,
which `xfaflow.ts` refuses ("needs repetition (164g.2)"). As a result OPM Form
1644's four tables, whose `Header` rows carry `<occur max="-1">`, refuse at page
level. This design makes the instances first, then lays them out.

## Decisions taken in brainstorming

| # | Question | Decision |
|---|---|---|
| 1 | How does a repeating subform find its instances in the data? | **Same-named data groups at its data path**, clamped to `[min, max]`. No data document means `initial`. The spec's general merge (scope matching, flat data spread across nested repeating subforms, Example 9.6) is out of scope. Every shape the rule cannot answer is refused by name. |
| 2 | Where does expansion happen? | **In `xfatemplate.ts`'s walk** (approach A). That walk already owns names, data paths and layout nodes, so the flow engine stays free of data. Expanding in the layout engine was rejected because it would give naming two owners. A separate merge module (XFA's Template DOM → Form DOM split) was rejected for now as a refactor this scope does not need. |

## Sources

XFA Specification 3.3, as pinned by 164g.1 (SHA-256
`a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`). The
copy re-fetched for this design is the Internet Archive capture of 2016-03-05,
and it matches the pin. Pages below are the printed page numbers.

- **The `occur` element** (p. 263). `min` defaults to 1. `max` defaults to the
  value of `min`, and `-1` means no limit. `initial` applies to a blank form
  and defaults to `min`. Subforms and subform sets take `occur` for the merge.
  A `pageArea`'s or `pageSet`'s `occur` acts during layout instead.
- **`initial`** (p. 339–340). It sets the number of siblings "during an empty
  merge" and is "ignored when merging with a non-empty data document".
- **`max`** (p. 341). It caps the siblings in a non-empty merge; `-1` means no
  limit; "ignored during an empty merge".
- **`min`** (p. 343–344). It sets "the starting number of copies … during a
  non-empty merge"; the subform gets at least this many whatever the data
  holds.
- **Blank form** (p. 345). `initial` "is always used during an empty merge".

**A conflict in the spec, recorded.** p. 339 says an attribute missing from an
`<occur>` element "defaults to 1". p. 263 and p. 341 say a missing `max`
duplicates `min`, and p. 340 says a missing `initial` duplicates `min`. The two
agree unless `min` is stated. We follow p. 263/341, the specific statements.
No form in the corpus states `min`.

## The evidence

The only `<occur>` in every vendored XFA form is OPM 1644's table `Header`
row: four of them, all `<occur max="-1">` in `layout="table"`, each holding two
draws and no field. No hybrid form repeats anything. The oracle is
`test/fixtures/xfa-dynamic/` (pdf.js 6.3.289):

- **`published`**: one empty `Header` data group per table, so one instance.
- **`header`**: three `Header` groups in SectionI. pdf.js stacks the rows at
  y = 139.14, 157.14 and 175.14, each 18pt tall. SectionII stays at y = 231.69
  in both variants, because `Page1` positions its sections absolutely.
- **`pages`**: `Page2` repeated across page breaks. This is page-level
  repetition and belongs to 164g.3.

**The data groups are EMPTY** (`<Header xfa:dataNode="dataGroup"></Header>`).
`parseXfaDatasets` keeps leaf values only, so it has no entry for them, and the
count needs a model of its own.

## Design

### 1. Data groups (`xfadata.ts`)

`parseXfaDataGroups(root: XmlNode): XfaDataGroups`. For every data path it
records how many child elements of each name sit there, empty ones included,
with indices assigned exactly as `parseXfaDatasets` assigns them (per name
among siblings). That is what makes a template instance's data path
`…Header[k]` the path its fields bind by.

```ts
export interface XfaDataGroups {
  /** No data document, or an empty `<xfa:data>`: the merge is EMPTY. */
  empty: boolean;
  /** How many children named `name` the data node at `path` holds; 0 when
   *  `path` names no data node. `path` is SOM-shaped, `''` for the data root. */
  count(path: string, name: string): number;
}
```

A pure leaf like the rest of `xfadata.ts`, and it never throws.

### 2. Instantiation (`xfatemplate.ts`)

`parseXfaTemplate(root, groups?: XfaDataGroups)`. When `groups` is omitted,
every repeating subform takes `initial`, the empty-merge answer. So a caller
holding only a template gets a definite, spec-backed result, and every existing
call is unchanged unless it passes `groups`.

For a `<subform>` with an `<occur>` child (or any subform, where the absent
element gives 1/1/1):

- `min`, `max`, `initial` are read with the defaults above. A value that is not
  a non-negative integer (`-1` allowed for `max` only) refuses the subform
  (below).
- **N** is `initial` for an empty merge. Otherwise it is
  `clamp(groups.count(parentDataPath, name), min, max)`, with `max = -1`
  meaning no upper bound.
- The subform is walked **N times**. Each pass takes the next occurrence index
  from the scope fdq3 built, so instances are `Header[0..N-1]` in the SOM name
  and in the data path alike. Each pass yields its own `LayoutNode`, carrying
  the subform's REAL `layout` (no more synthetic `'occur'`), and its own fields.
- **N = 0** is legal (`min="0"`, no data). The subform contributes no fields
  and no node, and its index is not consumed.
- A subform with no `<occur>`, or with `min = max = initial = 1`, follows
  exactly today's path. That is the byte-identity argument for every form
  without repetition, including all four hybrids.

**Refused, with the reason carried on the node and reported for each field
below it.** In each case the subform is walked ONCE, as today, so names stay
stable:

| Shape | Reason (prefix `<label>: `) |
|---|---|
| `<bind ref>` or `<bind match="none">` on a repeating subform | `a repeating subform bound by ref or match="none" is not instantiated` |
| An unnamed repeating subform in a non-empty merge | `an unnamed repeating subform has no data groups to count` |
| N > 1 in a `position`-laid parent | `N instances of a repeating subform in a positioned container would overlap` |
| A repeating PAGE subform (a child of the subform carrying `<pageSet>`) | `a repeating page subform needs page breaking (164g.3)` |
| An unreadable `min`/`max`/`initial` | `occur min="…" could not be read` (etc.) |
| `max` below `min` (`max` not `-1`) | `occur max="…" is below min="…"`. The spec requires `max ≥ min` (p. 342) and gives no recovery, so neither bound is chosen. |

"Repeating" means `max` other than 1, or N other than 1.

### 3. Flow (`xfaflow.ts`) and converter (`xfaconvert.ts`)

- `LayoutNode` gains `refusal?: string`. `refusalOf` returns it first and no
  longer knows `'occur'`. The engine learns nothing about data.
- `xfaconvert.ts` builds `parseXfaDataGroups` from the `datasets` packet it
  already decodes and passes it to `parseXfaTemplate`. Binding needs no change:
  each instance's fields already carry their own `[k]` in `dataPath`.
- A hybrid's AcroForm names instance `k` `…Header[k]…`, so reconciling stays
  name equality.

## Testing

- **`xfadata`**: group counts, empty groups counted, the indices agree with
  `parseXfaDatasets`'s paths, and the empty merge with no packet and with an
  empty `<xfa:data>`.
- **`xfatemplate`**: N for an empty merge (`initial`, defaulting through
  `min`), for a non-empty merge (counted, raised to `min`, capped at `max`,
  unbounded at `-1`), `min="0"` giving nothing, and each refusal in the table.
  Instance k's fields bind to group k, and a later sibling's index follows the
  instances.
- **Converter**: values bound per instance, and a refused repeating subform's
  fields reported with its reason.
- **pdf.js oracle** (`test/xfa-dynamic-oracle.test.ts`):
  - Page-level placement rises above today's 35 in ALL THREE variants. `pages`
    rises too, because its `Page1` is identical to `published`'s. The new
    counts are pinned exactly, raised in the issue that changes them.
  - Every placed box agrees with pdf.js as today.
  - In `header`, SectionI's rows below `Header` sit exactly 2 × 18pt lower than
    in `published`, and SectionII does not move.
  - In `pages`, `Page2`'s repetition is refused with the 164g.3 reason, and its
    fields are reported rather than placed.
- **Fences**: `test/xfa-real.test.ts` (four hybrids, no `<occur>`) and
  `test/xfa-flow-oracle.test.ts` must pass UNEDITED.
- **Mutation sweep** over each count rule and each refusal. A mutation that
  stays green is recorded, not left to be discovered.

## Out of scope

- The general merge algorithm: scope matching, flat data spread across nested
  repeating subforms (p. 341–342), `match="global"`, `bind ref` on a repeating
  subform.
- `subformSet`, which the walk does not read at all today.
- Page-level repetition and `pageArea`/`pageSet` occurrence (164g.3).
- A table header row repeated on each page by `overflowLeader` (164g.3).
