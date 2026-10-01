# DOCX Import (`AddDocx`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `flow.AddDocx`, `page.AddDocx`, `doc.AddDocx` and `docxFileToPdf`, which render a `.docx` through the flow engine as a documented subset and report every construct they do not render.

**Architecture:** `readDocx` (existing) resolves the package to a `WmlDocument`; a new pure mapper `wmlflow.ts` (with `wmlruns.ts` for inline content) lowers it to `FlowElement[]` segments split at page breaks plus a counted `skipped` report; a new wiring module `wmlimport.ts` supplies fonts and image bytes and is what the three entry points share. The flow engine gains two opt-in options — a per-item list `label` and a paragraph `indent` — so Word's labels and indents render faithfully.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest, no runtime dependencies. Windows PowerShell + Word 2010 COM for the one oracle task.

**Spec:** `docs/superpowers/specs/2026-09-30-docx-import-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins.
- Import specifiers carry `.js`; `strict` TypeScript.
- The `docx*` module prefix belongs to the WRITER; every new reader-side module is `wml*`.
- Public option bag is `DocxFlowOptions` (NOT `DocxOptions`, which is `ToDocx`'s).
- `DocxSkipped = { name: string; count: number; kind: 'dropped' | 'degraded' }`; `skipped` sorted by name, one record per (name, kind), a FRESH array on every return.
- Every `catch` in `src/` calls `rethrowLimit(caught)` first (`test/limits-catch.test.ts` enforces it); a bindingless `catch {` is `catch (caught) {`.
- A rejected call leaves the document byte-identical: options are validated before any page is allocated; a bad option is `TypeError`.
- The two flow additions change NOTHING for a caller who does not pass them: `test/rich-runs-identity.test.ts`, `test/markdown-flow.test.ts` and `test/html-identity.test.ts` must stay green UNEDITED.
- Place every DOCX flow with `paragraphSpacing: 0`.
- Bash heredocs strip backslashes on this machine: write code with the Write/Edit tools, never `cat <<EOF`. There is no Python; one-off scripts are node.
- Run `npm run typecheck` and `npm test` before closing; both green.
- Update `CHANGELOG.md` under `## [Unreleased]` → `### Added` in the task that ships the public API (Task 12).

## Review Focus

1. **A table whose `tblGrid` is wider than the column** — common, since Word tables run into the margins: it must scale to the column, not overflow the page. Pinned in Task 11.
2. **Body text with no `w:rFonts` anywhere** (props.font undefined — a document relying on Word's built-in default): must render in a serif face (Word's default is Times New Roman) and report nothing about fonts. Pinned in Task 7.
3. **A numbered list interrupted by an ordinary paragraph and then resumed**: the resumed items must show Word's continued labels (`3.` not `1.`), which requires the label to come from `readDocx`, never from `list()`'s own counter. Pinned in Task 10.
4. **A numbered heading** (`1.2 Scope` — outline numbering on a heading style): it must stay a heading (`/H2`) with its label drawn in front, not be swallowed into a list. Pinned in Task 10.
5. **A vertical merge in a row shifted by `gridBefore`**: `rowSpan` must be counted down the GRID column, not the cell index. Pinned in Task 11.

---

### Task 1: Pin Word's paragraph spacing against Word itself (gate)

The spec assumes Word ADDS a paragraph's space-after to the next one's space-before (the flow engine adds them). This task measures it. **If Word collapses (gap = max) rather than adds, STOP and revise Tasks 6 and 8 before continuing.**

**Files:**
- Create: `test/helpers/build-spacing-oracle.ts`
- Create: `scripts/gen-spacing-oracle.ts`
- Create: `scripts/gen-spacing-oracle.ps1`
- Create (generated, committed): `test/fixtures/docx/spacing-oracle.docx`, `test/fixtures/docx/spacing-oracle.json`
- Create: `test/spacing-oracle.test.ts`
- Modify: `test/fixtures/docx/PROVENANCE.md` (append a section)
- Modify: `test/docx-corpus.test.ts:14` (`NOT_CORPUS` gains `'spacing-oracle.docx'`)

**Interfaces:**
- Produces: `buildSpacingOracleDocx(): Uint8Array`; `spacing-oracle.json` = `{ word: string; paragraphs: { text: string; top: number }[] }`, `top` in points from the page top.

- [ ] **Step 1: Write the builder**

`test/helpers/build-spacing-oracle.ts` — three paragraphs with EXACT line spacing (20pt, so a line's height is known without font metrics), and before/after values chosen so add and max differ:

```ts
/** m2fp.5's spacing oracle: three paragraphs with exact 20pt lines. P1 after=12,
 *  P2 before=18 after=6, P3 before=30. Additive spacing puts P2 at 20+12+18=50pt
 *  below P1 and P3 at 20+6+30=56pt below P2; collapsing puts them at 38 and 50.
 *  Byte-reproducible: buildOoxmlPackage writes no clock. */
import { buildOoxmlPackage } from '../../src/ooxml.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const para = (text: string, before: number, after: number): string =>
  `<w:p><w:pPr><w:spacing w:before="${before * 20}" w:after="${after * 20}" w:line="400" w:lineRule="exact"/></w:pPr>`
  + `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>`
  + para('One', 0, 12) + para('Two', 18, 6) + para('Three', 30, 0)
  + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
  + '</w:body></w:document>';

export function buildSpacingOracleDocx(): Uint8Array {
  return buildOoxmlPackage(
    [{ path: 'word/document.xml', bytes: enc(DOCUMENT), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' }],
    [{ source: '', id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' }]);
}
```

- [ ] **Step 2: Write the generator scripts**

`scripts/gen-spacing-oracle.ts`:

```ts
// Writes test/fixtures/docx/spacing-oracle.docx (m2fp.5). Run by gen-spacing-oracle.ps1,
// which then has Word lay it out; not run by npm test.
import { writeFileSync } from 'node:fs';
import { buildSpacingOracleDocx } from '../test/helpers/build-spacing-oracle.js';

writeFileSync(process.argv[2] ?? 'test/fixtures/docx/spacing-oracle.docx', buildSpacingOracleDocx());
```

`scripts/gen-spacing-oracle.ps1` (mirrors `scripts/gen-wml-oracle.ps1`; `Information(6)` is `wdVerticalPositionRelativeToPage`, in points):

```powershell
# m2fp.5's spacing oracle: build spacing-oracle.docx, have Word 2010 lay it out
# through COM, and record each paragraph's vertical position from the page top.
# NOT run by npm test: it needs Word.
param(
  [string]$Docx = (Join-Path $PSScriptRoot '..\test\fixtures\docx\spacing-oracle.docx'),
  [string]$Json = (Join-Path $PSScriptRoot '..\test\fixtures\docx\spacing-oracle.json'))
$ErrorActionPreference = 'Stop'
$Docx = [IO.Path]::GetFullPath($Docx); $Json = [IO.Path]::GetFullPath($Json)
Push-Location (Join-Path $PSScriptRoot '..')
try { npx tsx scripts/gen-spacing-oracle.ts $Docx; if ($LASTEXITCODE) { throw 'builder failed' } } finally { Pop-Location }
$w = New-Object -ComObject Word.Application
try {
  $w.Visible = $false; $w.DisplayAlerts = 0
  $d = $w.Documents.Open($Docx, $false, $true)
  $paras = @()
  for ($i = 1; $i -le $d.Paragraphs.Count; $i++) {
    $p = $d.Paragraphs.Item($i)
    $paras += [ordered]@{ text = $p.Range.Text.TrimEnd("`r"); top = [double]$p.Range.Information(6) }
  }
  $d.Close([ref]0)
  $out = [ordered]@{ word = "$($w.Version) build $($w.Build)"; paragraphs = $paras }
  [IO.File]::WriteAllText($Json, (ConvertTo-Json $out -Depth 4), (New-Object Text.UTF8Encoding($false)))
} finally { $w.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null }
"wrote $Json"
"SHA-256 $((Get-FileHash $Docx -Algorithm SHA256).Hash)"
```

- [ ] **Step 3: Run the generator**

Run (PowerShell): `powershell -ExecutionPolicy Bypass -File scripts/gen-spacing-oracle.ps1`
Expected: writes both fixture files and prints the SHA-256. Open `spacing-oracle.json` and read the three `top` values.

- [ ] **Step 4: Decide**

Compute `top[1] - top[0]` and `top[2] - top[1]`. Additive predicts `50` and `56`; collapsing predicts `38` and `50` (tolerance 1pt: Word positions on a twip grid). If additive, continue. If collapsing, STOP: Task 8's spacing rule must become `spaceBefore = max(0, before - previousAfter)` and the spec must be amended first.

- [ ] **Step 5: Write the test that pins the answer**

`test/spacing-oracle.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSpacingOracleDocx } from './helpers/build-spacing-oracle.js';

// m2fp.5: Word 2010's own layout of three exact-20pt paragraphs (gen-spacing-oracle.ps1).
const DIR = join(__dirname, 'fixtures', 'docx');
const oracle = JSON.parse(readFileSync(join(DIR, 'spacing-oracle.json'), 'utf8')) as
  { word: string; paragraphs: { text: string; top: number }[] };

describe('Word paragraph spacing (oracle)', () => {
  it('the vendored document is the one the builder writes', () => {
    expect(Buffer.compare(readFileSync(join(DIR, 'spacing-oracle.docx')), Buffer.from(buildSpacingOracleDocx()))).toBe(0);
  });

  it('ADDS one paragraph\'s space-after to the next one\'s space-before', () => {
    const [a, b, c] = oracle.paragraphs.map((p) => p.top);
    expect(b - a).toBeCloseTo(20 + 12 + 18, 0);
    expect(c - b).toBeCloseTo(20 + 6 + 30, 0);
  });
});
```

Run: `npx vitest run test/spacing-oracle.test.ts` — Expected: PASS (if Step 4 said additive).

- [ ] **Step 6: Record provenance, exclude from the corpus**

Append to `test/fixtures/docx/PROVENANCE.md` a `## spacing-oracle.docx (m2fp.5)` section: what it is (OURS, laid out by Word), the command, Word's version string from the JSON, the SHA-256 printed in Step 3, the measured gaps, and the ceiling ("one Word version; exact line spacing only, so it says nothing about how Word sizes an auto line"). In `test/docx-corpus.test.ts` change line 14 to:

```ts
const NOT_CORPUS = new Set(['wml-oracle.docx', 'spacing-oracle.docx']);   // OURS, read by Word
```

Run: `npx vitest run test/docx-corpus.test.ts test/spacing-oracle.test.ts` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add test/helpers/build-spacing-oracle.ts scripts/gen-spacing-oracle.ts scripts/gen-spacing-oracle.ps1 test/fixtures/docx/spacing-oracle.docx test/fixtures/docx/spacing-oracle.json test/spacing-oracle.test.ts test/fixtures/docx/PROVENANCE.md test/docx-corpus.test.ts
git commit -m "test(m2fp.5): Word's paragraph spacing, measured through COM"
```

---

### Task 2: `FlowListItem.label` — an explicit list marker

**Files:**
- Modify: `src/flow.ts` (`FlowListItem` ~line 797, `validateNode` ~line 862, `buildListElements`' `walk` ~line 960, `drawMarkerOnce` ~line 587)
- Test: `test/flow-list-label.test.ts`

**Interfaces:**
- Produces: `FlowListItem.label?: string` — drawn as this item's marker text, measured into its depth's marker width; wins over `ordered`/`bullet`/computed ordinals for THIS item; `''` draws no marker. `marker` ('checkbox'|'checked') still wins over `label`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';

const textOf = (doc: Document) => doc.Pages[0].GetText();

describe('FlowListItem.label', () => {
  it('draws the stated label instead of the computed ordinal', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddList([{ text: 'alpha', label: '1.a)' }, { text: 'beta', label: 'IV.' }], { ordered: true });
    flow.Render();
    const t = textOf(doc);
    expect(t).toContain('1.a)');
    expect(t).toContain('IV.');
    expect(t).not.toMatch(/(^|\s)1\.\s+alpha/);
  });

  it('measures a label into the marker width, so a wide label pushes the body right', () => {
    const at = (label: string): number => {
      const doc = Document.New();
      const flow = doc.NewFlow();
      flow.AddList([{ text: 'body', label }]);
      flow.Render();
      return doc.Pages[0].GetTextFragments().find((f) => f.text.includes('body'))!.quad[0];
    };
    expect(at('Section 12:')).toBeGreaterThan(at('a.') + 20);
  });

  it('draws no marker for an empty label', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddList([{ text: 'solo', label: '' }]);
    flow.Render();
    expect(textOf(doc).trim()).toBe('solo');
  });

  it('refuses a label that is not a string', () => {
    const doc = Document.New();
    expect(() => doc.NewFlow().AddList([{ text: 'x', label: 3 as unknown as string }])).toThrow(TypeError);
  });

  it('leaves a checkbox marker in charge over a label', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddList([{ text: 'task', marker: 'checked', label: 'L.' }]);
    flow.Render();
    expect(textOf(doc)).not.toContain('L.');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-list-label.test.ts`
Expected: FAIL — the ordinal `1.` is drawn and `label` is ignored; the TypeError case does not throw.

- [ ] **Step 3: Implement**

In `FlowListItem`, after `marker`:

```ts
  /** Draw THIS text as the item's marker, in place of the computed ordinal or
   *  bullet — a label computed elsewhere, as a Word document's `1.a)` is. It is
   *  measured into the depth's marker width like any other marker; `''` draws
   *  none. `marker` (a task checkbox) still wins. */
  label?: string;
```

In `validateNode`, beside the `marker` check:

```ts
  if (n.label !== undefined && typeof n.label !== 'string')
    throw new TypeError('item.label must be a string');
```

In `buildListElements`' `walk`, replace the `const marker: ListMarker = …` expression with:

```ts
      const marker: ListMarker = item.marker !== undefined
        ? {
          kind: 'shape',
          shape: item.marker,
          actualText: item.marker === 'checked' ? '☑' : '☐',
        }
        : item.label !== undefined
          ? { kind: 'text', text: item.label }
          : markerFor(cfg, index, depth);
```

In `drawMarkerOnce`, in the text branch, guard the stamp:

```ts
  } else if (marker.text !== '') {
```

(leaving `state.markerDrawn = true;` after the if/else so an empty label still counts as drawn).

- [ ] **Step 4: Run to verify it passes, with the fences**

Run: `npx vitest run test/flow-list-label.test.ts test/rich-runs-identity.test.ts test/markdown-flow.test.ts test/html-identity.test.ts test/flow-list*.test.ts`
Expected: PASS, fences unedited.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow-list-label.test.ts
git commit -m "feat(m2fp.5): FlowListItem.label draws an explicit marker"
```

---

### Task 3: Paragraph left/right indent

**Files:**
- Modify: `src/flowblock.ts` (new `IndentElement` + `indented()` builder helper)
- Modify: `src/flow.ts` (`FlowParagraphOptions` ~line 200, `paragraph()`/`heading()` ~line 325)
- Test: `test/flow-indent.test.ts`

**Interfaces:**
- Produces: `FlowParagraphOptions.indent?: { left?: number; right?: number; firstLine?: number }` (points; `left`/`right` finite `>= 0`; `firstLine` finite, may be negative for a hanging indent, and must be `>= -left`). This task implements `left`/`right`; Task 4 implements `firstLine`. Also `indented(els: FlowElement[], left: number, right: number): FlowElement[]` exported from `flowblock.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';

function fragX(indent?: { left?: number; right?: number; firstLine?: number }, text = 'Indented words here.'): number {
  const doc = Document.New();
  const flow = doc.NewFlow();
  flow.AddParagraph(text, indent ? { indent } : {});
  flow.Render();
  return doc.Pages[0].GetTextFragments()[0].quad[0];
}

describe('paragraph indent: left and right', () => {
  it('shifts the text right by the left indent', () => {
    expect(fragX({ left: 36 }) - fragX()).toBeCloseTo(36, 3);
  });

  it('narrows the box by the right indent, so a long paragraph wraps sooner', () => {
    const lines = (indent?: { right: number }): number => {
      const doc = Document.New();
      const flow = doc.NewFlow();
      flow.AddParagraph('word '.repeat(60), indent ? { indent } : {});
      flow.Render();
      return doc.Pages[0].GetText().trim().split('\n').length;
    };
    expect(lines({ right: 200 })).toBeGreaterThan(lines());
  });

  it('reports squeezed rather than throwing when the indent is wider than the column', async () => {
    const { paragraph } = await import('../src/flow.js');
    const { placeElements } = await import('../src/flowplace.js');
    const doc = Document.New();
    const page = doc.AddPage();
    const els = paragraph('still drawn', { indent: { left: 10000 } });
    const seen: string[] = [];
    els[0].onCompromise = (how) => { seen.push(how); };
    expect(() => placeElements(doc, page, els, [72, 72, 451, 698])).not.toThrow();
    expect(page.GetText()).toContain('still drawn');
    expect(seen).toContain('squeezed');
  });

  it('refuses a negative left/right, a non-finite value, and a hanging indent past the left edge', () => {
    const flow = Document.New().NewFlow();
    expect(() => flow.AddParagraph('x', { indent: { left: -1 } })).toThrow(TypeError);
    expect(() => flow.AddParagraph('x', { indent: { right: Number.NaN } })).toThrow(TypeError);
    expect(() => flow.AddParagraph('x', { indent: { left: 10, firstLine: -11 } })).toThrow(TypeError);
  });

  it('indents a heading too, and keeps it keep-with-next eligible', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddHeading(1, 'Title', { indent: { left: 50 } });
    flow.Render();
    const base = Document.New();
    const f2 = base.NewFlow(); f2.AddHeading(1, 'Title'); f2.Render();
    expect(doc.Pages[0].GetTextFragments()[0].quad[0] - base.Pages[0].GetTextFragments()[0].quad[0]).toBeCloseTo(50, 3);
  });
});
```

(`doc.AddPage()` — confirm the method name that appends and returns a `Page` in `src/document.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/flow-indent.test.ts`
Expected: FAIL — `indent` is ignored (x offset 0), no TypeErrors.

- [ ] **Step 3: Implement `IndentElement` in `src/flowblock.ts`**

After `QuotedElement`, add (it mirrors `QuotedElement` without the bar; import `insetScale` and `Compromise` are already in scope there — add them to the existing `flowelement.js` import if not):

```ts
/** A paragraph's left/right indent (`m2fp.5`): the content box shifted right by
 *  `left` and narrowed by `left + right`, through ONE `insetScale` factor so an
 *  indent wider than the column squeezes rather than driving the width to zero
 *  (`e1bp`). Forwards everything the wrapped element owns, as `QuotedElement`
 *  does, so keep-with-next and compromise reporting read through it. */
class IndentElement implements FlowElement {
  constructor(
    private readonly inner: FlowElement,
    private readonly left: number,
    private readonly right: number,
  ) {}

  get spaceBefore(): number | undefined { return this.inner.spaceBefore; }
  set spaceBefore(v: number | undefined) { this.inner.spaceBefore = v; }
  get spaceAfter(): number | undefined { return this.inner.spaceAfter; }
  set spaceAfter(v: number | undefined) { this.inner.spaceAfter = v; }
  get clear(): FlowClear | undefined { return this.inner.clear; }
  set clear(v: FlowClear | undefined) { this.inner.clear = v; }
  get keepWithNextEligible(): boolean | undefined { return this.inner.keepWithNextEligible; }
  get keepWithNext(): boolean | undefined { return this.inner.keepWithNext; }
  get onCompromise(): ((how: Compromise) => void) | undefined { return this.inner.onCompromise; }
  set onCompromise(fn: ((how: Compromise) => void) | undefined) { this.inner.onCompromise = fn; }

  private scale(width: number): number { return insetScale(width, this.left + this.right); }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    const k = this.scale(ctx.width);
    return this.inner.measure?.({ width: ctx.width - (this.left + this.right) * k, availHeight: ctx.availHeight })
      ?? { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    const k = this.scale(ctx.width);
    const res = this.inner.place({
      ...ctx, x: ctx.x + this.left * k, width: ctx.width - (this.left + this.right) * k,
    });
    if (res.drew && k < 1) this.onCompromise?.('squeezed');
    return {
      usedHeight: res.usedHeight,
      drew: res.drew,
      remainder: res.remainder === null ? null : new IndentElement(res.remainder, this.left, this.right),
    };
  }
}

/** Wrap each element in a left/right indent; the elements unchanged when both are 0. */
export function indented(els: FlowElement[], left: number, right: number): FlowElement[] {
  if (left === 0 && right === 0) return els;
  return els.map((e) => new IndentElement(e, left, right));
}
```

Before writing, read `QuotedElement` and the `FlowElement` interface in `src/flowelement.ts` and match exactly which members are `readonly` properties versus accessors there: if `spaceBefore`/`spaceAfter`/`clear` are plain mutable fields on the interface, the accessors above satisfy them; if the engine assigns `first.spaceBefore = …` (flow.ts's list post-pass does), the setters must forward, as written.

- [ ] **Step 4: Wire the option in `src/flow.ts`**

In `FlowParagraphOptions`, after `spaceAfter`:

```ts
  /** Indent in points (`m2fp.5`). `left`/`right` narrow the text box from each
   *  side; `firstLine` shifts the FIRST line of the paragraph — negative is a
   *  hanging indent, and may not reach past `left`. Default: none. */
  indent?: { left?: number; right?: number; firstLine?: number };
```

Add a validator next to `normalizeSpacing`:

```ts
/** Validated indent, all three resolved to numbers. @internal */
function normalizeIndent(o: FlowParagraphOptions): { left: number; right: number; firstLine: number } {
  const i = o.indent;
  if (i === undefined) return { left: 0, right: 0, firstLine: 0 };
  if (typeof i !== 'object' || i === null) throw new TypeError('indent must be an object');
  const left = i.left ?? 0, right = i.right ?? 0, firstLine = i.firstLine ?? 0;
  if (!Number.isFinite(left) || left < 0) throw new TypeError('indent.left must be a non-negative finite number');
  if (!Number.isFinite(right) || right < 0) throw new TypeError('indent.right must be a non-negative finite number');
  if (!Number.isFinite(firstLine)) throw new TypeError('indent.firstLine must be a finite number');
  if (firstLine < -left) throw new TypeError('indent.firstLine may not hang past indent.left');
  return { left, right, firstLine };
}
```

In `paragraph()` and `heading()`, compute `const ind = normalizeIndent(o);` right after the existing validation and wrap the return: `return indented([new TextElement(…)], ind.left, ind.right);` (import `indented` from `./flowblock.js`, which flow.ts already imports builders from).

- [ ] **Step 5: Run to verify it passes, with the fences**

Run: `npx vitest run test/flow-indent.test.ts test/rich-runs-identity.test.ts test/markdown-flow.test.ts test/html-identity.test.ts test/flow*.test.ts`
Expected: PASS; fences unedited. (The `firstLine` tests arrive in Task 4.)

- [ ] **Step 6: Commit**

```bash
git add src/flowblock.ts src/flow.ts test/flow-indent.test.ts
git commit -m "feat(m2fp.5): paragraph left/right indent through insetScale"
```

---

### Task 4: First-line and hanging indent in the wrapping engine

**Files:**
- Modify: `src/layout.ts` (`LaidLine` ~line 116, `layoutRuns` ~line 282, the pack loop ~line 482)
- Modify: `src/stamp.ts` (`TextBlockOptions` ~line 396, `alignOffset`/`justifySpacing` call sites in `blockLineBoxes` ~672, `segmentBoxes` ~754, `buildRunBlockBody` ~902; the run arms of `flowTextBlock` ~1047 and `measureTextBlock` ~1157)
- Modify: `src/flow.ts` (`paragraphOptions`, `TextElement` continuation)
- Test: `test/flow-indent.test.ts` (add cases), `test/layout.test.ts` (add cases)

**Interfaces:**
- Consumes: `normalizeIndent` from Task 3.
- Produces: `layoutRuns(runs, boxWidth, boxHeight, leading, blockFontSize, firstLineIndent = 0)`; `LaidLine.indent?: number` (set on line 0 only, only when non-zero); `TextBlockOptions.firstLineIndent?: number` (run content only; a string is converted to one run by the flow layer).

- [ ] **Step 1: Write the failing tests**

Add to `test/layout.test.ts` (it already imports `layoutRuns`; build runs the way that file's existing helpers do — read its top and reuse its run factory):

```ts
describe('first-line indent (m2fp.5)', () => {
  it('packs line 0 against boxWidth - indent and marks it; later lines use the full box', () => {
    const runs = [run('aaaa bbbb cccc dddd eeee ffff')];   // the file's own one-run helper
    const plain = layoutRuns(runs, 100, 1000, 12, 10);
    const ind = layoutRuns(runs, 100, 1000, 12, 10, 30);
    expect(ind.lines[0].indent).toBe(30);
    expect(ind.lines[1].indent).toBeUndefined();
    expect(ind.lines[0].width).toBeLessThanOrEqual(70 + 1e-9);
    expect(ind.lines[0].text.length).toBeLessThan(plain.lines[0].text.length);
  });

  it('lets a hanging (negative) first line pack WIDER than the box', () => {
    const runs = [run('aaaa bbbb cccc dddd eeee ffff gggg')];
    const hang = layoutRuns(runs, 100, 1000, 12, 10, -30);
    expect(hang.lines[0].indent).toBe(-30);
    expect(hang.lines[0].width).toBeGreaterThan(100);
  });

  it('is byte-identical with no indent: no line carries the key', () => {
    const got = layoutRuns([run('aaaa bbbb cccc dddd')], 60, 1000, 12, 10);
    expect(got.lines.every((l) => !('indent' in l))).toBe(true);
  });
});
```

Add to `test/flow-indent.test.ts`:

```ts
describe('paragraph indent: first line', () => {
  const frags = (indent: { left?: number; firstLine?: number }) => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph('word '.repeat(40).trim(), { indent });
    flow.Render();
    const f = doc.Pages[0].GetTextFragments();
    const ys = [...new Set(f.map((x) => Math.round(x.quad[1])))].sort((a, b) => b - a);
    const firstX = (y: number) => Math.min(...f.filter((x) => Math.round(x.quad[1]) === y).map((x) => x.quad[0]));
    return { line0: firstX(ys[0]), line1: firstX(ys[1]) };
  };

  it('shifts the first line right and leaves the rest at the left indent', () => {
    const { line0, line1 } = frags({ left: 20, firstLine: 36 });
    expect(line0 - line1).toBeCloseTo(36, 3);
  });

  it('hangs the first line left of the rest', () => {
    const { line0, line1 } = frags({ left: 36, firstLine: -36 });
    expect(line1 - line0).toBeCloseTo(36, 3);
  });

  it('does not indent the first line of a CONTINUATION in the next column', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ columns: 2 });
    flow.AddParagraph('word '.repeat(2500).trim(), { indent: { firstLine: 40 } });
    flow.Render();
    const f = doc.Pages[0].GetTextFragments();
    const mid = doc.Pages[0].CropBox[2] / 2;
    const right = f.filter((x) => x.quad[0] > mid);
    const leftEdge = Math.min(...right.map((x) => x.quad[0]));
    const top = Math.max(...right.map((x) => x.quad[1]));
    const topLineX = Math.min(...right.filter((x) => Math.abs(x.quad[1] - top) < 1).map((x) => x.quad[0]));
    expect(topLineX).toBeCloseTo(leftEdge, 3);
  });

  it('keeps a link rect on its glyphs when the first line is indented', async () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'go', link: 'https://x.test/' }, { text: ' there' }], { indent: { firstLine: 50 } });
    flow.Render();
    const glyph = doc.Pages[0].GetTextFragments().find((x) => x.text.startsWith('go'))!;
    const link = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Link')!;
    expect(link.Rect[0]).toBeCloseTo(glyph.quad[0], 1);
  });
});
```

Check the `Annotation` accessor names (`Subtype`, `Rect`) against `src/annotation.ts` and adjust if they differ.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/layout.test.ts test/flow-indent.test.ts`
Expected: FAIL — `indent` undefined on line 0; first-line cases show no shift.

- [ ] **Step 3: Implement in `src/layout.ts`**

`LaidLine` gains, after `height`:

```ts
  /** Points this line starts right of the box's left edge — set on line 0 alone,
   *  by a first-line or (negative) hanging indent (`m2fp.5`), and ABSENT otherwise,
   *  so every existing caller's lines are unchanged object for object. */
  indent?: number;
```

`layoutRuns` gains a trailing parameter `firstLineIndent = 0`. At the top of the function body compute the first line's limit (clamped so a positive indent never narrows below `MIN_CONTENT_WIDTH`, imported from `./flowelement.js` — check that import closes no cycle with `npx vitest run test/import-cycles.test.ts`; if it does, inline the constant `12` with a comment naming `flowelement.ts`'s):

```ts
  const fi = firstLineIndent > 0
    ? Math.min(firstLineIndent, Math.max(0, boxWidth - Math.min(boxWidth, 12)))
    : firstLineIndent;
  // Line 0 packs against its own width; every later line against the box.
  const limit = (): number => (wrapped.length === 0 ? boxWidth - fi : boxWidth);
```

In the pack loop replace `if (next <= boxWidth) {` with `if (next <= limit()) {`. Where the kept `WrappedLine`s become `LaidLine`s, set `indent` on index 0 only when `fi !== 0` (find the `lines.push({ … })`/`.map` that builds `LaidLine` from `wrapped` and add `...(k === 0 && fi !== 0 ? { indent: fi } : {})`). `wrapped` must be declared before `limit` is first called — it is declared above the pack loop; place `fi`/`limit` after that declaration.

Note in a comment that an OVER-WIDE word on line 0 still splits against `boxWidth`, so its first piece may pass the indented edge — recorded, not fixed.

- [ ] **Step 4: Implement in `src/stamp.ts`**

`TextBlockOptions` gains:

```ts
  /** Points to shift the FIRST line of the block (`m2fp.5`); negative hangs it
   *  left. Run content only. Default 0. */
  firstLineIndent?: number;
```

Add two helpers beside `alignOffset` and route EVERY line-x and justify-slack computation through them — `blockLineBoxes`, `segmentBoxes`, `buildRunBlockBody` (and `buildBlockBody`/`buildShapedBlockBody` unchanged: those are the string paths, which never carry an indent):

```ts
/** A line's x within its box: its first-line indent, then alignment within what
 *  the indent leaves. 0 + alignOffset for every line with no indent, which is
 *  every line of every existing caller. */
function lineX(align: NormalizedBlockOptions['align'], boxWidth: number, line: LaidLine): number {
  const ind = line.indent ?? 0;
  return ind + alignOffset(align, boxWidth - ind, line.width);
}
/** The width a line justifies to: the box less its indent. */
const lineBox = (boxWidth: number, line: LaidLine): number => boxWidth - (line.indent ?? 0);
```

- `blockLineBoxes`: `const tw = justifySpacing(o.align, lineBox(w, line), line);` and `x: x + lineX(o.align, w, line)`, `width: tw > 0 ? lineBox(w, line) : line.width`.
- `segmentBoxes`: `const tw = justifySpacing(o.align, lineBox(w, line), line);` and `let dx = x + lineX(o.align, w, line);`.
- `buildRunBlockBody`: replace `alignOffset(o.align, w, line.width)` with `lineX(o.align, w, line)` and its `justifySpacing(o.align, w, line)` with `justifySpacing(o.align, lineBox(w, line), line)`.

In `flowTextBlock`'s and `measureTextBlock`'s run arms pass the option: `layoutRuns(…, ro.leading, ro.fontSize, options.firstLineIndent ?? 0)` (and `o.` in `measureTextBlock`).

- [ ] **Step 5: Implement in `src/flow.ts`**

`paragraphOptions(o)` gains `firstLineIndent: o.indent?.firstLine` — but only for run content. In `paragraph()`/`heading()`, when `ind.firstLine !== 0` and `text` is a string, convert it to `[{ text }]` before building the `TextElement`, so the run path carries it.

In `TextElement.place`, the continuation must drop it:

```ts
        : new TextElement(remainder, { ...this.opts, atomics: remainderAtomics, firstLineIndent: undefined },
```

- [ ] **Step 6: Run to verify it passes, with the fences**

Run: `npx vitest run test/layout.test.ts test/flow-indent.test.ts test/rich-runs-identity.test.ts test/markdown-flow.test.ts test/html-identity.test.ts test/flow*.test.ts test/import-cycles.test.ts`
Expected: PASS; the three identity fences UNEDITED.

- [ ] **Step 7: Commit**

```bash
git add src/layout.ts src/stamp.ts src/flow.ts test/layout.test.ts test/flow-indent.test.ts
git commit -m "feat(m2fp.5): first-line and hanging indent in the wrapping engine"
```

---

### Task 5: `openDocx` — part reader, font table and title

**Files:**
- Modify: `src/wmlread.ts`
- Create: `test/helpers/build-docx.ts`
- Test: `test/wmlread.test.ts` (add cases)

**Interfaces:**
- Produces, from `src/wmlread.ts`:

```ts
export type FontClass = 'serif' | 'sans-serif' | 'monospace';
export interface OpenedDocx {
  doc: WmlDocument;
  /** A part's bytes and content type; undefined for a part the package lacks
   *  or cannot decode (the caller reports it). Charged to the archive's limits. */
  readPart(part: string): { bytes: Uint8Array; contentType?: string } | undefined;
  /** fontTable.xml's w:family per font name, mapped to a generic class. */
  fontClass(name: string): FontClass | undefined;
  /** docProps/core.xml's dc:title, trimmed; undefined when absent or blank. */
  title?: string;
}
export function openDocx(bytes: Uint8Array, limits?: LoadLimits): OpenedDocx;
```

  `readDocx(bytes, limits)` becomes `openDocx(bytes, limits).doc`.
- Produces, `test/helpers/build-docx.ts`:

```ts
export interface DocxParts { styles?: string; numbering?: string; fontTable?: string; core?: string;
  media?: { name: string; bytes: Uint8Array; contentType: string }[]; rels?: { id: string; type: string; target: string; external?: boolean }[] }
export function buildDocx(bodyXml: string, parts?: DocxParts): Uint8Array;
```

- [ ] **Step 1: Write `test/helpers/build-docx.ts`**

```ts
/** A .docx for m2fp.5's tests: a body plus optional styles, numbering, font
 *  table, core properties, media and extra document relationships. The body is
 *  wrapped by helpers/wml.ts's docXml (which declares w, r, wp, a, pic). */
import { buildOoxmlPackage, type OoxmlPart, type OoxmlRelationship } from '../../src/ooxml.js';
import { docXml, stylesXml, numberingXml, enc, W_NS } from './wml.js';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

export interface DocxParts {
  styles?: string; numbering?: string; fontTable?: string; core?: string;
  media?: { name: string; bytes: Uint8Array; contentType: string }[];
  rels?: { id: string; type: string; target: string; external?: boolean }[];
}

export function buildDocx(bodyXml: string, parts: DocxParts = {}): Uint8Array {
  const p: OoxmlPart[] = [{ path: 'word/document.xml', bytes: docXml(bodyXml), contentType: `${CT}.document.main+xml` }];
  const r: OoxmlRelationship[] = [{ source: '', id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' }];
  const docRel = (id: string, type: string, target: string, external?: boolean): void => {
    r.push({ source: 'word/document.xml', id, type: `${REL}/${type}`, target, ...(external ? { external: true } : {}) });
  };
  if (parts.styles !== undefined) {
    p.push({ path: 'word/styles.xml', bytes: stylesXml(parts.styles), contentType: `${CT}.styles+xml` });
    docRel('rSt', 'styles', 'styles.xml');
  }
  if (parts.numbering !== undefined) {
    p.push({ path: 'word/numbering.xml', bytes: numberingXml(parts.numbering), contentType: `${CT}.numbering+xml` });
    docRel('rNu', 'numbering', 'numbering.xml');
  }
  if (parts.fontTable !== undefined) {
    p.push({ path: 'word/fontTable.xml', bytes: enc(`<w:fonts xmlns:w="${W_NS}">${parts.fontTable}</w:fonts>`), contentType: `${CT}.fontTable+xml` });
    docRel('rFt', 'fontTable', 'fontTable.xml');
  }
  if (parts.core !== undefined) {
    p.push({ path: 'docProps/core.xml', contentType: 'application/vnd.openxmlformats-package.core-properties+xml',
      bytes: enc('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        + `xmlns:dc="http://purl.org/dc/elements/1.1/">${parts.core}</cp:coreProperties>`) });
    r.push({ source: '', id: 'rCore', type: `${PKG_REL}/metadata/core-properties`, target: 'docProps/core.xml' });
  }
  for (const m of parts.media ?? []) {
    p.push({ path: `word/media/${m.name}`, bytes: m.bytes, contentType: m.contentType });
  }
  for (const x of parts.rels ?? []) docRel(x.id, x.type, x.target, x.external);
  return buildOoxmlPackage(p, r);
}
```

Check `OoxmlRelationship`'s external-target field name in `src/ooxml.ts` (it may be `targetMode: 'External'`) and match it.

- [ ] **Step 2: Write the failing tests** (append to `test/wmlread.test.ts`)

```ts
import { openDocx } from '../src/wmlread.js';
import { buildDocx } from './helpers/build-docx.js';

describe('openDocx', () => {
  it('reads a part lazily, with its content type, and says nothing for a missing one', () => {
    const png = buildPngRgbWith(2, 2, [255, 0, 0]);
    const o = openDocx(buildDocx(p(r('x')), { media: [{ name: 'a.png', bytes: png, contentType: 'image/png' }] }));
    expect(o.readPart('word/media/a.png')).toEqual({ bytes: png, contentType: 'image/png' });
    expect(o.readPart('word/media/none.png')).toBeUndefined();
  });

  it('maps fontTable w:family to a generic class, by exact font name', () => {
    const o = openDocx(buildDocx(p(r('x')), { fontTable:
      '<w:font w:name="Cambria"><w:family w:val="roman"/></w:font><w:font w:name="Calibri"><w:family w:val="swiss"/></w:font>'
      + '<w:font w:name="Consolas"><w:family w:val="modern"/></w:font><w:font w:name="Brush"><w:family w:val="script"/></w:font>' }));
    expect(['Cambria', 'Calibri', 'Consolas', 'Brush', 'Nope'].map((n) => o.fontClass(n)))
      .toEqual(['serif', 'sans-serif', 'monospace', 'sans-serif', undefined]);
  });

  it('reads a non-blank core title, and none for a blank or absent one', () => {
    expect(openDocx(buildDocx(p(r('x')), { core: '<dc:title> Report </dc:title>' })).title).toBe('Report');
    expect(openDocx(buildDocx(p(r('x')), { core: '<dc:title>  </dc:title>' })).title).toBeUndefined();
    expect(openDocx(buildDocx(p(r('x')))).title).toBeUndefined();
  });

  it('degrades an unreadable font table to no classes, and records it', () => {
    const o = openDocx(buildDocx(p(r('x')), { fontTable: '<w:font' }));
    expect(o.fontClass('Calibri')).toBeUndefined();
    expect(o.doc.unsupported).toContainEqual({ name: 'fontTable.xml: unreadable', count: 1 });
  });
});
```

(`buildPngRgbWith` is already imported at the top of `test/wmlread.test.ts`; check its signature there and match it.)

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/wmlread.test.ts`
Expected: FAIL — `openDocx` is not exported.

- [ ] **Step 4: Implement in `src/wmlread.ts`**

Rename the body of `readDocx` to `openDocx`, returning the `OpenedDocx` object; add `export function readDocx(bytes, limits = LoadLimits.defaults): WmlDocument { return openDocx(bytes, limits).doc; }`. Inside `openDocx`, after the styles/numbering/theme `optional(...)` calls:

```ts
  const FONT_TABLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable';
  const fontClasses: Map<string, FontClass> = optional('fontTable.xml', FONT_TABLE, (b) => parseFontTable(b, limits), new Map());
```

with a module-level parser (uses `parseWml`, `W`, `wAttr`, `wChild`, `wChildren` from `./wmlns.js`):

```ts
const FAMILY: Readonly<Record<string, FontClass>> = { roman: 'serif', swiss: 'sans-serif', modern: 'monospace' };

/** fontTable.xml's w:family per font (ECMA-376 17.8.3.10), to the generic a
 *  missing face falls back to — the producer's own classification, where
 *  cssfont.ts refuses to guess one from a name. script/decorative/auto have no
 *  Standard-14 analogue and take sans-serif. */
function parseFontTable(bytes: Uint8Array, limits: LoadLimits): Map<string, FontClass> {
  const root = parseWml(bytes, limits);
  if (root.ns !== W || root.local !== 'fonts') throw new PdfParseError('fontTable.xml: the root is not w:fonts');
  const out = new Map<string, FontClass>();
  for (const f of wChildren(root, 'font')) {
    const name = wAttr(f, 'name');
    const fam = wAttr(wChild(f, 'family'), 'val');
    if (name === undefined || fam === undefined || out.has(name)) continue;
    out.set(name, Object.hasOwn(FAMILY, fam) ? FAMILY[fam] : 'sans-serif');
  }
  return out;
}
```

Title (root relationship, core properties; parse with `parseNsXml` from `./xmlns.js`, `nsChild`):

```ts
  const CORE = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
  const DC = 'http://purl.org/dc/elements/1.1/';
  let title: string | undefined;
  const coreRel = pkg.relationships('').find((x) => x.type === CORE);
  if (coreRel?.part !== undefined && pkg.has(coreRel.part)) {
    try {
      const t = nsChild(parseNsXml(pkg.read(coreRel.part), limits), DC, 'title')?.text.trim();
      if (t) title = t;
    } catch (caught) { rethrowLimit(caught); note('core.xml: unreadable'); }
  }
```

`readPart`:

```ts
  const readPart = (part: string): { bytes: Uint8Array; contentType?: string } | undefined => {
    if (!pkg.has(part)) return undefined;
    try {
      const bytes = pkg.read(part);
      const contentType = pkg.contentType(part);
      return contentType === undefined ? { bytes } : { bytes, contentType };
    } catch (caught) { rethrowLimit(caught); return undefined; }
  };
```

`fontClass: (name) => fontClasses.get(name)`. Keep the `doc.unsupported` array built AFTER these so their notes appear in it. Update the module header comment with the three additions.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/wmlread.test.ts test/docx-corpus.test.ts test/wml-oracle.test.ts test/limits-catch.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/wmlread.ts test/helpers/build-docx.ts test/wmlread.test.ts
git commit -m "feat(m2fp.5): openDocx reads parts, the font table and the core title"
```

---

### Task 6: The mapper core and the three entry points (plain paragraphs)

The vertical slice: text paragraphs render through all three entry points, `skipped` carries `readDocx`'s records with kinds, page breaks split segments, and an empty paragraph keeps its line. Formatting, images, lists and tables are later tasks.

**Files:**
- Create: `src/wmlflow.ts`, `src/wmlruns.ts`, `src/wmlimport.ts`
- Modify: `src/flow.ts` (`Flow.AddDocx`), `src/page.ts` (`Page.AddDocx`), `src/document.ts` (`Document.AddDocx`)
- Test: `test/docx-import.test.ts`

**Interfaces:**
- Produces (`src/wmlflow.ts`):

```ts
export interface DocxSkipped { name: string; count: number; kind: 'dropped' | 'degraded' }
export interface WmlFlowEnv {
  /** The four faces for a Word font name (undefined = Word's default), and whether
   *  the NAME resolved to a real face rather than a Standard-14 stand-in. */
  family(name: string | undefined): { family: ResolvedFamily; resolved: boolean };
  /** An image part's bytes and content type, or undefined. */
  image(part: string): { bytes: Uint8Array; contentType?: string } | undefined;
}
export class SkipLog {
  add(name: string, kind?: 'dropped' | 'degraded', n?: number): void;   // kind defaults via kindOf(name)
  list(): DocxSkipped[];                                                  // sorted by name, fresh array
}
export function kindOf(name: string): 'dropped' | 'degraded';
export function mergeSkipped(...lists: DocxSkipped[][]): DocxSkipped[];
export function wmlElements(doc: WmlDocument, width: number, env: WmlFlowEnv):
  { segments: FlowElement[][]; skipped: DocxSkipped[] };
```

- Produces (`src/wmlruns.ts`): `inlineContent(inlines: WmlInline[], c: RunCtx): { runs: TextRun[]; atomics: FlowAtomic[]; maxSize: number }` and `interface RunCtx { env: WmlFlowEnv; log: SkipLog }` (grown in later tasks).
- Produces (`src/wmlimport.ts`):

```ts
export interface DocxFlowOptions {
  resolveFamily?: FamilyResolver;
  onSkipped?: (s: DocxSkipped) => void;
}
export interface DocxFlowResult { skipped: DocxSkipped[] }
export interface AddDocxResult extends DocxFlowResult { usedHeight: number; remainder: FlowElement[] }
export interface OpenedDocxSource { opened: OpenedDocx }        // what doc.AddDocx hands flow.AddDocx
export function checkDocxOptions(o: DocxFlowOptions): void;
export function openDocxSource(doc: Document, bytes: Uint8Array): OpenedDocxSource;
export function docxElements(doc: Document, src: Uint8Array | OpenedDocxSource, width: number,
  options?: DocxFlowOptions): { segments: FlowElement[][]; skipped: DocxSkipped[] };
```

- Produces: `Flow.AddDocx(src: Uint8Array | OpenedDocxSource, opts?: DocxFlowOptions): DocxFlowResult`; `Page.AddDocx(bytes: Uint8Array, rect, opts?: DocxFlowOptions & { structParent?: StructElement }): AddDocxResult`; `Document.AddDocx(bytes: Uint8Array, opts?: DocxFlowOptions & FlowOptions & { title?: string }): { pages: Page[]; skipped: DocxSkipped[] }`.

- [ ] **Step 1: Write the failing tests** (`test/docx-import.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';

const render = (body: string, parts = {}, opts = {}) => {
  const doc = Document.New();
  const res = doc.AddDocx(buildDocx(body, parts), opts);
  return { doc, ...res, text: res.pages.map((pg) => pg.GetText()).join('\n') };
};

describe('AddDocx: paragraphs', () => {
  it('renders every paragraph\'s text in order through doc.AddDocx', () => {
    const { text, skipped } = render(p(r('First paragraph.')) + p(r('Second one.')));
    expect(text).toMatch(/First paragraph\.[\s\S]*Second one\./);
    expect(skipped).toEqual([]);
  });

  it('keeps an empty paragraph as vertical space', () => {
    const y = (body: string) => {
      const { doc } = render(body);
      return doc.Pages[0].GetTextFragments().find((f) => f.text.includes('B'))!.quad[1];
    };
    expect(y(p(r('A')) + p(r('B')))).toBeGreaterThan(y(p(r('A')) + p('') + p(r('B'))) + 5);
  });

  it('starts a new page at a page break', () => {
    const { pages } = render(p(r('before') + '<w:r><w:br w:type="page"/></w:r>' + r('after')));
    expect(pages.length).toBe(2);
    expect(pages[1].GetText()).toContain('after');
  });

  it('passes readDocx\'s records through, with a kind, counted and sorted', () => {
    const body = p('<w:r><w:footnoteReference w:id="1"/></w:r>' + r('x'))
      + p('<w:r><w:footnoteReference w:id="2"/></w:r>' + '<w:ins w:id="1" w:author="a">' + r('y') + '</w:ins>');
    expect(render(body).skipped).toEqual([
      { name: 'w:footnoteReference', count: 2, kind: 'dropped' },
      { name: 'w:ins', count: 1, kind: 'degraded' },
    ]);
  });

  it('returns a fresh skipped array on every call', () => {
    const doc = Document.New();
    const a = doc.AddDocx(buildDocx(p(r('x')))).skipped;
    a.push({ name: 'mine', count: 1, kind: 'dropped' });
    expect(doc.AddDocx(buildDocx(p(r('x')))).skipped).toEqual([]);
  });

  it('refuses a non-function resolveFamily or onSkipped before allocating a page', () => {
    const doc = Document.New();
    const before = doc.Pages.length;
    expect(() => doc.AddDocx(buildDocx(p(r('x'))), { onSkipped: 3 as never })).toThrow(TypeError);
    expect(() => doc.AddDocx(buildDocx(p(r('x'))), { resolveFamily: 'x' as never })).toThrow(TypeError);
    expect(doc.Pages.length).toBe(before);
  });

  it('throws PdfParseError for bytes that are not a WordprocessingML package', async () => {
    const { PdfParseError } = await import('../src/errors.js');
    expect(() => Document.New().AddDocx(new Uint8Array([1, 2, 3]))).toThrow(PdfParseError);
  });
});

describe('AddDocx: the three entry points agree', () => {
  const body = p(r('Alpha words.')) + p(r('Beta words.'));
  it('flow.AddDocx, page.AddDocx and doc.AddDocx extract the same text', () => {
    const viaDoc = Document.New(); viaDoc.AddDocx(buildDocx(body));
    const viaFlow = Document.New(); const f = viaFlow.NewFlow(); f.AddDocx(buildDocx(body)); f.Render();
    const viaPage = Document.New(); const pg = viaPage.AddPage();
    pg.AddDocx(buildDocx(body), [72, 72, 451, 698]);
    const norm = (d: Document) => d.Pages[0].GetText().replace(/\s+/g, ' ').trim();
    expect(norm(viaFlow)).toBe(norm(viaDoc));
    expect(norm(viaPage)).toBe(norm(viaDoc));
  });

  it('page.AddDocx reports a page break it cannot honour', () => {
    const pg = Document.New().AddPage();
    const res = pg.AddDocx(buildDocx(p(r('a') + '<w:r><w:br w:type="page"/></w:r>' + r('b'))), [72, 72, 451, 698]);
    expect(res.skipped).toContainEqual({ name: 'w:br (page)', count: 1, kind: 'degraded' });
    expect(pg.GetText()).toMatch(/a[\s\S]*b/);
  });
});
```

`Page.AddPage` — check the real method name in `src/document.ts` (`AddPage()` returning a `Page`) and adjust.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/docx-import.test.ts`
Expected: FAIL — `AddDocx` does not exist.

- [ ] **Step 3: Write `src/wmlruns.ts`**

```ts
/** WordprocessingML inline content to the flow engine's runs (`m2fp.5`): text
 *  runs, image atomics among them, and the report of what did not map. Pure:
 *  fonts and image bytes arrive through `WmlFlowEnv`. Formatting beyond the text
 *  arrives in Task 7; this is the text-only core. */
import type { WmlInline } from './wmlbody.js';
import type { TextRun } from './textdecor.js';
import type { FlowAtomic } from './flow.js';
import type { SkipLog, WmlFlowEnv } from './wmlflow.js';

export interface RunCtx { env: WmlFlowEnv; log: SkipLog }

export function inlineContent(inlines: WmlInline[], c: RunCtx): { runs: TextRun[]; atomics: FlowAtomic[]; maxSize: number } {
  const runs: TextRun[] = [];
  const atomics: FlowAtomic[] = [];
  let maxSize = 0;
  for (const i of inlines) {
    if (i.kind === 'text') {
      runs.push({ text: i.text, fontSize: i.props.sizePt });
      maxSize = Math.max(maxSize, i.props.sizePt);
    } else if (i.kind === 'break') {
      // page/column breaks were split out by the caller; only line breaks reach here.
      runs.push({ text: '\n' });
    } else if (i.kind === 'tab') {
      runs.push({ text: ' ' });
      c.log.add('w:tab');
    }
    // images: Task 9
  }
  return { runs, atomics, maxSize };
}
```

Check for a cycle: `wmlruns.ts` imports `wmlflow.ts` for TYPES only (`import type`), so it closes no value edge; confirm with `npx vitest run test/import-cycles.test.ts` at Step 7.

- [ ] **Step 4: Write `src/wmlflow.ts`**

```ts
/** A resolved WordprocessingML document (`readDocx`) to flow elements
 *  (`m2fp.5`) — the one implementation behind `flow.AddDocx`, `page.AddDocx` and
 *  `doc.AddDocx`. This module owns the MAPPING and nothing else: no columns,
 *  rects or pagination (`mdflow.ts`'s rule), no Document, no package. Fonts and
 *  image bytes arrive through `WmlFlowEnv`, which `wmlimport.ts` supplies.
 *
 *  **Invariant:** output is SEGMENTS split at page and column breaks, because a
 *  break is not a FlowElement — `Flow.AddColumnBreak` is a sentinel inside the
 *  flow — so each entry point decides what a break means for it.
 *
 *  **Invariant:** nothing here throws on document content; what does not map is
 *  a counted record in `skipped`. */
import type { WmlDocument, WmlBlock, WmlParagraph, WmlInline } from './wmlbody.js';
import type { FlowElement } from './flowelement.js';
import type { ResolvedFamily } from './mdstyle.js';
import { paragraph } from './flow.js';
import { inlineContent, type RunCtx } from './wmlruns.js';

export interface DocxSkipped { name: string; count: number; kind: 'dropped' | 'degraded' }

export interface WmlFlowEnv {
  family(name: string | undefined): { family: ResolvedFamily; resolved: boolean };
  image(part: string): { bytes: Uint8Array; contentType?: string } | undefined;
}

/** Constructs that draw NOTHING of what the document said; every other name is
 *  `degraded`, because readDocx keeps an unknown construct's text. */
const DROPPED = new Set([
  'w:headerReference', 'w:footerReference', 'w:footnoteReference', 'w:endnoteReference',
  'w:commentReference', 'w:del', 'w:moveFrom', 'w:fldChar (unterminated)',
  'a:blip (unresolved image)', 'a:blip (unreadable image)', 'w:drawing (not a picture)', 'text',
]);

export function kindOf(name: string): 'dropped' | 'degraded' {
  return DROPPED.has(name) || name.startsWith('image:') ? 'dropped' : 'degraded';
}

export class SkipLog {
  private readonly counts = new Map<string, DocxSkipped>();
  add(name: string, kind: 'dropped' | 'degraded' = kindOf(name), n = 1): void {
    const key = `${kind}\u0000${name}`;
    const hit = this.counts.get(key);
    if (hit) hit.count += n; else this.counts.set(key, { name, count: n, kind });
  }
  list(): DocxSkipped[] {
    return [...this.counts.values()].map((s) => ({ ...s }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  }
}

export function mergeSkipped(...lists: DocxSkipped[][]): DocxSkipped[] {
  const log = new SkipLog();
  for (const l of lists) for (const s of l) log.add(s.name, s.kind, s.count);
  return log.list();
}

interface Ctx extends RunCtx {
  width: number;
  segments: FlowElement[][];
  /** Space an empty paragraph left, added to the next element's spaceBefore. */
  gap: number;
}

const cur = (c: Ctx): FlowElement[] => c.segments[c.segments.length - 1];

/** A paragraph's inlines split at page/column breaks: a new segment starts after each. */
function splitAtBreaks(inlines: WmlInline[]): WmlInline[][] {
  const parts: WmlInline[][] = [[]];
  for (const i of inlines) {
    if (i.kind === 'break' && i.type !== 'line') parts.push([]);
    else parts[parts.length - 1].push(i);
  }
  return parts;
}

const DEFAULT_SIZE = 10;   // Word's size with nothing stated (m2fp.3)

function paragraphElements(p: WmlParagraph, inlines: WmlInline[], c: Ctx): void {
  const content = inlineContent(inlines, c);
  const size = content.maxSize > 0 ? content.maxSize : DEFAULT_SIZE;
  const leading = size * 1.2;
  if (content.runs.every((x) => x.text.trim() === '') && content.atomics.length === 0) {
    c.gap += leading;
    return;
  }
  const els = paragraph(content.runs, { fontSize: size, leading, spaceBefore: c.gap });
  c.gap = 0;
  cur(c).push(...els);
}

function blockElements(blocks: WmlBlock[], c: Ctx): void {
  for (const b of blocks) {
    if (b.kind === 'paragraph') {
      const parts = splitAtBreaks(b.inlines);
      parts.forEach((inl, k) => {
        if (k > 0) { c.segments.push([]); c.gap = 0; }
        paragraphElements(b, inl, c);
      });
    }
    // tables: Task 11
  }
}

export function wmlElements(doc: WmlDocument, width: number, env: WmlFlowEnv): { segments: FlowElement[][]; skipped: DocxSkipped[] } {
  const log = new SkipLog();
  for (const u of doc.unsupported) log.add(u.name, kindOf(u.name), u.count);
  const c: Ctx = { env, log, width, segments: [[]], gap: 0 };
  blockElements(doc.blocks, c);
  return { segments: c.segments, skipped: log.list() };
}
```

- [ ] **Step 5: Write `src/wmlimport.ts`**

```ts
/** The three `AddDocx` entry points' one implementation (`m2fp.5`) — the wiring
 *  and nothing else, `htmlflow.ts`'s shape: open the package, supply fonts and
 *  image bytes, hand the width down. The only module of the DOCX import that
 *  touches a Document.
 *
 *  **Invariant:** THE CALLER MUST PLACE WITH `paragraphSpacing: 0` — Word's
 *  spacing is carried on each element, and the engine ADDS paragraphSpacing
 *  between every pair. Word COLLAPSES adjacent spacing to max(after, before)
 *  (test/spacing-oracle.test.ts), which wmlflow.ts emits as
 *  spaceBefore = max(0, before - previousAfter). */
import type { Document } from './document.js';
import type { FamilyResolver } from './cssinline.js';
import type { FlowElement } from './flowelement.js';
import { openDocx, type OpenedDocx } from './wmlread.js';
import { wmlElements, type DocxSkipped, type WmlFlowEnv } from './wmlflow.js';
import { documentFamilyResolver } from './cssfont.js';

export type { DocxSkipped } from './wmlflow.js';

export interface DocxFlowOptions {
  /** Override the font bridge. Default: the document's registered families,
   *  then a generic chosen by the DOCX font table's w:family. */
  resolveFamily?: FamilyResolver;
  /** Placement-time compromises (`'squeezed'`, `'overflow'`,
   *  `'image:scaled-to-fit'`), for a Flow whose AddDocx returns before Render.
   *  doc.AddDocx and page.AddDocx fold them into `skipped` themselves. */
  onSkipped?: (s: DocxSkipped) => void;
}
export interface DocxFlowResult { skipped: DocxSkipped[] }
export interface AddDocxResult extends DocxFlowResult { usedHeight: number; remainder: FlowElement[] }
/** An opened package, so doc.AddDocx reads its page geometry once and hands the
 *  same package to its flow. @internal */
export interface OpenedDocxSource { opened: OpenedDocx }

export function checkDocxOptions(o: DocxFlowOptions): void {
  if (o.resolveFamily !== undefined && typeof o.resolveFamily !== 'function')
    throw new TypeError('resolveFamily must be a function');
  if (o.onSkipped !== undefined && typeof o.onSkipped !== 'function')
    throw new TypeError('onSkipped must be a function');
}

export function openDocxSource(doc: Document, bytes: Uint8Array): OpenedDocxSource {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('the DOCX source must be a Uint8Array');
  return { opened: openDocx(bytes, doc.loadLimits) };
}

export function docxElements(
  doc: Document, src: Uint8Array | OpenedDocxSource, width: number, options: DocxFlowOptions = {},
): { segments: FlowElement[][]; skipped: DocxSkipped[] } {
  checkDocxOptions(options);
  const { opened } = src instanceof Uint8Array ? openDocxSource(doc, src) : src;
  const resolver = options.resolveFamily ?? documentFamilyResolver(doc);
  const env: WmlFlowEnv = {
    family: (name) => {
      const generic = name === undefined ? 'serif' : opened.fontClass(name) ?? 'sans-serif';
      const family = resolver(name === undefined ? [generic] : [name, generic]);
      return { family, resolved: name !== undefined && typeof family.regular !== 'string' };
    },
    image: (part) => opened.readPart(part),
  };
  const out = wmlElements(opened.doc, width, env);
  if (options.onSkipped !== undefined) reportCompromises(out.segments.flat(), options.onSkipped);
  return out;
}

const COMPROMISE: Readonly<Record<Compromise, string>> = {
  squeezed: 'squeezed', overflow: 'overflow', scaled: 'image:scaled-to-fit',
};

/** A one-shot report per element and kind — mdflow.ts's reportCompromises,
 *  in DocxSkipped's shape. The kind is stated EXPLICITLY as degraded: these
 *  drew, and kindOf would call 'image:scaled-to-fit' dropped by its prefix. */
function reportCompromises(elements: FlowElement[], sink: (s: DocxSkipped) => void): void {
  for (const el of elements) {
    if (el.onCompromise !== undefined) continue;
    const done = new Set<Compromise>();
    el.onCompromise = (how) => {
      if (done.has(how)) return;
      done.add(how);
      sink({ name: COMPROMISE[how], count: 1, kind: 'degraded' });
    };
  }
}
```

(Import `type Compromise` alongside `FlowElement` from `./flowelement.js`.) Task 9 adds the test that pins this, an over-tall image; the mutation sweep in Task 14 covers the explicit `'degraded'`.

Check `ResolvedFamily` is what `FamilyResolver` returns (`cssinline.ts:36` says `ResolvedFamily`; confirm it is `mdstyle.ts`'s type).

- [ ] **Step 6: Wire the entry points**

`src/flow.ts`, beside `AddHtml` (import `docxElements`, `DocxFlowOptions`, `DocxFlowResult`, `OpenedDocxSource` from `./wmlimport.js`):

```ts
  /** Append a Word document (.docx) as a documented subset — paragraphs, styles,
   *  headings, lists, tables, images and links — reporting everything else in
   *  `skipped` (`m2fp.5`). A page or column break becomes a column break. */
  AddDocx(src: Uint8Array | OpenedDocxSource, options: DocxFlowOptions = {}): DocxFlowResult {
    const { segments, skipped } = docxElements(this.doc, src, this.geometry.columnWidth, options);
    segments.forEach((els, k) => {
      if (k > 0) this.AddColumnBreak();
      this.items.push(...els);
    });
    return { skipped };
  }
```

`src/page.ts`, beside `AddHtml`:

```ts
  /** Lay a Word document (.docx) into the rectangle [x, y, w, h] on this page
   *  (`m2fp.5`). A page or column break cannot be honoured in one rect: the
   *  content before and after it is placed continuously and the break reported.
   *  Returns `usedHeight`, `skipped` and a `remainder` for `placeElements`. */
  AddDocx(
    bytes: Uint8Array,
    rect: [number, number, number, number],
    options: DocxFlowOptions & { structParent?: StructElement } = {},
  ): AddDocxResult {
    checkDocxOptions(options);
    const late = new SkipLog();
    const onSkipped = (s: DocxSkipped): void => { late.add(s.name, s.kind, s.count); options.onSkipped?.(s); };
    const { segments, skipped } = docxElements(this.doc, bytes, rect[2], { ...options, onSkipped });
    if (segments.length > 1) late.add('w:br (page)', 'degraded', segments.length - 1);
    const { usedHeight, remainder } = placeElements(this.doc, this, segments.flat(), rect, {
      paragraphSpacing: 0, structParent: options.structParent,
    });
    return { usedHeight, remainder, skipped: mergeSkipped(skipped, late.list()) };
  }
```

`src/document.ts`, beside `AddHtml` (import `openDocxSource`, `checkDocxOptions`, `DocxFlowOptions`, `DocxSkipped` from `./wmlimport.js`, `SkipLog`, `mergeSkipped` from `./wmlflow.js`, `PageFormat` if not already):

```ts
  /** Render a whole Word document (.docx), appending freshly sized pages
   *  (`m2fp.5`). The one-call form of `NewFlow` + `AddDocx` + `Render`. Page size
   *  and margins come from the document's last section unless `options` states
   *  them; the document's own core-properties title becomes the PDF title unless
   *  an explicit `title` is given (`AddHtml`'s rule for `<title>`). */
  AddDocx(
    bytes: Uint8Array,
    options: DocxFlowOptions & FlowOptions & { title?: string } = {},
  ): { pages: Page[]; skipped: DocxSkipped[] } {
    const explicit = options.title;
    if (explicit !== undefined && (typeof explicit !== 'string' || explicit === ''))
      throw new TypeError('title must be a non-empty string');
    checkDocxOptions(options);
    const src = openDocxSource(this, bytes);
    const pg = src.opened.doc.page;
    const geometry: FlowOptions = pg === undefined ? {} : {
      format: PageFormat.custom(pg.widthPt, pg.heightPt),
      marginLeft: pg.margins.left, marginRight: pg.margins.right,
      marginTop: pg.margins.top, marginBottom: pg.margins.bottom,
    };
    const flow = new Flow(this, { ...geometry, ...options, paragraphSpacing: 0 });
    const late = new SkipLog();
    const onSkipped = (s: DocxSkipped): void => { late.add(s.name, s.kind, s.count); options.onSkipped?.(s); };
    const { skipped } = flow.AddDocx(src, { ...options, onSkipped });
    const pages = flow.Render();
    const title = explicit ?? src.opened.title;
    if (title !== undefined) {
      this.SetMetadata({ title });
      this.DisplayDocTitle = true;
    }
    return { pages, skipped: mergeSkipped(skipped, late.list()) };
  }
```

Check `FlowOptions` has a `paragraphSpacing` field (it is `normalizeFlowOptions`' — confirm the name) and that a caller-stated `format`/`margin*` in `options` wins because it is spread after `geometry`. Check `WmlDocument.page`'s shape (`src/wmlbody.ts`: `WmlPage { widthPt; heightPt; margins }`).

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run test/docx-import.test.ts test/import-cycles.test.ts test/limits-catch.test.ts && npm run typecheck`
Expected: PASS. If `import-cycles` reports a new 2-cycle (e.g. `flow.ts` ↔ `wmlimport.ts` through `wmlflow.ts` → `flow.ts`), break it by making `Flow.AddDocx` import only from `wmlimport.ts` and keeping `wmlflow.ts`'s imports from `flow.ts` builder-only; `flow.ts` → `wmlimport.ts` → `wmlflow.ts` → `flow.ts` IS a cycle — resolve it the way `htmlflow.ts`/`cssflow.ts` do (read how `flow.ts` imports `htmlElements` and `cssflow.ts` imports `paragraph`, and follow the same structure, which that test already accepts or records).

- [ ] **Step 8: Commit**

```bash
git add src/wmlflow.ts src/wmlruns.ts src/wmlimport.ts src/flow.ts src/page.ts src/document.ts test/docx-import.test.ts
git commit -m "feat(m2fp.5): AddDocx renders paragraphs through the flow engine"
```

---

### Task 7: Character formatting, fonts and links

**Files:**
- Modify: `src/wmlruns.ts`
- Test: `test/docx-runs.test.ts`

**Interfaces:**
- Consumes: `WmlFlowEnv.family`, `SkipLog`.
- Produces: `inlineContent` now fills `TextRun.font` (face by bold/italic from the resolved family), `fontSize`, `color`, `underline`, `strikethrough`, `background` (highlight), `link` (external URL only); logs `font:<Name>` once per unresolved name per run, `w:hyperlink (anchor)` per anchor link run, and each run's `unmodelled` names.

- [ ] **Step 1: Write the failing tests** (`test/docx-runs.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';

const frags = (body: string, parts = {}) => {
  const doc = Document.New();
  const res = doc.AddDocx(buildDocx(body, parts));
  return { f: doc.Pages[0].GetTextFragments(), skipped: res.skipped, doc };
};

describe('AddDocx: runs', () => {
  it('draws bold and italic in the family\'s bold and italic faces', () => {
    const { f } = frags(p(r('plain ') + r('bold ', '<w:b/>') + r('ital', '<w:i/>')));
    expect(f.find((x) => x.text.includes('bold'))?.bold).toBe(true);
    expect(f.find((x) => x.text.includes('ital'))?.italic).toBe(true);
    expect(f.find((x) => x.text.includes('plain'))?.bold).toBeUndefined();
  });

  it('draws each run at its own size and colour', () => {
    const { f } = frags(p(r('big', '<w:sz w:val="40"/><w:color w:val="FF0000"/>') + r(' small', '<w:sz w:val="16"/>')));
    expect(f.find((x) => x.text.includes('big'))!.fontSize).toBeCloseTo(20, 3);
    expect(f.find((x) => x.text.includes('small'))!.fontSize).toBeCloseTo(8, 3);
    expect(f.find((x) => x.text.includes('big'))!.color).toEqual([1, 0, 0]);
  });

  it('falls back by the font table\'s class and reports the unresolved name once per run', () => {
    const { f, skipped } = frags(p(r('serif', '<w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/>')),
      { fontTable: '<w:font w:name="Cambria"><w:family w:val="roman"/></w:font>' });
    expect(f[0].fontName).toMatch(/Times/);
    expect(skipped).toContainEqual({ name: 'font:Cambria', count: 1, kind: 'degraded' });
  });

  it('renders text with no w:rFonts anywhere in a serif face and reports nothing about fonts (Review Focus 2)', () => {
    const { f, skipped } = frags(p(r('default')));
    expect(f[0].fontName).toMatch(/Times/);
    expect(skipped.filter((s) => s.name.startsWith('font:'))).toEqual([]);
  });

  it('links an external hyperlink and reports an internal anchor as degraded', () => {
    const { doc, skipped } = frags(p('<w:hyperlink r:id="rL">' + r('site') + '</w:hyperlink> '
      + '<w:hyperlink w:anchor="bm">' + r('there') + '</w:hyperlink>'),
      { rels: [{ id: 'rL', type: 'hyperlink', target: 'https://x.test/', external: true }] });
    const links = doc.Pages[0].Annotations.filter((a) => a.Subtype === 'Link');
    expect(links).toHaveLength(1);
    expect(skipped).toContainEqual({ name: 'w:hyperlink (anchor)', count: 1, kind: 'degraded' });
  });

  it('draws underline and strike, and reports a property it does not model', () => {
    const { skipped } = frags(p(r('u', '<w:u w:val="single"/>') + r('s', '<w:strike/>') + r('sup', '<w:vertAlign w:val="superscript"/>')));
    expect(skipped).toContainEqual({ name: 'w:vertAlign', count: 1, kind: 'degraded' });
  });

  it('reports text the resolved face cannot draw', () => {
    const { skipped } = frags(p(r('Привет')));
    expect(skipped.some((s) => s.name === 'text' || s.name === 'text:partial')).toBe(true);
  });
});
```

(Adjust `Annotation` accessor names to `src/annotation.ts`; `TextFragment.color` is absent for black — which is why the plain run is not asserted for colour.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/docx-runs.test.ts`
Expected: FAIL — runs carry no font, colour or link; nothing logs.

- [ ] **Step 3: Implement in `src/wmlruns.ts`**

Replace the text branch with a `textRun` helper:

```ts
function face(f: ResolvedFamily, bold: boolean, italic: boolean): AuthoringFont {
  return bold && italic ? f.boldItalic : bold ? f.bold : italic ? f.italic : f.regular;
}

function textRun(t: WmlText, c: RunCtx): TextRun {
  const fam = c.env.family(t.props.font);
  if (t.props.font !== undefined && !fam.resolved) c.log.add(`font:${t.props.font}`, 'degraded');
  for (const u of t.unmodelled) c.log.add(u, 'degraded');
  const run: TextRun = { text: t.text, font: face(fam.family, t.props.bold, t.props.italic), fontSize: t.props.sizePt };
  if (t.props.color) run.color = t.props.color;
  if (t.props.underline) run.underline = true;
  if (t.props.strike) run.strikethrough = true;
  if (t.props.highlight) run.background = t.props.highlight;
  if (t.link) {
    if ('url' in t.link) run.link = t.link.url;
    else c.log.add('w:hyperlink (anchor)', 'degraded');
  }
  return run;
}
```

(`RunProps.color`/`highlight` are `Rgb = [number, number, number]` in 0..1 — `hexColor` — which is `TextRun.color`'s shape.) In `inlineContent`, text: `runs.push(textRun(i, c))`; a line break pushes `{ text: '\n', ...fontOf(lastRun) }` so the break takes the preceding run's size; a tab pushes `{ ...fontOf(lastRun), text: ' ' }`, where `fontOf = (x?: TextRun) => x ? { font: x.font, fontSize: x.fontSize } : {}`.

Coverage: in `wmlflow.ts`'s `paragraphElements`, pass `onUndrawable: (u) => c.log.add(u.all ? 'text' : 'text:partial', u.all ? 'dropped' : 'degraded')` to `paragraph()` (and to `heading()`/`list()`/`table()` in the later tasks).

Also pass the block `font` to `paragraph()`: `font: content.runs.find((x) => x.font)?.font`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/docx-runs.test.ts test/docx-import.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wmlruns.ts src/wmlflow.ts test/docx-runs.test.ts
git commit -m "feat(m2fp.5): DOCX run formatting, font fallback by the font table, links"
```

---

### Task 8: Paragraph layout — alignment, spacing, leading, indents, headings

**Files:**
- Modify: `src/wmlflow.ts`
- Test: `test/docx-paragraphs.test.ts`

**Interfaces:**
- Consumes: `ParaProps` (`align`, `spaceBeforePt`, `spaceAfterPt`, `line`, `indent`), `WmlParagraph.heading`, `FlowParagraphOptions.indent` (Tasks 3-4), `heading()`.
- Produces: `paraOptions(p, content, c): FlowParagraphOptions` inside `wmlflow.ts`, reused by lists (Task 10).

- [ ] **Step 1: Write the failing tests** (`test/docx-paragraphs.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r, style } from './helpers/wml.js';

const first = (body: string, parts = {}) => {
  const doc = Document.New();
  const res = doc.AddDocx(buildDocx(body, parts));
  return { doc, res, f: doc.Pages[0].GetTextFragments() };
};
const yOf = (doc: Document, t: string) => doc.Pages[0].GetTextFragments().find((x) => x.text.includes(t))!.quad[1];
const xOf = (doc: Document, t: string) => doc.Pages[0].GetTextFragments().find((x) => x.text.includes(t))!.quad[0];

describe('AddDocx: paragraph layout', () => {
  it('centres and right-aligns', () => {
    const { doc } = first(p(r('mid'), '<w:jc w:val="center"/>') + p(r('end'), '<w:jc w:val="right"/>') + p(r('lft')));
    expect(xOf(doc, 'mid')).toBeGreaterThan(xOf(doc, 'lft') + 100);
    expect(xOf(doc, 'end')).toBeGreaterThan(xOf(doc, 'mid'));
  });

  it('adds space-after to the next space-before (the Word oracle\'s rule)', () => {
    const gap = (body: string) => { const { doc } = first(body); return yOf(doc, 'A') - yOf(doc, 'B'); };
    const base = gap(p(r('A')) + p(r('B')));
    const spaced = gap(p(r('A'), '<w:spacing w:after="240"/>') + p(r('B'), '<w:spacing w:before="360"/>'));
    expect(spaced - base).toBeCloseTo(12 + 18, 0);
  });

  it('honours exact line spacing', () => {
    const lines = (pPr: string) => {
      const { doc } = first(p(r('word '.repeat(80)), pPr));
      const ys = [...new Set(doc.Pages[0].GetTextFragments().map((x) => Math.round(x.quad[1] * 100) / 100))].sort((a, b) => b - a);
      return ys[0] - ys[1];
    };
    expect(lines('<w:spacing w:line="480" w:lineRule="exact"/>')).toBeCloseTo(24, 1);
  });

  it('indents left and first-line, and hangs', () => {
    const { doc } = first(p(r('base')) + p(r('ind'), '<w:ind w:left="720"/>') + p(r('word '.repeat(60) + 'fl'), '<w:ind w:firstLine="720"/>'));
    expect(xOf(doc, 'ind') - xOf(doc, 'base')).toBeCloseTo(36, 1);
  });

  it('clamps a hanging indent past the left margin and reports it', () => {
    const { res } = first(p(r('h'), '<w:ind w:left="0" w:hanging="360"/>'));
    expect(res.skipped).toContainEqual({ name: 'w:ind (hanging past margin)', count: 1, kind: 'degraded' });
  });

  it('makes an outline-level paragraph a heading, with Word\'s own face and size', () => {
    const styles = style('paragraph', 'H1', '<w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:sz w:val="32"/></w:rPr>');
    const doc = Document.New();
    doc.AddDocx(buildDocx(p(r('Title'), '<w:pStyle w:val="H1"/>') + p(r('body')), { styles }), { tagged: true });
    const types = (el: { Type: string; Children: unknown[] }[]): string[] =>
      el.flatMap((e) => [e.Type, ...types(e.Children as never)]);
    expect(types(doc.GetStructTree()!.Children as never)).toContain('H1');
    expect(doc.Pages[0].GetTextFragments().find((x) => x.text.includes('Title'))!.fontSize).toBeCloseTo(16, 3);
  });

  it('renders outline levels 7-9 as H6 and reports it', () => {
    const doc = Document.New();
    const { skipped } = doc.AddDocx(buildDocx(p(r('deep'), '<w:outlineLvl w:val="7"/>')), { tagged: true });
    expect(skipped).toContainEqual({ name: 'w:outlineLvl=7', count: 1, kind: 'degraded' });
  });
});
```

(Drop the stray `{ format: undefined }`/`{ }` arguments in `first` if typecheck objects.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/docx-paragraphs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `src/wmlflow.ts`**

```ts
/** A paragraph's flow options from Word's resolved properties. */
function paraOptions(p: WmlParagraph, content: { runs: TextRun[]; maxSize: number }, c: Ctx): FlowParagraphOptions {
  const pp = p.props;
  const size = content.maxSize > 0 ? content.maxSize : DEFAULT_SIZE;
  const single = size * 1.2;
  const leading = pp.line === undefined ? single
    : 'exactPt' in pp.line ? pp.line.exactPt
      : 'atLeastPt' in pp.line ? Math.max(single, pp.line.atLeastPt)
        : single * pp.line.auto;
  const o: FlowParagraphOptions = {
    font: content.runs.find((x) => x.font)?.font,
    fontSize: size,
    leading,
    spaceBefore: (pp.spaceBeforePt ?? 0) + c.gap,
    spaceAfter: pp.spaceAfterPt ?? 0,
    onUndrawable: (u) => c.log.add(u.all ? 'text' : 'text:partial', u.all ? 'dropped' : 'degraded'),
  };
  if (pp.align) o.align = pp.align;
  const ind = pp.indent;
  if (ind) {
    let left = ind.leftPt ?? 0, right = ind.rightPt ?? 0;
    if (left < 0 || right < 0) { c.log.add('w:ind (negative)', 'degraded'); left = Math.max(0, left); right = Math.max(0, right); }
    let firstLine = ind.firstLinePt ?? -(ind.hangingPt ?? 0);
    if (firstLine < -left) { c.log.add('w:ind (hanging past margin)', 'degraded'); firstLine = -left; }
    if (left !== 0 || right !== 0 || firstLine !== 0) o.indent = { left, right, firstLine };
  }
  return o;
}
```

Check `ParaProps.line`'s actual union spelling in `src/wmlstyles.ts` (`{ exactPt } | { atLeastPt } | { auto }`) and `Indent`'s field names (`leftPt`, `rightPt`, `firstLinePt`, `hangingPt`).

In `paragraphElements`: the empty-paragraph gap becomes `c.gap += (pp.spaceBeforePt ?? 0) + leading + (pp.spaceAfterPt ?? 0)` (compute via `paraOptions`); a non-empty paragraph with `p.heading !== undefined`:

```ts
  const o = paraOptions(p, content, c);
  c.gap = 0;
  if (p.heading !== undefined) {
    if (p.heading > 6) c.log.add(`w:outlineLvl=${p.heading - 1}`, 'degraded');
    cur(c).push(...heading(Math.min(p.heading, 6), content.runs,
      { ...o, font: o.font ?? 'Times-Roman', fontSize: o.fontSize, align: o.align === 'justify' ? 'left' : o.align }));
    return;
  }
  cur(c).push(...paragraph(content.runs, o));
```

(The explicit `font`/`fontSize` stop `heading()`'s Helvetica-Bold/24pt defaults applying — `cssflow.ts`'s rule.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/docx-paragraphs.test.ts test/docx-import.test.ts test/docx-runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wmlflow.ts test/docx-paragraphs.test.ts
git commit -m "feat(m2fp.5): DOCX alignment, spacing, leading, indents and headings"
```

---

### Task 9: Images

**Files:**
- Modify: `src/wmlruns.ts`, `src/wmlflow.ts`
- Test: `test/docx-images.test.ts`

**Interfaces:**
- Consumes: `WmlInline` `{ kind: 'image'; part?; widthPt; heightPt; alt? }`, `WmlFlowEnv.image`, `image()` from `flow.ts`, `imageSize` from `imageembed.ts`.
- Produces: an image among text → `FlowAtomic { beforeRun, data, width, height }`; a paragraph that is ONE image (and whitespace) → block `image(data, { width, height, alt, align })`; logs `image:<contentType>` (dropped) for bytes `imageSize` cannot read, `a:blip (unreadable image)` (dropped) when `env.image` returns nothing.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocx } from './helpers/build-docx.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';
import { p, r } from './helpers/wml.js';

const drawing = (rid: string, cxPt: number, cyPt: number) => '<w:r><w:drawing><wp:inline>'
  + `<wp:extent cx="${cxPt * 12700}" cy="${cyPt * 12700}"/><wp:docPr id="1" name="p" descr="A cat"/>`
  + `<a:graphic><a:graphicData uri="x"><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>`
  + '</wp:inline></w:drawing></w:r>';
const png = buildPngRgbWith(4, 4, [0, 128, 255]);
const media = { media: [{ name: 'i.png', bytes: png, contentType: 'image/png' }],
  rels: [{ id: 'rI', type: 'image', target: 'media/i.png' }] };

describe('AddDocx: images', () => {
  it('draws a lone image as a figure at its extent', () => {
    const doc = Document.New();
    const { skipped } = doc.AddDocx(buildDocx(p(drawing('rI', 100, 50)), media), { tagged: true });
    expect(skipped).toEqual([]);
    expect(doc.Pages[0].Images).toHaveLength(1);
  });

  it('draws an image among words on the text line', () => {
    const doc = Document.New();
    doc.AddDocx(buildDocx(p(r('before ') + drawing('rI', 12, 12) + r(' after')), media));
    expect(doc.Pages[0].Images).toHaveLength(1);
    expect(doc.Pages[0].GetText()).toMatch(/before[\s\S]*after/);
  });

  it('drops an image in a format we cannot draw, naming its type', () => {
    const doc = Document.New();
    const emf = { media: [{ name: 'i.emf', bytes: new Uint8Array([1, 0, 0, 0]), contentType: 'image/x-emf' }],
      rels: [{ id: 'rI', type: 'image', target: 'media/i.emf' }] };
    const { skipped } = doc.AddDocx(buildDocx(p(r('t ') + drawing('rI', 12, 12)), emf));
    expect(skipped).toContainEqual({ name: 'image:image/x-emf', count: 1, kind: 'dropped' });
    expect(doc.Pages[0].GetText()).toContain('t');
  });
});
```

(`page.Images` is the XObject image list; confirm the accessor name on `Page`.)

Add the placement-compromise case too (the spec's `onSkipped` for a Flow; `doc.AddDocx` folds these in):

```ts
  it('reports an image scaled to fit a column it is taller than, as degraded', () => {
    const doc = Document.New();
    const { skipped } = doc.AddDocx(buildDocx(p(drawing('rI', 400, 2000)), media));
    expect(skipped).toContainEqual({ name: 'image:scaled-to-fit', count: 1, kind: 'degraded' });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/docx-images.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

In `wmlruns.ts`, the image branch:

```ts
    } else if (i.kind === 'image') {
      const a = imageAtomic(i, runs.length, c);
      if (a) atomics.push(a);
    }
```

```ts
/** An image's bytes and drawn size, or undefined — reported — when it cannot be drawn. */
export function imageData(i: Extract<WmlInline, { kind: 'image' }>, c: RunCtx): Uint8Array | undefined {
  if (i.part === undefined) return undefined;          // readDocx already recorded why
  const got = c.env.image(i.part);
  if (!got) { c.log.add('a:blip (unreadable image)', 'dropped'); return undefined; }
  if (imageSize(got.bytes) === undefined) { c.log.add(`image:${got.contentType ?? 'unknown'}`, 'dropped'); return undefined; }
  return got.bytes;
}

function imageAtomic(i: Extract<WmlInline, { kind: 'image' }>, beforeRun: number, c: RunCtx): FlowAtomic | undefined {
  const data = imageData(i, c);
  if (!data || !(i.widthPt > 0) || !(i.heightPt > 0)) return undefined;
  return { beforeRun, data, width: i.widthPt, height: i.heightPt };
}
```

In `wmlflow.ts`'s `paragraphElements`, BEFORE computing content: if the inlines hold exactly one image and every other inline is whitespace text, build a block figure:

```ts
  const meaningful = inlines.filter((x) => !(x.kind === 'text' && x.text.trim() === ''));
  if (meaningful.length === 1 && meaningful[0].kind === 'image') {
    const img = meaningful[0];
    const data = imageData(img, c);
    if (data) {
      try {
        cur(c).push(...image(data, {
          width: img.widthPt > 0 ? img.widthPt : undefined, height: img.heightPt > 0 ? img.heightPt : undefined,
          alt: img.alt, align: p.props.align === 'center' || p.props.align === 'right' ? p.props.align : 'left',
          spaceBefore: (p.props.spaceBeforePt ?? 0) + c.gap, spaceAfter: p.props.spaceAfterPt ?? 0,
        }));
        c.gap = 0;
      } catch (caught) { rethrowLimit(caught); c.log.add('image:undecodable', 'dropped'); }
    }
    return;
  }
```

and pass `atomics: content.atomics.length > 0 ? content.atomics : undefined` in `paraOptions`' result for text paragraphs. Treat a paragraph whose runs are blank but which carries atomics as non-empty (already so from Task 6's guard).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/docx-images.test.ts test/docx-import.test.ts test/limits-catch.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wmlruns.ts src/wmlflow.ts test/docx-images.test.ts
git commit -m "feat(m2fp.5): DOCX inline and block images"
```

---

### Task 10: Lists

**Files:**
- Modify: `src/wmlflow.ts`
- Test: `test/docx-lists.test.ts`

**Interfaces:**
- Consumes: `WmlParagraph.list { numId; ilvl; ordinal; label; bullet }`, `FlowListItem.label` (Task 2), `list()`, `coverageOf` from `textcoverage.ts`.
- Produces: `listElements(paras: WmlParagraph[], c)`; a run of consecutive list paragraphs (none of them a heading) → one `list()`, nested by `ilvl`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r, numPr, lvl, style } from './helpers/wml.js';

const NUM = `<w:abstractNum w:abstractNumId="0">${lvl(0, 'decimal', '%1.')}${lvl(1, 'lowerLetter', '%1.%2)')}</w:abstractNum>`
  + '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>'
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>';
const li = (text: string, numId: number, ilvl = 0) => p(r(text), numPr(numId, ilvl));

const render = (body: string, parts = {}) => {
  const doc = Document.New();
  const res = doc.AddDocx(buildDocx(body, { numbering: NUM, ...parts }), { tagged: true });
  return { doc, res, text: doc.Pages[0].GetText() };
};
const types = (doc: Document): string[] => {
  const walk = (els: { Type: string; Children: unknown[] }[]): string[] => els.flatMap((e) => [e.Type, ...walk(e.Children as never)]);
  return walk(doc.GetStructTree()!.Children as never);
};

describe('AddDocx: lists', () => {
  it('draws Word\'s own labels, nested', () => {
    const { text } = render(li('one', 1) + li('sub', 1, 1) + li('two', 1));
    expect(text).toMatch(/1\.\s*one[\s\S]*1\.a\)\s*sub[\s\S]*2\.\s*two/);
  });

  it('tags a list as /L > /LI, nested', () => {
    const { doc } = render(li('one', 1) + li('sub', 1, 1));
    expect(types(doc).filter((t) => t === 'L').length).toBe(2);
    expect(types(doc)).toContain('LI');
  });

  it('continues numbering across an interrupting paragraph (Review Focus 3)', () => {
    const { text } = render(li('a', 1) + li('b', 1) + p(r('interrupt')) + li('c', 1));
    expect(text).toMatch(/3\.\s*c/);
  });

  it('draws a Symbol-font bullet as U+2022 and reports it', () => {
    const { text, res } = render(li('dot', 2));
    expect(text).toContain('•');
    expect(res.skipped).toContainEqual({ name: 'w:lvlText (bullet glyph)', count: 1, kind: 'degraded' });
  });

  it('keeps a numbered heading a heading, its label drawn in front (Review Focus 4)', () => {
    const styles = style('paragraph', 'H', '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>');
    const { doc, text } = render(p(r('Scope'), '<w:pStyle w:val="H"/>' + numPr(1, 0)), { styles });
    expect(types(doc)).toContain('H2');
    expect(types(doc)).not.toContain('L');
    expect(text).toMatch(/1\.\s*Scope/);
  });
});
```

(Check `numPr`/`lvl` helper signatures in `test/helpers/wml.ts`; the bullet `lvlText` must reach the XML as the character U+F0B7 — the `''` escape in a TS string literal does that.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/docx-lists.test.ts` — Expected: FAIL (lists render as plain paragraphs without labels).

- [ ] **Step 3: Implement in `src/wmlflow.ts`**

```ts
const BULLET = '•';

function listItem(p: WmlParagraph, c: Ctx): FlowListItem {
  const content = inlineContent(p.inlines, c);
  const o = paraOptions(p, content, c);
  let label = p.list!.label;
  const font = o.font ?? 'Times-Roman';
  if (p.list!.bullet && label !== '' && coverageOf(label, font, false) !== undefined) {
    label = BULLET;
    c.log.add('w:lvlText (bullet glyph)', 'degraded');
  }
  const item: FlowListItem = { text: content.runs, label, font, fontSize: o.fontSize, leading: o.leading };
  if (content.atomics.length > 0) item.atomics = content.atomics;
  if (o.align && o.align !== 'justify') item.align = o.align;
  if (p.props.indent?.leftPt) item.indent = p.props.indent.leftPt;
  item.spaceBefore = o.spaceBefore; item.spaceAfter = o.spaceAfter;
  return item;
}

/** A run of consecutive list paragraphs as ONE list, nested by ilvl. A level
 *  deeper than its predecessor's child level nests under the last item there
 *  is (the engine cannot express a skipped level). */
function listElements(paras: WmlParagraph[], c: Ctx): void {
  const roots: FlowListItem[] = [];
  const stack: { ilvl: number; item: FlowListItem }[] = [];
  for (const p of paras) {
    const item = listItem(p, c);
    c.gap = 0;
    const ilvl = p.list!.ilvl;
    while (stack.length > 0 && stack[stack.length - 1].ilvl >= ilvl) stack.pop();
    if (stack.length === 0) roots.push(item);
    else (stack[stack.length - 1].item.items ??= []).push(item);
    stack.push({ ilvl, item });
  }
  cur(c).push(...list(roots, {
    onUndrawable: (u) => c.log.add(u.all ? 'text' : 'text:partial', u.all ? 'dropped' : 'degraded'),
  }));
}
```

In `blockElements`, collect consecutive `b.kind === 'paragraph' && b.list && b.heading === undefined` paragraphs (with no page break inside — a paragraph containing a page/column break ends the run and goes through the paragraph path) and call `listElements`. A HEADING with `list` goes through the heading path with its label prepended as a run: in `paragraphElements`, when `p.heading !== undefined && p.list`, `content.runs.unshift({ text: `${p.list.label} `, font: content.runs[0]?.font, fontSize: content.runs[0]?.fontSize })`.

The first item's `spaceBefore` must also absorb a pending empty-paragraph gap: `item.spaceBefore = o.spaceBefore` already includes `c.gap` via `paraOptions`; reset `c.gap = 0` after the first item (done in the loop). Import `list`, `type FlowListItem` from `./flow.js` and `coverageOf` from `./textcoverage.js` (check its signature — `coverageOf(text, font, shaped)`; pass the label string).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/docx-lists.test.ts test/docx-import.test.ts test/docx-paragraphs.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wmlflow.ts test/docx-lists.test.ts
git commit -m "feat(m2fp.5): DOCX lists with Word's own labels, nested and tagged"
```

---

### Task 11: Tables

**Files:**
- Modify: `src/wmlflow.ts`
- Test: `test/docx-tables.test.ts`

**Interfaces:**
- Consumes: `WmlTable { gridPt; rows: { header; cells; gridBefore?; gridAfter? }[]; unmodelled }`, `WmlCell { span; vMerge?; shading?; blocks }`, `createTable`, `table()` from `flowtable.ts`.
- Produces: `tableElements(t: WmlTable, c)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';

const tc = (text: string, tcPr = '') => `<w:tc>${tcPr ? `<w:tcPr>${tcPr}</w:tcPr>` : ''}${p(r(text))}</w:tc>`;
const tbl = (grid: number[], rows: string[]) => `<w:tbl><w:tblGrid>${grid.map((g) => `<w:gridCol w:w="${g * 20}"/>`).join('')}</w:tblGrid>`
  + rows.join('') + '</w:tbl>';
const tr = (cells: string, trPr = '') => `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cells}</w:tr>`;

const render = (body: string) => {
  const doc = Document.New();
  const res = doc.AddDocx(buildDocx(body), { tagged: true });
  return { doc, res, text: doc.Pages[0].GetText() };
};
const cellTypes = (doc: Document): string[] => {
  const walk = (els: { Type: string; Children: unknown[] }[]): string[] => els.flatMap((e) => [e.Type, ...walk(e.Children as never)]);
  return walk(doc.GetStructTree()!.Children as never);
};

describe('AddDocx: tables', () => {
  it('draws cells in grid order and tags /Table > /TR > /TD', () => {
    const { doc, text } = render(tbl([100, 100], [tr(tc('a1') + tc('b1')), tr(tc('a2') + tc('b2'))]));
    expect(text).toMatch(/a1[\s\S]*b1[\s\S]*a2[\s\S]*b2/);
    expect(cellTypes(doc)).toEqual(expect.arrayContaining(['Table', 'TR', 'TD']));
  });

  it('spans columns and merges rows', async () => {
    const { doc } = render(tbl([100, 100], [
      tr(tc('wide', '<w:gridSpan w:val="2"/>')),
      tr(tc('tall', '<w:vMerge w:val="restart"/>') + tc('x')),
      tr(tc('', '<w:vMerge/>') + tc('y')),
    ]));
    const te = doc.GetStructTree()!;
    const all = (els: never[]): { Type: string; TableAttributes?: { colSpan?: number; rowSpan?: number } }[] =>
      els.flatMap((e: { Children: never[] }) => [e, ...all(e.Children)]) as never;
    const tds = all(te.Children as never).filter((e) => e.Type === 'TD');
    expect(tds.some((e) => e.TableAttributes?.colSpan === 2)).toBe(true);
    expect(tds.some((e) => e.TableAttributes?.rowSpan === 2)).toBe(true);
  });

  it('counts a vertical merge down the GRID column in a row shifted by gridBefore (Review Focus 5)', () => {
    const { doc } = render(tbl([100, 100, 100], [
      tr(tc('a') + tc('m', '<w:vMerge w:val="restart"/>') + tc('c')),
      tr(tc('', '<w:vMerge/>') + tc('z'), '<w:gridBefore w:val="1"/>'),
    ]));
    const all = (els: never[]): { Type: string; TableAttributes?: { rowSpan?: number } }[] =>
      els.flatMap((e: { Children: never[] }) => [e, ...all(e.Children)]) as never;
    expect(all(doc.GetStructTree()!.Children as never).some((e) => e.TableAttributes?.rowSpan === 2)).toBe(true);
  });

  it('repeats header rows and marks them /TH', () => {
    const { doc } = render(tbl([100], [tr(tc('Head'), '<w:tblHeader/>'), tr(tc('body'))]));
    expect(cellTypes(doc)).toContain('TH');
  });

  it('scales a grid wider than the column instead of overflowing (Review Focus 1)', () => {
    const { doc } = render(tbl([400, 400], [tr(tc('left') + tc('right'))]));
    const f = doc.Pages[0].GetTextFragments().find((x) => x.text.includes('right'))!;
    expect(f.quad[2]).toBeLessThan(doc.Pages[0].CropBox[2] - 72 + 1);
  });

  it('flattens a nested table into its cell and reports it', () => {
    const inner = tbl([50], [tr(tc('inner'))]);
    const { text, res } = render(tbl([200], [tr(`<w:tc>${p(r('outer'))}${inner}${p('')}</w:tc>`)]));
    expect(text).toMatch(/outer[\s\S]*inner/);
    expect(res.skipped).toContainEqual({ name: 'w:tbl (nested)', count: 1, kind: 'degraded' });
  });

  it('separates a cell\'s paragraphs with a line break', () => {
    const { text } = render(tbl([200], [tr(`<w:tc>${p(r('alpha'))}${p(r('beta'))}</w:tc>`)]));
    expect(text).not.toContain('alphabeta');
  });
});
```

Check `StructElement.TableAttributes`' field names (`colSpan`/`rowSpan` or `ColSpan`/`RowSpan`) in `src/structattr.ts` and adjust.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/docx-tables.test.ts` — Expected: FAIL (tables are ignored).

- [ ] **Step 3: Implement in `src/wmlflow.ts`**

```ts
const GRID_BORDER = { width: 0.5, color: [0, 0, 0] as [number, number, number] };

/** A cell's content as runs: its paragraphs joined by line breaks, a nested
 *  table flattened row by row and reported (csstable.ts's rule). */
function cellContent(blocks: WmlBlock[], c: Ctx): { runs: TextRun[]; atomics: FlowAtomic[]; align?: 'left' | 'center' | 'right' } {
  const runs: TextRun[] = [];
  const atomics: FlowAtomic[] = [];
  let align: 'left' | 'center' | 'right' | undefined;
  const addPara = (p: WmlParagraph): void => {
    if (runs.length > 0) runs.push({ text: '\n' });
    if (p.list) runs.push({ text: `${p.list.label} ` });
    const got = inlineContent(p.inlines.filter((i) => !(i.kind === 'break' && i.type !== 'line')), c);
    for (const a of got.atomics) atomics.push({ ...a, beforeRun: a.beforeRun + runs.length });
    runs.push(...got.runs);
    if (align === undefined && p.props.align && p.props.align !== 'justify') align = p.props.align;
  };
  const walk = (bs: WmlBlock[]): void => {
    for (const b of bs) {
      if (b.kind === 'paragraph') addPara(b);
      else { c.log.add('w:tbl (nested)', 'degraded'); for (const row of b.rows) for (const cell of row.cells) walk(cell.blocks); }
    }
  };
  walk(blocks);
  return align === undefined ? { runs, atomics } : { runs, atomics, align };
}

function tableElements(t: WmlTable, c: Ctx): void {
  for (const u of t.unmodelled) c.log.add(u, 'degraded');
  const tb = createTable({ border: GRID_BORDER, outerBorder: GRID_BORDER, fontSize: DEFAULT_SIZE });
  const total = t.gridPt.reduce((a, b) => a + b, 0);
  if (t.gridPt.length > 0 && total > 0)
    tb.setColumnWidths(t.gridPt.map((g) => (total <= c.width ? { fixed: g } : { fraction: g / total })));
  else tb.autoFitColumns();

  // Grid column of every cell, then rowSpan for each vMerge restart counted down that column.
  const cols = t.rows.map((row) => {
    let col = row.gridBefore ?? 0;
    return row.cells.map((cell) => { const at = col; col += cell.span; return at; });
  });
  const mergeAt = (ri: number, col: number): 'restart' | 'continue' | undefined => {
    const k = cols[ri]?.indexOf(col) ?? -1;
    return k < 0 ? undefined : t.rows[ri].cells[k].vMerge;
  };
  let headers = 0;
  t.rows.forEach((row, ri) => {
    if (row.header && headers === ri) headers++;
    const rb = tb.addRow();
    if (row.gridBefore) rb.addCell('', { colSpan: row.gridBefore });
    row.cells.forEach((cell, k) => {
      if (cell.vMerge === 'continue') return;          // covered by the restart above
      let rowSpan = 1;
      if (cell.vMerge === 'restart') while (mergeAt(ri + rowSpan, cols[ri][k]) === 'continue') rowSpan++;
      const content = cellContent(cell.blocks, c);
      rb.addCell(content.runs, {
        colSpan: cell.span, rowSpan,
        ...(content.align ? { align: content.align } : {}),
        ...(cell.shading ? { background: cell.shading } : {}),
        ...(content.atomics.length > 0 ? { atomics: content.atomics } : {}),
      });
    });
    if (row.gridAfter) rb.addCell('', { colSpan: row.gridAfter });
  });
  if (headers > 0) tb.setRepeatingRowsCount(headers);
  cur(c).push(...table(tb, {
    spaceBefore: c.gap,
    onUndrawable: (u) => c.log.add(u.all ? 'text' : 'text:partial', u.all ? 'dropped' : 'degraded'),
  }));
  c.gap = 0;
}
```

Check against `src/tableauthor.ts`: that `addRow()` with no arguments returns a `RowBuilder` whose `addCell(text, opts)` exists; that `autoFitColumns()` exists on `TableBuilder`; that a `CellOptions.background` field exists (it is `CellTextOptions.background`); and the `table()` options type in `src/flowtable.ts` (`FlowTableOptions`). Add `else if (b.kind === 'table') tableElements(b, c);` to `blockElements` (flushing any pending list run first).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/docx-tables.test.ts test/docx-import.test.ts test/docx-lists.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wmlflow.ts test/docx-tables.test.ts
git commit -m "feat(m2fp.5): DOCX tables with spans, merges, headers and grid scaling"
```

---

### Task 12: `docxFileToPdf`, public exports, README and CHANGELOG

**Files:**
- Modify: `src/node.ts`, `src/index.ts`, `README.md`, `CHANGELOG.md`
- Test: `test/docx-file.test.ts`, `test/readme-api.test.ts` (counts only, if it asserts them literally)

**Interfaces:**
- Produces: `export interface DocxFileOptions extends DocxFlowOptions, FlowOptions { title?: string }` and `export async function docxFileToPdf(inputPath: string, outPath: string, options?: DocxFileOptions): Promise<{ skipped: DocxSkipped[] }>` in `src/node.ts`; index exports `docxFileToPdf`, types `DocxFileOptions`, `DocxFlowOptions`, `DocxFlowResult`, `AddDocxResult`, `DocxSkipped`.

- [ ] **Step 1: Write the failing test** (`test/docx-file.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docxFileToPdf, Document } from '../src/index.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';

describe('docxFileToPdf', () => {
  it('reads a .docx, writes the PDF, and returns what did not render', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'docx-'));
    const input = join(dir, 'in.docx'); const output = join(dir, 'out', 'o.pdf');
    writeFileSync(input, buildDocx(p(r('From a file.')) + p('<w:r><w:footnoteReference w:id="1"/></w:r>')));
    const { skipped } = await docxFileToPdf(input, output);
    expect(skipped).toContainEqual({ name: 'w:footnoteReference', count: 1, kind: 'dropped' });
    expect(Document.Open(new Uint8Array(readFileSync(output))).Pages[0].GetText()).toContain('From a file.');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/docx-file.test.ts` — Expected: FAIL (not exported).

- [ ] **Step 3: Implement**

`src/node.ts`, after `htmlFileToPdf`:

```ts
/** How {@link docxFileToPdf} renders: everything `doc.AddDocx` takes. */
export interface DocxFileOptions extends DocxFlowOptions, FlowOptions {
  /** Document title. Non-empty. Default: the document's own core-properties title. */
  title?: string;
}

/** Read a Word document (.docx) from disk, render it, and write the PDF to
 *  `outPath` (`m2fp.5`). The one-call form of `Document.New` + `AddDocx` +
 *  `Save`; returns what did not render. */
export async function docxFileToPdf(
  inputPath: string, outPath: string, options: DocxFileOptions = {},
): Promise<{ skipped: DocxSkipped[] }> {
  const bytes = new Uint8Array(await readFile(inputPath));
  const doc = Document.New();
  const { skipped } = doc.AddDocx(bytes, options);
  await mkdir(dirname(resolve(outPath)), { recursive: true });
  await writeFile(outPath, doc.Save());
  return { skipped };
}
```

`src/index.ts`: add `docxFileToPdf` to the `./node.js` export list beside `htmlFileToPdf`, `type DocxFileOptions` beside `HtmlFileOptions`, and `export type { DocxFlowOptions, DocxFlowResult, AddDocxResult, DocxSkipped } from './wmlimport.js';` beside the `htmlflow.js` type exports.

- [ ] **Step 4: Documentation**

- `README.md` **Key Capabilities**: after the HTML-to-PDF bullet, add a **Word (DOCX) to PDF** bullet: the three entry points and `docxFileToPdf`; the subset (paragraphs and styles, headings by outline level, character formatting, Word's own list labels, tables with merged cells and repeating header rows, inline and block images, external links, page size and margins from the last section); fonts resolve through registered folders and otherwise by the font table's family class; everything else — headers, footers, footnotes, text boxes, floating placement, tab stops, internal links, tracked-change display — is counted in `skipped` as `dropped` or `degraded`; legacy `.doc` is not read.
- **Additional Examples**: an imperative-headed example `### Render a Word Document` showing `doc.AddDocx(bytes, { tagged: true })`, reading `skipped`, and `docxFileToPdf`.
- **API Reference**: rows `flow.AddDocx(src, opts?)` / `page.AddDocx(bytes, rect, opts?)` / `doc.AddDocx(bytes, opts?)` in the same table as the `AddHtml` row; `docxFileToPdf(inputPath, outPath, opts?)` beside `htmlFileToPdf`; type rows `DocxFlowOptions`, `DocxFlowResult`, `AddDocxResult`, `DocxSkipped`, `DocxFileOptions` in the table and alphabetical run where their `Html*` siblings sit.
- **Scope and Limitations**: a DOCX bullet stating it is a documented subset, not a Word layout engine, with the out-of-scope list and the `.doc` refusal.
- Run `npx vitest run test/readme-api.test.ts`; if it reports new counts, update the intro sentence's counts to what it says.
- `CHANGELOG.md` → `## [Unreleased]` → `### Added`, newest first: a bold lead-in — **Word documents render to PDF.** — then prose: what the three entry points and `docxFileToPdf` do, the subset, that Word's own list labels and indents render because the flow engine gained `FlowListItem.label` and `FlowParagraphOptions.indent` (both opt-in, existing output byte-identical), that fonts fall back by the producer's font-table class rather than a guessed name table, that paragraph spacing adds as Word's does (measured through Word 2010 COM), that the real-world Word/LibreOffice corpus renders with its expected text and structure, and what is reported rather than drawn. End with `(m2fp.5)`.

- [ ] **Step 5: Run to verify**

Run: `npx vitest run test/docx-file.test.ts test/readme-api.test.ts && npm run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/node.ts src/index.ts README.md CHANGELOG.md test/docx-file.test.ts
git commit -m "feat(m2fp.5): docxFileToPdf, public exports, README and CHANGELOG"
```

---

### Task 13: Corpus, round trip and entry-point equivalence

**Files:**
- Create: `test/docx-import-corpus.test.ts`, `test/docx-roundtrip.test.ts`

**Interfaces:**
- Consumes: `readTruth`, `comparable`, `COUNT_KEYS`, `type DocxTruth` from `test/helpers/docx-truth.ts`; the corpus `.docx` files and their `.word.json`/`.lo.json` truths; `SKIP_MAP` (copy it from `test/docx-corpus.test.ts` — or export it from there into `test/helpers/docx-truth.ts` and import it in both, which is better: do that).

- [ ] **Step 1: Write the corpus test**

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/index.js';
import { readTruth, COUNT_KEYS, SKIP_MAP, type DocxTruth } from './helpers/docx-truth.js';

const DIR = join(__dirname, 'fixtures', 'docx');
const NOT_CORPUS = new Set(['wml-oracle.docx', 'spacing-oracle.docx']);
const files = readdirSync(DIR).filter((f) => f.endsWith('.docx') && !NOT_CORPUS.has(f)).sort();
const truthsOf = (f: string): DocxTruth[] =>
  ['word', 'lo'].map((k) => join(DIR, `${f.replace(/\.docx$/, '')}.${k}.json`)).filter(existsSync).map(readTruth);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe.each(files)('AddDocx renders %s', (f) => {
  const truths = truthsOf(f);
  const doc = Document.New();
  const { pages, skipped } = doc.AddDocx(new Uint8Array(readFileSync(join(DIR, f))), { tagged: true });
  const text = norm(pages.map((p) => p.GetText()).join(' '));

  it('draws every paragraph\'s text both readers agree on', () => {
    const agreed = truths[0].paragraphs.map((p) => p.text)
      .filter((t) => truths.every((u) => u.paragraphs.some((q) => q.text === t)))
      .map(norm).filter((t) => t !== '' && !t.includes('\t'));
    for (const t of agreed) expect(text).toContain(t);
  });

  it('tags a heading for every paragraph both readers call one, and a table for every table', () => {
    const types: string[] = [];
    const walk = (els: { Type: string; Children: unknown[] }[]): void => { for (const e of els) { types.push(e.Type); walk(e.Children as never); } };
    walk(doc.GetStructTree()!.Children as never);
    const headings = truths[0].paragraphs.filter((p) => p.heading !== null && truths.every((u) => u.paragraphs.some((q) => q.text === p.text && q.heading === p.heading)));
    expect(types.filter((t) => /^H[1-6]$/.test(t)).length).toBeGreaterThanOrEqual(headings.length);
    expect(types.filter((t) => t === 'Table').length).toBeGreaterThanOrEqual(Math.min(...truths.map((u) => u.tables.length)));
  });

  it('names in skipped every construct both readers counted', () => {
    const names = new Set(skipped.map((s) => s.name));
    const missing = COUNT_KEYS.filter((k) => truths.every((t) => t.counts[k] > 0) && !SKIP_MAP[k].some((n) => names.has(n)));
    expect(missing).toEqual([]);
  });
});
```

Paragraphs holding a tab are excluded from the text check because a tab renders as one space — a TOC entry's `Title\t3` draws as `Title 3`. If a corpus file still fails a line, look at why before excluding anything: a genuine rendering gap is a defect in Tasks 6-11, not a test to loosen. Record any residual exclusion in the test with its reason.

- [ ] **Step 2: Write the round-trip test** (`test/docx-roundtrip.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';

const SRC = '# Report\n\nOpening paragraph with **bold** words.\n\n- first\n- second\n\n| A | B |\n|---|---|\n| 1 | 2 |\n';

const typesOf = (doc: Document): string[] => {
  const out: string[] = [];
  const walk = (els: { Type: string; Children: unknown[] }[]): void => { for (const e of els) { out.push(e.Type); walk(e.Children as never); } };
  walk(doc.GetStructTree()!.Children as never);
  return out;
};

describe('ToDocx -> AddDocx round trip', () => {
  it('keeps the text and the structure types', () => {
    const original = Document.New();
    original.AddMarkdown(SRC, { gfm: true, tagged: true });
    const again = Document.New();
    again.AddDocx(original.ToDocx(), { tagged: true });
    const norm = (d: Document) => d.Pages.map((p) => p.GetText()).join(' ').replace(/\s+/g, ' ').trim();
    expect(norm(again)).toBe(norm(original));
    for (const t of ['H1', 'P', 'L', 'LI', 'Table', 'TR', 'TD']) expect(typesOf(again)).toContain(t);
  });
});
```

If the text differs only in list markers (Markdown draws `•` as a vector shape with no text, while a DOCX bullet draws the glyph `•`), normalise markers out of both sides and record why in a comment.

- [ ] **Step 3: Run**

Run: `npx vitest run test/docx-import-corpus.test.ts test/docx-roundtrip.test.ts test/docx-corpus.test.ts`
Expected: PASS. Failures here are defects in the mapper: fix them in the owning task's module with a unit case in that task's test file first.

- [ ] **Step 4: Commit**

```bash
git add test/docx-import-corpus.test.ts test/docx-roundtrip.test.ts test/helpers/docx-truth.ts test/docx-corpus.test.ts
git commit -m "test(m2fp.5): the real-world corpus and a ToDocx round trip through AddDocx"
```

---

### Task 14: CLAUDE.md, mutation sweep and final gates

**Files:**
- Modify: `CLAUDE.md` (Source list entries for `wmlflow.ts`, `wmlruns.ts`, `wmlimport.ts`; notes on `flow.ts`'s `label` and `indent` and `layout.ts`'s first-line indent)
- Create (scratch, not committed): a mutation script in the session scratchpad

- [ ] **Step 1: Mutation sweep**

Write a node script (the `mut9.mjs` shape used in m2fp.9: exact-string replace, run the named test files, restore, print RED n / GREEN / NOT APPLIED) covering at least:
1. `kindOf` returns `'degraded'` always.
2. `SkipLog.list` returns the internal records (no copy) — the fresh-array case must redden.
3. Empty-paragraph gap dropped (`c.gap += …` removed).
4. `splitAtBreaks` ignores page breaks.
5. Leading: exact line spacing ignored.
6. `firstLine < -left` clamp removed.
7. Heading level not clamped to 6.
8. Bullet fallback removed (label kept as U+F0B7).
9. List nesting flattened (every item a root).
10. vMerge counted by cell index instead of grid column.
11. Grid always `fixed` (no scaling).
12. Nested-table report removed.
13. `layoutRuns` `limit()` returns `boxWidth` always.
14. `lineX` ignores `line.indent`.
15. `TextElement` continuation keeps `firstLineIndent`.
16. `IndentElement` scale not applied (width minus raw indent).
17. `label` ignored in `walk`.
18. Anchor link reported nothing.
19. Font fallback ignores the font table (always `'sans-serif'`).
20. `doc.AddDocx` ignores `sectPr` geometry.
21. `reportCompromises` reports with `kindOf(name)` instead of `'degraded'` (the scaled image then reads as dropped).

Every mutation must redden or be recorded as a redundant defence/equivalent mutant with the reason. For each green one, either add the case that makes it red (in the owning task's test file) or record it in CLAUDE.md as NOT covered, with why.

- [ ] **Step 2: CLAUDE.md**

Add Source-list entries (bold module names) for `wmlflow.ts`, `wmlruns.ts`, `wmlimport.ts`, recording: segments at breaks and why; the kind table and its default; the font-table fallback and the "resolved means an EmbeddedFont" test; the empty-paragraph gap; spacing measured COLLAPSING (max) against Word and emitted as `spaceBefore = max(0, before - previousAfter)` (`test/spacing-oracle.test.ts`, and why `Information(6)` of a spaced paragraph is not a witness); lists grouped by run, labels from `readDocx`, the U+2022 bullet rule; numbered headings stay headings; tables' grid-column vMerge counting and grid scaling; images; the mutation results from Step 1. Under the `flow.ts` / `layout.ts` entries add the `label` and `indent` notes (opt-in, byte-identical fences, continuation drops the first-line indent, over-wide first-line word residue). Run the module sweep from CLAUDE.md's Conventions and confirm it prints nothing.

- [ ] **Step 3: Final gates**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/index.js` exists.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md test/
git commit -m "docs(m2fp.5): CLAUDE.md entries and mutation results for DOCX import"
```
