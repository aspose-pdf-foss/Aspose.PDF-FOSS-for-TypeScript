# XFA: split a field between its lines — Implementation Plan (`164g.13`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ConvertXfaToAcroForm` splits a text-like field straddling a content-area break where Adobe Reader 26.1 does — in a positioned, `tb` or `lr-tb` parent — and writes it as ONE AcroForm field with one widget per piece, each widget showing its own lines.

**Architecture:** A new pure leaf, `src/xfafieldsplit.ts`, owns the cut rules (`fieldCut`) and the piece copy (`pieceOf`). Pagination asks it wherever a field straddles a cut: `xfasplitpos.ts`'s consensus (replacing R4's refusal) and `xfapage.ts`'s flow `straddle` (now for `tb` fields too). A piece is a copy of the field's `LayoutNode` stating its own `h` and carrying `piece: { offset, lines }`; `xfaflow.ts` places it as an ordinary leaf and reports the piece on its `Placed`. The converter collects every placement of a name, and a field placed in several pieces is created by a new internal `createSplitField` (`formcreate.ts`) as one field dict with `/Kids` widgets. A line-count hook (`fieldLines`), built by `xfaFieldLines` over `xfatext.ts`, gives pagination the field value's wrapped line count and the converter each line's text.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-xfa-split-field-design.md` — rules 1-7 and the probe tables are cited by number below. Read it before Task 1.

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins.
- ESM + NodeNext: every relative import ends in `.js`.
- `src/xfafieldsplit.ts` is a pure leaf: it imports `xfaflow.js` TYPES only, never throws, and owns `fontSizeOf` and `ptStr` (moved from `xfasplitpos.ts`, which then imports them — the reverse edge would close a 2-cycle that `test/import-cycles.test.ts` fails).
- `src/xfapage.ts` stays a pure leaf over `xfaflow.js`, `xfageom.js`, `xfasplitpos.js` and `xfafieldsplit.js`.
- No new `catch` blocks; any unavoidable one opens with `rethrowLimit(caught)`.
- A one-piece field keeps today's merged field/widget dict BYTE FOR BYTE (`createField` untouched).
- `npm run typecheck` and `npm test` both green before the issue closes.
- CHANGELOG entries under `## [Unreleased]` in the commit that makes the change visible.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do NOT re-run `scripts/gen-*` or the Reader probe script; t40-t54 are vendored as captured.
- Do NOT re-record any oracle (DD 1494, OPM 1644, hybrids, t3-t39 other than the nine flipped here, q1-q15). A fence going red is investigated and reported.
- `bd` for tracking.

## Review Focus

1. **A field taller than two content areas** — the tail piece straddles the next break and must split again (spec rule 7), with lines continuing from the right offset. Pinned in Task 4's "splits twice" case and Task 2's tail-piece `fieldCut` case.
2. **A refused split in a `tb` parent** (a checkbox, a captioned field) — must MOVE whole as under 164g.8, not be refused, or forms that converted before lose fields. This plan's one deliberate departure from spec rule 6's wording; pinned in Task 4.
3. **A field split whose tail is later refused** (no page left) — the field must be refused whole, never created with one widget. Pinned in Task 5.
4. **A password field split** — each widget's appearance must be masked like the unsplit field's. Pinned in Task 5.
5. **A text field whose cut falls below its text** (t54) — the cut is free there, and the bottom widget shows no text. Pinned by t54 and Task 2.

## Decisions this plan adds (beyond the spec)

- **`piece` carries `{ offset, lines }`, no `index`.** The spec named `index`; the order of pieces is their `offset`, and the line range each widget shows is `lines`, which the spec's converter section needs. Cost if wrong: none (internal type).
- **Rule 6 also refuses a BOTTOM inset.** A piece's widget box with a split inset is unprobed, same as a top inset.
- **In a `tb` parent a refused field moves whole** (Review Focus 2); in positioned and `lr-tb` parents it is refused, as 164g.11/164g.12 already refuse it.
- **A field directly under the content area** (a root child) is not split; it moves whole as today. No probe has one.

---

### Task 1: Vendor probes t40-t54 and file the child issue

The 15 probes exist UNTRACKED as `tN.xml`, `tN.out.pdf`, `tN.out.png` in `test/fixtures/xfa-adobe/`. This task renames, transcribes and records them. They join the oracle loop in Task 6.

**Files:**
- Rename: `test/fixtures/xfa-adobe/tN.out.pdf` → `tN.pdf`, `tN.out.png` → `captures/tN.png`, N = 40..54; add `tN.xml`
- Modify: `test/fixtures/xfa-adobe/adobe.json`, `test/fixtures/xfa-adobe/PROVENANCE.md`

**Interfaces:**
- Produces: `adobe.json` probes `t40`..`t54` in the existing `AdobeProbe` shape (`draws` used by t48).

- [ ] **Step 1: File the child issue**

```bash
bd create "XFA: split a captioned, non-text, inset, vAlign'd, lineHeight or orphans/widows field across a break" \
  --parent aspose-pdf-foss-for-ts-164g --type feature --priority 3 \
  --deps discovered-from:aspose-pdf-foss-for-ts-164g.13 \
  --description "164g.13 splits a text-like field between its lines where Adobe does, and refuses (or in a tb parent moves) a field that would split and is not text-like, is a comb, states a caption, a top or bottom inset, vAlign other than top, a para lineHeight, orphans or widows, or mixes font sizes. Each is unprobed: probe it in Adobe Reader (scripts/gen-xfa-adobe-probes.ts) and split by what Reader shows."
```

Expected: the id printed is most likely `aspose-pdf-foss-for-ts-164g.26`. Wherever this plan writes `164g.26`, use the short form bd printed.

- [ ] **Step 2: Rename the files**

```bash
cd test/fixtures/xfa-adobe
for n in $(seq 40 54); do mv t$n.out.pdf t$n.pdf; mv t$n.out.png captures/t$n.png; done
cd ../../..
git add test/fixtures/xfa-adobe/t4?.xml test/fixtures/xfa-adobe/t5?.xml test/fixtures/xfa-adobe/t4?.pdf test/fixtures/xfa-adobe/t5?.pdf test/fixtures/xfa-adobe/captures/t4?.png test/fixtures/xfa-adobe/captures/t5?.png
git status --short test/fixtures/xfa-adobe | grep -c '^A'
```

Expected: `45` (15 each of xml, pdf, png). These are plain `mv`, not `git mv` — the files were never tracked.

- [ ] **Step 3: Add the goldens**

Write this to the scratchpad as `add-field-probes.mjs`, run it with `node <path>` from the repo root. Every number is read from `captures/tN.png`.

```js
import { readFileSync, writeFileSync } from 'node:fs';
const file = 'test/fixtures/xfa-adobe/adobe.json';
const g = JSON.parse(readFileSync(file, 'utf8'));
const OR = { 'form1.oracle': [[1, 0, 0, 540, 216]] };
const OUT = { 'form1.oracle.out': [[1, 0, 0, 540, 216]] };
const Z = { 'form1.pos.z': [[1, 360, 14.4, 72, 21.6]] };
/** A positioned probe: filler 360, pos at 576 cut at `cut`, field f in two pieces. */
const pos = (cut, f) => ({
  pages: 2, expect: 'match',
  subforms: { ...OR, 'form1.filler': [[1, 0, 216, 540, 360]], 'form1.pos': [[1, 0, 576, 540, cut], [2, 0, 0, 540, 288 - cut]] },
  fields: { ...OUT, ...Z, 'form1.pos.f': f },
});
const F4 = { 'form1.filler': [[1, 0, 216, 540, 400]] };
const p = {
  t40: pos(134, [[1, 0, 98, 144, 36], [2, 0, 0, 144, 12]]),
  t41: pos(134, [[1, 0, 102, 144, 32], [2, 0, 0, 144, 16]]),
  t42: pos(144, [[1, 0, 106, 144, 38], [2, 0, 0, 144, 10]]),
  t43: pos(144, [[1, 0, 108, 144, 36], [2, 0, 0, 144, 12]]),
  t44: pos(124, [[1, 0, 102, 144, 22], [2, 0, 0, 144, 26]]),
  t45: pos(140, [[1, 0, 80, 144, 60], [2, 0, 0, 144, 70]]),
  t46: pos(144, [[1, 0, 84, 144, 60], [2, 0, 0, 144, 70]]),
  t47: {
    pages: 2, expect: 'match',
    subforms: { ...OR, ...F4, 'form1.stack': [[1, 0, 616, 540, 96], [2, 0, 0, 540, 34]] },
    fields: { ...OUT, 'form1.stack.f': [[1, 0, 0, 144, 96], [2, 0, 0, 144, 34]] },
  },
  t48: {
    pages: 2, expect: 'match',
    subforms: { ...OR, ...F4, 'form1.stack': [[2, 0, 0, 540, 130]] },
    fields: { ...OUT },
    draws: { 'form1.filler.d0': [[1, 0, 0, 72, 10]], 'form1.stack.t': [[2, 0, 0, 144, 130]] },
  },
  t49: {
    pages: 2, expect: 'match',
    subforms: { ...OR, ...F4, 'form1.flow': [[1, 0, 616, 540, 96], [2, 0, 0, 540, 94]] },
    fields: {
      ...OUT, 'form1.flow.f1': [[1, 0, 0, 180, 60]], 'form1.flow.f2': [[1, 180, 0, 180, 60]],
      'form1.flow.f3': [[1, 360, 0, 180, 60]], 'form1.flow.f': [[1, 0, 60, 180, 36], [2, 0, 0, 180, 94]],
    },
  },
  t50: pos(140, [[1, 0, 80, 144, 60], [2, 0, 0, 144, 70]]),
  t51: pos(128, [[1, 0, 80, 144, 48], [2, 0, 0, 144, 212]]),
  t52: pos(142, [[1, 0, 130, 144, 12], [2, 0, 0, 144, 118]]),
  t53: pos(142, [[1, 0, 34, 144, 108], [2, 0, 0, 144, 12]]),
  t54: pos(144, [[1, 0, 80, 144, 64], [2, 0, 0, 144, 66]]),
};
for (const [k, v] of Object.entries(p)) g.probes[k] = v;
writeFileSync(file, `${JSON.stringify(g, null, 2)}\n`);
console.log('added', Object.keys(p).join(' '));
```

The `pos` helper's second page fragment height is `288 - cut` because `pos` states `h="4in"` (288pt); Adobe's captures show `2,0,0,540,154` for t40/t41 (288 − 134), `144` for t42/t43/t46/t54, `164` for t44, `148` for t45/t50, `160` for t51, `146` for t52/t53 — the helper reproduces each. Cross-check t44 (`[2,0,0,540,164]`) and t51 (`[2,0,0,540,160]`) by printing them.

Expected: `added t40 … t54`; `git diff --stat test/fixtures/xfa-adobe/adobe.json` shows additions only.

- [ ] **Step 4: Provenance**

Append to `test/fixtures/xfa-adobe/PROVENANCE.md`:

```markdown
## Field splitting probes (164g.13)

**Producer:** as above, 2026-10-15. t40-t46 and t50-t54 hold one field `f` in a
`keep intact="none"` positioned subform cut 144pt below its top; t47 and t48 a
130pt field and draw in a `tb` after a 400pt filler; t49 a text field on an
`lr-tb`'s second line. t40-t44 are EMPTY fields, the rest hold ten one-word
lines (`line 01` ... `line 10`; t54 three) in Courier New, Arial (t50) or 20pt
Courier New (t51). The spec's tables
(`docs/superpowers/specs/2026-10-15-xfa-split-field-design.md`) give each
probe's room and Adobe's pieces.

**What it settled:** a field's lines sit on a `1.2 x font size` grid whatever
the font; inside the text the cut snaps to a whole line, below it the cut is
free; a bottom piece under one font size moves the cut up by exactly one font
size; no orphan or widow control; a field in a `tb` splits (164g.8 moved it),
a draw does not.

**Captures are uncropped** whole Reader windows, as for t27-t39.

**Ceiling:** one producer, one version, hand transcription. Not covered:
captions, insets, `vAlign`, `lineHeight`, orphans/widows, non-text fields and
mixed sizes (164g.26), and how Reader draws a split field's text.

| File | SHA-256 |
|---|---|
```

then one row per file from `sha256sum test/fixtures/xfa-adobe/t{40..54}.pdf`, each cell holding the hash itself:

```bash
for n in $(seq 40 54); do h=$(sha256sum test/fixtures/xfa-adobe/t$n.pdf | cut -d' ' -f1); echo "| \`t$n.pdf\` | \`$h\` |" >> test/fixtures/xfa-adobe/PROVENANCE.md; done
```

- [ ] **Step 5: Check the JSON loads and commit**

Run: `node -e "const g=require('./test/fixtures/xfa-adobe/adobe.json');for(let n=40;n<=54;n++)if(!g.probes['t'+n])throw 't'+n;console.log('ok')"`
Expected: `ok`.

```bash
git add test/fixtures/xfa-adobe
git commit -m "test(164g.13): vendor Adobe probes t40-t54 for field splitting

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `xfafieldsplit.ts` — the cut rules and the piece

**Files:**
- Create: `src/xfafieldsplit.ts`, `test/xfafieldsplit.test.ts`
- Modify: `src/xfaflow.ts` (LayoutNode fields, `XfaPiece`, `Placed`, `emit`)
- Modify: `src/xfatemplate.ts` (`nodeOf`: `ui`, `comb`, `lineKeep`)
- Modify: `src/xfasplitpos.ts`, `src/xfapage.ts` (import `fontSizeOf`/`ptStr` from the new module)
- Modify: `test/xfatemplate-chrome.test.ts` (one case for the new node fields)

**Interfaces:**
- Produces (xfaflow): `interface XfaPiece { offset: number; lines: [number, number] }`; `LayoutNode.ui?: string; comb?: true; lineKeep?: true; piece?: XfaPiece`; `Placed = { box: XfaBox; piece?: XfaPiece } | { reason: string }`.
- Produces (xfafieldsplit):
  ```ts
  export const LINE_PITCH = 1.2;
  export const ptStr: (v: number) => string;
  export const fontSizeOf: (f: LayoutNode) => number;
  export type FieldCut = { cut: number } | 'move' | { refusal: string };
  export function fieldCut(n: LayoutNode, room: number, lines: number | undefined, h: number): FieldCut;
  export function pieceOf(n: LayoutNode, off: number, h: number): LayoutNode;
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/xfafieldsplit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fieldCut, pieceOf, fontSizeOf } from '../src/xfafieldsplit.js';
import type { LayoutNode } from '../src/xfaflow.js';
import type { LeafText } from '../src/xfarich.js';

/** A text field of height `h`, font `size`, with `extra` on its node or text. */
const fld = (h: number, size = 10, extra: Partial<LayoutNode> = {}, text: Partial<LeafText> = {}): LayoutNode => ({
  kind: 'field', label: 'f', field: 'f', ui: 'textEdit', geom: { w: '144pt', h: `${String(h)}pt` }, children: [],
  text: {
    kind: 'text', paras: [{ runs: [], base: { family: ['Courier New'], size, bold: false, italic: false },
      marginLeft: 0, marginRight: 0, textIndent: 0, lineHeight: 0, spaceAbove: 0, spaceBelow: 0 }],
    insets: { l: 0, r: 0, t: 0, b: 0 }, password: false, picture: false, ...text,
  } as LeafText,
  ...extra,
});

describe('fieldCut: an empty field (spec rules 3, 4)', () => {
  it('cuts at the room left once the top piece reaches the font size (t9, t10, t11, t20)', () => {
    expect(fieldCut(fld(48), 11, 0, 48)).toEqual({ cut: 11 });
    expect(fieldCut(fld(48), 12, 0, 48)).toEqual({ cut: 12 });
    expect(fieldCut(fld(48), 24, 0, 48)).toEqual({ cut: 24 });
    expect(fieldCut(fld(48), 10, 0, 48)).toEqual({ cut: 10 });
  });
  it('moves the field when the top piece is below the font size (t8, t19, t22)', () => {
    expect(fieldCut(fld(48), 9, 0, 48)).toBe('move');
  });
  it('accepts a bottom piece of exactly the font size (t42)', () => {
    expect(fieldCut(fld(48), 38, 0, 48)).toEqual({ cut: 38 });
  });
  it('moves the cut up by exactly one font size when the bottom is smaller (t21, t40, t41)', () => {
    expect(fieldCut(fld(46), 40, 0, 46)).toEqual({ cut: 30 });
    expect(fieldCut(fld(48), 46, 0, 48)).toEqual({ cut: 36 });   // not 38: "by", not "to"
    expect(fieldCut(fld(48), 42, 0, 48)).toEqual({ cut: 32 });
  });
  it('scales the floor with the font size (t44)', () => {
    expect(fieldCut(fld(48, 20), 42, 0, 48)).toEqual({ cut: 22 });
  });
  it('moves the field when the floor leaves less than one font size on top', () => {
    expect(fieldCut(fld(20), 15, 0, 20)).toBe('move');
  });
});

describe('fieldCut: a field with text (spec rules 1, 2)', () => {
  it('snaps to the last whole line on a 1.2 x size grid (t45, t46, t50)', () => {
    expect(fieldCut(fld(130), 64, 10, 130)).toEqual({ cut: 60 });
    expect(fieldCut(fld(130), 60, 10, 130)).toEqual({ cut: 60 });
  });
  it('uses the grid at 20pt too (t51)', () => {
    expect(fieldCut(fld(260, 20), 64, 10, 260)).toEqual({ cut: 48 });
  });
  it('keeps one line on top: no orphan control (t52)', () => {
    expect(fieldCut(fld(130), 14, 10, 130)).toEqual({ cut: 12 });
  });
  it('carries one line alone: no widow control (t53)', () => {
    expect(fieldCut(fld(120), 110, 10, 120)).toEqual({ cut: 108 });
  });
  it('cuts freely below the text (t54)', () => {
    expect(fieldCut(fld(130), 64, 3, 130)).toEqual({ cut: 64 });
  });
  it('moves the field when no whole line fits', () => {
    expect(fieldCut(fld(130, 10), 11, 10, 130)).toBe('move');
  });
  it('snaps a tail piece on the FIELD\'s grid, from its offset (rule 7)', () => {
    const tail = pieceOf(fld(130), 60, 70);
    expect(fieldCut(tail, 30, 10, 70)).toEqual({ cut: 24 });     // lines 6-7: offset 60 + 24 = 84 = 7 x 12
  });
  it('refuses a field whose line count is unknown', () => {
    expect(fieldCut(fld(130), 64, undefined, 130)).toEqual({ refusal: expect.stringMatching(/^f: its value's wrapped line count is not known/) as unknown as string });
  });
});

describe('fieldCut: rule 6, refused by name (164g.26)', () => {
  const refused = (n: LayoutNode): string => {
    const r = fieldCut(n, 30, 0, 48);
    return typeof r === 'object' && 'refusal' in r ? r.refusal : '';
  };
  it.each([
    ['a checkButton', fld(48, 10, { ui: 'checkButton' }), /a <checkButton> field/],
    ['a comb', fld(48, 10, { comb: true }), /a comb field/],
    ['a caption', fld(48, 10, {}, { caption: { placement: 'left', reserve: 20 } }), /a captioned field/],
    ['a top inset', fld(48, 10, {}, { insets: { l: 0, r: 0, t: 2, b: 0 } }), /a top or bottom inset/],
    ['a bottom inset', fld(48, 10, {}, { insets: { l: 0, r: 0, t: 0, b: 2 } }), /a top or bottom inset/],
    ['vAlign', fld(48, 10, {}, { vAlign: 'middle' }), /vAlign="middle"/],
    ['orphans/widows', fld(48, 10, { lineKeep: true }), /orphans or widows/],
  ])('refuses %s', (_w, n, re) => {
    expect(refused(n)).toMatch(re);
    expect(refused(n)).toMatch(/\(164g\.26\)$/);
  });
  it('refuses a stated lineHeight and mixed sizes', () => {
    const lh = fld(48);
    lh.text!.paras[0].lineHeight = 14;
    expect(refused(lh)).toMatch(/a stated lineHeight/);
    const mixed = fld(48);
    mixed.text!.paras[0].runs = [{ text: 'a', family: ['Courier New'], size: 14, bold: false, italic: false }];
    expect(refused(mixed)).toMatch(/mixed font sizes/);
  });
  it('lets a field that would move anyway move, whatever it states', () => {
    expect(fieldCut(fld(48, 10, { ui: 'checkButton' }), 5, 0, 48)).toBe('move');
  });
  it('accepts left and right insets', () => {
    expect(fieldCut(fld(48, 10, {}, { insets: { l: 3, r: 3, t: 0, b: 0 } }), 30, 0, 48)).toEqual({ cut: 30 });
  });
});

describe('pieceOf', () => {
  it('states the piece height, drops min/max, and records offset and line range', () => {
    const n = fld(130, 10, { minMax: { minH: '10pt' } });
    const head = pieceOf(n, 0, 60);
    expect(head.geom.h).toBe('60pt');
    expect(head.minMax).toBeUndefined();
    expect(head.piece).toEqual({ offset: 0, lines: [0, 5] });
    const tail = pieceOf(n, 60, 70);
    expect(tail.piece).toEqual({ offset: 60, lines: [5, 11] });
  });
  it('composes offsets for a piece of a piece', () => {
    expect(pieceOf(pieceOf(fld(200), 60, 140), 24, 116).piece).toEqual({ offset: 84, lines: [7, 17] });
  });
  it('keeps the field name, so every piece places under one SOM name', () => {
    expect(pieceOf(fld(48), 0, 20).field).toBe('f');
  });
});

describe('fontSizeOf', () => {
  it('reads the base size, else XFA\'s 10pt default', () => {
    expect(fontSizeOf(fld(48, 14))).toBe(14);
    expect(fontSizeOf({ kind: 'field', label: 'x', geom: {}, children: [] })).toBe(10);
  });
});
```

Add to `test/xfatemplate-chrome.test.ts` (inside its describe):

```ts
  it("records a field's ui, comb and orphans/widows for splitting (164g.13)", () => {
    const t = tpl(`<field name="a" w="1in" h="1in"><ui><textEdit><comb numberOfCells="4"/></textEdit></ui></field>
      <field name="b" w="1in" h="1in"><para orphans="2"/><ui><checkButton/></ui></field>
      <field name="c" w="1in" h="1in"><ui><textEdit/></ui></field>`);
    const at = (l: string) => find(t.body!.root, (n) => n.label === l)!;
    expect([at('a[0]').ui, at('a[0]').comb, at('a[0]').lineKeep]).toEqual(['textEdit', true, undefined]);
    expect([at('b[0]').ui, at('b[0]').comb, at('b[0]').lineKeep]).toEqual(['checkButton', undefined, true]);
    expect([at('c[0]').ui, at('c[0]').comb, at('c[0]').lineKeep]).toEqual(['textEdit', undefined, undefined]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/xfafieldsplit.test.ts test/xfatemplate-chrome.test.ts`
Expected: FAIL — `xfafieldsplit.js` does not exist; the template case fails on `ui` undefined.

- [ ] **Step 3: Add the node fields in `xfaflow.ts`**

Beside `export type Placed`:

```ts
/** One piece of a field Adobe splits across content areas (164g.13): how far
 *  down the whole field the piece starts, and which of the value's wrapped
 *  lines [from, to) fall inside it on the `1.2 x size` grid. */
export interface XfaPiece { offset: number; lines: [number, number] }

export type Placed = { box: XfaBox; piece?: XfaPiece } | { reason: string };
```

(replacing the existing `Placed` line). In `interface LayoutNode`, after `text?: LeafText;`:

```ts
  /** A field's `<ui>` child name, its `<comb>` and whether its `<para>` states
   *  orphans or widows (164g.13): read only to decide whether it may split. */
  ui?: string;
  comb?: true;
  lineKeep?: true;
  /** One piece of a field split across content areas (164g.13). */
  piece?: XfaPiece;
```

In `emit`, replace `if (n.field !== undefined) this.put(out, n.field, { box });` with:

```ts
      if (n.field !== undefined) this.put(out, n.field, n.piece ? { box, piece: n.piece } : { box });
```

- [ ] **Step 4: Populate them in `xfatemplate.ts`'s `nodeOf`**

After `if (kind === 'field' || kind === 'draw') n.text = leafText(el);` add:

```ts
  if (kind === 'field') {
    const ui = child(el, 'ui')?.children[0];
    if (ui) {
      n.ui = ui.name;
      if (child(ui, 'comb')) n.comb = true;
    }
    const para = child(el, 'para');
    if (para && ['orphans', 'widows'].some((a) => Number(para.attrs.get(a) ?? '0') !== 0)) n.lineKeep = true;
  }
```

- [ ] **Step 5: Create `src/xfafieldsplit.ts`**

```ts
// src/xfafieldsplit.ts
/**
 * Splitting an XFA field between its lines across content areas (`164g.13`):
 * where Adobe Reader 26.1 cuts a field that straddles a break, and the piece
 * either side. Measured by probe (`test/fixtures/xfa-adobe/`, t6, t9-t11, t20,
 * t21, t27, t28, t31, t40-t54; spec
 * `docs/superpowers/specs/2026-10-15-xfa-split-field-design.md`).
 *
 * **Invariant: a pure leaf over `xfaflow.js` TYPES.** It never
 * throws: a field it cannot split is a named refusal, and the caller decides
 * what a refusal means in its parent.
 *
 * **Invariant: lines sit on a `1.2 x font size` grid from the field's top,
 * whatever the face (t45 Courier New and t50 Arial both 12pt at 10pt; t51 24pt
 * at 20pt).** Our own measured line height (hhea, 164g.7) is NOT that grid.
 */
import type { LayoutNode } from './xfaflow.js';

const EPS = 1e-6;
/** Adobe's line pitch, as a multiple of the font size (t45, t50, t51). */
export const LINE_PITCH = 1.2;

/** A measurement written back into `geom`: snapped to 0 within EPS and never
 *  in exponent notation, which `measureToPt` cannot read -- mm templates leave
 *  residues like -2.8e-14 where a child sits on the cut. */
export const ptStr = (v: number): string => `${String(Math.abs(v) < EPS ? 0 : Number(v.toFixed(6)))}pt`;
/** A field's font size: its base run's (`leafText`), XFA's 10pt default otherwise. */
export const fontSizeOf = (f: LayoutNode): number => f.text?.paras[0]?.base.size ?? 10;

const TEXT_UI: ReadonlySet<string> = new Set(['textEdit', 'numericEdit', 'dateTimeEdit', 'passwordEdit']);

export type FieldCut = { cut: number } | 'move' | { refusal: string };

/** Spec rule 6: what about this field no probe shows Adobe splitting. */
function splitRefusal(n: LayoutNode): string | undefined {
  const t = n.text;
  const fs = fontSizeOf(n);
  let what: string | undefined;
  if (n.ui !== undefined && !TEXT_UI.has(n.ui)) what = `a <${n.ui}> field`;
  else if (n.comb) what = 'a comb field';
  else if (t?.caption) what = 'a captioned field';
  else if ((t?.insets?.t ?? 0) !== 0 || (t?.insets?.b ?? 0) !== 0) what = 'a field with a top or bottom inset';
  else if (t?.vAlign) what = `a field stating vAlign="${t.vAlign}"`;
  else if (t?.paras?.some((p) => p.lineHeight)) what = 'a field with a stated lineHeight';
  else if (n.lineKeep) what = 'a field stating orphans or widows';
  else if (t?.paras?.some((p) => p.base.size !== fs || (p.runs ?? []).some((r) => r.size !== fs)))
    what = 'a field with mixed font sizes';
  return what === undefined ? undefined
    : `${n.label}: ${what} would split across a content-area break, which is not implemented (164g.26)`;
}

/**
 * Where a field of height `h` straddling a break splits, with `room` left above
 * the break from the piece's top, and `lines` the wrapped line count of its
 * value (0 when empty; undefined when it could not be counted).
 *
 * Rule 3: the cut is the room once the top piece reaches the font size (t9).
 * Rule 2: inside the text it snaps down to a whole line, at least one (t45, t52;
 * no orphan or widow control, t52, t53). Rule 4: a bottom piece under one font
 * size moves the cut up by EXACTLY one font size (t21, t40, t41, t44), snapping
 * again inside the text. A piece's grid is the FIELD's, from its `offset`.
 */
export function fieldCut(n: LayoutNode, room: number, lines: number | undefined, h: number): FieldCut {
  const fs = fontSizeOf(n);
  if (room < fs - EPS) return 'move';
  const why = splitRefusal(n);
  if (why !== undefined) return { refusal: why };
  if (lines === undefined)
    return { refusal: `${n.label}: its value's wrapped line count is not known, so where it splits is not known` };
  const pitch = LINE_PITCH * fs;
  const off = n.piece?.offset ?? 0;
  const textEnd = lines * pitch - off;
  const snap = (c: number): number =>
    (c < textEnd - EPS ? Math.floor((off + c) / pitch + EPS) * pitch - off : c);
  let c = snap(room);
  if (h - c < fs - EPS) c = snap(c - fs);
  if (c < fs - EPS || c >= h - EPS) return 'move';
  return { cut: c };
}

/** The part of field `n` from `off` down, `h` tall: a copy stating that `h`,
 *  its `minMax` dropped, carrying the offset from the WHOLE field's top and the
 *  lines it holds on the grid. A piece of a piece composes offsets. */
export function pieceOf(n: LayoutNode, off: number, h: number): LayoutNode {
  const offset = (n.piece?.offset ?? 0) + off;
  const pitch = LINE_PITCH * fontSizeOf(n);
  const lines: [number, number] = [Math.round(offset / pitch), Math.round((offset + h) / pitch)];
  const { minMax: _stated, ...rest } = n;
  void _stated;
  return { ...rest, geom: { ...n.geom, h: ptStr(h) }, piece: { offset, lines } };
}
```

Then move the two helpers out of `xfasplitpos.ts`: delete its `const ptStr`, `const fontSizeOf` and `fieldSplitRefusal` definitions, and import `{ fontSizeOf, ptStr }` from `./xfafieldsplit.js` there. In `xfapage.ts`, change the `xfasplitpos.js` import to drop `fontSizeOf`, `ptStr` and `fieldSplitRefusal`, and add:

```ts
import { fieldCut, fontSizeOf, pieceOf, ptStr } from './xfafieldsplit.js';
```

`xfasplitpos.ts`'s R4 branch still calls `fieldSplitRefusal` until Task 3; keep it compiling by leaving R4's return as an inline string for now:

```ts
        return { refusal: `${k.node.label}: Adobe splits a field straddling a content-area break between its lines, which is not implemented (164g.13)` };
```

and `xfapage.ts`'s `straddle` field line likewise until Task 4:

```ts
  if (n.kind === 'field') return piece >= fontSizeOf(n) - EPS
    ? `${n.label}: Adobe splits a field straddling a content-area break between its lines, which is not implemented (164g.13)` : undefined;
```

(`fieldCut` and `pieceOf` are imported but unused in `xfapage.ts` until Task 4; the tsconfigs do not set `noUnusedLocals`.)

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/xfafieldsplit.test.ts test/xfatemplate-chrome.test.ts test/xfasplitpos.test.ts test/xfapage.test.ts test/import-cycles.test.ts`
Expected: PASS. Then `npm run typecheck` clean.

- [ ] **Step 7: Commit**

```bash
git add src/xfafieldsplit.ts src/xfaflow.ts src/xfatemplate.ts src/xfasplitpos.ts src/xfapage.ts test/xfafieldsplit.test.ts test/xfatemplate-chrome.test.ts
git commit -m "feat(164g.13): where Adobe cuts a field, and the piece either side

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Split a field in a positioned subform

**Files:**
- Modify: `src/xfasplitpos.ts` (`positionedCut` gains `lines`; R4 → `fieldCut`; `positionedFragment` emits pieces)
- Modify: `src/xfapage.ts` (`placePositioned` passes `hooks.fieldLines`; `XfaPaginateHooks.fieldLines`)
- Modify: `test/xfasplitpos.test.ts`, `test/xfapage.test.ts`

**Interfaces:**
- Consumes: `fieldCut`, `pieceOf`, `ptStr` (Task 2).
- Produces: `positionedCut(n, room, boxes, lines?: (n: LayoutNode) => number | undefined)`; `XfaPaginateHooks.fieldLines?: (n: LayoutNode) => number | undefined`.

- [ ] **Step 1: Rewrite the R4 tests**

In `test/xfasplitpos.test.ts`, replace the case `'refuses a field whose top piece reaches its font size (t20, t6), naming 164g.13'` with:

```ts
  const none = (): number => 0;
  it('cuts through a field whose top piece reaches its font size (t20, t6)', () => {
    expect(positionedCut(pos('p', 288, [fld('f', 134, 48)]), 144, boxes, none)).toBe(144);   // t20: 10/38
    expect(positionedCut(pos('p', 288, [fld('b', 108, 72)]), 144, boxes, none)).toBe(144);   // t6: 36/36
  });
  it('moves the cut by the field\'s bottom floor (t21)', () => {
    expect(positionedCut(pos('p', 288, [fld('f', 104, 46)]), 144, boxes, none)).toBe(134);
  });
  it('refuses a straddling field when its line count is unknown', () => {
    expect(positionedCut(pos('p', 288, [fld('f', 134, 48)]), 144, boxes))
      .toEqual({ refusal: expect.stringMatching(/^f: its value's wrapped line count is not known/) as unknown as string });
  });
```

and add to the `positionedFragment` describe block:

```ts
  it('puts a piece of a field crossing the cut in each fragment (t20)', () => {
    const p = pos('p', 288, [fld('f', 134, 48)]);
    const head = positionedFragment(p, 0, 144, boxes) as LayoutNode;
    const tail = positionedFragment(p, 144, 288, boxes) as LayoutNode;
    expect([head.children[0].geom.y, head.children[0].geom.h, head.children[0].piece?.offset]).toEqual(['134pt', '10pt', 0]);
    expect([tail.children[0].geom.y, tail.children[0].geom.h, tail.children[0].piece?.offset]).toEqual(['0pt', '38pt', 10]);
  });
```

In `test/xfapage.test.ts`, replace the case `'refuses a split it cannot make and places nothing of it (t6)'` with:

```ts
  it('splits a field it can split, one piece per fragment (t6)', () => {
    const p = P(288, [fld('a', 36, 21.6), fld('b', 108, 72)]);
    const b = body([area([ca(720)])], [...lead, p, kid('Z', 10)]);
    const r = paginate(b, posHeight, { boxes: posBoxes, fieldLines: () => 0 });
    expect(r.refused.size).toBe(0);
    expect(r.pages.map((pg) => pg.contentAreas[0].children
      .map((k) => (k.label === 'P' ? `P:${k.geom.h ?? ''}(${k.children.map((x) => `${x.label}@${x.geom.y ?? ''}/${x.geom.h ?? ''}`).join(',')})` : k.label))
      .join(' '))).toEqual(['O F P:144pt(a@36pt/21.6pt,b@108pt/36pt)', 'P:144pt(b@0pt/36pt) Z']);
  });
  it('refuses a field split it cannot count the lines of, placing nothing of the subform', () => {
    const p = P(288, [fld('a', 36, 21.6), fld('b', 108, 72)]);
    const r = run([...lead, p, kid('Z', 10)]);
    expect(r.refused.get(p)).toMatch(/^b: its value's wrapped line count is not known/);
    expect(r.pages.map((pg) => pg.contentAreas[0].children.map((k) => k.label).join(' '))).toEqual(['O F']);
  });
```

(`fld` in that describe block takes `(label, y, h)`; check its signature at the top of the 164g.11 describe and adapt the call if it differs.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/xfasplitpos.test.ts test/xfapage.test.ts`
Expected: FAIL — `positionedCut` ignores a 4th argument and still refuses; `fieldLines` is not a hook.

- [ ] **Step 3: Implement in `xfasplitpos.ts`**

Change the signature and the R4 branch of `positionedCut`:

```ts
export function positionedCut(
  n: LayoutNode, room: number, boxes: XfaChildBoxes, lines?: (n: LayoutNode) => number | undefined,
): number | { refusal: string } {
```

pass `lines` through the recursive call (`positionedCut(k.node, cut - k.top, boxes, lines)`), and replace

```ts
      } else if (k.node.kind === 'field' && cut - k.top >= fontSizeOf(k.node) - EPS) {
        // R4 ...
        return { refusal: ... };
      }
```

with

```ts
      } else if (k.node.kind === 'field') {
        // R4 (t6, t9-t11, t20, t21; 164g.13): Adobe splits a straddling field
        // where fieldCut says; one it would move moves the cut to its top (R2).
        const fc = fieldCut(k.node, cut - k.top, lines?.(k.node), k.h);
        if (typeof fc === 'object' && 'refusal' in fc) return { refusal: fc.refusal };
        if (fc !== 'move') next = k.top + fc.cut;
      }
```

(adding `fieldCut` to the `./xfafieldsplit.js` import). The surrounding loop then moves the cut to `next` when it is higher, and re-checks; `fieldCut` is idempotent on its own cut, so the loop ends.

In `positionedFragment`, before the final `else if (k.top >= from - EPS && k.top < to - EPS)` branch, add:

```ts
    } else if (c.kind === 'field' && k.top < to - EPS && bottom > from + EPS
      && (k.top < from - EPS || bottom > to + EPS)) {
      // 164g.13: a field the cut runs through is in both fragments, as pieces.
      const a = Math.max(k.top, from);
      const b = Math.min(bottom, to);
      const piece = pieceOf(c, a - k.top, b - a);
      children.push({ ...piece, geom: { ...piece.geom, y: ptStr(a - from) } });
```

(adding `pieceOf` to the import).

- [ ] **Step 4: Thread the hook through `xfapage.ts`**

Add to `XfaPaginateHooks`:

```ts
  /** A field value's wrapped line count, 0 when empty (164g.13). Without it a
   *  straddling field whose value is not known empty is refused. */
  fieldLines?: (n: LayoutNode) => number | undefined;
```

In `placePositioned`, change its signature to take the hooks and pass the line hook:

```ts
function placePositioned(p: Paginator, c: LayoutNode, h: number, boxes: XfaChildBoxes, lines?: (n: LayoutNode) => number | undefined): 'whole' | string | undefined {
```

with `const cut = positionedCut(cur, room, boxes, lines);`, and in `paginateOnce`: `placePositioned(p, c, r.h, hooks.boxes, hooks.fieldLines)`.

In `layoutHooks`, change the signature to `layoutHooks(measure?: XfaMeasure, lines?: (n: LayoutNode) => number | undefined)` and add to the returned object:

```ts
    // Without a counter, only a field whose template value is empty is known.
    fieldLines: lines ?? ((n) => (n.text && n.text.refusal === undefined
      && n.text.paras.every((q) => q.runs.every((r) => r.text === '')) ? 0 : undefined)),
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/xfasplitpos.test.ts test/xfapage.test.ts test/xfapage-hooks.test.ts test/xfaflow.test.ts`
Expected: PASS. `npm run typecheck` clean.

- [ ] **Step 6: Commit**

```bash
git add src/xfasplitpos.ts src/xfapage.ts test/xfasplitpos.test.ts test/xfapage.test.ts
git commit -m "feat(164g.13): split a straddling field in a positioned subform

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Split a field in a `tb` or `lr-tb` flow

**Files:**
- Modify: `src/xfapage.ts` (`straddle`, `placeSplit`)
- Modify: `test/xfapage.test.ts`

**Interfaces:**
- Consumes: `fieldCut`, `pieceOf`, `XfaPaginateHooks.fieldLines`.
- Produces: `straddle(...)` returns `string | undefined | { head: LayoutNode; tail: LayoutNode }`.

- [ ] **Step 1: Write the failing tests**

In `test/xfapage.test.ts`, give `fldN` an empty text so the default line hook counts it as 0 lines — replace the `fldN` helper with:

```ts
const EMPTY_TEXT = {
  kind: 'text', paras: [{ runs: [], base: { family: ['Courier'], size: 10, bold: false, italic: false },
    marginLeft: 0, marginRight: 0, textIndent: 0, lineHeight: 0, spaceAbove: 0, spaceBelow: 0 }],
  insets: { l: 0, r: 0, t: 0, b: 0 }, password: false, picture: false,
} as unknown as LeafText;
const fldN = (label: string, w: number, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'field', label, field: label, ui: 'textEdit', geom: { w: `${String(w)}pt`, h: `${String(h)}pt` }, children: [], text: EMPTY_TEXT, ...extra });
```

Replace the 164g.12 case `'refuses a straddling field whose piece reaches its font size, and moves one whose piece does not'` with:

```ts
  // t27, t28, t31 against t35: Adobe splits a straddling field once its piece
  // above the cut reaches its font size (164g.13), and moves it otherwise.
  it('splits a straddling field whose piece reaches its font size, and moves one whose piece does not', () => {
    const fields = () => ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((n) => fldN(n, 100, 30));
    const b = body([area([ca(100)])], [kid('A', 50), lrtb('L', fields())]);
    expect(realSplit(b)).toEqual(['0:A,L(f1,f2,f3,f4)', '0:L(f4,f5,f6)']);
    const r = layoutPages(b);
    expect(r.pages[0].placed.get('f4')).toMatchObject({ box: { h: 20 }, piece: { offset: 0 } });
    expect(r.pages[1].placed.get('f4')).toMatchObject({ box: { h: 10, x: 0, y: 0 }, piece: { offset: 20 } });
    // A 62: room 38, f4's piece 8 < 10 -> it moves.
    expect(realSplit(body([area([ca(100)])], [kid('A', 62), lrtb('L', fields())])))
      .toEqual(['0:A,L(f1,f2,f3)', '0:L(f4,f5,f6)']);
  });
```

and add, in the same 164g.12 describe block:

```ts
  // t47: a field in a tb splits too; t48: a draw there still moves.
  it('splits a field in a tb, and moves a draw', () => {
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), tb('T', [fldN('f', 100, 80)])])))
      .toEqual(['0:A,T(f)', '0:T(f)']);
    const r = layoutPages(body([area([ca(100)])], [kid('A', 50), tb('T', [fldN('f', 100, 80)])]));
    expect([r.pages[0].placed.get('f'), r.pages[1].placed.get('f')])
      .toMatchObject([{ box: { h: 50 } }, { box: { h: 30 } }]);
    expect(realSplit(body([area([ca(100)])], [kid('A', 50), tb('T', [drwN('d', 100, 80)])])))
      .toEqual(['0:A', '0:T(d)']);
  });

  // Rule 7: a field taller than two content areas splits again.
  it('splits a field twice', () => {
    const r = layoutPages(body([area([ca(100)])], [kid('A', 50), tb('T', [fldN('f', 100, 230)])]));
    expect(r.pages.map((p) => (p.placed.get('f') as { box: { h: number } }).box.h)).toEqual([50, 100, 80]);
  });

  // Review Focus 2: in a tb a field the rules refuse moves whole, as under 164g.8.
  it('moves, rather than refuses, a field in a tb that would split and may not', () => {
    const box = fldN('c', 100, 80, { ui: 'checkButton' });
    const b = body([area([ca(100)])], [kid('A', 50), tb('T', [box])]);
    expect(realSplit(b)).toEqual(['0:A', '0:T(c)']);
    expect(realRefusals(b)).toEqual([]);
  });

  it('refuses, in an lr-tb, a field that would split and may not, naming 164g.26', () => {
    const f = fldN('f4', 100, 30, { ui: 'checkButton' });
    const r = realRefusals(body([area([ca(100)])], [kid('A', 50), lrtb('L', [...draws(3), f])]));
    expect(r[0]).toEqual(['f4', expect.stringMatching(/^f4: a <checkButton> field would split .*\(164g\.26\)$/) as unknown as string]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/xfapage.test.ts`
Expected: FAIL — f4 is refused (164g.13), and `tb` fields move whole.

- [ ] **Step 3: Rewrite `straddle`**

Replace `straddle` in `src/xfapage.ts` with:

```ts
/** Rule 7 of 164g.12, widened by 164g.13: what a leaf that does not fit does
 *  instead of moving. A field in a `tb` or `lr-tb` splits where `fieldCut` says
 *  (t27, t28, t31, t47, t49) -- in a `tb`, a field the rules refuse MOVES, as
 *  under 164g.8, so no form that converted before loses it. In an `lr-tb` a
 *  draw moves (t37, t38), a refused field is refused, and a splittable subform
 *  item is refused (164g.25). A table row and a `tb` draw always move (t29, t48).
 *  The room for the leaf is the region's room less its top in the candidate
 *  fragment and the bottom margins around it. */
function straddle(
  l: Leaf, cand: LayoutNode, room: number, hooks: XfaPaginateHooks, height: XfaHeight,
): string | undefined | { head: LayoutNode; tail: LayoutNode } {
  const lay = l.path[l.path.length - 1].layout;
  const n = l.node;
  if ((lay !== 'lr-tb' && lay !== 'tb') || !hooks.topOf) return undefined;
  if (lay === 'tb' && n.kind !== 'field') return undefined;
  const top = hooks.topOf(cand, n);
  if (top === undefined) return undefined;
  let bottoms = 0;
  for (const c of l.path) {
    const m = insetsOf(c);
    if (!('reason' in m)) bottoms += m.b;
  }
  const piece = room - top - bottoms;
  if (piece <= EPS) return undefined;
  if (n.kind === 'field') {
    const hh = height(n, Infinity);
    if ('reason' in hh) return undefined;
    const fc = fieldCut(n, piece, hooks.fieldLines?.(n), hh.h);
    if (fc === 'move') return undefined;
    if ('refusal' in fc) return lay === 'tb' ? undefined : fc.refusal;
    return { head: pieceOf(n, 0, fc.cut), tail: pieceOf(n, fc.cut, hh.h - fc.cut) };
  }
  if (splittable(n))
    return `${n.label}: an lr-tb item that is itself a splittable subform is not split across content areas (164g.25)`;
  return undefined;
}
```

- [ ] **Step 4: Rewrite the retry loop in `placeSplit`**

Inside `for (const [j, l] of leaves.entries())`, after the hidden-leaf branch and the `brks` block, rename the loop variable to a mutable `cur` and replace the `for (;;)` loop body with:

```ts
    let cur = l;
    for (;;) {
      const cap = p.capacity();
      const cand = [...region, ...pending, cur];
      const f = fragmentOf(cand, widths);
      const r = height(f, Infinity);
      if ('reason' in r) return failFrom(j, r.reason);
      const fresh = !hasVisible(region);
      let take = p.used + r.h <= cap + EPS;
      let split: { head: LayoutNode; tail: LayoutNode } | undefined;
      if (!take) {
        const s = straddle(cur, f, cap - p.used, hooks, height);
        if (typeof s === 'object') split = s;
        else if (s !== undefined && !(fresh && p.used === 0)) return failFrom(j, s);
        if (!split && fresh && p.used === 0) {
          const past = (): boolean => { const q = height(f, cap); return 'reason' in q ? true : q.past; };
          const e = emptyRegion(p, r.h, past, cur.node.label);
          if ('reason' in e) return failFrom(j, e.reason);
          take = e.act === 'place';
        }
      }
      if (split) {
        // 164g.13: the head piece closes this region, the tail is the leaf retried.
        const headCand = [...region, ...pending, { ...cur, node: split.head }];
        const q = height(fragmentOf(headCand, widths), Infinity);
        if (!('reason' in q) && p.used + q.h <= cap + EPS) {
          const why = continues(cur);
          if (why !== undefined) return failFrom(j, why);
          region = headCand;
          regionH = q.h;
          pending = [];
          cur = { node: split.tail, path: cur.path, brks: [] };
        }
      } else if (take) {
        const why = continues(cur);
        if (why !== undefined) return failFrom(j, why);
        region = cand;
        regionH = r.h;
        pending = [];
        break;
      }
      flush();
      const moved = p.advance();
      if (moved !== undefined) return failFrom(j, moved);
    }
```

Keep every other part of `placeSplit` as it is. A string from `straddle` in an EMPTY region is ignored in favour of the p. 295 rule, as before 164g.13 — an over-tall `lr-tb` item there was never a straddle refusal.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/xfapage.test.ts test/xfapage-hooks.test.ts test/xfasplitpos.test.ts test/xfaflow.test.ts`
Expected: PASS. If `'splits a field twice'` gives `[50, 100, 80]` reversed or short, check that the tail `cur` keeps the field's `path` (it does above) and that `fieldCut` on a tail uses its `offset` (Task 2).

Then run the fences that this changes the layout under: `npx vitest run test/xfa-master-oracle.test.ts test/xfa-dynamic-oracle.test.ts test/xfa-real.test.ts`
Expected: PASS. If DD 1494 or OPM 1644 moves, stop: pdf.js never splits a field, so a `tb` field we now split where pdf.js moved it is a disagreement between the two oracles, and which wins is the user's decision. Report the field, the page and both boxes.

- [ ] **Step 6: Commit**

```bash
git add src/xfapage.ts test/xfapage.test.ts
git commit -m "feat(164g.13): split a straddling field in a tb or lr-tb flow

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Converter — one field, one widget per piece

**Files:**
- Modify: `src/xfapage.ts` (`layoutPages` takes `lines`)
- Modify: `src/xfaconvert.ts` (`xfaFieldLines`, `where` lists, `geometryFor`, `PlanEntry.pieces`, `applyPositioned`)
- Modify: `src/formcreate.ts` (`createSplitField`)
- Create: `test/xfaconvert-split-field.test.ts`

**Interfaces:**
- Consumes: `XfaPiece` on `Placed`; `layoutHooks(measure, lines)`.
- Produces:
  ```ts
  // xfapage.ts
  export function layoutPages(body: XfaBody, measure?: XfaMeasure, warnings?: string[], lines?: (n: LayoutNode) => number | undefined): XfaLayoutResult;
  // xfaconvert.ts (@internal)
  export function xfaFieldLines(doc: Document, tpl: XfaTemplate, values: XfaValues, globals?: XfaGlobals):
    { count: (n: LayoutNode) => number | undefined; texts: Map<string, string[]> };
  // formcreate.ts (@internal)
  export function createSplitField(doc: Document, init: Omit<FieldInit, 'page' | 'rect'>,
    pieces: ReadonlyArray<{ page: number; rect: [number, number, number, number]; shown: PdfObject }>,
    spec: FieldSpec): CreatedField;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/xfaconvert-split-field.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { decodeStream } from '../src/filters.js';
import { isStream, type PdfDict, type PdfObject } from '../src/types.js';

const probe = (n: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/xfa-adobe/${n}.pdf`, import.meta.url)));
const latin = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

function converted(name: string) {
  const src = Document.Open(probe(name));
  const report = src.ConvertXfaToAcroForm();
  const doc = Document.Open(src.Save());
  const fld = doc.Form.Fields.find((f) => f.FullName === 'form1[0].pos[0].f[0]')!;
  const kids = ((doc.resolve(fld.Dict.get('Kids')) ?? []) as PdfObject[]).map((k) => doc.resolve(k) as PdfDict);
  const apText = (w: PdfDict): string => {
    const ap = doc.resolve(w.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N'));
    return isStream(n) ? latin(decodeStream(n)) : '';
  };
  return { doc, report, fld, kids, apText };
}

describe('ConvertXfaToAcroForm: a field Adobe splits (164g.13)', () => {
  // t45: ten lines, 5 on page 1 (60pt) and 5 on page 2 (70pt).
  it('creates one field with a widget per piece, each on its own page', () => {
    const { doc, fld, kids } = converted('t45');
    expect(kids.length).toBe(2);
    expect(fld.Dict.has('Rect')).toBe(false);
    const pageOf = (w: PdfDict) => doc.Pages.findIndex((pg) => ((doc.resolve(pg.Dict.get('Annots')) ?? []) as PdfObject[])
      .some((a) => doc.resolve(a) === w)) + 1;
    expect(kids.map(pageOf)).toEqual([1, 2]);
    expect(kids.map((w) => { const r = doc.resolve(w.get('Rect')) as number[]; return Math.round(r[3] - r[1]); })).toEqual([60, 70]);
  });
  it('shows each widget its own lines, and keeps the whole value', () => {
    const { fld, kids, apText } = converted('t45');
    expect(String(fld.Value)).toContain('line 10');
    const [a, b] = kids.map(apText);
    expect(a).toContain('line 05');
    expect(a).not.toContain('line 06');
    expect(b).toContain('line 06');
    expect(b).toContain('line 10');
    expect(b).not.toContain('line 05');
  });
  // t54: the cut falls below the text, so the second widget shows nothing.
  it('shows nothing in a piece below the text', () => {
    const { kids, apText } = converted('t54');
    expect(apText(kids[0])).toContain('line 03');
    expect(apText(kids[1])).not.toContain('line');
  });
});
```

Add the password case (Review Focus 4) to the same describe block. It builds a password variant of t45 with `test/helpers/build-xfa-pdf.ts`, the way `scripts/gen-xfa-adobe-probes.ts` builds the probes (without the docReady `<event>` and `config` packet, which only Reader needs), and asserts neither widget's appearance carries the text:

```ts
  it('masks every piece of a password field', async () => {
    const { buildXfaPdf } = await import('./helpers/build-xfa-pdf.js');
    const body = readFileSync(new URL('./fixtures/xfa-adobe/t45.xml', import.meta.url), 'utf8')
      .replace('<textEdit multiLine="1"/>', '<passwordEdit/>');
    const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/2.8/"><subform name="form1" layout="tb" locale="en_US">
  <pageSet><pageArea name="P1" id="P1"><medium short="8.5in" long="11in" stock="letter"/>
    <contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/></pageArea></pageSet>
  <subform name="oracle" layout="tb" w="7.5in"><field name="out" w="7.5in" h="3in"><ui><textEdit multiLine="1"/></ui></field></subform>
  ${body}
</subform></template>`;
    const src = Document.Open(buildXfaPdf({ template, needsRendering: true, singleStream: true,
      datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data/></xfa:datasets>' }));
    src.ConvertXfaToAcroForm();
    const doc = Document.Open(src.Save());
    const fld = doc.Form.Fields.find((f) => f.FullName === 'form1[0].pos[0].f[0]')!;
    const kids = ((doc.resolve(fld.Dict.get('Kids')) ?? []) as PdfObject[]).map((k) => doc.resolve(k) as PdfDict);
    expect(kids.length).toBe(2);
    for (const w of kids) {
      const n = doc.resolve((doc.resolve(w.get('AP')) as PdfDict).get('N'));
      expect(isStream(n) ? latin(decodeStream(n)) : '').not.toContain('line');
    }
  });
```

(`buildXfaPdf`'s option names are the ones `scripts/gen-xfa-adobe-probes.ts` passes — check that file if they differ.)

Add, for Review Focus 3, to the same file:

```ts
  // Review Focus 3: a field whose tail is refused is refused whole, never half-created.
  it('creates no widget for a field whose tail could not be placed', async () => {
    const { buildXfaPdf } = await import('./helpers/build-xfa-pdf.js');
    const body = readFileSync(new URL('./fixtures/xfa-adobe/t45.xml', import.meta.url), 'utf8');
    // One page only: occur max 1 on the page area, so the tail has nowhere to go.
    const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/2.8/"><subform name="form1" layout="tb" locale="en_US">
  <pageSet><pageArea name="P1" id="P1"><occur max="1"/><medium short="8.5in" long="11in" stock="letter"/>
    <contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/></pageArea><occur max="1"/></pageSet>
  <subform name="oracle" layout="tb" w="7.5in"><field name="out" w="7.5in" h="3in"><ui><textEdit multiLine="1"/></ui></field></subform>
  ${body}
</subform></template>`;
    const src = Document.Open(buildXfaPdf({ template, needsRendering: true, singleStream: true,
      datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data/></xfa:datasets>' }));
    const report = src.ConvertXfaToAcroForm();
    const doc = Document.Open(src.Save());
    const fld = doc.Form.Fields.find((f) => f.FullName === 'form1[0].pos[0].f[0]');
    if (fld) expect(fld.Dict.has('Kids') || fld.Dict.has('Rect')).toBe(false);
    expect(report.skipped.some((s) => s.name === 'form1[0].pos[0].f[0]')).toBe(true);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/xfaconvert-split-field.test.ts`
Expected: FAIL — the field is one merged widget (or refused as a duplicate name across two pages).

- [ ] **Step 3: `layoutPages` takes the line counter**

In `src/xfapage.ts`:

```ts
export function layoutPages(
  body: XfaBody, measure?: XfaMeasure, warnings: string[] = [], lines?: (n: LayoutNode) => number | undefined,
): XfaLayoutResult {
```

and `layoutHooks(m, lines)` in its `paginate` call.

- [ ] **Step 4: `createSplitField` in `src/formcreate.ts`**

After `createField`, add:

```ts
/** @internal One terminal field with a widget per piece (164g.13): an XFA
 *  field Adobe splits across pages. The field dict holds the type, flags, `/DA`
 *  and the WHOLE value; each `/Kids` widget is one piece on its own page, with
 *  an appearance drawn from `shown` -- the lines in that piece. Same
 *  validate-then-mutate order as `createField`, so a rejected call leaves the
 *  document byte-identical. An editor that regenerates appearances draws the
 *  whole value from the top of every widget; AcroForm cannot flow text between
 *  widgets. */
export function createSplitField(
  doc: Document, init: Omit<FieldInit, 'page' | 'rect'>,
  pieces: ReadonlyArray<{ page: number; rect: [number, number, number, number]; shown: PdfObject }>,
  spec: FieldSpec,
): CreatedField {
  const placed = pieces.map((p) => ({
    page: pageOf(doc, p.page), rect: checkNums('rect', p.rect, 4) as [number, number, number, number], shown: p.shown,
  }));
  const style = checkFieldStyle(init);
  const std: StdFont = init.font ?? 'Helvetica';
  const size = init.fontSize ?? 0;
  const color = (checkColor('textColor', init.textColor ?? [0, 0, 0]) ?? [0, 0, 0]) as [number, number, number];
  nameParts(init.name);
  const aa = init.actions === undefined ? undefined : encodeFieldActions(doc, init.actions);

  const acro = ensureAcroForm(doc);
  resolvePath(doc, acro, init.name, false);

  const key = ensureDRFont(doc, acro, std);
  if (!acro.has('DA')) acro.set('DA', pdfLatin(fieldDA(key, 0, [0, 0, 0])));
  const path = resolvePath(doc, acro, init.name, true);

  let ff = spec.ff ?? 0;
  if (init.readOnly) ff |= FF_READONLY;
  if (init.required) ff |= FF_REQUIRED;

  const dict: PdfDict = new Map<string, PdfObject>([['FT', name(spec.ft)], ['T', pdfText(path.partial)]]);
  if (ff !== 0) dict.set('Ff', ff);
  dict.set('DA', pdfLatin(fieldDA(key, size, color)));
  if (path.parent) dict.set('Parent', path.parent);
  for (const [k, v] of spec.entries ?? []) dict.set(k, v);
  if (aa) dict.set('AA', aa);
  const fieldRef = doc.allocObject(dict);
  path.container.push(fieldRef);

  const kids: PdfObject[] = [];
  const widgets: PdfDict[] = [];
  for (const p of placed) {
    const w = buildWidgetDict(doc, p.page, p.rect);
    w.set('Parent', fieldRef);
    w.set('DA', pdfLatin(fieldDA(key, size, color)));
    applyWidgetStyle(doc, w, style);
    const ref = doc.allocObject(w);
    kids.push(ref);
    widgets.push(w);
    attachWidget(doc, p.page, ref);
  }
  dict.set('Kids', kids);

  const type = classify(spec.ft, ff);
  widgets.forEach((w, i) => generateFieldAppearance(doc, acro, w, type, ff, placed[i].shown));
  doc.markModified();
  return { acro, dict, type, ff, partial: path.partial, fullName: init.name };
}
```

Every identifier used is already imported by `formcreate.ts` for `createField`; `npm run typecheck` names any that is not.

- [ ] **Step 5: The converter**

In `src/xfaconvert.ts`:

1. Imports: add `createSplitField` to the `./formcreate.js` import, `layoutLeaf` to `./xfatext.js`, `measureToPt` to `./xfageom.js`, and `type LayoutNode, type XfaPiece` to `./xfaflow.js`.

2. `PlanEntry` gains:

```ts
  /** A field Adobe splits (164g.13): one widget per piece, page order, each
   *  with the text its widget shows. Absent for a field placed whole. */
  pieces?: Array<{ page: number; rect: [number, number, number, number]; shown: string }>;
```

3. After `xfaMeasurer`, add:

```ts
/** @internal 164g.13: a field's value as the lines `xfatext.ts` wraps it into
 *  at the field's stated width, with the faces `xfaMeasurer` measures with --
 *  `count` is what pagination splits by (0 for an empty value), and `texts`
 *  what each piece's widget shows. Undefined where the value cannot be laid
 *  out, which refuses a split rather than guessing at one. */
export function xfaFieldLines(
  doc: Document, tpl: XfaTemplate, values: XfaValues, globals?: XfaGlobals,
): { count: (n: LayoutNode) => number | undefined; texts: Map<string, string[]> } {
  const faces = faceLookup(doc);
  const byName = new Map(tpl.fields.map((f) => [f.name, f]));
  const texts = new Map<string, string[]>();
  const count = (n: LayoutNode): number | undefined => {
    if (n.kind !== 'field' || !n.text || n.field === undefined) return undefined;
    const known = texts.get(n.field);
    if (known) return known.length;
    let t = n.text;
    const f = byName.get(n.field);
    if (f) {
      const v = bindFieldValue(f, values, globals);
      if (Array.isArray(v)) return undefined;
      if (v !== undefined) t = withValue(t, v);
    }
    if (t.refusal !== undefined) return undefined;
    if (t.paras.every((p) => p.runs.every((r) => r.text === ''))) { texts.set(n.field, []); return 0; }
    const w = n.geom.w === undefined ? undefined : measureToPt(n.geom.w);
    if (w === undefined) return undefined;
    const l = layoutLeaf(t, { width: w }, faces);
    if ('reason' in l) return undefined;
    const out = l.lines.map((x) => x.segments.map((s) => s.text).join(''));
    texts.set(n.field, out);
    return out.length;
  };
  return { count, texts };
}
```

4. Where the plan lays pages out (step 3, `const laid = ...`):

```ts
  const measure = xfaMeasurer(doc, tpl, values, globals);
  const fieldLines = xfaFieldLines(doc, tpl, values, globals);
  const laid = tpl.body ? layoutPages(tpl.body, measure, report.warnings, fieldLines.count)
    : { pages: [], refused: new Map<string, string>() };
```

5. Replace the `where` map (step 4b) with lists:

```ts
  // 4b. Each field's placements, keyed by SOM name: one, or one per piece (164g.13).
  const where = new Map<string, Array<{ page: number; p: Placed }>>();
  laid.pages.forEach((pg, i) => {
    for (const [k, v] of pg.placed) {
      const l = where.get(k) ?? [];
      l.push({ page: i, p: v });
      where.set(k, l);
    }
  });
```

Run `grep -n "where" src/xfaconvert.ts` and update every other reader of `where` to the list (groups read the first entry: `where.get(name)?.[0]`).

6. Replace `geometryFor`'s parameter type with `ReadonlyMap<string, Array<{ page: number; p: Placed }>>`, add a `texts: ReadonlyMap<string, string[]>` parameter, and replace its body from `const w = where.get(f.name);` to the end with:

```ts
  const ws = where.get(f.name);
  if (ws === undefined || ws.length === 0) return 'the field is not on any laid-out page, so it carries no geometry';
  if (ws.some((w) => badPages.has(w.page))) return '';
  if (ws.length > 1 && !ws.every((w) => 'box' in w.p && w.p.piece))
    return `two fields share the SOM name ${f.name}, so neither can be placed by it, so the field carries no geometry`;
  const out: Array<{ page: number; rect: [number, number, number, number]; piece?: XfaPiece }> = [];
  for (const w of ws) {
    const p = w.p;
    if ('reason' in p) return `${p.reason}, so the field carries no geometry`;
    const wb = widgetBox(f, p.box);
    if ('reason' in wb) return `${wb.reason}, so the field carries no geometry`;
    out.push({ page: w.page + 1, rect: rectFromBox(wb, crops[w.page]), ...(p.piece ? { piece: p.piece } : {}) });
  }
  out.sort((a, b) => (a.piece?.offset ?? 0) - (b.piece?.offset ?? 0));
  entry.page = out[0].page;
  entry.rect = out[0].rect;
  if (out.length > 1) {
    const lines = texts.get(f.name) ?? [];
    entry.pieces = out.map((o) => ({ page: o.page, rect: o.rect, shown: lines.slice(o.piece!.lines[0], o.piece!.lines[1]).join('\n') }));
  }
  return undefined;
```

and pass `fieldLines.texts` at its call site: `geometryFor(f, entry, noGeometry, badPages, where, laid.refused, crops, fieldLines.texts)`.

`refused` is checked first in `geometryFor` (unchanged), so a field whose tail was refused by pagination is refused whole and gets no pieces — Review Focus 3.

7. `applyPositioned`:

```ts
function applyPositioned(doc: Document, e: PlanEntry): boolean {
  try {
    const init = {
      name: e.name,
      readOnly: (e.ff & FF_READONLY) !== 0,
      required: (e.ff & FF_REQUIRED) !== 0,
      ...(e.style ?? {}),
    };
    if (e.pieces && e.pieces.length > 1) {
      createSplitField(doc, init, e.pieces.map((p) => ({
        page: p.page, rect: p.rect, shown: p.shown === '' ? null : pdfText(p.shown),
      })), specFor(e));
    } else {
      createField(doc, { ...init, page: e.page!, rect: e.rect! }, specFor(e));
    }
    return true;
  } catch (caught) { rethrowLimit(caught);
    return false;
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/xfaconvert-split-field.test.ts test/xfaconvert*.test.ts test/xfa-real.test.ts test/xfa-master-oracle.test.ts`
Expected: PASS, the existing converter suites unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/xfapage.ts src/xfaconvert.ts src/formcreate.ts test/xfaconvert-split-field.test.ts
git commit -m "feat(164g.13): a split field converts to one field with a widget per piece

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Oracle — t40-t54 and the nine flipped probes

**Files:**
- Modify: `test/helpers/xfa-adobe.ts` (`ADOBE_PROBES` → t3..t54)
- Modify: `test/fixtures/xfa-adobe/adobe.json` (t6, t9, t10, t11, t20, t21, t27, t28, t31 → `match`)
- Modify: `test/xfa-adobe-oracle.test.ts` (every fragment of a field against its widgets)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: One probe list, nine flips**

```ts
/** t3-t26: a positioned subform split (164g.11); t27-t39: an lr-tb or table
 *  split (164g.12); t40-t54: a field split between its lines (164g.13). */
export const ADOBE_PROBES: readonly string[] = Array.from({ length: 52 }, (_, i) => `t${String(i + 3)}`);
```

```bash
node -e "const fs=require('fs');const f='test/fixtures/xfa-adobe/adobe.json';const g=JSON.parse(fs.readFileSync(f,'utf8'));for(const t of ['t6','t9','t10','t11','t20','t21','t27','t28','t31']){const p=g.probes[t];p.expect='match';delete p.reason;delete p.refusedUnder;}fs.writeFileSync(f,JSON.stringify(g,null,2)+'\n');"
```

- [ ] **Step 2: Compare every fragment**

In `test/xfa-adobe-oracle.test.ts`, replace the body of `"puts every field on Adobe's page and box"` with:

```ts
        /** A field's widgets: its /Kids, or the merged dict itself. */
        const widgetsOf = (d: PdfDict): PdfDict[] => {
          const kids = doc.resolve(d.get('Kids'));
          return Array.isArray(kids) ? kids.map((k) => doc.resolve(k) as PdfDict) : [d];
        };
        const pageOf = (w: PdfDict): number => doc.Pages.findIndex((pg) => ((doc.resolve(pg.Dict.get('Annots')) ?? []) as PdfObject[])
          .some((a) => doc.resolve(a) === w)) + 1;
        const widgets = new Map(doc.Form.Fields.map((fld) => [fld.FullName,
          widgetsOf(fld.Dict).map((w) => ({ page: pageOf(w), rect: doc.resolve(w.get('Rect')) as number[] }))
            .sort((a, b) => a.page - b.page)]));
        const wrong: string[] = [];
        for (const [path, frags] of Object.entries(probe.fields)) {
          const got = widgets.get(som(path)) ?? [];
          if (got.length !== frags.length) { wrong.push(`${path}: ${String(frags.length)} fragments, ${String(got.length)} widgets`); continue; }
          frags.forEach((frag, i) => {
            const b = boxOf(probe, path, frag);
            if (typeof b === 'string') { wrong.push(`${path}: ${b}`); return; }
            const want = { page: b.page, rect: [b.x, PAGE_H - b.y - b.h, b.x + b.w, PAGE_H - b.y] };
            const g2 = got[i];
            if (g2.page !== want.page || g2.rect.some((v, k) => Math.abs(v - want.rect[k]) > TOL))
              wrong.push(`${path}#${String(i)}: want p${String(want.page)} [${want.rect.join(' ')}], got p${String(g2.page)} [${g2.rect.join(' ')}]`);
          });
        }
        expect(wrong).toEqual([]);
```

and add `type PdfDict` to the `../src/types.js` import. The 164g.11 probes' fields are one fragment each, so this compares exactly what the old body did for them.

- [ ] **Step 3: Run the oracle**

Run: `npx vitest run test/xfa-adobe-oracle.test.ts test/xfa-adobe-qualified-oracle.test.ts`
Expected: PASS for all 52 probes and q1-q15. A failure names the field, fragment index and both rects; compare against the spec's tables before touching code, and never edit a golden number.

- [ ] **Step 4: Fences and the full gate**

Run: `npx vitest run test/xfa-master-oracle.test.ts test/xfa-real.test.ts test/xfa-dynamic-oracle.test.ts test/xfa-chrome-fence.test.ts test/import-cycles.test.ts`
Expected: PASS. Then `npm run typecheck && npm test` — expected all green.

- [ ] **Step 5: CHANGELOG**

Under `## [Unreleased]` → `### Added`, first:

```markdown
- **`ConvertXfaToAcroForm` splits a text field across a page break where Adobe Reader does, as one field with a widget per page.** A field that straddled a break in a positioned or `lr-tb` subform was refused, and one in a `tb` subform moved whole to the next page. Each now splits as Adobe Reader 26.1 splits it, measured through 15 new probe forms (`test/fixtures/xfa-adobe/`, t40-t54) beside nine that were refused until now. A field's text sits on a grid of 1.2 times its font size, whatever the face; inside the text the break falls between whole lines, keeping at least one line on top and with no orphan or widow control, and below the text, or in an empty field, it falls exactly where the room ends; a piece below the break smaller than the font size moves the break up by exactly one font size. The field is written as one AcroForm field holding the whole value, with a widget on each page at Adobe's box, each widget's appearance showing the lines that fall in it. An editor that regenerates appearances draws the whole value from the top of every widget, since AcroForm cannot flow text between widgets. Draws, table rows and fields directly under the content area are not split. A field that would split and is not a plain text field, or states a caption, a top or bottom inset, a vertical alignment, a line height, orphans or widows, or mixed font sizes, is refused by name in a positioned or `lr-tb` subform and moves whole in a `tb` subform, as before (164g.26). Every field of all 24 probes lands on Reader's pages and boxes. (aspose-pdf-foss-for-ts-164g.13)
```

Under `### Changed`, first (create the heading after `### Added`'s entries if `[Unreleased]` has none):

```markdown
- **A text field straddling a page break inside a `tb` subform is split, not moved.** `ConvertXfaToAcroForm` moved such a field whole to the next page; Adobe Reader splits it between its lines (probe t47), so it now becomes one field with a widget on each page. A field the splitting rules decline still moves whole. (aspose-pdf-foss-for-ts-164g.13)
```

- [ ] **Step 6: Commit**

```bash
git add test/helpers/xfa-adobe.ts test/fixtures/xfa-adobe/adobe.json test/xfa-adobe-oracle.test.ts CHANGELOG.md
git commit -m "test(164g.13): Adobe oracle for field splitting, t40-t54 and nine more

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Mutation sweep

For each mutation: apply, check `git diff --stat src/` is non-empty (a no-op reports green and looks like a coverage gap), run `npx vitest run test/xfafieldsplit.test.ts test/xfapage.test.ts test/xfasplitpos.test.ts test/xfaconvert-split-field.test.ts test/xfa-adobe-oracle.test.ts --testTimeout=30000` with ANSI stripped, record which cases go red, restore with `git checkout -- src/`. A run whose test file fails to LOAD is not green. Kill orphaned vitest workers after a hang before the next run.

| # | Mutation | Expected red |
|---|---|---|
| M1 | `LINE_PITCH = 1.1328` (Courier New's metric line height) | t45, t46, t50, unit snap cases |
| M2 | `snap` returns `c` unchanged | t45, t46, t47, t49-t53 |
| M3 | `snap` snaps below the text too (drop the `c < textEnd` test) | t54, unit "cuts freely below the text" |
| M4 | bottom floor "to": `c = h - fs` instead of `snap(c - fs)` | t40, t41 |
| M5 | no bottom floor | t21, t40, t41, t44 |
| M6 | `straddle`: `if (lay === 'tb' ...) return undefined` for fields too | t47, builder "splits a field in a tb" |
| M7 | `straddle`: a `tb` refusal returns the refusal | builder "moves, rather than refuses" |
| M8 | `pieceOf` ignores `n.piece` offset | unit "piece of a piece", builder "splits twice" |
| M9 | `geometryFor`: `shown` is the whole value | converter "own lines" |
| M10 | `positionedFragment`: no piece branch | t6, t9-t11, t20, t21, t40-t46, t50-t54 |
| M11 | `splitRefusal` returns undefined | rule-6 unit cases, builder "refuses, in an lr-tb" |

Record the outcomes for Task 8. Any mutation expected red that stays green is a coverage gap: add the missing case, rerun it, commit the case with a message naming the mutation.

---

### Task 8: Documentation, close, push

**Files:** `CLAUDE.md`, `README.md`

- [ ] **Step 1: CLAUDE.md — the new module**

After the `xfasplitpos.ts` entry (the one beginning `- **xfasplitpos.ts** — splitting a positioned XFA subform`), add:

```markdown
- **xfafieldsplit.ts** — splitting a field between its lines across content
  areas (`164g.13`): `fieldCut` (where Adobe cuts a straddling field, or
  `'move'`, or a named refusal) and `pieceOf` (the part of a field from an
  offset, as a copy stating its own `h` and carrying `piece: { offset, lines }`).
  It owns `fontSizeOf` and `ptStr`, which `xfasplitpos.ts` imports -- the
  other way round closes a 2-cycle. A pure leaf over `xfaflow.js` TYPES and
  `xfageom.js` that never throws.
  **Invariant:** lines sit on a `1.2 x font size` grid from the field's top,
  WHATEVER THE FACE (t45 Courier New and t50 Arial at 12pt for 10pt, t51 24pt
  at 20pt). Our own measured line height, hhea's, is not that grid, and using
  it moves every cut inside text by a line in a few.
  **Invariant:** inside the text the cut snaps down to a whole line, at least
  one; below the text, or in an empty field, it is free (t54). There is NO
  orphan or widow control (t52 keeps one line, t53 carries one).
  **Invariant, and it reads wrong:** a bottom piece smaller than one font size
  moves the cut up by EXACTLY one font size -- not until the bottom reaches it
  (t40: 46/2 became 36/12, where "until" gives 38/10; t41: 42/6 became 32/16).
  **Invariant:** a piece's grid is the WHOLE field's, from its `offset`, so a
  field split twice keeps its lines aligned; `pieceOf` composes offsets.
  **Invariant:** rule 6 refuses what no probe shows split -- a non-text `ui`, a
  comb, a caption, a top or bottom inset, `vAlign`, a `lineHeight`, orphans or
  widows, mixed sizes (164g.26) -- and a field that would MOVE anyway moves,
  whatever it states. What a refusal MEANS is the caller's: in a `tb` the field
  moves whole as under 164g.8, so no form that converted before loses a field;
  in a positioned or `lr-tb` parent it is refused, as 164g.11 and 164g.12
  already refused every straddling field there.
  **Invariant (`xfaconvert.ts`):** a field placed in several pieces is ONE
  field with a `/Kids` widget per piece (`formcreate.ts`'s internal
  `createSplitField`), the whole value in `/V`, each widget's appearance
  showing the lines its piece holds (`xfaFieldLines`, the same `xfatext.ts`
  wrap the line count came from). A field with one placement keeps
  `createField`'s merged dict byte for byte. A field whose tail pagination
  refused is refused whole: `geometryFor` reads `refused` first.
  **Stated limit:** an editor that regenerates appearances draws the whole
  value from the top of every widget; AcroForm cannot flow text between widgets.
  **Note on the oracle:** Adobe probes t6, t9-t11, t20, t21, t27, t28, t31 and
  t40-t54 (`test/fixtures/xfa-adobe/`); their fields are EMPTY or hold one-word
  lines, so where our wrap and Adobe's differ on long lines is unmeasured.
  **Note, measured:** <fill from Task 7: N of 11 mutations redden; name any held
  by builder cases alone>.
```

Fill the last note from Task 7's results.

- [ ] **Step 2: CLAUDE.md — neighbours and the fixtures row**

- In the `xfasplitpos.ts` entry, replace "a field whose piece reaches its font size is one Adobe SPLITS, and that is refused (164g.13)" with "a field whose piece reaches its font size is SPLIT through `xfafieldsplit.ts` (164g.13)".
- In the `xfapage.ts` `164g.12` rule-7 invariant, replace "a field moves when the piece is below its font size (t35) and is refused otherwise (t27, t28, t31 -- 164g.13, `xfasplitpos.ts`'s `fieldSplitRefusal`, one text for both splitters)" with "a field splits where `xfafieldsplit.ts`'s `fieldCut` says (t27, t28, t31, t35), and since 164g.13 a field in a `tb` does too (t47) -- a refused one moving whole there".
- In the `fixtures/xfa-adobe/` table row, change `37 dynamic XFA probes` to `52 dynamic XFA probes`, and before `Since \`164g.9\`` insert: `Since \`164g.13\`, 15 more (t40-t54) settled where Reader cuts a field between its lines -- a 1.2 x font size grid, a free cut below the text, a one-font-size floor moved by, not to -- and turned nine refused probes into matches.`

Run the module sweep:

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

Expected: empty.

- [ ] **Step 3: README**

In `README.md`'s Scope and Limitations bullet beginning `- **XFA converts to AcroForm, with limited content splitting**`, replace

```
and content splits across them only in two cases -- a `tb` subform between its children, and a positioned subform stating `keep intact="none"` where Adobe Reader splits it (a field Reader would split between its lines, a top or bottom margin, or an anchored child refuses that split) --
```

with

```
and content splits across them where Adobe Reader splits it -- a `tb` subform between its children, an `lr-tb` between its items, a table between its rows, a positioned subform stating `keep intact="none"`, and a text field between its lines, written as one field with a widget per page whose appearances an editor regenerates by drawing the whole value in every widget (a field with a caption, an inset, a vertical alignment or a line height, a non-text field, a top or bottom margin on a positioned subform, or an anchored child refuses its split) --
```

- [ ] **Step 4: Gate and commit**

Run: `npm run typecheck && npm test` — expected all green.

```bash
git add CLAUDE.md README.md
git commit -m "docs(164g.13): field splitting invariants and the regeneration limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Close and push**

```bash
bd close aspose-pdf-foss-for-ts-164g.13 --reason "A text field straddling a break splits where Adobe does (1.2 x size line grid, snap inside text, free below it, one-font-size floor moved by) in positioned, tb and lr-tb parents, converted as one field with a widget per piece. Oracle: Adobe probes t40-t54 plus nine formerly refused. Unprobed shapes filed as 164g.26."
git add .beads/interactions.jsonl && git commit -m "chore(beads): close 164g.13

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git pull --rebase
git push
git status    # must say "up to date with 'origin/main'"
```
