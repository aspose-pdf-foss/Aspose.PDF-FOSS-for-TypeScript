# /DR Resource Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc.Optimize()` removes `/AcroForm /DR` resources nothing in the document can name, so a face a since-removed field registered stops being written by `Save()`.

**Architecture:** A new `src/drprune.ts` collects every reference a document can make into `/DR` — every `/DA` string, and every name an `/AP` stream cannot resolve against its own `/Resources` — deletes the unreferenced entries, then takes a reachability diff to count the bytes freed and delete the objects it orphaned. `optimize.ts` runs it first, ahead of images/fonts/dedup/compress.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest, zero runtime dependencies.

Spec: `docs/superpowers/specs/2026-08-04-dr-resource-pruning-design.md`. Issue: `h7g5`.

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension (`import { parseContentStream } from './content.js'`).
- **`strict` TypeScript.** `npm run typecheck` must be clean.
- **`npm run typecheck` and `npm test` must both be green before the issue is closed.** Target one file with `npx vitest run test/optimize-dr.test.ts`.
- **Task tracking is `bd`, not TodoWrite or markdown TODO lists** (see `CLAUDE.md`).
- **Public API changes are mirrored in `README.md`** — the Optimization section and the Limitations bullet.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Write multi-line messages via a file (`git commit -F`) or repeated `-m`; PowerShell here-strings do not work in the Bash tool.

## File Structure

| File | Responsibility |
|---|---|
| `src/drprune.ts` (create) | The whole pass: reference collection, the prune, byte accounting, orphan deletion. Exports `pruneDefaultResources(doc)` and `DrPruneResult`. |
| `src/optimize.ts` (modify) | Orchestration only: the `dr` option, the report field, running it first, folding its bytes into the total. |
| `src/index.ts` (modify) | Export the `DrPruneResult` type so `OptimizeReport['dr']` is nameable by consumers. |
| `test/helpers/build-dr-pdf.ts` (create) | Fixture builders: a form document with referenced and unreferenced `/DR` entries under several variants, plus a bare one whose `/DR` empties completely. |
| `test/optimize-dr.test.ts` (create) | All tests for the pass — collector unit tests, prune tests through `pruneDefaultResources`, integration tests through `doc.Optimize()`. |
| `README.md` (modify) | Optimization section table + prose, and the Optimize limitation bullet. |
| `CLAUDE.md` (modify) | Add `drprune.ts` to the Optimize architecture bullet. |

---

### Task 1: The reference collector

The pure half: given parsed content ops, which resource names does this fragment use? No `Document`, no PDF I/O — the piece worth unit-testing directly.

**Files:**
- Create: `src/drprune.ts`
- Create: `test/optimize-dr.test.ts`

**Interfaces:**
- Consumes: `ContentOp` / `parseContentStream` from `src/content.ts`, `isName` from `src/types.ts`.
- Produces:
  - `DR_CATEGORIES: readonly string[]` — `['Font','XObject','ExtGState','ColorSpace','Pattern','Shading','Properties']`
  - `refKey(category: string, name: string): string` — `` `${category}/${name}` ``
  - `collectResourceRefs(ops: readonly ContentOp[], out: Set<string>): void`

- [ ] **Step 1: Write the failing tests**

Create `test/optimize-dr.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseContentStream } from '../src/content.js';
import { collectResourceRefs } from '../src/drprune.js';

/** Every resource reference in a content-stream fragment, sorted. */
const refs = (src: string): string[] => {
  const out = new Set<string>();
  collectResourceRefs(parseContentStream(new TextEncoder().encode(src)), out);
  return [...out].sort();
};

describe('collectResourceRefs', () => {
  it('collects one name per resource-naming operator', () => {
    expect(refs('/GS0 gs BT /Helv 9 Tf ET /Im0 Do /Sh0 sh')).toEqual(
      ['ExtGState/GS0', 'Font/Helv', 'Shading/Sh0', 'XObject/Im0'],
    );
  });

  it('ignores device colour spaces and keeps named ones', () => {
    expect(refs('/DeviceRGB cs /DeviceGray CS /CS0 cs')).toEqual(['ColorSpace/CS0']);
  });

  it('reads a pattern from the last scn operand', () => {
    expect(refs('/Pattern cs /P0 scn 1 0 0 SCN')).toEqual(['Pattern/P0']);
  });

  it('reads a marked-content property list, but not the tag', () => {
    expect(refs('/OC /MC0 BDC EMC')).toEqual(['Properties/MC0']);
  });

  it('reads an inline image colour space', () => {
    expect(refs('BI /W 1 /H 1 /BPC 8 /CS /CS0 /L 3 ID abc EI')).toEqual(['ColorSpace/CS0']);
  });

  it('is silent on a fragment that names nothing', () => {
    expect(refs('/Tx BMC EMC')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/optimize-dr.test.ts`
Expected: FAIL — `Failed to resolve import "../src/drprune.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/drprune.ts`:

```ts
import { ContentOp } from './content.js';
import { isName } from './types.js';

/** The /DR categories this pass prunes. /ProcSet is an array of names rather
 *  than a resource dict, and is left alone. */
export const DR_CATEGORIES: readonly string[] = [
  'Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties',
];

/** Colour spaces an operator may name that no /Resources ever holds: the device
 *  spaces, /Pattern, and the inline-image abbreviations (32000-1 table 93). */
const DEVICE_SPACES: ReadonlySet<string> = new Set([
  'DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern',
  'G', 'RGB', 'CMYK', 'I', 'Indexed',
]);

/** A reference key. Split at the *first* '/', which is unambiguous: a category
 *  name never contains one, a resource name (via a #2F escape) might. */
export const refKey = (category: string, name: string): string => `${category}/${name}`;

/** Every resource name a content fragment uses, as `Category/name` keys. The
 *  fragment may be a page's content, an /AP stream, or a /DA string — a /DA is
 *  a content-stream fragment by definition (32000-1 12.7.3.3), which is what
 *  lets one collector serve both of this pass's sources. */
export function collectResourceRefs(ops: readonly ContentOp[], out: Set<string>): void {
  for (const op of ops) {
    const a = op.operands;
    const first = a[0];
    switch (op.operator) {
      case 'Tf': if (isName(first)) out.add(refKey('Font', first.name)); break;
      case 'Do': if (isName(first)) out.add(refKey('XObject', first.name)); break;
      case 'gs': if (isName(first)) out.add(refKey('ExtGState', first.name)); break;
      case 'sh': if (isName(first)) out.add(refKey('Shading', first.name)); break;
      case 'cs': case 'CS':
        if (isName(first) && !DEVICE_SPACES.has(first.name)) out.add(refKey('ColorSpace', first.name));
        break;
      case 'scn': case 'SCN': {
        // A pattern is named by the *last* operand; the leading numbers are the
        // underlying colour components of an uncoloured pattern.
        const last = a[a.length - 1];
        if (isName(last)) out.add(refKey('Pattern', last.name));
        break;
      }
      case 'BDC': {
        // operands are [tag, propertyList]; only an inline dict avoids /Properties.
        const props = a[1];
        if (isName(props)) out.add(refKey('Properties', props.name));
        break;
      }
      case 'BI': {
        const d = op.inlineImage?.dict;
        const cs = d?.get('CS') ?? d?.get('ColorSpace');
        if (isName(cs) && !DEVICE_SPACES.has(cs.name)) out.add(refKey('ColorSpace', cs.name));
        break;
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/optimize-dr.test.ts` — Expected: PASS (6 tests)
Run: `npm run typecheck` — Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/drprune.ts test/optimize-dr.test.ts
git commit -m "feat(optimize): resource-reference collector for /DR pruning (h7g5)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Fixture builder, and the prune driven by /DA

The pass end to end for the `/DA` half: collect from every `/DA` reachable from the catalog, delete what nothing names, count the freed bytes, delete the orphans. `/AP` streams arrive in Task 3, so a fixture whose appearance names something is expected to over-prune until then — Task 3's tests are what pin it.

**Files:**
- Create: `test/helpers/build-dr-pdf.ts`
- Modify: `src/drprune.ts`
- Modify: `test/optimize-dr.test.ts`

**Interfaces:**
- Consumes: `collectResourceRefs`, `refKey`, `DR_CATEGORIES` from Task 1.
- Produces:
  - `interface DrPruneResult { removed: string[]; bytesSaved: number; skipped?: string }`
  - `pruneDefaultResources(doc: Document): DrPruneResult`
  - `buildDrPdf(opts?: DrPdfOptions): Uint8Array`, `buildBareDrPdf(): Uint8Array`,
    `DR_TIBO_PROGRAM_BYTES`, `DR_IMAGE_BYTES` from `test/helpers/build-dr-pdf.ts`

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-dr-pdf.ts`:

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** The /DR /Font /TiBo program: unreferenced, so the prune orphans it. */
export const DR_TIBO_PROGRAM_BYTES = 600;
/** The /DR /XObject /Im0 payload: unreferenced likewise. */
export const DR_IMAGE_BYTES = 300;

export interface DrPdfOptions {
  /** /AcroForm /XFA present — the hybrid-XFA veto. */
  xfa?: boolean;
  /** The widget's /AP /N claims /FlateDecode over garbage — the unreadable-appearance veto. */
  badAp?: boolean;
  /** The /AP names /GS0 through `gs`, but its own /Resources carries only /Font. */
  apUsesExtGState?: boolean;
  /** The /AP carries no /Resources at all and names /Helv2 through `Tf`. */
  apNoResources?: boolean;
  /** A FreeText annotation whose /DA names /TiIt. */
  freeText?: boolean;
}

/**
 * One-page form document whose /AcroForm /DR carries entries reached in every
 * way the pass must honour, plus entries nothing reaches:
 *
 *   /Font /Helv    <- the AcroForm-level /DA
 *   /Font /HeBo    <- the text field's /DA
 *   /Font /TiRo    <- a kid widget's own /DA
 *   /Font /TiIt    <- a FreeText annotation's /DA   (opts.freeText)
 *   /Font /Helv2   <- a /Resources-free /AP stream  (opts.apNoResources)
 *   /Font /TiBo    <- nothing; owns a font program of DR_TIBO_PROGRAM_BYTES
 *   /Font /Shared  <- nothing; its program is the page font's, so pruning it
 *                     orphans two dicts and no stream bytes
 *   /XObject /Im0  <- nothing; DR_IMAGE_BYTES of payload
 *   /ExtGState /GS0 <- an /AP that lacks it locally (opts.apUsesExtGState)
 */
export function buildDrPdf(opts: DrPdfOptions = {}): Uint8Array {
  const objects: string[] = [];
  const reserve = (): number => { objects.push(''); return objects.length; };
  const put = (n: number, body: string): number => { objects[n - 1] = body; return n; };
  const add = (body: string): number => put(reserve(), body);
  const stream = (dict: string, body: string): number =>
    add(`<< ${dict} /Length ${byteLen(body)} >>\nstream\n${body}\nendstream`);

  // Reserved up front: their bodies name objects allocated further down.
  const catalog = reserve(), pagesN = reserve(), pageN = reserve(), acroN = reserve();
  const textField = reserve(), noteField = reserve();

  const contents = stream('', 'BT /F1 12 Tf 20 200 Td (page text) Tj ET');

  // The page font and the program it shares with /DR /Font /Shared.
  const sharedProgram = stream('/Length1 400', 'S'.repeat(400));
  const sharedDescriptor = add(`<< /Type /FontDescriptor /FontName /PageFace /Flags 4 /FontFile2 ${sharedProgram} 0 R >>`);
  const pageFont = add(`<< /Type /Font /Subtype /TrueType /BaseFont /PageFace /FirstChar 32 /LastChar 32 /Widths [500] /FontDescriptor ${sharedDescriptor} 0 R >>`);

  const std = (base: string): number =>
    add(`<< /Type /Font /Subtype /Type1 /BaseFont /${base} /Encoding /WinAnsiEncoding >>`);
  const drHelv = std('Helvetica'), drHeBo = std('Helvetica-Bold');
  const drTiRo = std('Times-Roman'), drTiIt = std('Times-Italic');
  const drHelv2 = std('Helvetica');

  const tiboProgram = stream('/Length1 600', 'T'.repeat(DR_TIBO_PROGRAM_BYTES));
  const tiboDescriptor = add(`<< /Type /FontDescriptor /FontName /TiBoFace /Flags 4 /FontFile2 ${tiboProgram} 0 R >>`);
  const drTiBo = add(`<< /Type /Font /Subtype /TrueType /BaseFont /TiBoFace /FirstChar 32 /LastChar 32 /Widths [500] /FontDescriptor ${tiboDescriptor} 0 R >>`);
  const drShared = add(`<< /Type /Font /Subtype /TrueType /BaseFont /PageFace /FirstChar 32 /LastChar 32 /Widths [500] /FontDescriptor ${sharedDescriptor} 0 R >>`);

  const drImage = stream(
    '/Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceGray /BitsPerComponent 8',
    'i'.repeat(DR_IMAGE_BYTES),
  );

  // The text field's appearance, in one of four shapes.
  const apBody = opts.apNoResources
    ? '/Tx BMC q BT /Helv2 9 Tf 2 5 Td (Bob) Tj ET Q EMC'
    : opts.apUsesExtGState
      ? '/Tx BMC q /GS0 gs BT /HeBo 9 Tf 2 5 Td (Bob) Tj ET Q EMC'
      : '/Tx BMC q BT /HeBo 9 Tf 2 5 Td (Bob) Tj ET Q EMC';
  const apResources = opts.apNoResources ? '' : `/Resources << /Font << /HeBo ${drHeBo} 0 R >> >>`;
  const apN = opts.badAp
    ? stream('/Type /XObject /Subtype /Form /BBox [0 0 190 20] /Filter /FlateDecode', 'not-deflate-data')
    : stream(`/Type /XObject /Subtype /Form /BBox [0 0 190 20] ${apResources}`, apBody);

  put(textField, `<< /FT /Tx /T (name) /V (Bob) /DA (/HeBo 9 Tf 0 g) /Type /Annot /Subtype /Widget /Rect [10 10 200 30] /AP << /N ${apN} 0 R >> >>`);
  const noteWidget = add(`<< /Parent ${noteField} 0 R /Type /Annot /Subtype /Widget /Rect [10 40 200 60] /DA (/TiRo 9 Tf 0 g) >>`);
  put(noteField, `<< /FT /Tx /T (note) /Kids [${noteWidget} 0 R] >>`);

  const freeText = opts.freeText
    ? add(`<< /Type /Annot /Subtype /FreeText /Rect [220 10 380 40] /Contents (memo) /DA (/TiIt 11 Tf 0 g) >>`)
    : 0;
  const xfa = opts.xfa ? stream('', '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"></xdp:xdp>') : 0;

  const drFonts = [
    `/Helv ${drHelv} 0 R`, `/HeBo ${drHeBo} 0 R`, `/TiRo ${drTiRo} 0 R`,
    `/TiIt ${drTiIt} 0 R`, `/Helv2 ${drHelv2} 0 R`, `/TiBo ${drTiBo} 0 R`,
    `/Shared ${drShared} 0 R`,
  ].join(' ');
  const dr = `<< /Font << ${drFonts} >> /XObject << /Im0 ${drImage} 0 R >> /ExtGState << /GS0 << /Type /ExtGState /ca 0.5 >> >> >>`;

  put(acroN, `<< /Fields [${textField} 0 R ${noteField} 0 R] /DA (/Helv 0 Tf 0 g) /DR ${dr}${xfa ? ` /XFA ${xfa} 0 R` : ''} >>`);
  put(catalog, `<< /Type /Catalog /Pages ${pagesN} 0 R /AcroForm ${acroN} 0 R >>`);
  put(pagesN, `<< /Type /Pages /Count 1 /Kids [${pageN} 0 R] /MediaBox [0 0 400 400] >>`);
  const annots = [textField, noteWidget, freeText].filter((n) => n !== 0).map((n) => `${n} 0 R`).join(' ');
  put(pageN, `<< /Type /Page /Parent ${pagesN} 0 R /Resources << /Font << /F1 ${pageFont} 0 R >> >> /Contents ${contents} 0 R /Annots [${annots}] >>`);

  return assemble(objects);
}

/** An /AcroForm whose whole /DR is unreferenced: no /DA anywhere, no fields.
 *  The prune must take the /Font dict and /DR itself with it. */
export function buildBareDrPdf(): Uint8Array {
  const objects: string[] = [];
  const reserve = (): number => { objects.push(''); return objects.length; };
  const put = (n: number, body: string): number => { objects[n - 1] = body; return n; };
  const add = (body: string): number => put(reserve(), body);

  const catalog = reserve(), pagesN = reserve(), pageN = reserve(), acroN = reserve();
  const contents = add(`<< /Length 0 >>\nstream\n\nendstream`);
  const drTiBo = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>`);
  put(acroN, `<< /Fields [] /DR << /Font << /TiBo ${drTiBo} 0 R >> >> >>`);
  put(catalog, `<< /Type /Catalog /Pages ${pagesN} 0 R /AcroForm ${acroN} 0 R >>`);
  put(pagesN, `<< /Type /Pages /Count 1 /Kids [${pageN} 0 R] /MediaBox [0 0 400 400] >>`);
  put(pageN, `<< /Type /Page /Parent ${pagesN} 0 R /Resources << >> /Contents ${contents} 0 R >>`);
  return assemble(objects);
}

/** Wrap object bodies in a classic-xref file. */
function assemble(objects: string[]): Uint8Array {
  let body = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = new Array(objects.length + 1).fill(0);
  for (let n = 1; n <= objects.length; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n - 1]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objects.length; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

- [ ] **Step 2: Write the failing tests**

Append to `test/optimize-dr.test.ts` (and extend its import block):

```ts
import { Document } from '../src/document.js';
import { PdfDict, isDict, isStream } from '../src/types.js';
import { pruneDefaultResources } from '../src/drprune.js';
import { buildDrPdf, buildBareDrPdf, DR_TIBO_PROGRAM_BYTES, DR_IMAGE_BYTES, DrPdfOptions } from './helpers/build-dr-pdf.js';

/** The live /AcroForm /DR, or undefined once the prune has deleted it. */
function drOf(doc: Document): PdfDict | undefined {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (!isDict(acro)) return undefined;
  const dr = doc.resolve(acro.get('DR'));
  return isDict(dr) ? dr : undefined;
}

/** The /DR /Font keys still present, sorted. */
function fontKeys(doc: Document): string[] {
  const dr = drOf(doc);
  const fonts = dr ? doc.resolve(dr.get('Font')) : null;
  return isDict(fonts) ? [...fonts.keys()].sort() : [];
}

const opened = (opts: DrPdfOptions = {}) => Document.Open(buildDrPdf(opts));

describe('pruneDefaultResources', () => {
  it('removes a face no /DA and no appearance names', () => {
    const doc = opened();
    const r = pruneDefaultResources(doc);
    expect(r.removed).toContain('Font/TiBo');
    expect(r.removed).toContain('Font/Shared');
    expect(r.skipped).toBeUndefined();
    expect(fontKeys(doc)).not.toContain('TiBo');
  });

  it('keeps the face the AcroForm-level /DA names', () => {
    const doc = opened();
    pruneDefaultResources(doc);
    expect(fontKeys(doc)).toContain('Helv');
  });

  it("keeps the face a field's own /DA names", () => {
    const doc = opened();
    pruneDefaultResources(doc);
    expect(fontKeys(doc)).toContain('HeBo');
  });

  it("keeps the face a kid widget's /DA names", () => {
    const doc = opened();
    pruneDefaultResources(doc);
    expect(fontKeys(doc)).toContain('TiRo');
  });

  it('keeps a face only a FreeText annotation names, and drops it otherwise', () => {
    const withNote = opened({ freeText: true });
    pruneDefaultResources(withNote);
    expect(fontKeys(withNote)).toContain('TiIt');

    const without = opened();
    expect(pruneDefaultResources(without).removed).toContain('Font/TiIt');
  });

  it('prunes categories other than /Font', () => {
    const doc = opened();
    expect(pruneDefaultResources(doc).removed).toContain('XObject/Im0');
    const dr = drOf(doc);
    expect(dr?.has('XObject')).toBe(false);
  });

  it('counts the orphaned program and the orphaned image, but not a shared program', () => {
    const doc = opened();
    const r = pruneDefaultResources(doc);
    // /Shared's program is the page font's: pruning that entry frees two dicts
    // and no stream payload.
    expect(r.bytesSaved).toBe(DR_TIBO_PROGRAM_BYTES + DR_IMAGE_BYTES);
  });

  it('leaves a program the page still reaches in the document', () => {
    const doc = opened();
    pruneDefaultResources(doc);
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
    const fonts = doc.resolve(res.get('Font')) as PdfDict;
    const font = doc.resolve(fonts.get('F1')) as PdfDict;
    const fd = doc.resolve(font.get('FontDescriptor')) as PdfDict;
    expect(isStream(doc.resolve(fd.get('FontFile2')))).toBe(true);
  });

  it('deletes a category dict and /DR itself once the prune empties them', () => {
    const doc = Document.Open(buildBareDrPdf());
    expect(pruneDefaultResources(doc).removed).toEqual(['Font/TiBo']);
    expect(drOf(doc)).toBeUndefined();
  });

  it('leaves a document with no /DR alone', () => {
    const doc = Document.Open(buildBareDrPdf());
    pruneDefaultResources(doc);
    const again = pruneDefaultResources(doc);
    expect(again.removed).toEqual([]);
    expect(again.bytesSaved).toBe(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/optimize-dr.test.ts`
Expected: FAIL — `pruneDefaultResources is not a function` (the Task 1 collector tests still pass).

- [ ] **Step 4: Write the implementation**

Add to `src/drprune.ts` — extend the import block and append:

```ts
import type { Document } from './document.js';
import { ContentOp, parseContentStream } from './content.js';
import {
  PdfDict, PdfObject, PdfRef, isDict, isStream, isArray, isName, isString, isRef,
} from './types.js';
import { refsIn } from './serializer.js';
```

```ts
export interface DrPruneResult {
  /** Qualified keys removed, e.g. 'Font/TiBo'. */
  removed: string[];
  bytesSaved: number;
  /** Set when the pass declined to run; `removed` is then empty. */
  skipped?: string;
}

/** Charge to /DR every name `local` holds that `res` does not resolve. A /DA
 *  has no resource dict of its own, so all of its names are charged. */
function chargeUnresolved(doc: Document, local: Set<string>, res: PdfObject, out: Set<string>): void {
  for (const key of local) {
    const cut = key.indexOf('/');
    const category = key.slice(0, cut), nm = key.slice(cut + 1);
    const table = isDict(res) ? doc.resolve(res.get(category)) : null;
    if (isDict(table) && table.has(nm)) continue;
    out.add(key);
  }
}

/**
 * Every reference the document can make into /DR: each /DA string, and each
 * name an /AP stream cannot resolve against its own /Resources.
 *
 * The walk starts at the catalog, not at `doc.objectEntries()`, and that is
 * load-bearing rather than tidy. `Form.RemoveField` unwires a field and leaves
 * its dict in the object map for `Save()`'s mark-sweep to drop; scanning every
 * object would read the /DA of the very field whose removal this pass exists to
 * clean up after, and the pass would never remove anything.
 */
function collectDrReferences(doc: Document): { refs: Set<string> } | { veto: string } {
  const refs = new Set<string>();
  const seen = new Set<PdfObject>();
  let veto: string | undefined;

  const scan = (stream: PdfObject): void => {
    if (!isStream(stream)) return;
    let ops: ContentOp[];
    try { ops = parseContentStream(decodeStream(stream)); }
    catch { veto ??= 'an appearance stream could not be read'; return; }
    const local = new Set<string>();
    collectResourceRefs(ops, local);
    chargeUnresolved(doc, local, doc.resolve(stream.dict.get('Resources')), refs);
  };

  const visitAP = (ap: PdfObject): void => {
    const d = doc.resolve(ap);
    if (!isDict(d)) return;
    for (const key of ['N', 'D', 'R']) {
      const entry = doc.resolve(d.get(key));
      if (isStream(entry)) scan(entry);
      // The sub-dictionary form: /N << /Yes 5 0 R /Off 6 0 R >>.
      else if (isDict(entry)) for (const v of entry.values()) scan(doc.resolve(v));
    }
  };

  const visit = (o: PdfObject): void => {
    const r = doc.resolve(o);
    if (isArray(r)) {
      if (seen.has(r)) return;
      seen.add(r);
      for (const v of r) visit(v);
      return;
    }
    const d = isDict(r) ? r : isStream(r) ? r.dict : undefined;
    if (!d || seen.has(d)) return;
    seen.add(d);
    const da = doc.resolve(d.get('DA'));
    if (isString(da)) {
      try { collectResourceRefs(parseContentStream(da.bytes), refs); }
      catch { veto ??= 'a /DA string could not be read'; }
    }
    const ap = d.get('AP');
    if (ap !== undefined) visitAP(ap);
    for (const v of d.values()) visit(v);
  };

  visit(doc.catalog());
  return veto !== undefined ? { veto } : { refs };
}

/** Object numbers reachable from /Root (+ /Info) — what `Save()` would write. */
function reachableSet(doc: Document): Set<number> {
  const objects = new Map<number, PdfObject>();
  for (const [r, o] of doc.objectEntries()) objects.set(r.num, o);
  const seen = new Set<number>();
  const queue: number[] = [];
  const push = (n: number): void => {
    if (seen.has(n) || !objects.has(n)) return;
    seen.add(n);
    queue.push(n);
  };
  for (const key of ['Root', 'Info']) {
    const r = doc.trailer.get(key);
    if (isRef(r)) push(r.num);
  }
  while (queue.length) {
    const out: PdfRef[] = [];
    refsIn(objects.get(queue.shift()!)!, out);
    for (const r of out) push(r.num);
  }
  return seen;
}

/**
 * Delete /AcroForm /DR entries nothing in the document can name, and the objects
 * that leaves unreachable.
 *
 * Deleting the orphans is what keeps the rest of Optimize honest: an orphaned
 * stream left in the object map is still walked by dedup and recompress, which
 * would report bytes saved on an object `Save()` was going to drop anyway. It is
 * a mark-sweep confined to what this pass orphaned — anything already unreachable
 * beforehand is left to `Save()`.
 */
export function pruneDefaultResources(doc: Document): DrPruneResult {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (!isDict(acro)) return { removed: [], bytesSaved: 0 };
  const dr = doc.resolve(acro.get('DR'));
  if (!isDict(dr)) return { removed: [], bytesSaved: 0 };

  const found = collectDrReferences(doc);
  if ('veto' in found) return { removed: [], bytesSaved: 0, skipped: found.veto };
  const refs = found.refs;

  const before = reachableSet(doc);
  const removed: string[] = [];
  for (const category of DR_CATEGORIES) {
    const table = doc.resolve(dr.get(category));
    if (!isDict(table)) continue;
    let removedHere = 0;
    for (const nm of [...table.keys()]) {
      if (refs.has(refKey(category, nm))) continue;
      table.delete(nm);
      removed.push(refKey(category, nm));
      removedHere++;
    }
    // An empty category dict is a leftover; the next Add* rebuilds what it needs.
    if (removedHere > 0 && table.size === 0) dr.delete(category);
  }
  if (removed.length === 0) return { removed, bytesSaved: 0 };
  if (dr.size === 0) acro.delete('DR');

  const after = reachableSet(doc);
  let bytesSaved = 0;
  const orphans: number[] = [];
  for (const [r, o] of [...doc.objectEntries()]) {
    if (!before.has(r.num) || after.has(r.num)) continue;
    orphans.push(r.num);
    // Stream payloads only. A font dict with no program frees bytes the report
    // cannot measure, matching the estimate the rest of OptimizeReport gives.
    if (isStream(o)) bytesSaved += o.raw.length;
  }
  for (const num of orphans) doc.deleteObject(num);
  return { removed, bytesSaved };
}
```

Also add the `decodeStream` import to the top of the file:

```ts
import { decodeStream } from './filters.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/optimize-dr.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: clean

- [ ] **Step 6: Prove the catalog-rooted walk is load-bearing**

Temporarily change `visit(doc.catalog())` to walk every object instead:

```ts
  for (const [, o] of doc.objectEntries()) visit(o);
```

Run: `npx vitest run test/optimize-dr.test.ts` — Expected: still PASS, which is the point: no test here covers it, and Task 5's end-to-end test is the one that must go red. Revert the change before committing, and do not add a test for it now — Task 5 Step 6 verifies it.

- [ ] **Step 7: Commit**

```bash
git add src/drprune.ts test/optimize-dr.test.ts test/helpers/build-dr-pdf.ts
git commit -m "feat(optimize): prune /DR entries no /DA names (h7g5)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Appearance streams as a reference source

Task 2 already routes `/AP` streams through `chargeUnresolved`; this task is the tests that pin the two shapes that matter, plus the fixpoint for a `/DR` entry that is itself a content stream.

**Files:**
- Modify: `src/drprune.ts`
- Modify: `test/optimize-dr.test.ts`

**Interfaces:**
- Consumes: `pruneDefaultResources`, `collectResourceRefs`, `DR_CATEGORIES`, `refKey` from Tasks 1–2.
- Produces: no new exported names.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('pruneDefaultResources', ...)` block:

```ts
  it('keeps a face only a /Resources-free appearance names', () => {
    const doc = opened({ apNoResources: true });
    pruneDefaultResources(doc);
    expect(fontKeys(doc)).toContain('Helv2');
  });

  it('drops that face when no appearance names it', () => {
    expect(pruneDefaultResources(opened()).removed).toContain('Font/Helv2');
  });

  it('keeps an /ExtGState an appearance names but its own /Resources lacks', () => {
    const doc = opened({ apUsesExtGState: true });
    const r = pruneDefaultResources(doc);
    expect(r.removed).not.toContain('ExtGState/GS0');
    const gs = doc.resolve(drOf(doc)!.get('ExtGState'));
    expect(isDict(gs) && gs.has('GS0')).toBe(true);
  });

  it('drops an /ExtGState nothing names', () => {
    expect(pruneDefaultResources(opened()).removed).toContain('ExtGState/GS0');
  });

  it('does not charge a name the appearance resolves locally', () => {
    // /HeBo lives in the /AP's own /Resources *and* in the field /DA, so the
    // entry survives — but it must survive on the /DA, not on a name the
    // appearance already resolved for itself.
    const doc = opened();
    pruneDefaultResources(doc);
    expect(fontKeys(doc)).toContain('HeBo');
  });
```

- [ ] **Step 2: Run the tests to verify the state of play**

Run: `npx vitest run test/optimize-dr.test.ts`
Expected: PASS — Task 2's implementation already covers these. If any fails, the `/AP` path is wrong and this is where it surfaces.

- [ ] **Step 3: Write the failing test for a /DR entry that is itself a stream**

Append inside the same block:

```ts
  it('keeps a face named by a /DR form XObject the appearance draws', () => {
    // /DR /XObject /Im0 is unreferenced, so it goes; a *referenced* /DR stream
    // that names another /DR entry must keep it alive.
    const doc = opened({ apNoResources: true });
    const dr = drOf(doc)!;
    const xobjects = doc.resolve(dr.get('XObject')) as PdfDict;
    // A form XObject with no /Resources of its own, drawn by the appearance.
    const form = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')],
        ['BBox', [0, 0, 10, 10]],
      ]),
      raw: new TextEncoder().encode('BT /TiIt 9 Tf (x) Tj ET'),
    });
    xobjects.set('Fx0', form);

    // Make the appearance draw it, so /XObject /Fx0 is referenced.
    const field = doc.Form.Get('name')!;
    const ap = doc.resolve(field.Dict.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N'));
    if (!isStream(n)) throw new Error('no /AP /N stream');
    doc.replaceObject((ap.get('N') as PdfRef).num, {
      kind: 'stream', dict: n.dict,
      raw: new TextEncoder().encode('/Tx BMC q /Fx0 Do BT /Helv2 9 Tf (Bob) Tj ET Q EMC'),
    });

    const r = pruneDefaultResources(doc);
    expect(r.removed).not.toContain('XObject/Fx0');
    expect(r.removed).not.toContain('Font/TiIt');
    expect(fontKeys(doc)).toContain('TiIt');
  });
```

Extend the test file's imports with `name` and `PdfObject`, `PdfRef`:

```ts
import { PdfDict, PdfObject, PdfRef, isDict, isStream, name } from '../src/types.js';
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run test/optimize-dr.test.ts -t 'form XObject'`
Expected: FAIL — `Font/TiIt` is in `removed`: nothing scans the `/DR` stream, so the face it names looks unused.

- [ ] **Step 5: Write the fixpoint**

Add to `src/drprune.ts`, above `pruneDefaultResources`:

```ts
/**
 * A /DR entry can itself be a content stream — a form XObject, a tiling pattern —
 * naming further /DR entries. Charge those, for *kept* entries only, to a
 * fixpoint.
 *
 * Kept-only is what makes the pass idempotent. Charging every /DR stream would
 * let an entry that this same run deletes keep a resource alive, and the next
 * Optimize would then remove more than this one did.
 */
function chargeKeptDrStreams(doc: Document, dr: PdfDict, refs: Set<string>): string | undefined {
  for (;;) {
    let grew = false;
    for (const category of DR_CATEGORIES) {
      const table = doc.resolve(dr.get(category));
      if (!isDict(table)) continue;
      for (const nm of table.keys()) {
        if (!refs.has(refKey(category, nm))) continue;
        const entry = doc.resolve(table.get(nm));
        if (!isStream(entry)) continue;
        let ops: ContentOp[];
        try { ops = parseContentStream(decodeStream(entry)); }
        catch { return 'a /DR resource stream could not be read'; }
        const local = new Set<string>();
        collectResourceRefs(ops, local);
        const before = refs.size;
        chargeUnresolved(doc, local, doc.resolve(entry.dict.get('Resources')), refs);
        if (refs.size !== before) grew = true;
      }
    }
    if (!grew) return undefined;
  }
}
```

Call it in `pruneDefaultResources`, immediately after `const refs = found.refs;`:

```ts
  const streamVeto = chargeKeptDrStreams(doc, dr, refs);
  if (streamVeto !== undefined) return { removed: [], bytesSaved: 0, skipped: streamVeto };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/optimize-dr.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: clean

- [ ] **Step 7: Commit**

```bash
git add src/drprune.ts test/optimize-dr.test.ts
git commit -m "feat(optimize): charge appearance and /DR-stream names to /DR (h7g5)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The vetoes

Two documents the scan cannot prove complete against. Both leave the model untouched.

**Files:**
- Modify: `src/drprune.ts`
- Modify: `test/optimize-dr.test.ts`

**Interfaces:**
- Consumes: `pruneDefaultResources` from Task 2.
- Produces: no new exported names.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('pruneDefaultResources', ...)`:

```ts
  it('declines a document whose appearance cannot be read', () => {
    const doc = opened({ badAp: true });
    const before = doc.Save();
    const r = pruneDefaultResources(doc);
    expect(r.removed).toEqual([]);
    expect(r.bytesSaved).toBe(0);
    expect(r.skipped).toMatch(/appearance/);
    expect(fontKeys(doc)).toContain('TiBo');
    expect(doc.Save()).toEqual(before);
  });

  it('declines a hybrid XFA document', () => {
    const doc = opened({ xfa: true });
    const before = doc.Save();
    const r = pruneDefaultResources(doc);
    expect(r.removed).toEqual([]);
    expect(r.skipped).toMatch(/XFA/);
    expect(fontKeys(doc)).toContain('TiBo');
    expect(doc.Save()).toEqual(before);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/optimize-dr.test.ts -t 'declines'`
Expected: the XFA test FAILS (`skipped` is undefined and `TiBo` is gone). The unreadable-appearance test already passes — `collectDrReferences` returns its veto from Task 2 — which is the intended state; the assertion set here is what pins it.

- [ ] **Step 3: Add the XFA veto**

In `pruneDefaultResources`, between the `/AcroForm` check and the `/DR` lookup:

```ts
  // An XFA packet names /DR faces and txgg documented that we never read it. A
  // scan that structurally cannot see those references is not complete, and
  // "unused" is exactly the conclusion it must not draw. Editing a hybrid
  // document stays allowed — concluding something in it is dead does not.
  if (acro.has('XFA')) {
    return {
      removed: [], bytesSaved: 0,
      skipped: 'a hybrid XFA document may name /DR resources from its XFA packet',
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/optimize-dr.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: clean

- [ ] **Step 5: Prove the unreadable-appearance veto is load-bearing**

In `collectDrReferences`, temporarily change the `scan` catch to swallow instead of vetoing:

```ts
    catch { return; }
```

Run: `npx vitest run test/optimize-dr.test.ts -t 'cannot be read'`
Expected: FAIL — the document is pruned despite an appearance nobody could read. Revert.

- [ ] **Step 6: Commit**

```bash
git add src/drprune.ts test/optimize-dr.test.ts
git commit -m "feat(optimize): veto /DR pruning on XFA and unreadable appearances (h7g5)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the pass into Optimize

**Files:**
- Modify: `src/optimize.ts:16-24` (options), `:40-56` (report), `:295-331` (`optimizeDocument`)
- Modify: `src/index.ts:150-153`
- Modify: `test/optimize-dr.test.ts`

**Interfaces:**
- Consumes: `pruneDefaultResources`, `DrPruneResult` from Tasks 2–4.
- Produces: `OptimizeOptions.dr?: boolean`, `OptimizeReport.dr: DrPruneResult`, `DrPruneResult` re-exported from `src/optimize.ts` and `src/index.ts`.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block to `test/optimize-dr.test.ts`:

```ts
const DR_ONLY = { fonts: false, dedup: false, compress: false } as const;

describe('Optimize({ dr })', () => {
  it('prunes by default and reports the removed keys', () => {
    const doc = opened();
    const report = doc.Optimize(DR_ONLY);
    expect(report.dr.removed).toContain('Font/TiBo');
    expect(fontKeys(doc)).not.toContain('TiBo');
  });

  it('honors the opt-out', () => {
    const doc = opened();
    const report = doc.Optimize({ ...DR_ONLY, dr: false });
    expect(report.dr.removed).toEqual([]);
    expect(fontKeys(doc)).toContain('TiBo');
  });

  it('folds its bytes into the total', () => {
    const doc = opened();
    const report = doc.Optimize(DR_ONLY);
    expect(report.dr.bytesSaved).toBe(DR_TIBO_PROGRAM_BYTES + DR_IMAGE_BYTES);
    expect(report.bytesSaved).toBe(report.dr.bytesSaved);
  });

  it('is idempotent — a second run finds nothing more', () => {
    const doc = opened();
    doc.Optimize(DR_ONLY);
    expect(doc.Optimize(DR_ONLY).dr.removed).toEqual([]);
  });

  it('does not let a later pass claim bytes for an object it orphaned', () => {
    // compress would otherwise re-deflate the orphaned /DR program and report
    // bytes for a stream Save() never writes.
    const doc = opened();
    const report = doc.Optimize({ fonts: false, dedup: false });
    expect(report.compress.bytesSaved + report.dr.bytesSaved).toBe(report.bytesSaved);
    expect(Document.Open(doc.Save()).Pages.length).toBe(1);
  });

  it('drops the face a removed field had registered', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'keep' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'gone', font: 'Times-Bold' });
    expect(doc.Form.RemoveField('gone')).toBe(true);

    const report = doc.Optimize(DR_ONLY);
    expect(report.dr.removed).toEqual(['Font/TiBo']);
    // /Helv stays: the first created field's face became the AcroForm /DA.
    expect(fontKeys(doc)).toEqual(['Helv']);

    const reopened = Document.Open(doc.Save());
    expect(reopened.Form.Get('keep')).toBeDefined();
    expect(reopened.Form.Fields.length).toBe(1);
  });
});
```

Add the blank-page builder to the test imports:

```ts
import { buildBlankPage } from './helpers/build-blank-page.js';
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/optimize-dr.test.ts`
Expected: FAIL — `report.dr` is undefined.

- [ ] **Step 3: Wire it into `src/optimize.ts`**

Add the import:

```ts
import { pruneDefaultResources, DrPruneResult } from './drprune.js';
```

Re-export the type beside the existing `export type { OptimizeImageOptions, ... }` line:

```ts
export type { DrPruneResult };
```

Add the option (`OptimizeOptions`):

```ts
  /** Prune /AcroForm /DR entries nothing in the document names. Lossless. */
  dr?: boolean;
```

Add the report field (`OptimizeReport`, beside `dedup` / `compress`):

```ts
  /** /AcroForm /DR entries removed, and the bytes that orphaned. */
  dr: DrPruneResult;
```

Initialize it in `optimizeDocument`'s report literal:

```ts
    dr: { removed: [], bytesSaved: 0 },
```

Run the pass **first**, immediately before the `if (opts.images)` block:

```ts
  // First of all the passes. A /DR entry this removes orphans a font program,
  // and running later means optimizeFonts shrinks that program and
  // recompressStreams re-deflates it — both reporting bytesSaved for bytes the
  // output file never contains.
  if (opts.dr ?? true) report.dr = pruneDefaultResources(doc);
```

Fold the bytes into the total:

```ts
  report.bytesSaved =
    report.fonts.reduce((n, f) => n + f.bytesSaved, 0) +
    report.images.reduce((n, i) => n + i.bytesSaved, 0) +
    report.dr.bytesSaved + report.dedup.bytesSaved + report.compress.bytesSaved;
```

- [ ] **Step 4: Export the type from `src/index.ts`**

Extend the existing optimize export:

```ts
export type {
  OptimizeOptions, OptimizeReport, FontOptimization, SkippedFont,
  OptimizeImageOptions, ImageOptimization, SkippedImage, DrPruneResult,
} from './optimize.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/optimize-dr.test.ts` — Expected: PASS
Run: `npm test` — Expected: the whole suite green (`optimize.test.ts` included: its reports gain a `dr` field but assert on named fields only)
Run: `npm run typecheck` — Expected: clean

- [ ] **Step 6: Prove the end-to-end test is load-bearing**

In `collectDrReferences`, temporarily replace `visit(doc.catalog())` with a walk over every object:

```ts
  for (const [, o] of doc.objectEntries()) visit(o);
```

Run: `npx vitest run test/optimize-dr.test.ts -t 'removed field'`
Expected: FAIL — the unwired field dict is still in the object map, its `/DA` still names `/TiBo`, and the pass removes nothing. This is the issue's entire motivating case. Revert.

- [ ] **Step 7: Commit**

```bash
git add src/optimize.ts src/index.ts test/optimize-dr.test.ts
git commit -m "feat(optimize): run /DR pruning as the first pass (h7g5)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation and issue close

**Files:**
- Modify: `README.md` (Optimization section ~1437-1476, Optimize limitation bullet ~1611)
- Modify: `CLAUDE.md` (the `optimize.ts` architecture bullet)

**Interfaces:**
- Consumes: the public surface from Task 5 (`OptimizeOptions.dr`, `OptimizeReport.dr`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the option to the README table**

In the Optimization section table, above the `images` row:

```markdown
| `dr` | Remove `/AcroForm /DR` resources nothing in the document names |
```

And extend the sentence below it:

```markdown
`fonts`, `dedup`, `compress`, and `dr` are lossless and default **on**. `images` is
```

- [ ] **Step 2: Document the pass**

Insert after the paragraph ending "…only `Save()` produces bytes.":

```markdown
The `dr` pass removes `/AcroForm /DR` entries — in every category, not only
`/Font` — that nothing in the document can name. A reference is a name in any
`/DA` string (the AcroForm default, a field's, a widget's, a `FreeText`
annotation's) or a name an `/AP` appearance stream cannot resolve against its own
`/Resources`. This is what collects the face a field registered at creation and
kept after `Form.RemoveField` unwired it. `report.dr.removed` names the removed
keys (`'Font/TiBo'`), and `report.dr.bytesSaved` counts the payload of the
streams the removal orphaned.

The pass declines outright — reporting `report.dr.skipped` and changing nothing —
for a document carrying `/AcroForm /XFA`, whose packet can name `/DR` faces this
library never reads, or one whose appearance streams cannot all be decoded and
parsed. A scan that cannot prove itself complete does not get to call a resource
unused.
```

- [ ] **Step 3: Extend the Optimize limitation bullet**

Append to the end of the "**Optimize subsets embedded TrueType and CFF fonts**" bullet:

```markdown
 `/AcroForm /DR` pruning (`dr`, default on) removes only entries no `/DA` names and no appearance stream leaves unresolved against its own `/Resources`; it does not read `/XFA` (a document carrying one is skipped outright), does not prune the `/AcroForm /DA` default itself, and leaves `/ProcSet` alone. A `/DR` entry the AcroForm-level `/DA` names therefore survives the removal of every field — that `/DA` is the live default for the next field created.
```

- [ ] **Step 4: Add the module to `CLAUDE.md`**

In the `optimize.ts` architecture bullet, extend the file list at the top of the entry:

```markdown
- **optimize.ts**, **glyphusage.ts**, **fontshrink.ts**, **dedup.ts**,
  **recompress.ts**, **drprune.ts**, **imageopt.ts**, **imageusage.ts**, **resample.ts** —
```

and append to the body of that bullet:

```markdown
  **drprune.ts** removes `/AcroForm /DR` entries nothing names, in every resource
  category, and deletes the objects that orphans.
  **Invariant:** the reference scan walks from the *catalog*, never
  `doc.objectEntries()`. `Form.RemoveField` leaves the unwired field dict in the
  object map for `Save()`'s mark-sweep, so scanning every object reads the `/DA`
  of the very field whose removal this pass exists to clean up after — and the
  pass silently becomes a no-op on its own motivating case.
```

- [ ] **Step 5: Verify the whole suite and typecheck**

Run: `npm test` — Expected: green
Run: `npm run typecheck` — Expected: clean

- [ ] **Step 6: Commit, close the issue, push**

```bash
git add README.md CLAUDE.md
git commit -m "docs: /DR pruning in Optimize (h7g5)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-h7g5 --reason "src/drprune.ts: prunes unreferenced /AcroForm /DR entries in every category, first pass in Optimize, reported as report.dr with bytes from a reachability diff."
git add .beads/interactions.jsonl
git commit -m "chore(bd): close h7g5" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git pull --rebase
git push
git status -sb   # MUST show up to date with origin
```
