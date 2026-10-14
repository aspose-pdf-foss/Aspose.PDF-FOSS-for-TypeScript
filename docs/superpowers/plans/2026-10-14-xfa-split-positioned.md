# XFA: splitting a positioned subform (`164g.11`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ConvertXfaToAcroForm` splits a positioned subform that states `<keep intact="none"/>` across content areas exactly where Adobe Reader does, checked against Reader's own layout.

**Architecture:** A new pure module `src/xfasplitpos.ts` decides the cut (`positionedCut`) and builds geometric fragments (`positionedFragment`) from child boxes supplied by a callback; `src/xfaflow.ts` gains `positionedChildBoxes`, the engine's answer for that callback; `src/xfapage.ts`'s root-child loop plans every cut before placing anything and emits the fragments. The oracle is a new fixture directory of 24 Adobe Reader probes with Adobe's layout transcribed into `adobe.json`.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-xfa-split-positioned-design.md` -- read it first; R1-R8 below are its rules.

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins.
- Every new module is a pure leaf: no `Document`, no PDF object, never throws. A shape it cannot handle is a named refusal string.
- Never an approximate rect: what cannot be laid out is refused BY NAME and reported.
- Refusal reasons cite their issue: field splitting `164g.13`, overflow leaders `164g.15`, over-tall default positioned subform `164g.19`, margins across a split `164g.20`.
- `SPLIT_LATER` (xfaflow.ts) becomes `'splitting beyond a tb subform between its children (164g.12, 164g.13, 164g.19)'`.
- Only a ROOT child is split (spec, Scope amendment; in-chain is 164g.21).
- Tolerance for comparing summed measurements is `EPS = 1e-6`, as in `xfapage.ts`.
- Run `npm run typecheck` and `npx vitest run` before closing; both green.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (none are needed here; do not add any).

## Review Focus

- A keep-none positioned subform with NO stated `h` (growable): its height comes from the engine and its fragments state `h` -- pinned in Task 5.
- A split whose tail needs another page when the page set's `occur max` is used up: nothing is placed and the subform is refused with the discard reason -- pinned in Task 5.
- A child whose top lies exactly on the cut is not straddling: it goes into the later fragment -- pinned in Tasks 3 and 4.
- Hidden or inactive children of a splitting subform are kept (first fragment) so their fields stay known to the converter -- pinned in Task 4.
- A nested split (t24) puts fragments of one subform on two pages without a "two fields share the SOM name" refusal -- pinned in Task 5.

---

### Task 1: Vendor the Adobe oracle fixture

**Files:**
- Create: `test/fixtures/xfa-adobe/` with `t3.pdf` ... `t26.pdf` (24 probes, t1/t2 excluded), `t3.xml` ... `t26.xml` (template bodies), `captures/t3.png` ... `captures/t26.png`, `adobe.json`, `PROVENANCE.md`
- Create: `scripts/gen-xfa-adobe-probes.ts`, `scripts/run-xfa-adobe-probe.ps1`
- Create: `test/helpers/xfa-adobe.ts`
- Test: `test/xfa-adobe-fixture.test.ts`

**Interfaces:**
- Produces: `test/helpers/xfa-adobe.ts` exports
  `ADOBE_PROBES: readonly string[]`, `loadAdobeProbe(name: string): Uint8Array`, `adobeGoldens(): AdobeGoldens`, and the types
  `AdobeFrag = [page: number, x: number, y: number, w: number, h: number]`,
  `AdobeProbe = { pages: number; expect: 'match' | 'refused'; reason?: string; insets?: Record<string, [left: number, top: number]>; subforms: Record<string, AdobeFrag[]>; fields: Record<string, AdobeFrag[]> }`,
  `AdobeGoldens = { reader: string; probes: Record<string, AdobeProbe> }`.

The spike's files are in the session scratchpad,
`C:\Users\user\AppData\Local\Temp\claude\s--Aspose-PAS-gitlab-com-esopsa-pdf4ts-aspose-pdf-foss-for-ts\fcb7fc8f-06c4-488e-9aad-471f2f16abd7\scratchpad\spike\`
(below: `$SPIKE`). Probe `tN` was rendered from `tN.pdf`, built from body file `bodyN.xml` -- except t3, whose body is `body1.xml`.

- [ ] **Step 1: Copy the probes, bodies and crops**

```powershell
$SPIKE = "C:\Users\user\AppData\Local\Temp\claude\s--Aspose-PAS-gitlab-com-esopsa-pdf4ts-aspose-pdf-foss-for-ts\fcb7fc8f-06c4-488e-9aad-471f2f16abd7\scratchpad\spike"
$DST = "test\fixtures\xfa-adobe"
New-Item -ItemType Directory -Force "$DST\captures" | Out-Null
Add-Type -AssemblyName System.Drawing
foreach ($n in 3..26) {
  Copy-Item "$SPIKE\t$n.pdf" "$DST\t$n.pdf"
  $body = if ($n -eq 3) { "body1.xml" } else { "body$n.xml" }
  Copy-Item "$SPIKE\$body" "$DST\t$n.xml"
  $img = [Drawing.Image]::FromFile("$SPIKE\t$n.png")
  $out = New-Object Drawing.Bitmap 760, 270
  $g = [Drawing.Graphics]::FromImage($out)
  $g.DrawImage($img, (New-Object Drawing.Rectangle 0, 0, 760, 270), (New-Object Drawing.Rectangle 630, 228, 760, 270), [Drawing.GraphicsUnit]::Pixel)
  $out.Save("$DST\captures\t$n.png"); $img.Dispose(); $g.Dispose(); $out.Dispose()
}
Get-ChildItem $DST | Measure-Object | Select-Object Count
```

Expected: `Count` 49 (24 PDFs, 24 XMLs, `captures`). Open three captures (t5, t15, t24) with the Read tool and confirm each shows that probe's `pages=` line.

- [ ] **Step 2: Write `adobe.json`**

Coordinates are Adobe's `xfa.layout` numbers as transcribed from the captures: relative to the PARENT's content box, a root child's relative to the content area. `t15`'s third and fourth `pos` fragments are DERIVED (720, and 1800 - 144 - 720 - 720 = 216); the capture's line is cut off there.

```json
{
  "reader": "Adobe Acrobat Reader 26.1.21691.0 (Acrobat DC, Reader mode, Protected Mode on)",
  "probes": {
    "t3": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[2,0,0,540,288]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.a": [[2,0,36,144,21.6]], "form1.pos.b": [[2,0,108,144,21.6]], "form1.pos.c": [[2,0,216,144,21.6]] } },
    "t4": { "pages": 1, "expect": "refused", "reason": "164g.19",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.pos": [[1,0,216,540,864]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.a": [[1,0,72,144,21.6]], "form1.pos.b": [[1,180,396,144,21.6]], "form1.pos.c": [[1,0,496.8,144,21.6]], "form1.pos.d": [[1,0,792,144,21.6]] } },
    "t5": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,144],[2,0,0,540,144]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.a": [[1,0,36,144,21.6]], "form1.pos.b": [[1,0,108,144,21.6]], "form1.pos.c": [[2,0,72,144,21.6]] } },
    "t6": { "pages": 2, "expect": "refused", "reason": "164g.13",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,144],[2,0,0,540,144]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.a": [[1,0,36,144,21.6]], "form1.pos.b": [[1,0,108,144,36],[2,0,0,144,36]], "form1.pos.c": [[1,216,72,144,21.6]], "form1.pos.e": [[2,0,72,144,21.6]] } },
    "t7": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.pos": [[1,0,216,540,496.8],[2,0,0,540,367.2]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.a": [[1,0,72,144,21.6]], "form1.pos.b": [[1,180,396,144,21.6]], "form1.pos.c": [[2,0,0,144,21.6]], "form1.pos.d": [[2,0,295.2,144,21.6]] } },
    "t8": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,138],[2,0,0,540,150]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.f": [[2,0,0,144,48]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t9": { "pages": 2, "expect": "refused", "reason": "164g.13",
      "subforms": { "form1.pos": [[1,0,576,540,144],[2,0,0,540,144]] },
      "fields": { "form1.pos.f": [[1,0,133,144,11],[2,0,0,144,37]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t10": { "pages": 2, "expect": "refused", "reason": "164g.13",
      "subforms": { "form1.pos": [[1,0,576,540,144],[2,0,0,540,144]] },
      "fields": { "form1.pos.f": [[1,0,132,144,12],[2,0,0,144,36]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t11": { "pages": 2, "expect": "refused", "reason": "164g.13",
      "subforms": { "form1.pos": [[1,0,576,540,144],[2,0,0,540,144]] },
      "fields": { "form1.pos.f": [[1,0,120,144,24],[2,0,0,144,24]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t12": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,120],[2,0,0,540,168]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t13": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,120],[2,0,0,540,168]], "form1.pos.inner": [[2,0,0,216,48]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.inner.g": [[2,0,0,72,20]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t14": { "pages": 2, "expect": "refused", "reason": "164g.20",
      "subforms": { "form1.pos": [[1,0,576,540,144],[2,0,0,540,144]] },
      "fields": { "form1.pos.f": [[1,0,80,144,20]], "form1.pos.h": [[2,0,56,144,20]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t15": { "pages": 4, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,144],[2,0,0,540,720],[3,0,0,540,720],[4,0,0,540,216]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.f": [[1,0,100,144,20]], "form1.pos.h": [[3,0,36,144,20]], "form1.pos.k": [[4,0,116,144,20]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t16": { "pages": 1, "expect": "match", "insets": { "form1.pos": [6,18] },
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,72]], "form1.pos": [[1,0,288,540,288]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.f": [[1,0,80,144,20]] } },
    "t17": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,137],[2,0,0,540,151]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.f": [[2,0,0,144,48]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t18": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,136],[2,0,0,540,152]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.f": [[2,0,0,144,48]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t19": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,135],[2,0,0,540,153]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.f": [[2,0,0,144,48]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t20": { "pages": 2, "expect": "refused", "reason": "164g.13",
      "subforms": { "form1.pos": [[1,0,576,540,144],[2,0,0,540,144]] },
      "fields": { "form1.pos.f": [[1,0,134,144,10],[2,0,0,144,38]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t21": { "pages": 2, "expect": "refused", "reason": "164g.13",
      "subforms": { "form1.pos": [[1,0,576,540,134],[2,0,0,540,154]] },
      "fields": { "form1.pos.f": [[1,0,104,144,30],[2,0,0,144,16]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t22": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,129],[2,0,0,540,159]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.f": [[2,0,0,144,60]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t23": { "pages": 1, "expect": "match", "insets": { "form1.pos": [6,18] },
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.pos": [[1,0,216,540,130]], "form1.nxt": [[1,0,346,540,20]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.f": [[1,0,80,144,20]], "form1.nxt.n": [[1,0,0,144,20]] } },
    "t24": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,144],[2,0,0,540,144]], "form1.pos.inner": [[1,0,100,216,44],[2,0,0,216,76]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.inner.g": [[1,0,0,72,20]], "form1.pos.inner.k": [[2,0,36,72,20]], "form1.pos.z": [[1,360,14.4,72,21.6]] } },
    "t25": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[2,0,0,540,288]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.g": [[2,216,250,72,20]] } },
    "t26": { "pages": 2, "expect": "match",
      "subforms": { "form1.oracle": [[1,0,0,540,216]], "form1.filler": [[1,0,216,540,360]], "form1.pos": [[1,0,576,540,144],[2,0,0,540,144]] },
      "fields": { "form1.oracle.out": [[1,0,0,540,216]], "form1.pos.g": [[2,0,56,72,20]] } }
  }
}
```

Before saving, re-read each probe's capture and check every number above against it; correct any disagreement from the capture, never from the spec.

- [ ] **Step 3: Write the helper**

```ts
// test/helpers/xfa-adobe.ts
import { readFileSync } from 'node:fs';

/** One fragment as Adobe Reader's xfa.layout reports it: page (1-based) and
 *  x, y, w, h in points, x/y relative to the parent's content box. */
export type AdobeFrag = [page: number, x: number, y: number, w: number, h: number];
export interface AdobeProbe {
  pages: number;
  expect: 'match' | 'refused';
  /** The issue id a refused probe's reason cites. */
  reason?: string;
  /** [left, top] content insets of a subform, by dotted path. */
  insets?: Record<string, [number, number]>;
  subforms: Record<string, AdobeFrag[]>;
  fields: Record<string, AdobeFrag[]>;
}
export interface AdobeGoldens { reader: string; probes: Record<string, AdobeProbe> }

const DIR = new URL('../fixtures/xfa-adobe/', import.meta.url);
export const ADOBE_PROBES: readonly string[] = Array.from({ length: 24 }, (_, i) => `t${String(i + 3)}`);
export const loadAdobeProbe = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`${name}.pdf`, DIR)));
export const adobeGoldens = (): AdobeGoldens =>
  JSON.parse(readFileSync(new URL('adobe.json', DIR), 'utf8')) as AdobeGoldens;
```

- [ ] **Step 4: Write the fixture test**

```ts
// test/xfa-adobe-fixture.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { ADOBE_PROBES, adobeGoldens, loadAdobeProbe } from './helpers/xfa-adobe.js';

describe('Adobe Reader oracle fixture (164g.11)', () => {
  const g = adobeGoldens();
  it('holds a golden for every probe, and a probe for every golden', () => {
    expect(Object.keys(g.probes).sort()).toEqual([...ADOBE_PROBES].sort());
  });
  it.each(ADOBE_PROBES)('%s is a dynamic XFA document', (name) => {
    const doc = Document.Open(loadAdobeProbe(name));
    expect(doc.Pages.length).toBe(1);
    expect(g.probes[name].expect === 'match' || g.probes[name].reason !== undefined).toBe(true);
  });
});
```

- [ ] **Step 5: Run it**

Run: `npx vitest run test/xfa-adobe-fixture.test.ts`
Expected: PASS, 25 tests.

- [ ] **Step 6: Promote the generator and the runner**

Copy `$SPIKE\make.mts` to `scripts/gen-xfa-adobe-probes.ts` and edit it so that: it takes `(name)` only and reads `test/fixtures/xfa-adobe/<name>.xml`, writing `test/fixtures/xfa-adobe/<name>.out.pdf` (never overwriting the vendored probe); the dynamic import becomes a static `import { buildXfaPdf } from '../test/helpers/build-xfa-pdf.js';`; and the `if (typeof spikeSave ...)` line and its `savePath` argument are removed. Keep the `config` packet, the `docReady` script and the 3in `oracle` field exactly. Header comment:

```ts
// scripts/gen-xfa-adobe-probes.ts -- NOT run by npm test.
// Builds an XFA probe for Adobe Reader (164g.11): a dynamic form whose docReady
// script writes Adobe's xfa.layout of every subform, field and draw into a
// visible field at the top of page 1. Usage:
//   npx tsx scripts/gen-xfa-adobe-probes.ts t5
// then scripts/run-xfa-adobe-probe.ps1 -Name t5.out to open it in Reader and
// capture the window. The vendored tN.pdf are the bytes Reader rendered; this
// script rebuilds them without the spike's save call, so only the script text
// differs.
```

Merge `$SPIKE\run.ps1` and `$SPIKE\cap.ps1` into `scripts/run-xfa-adobe-probe.ps1`: `param([Parameter(Mandatory)][string]$Name)`, the PDF read from `test\fixtures\xfa-adobe\$Name.pdf`, the capture written to `test\fixtures\xfa-adobe\$Name.png`, no wait for a saved copy (sleep 15 s after launch), the capture filter `$_.MainWindowTitle -like '*.pdf*'`.

- [ ] **Step 7: Write `PROVENANCE.md`**

```markdown
# Adobe Reader layout probes (164g.11)

**Producer:** Adobe Acrobat Reader 26.1.21691.0 (Acrobat DC in Reader mode,
Protected Mode on), Windows 11, 2026-10-14.

**What they are:** 24 dynamic XFA forms built by our own
`scripts/gen-xfa-adobe-probes.ts` and laid out by ADOBE. The template bodies
are `tN.xml`; `tN.pdf` are the exact bytes Reader rendered (t1 and t2 were
early runs Reader drew blank -- no `config` packet -- and are not vendored).
Each probe's `docReady` script walks `xfa.form` and writes every subform's,
field's and draw's SOM expression and, per fragment `k < xfa.layout.pageSpan`,
`page, xfa.layout.x/y/w/h(node, "pt", k)` into a field at the top of page 1.

**The channel is the SCREEN.** Reader will not save data typed into these
forms, and a folder-level trusted function is invisible to XFA scripts, so the
window was captured (`captures/tN.png`, cropped to the field) and the numbers
transcribed by hand into `adobe.json`. Only `t15`'s third and fourth `pos`
fragments are derived rather than read (720 and 216 -- the capture line is cut
off; the field positions on those pages are read).

**Coordinates** are relative to the parent's content box (t23 shows margins are
honoured while a child's y is reported without them); a root child's are
relative to the content area, which every probe places at (0.5in, 0.5in) on US
Letter, 7.5in x 10in.

**How to re-run:** Reader installed, then
`npx tsx scripts/gen-xfa-adobe-probes.ts tN` and
`scripts/run-xfa-adobe-probe.ps1 -Name tN.out`.

**Ceiling:** one producer, one version, hand transcription. Evidence for how
Adobe splits a positioned subform, not conformance. Not covered: a positioned
subform inside a split tb chain (164g.21), margins across a split (t14,
164g.20), the bottom-piece rule for a field split (t21, 164g.13).

| File | SHA-256 |
|---|---|
```

Then append one row per probe PDF with this command, pasting its output under the table header:

```powershell
Get-ChildItem test\fixtures\xfa-adobe\t*.pdf | Sort-Object { [int]($_.BaseName.Substring(1)) } | ForEach-Object { "| ``$($_.Name)`` | ``$((Get-FileHash $_.FullName).Hash.ToLower())`` |" }
```

- [ ] **Step 8: Commit**

```bash
git add test/fixtures/xfa-adobe scripts/gen-xfa-adobe-probes.ts scripts/run-xfa-adobe-probe.ps1 test/helpers/xfa-adobe.ts test/xfa-adobe-fixture.test.ts
git commit -m "test(164g.11): vendor 24 Adobe Reader layout probes for positioned splitting"
```

---

### Task 2: `positionedChildBoxes` in `xfaflow.ts`

**Files:**
- Modify: `src/xfaflow.ts` (after `measureExtent`, end of file)
- Test: `test/xfaflow-positioned-boxes.test.ts`

**Interfaces:**
- Produces: `export interface ChildBox { node: LayoutNode; top: number; h: number }` and
  `export function positionedChildBoxes(n: LayoutNode, measure?: XfaMeasure): ChildBox[] | { reason: string }` -- `n`'s visible children (hidden/inactive excluded) in document order, `top` relative to `n`'s CONTENT box (the parent's top inset removed, any anchor shift included), `h` the child's laid-out height.

- [ ] **Step 1: Write the failing test**

```ts
// test/xfaflow-positioned-boxes.test.ts
import { describe, it, expect } from 'vitest';
import { positionedChildBoxes, type LayoutNode } from '../src/xfaflow.js';

const f = (label: string, y: string, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'field', label, geom: { x: '0pt', y, w: '50pt', h: `${String(h)}pt` }, children: [], ...extra });
const pos = (children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label: 'pos', layout: 'position', geom: { w: '500pt', h: '300pt' }, children, ...extra });

describe('positionedChildBoxes (164g.11)', () => {
  it('reports each visible child, top in the content box, with its height', () => {
    const n = pos([f('a', '36pt', 20), f('h', '10pt', 10, { presence: 'hidden' }), f('b', '100pt', 30)],
      { margin: { topInset: '18pt', leftInset: '6pt' } });
    expect(positionedChildBoxes(n)).toEqual([
      { node: n.children[0], top: 36, h: 20 },
      { node: n.children[2], top: 100, h: 30 },
    ]);
  });

  it('applies an anchor shift to the top', () => {
    const n = pos([f('a', '100pt', 20, { geom: { x: '0pt', y: '100pt', w: '50pt', h: '20pt', anchorType: 'bottomLeft' } })]);
    expect(positionedChildBoxes(n)).toEqual([{ node: n.children[0], top: 80, h: 20 }]);
  });

  it('carries a child it cannot place as a reason', () => {
    expect(positionedChildBoxes(pos([f('a', 'abc', 20)]))).toEqual({ reason: 'a: y="abc" could not be read as a measurement' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/xfaflow-positioned-boxes.test.ts`
Expected: FAIL -- `positionedChildBoxes` is not exported.

- [ ] **Step 3: Implement**

Append to `src/xfaflow.ts`:

```ts
/** One child of a positioned container as pagination sees it (164g.11): its
 *  top in the container's CONTENT box and its laid-out height. */
export interface ChildBox { node: LayoutNode; top: number; h: number }

/**
 * A positioned container's visible children, in document order, each with its
 * top relative to the container's content box -- the frame XFA's `x`/`y` and
 * Adobe's `xfa.layout.y` both use -- and its laid-out height. What
 * `xfasplitpos.ts` decides a cut from. Hidden and inactive children take no
 * space (p. 67) and are left out.
 */
export function positionedChildBoxes(n: LayoutNode, measure?: XfaMeasure): ChildBox[] | { reason: string } {
  const engine = new Engine(undefined, measure, []);
  engine.index(n);
  const m = insetsOf(n);
  if (isFail(m)) return { reason: m.reason };
  const slots = engine.arrange(n);
  const out: ChildBox[] = [];
  for (const c of n.children) {
    if (concealed(c) !== undefined) continue;
    const s = slots.get(c);
    if (s === undefined) return { reason: `${c.label}: was not laid out` };
    if (isFail(s)) return { reason: s.reason };
    const e = engine.extent(c);
    if (isFail(e)) return { reason: e.reason };
    out.push({ node: c, top: s.y - m.t, h: e.h });
  }
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/xfaflow-positioned-boxes.test.ts`
Expected: PASS, 3 tests. If the anchor case gives a different `top`, read `anchorShift` in `src/xfageom.ts` and correct the TEST's expectation only if `bottomLeft` with `h` 20 shifts by -20 there.

- [ ] **Step 5: Commit**

```bash
git add src/xfaflow.ts test/xfaflow-positioned-boxes.test.ts
git commit -m "feat(164g.11): positionedChildBoxes, a positioned container's children for pagination"
```

---

### Task 3: `positionedCut` in a new `xfasplitpos.ts`

**Files:**
- Create: `src/xfasplitpos.ts`
- Test: `test/xfasplitpos.test.ts`

**Interfaces:**
- Consumes: `ChildBox`, `LayoutNode` (types) from `xfaflow.ts`; `measureToPt` from `xfageom.ts`.
- Produces:
  `export type XfaChildBoxes = (n: LayoutNode) => ChildBox[] | { reason: string };`
  `export function positionedSplittable(n: LayoutNode): boolean;`
  `export function positionedCut(n: LayoutNode, room: number, boxes: XfaChildBoxes): number | { refusal: string };`

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfasplitpos.test.ts
import { describe, it, expect } from 'vitest';
import { positionedCut, positionedSplittable, type XfaChildBoxes } from '../src/xfasplitpos.js';
import type { LayoutNode } from '../src/xfaflow.js';
import type { LeafText } from '../src/xfarich.js';

const pt = (s: string | undefined): number => Number((s ?? '0pt').replace('pt', ''));
const fld = (label: string, y: number, h: number, size = 10): LayoutNode => ({
  kind: 'field', label, geom: { x: '0pt', y: `${String(y)}pt`, w: '100pt', h: `${String(h)}pt` }, children: [],
  text: { paras: [{ base: { size } }] } as unknown as LeafText,
});
const drw = (label: string, y: number, h: number): LayoutNode =>
  ({ kind: 'draw', label, geom: { x: '0pt', y: `${String(y)}pt`, w: '100pt', h: `${String(h)}pt` }, children: [] });
const pos = (label: string, h: number, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'position', geom: { w: '540pt', h: `${String(h)}pt` }, keep: { intact: 'none' }, children, ...extra });
const at = (y: number, h: number, w = 216) => ({ geom: { x: '0pt', y: `${String(y)}pt`, w: `${String(w)}pt`, h: `${String(h)}pt` } });
const boxes: XfaChildBoxes = (n) => n.children
  .filter((k) => k.presence !== 'hidden' && k.presence !== 'inactive')
  .map((k) => ({ node: k, top: pt(k.geom.y), h: pt(k.geom.h) }));

describe('positionedSplittable (R1)', () => {
  it('is true only for a positioned subform stating keep intact="none"', () => {
    expect(positionedSplittable(pos('p', 288, []))).toBe(true);
    expect(positionedSplittable(pos('p', 288, [], { keep: undefined }))).toBe(false);      // t3
    expect(positionedSplittable(pos('p', 288, [], { keep: { intact: 'contentArea' } }))).toBe(false);
    expect(positionedSplittable(pos('p', 288, [], { layout: 'tb' }))).toBe(false);
    expect(positionedSplittable(pos('p', 288, [], { refusal: 'x' }))).toBe(false);
    expect(positionedSplittable({ ...drw('d', 0, 10), keep: { intact: 'none' } })).toBe(false);
  });
});

describe('positionedCut (R2-R8)', () => {
  it('cuts at the room left when nothing straddles it (t5)', () => {
    expect(positionedCut(pos('p', 288, [fld('a', 36, 21.6), fld('b', 108, 21.6), fld('c', 216, 21.6)]), 144, boxes)).toBe(144);
  });
  it('does not count a child whose top is exactly on the cut as straddling', () => {
    expect(positionedCut(pos('p', 288, [fld('c', 144, 21.6)]), 144, boxes)).toBe(144);
  });
  it('moves the cut to a straddling draw (t12)', () => {
    expect(positionedCut(pos('p', 288, [drw('dr', 120, 48)]), 144, boxes)).toBe(120);
  });
  it('moves the cut to a straddling subform that does not split (t13)', () => {
    const inner = pos('inner', 48, [fld('g', 0, 20)], { keep: undefined, ...at(120, 48) });
    expect(positionedCut(pos('p', 288, [inner]), 144, boxes)).toBe(120);
  });
  it('moves the cut to a field whose top piece is below its font size (t8, t19, t22)', () => {
    expect(positionedCut(pos('p', 288, [fld('f', 138, 48)]), 144, boxes)).toBe(138);
    expect(positionedCut(pos('p', 288, [fld('f', 135, 48)]), 144, boxes)).toBe(135);
    expect(positionedCut(pos('p', 288, [fld('f', 129, 60, 20)]), 144, boxes)).toBe(129);
  });
  it('refuses a field whose top piece reaches its font size (t20, t6), naming 164g.13', () => {
    for (const k of [fld('f', 134, 48), fld('b', 108, 72)]) {
      const r = positionedCut(pos('p', 288, [k]), 144, boxes);
      expect(r).toEqual({ refusal: `${k.label}: Adobe splits a field straddling a content-area break between its lines, which is not implemented (164g.13)` });
    }
  });
  it('repeats until nothing straddles (t7)', () => {
    // f clears the first cut (135 < 144) and straddles only the one d makes
    // (130): a single pass returns 130. Keep f FIRST or the case measures nothing.
    expect(positionedCut(pos('p', 864, [fld('f', 125, 10), drw('d', 130, 20)]), 144, boxes)).toBe(125);
    expect(positionedCut(pos('p', 864, [fld('c', 496.8, 21.6)]), 504, boxes)).toBeCloseTo(496.8, 9);
  });
  it('splits a straddling keep-none positioned child at the same cut (t24)', () => {
    const inner = pos('inner', 120, [fld('g', 0, 20), fld('k', 80, 20)], at(100, 120));
    expect(positionedCut(pos('p', 288, [inner]), 144, boxes)).toBe(144);
  });
  it('moves the cut by what a nested split decides', () => {
    const inner = pos('inner', 120, [drw('d', 30, 30)], at(100, 120));
    expect(positionedCut(pos('p', 288, [inner]), 144, boxes)).toBe(130);
  });
  it('returns 0 when a child covers the top (t25)', () => {
    expect(positionedCut(pos('p', 288, [drw('dr', 0, 200)]), 144, boxes)).toBe(0);
  });
  it('refuses a top or bottom margin, naming 164g.20, and allows left/right ones (t14)', () => {
    const want = { refusal: 'p: a positioned subform with a top or bottom margin is not split across content areas (164g.20)' };
    expect(positionedCut(pos('p', 288, [], { margin: { topInset: '18pt' } }), 144, boxes)).toEqual(want);
    expect(positionedCut(pos('p', 288, [], { margin: { bottomInset: '12pt' } }), 144, boxes)).toEqual(want);
    expect(positionedCut(pos('p', 288, [], { margin: { leftInset: '6pt', rightInset: '6pt' } }), 144, boxes)).toBe(144);
  });
  it('refuses a child anchored other than topLeft (R8)', () => {
    const k: LayoutNode = { ...fld('a', 36, 20), geom: { x: '0pt', y: '36pt', w: '100pt', h: '20pt', anchorType: 'bottomLeft' } };
    expect(positionedCut(pos('p', 288, [k]), 144, boxes))
      .toEqual({ refusal: 'a: a child anchored bottomLeft is not split with its positioned parent' });
  });
  it("carries the boxes callback's reason as a refusal", () => {
    expect(positionedCut(pos('p', 288, []), 144, () => ({ reason: 'nope' }))).toEqual({ refusal: 'nope' });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/xfasplitpos.test.ts`
Expected: FAIL -- cannot resolve `../src/xfasplitpos.js`.

- [ ] **Step 3: Implement**

```ts
// src/xfasplitpos.ts
/**
 * Splitting a positioned XFA subform across content areas (`164g.11`): where
 * the cut falls, and the fragments either side of it. The rules are what Adobe
 * Reader 26.1 does, measured by probe (`test/fixtures/xfa-adobe/`, spec
 * `docs/superpowers/specs/2026-10-14-xfa-split-positioned-design.md`, R1-R8).
 *
 * **Invariant: a pure leaf over `xfaflow.js` TYPES and `xfageom.js`.** Child
 * boxes arrive through a callback, so every rule is testable from hand-built
 * nodes. It never throws: a shape it cannot split is a named refusal.
 *
 * **Invariant: Adobe splits a positioned subform ONLY when it states
 * `keep intact="none"`.** XFA 3.3 p. 292 reads as `none` for any subform under
 * a flowing parent; Adobe treats a positioned one as unsplittable unless told
 * (t3 against t5), and Adobe is the oracle.
 */
import { measureToPt } from './xfageom.js';
import type { ChildBox, LayoutNode } from './xfaflow.js';

/** Tolerance for comparing summed measurements (`xfapage.ts`'s). */
const EPS = 1e-6;

/** A positioned container's children as pagination sees them (164g.11). */
export type XfaChildBoxes = (n: LayoutNode) => ChildBox[] | { reason: string };

/** R1 (t3, t5, t13): a positioned subform splits only when it states
 *  `<keep intact="none"/>`. Its parent's being a flow is the caller's to know. */
export function positionedSplittable(n: LayoutNode): boolean {
  return n.kind === 'subform' && (n.layout ?? 'position') === 'position'
    && n.refusal === undefined && n.keep?.intact === 'none';
}

const inset = (s: string | undefined): number => (s === undefined ? 0 : measureToPt(s) ?? NaN);
/** A field's font size: its base run's (`leafText`), XFA's 10pt default otherwise. */
const fontSizeOf = (f: LayoutNode): number => f.text?.paras[0]?.base.size ?? 10;

/**
 * Where `n` splits when `room` is left (R2-R8): the room, moved up to the top of
 * every straddling child that will not split, until none straddles. A cut of 0
 * means `n` cannot split here (R5).
 */
export function positionedCut(n: LayoutNode, room: number, boxes: XfaChildBoxes): number | { refusal: string } {
  // R7 (t14): Adobe's margins across a split are unresolved.
  if (inset(n.margin?.topInset) !== 0 || inset(n.margin?.bottomInset) !== 0)
    return { refusal: `${n.label}: a positioned subform with a top or bottom margin is not split across content areas (164g.20)` };
  const kids = boxes(n);
  if ('reason' in kids) return { refusal: kids.reason };
  // R8: fragments rewrite each child's y, which an anchor would reinterpret.
  for (const k of kids) {
    const a = k.node.geom.anchorType;
    if (a !== undefined && a !== 'topLeft')
      return { refusal: `${k.node.label}: a child anchored ${a} is not split with its positioned parent` };
  }
  let cut = room;
  for (let moved = true; moved;) {
    moved = false;
    for (const k of kids) {
      // Straddling: top above the cut and bottom below it (a top ON the cut is not).
      if (!(k.top < cut - EPS && k.top + k.h > cut + EPS)) continue;
      let next = k.top;
      if (positionedSplittable(k.node)) {
        // R3 (t24): a keep-none positioned child splits at the same cut.
        const inner = positionedCut(k.node, cut - k.top, boxes);
        if (typeof inner === 'object') return inner;
        next = k.top + inner;
      } else if (k.node.kind === 'field' && cut - k.top >= fontSizeOf(k.node) - EPS) {
        // R4 (t6, t9-t11, t20): Adobe splits this field; its rule is 164g.13's.
        return { refusal: `${k.node.label}: Adobe splits a field straddling a content-area break between its lines, which is not implemented (164g.13)` };
      }
      // R2 (t7, t8, t12, t13, t17-t19, t22): a draw, an unsplittable subform,
      // or a field whose top piece is below its font size moves the cut up.
      if (next < cut - EPS) { cut = next; moved = true; }
    }
  }
  return cut;
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/xfasplitpos.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/xfasplitpos.ts test/xfasplitpos.test.ts
git commit -m "feat(164g.11): positionedCut, Adobe's split consensus for a positioned subform"
```

---

### Task 4: `positionedFragment`

**Files:**
- Modify: `src/xfasplitpos.ts`
- Test: `test/xfasplitpos.test.ts` (append)

**Interfaces:**
- Produces: `export function positionedFragment(n: LayoutNode, from: number, to: number, boxes: XfaChildBoxes): LayoutNode | { refusal: string }` -- a shallow copy of `n` with `geom.h` = `${to - from}pt`, no `minMax`, holding the children whose top lies in `[from, to)` with `geom.y` shifted by `-from`; a splittable child crossing `from` or `to` is replaced by its own fragment; hidden/inactive children only in the fragment with `from === 0`; document order kept.

- [ ] **Step 1: Write the failing tests**

Append to `test/xfasplitpos.test.ts` (and add `positionedFragment` to its import):

```ts
describe('positionedFragment (R6)', () => {
  const frag = (n: LayoutNode, from: number, to: number) => {
    const f = positionedFragment(n, from, to, boxes);
    if ('refusal' in f) throw new Error(f.refusal);
    return f;
  };
  const show = (f: LayoutNode): string =>
    `${f.label}@${f.geom.y ?? '-'}:${f.geom.h ?? '-'}(${f.children.map(show).join(',')})`;

  it('keeps each child in the fragment holding its top, shifted (t5)', () => {
    const p = pos('p', 288, [fld('a', 36, 21.6), fld('b', 108, 21.6), fld('c', 216, 21.6)]);
    expect(show(frag(p, 0, 144))).toBe('p@-:144pt(a@36pt:21.6pt(),b@108pt:21.6pt())');
    expect(show(frag(p, 144, 288))).toBe('p@-:144pt(c@72pt:21.6pt())');
  });
  it('puts a child whose top is on the cut in the later fragment', () => {
    const p = pos('p', 288, [fld('c', 144, 21.6)]);
    expect(frag(p, 0, 144).children).toEqual([]);
    expect(frag(p, 144, 288).children.map((k) => k.geom.y)).toEqual(['0pt']);
  });
  it('allows an empty fragment (t26)', () => {
    expect(show(frag(pos('p', 288, [fld('g', 200, 20)]), 0, 144))).toBe('p@-:144pt()');
  });
  it('splits a keep-none positioned child into its own fragments (t24)', () => {
    const p = pos('p', 288, [pos('inner', 120, [fld('g', 0, 20), fld('k', 80, 20)], at(100, 120))]);
    expect(show(frag(p, 0, 144))).toBe('p@-:144pt(inner@100pt:44pt(g@0pt:20pt()))');
    expect(show(frag(p, 144, 288))).toBe('p@-:144pt(inner@0pt:76pt(k@36pt:20pt()))');
  });
  it('keeps hidden children in the first fragment, in document order', () => {
    const h: LayoutNode = { ...fld('h', 250, 10), presence: 'hidden' };
    const p = pos('p', 288, [fld('a', 36, 20), h, fld('c', 216, 20)]);
    expect(frag(p, 0, 144).children.map((k) => k.label)).toEqual(['a', 'h']);
    expect(frag(p, 144, 288).children.map((k) => k.label)).toEqual(['c']);
  });
  it('states h on a growable subform and drops its minMax', () => {
    const p = { ...pos('p', 288, [fld('a', 36, 20)]), geom: { w: '540pt' }, minMax: { minH: '100pt' } };
    const f = frag(p, 0, 144);
    expect([f.geom.h, f.minMax]).toEqual(['144pt', undefined]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/xfasplitpos.test.ts`
Expected: FAIL -- `positionedFragment` is not exported.

- [ ] **Step 3: Implement**

Append to `src/xfasplitpos.ts`:

```ts
const concealed = (c: LayoutNode): boolean => c.presence === 'hidden' || c.presence === 'inactive';

/**
 * The part of `n` between `from` and `to` (R6; t5, t15, t24, t26): a shallow
 * copy stating `h = to - from`, holding the children whose top falls in
 * `[from, to)` at their y minus `from`. After `positionedCut` no unsplittable
 * child straddles a cut, so each leaf lands in exactly one fragment and keeps
 * its SOM name; a keep-none positioned child crossing an edge is represented by
 * its own fragment (R3). A fragment may hold nothing (t26). Hidden children take
 * no space (p. 67) and ride in the first fragment so their fields stay known.
 */
export function positionedFragment(
  n: LayoutNode, from: number, to: number, boxes: XfaChildBoxes,
): LayoutNode | { refusal: string } {
  const kids = boxes(n);
  if ('reason' in kids) return { refusal: kids.reason };
  const box = new Map(kids.map((k) => [k.node, k]));
  const children: LayoutNode[] = [];
  for (const c of n.children) {
    if (concealed(c)) { if (from <= EPS) children.push(c); continue; }
    const k = box.get(c);
    if (k === undefined) continue;
    const bottom = k.top + k.h;
    const crosses = k.top < from - EPS || bottom > to + EPS;
    if (positionedSplittable(c) && crosses && k.top < to - EPS && bottom > from + EPS) {
      const f = positionedFragment(c, Math.max(0, from - k.top), Math.min(k.h, to - k.top), boxes);
      if ('refusal' in f) return f;
      children.push({ ...f, geom: { ...f.geom, y: `${String(Math.max(k.top, from) - from)}pt` } });
    } else if (k.top >= from - EPS && k.top < to - EPS) {
      children.push({ ...c, geom: { ...c.geom, y: `${String(k.top - from)}pt` } });
    }
  }
  const { minMax: _stated, ...rest } = n;
  void _stated;
  return { ...rest, geom: { ...n.geom, h: `${String(to - from)}pt` }, children };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/xfasplitpos.test.ts`
Expected: PASS, 20 tests. If a `show` string differs only by floating-point formatting (e.g. `72.00000000000001pt`), round in the IMPLEMENTATION: write y and h through `const pt = (v: number) => \`${String(Math.round(v * 1e6) / 1e6)}pt\`` and use it for both.

- [ ] **Step 5: Commit**

```bash
git add src/xfasplitpos.ts test/xfasplitpos.test.ts
git commit -m "feat(164g.11): positionedFragment, the geometric pieces of a split positioned subform"
```

---

### Task 5: Pagination splits a keep-none positioned root child

**Files:**
- Modify: `src/xfapage.ts` (`paginate`, a new `placePositioned`, `layoutPages`)
- Modify: `src/xfaflow.ts:47` (`SPLIT_LATER`)
- Test: `test/xfapage.test.ts` (append a describe)

**Interfaces:**
- Consumes: `positionedSplittable`, `positionedCut`, `positionedFragment`, `XfaChildBoxes` (Tasks 3-4); `positionedChildBoxes` (Task 2).
- Produces: `paginate(body: XfaBody, height: XfaHeight, boxes?: XfaChildBoxes): Pagination` -- with `boxes` omitted nothing splits geometrically (today's behaviour). `layoutPages` passes `(n) => positionedChildBoxes(n, measure)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/xfapage.test.ts` (add `import type { XfaChildBoxes } from '../src/xfasplitpos.js';` and `import type { LeafText } from '../src/xfarich.js';` at the top):

```ts
// 164g.11: a positioned subform stating keep intact="none" splits where Adobe
// Reader does (test/fixtures/xfa-adobe/). Content area 720 tall; O + F leave 144.
describe('paginate: splitting a keep-none positioned root child (164g.11)', () => {
  const fld = (label: string, y: number, h: number): LayoutNode => ({
    kind: 'field', label, field: `pos.${label}`, geom: { x: '0pt', y: `${String(y)}pt`, w: '100pt', h: `${String(h)}pt` },
    children: [], text: { paras: [{ base: { size: 10 } }] } as unknown as LeafText,
  });
  const drw = (label: string, y: number, h: number): LayoutNode =>
    ({ kind: 'draw', label, geom: { x: '0pt', y: `${String(y)}pt`, w: '100pt', h: `${String(h)}pt` }, children: [] });
  const P = (h: number | undefined, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode => ({
    kind: 'subform', label: 'P', layout: 'position', geom: h === undefined ? { w: '540pt' } : { w: '540pt', h: `${String(h)}pt` },
    keep: { intact: 'none' }, children, ...extra,
  });
  const posBoxes: XfaChildBoxes = (n) => n.children
    .filter((k) => k.presence !== 'hidden' && k.presence !== 'inactive')
    .map((k) => ({ node: k, top: pt(k.geom.y), h: hOf(k) }));
  // A growable positioned subform's height is its lowest child's bottom.
  const posHeight: XfaHeight = (n) => (n.layout === 'position' && n.geom.h === undefined
    ? { h: Math.max(0, ...n.children.map((k) => pt(k.geom.y) + hOf(k))), past: false } : flowHeight(n, Infinity));
  const lead = [kid('O', 216), kid('F', 360)];
  const run = (kids: LayoutNode[], b = body([area([ca(720)])], kids)) => paginate(b, posHeight, posBoxes);
  const regions = (kids: LayoutNode[], b?: XfaBody) => run(kids, b).pages.map((p) => p.contentAreas.map((c) => c.children
    .map((k) => (k.label === 'P' ? `P:${k.geom.h ?? ''}(${k.children.map((x) => `${x.label}@${x.geom.y ?? ''}`).join(',')})` : k.label))
    .join(' ')).join('|'));

  it('puts the top into the room left and the rest on the next page (t5)', () => {
    expect(regions([...lead, P(288, [fld('a', 36, 21.6), fld('b', 108, 21.6), fld('c', 216, 21.6)])]))
      .toEqual(['O F P:144pt(a@36pt,b@108pt)', 'P:144pt(c@72pt)']);
  });
  it('moves a default positioned subform whole, as before (t3)', () => {
    expect(regions([...lead, P(288, [fld('a', 36, 21.6)], { keep: undefined })])).toEqual(['O F', 'P']);
  });
  it('does not split without the boxes callback', () => {
    const r = paginate(body([area([ca(720)])], [...lead, P(288, [fld('a', 36, 21.6)])]), posHeight);
    expect(r.pages.map((p) => p.contentAreas[0].children.map((k) => k.label).join(' '))).toEqual(['O F', 'P']);
  });
  it('splits again while the rest is taller than a page (t15)', () => {
    expect(regions([...lead, P(1800, [fld('f', 100, 20), fld('h', 900, 20), fld('k', 1700, 20)])]))
      .toEqual(['O F P:144pt(f@100pt)', 'P:720pt()', 'P:720pt(h@36pt)', 'P:216pt(k@116pt)']);
  });
  it('moves it whole when the cut reaches the top (t25)', () => {
    expect(regions([...lead, P(288, [drw('dr', 0, 200), fld('g', 250, 20)])])).toEqual(['O F', 'P']);
  });
  it('splits a growable keep-none subform, stating h on each fragment', () => {
    expect(regions([...lead, P(undefined, [fld('a', 36, 20), fld('c', 216, 20)])]))
      .toEqual(['O F P:144pt(a@36pt)', 'P:92pt(c@72pt)']);
  });
  it('refuses a split it cannot make and places nothing of it (t6)', () => {
    const p = P(288, [fld('a', 36, 21.6), fld('b', 108, 72)]);
    const r = run([...lead, p, kid('Z', 10)]);
    expect(r.refused.get(p)).toBe('b: Adobe splits a field straddling a content-area break between its lines, which is not implemented (164g.13)');
    expect(r.pages.map((pg) => pg.contentAreas[0].children.map((k) => k.label).join(' '))).toEqual(['O F']);
    expect([...r.refused.keys()].map((n) => n.label)).toEqual(['P', 'Z']);
  });
  it('refuses a split whose rest has no page left, placing nothing (occur max)', () => {
    const p = P(1000, [fld('a', 36, 20)]);
    const b = body([area([ca(720)], { max: 1 })], [...lead, p], { max: 1 });
    const r = run([], b);
    expect(r.refused.get(p)).toMatch(/discarded/);
    expect(r.pages[0].contentAreas[0].children.map((k) => k.label)).toEqual(['O', 'F']);
  });
  it('refuses a keep-none subform with an <overflow> that would continue (164g.15)', () => {
    const p = P(288, [fld('a', 36, 21.6)], { overflow: true });
    expect(run([...lead, p]).refused.get(p)).toMatch(/164g\.15/);
  });
  it('names 164g.19 when a default positioned subform is taller than an empty page', () => {
    expect(SPLIT_LATER).toMatch(/164g\.19/);
    expect(SPLIT_LATER).not.toMatch(/164g\.11/);
  });
});

describe('layoutPages: a split positioned subform (164g.11)', () => {
  const fld = (label: string, y: number, h: number): LayoutNode => ({
    kind: 'field', label, field: label, geom: { x: '0pt', y: `${String(y)}pt`, w: '100pt', h: `${String(h)}pt` }, children: [],
  });
  it("lays each fragment's fields out on its own page (t24's nesting)", () => {
    const inner: LayoutNode = { kind: 'subform', label: 'inner', layout: 'position', keep: { intact: 'none' },
      geom: { x: '0pt', y: '100pt', w: '216pt', h: '120pt' }, children: [fld('g', 0, 20), fld('k', 80, 20)] };
    const p: LayoutNode = { kind: 'subform', label: 'P', layout: 'position', keep: { intact: 'none' },
      geom: { w: '540pt', h: '288pt' }, children: [inner] };
    const r = layoutPages(body([area([ca(720)])], [kid('O', 216), kid('F', 360), p]));
    expect(r.pages.length).toBe(2);
    expect(r.pages[0].placed.get('g')).toEqual({ box: { x: 0, y: 676, w: 100, h: 20 } });
    expect(r.pages[1].placed.get('k')).toEqual({ box: { x: 0, y: 36, w: 100, h: 20 } });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/xfapage.test.ts`
Expected: FAIL in the two new describes (no geometric split happens; `SPLIT_LATER` still names 164g.11).

- [ ] **Step 3: Implement**

In `src/xfaflow.ts` change line 47 to:

```ts
export const SPLIT_LATER = 'splitting beyond a tb subform between its children (164g.12, 164g.13, 164g.19)';
```

In `src/xfapage.ts` add to the imports:

```ts
import {
  positionedCut, positionedFragment, positionedSplittable, type XfaChildBoxes,
} from './xfasplitpos.js';
```

and `positionedChildBoxes` to the existing `./xfaflow.js` import list.

Add, after `emptyRegion`:

```ts
/** Split a keep-none positioned root child from the room left (164g.11, spec
 *  R1-R8). EVERY cut is decided before anything is placed, so a refusal places
 *  nothing and the child is refused whole: its fields would otherwise land on
 *  some pages and be refused on others. `'whole'` is R5 at the first region --
 *  the cut reached the top -- and the caller places it whole by today's rules. */
function placePositioned(p: Paginator, c: LayoutNode, h: number, boxes: XfaChildBoxes): 'whole' | string | undefined {
  const s = p.snapshot();
  const plan: Array<{ node: LayoutNode; h: number }> = [];
  let cur = c;
  let left = h;
  for (;;) {
    const room = p.capacity() - p.used;
    if (left <= room + EPS) { plan.push({ node: cur, h: left }); break; }
    const cut = positionedCut(cur, room, boxes);
    if (typeof cut === 'object') { p.restore(s); return cut.refusal; }
    if (cut <= EPS) {
      p.restore(s);
      return plan.length === 0 ? 'whole'
        : `${c.label}: does not fit an empty content area and would need ${SPLIT_LATER}`;
    }
    if (c.overflow) {
      p.restore(s);
      return `${c.label}: its <overflow> leader or trailer would be inserted as it continues into the next region, which is not implemented (164g.15)`;
    }
    const head = positionedFragment(cur, 0, cut, boxes);
    const tail = positionedFragment(cur, cut, left, boxes);
    if ('refusal' in head) { p.restore(s); return head.refusal; }
    if ('refusal' in tail) { p.restore(s); return tail.refusal; }
    plan.push({ node: head, h: cut });
    const moved = p.advance();
    if (moved !== undefined) { p.restore(s); return moved; }
    cur = tail;
    left -= cut;
  }
  p.restore(s);
  plan.forEach((f, i) => {
    if (i > 0) p.advance();
    p.place(f.node, f.h);
  });
  return undefined;
}
```

Change `paginate`'s signature to `export function paginate(body: XfaBody, height: XfaHeight, boxes?: XfaChildBoxes): Pagination {`, and in its root-child loop insert, immediately after the `if (split) { ... break; }` block and before `if (p.used === 0) {`:

```ts
      if (boxes && positionedSplittable(c)) {
        // 164g.11: a keep-none positioned root child splits where Adobe does.
        const why = placePositioned(p, c, r.h, boxes);
        if (why === undefined) { placed = true; break; }
        if (why !== 'whole') { fail(why); break; }
      }
```

In `layoutPages`, change the `paginate` call to:

```ts
  const pg = paginate(body, (n, limit) => measureExtent(n, limit, measure, [], 'tb'),
    (n) => positionedChildBoxes(n, measure));
```

Update `splittable`'s doc comment's last sentence to read: `(a positioned subform splits geometrically instead, when it states keep intact="none" -- xfasplitpos.ts, 164g.11)`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/xfapage.test.ts test/xfasplitpos.test.ts test/xfaflow-positioned-boxes.test.ts`
Expected: PASS. Then run the whole XFA area for regressions:
`npx vitest run test/xfa`
Expected: PASS -- every existing oracle (`xfa-real`, `xfa-dynamic-oracle`, `xfa-master-oracle`, `xfa-chrome-oracle`, `xfa-chrome-fence`) unchanged: no vendored form states `keep intact="none"` on a positioned subform.

- [ ] **Step 5: Commit**

```bash
git add src/xfapage.ts src/xfaflow.ts test/xfapage.test.ts
git commit -m "feat(164g.11): paginate splits a keep-none positioned root child across pages"
```

---

### Task 6: The Adobe oracle, end to end

**Files:**
- Test: `test/xfa-adobe-oracle.test.ts`

**Interfaces:**
- Consumes: `adobeGoldens`, `loadAdobeProbe`, `ADOBE_PROBES`, `AdobeFrag` (Task 1); `ConvertXfaToAcroForm` (existing).

- [ ] **Step 1: Write the test**

```ts
// test/xfa-adobe-oracle.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PdfObject } from '../src/types.js';
import { ADOBE_PROBES, adobeGoldens, loadAdobeProbe, type AdobeFrag, type AdobeProbe } from './helpers/xfa-adobe.js';

/**
 * The Adobe Reader oracle for splitting a positioned subform (164g.11): each
 * probe in test/fixtures/xfa-adobe/ converted from its template and compared,
 * field by field, with the layout Adobe Reader 26.1 reported for it.
 *
 * Its ceiling: one producer, one version, hand-transcribed numbers.
 */
const g = adobeGoldens();
/** US Letter; every probe's content area sits at (0.5in, 0.5in). */
const PAGE_H = 792;
const ORIGIN = 36;
const TOL = 0.05;
const som = (path: string): string => path.split('.').map((s) => `${s}[0]`).join('.');

/** A field's expected rect in PDF space: its own fragment plus, on the same
 *  page, every ancestor subform's fragment and content inset. */
function expected(probe: AdobeProbe, path: string, f: AdobeFrag): { page: number; rect: number[] } | string {
  const [page, fx, fy, w, h] = f;
  let x = ORIGIN + fx;
  let y = ORIGIN + fy;
  const parts = path.split('.');
  for (let i = 2; i < parts.length; i++) {
    const anc = parts.slice(0, i).join('.');
    const frag = probe.subforms[anc]?.find((a) => a[0] === page);
    if (!frag) return `${anc} has no fragment on page ${String(page)}`;
    const [l, t] = probe.insets?.[anc] ?? [0, 0];
    x += frag[1] + l;
    y += frag[2] + t;
  }
  return { page, rect: [x, PAGE_H - y - h, x + w, PAGE_H - y] };
}

for (const name of ADOBE_PROBES) {
  const probe = g.probes[name];
  describe(`Adobe oracle: ${name}`, () => {
    const src = Document.Open(loadAdobeProbe(name));
    const report = src.ConvertXfaToAcroForm();
    const doc = Document.Open(src.Save());

    if (probe.expect === 'match') {
      it("produces Adobe's page count", () => {
        expect(doc.Pages.length).toBe(probe.pages);
      });
      it("puts every field on Adobe's page and box", () => {
        const widgets = new Map(doc.Form.Fields.map((fld) => {
          const page = doc.Pages.findIndex((pg) => ((doc.resolve(pg.Dict.get('Annots')) ?? []) as PdfObject[])
            .some((a) => doc.resolve(a) === fld.Dict));
          return [fld.FullName, { page: page + 1, rect: doc.resolve(fld.Dict.get('Rect')) as number[] }];
        }));
        const wrong: string[] = [];
        for (const [path, frags] of Object.entries(probe.fields)) {
          const want = expected(probe, path, frags[0]);
          const got = widgets.get(som(path));
          if (typeof want === 'string') { wrong.push(`${path}: ${want}`); continue; }
          if (!got || got.page !== want.page || got.rect.some((v, i) => Math.abs(v - want.rect[i]) > TOL))
            wrong.push(`${path}: want p${String(want.page)} [${want.rect.join(' ')}], got ${got ? `p${String(got.page)} [${got.rect.join(' ')}]` : 'nothing'}`);
        }
        expect(wrong).toEqual([]);
      });
    } else {
      it(`refuses the positioned subform's fields, naming ${String(probe.reason)}`, () => {
        const hits = report.skipped.filter((s) => s.what === 'field' && s.name?.startsWith('form1[0].pos[0].'));
        expect(hits.length).toBeGreaterThan(0);
        for (const h of hits) expect(h.reason).toContain(String(probe.reason));
      });
    }
  });
}
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/xfa-adobe-oracle.test.ts`
Expected: PASS for all 24 probes. On a mismatch, read the failure's `want`/`got` and the probe's capture; a disagreement is a bug in Tasks 2-5 or a transcription error in `adobe.json` (fix the json only if the capture shows a different number).

- [ ] **Step 3: Mutation sweep**

For each mutation, apply it, run `npx vitest run test/xfa-adobe-oracle.test.ts test/xfasplitpos.test.ts test/xfapage.test.ts`, record the failing test names, then revert with `git checkout -- src/`. Confirm each mutation actually changed the file (`git diff --stat`) before trusting a green result. Every one must redden at least one test:

1. `positionedSplittable`: drop `&& n.keep?.intact === 'none'` (splits a default subform -- t3 reddens).
2. `positionedCut`: replace `for (let moved = true; moved;)` with a single pass (`let moved = false;` after one loop) -- the repeat case reddens.
3. `positionedCut`: `cut - k.top >= fontSizeOf(k.node) - EPS` → `cut - k.top > fontSizeOf(k.node) + EPS` -- t20 reddens.
4. `positionedCut`: replace the R3 branch with `next = k.top` (no recursion) -- t24 reddens.
5. `positionedFragment`: drop the `-from` shift (`y: \`${String(k.top)}pt\``) -- t5/t15 redden.
6. `positionedFragment`: skip a fragment with no children (return `{ refusal: 'empty' }` when `children.length === 0`) -- t26 reddens.
7. `positionedCut`: delete the R7 margin check -- the margin case reddens.
8. `placePositioned`: place each head as it is planned instead of after planning (move `p.place(...)` into the loop and drop the replay) -- the t6 "places nothing" case reddens.

Record the results in the commit message body.

- [ ] **Step 4: Commit**

```bash
git add test/xfa-adobe-oracle.test.ts
git commit -m "test(164g.11): Adobe Reader oracle for positioned splitting, 24 probes"
```

---

### Task 7: Documentation, quality gates, close

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`, newest first)
- Modify: `CLAUDE.md` (new `xfasplitpos.ts` entry after the `xfapage.ts` entry; a fixtures-table row for `fixtures/xfa-adobe/`)
- Modify: `README.md:200` (the XFA capability paragraph)

- [ ] **Step 1: CHANGELOG**

Insert first under `### Added`:

```markdown
- **`ConvertXfaToAcroForm` splits a positioned subform across pages, as Adobe Reader does.** A `layout="position"` subform that states `<keep intact="none"/>` and does not fit the room left on a page is now split there, its top on this page and the rest on the next, again and again while the rest is taller than a page. Where the cut falls is Adobe's split consensus: the room left, moved up to the top of any child that straddles it and will not split -- a draw, a subform that does not split, or a field whose piece above the cut is smaller than its font size -- and a keep-none positioned child splits at the same cut. A subform with no such statement is moved whole, as before: Adobe treats a positioned subform as unsplittable unless told, contrary to XFA 3.3's default, and Adobe is the oracle. Every rule was measured in Adobe Reader 26.1 itself, through 24 probe forms whose layout Reader reported through `xfa.layout` (`test/fixtures/xfa-adobe/`); every field of the 17 probes we lay out lands on Reader's page and box. What Reader does and we do not yet is refused and reported: a field Reader would split between its lines (164g.13), a splitting subform with a top or bottom margin (164g.20), a child anchored other than top-left, and an over-tall subform that does not split, which Reader lets overflow the page (164g.19). (aspose-pdf-foss-for-ts-164g.11)
```

- [ ] **Step 2: CLAUDE.md**

After the `- **xfapage.ts**` entry (it ends with the line beginning `**Note, measured:** all 18 mutations aimed at this issue redden.`), insert:

```markdown
- **xfasplitpos.ts** — splitting a positioned XFA subform across content
  areas (`164g.11`): `positionedSplittable` (R1), `positionedCut` (Adobe's
  split consensus, R2-R8) and `positionedFragment` (R6), over child boxes from
  `xfaflow.ts`'s `positionedChildBoxes`. A pure leaf over `xfaflow.js` TYPES
  and `xfageom.js`; it never throws. `xfapage.ts`'s root-child loop calls it
  through `placePositioned`.
  **Invariant, and XFA 3.3 says otherwise:** a positioned subform splits ONLY
  when it states `<keep intact="none"/>`. p. 292 makes `none` the default under
  a flowing parent; Adobe Reader moves such a subform whole (probe t3) and
  splits it only when told (t5). Adobe is the oracle.
  **Invariant:** every cut is planned BEFORE anything is placed, so a refusal
  places nothing and the subform is refused whole; placing as it plans would
  leave its fields on some pages and refused on others.
  **Invariant:** the cut moves up to a straddling draw, an unsplittable
  subform, or a field whose piece above the cut is below its font size, and
  repeats until nothing straddles (t7, t8, t12, t13, t17-t19, t22); a field
  whose piece reaches its font size is one Adobe SPLITS, and that is refused
  (164g.13), as are top/bottom margins (164g.20) and anchored children. A
  fragment may hold nothing (t26). Only ROOT children split; in a 164g.8 chain
  a positioned subform is still whole (164g.21).
  **Note on the oracle:** `test/fixtures/xfa-adobe/` is ADOBE's layout, read
  through `xfa.layout` in Reader and transcribed by hand from window captures
  -- Reader will not save these forms and a folder-level trusted function is
  invisible to XFA scripts. One producer, one version. Unlike pdf.js
  (`fixtures/xfa-dynamic/`), it is Adobe itself, but it is not re-runnable in
  CI.
```

In the fixtures table, after the `fixtures/xfa/` row, add:

```markdown
| `fixtures/xfa-adobe/` | `PROVENANCE.md` | 24 dynamic XFA probes laid out by **Adobe Acrobat Reader 26.1** itself, each reporting Adobe's `xfa.layout` page and box for every node into a field on page 1, transcribed by hand from window captures into `adobe.json` (Reader will not save them). The oracle for splitting a positioned subform (164g.11): it showed Adobe splits one only under `keep intact="none"`, contrary to XFA 3.3's default, and pinned the split-consensus rules. pdf.js cannot serve here -- it never splits a positioned subform. One producer, one version (`test/xfa-adobe-oracle.test.ts`) |
```

- [ ] **Step 3: README**

In `README.md` line 200, replace the final sentence `Content is never split across pages.` with:

```markdown
A `tb` subform too tall for the room left is split between its children, and a positioned subform that states `keep intact="none"` is split where Adobe Reader splits it; other content moves to the next page whole.
```

Then search the "Convert an XFA Form to an AcroForm" section (`grep -n "split" README.md`) for any sentence claiming content is never split, and make it agree.

- [ ] **Step 4: Quality gates**

Run: `npm run typecheck`
Expected: no output, exit 0.
Run: `npx vitest run`
Expected: all files pass.
Run: `npx vitest run test/readme-api.test.ts test/import-cycles.test.ts test/limits-catch.test.ts`
Expected: PASS (no new export, no new import cycle, no new catch).
Run the CLAUDE.md module sweep from Git Bash:
`for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done`
Expected: empty output.

- [ ] **Step 5: Commit, close, push**

```bash
git add CHANGELOG.md CLAUDE.md README.md
git commit -m "docs(164g.11): CHANGELOG, CLAUDE.md, README for positioned splitting"
bd close aspose-pdf-foss-for-ts-164g.11 --reason "Keep-none positioned root child splits by Adobe's split consensus; 24 Adobe Reader probes, all fields of 17 laid-out probes on Adobe's page and box; refusals cite 164g.13/.19/.20; in-chain is 164g.21."
git add .beads/interactions.jsonl
git commit -m "chore(beads): close 164g.11"
git pull --rebase --autostash
git push
git status -sb
```

Expected: `## main...origin/main` with no ahead/behind. Do not stage anything under `_my/`.
