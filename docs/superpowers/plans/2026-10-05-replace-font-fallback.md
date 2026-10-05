# Replacement Font Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `ReplaceText` draw every replacement character: in the original font where it truly can (verified against the embedded program), else in the same face found in registered folders, else in caller-given fallback fonts, switching font with `Tf` around each foreign run; report or refuse what nothing can draw.

**Architecture:** `TextFont.drawCode(ch)` answers tier A (round-trip decode plus glyph presence). A new pure module `replacefont.ts` validates options and assigns each character to a tier as runs. A new pure module `showsplit.ts` rewrites one show operator into `Tf`-switched pieces. `textedit.ts` splits into plan (mutates nothing) and apply; `doc.ReplaceText` plans every page before applying any. `GlyphEvent` gains the `Tf` key and size so the original font can be restored.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-05-replace-font-fallback-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins.
- Import specifiers carry `.js`.
- `UnsupportedFeatureError` for an undrawable character; `TypeError` for a bad option. A refused call leaves the document byte-identical; `doc.ReplaceText` refuses document-wide.
- A replacement the original font can fully draw produces output **byte-identical** to before this issue.
- Every user-visible change gets a `CHANGELOG.md` entry under `## [Unreleased]` in the SAME commit, bold lead-in, prose, `(u3l5.2)` at the end.
- Write test files containing `\` escapes with the Write/Edit tools, never a Bash heredoc (heredocs strip backslashes here). Prefer hex strings in content streams.
- `npm run typecheck` and `npm test` must both be green before the issue closes.

## Review Focus

1. **A Form XObject with no `/Resources` of its own** — it inherits its parent's, and creating an own dict to register a fallback font would hide every other resource it uses. Expected: no foreign tier for that scope; the characters are undrawable (throw or report). Test in Task 6.
2. **A font set by `Tf` OUTSIDE a form and inherited into it (mih4)** — the restore `Tf` would name a key the form's resources do not hold. Expected: no foreign tier for that glyph. Test in Task 6.
3. **A Type 1 embedded program**, whose gid 0 is an ordinary glyph (`NimbusSans-Regular.t1` lists `/A` first). Expected: gid 0 is NOT treated as `.notdef` for Type 1. Test in Task 2.
4. **A space in a replacement whose font has an empty space glyph** — whitespace legitimately has no outline. Expected: still drawable in the original font. Test in Task 2.
5. **`doc.ReplaceText` where only a LATER page cannot draw** — earlier pages must stay untouched. Test in Task 6.

---

## File Structure

- `src/text.ts` — Task 1: `TextState.fontKey`; `GlyphEvent.tfKey`/`tfSize`.
- `src/font.ts` — Task 2: `TextFont.drawCode`, glyph-presence loaders, shared program loaders.
- `src/stamp.ts` — Task 3: export `driverFor`, new `registerFontIn`.
- `src/document.ts` — Task 3: `fontByPostScriptName` + `loadFaceFile`; Task 6: `ReplaceText` options and atomicity.
- `src/replacefont.ts` (new) — Task 4: `ReplaceTextOptions`, `UndrawableText`, `checkReplaceOptions`, `Run`, `FontTiers`, `assignRuns`, `pushRun`.
- `src/showsplit.ts` (new) — Task 5: `ShowPiece`, `FontRestore`, `splitShowOp`.
- `src/textedit.ts` — Task 6: plan/apply, tiers per glyph, foreign apply path.
- `src/page.ts` — Task 6: `ReplaceText` options type.
- `src/index.ts`, `README.md`, `CLAUDE.md` — Task 7.
- `test/helpers/build-text-pdf.ts` — Task 1 (`buildFormTextPdf`), Task 2 (`buildType0Pdf` `encoding` option).
- `test/docx-group.test.ts` — Task 1 (synthetic `GlyphEvent` gains the two required fields).
- Tests: `test/text-tf-key.test.ts`, `test/font-draw-code.test.ts`, `test/font-by-psname.test.ts`, `test/replace-font-tiers.test.ts`, `test/showsplit.test.ts`, `test/replace-fallback.test.ts` (all new).

---

### Task 1: `GlyphEvent` reports the `Tf` key and size

**Files:**
- Modify: `src/text.ts` (`TextState` ~line 491, `newState` ~515, `case 'Tf'` ~817, `GlyphEvent` ~299-390, emit site ~961)
- Modify: `test/helpers/build-text-pdf.ts` (add `buildFormTextPdf` after `buildMixedType0Pdf`)
- Modify: `test/docx-group.test.ts:10-21`
- Test: `test/text-tf-key.test.ts` (create)

**Interfaces:**
- Produces: `GlyphEvent.tfKey: string` (resource name `Tf` used; `''` if none) and `GlyphEvent.tfSize: number`. `buildFormTextPdf(pageStream: string, formStream: string, opts?: { formFont?: boolean; formResources?: boolean }): Uint8Array`.

- [ ] **Step 1: Add the form builder**

In `test/helpers/build-text-pdf.ts`, after `buildMixedType0Pdf`:

```ts
/** Page whose /Resources hold Helvetica `/F1` and a Form XObject `/Fm0`
 *  showing `formStream`. `formFont: false` gives the form /Resources with no
 *  /Font; `formResources: false` gives it no /Resources at all, so it inherits
 *  the page's (7.8.3). */
export function buildFormTextPdf(
  pageStream: string, formStream: string,
  opts: { formFont?: boolean; formResources?: boolean } = {},
): Uint8Array {
  const formRes = opts.formResources === false ? ''
    : opts.formFont === false ? '/Resources << >> '
    : '/Resources << /Font << /F1 5 0 R >> >> ';
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Fm0 6 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(pageStream),
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    6: `<< /Type /XObject /Subtype /Form /BBox [0 0 300 300] ${formRes}/Length ${byteLen(formStream)} >>\nstream\n${formStream}\nendstream`,
  };
  return serialize(objects, 6);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/text-tf-key.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildSimpleTextPdf, buildFormTextPdf } from './helpers/build-text-pdf.js';

const glyphs = (doc: Document): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (e) => { out.push(e); } });
  return out;
};

describe('GlyphEvent tfKey and tfSize', () => {
  it('reports the resource name and size Tf selected', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hi) Tj ET'));
    const [g] = glyphs(doc);
    expect(g.tfKey).toBe('F1');
    expect(g.tfSize).toBe(12);
  });

  it('scopes the size by q/Q like the rest of the text state', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td q /F1 20 Tf (a) Tj Q (b) Tj ET'));
    expect(glyphs(doc).map((g) => g.tfSize)).toEqual([20, 12]);
  });

  it('reports the key a form inherited from the page text state', () => {
    const doc = Document.Open(buildFormTextPdf(
      'BT /F1 9 Tf ET /Fm0 Do', 'BT 20 250 Td (x) Tj ET', { formFont: false }));
    const [g] = glyphs(doc);
    expect(g.text).toBe('x');
    expect(g.tfKey).toBe('F1');
    expect(g.tfSize).toBe(9);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/text-tf-key.test.ts`
Expected: FAIL, `tfKey`/`tfSize` undefined in all three.

- [ ] **Step 4: Implement**

In `src/text.ts`:

(a) `TextState` — add after `font?: TextFont; fontSize: number;`:

```ts
  /** The resource name the `Tf` that set `font` used (u3l5.2). Graphics state
   *  like the font itself, so `q`/`Q` scope it and a form inherits it. */
  fontKey?: string;
```

(b) In `case 'Tf'`, inside the `if (isDict(fd)) { ... }` block, after `st.font = tf;`:

```ts
              st.fontKey = fname.name;
```

(c) `GlyphEvent` — add after the `code`/`cid` fields:

```ts
  /** The resource name `Tf` selected this glyph's font under, `''` when no
   *  `Tf` did, and the size it stated (u3l5.2). REQUIRED, like `code`: a
   *  replace that switches to another font writes `/tfKey tfSize Tf` to switch
   *  back and must never guess. Note the key is resolved where the font was
   *  SET — for a form inheriting the page's text state (mih4) that is not the
   *  form's own resources. */
  tfKey: string;
  tfSize: number;
```

(d) At the emit site, after `code: g.code, cid: g.cid,`:

```ts
      tfKey: st.fontKey ?? '', tfSize: st.fontSize,
```

(e) In `test/docx-group.test.ts`, after `code: 0, cid: 0,` in the synthetic glyph:

```ts
    tfKey: 'F1', tfSize: size,
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/text-tf-key.test.ts test/docx-group.test.ts test/text-state-q.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors (any other `GlyphEvent` literal the compiler names gets the same two fields).

- [ ] **Step 6: Mutation check**

Set `st.fontKey` outside the `isDict(fd)` block instead (before it, unconditionally) → expect GREEN (all fixtures resolve their font); record. Remove `tfSize: st.fontSize` (replace with `tfSize: 0`) → expect the first two cases red. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/text.ts test/helpers/build-text-pdf.ts test/docx-group.test.ts test/text-tf-key.test.ts
git commit -m "feat(u3l5.2): GlyphEvent reports the Tf key and size"
```
(Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.) No CHANGELOG entry: the fields are folded into Task 6's Added entry.

---

### Task 2: `TextFont.drawCode` — tier A

**Files:**
- Modify: `src/font.ts` (fields near ~247-285; constructor ~287-340; new methods after `encode`; `buildProgramWidths` ~898; `buildCidProgramWidths` ~966)
- Modify: `test/helpers/build-text-pdf.ts` (`buildType0Pdf` gains `encoding?: string`)
- Modify: `test/helpers/build-optimize-pdf.ts` (add `buildType1EmbeddedPdf`)
- Test: `test/font-draw-code.test.ts` (create)

**Interfaces:**
- Produces: `TextFont.drawCode(ch: string): Uint8Array | undefined` — one code point in, its bytes out.

- [ ] **Step 1: Add the `encoding` option to `buildType0Pdf`**

Change its opts type to `{ baseFont?: string; ordering?: string; toUnicode?: boolean; encoding?: string }` and object 5 to use `/Encoding /${opts.encoding ?? 'Identity-H'}`. The default keeps every existing caller byte-identical.

In `test/helpers/build-optimize-pdf.ts`, after `buildSimpleTtfPdf`, add a Type 1 builder. The program goes in as RAW stream bytes: `NimbusSans-Regular.t1`'s eexec section is binary (measured: it holds bytes above 0x7F), so a string-built fixture would corrupt it.

```ts
/** A PDF showing `body` in a simple /Type1 font that embeds `program` (a
 *  .t1/.pfa/.pfb) as /FontFile, WinAnsi-encoded. */
export function buildType1EmbeddedPdf(body: string, program: Uint8Array): Uint8Array {
  const objects = new Map<number, PdfObject>();
  objects.set(6, { kind: 'stream', dict: new Map<string, PdfObject>([['Length', program.length]]), raw: program });
  objects.set(7, new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', name('NimbusSans-Regular')],
    ['Flags', 32], ['FontBBox', [0, -200, 1000, 900]], ['ItalicAngle', 0],
    ['Ascent', 900], ['Descent', -200], ['CapHeight', 700], ['StemV', 80],
    ['FontFile', ref(6, 0)],
  ]));
  objects.set(4, new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('NimbusSans-Regular')],
    ['Encoding', name('WinAnsiEncoding')], ['FontDescriptor', ref(7, 0)],
  ]));
  objects.set(3, { kind: 'stream', dict: new Map<string, PdfObject>([['Length', body.length]]), raw: enc(body) });
  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(8, 0)], ['MediaBox', [0, 0, 612, 792]], ['Contents', ref(3, 0)],
    ['Resources', new Map<string, PdfObject>([['Font', new Map<string, PdfObject>([['F1', ref(4, 0)]])]])],
  ]));
  objects.set(8, new Map<string, PdfObject>([['Type', name('Pages')], ['Kids', [ref(2, 0)]], ['Count', 1]]));
  objects.set(1, new Map<string, PdfObject>([['Type', name('Catalog')], ['Pages', ref(8, 0)]]));
  return serializeDocument(objects, new Map<string, PdfObject>([['Root', ref(1, 0)]]));
}
```

(`enc` is the local text encoder `buildSimpleTtfPdf` already uses in that file.)

- [ ] **Step 2: Write the failing tests**

Create `test/font-draw-code.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { name } from '../src/types.js';
import { visitContent } from '../src/text.js';
import type { TextFont } from '../src/font.js';
import { buildSimpleTextPdf, buildToUnicodePdf, buildType0Pdf } from './helpers/build-text-pdf.js';
import { buildSimpleTtfPdf, buildType1EmbeddedPdf } from './helpers/build-optimize-pdf.js';

const NIMBUS = new Uint8Array(readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.otf', import.meta.url)));
const T1 = new Uint8Array(readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.t1', import.meta.url)));
const LIB = new Uint8Array(readFileSync(new URL('./fixtures/fonts/LiberationSans-Regular.woff2', import.meta.url)));

/** The TextFont of the first glyph on page 1. */
const fontOf = (doc: Document): TextFont => {
  let f: TextFont | undefined;
  visitContent(doc, doc.Pages[0], { glyph: (e) => { f ??= e.font; } });
  return f!;
};
const bytes = (u: Uint8Array | undefined) => (u ? [...u] : undefined);

describe('TextFont.drawCode', () => {
  it('encodes through a non-embedded font by its encoding', () => {
    const f = fontOf(Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (A) Tj ET')));
    expect(bytes(f.drawCode('A'))).toEqual([0x41]);
    expect(f.drawCode('\u03A9')).toBeUndefined();
  });

  it('rejects a code that does not decode back to the character', () => {
    // /ToUnicode says code 0x41 is "Z": writing 0x41 for "A" would extract as Z.
    const cmap = '1 begincodespacerange <00> <FF> endcodespacerange\n1 beginbfchar <41> <005A> endbfchar\n';
    const f = fontOf(Document.Open(buildToUnicodePdf('BT /F1 12 Tf 20 250 Td (A) Tj ET', cmap)));
    expect(f.drawCode('A')).toBeUndefined();
    expect(bytes(f.drawCode('Z'))).toEqual([0x41]);
  });

  it('refuses a character an embedded program does not map', () => {
    const f = fontOf(Document.Open(buildSimpleTtfPdf({ encoding: name('WinAnsiEncoding'), content: '(A)' })));
    expect(bytes(f.drawCode('A'))).toEqual([0x41]);
    expect(f.drawCode('C')).toBeUndefined();   // WinAnsi encodes C; the program's cmap has no C
  });

  it('refuses a glyph a subset blanked, which used to draw nothing', () => {
    const before = Document.Open(buildSimpleTtfPdf({ encoding: name('WinAnsiEncoding'), content: '(A)' }));
    expect(bytes(fontOf(before).drawCode('B'))).toEqual([0x42]);   // whole font: B has an outline
    before.Optimize();
    const after = Document.Open(before.Save());
    expect(fontOf(after).drawCode('B')).toBeUndefined();          // B's slot is now empty
    expect(bytes(fontOf(after).drawCode('A'))).toEqual([0x41]);
  });

  it('re-encodes a Type0 Identity-H font through the inverse ToUnicode', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfchar <0003> <0048> <0004> <0069> endbfchar\n';
    const f = fontOf(Document.Open(buildType0Pdf('BT /F1 12 Tf 20 250 Td <0003> Tj ET', cmap)));
    expect(bytes(f.drawCode('i'))).toEqual([0, 4]);
    expect(f.drawCode('Q')).toBeUndefined();
  });

  it('declines a Type0 font under any CMap but Identity', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfchar <0003> <0048> endbfchar\n';
    const f = fontOf(Document.Open(buildType0Pdf('BT /F1 12 Tf 20 250 Td <0003> Tj ET', cmap, { encoding: 'UniGB-UCS2-H' })));
    expect(f.drawCode('H')).toBeUndefined();
  });

  it('draws only what a real embedded Type0 subset holds', () => {
    const src = Document.New(PageFormat.A4);
    src.Pages[0].AddText('Draft', 50, 700, { font: src.AddFont(NIMBUS) });
    const f = fontOf(Document.Open(src.Save()));
    expect(f.drawCode('D')?.length).toBe(2);
    expect(f.drawCode('Q')).toBeUndefined();
  });

  it('keeps a space drawable though its glyph has no outline', () => {
    // Liberation is glyf-flavoured: its space glyph is a zero-length slot.
    const src = Document.New(PageFormat.A4);
    src.Pages[0].AddText('a b', 50, 700, { font: src.AddFont(LIB) });
    expect(fontOf(Document.Open(src.Save())).drawCode(' ')?.length).toBe(2);
  });

  it('treats gid 0 of a Type 1 program as an ordinary glyph', () => {
    // NimbusSans-Regular.t1 lists /A FIRST, so A is gid 0 in this program.
    const f = fontOf(Document.Open(buildType1EmbeddedPdf('BT /F1 12 Tf 20 250 Td (A) Tj ET', T1)));
    expect(bytes(f.drawCode('A'))).toEqual([0x41]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/font-draw-code.test.ts`
Expected: FAIL — `f.drawCode is not a function` in every case.

- [ ] **Step 4: Implement**

In `src/font.ts`:

(a) Fields, beside `private programWidthInit = false;`:

```ts
  /** Type0 under `/Identity-H` or `/Identity-V`: a code IS its CID, two bytes. */
  private identityEnc = false;
  /** Builds the "does the embedded program define this glyph" test; unset for
   *  a font that cannot have one (Type 3). */
  private loadPresence?: () => ((code: number, cid: number, text: string) => boolean) | undefined;
  /** The built test, or `null` when nothing is embedded — such a font is
   *  trusted by its encoding, since the viewer supplies the face. */
  private presenceFn?: ((code: number, cid: number, text: string) => boolean) | null;
  /** `/ToUnicode` inverted for single-character entries, codes ascending. */
  private tuInverse?: Map<string, number[]>;
```

(b) Constructor, Type0 branch, after `this.wmode = ...`:

```ts
      const encName = resolve(dict.get('Encoding'));
      this.identityEnc = isName(encName) && (encName.name === 'Identity-H' || encName.name === 'Identity-V');
      this.loadPresence = () => buildCidPresence(dict, resolve, inflate);
```

simple branch, after `this.loadProgramWidths = () => buildProgramWidths(...)`:

```ts
      this.loadPresence = () => buildSimplePresence(dict, resolve, inflate);
```

and inside the `if (... 'Type3')` block add `this.loadPresence = undefined;` (a Type 3 font's glyphs are content streams, not a program).

(c) Methods, after `encode(...)`:

```ts
  /**
   * The bytes that draw `ch` (one code point) in THIS font, or `undefined`
   * when none do (u3l5.2).
   *
   * **Invariant:** a code qualifies only when it DECODES back to exactly `ch`
   * through this font's own decoder AND, for an embedded program, selects a
   * glyph the program defines. The round trip is the criterion — a code that
   * would not extract as `ch` is the wrong code however it was found — and the
   * presence test is what stops a SUBSET font accepting a character its
   * encoding maps and its program never embedded, which drew a blank.
   *
   * Candidates are the encoding inverse (simple fonts) and the inverse of the
   * single-character `/ToUnicode` entries. A Type0 font answers ONLY under
   * `/Identity-H`/`-V`, where a code is its CID and is two bytes; any other
   * CMap declines, since writing a code needs its byte width.
   */
  drawCode(ch: string): Uint8Array | undefined {
    for (const code of this.candidateCodes(ch)) {
      if (this.textOf(code, code) !== ch) continue;
      if (!this.definesGlyph(code, code, ch)) continue;
      return this.isType0 ? Uint8Array.of((code >> 8) & 0xff, code & 0xff) : Uint8Array.of(code);
    }
    return undefined;
  }

  private candidateCodes(ch: string): number[] {
    const out: number[] = [];
    if (!this.isType0) {
      const c = this.encodeChar(ch);
      if (c !== undefined) out.push(c);
    } else if (!this.identityEnc) return out;
    const max = this.isType0 ? 0xffff : 0xff;
    for (const c of this.toUnicodeInverse().get(ch) ?? []) if (c <= max && !out.includes(c)) out.push(c);
    return out;
  }

  private toUnicodeInverse(): Map<string, number[]> {
    if (!this.tuInverse) {
      const inv = new Map<string, number[]>();
      for (const [code, u] of this.toUnicode?.entries() ?? []) {
        const l = inv.get(u);
        if (l) l.push(code); else inv.set(u, [code]);
      }
      for (const l of inv.values()) l.sort((a, b) => a - b);
      this.tuInverse = inv;
    }
    return this.tuInverse;
  }

  private definesGlyph(code: number, cid: number, text: string): boolean {
    if (this.presenceFn === undefined) this.presenceFn = this.loadPresence?.() ?? null;
    return this.presenceFn === null || this.presenceFn(code, cid, text);
  }
```

(d) Shared loaders. Replace the first three lines of `buildProgramWidths`' body with a call to a new `loadSimpleProgram`, and the descendant/`cidToGid` prologue of `buildCidProgramWidths` with `loadCidProgram`, then add the two presence builders and `glyphDefined`:

```ts
/** A simple font's embedded program and its code -> glyph-name route, or
 *  `undefined` when it embeds none we can read. One loader for widths and for
 *  glyph presence, so the two cannot disagree about which glyph a code is. */
function loadSimpleProgram(
  dict: PdfDict, resolve: Resolve, inflate: Inflate,
): { prog: EmbeddedProgram; nameForCode: (code: number) => string | undefined } | undefined {
  const prog = loadEmbeddedProgram(dict.get('FontDescriptor'), resolve, inflate);
  if (!prog.sfnt && !prog.cff && !prog.type1) return undefined;
  const nameForCode = glyphNameResolver(
    resolveSimpleEncoding(dict, resolve), prog.type1?.builtinEncodingNames(),
  );
  return { prog, nameForCode };
}

function buildProgramWidths(
  dict: PdfDict, resolve: Resolve, inflate: Inflate, simple: (string | undefined)[] | undefined,
): ((code: number) => number | undefined) | undefined {
  const p = loadSimpleProgram(dict, resolve, inflate);
  if (!p) return undefined;
  const cache = new Map<number, number | undefined>();
  return (code) => {
    if (cache.has(code)) return cache.get(code);
    const gid = gidForProgram(p.prog, code, simple?.[code & 0xff] ?? '', p.nameForCode);
    const w = gid === undefined ? undefined : programAdvance(p.prog, gid);
    cache.set(code, w);
    return w;
  };
}

/** A composite font's descendant program and `/CIDToGIDMap`, or `undefined`
 *  when it embeds none we can read. */
function loadCidProgram(
  dict: PdfDict, resolve: Resolve, inflate: Inflate,
): { prog: EmbeddedProgram; cidToGid: Uint8Array | undefined } | undefined {
  const desc = resolve(dict.get('DescendantFonts'));
  const cidFont = isArray(desc) ? resolve(desc[0]) : undefined;
  if (!isDict(cidFont)) return undefined;
  const prog = loadEmbeddedProgram(cidFont.get('FontDescriptor'), resolve, inflate);
  if (!prog.sfnt && !prog.cff && !prog.type1) return undefined;
  // /CIDToGIDMap is a stream of 2-byte gids, or the name /Identity. An
  // unreadable stream degrades to Identity rather than to no widths at all.
  let cidToGid: Uint8Array | undefined;
  const c2g = resolve(cidFont.get('CIDToGIDMap'));
  if (isStream(c2g)) {
    try { cidToGid = inflate(c2g as { dict: PdfDict; raw: Uint8Array }); } catch (caught) { rethrowLimit(caught); cidToGid = undefined; }
  }
  return { prog, cidToGid };
}

function buildCidProgramWidths(
  dict: PdfDict, resolve: Resolve, inflate: Inflate,
): ((cid: number) => number | undefined) | undefined {
  const p = loadCidProgram(dict, resolve, inflate);
  if (!p) return undefined;
  const cache = new Map<number, number | undefined>();
  return (cid) => {
    if (cache.has(cid)) return cache.get(cid);
    const w = programAdvance(p.prog, gidForCid(p.prog, cid, p.cidToGid));
    cache.set(cid, w);
    return w;
  };
}

function buildSimplePresence(
  dict: PdfDict, resolve: Resolve, inflate: Inflate,
): ((code: number, cid: number, text: string) => boolean) | undefined {
  const p = loadSimpleProgram(dict, resolve, inflate);
  if (!p) return undefined;
  return (code, _cid, text) => glyphDefined(p.prog, gidForProgram(p.prog, code, text, p.nameForCode), text);
}

function buildCidPresence(
  dict: PdfDict, resolve: Resolve, inflate: Inflate,
): ((code: number, cid: number, text: string) => boolean) | undefined {
  const p = loadCidProgram(dict, resolve, inflate);
  if (!p) return undefined;
  return (_code, cid, text) => glyphDefined(p.prog, gidForCid(p.prog, cid, p.cidToGid), text);
}

/** Whether `gid` is a real glyph of `prog` for the character `text`.
 *
 *  **Invariant:** gid 0 is `.notdef` in an sfnt or a CFF and so missing — but a
 *  Type 1 program numbers glyphs by order of appearance, and its gid 0 is an
 *  ordinary glyph (`NimbusSans-Regular.t1` lists `/A` first). A subset that
 *  keeps glyph numbering blanks a dropped glyph to zero length; whitespace
 *  legitimately has no outline, so an empty slot is missing only for text
 *  that draws ink. */
function glyphDefined(prog: EmbeddedProgram, gid: number | undefined, text: string): boolean {
  if (gid === undefined) return false;
  if (gid === 0 && !prog.type1) return false;
  const count = prog.sfnt?.numGlyphs ?? prog.cff?.numGlyphs;
  if (count !== undefined && count > 0 && gid >= count) return false;
  const sf = prog.sfnt;
  if (sf && sf.outlines === 'glyf' && gid + 1 < sf.loca.length
    && sf.loca[gid] === sf.loca[gid + 1] && !/^\s+$/u.test(text)) return false;
  return true;
}
```

Add `type EmbeddedProgram` to the existing `./glyphprogram.js` import. If `glyphNameResolver`'s return type differs from `(code: number) => string | undefined`, use its declared return type in `loadSimpleProgram`'s signature (read it at `src/font.ts:819`).

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/font-draw-code.test.ts test/font-dict-width.test.ts test/font-cid-program-widths.test.ts test/optimize-type1.test.ts`
Expected: PASS. If the Optimize precondition (`drawCode('B')` before Optimize is `[0x42]`) holds but the after-case still returns bytes, check `Optimize` actually shrank the program (it reports per font); if `Optimize` does not shrink this fixture, ledger a ruling and build the blank slot directly instead: a `buildSimpleTtfPdf` variant whose program is `shrinkGlyf(buildManyGlyphTtf(200), new Set([1])).bytes` (from `src/fontshrink.ts`).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Mutation checks**

Each followed by `npx vitest run test/font-draw-code.test.ts` and a restore; record counts:
1. Drop the round trip: delete `if (this.textOf(code, code) !== ch) continue;` → the ToUnicode-mismatch case reddens.
2. Trust everything: `return true` at the top of `glyphDefined` → cmap-miss and blanked cases redden.
3. Treat Type 1 gid 0 as missing: drop `&& !prog.type1` → the Type 1 case reddens.
4. Ignore whitespace: drop `&& !/^\s+$/u.test(text)` → the space case reddens.
5. Allow any Type0 CMap: drop `else if (!this.identityEnc) return out;` → the UniGB case reddens.

- [ ] **Step 7: Commit**

```bash
git add src/font.ts test/helpers/build-text-pdf.ts test/font-draw-code.test.ts
git commit -m "feat(u3l5.2): TextFont.drawCode verifies a code round-trips and has a glyph"
```
No CHANGELOG yet: nothing calls `drawCode` until Task 6, which carries the Fixed entry.

---

### Task 3: Font registration into any resource dict; a face by PostScript name

**Files:**
- Modify: `src/stamp.ts` (`driverFor` ~43, `registerFont` ~180-205)
- Modify: `src/document.ts` (`LoadFontByName` ~2427)
- Test: `test/font-by-psname.test.ts` (create)

**Interfaces:**
- Produces: `export function driverFor(font: AuthoringFont): FontDriver`; `export function registerFontIn(doc: Document, fonts: PdfDict, font: AuthoringFont): string`; `Document.fontByPostScriptName(postScriptName: string): EmbeddedFont | undefined` (`@internal`).

- [ ] **Step 1: Write the failing test**

Create `test/font-by-psname.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Document } from '../src/document.js';
import { readFontNames } from '../src/fontnames.js';

const DIR = fileURLToPath(new URL('./fixtures/fonts/', import.meta.url));
const OTF = new Uint8Array(readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.otf', import.meta.url)));

describe('Document.fontByPostScriptName', () => {
  it('finds a registered face by its exact PostScript name', () => {
    expect(readFontNames(OTF)?.postScriptName).toBe('NimbusSans-Regular');   // fixture precondition
    const doc = Document.New();
    doc.RegisterFontFolder(DIR);
    const f = doc.fontByPostScriptName('NimbusSans-Regular');
    expect(f).toBeDefined();
    expect(doc.fontByPostScriptName('NimbusSans-Regular')).toBe(f);   // one handle, one embedding
  });

  it('does not accept a family-only or differently cased name', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(DIR);
    expect(doc.fontByPostScriptName('NimbusSans')).toBeUndefined();
    expect(doc.fontByPostScriptName('nimbussans-regular')).toBeUndefined();
  });

  it('finds nothing when no folder is registered', () => {
    expect(Document.New().fontByPostScriptName('NimbusSans-Regular')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/font-by-psname.test.ts`
Expected: FAIL — `fontByPostScriptName is not a function`.

- [ ] **Step 3: Implement**

`src/stamp.ts`: export `driverFor` (add `export`), and split `registerFont`:

```ts
/** Register (or reuse) `font` in a `/Font` resource dict the caller owns —
 *  a page's or a Form XObject's (u3l5.2) — and return its key. Standard-14
 *  faces become a WinAnsi Type1 dict; an embedded handle reserves a Type0
 *  object (filled at Save) shared across all its draws. One owner of "reuse
 *  the key when this font is already there". */
export function registerFontIn(doc: Document, fonts: PdfDict, font: AuthoringFont): string {
  // ... the existing body of registerFont from `if (font instanceof EmbeddedFont) {` to the end ...
}

/** Register (or reuse) `font` on the page; returns its resource key. */
function registerFont(doc: Document, page: Page, font: AuthoringFont): string {
  return registerFontIn(doc, ensureOwnSubdict(doc, ensureOwnResources(doc, page), 'Font'), font);
}
```

Move the body VERBATIM; only the two `ensure…` lines leave it.

`src/document.ts`: replace the loading half of `LoadFontByName` with a call, and add the two methods after it:

```ts
  LoadFontByName(family: string | string[], opts: LoadFontOptions = {}): EmbeddedFont | undefined {
    const hit = this.ResolveFontByName(family, opts);
    if (!hit) return undefined;
    return this.loadFaceFile(hit.path, hit.faceIndex, opts.shape);
  }

  /** @internal The registered face whose PostScript name (`name` ID 6) is
   *  EXACTLY `postScriptName`, through `LoadFontByName`'s memo, or `undefined`.
   *  `ReplaceText({ matchRegisteredFonts })` uses it to find the face a subset
   *  font was cut from (u3l5.2); a family match is a different face. */
  fontByPostScriptName(postScriptName: string): EmbeddedFont | undefined {
    for (const f of this.fontFolders) {
      for (const face of indexFolder(f.dir, f.sniff)) {
        if (face.names.postScriptName === postScriptName) return this.loadFaceFile(face.path, face.faceIndex, undefined);
      }
    }
    return undefined;
  }

  /** Load one face of a font file once per document. Keyed by path AND face:
   *  the faces of a collection share one path, so a path-only key hands back
   *  face 0's font for every face of the file, silently. */
  private loadFaceFile(path: string, faceIndex: number, shape: boolean | undefined): EmbeddedFont | undefined {
    const key = `${path}#${faceIndex}`;
    const already = this.fontsByPath.get(key);
    if (already) return already;
    let font: EmbeddedFont;
    try {
      font = this.AddFont(new Uint8Array(readFileSync(path)), { shape, faceIndex });
    } catch (caught) { rethrowLimit(caught);
      return undefined;   // readable enough to index, not enough to parse
    }
    this.fontsByPath.set(key, font);
    return font;
  }
```

Keep `LoadFontByName`'s doc comment unchanged above it.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/font-by-psname.test.ts test/font-byname.test.ts test/rich-runs-identity.test.ts test/stamp.test.ts`
Expected: PASS (the last two are the byte-identity fences for the `registerFont` split; drop any file name `ls test` does not show).

Run: `npm run typecheck` — no errors.

- [ ] **Step 5: Mutation check**

Make `fontByPostScriptName` compare case-insensitively (`.toLowerCase()` both sides) → the case-difference assertion reddens. Make it bypass the memo (call `this.AddFont` directly) → the same-handle assertion reddens. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/stamp.ts src/document.ts test/font-by-psname.test.ts
git commit -m "feat(u3l5.2): register a font into any resource dict; find a face by PostScript name"
```

---

### Task 4: `replacefont.ts` — options and tier assignment

**Files:**
- Create: `src/replacefont.ts`
- Test: `test/replace-font-tiers.test.ts` (create)

**Interfaces:**
- Consumes: `TextFont.drawCode` (Task 2); `driverFor`, `AUTHORING_FONTS`, `AuthoringFont` (Task 3, `src/stamp.ts`).
- Produces:
  - `interface ReplaceTextOptions extends SearchOptions { fallbackFonts?: AuthoringFont[]; matchRegisteredFonts?: boolean; onUndrawable?: (r: UndrawableText) => void }`
  - `interface UndrawableText { page: number; match: string; missing: string[] }`
  - `function checkReplaceOptions(opts: ReplaceTextOptions | undefined): ReplaceTextOptions`
  - `type Run = { font: 'original'; bytes: Uint8Array } | { font: AuthoringFont; text: string }`
  - `interface FontTiers { original: TextFont; registered?: EmbeddedFont; fallbacks: readonly AuthoringFont[] }`
  - `function assignRuns(text: string, tiers: FontTiers, out: Run[], missing: string[]): void`
  - `function pushRun(out: Run[], r: Run): void`

- [ ] **Step 1: Write the failing tests**

Create `test/replace-font-tiers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { visitContent } from '../src/text.js';
import type { TextFont } from '../src/font.js';
import { assignRuns, checkReplaceOptions, type Run } from '../src/replacefont.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const LIB = new Uint8Array(readFileSync(new URL('./fixtures/fonts/LiberationSans-Regular.woff2', import.meta.url)));
const helv = (): TextFont => {
  const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (A) Tj ET'));
  let f: TextFont | undefined;
  visitContent(doc, doc.Pages[0], { glyph: (e) => { f ??= e.font; } });
  return f!;
};
const show = (runs: Run[]) => runs.map((r) =>
  r.font === 'original' ? `O:${String.fromCharCode(...r.bytes)}` : `${typeof r.font === 'string' ? r.font : 'E'}:${r.text}`);

describe('checkReplaceOptions', () => {
  it('accepts nothing, and every valid option', () => {
    const lib = Document.New().AddFont(LIB);
    expect(checkReplaceOptions(undefined)).toEqual({});
    expect(() => checkReplaceOptions({ fallbackFonts: ['Helvetica', lib], matchRegisteredFonts: true, onUndrawable: () => {} })).not.toThrow();
  });

  it.each([
    [{ fallbackFonts: 'Helvetica' }, /fallbackFonts must be an array/],
    [{ fallbackFonts: ['Symbol'] }, /neither a Standard-14 authoring face/],
    [{ fallbackFonts: [42] }, /neither a Standard-14 authoring face/],
    [{ matchRegisteredFonts: 'yes' }, /matchRegisteredFonts must be a boolean/],
    [{ onUndrawable: 'log' }, /onUndrawable must be a function/],
  ])('refuses %j', (o, msg) => {
    expect(() => checkReplaceOptions(o as never)).toThrow(TypeError);
    expect(() => checkReplaceOptions(o as never)).toThrow(msg);
  });
});

describe('assignRuns', () => {
  it('keeps what the original font draws as one original run', () => {
    const out: Run[] = [], missing: string[] = [];
    assignRuns('ab', { original: helv(), fallbacks: ['Times-Roman'] }, out, missing);
    expect(show(out)).toEqual(['O:ab']);
    expect(missing).toEqual([]);
  });

  it('switches per character, in runs', () => {
    const lib = Document.New().AddFont(LIB);
    const out: Run[] = [], missing: string[] = [];
    assignRuns('a\u03A9\u03A9b', { original: helv(), fallbacks: [lib] }, out, missing);
    expect(show(out)).toEqual(['O:a', 'E:\u03A9\u03A9', 'O:b']);
  });

  it('tries the registered face before the fallbacks', () => {
    const d = Document.New();
    const first = d.AddFont(LIB), second = d.AddFont(LIB);
    const out: Run[] = [];
    assignRuns('\u03A9', { original: helv(), registered: first, fallbacks: [second] }, out, []);
    expect(out[0].font).toBe(first);
  });

  it('omits and reports a character no tier draws', () => {
    const out: Run[] = [], missing: string[] = [];
    assignRuns('a\u03A9b', { original: helv(), fallbacks: ['Times-Roman'] }, out, missing);
    expect(show(out)).toEqual(['O:ab']);
    expect(missing).toEqual(['\u03A9']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/replace-font-tiers.test.ts`
Expected: FAIL — cannot resolve `../src/replacefont.js`.

- [ ] **Step 3: Implement**

Create `src/replacefont.ts`:

```ts
// Which font each character of a replacement is written in (u3l5.2), and the
// options that choose them. Pure over a TextFont and authoring fonts: it
// allocates nothing and touches no content stream, so every tier rule is
// testable from fonts alone.
import type { SearchOptions } from './textedit.js';
import type { TextFont } from './font.js';
import { EmbeddedFont } from './embeddedfont.js';
import { AUTHORING_FONTS, driverFor, type AuthoringFont } from './stamp.js';

/** Options for `ReplaceText` on a page or a document. */
export interface ReplaceTextOptions extends SearchOptions {
  /** Fonts to write a character in when the matched glyph's own font cannot
   *  draw it, tried in order: one of the 12 Latin Standard-14 faces by name, or
   *  a handle from `AddFont`/`LoadFontByName`. */
  fallbackFonts?: AuthoringFont[];
  /** Before `fallbackFonts`, look for the SAME face among folders registered
   *  with `RegisterFontFolder`/`RegisterSystemFonts`: a font whose PostScript
   *  name equals the matched font's `/BaseFont` without its subset tag.
   *  Default false, since the answer depends on the machine. */
  matchRegisteredFonts?: boolean;
  /** Called once per match that lost characters no font could draw. Without
   *  it such a call throws `UnsupportedFeatureError` and changes nothing. */
  onUndrawable?: (r: UndrawableText) => void;
}

/** A match some of whose characters no available font could draw. */
export interface UndrawableText {
  /** 1-based page number. */
  page: number;
  /** The matched text. */
  match: string;
  /** The characters left out, distinct, in order of first appearance. */
  missing: string[];
}

/** Validate `opts` before any page is read; `TypeError` for the wrong kind of
 *  thing, so a typo such as `fallbackFonts: 'Helvetica'` cannot silently mean
 *  "no fallback". */
export function checkReplaceOptions(opts: ReplaceTextOptions | undefined): ReplaceTextOptions {
  const o = opts ?? {};
  if (typeof o !== 'object' || o === null) throw new TypeError('ReplaceText options must be an object');
  if (o.fallbackFonts !== undefined) {
    if (!Array.isArray(o.fallbackFonts)) throw new TypeError('ReplaceText: fallbackFonts must be an array of fonts');
    for (const f of o.fallbackFonts) {
      const ok = f instanceof EmbeddedFont
        || (typeof f === 'string' && (AUTHORING_FONTS as readonly string[]).includes(f));
      if (!ok) throw new TypeError(`ReplaceText: fallbackFonts entry ${String(f)} is neither a Standard-14 authoring face nor a font from AddFont`);
    }
  }
  if (o.matchRegisteredFonts !== undefined && typeof o.matchRegisteredFonts !== 'boolean')
    throw new TypeError('ReplaceText: matchRegisteredFonts must be a boolean');
  if (o.onUndrawable !== undefined && typeof o.onUndrawable !== 'function')
    throw new TypeError('ReplaceText: onUndrawable must be a function');
  return o;
}

/** One run of written text in one font: bytes already encoded in the ORIGINAL
 *  font, or text to encode at apply time in a foreign authoring font. Encoding
 *  a foreign run is deferred because `EmbeddedFont.encode` records glyph usage
 *  for subsetting, and a plan that is refused must record nothing. */
export type Run = { font: 'original'; bytes: Uint8Array } | { font: AuthoringFont; text: string };

/** The fonts a character may be written in, in tier order. */
export interface FontTiers {
  original: TextFont;
  registered?: EmbeddedFont;
  fallbacks: readonly AuthoringFont[];
}

/** Assign each code point of `text` to the first tier that can draw it,
 *  appending to `out`. A code point no tier draws is omitted and pushed onto
 *  `missing`.
 *
 *  **Invariant (u3l5.2):** the decision is PER CHARACTER, so the original face
 *  is kept wherever it can draw and only what it cannot changes face. */
export function assignRuns(text: string, tiers: FontTiers, out: Run[], missing: string[]): void {
  for (const ch of text) {
    const bytes = tiers.original.drawCode(ch);
    if (bytes) { pushRun(out, { font: 'original', bytes }); continue; }
    const foreign = [tiers.registered, ...tiers.fallbacks]
      .find((f): f is AuthoringFont => f !== undefined && driverFor(f).probe(ch) > 0);
    if (foreign !== undefined) pushRun(out, { font: foreign, text: ch });
    else missing.push(ch);
  }
}

/** Append `r`, merging it into the last run when both are in one font. */
export function pushRun(out: Run[], r: Run): void {
  const last = out[out.length - 1];
  if (last && last.font === 'original' && r.font === 'original') {
    const joined = new Uint8Array(last.bytes.length + r.bytes.length);
    joined.set(last.bytes); joined.set(r.bytes, last.bytes.length);
    out[out.length - 1] = { font: 'original', bytes: joined };
    return;
  }
  if (last && last.font !== 'original' && r.font !== 'original' && last.font === r.font) {
    out[out.length - 1] = { font: r.font, text: last.text + r.text };
    return;
  }
  out.push(r);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/replace-font-tiers.test.ts test/import-cycles.test.ts`
Expected: PASS. (`import-cycles` must not gain a 2-cycle: `replacefont.ts` imports `textedit.ts` as a TYPE only.)

Run: `npm run typecheck` — no errors.

- [ ] **Step 5: Mutation checks**

1. Swap tier order to `[...tiers.fallbacks, tiers.registered]` → the registered-first case reddens.
2. Make `pushRun` never merge (always `out.push(r)`) → the per-character and original cases redden.
3. Drop the `AUTHORING_FONTS` check (accept any string) → the `Symbol` case reddens.

- [ ] **Step 6: Commit**

```bash
git add src/replacefont.ts test/replace-font-tiers.test.ts
git commit -m "feat(u3l5.2): replacefont assigns each character a font tier"
```

---

### Task 5: `showsplit.ts` — a show operator rewritten around foreign runs

**Files:**
- Create: `src/showsplit.ts`
- Test: `test/showsplit.test.ts` (create)

**Interfaces:**
- Produces:
  - `type ShowPiece = { kind: 'bytes'; bytes: Uint8Array } | { kind: 'kern'; value: PdfObject } | { kind: 'foreign'; key: string; bytes: Uint8Array }`
  - `interface FontRestore { key: string; size: number }`
  - `function splitShowOp(op: ContentOp, pieces: ShowPiece[], restore: FontRestore): ContentOp[]`

- [ ] **Step 1: Write the failing tests**

Create `test/showsplit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { splitShowOp, type ShowPiece } from '../src/showsplit.js';
import type { ContentOp } from '../src/content.js';
import { isName, isString, type PdfObject } from '../src/types.js';

const s = (t: string): PdfObject => ({ kind: 'string', bytes: Uint8Array.from(t, (c) => c.charCodeAt(0)) });
const b = (t: string): ShowPiece => ({ kind: 'bytes', bytes: Uint8Array.from(t, (c) => c.charCodeAt(0)) });
const f = (t: string): ShowPiece => ({ kind: 'foreign', key: 'F9', bytes: Uint8Array.from(t, (c) => c.charCodeAt(0)) });
const R = { key: 'F1', size: 12 };
/** Ops as compact strings: `Tj(ab)`, `Tf F9 12`, `TJ[(a) -50]`. */
const fmt = (ops: ContentOp[]): string[] => ops.map((op) => {
  const arg = (o: PdfObject): string => isString(o) ? `(${String.fromCharCode(...o.bytes)})`
    : isName(o) ? o.name : Array.isArray(o) ? `[${o.map(arg).join(' ')}]` : String(o);
  return op.operator === 'Tf' ? `Tf ${op.operands.map(arg).join(' ')}` : `${op.operator}${op.operands.map(arg).join(' ')}`;
});

describe('splitShowOp', () => {
  it('splits a Tj around a foreign run and restores the font', () => {
    const op: ContentOp = { operator: 'Tj', operands: [s('aXb')] };
    expect(fmt(splitShowOp(op, [b('a'), f('W'), b('b')], R)))
      .toEqual(['Tj(a)', 'Tf F9 12', 'Tj(W)', 'Tf F1 12', 'Tj(b)']);
  });

  it('omits an empty Tj before or after the switch', () => {
    const op: ContentOp = { operator: 'Tj', operands: [s('X')] };
    expect(fmt(splitShowOp(op, [b(''), f('W'), b('')], R))).toEqual(['Tf F9 12', 'Tj(W)', 'Tf F1 12']);
  });

  it('merges adjacent original pieces into one string', () => {
    const op: ContentOp = { operator: 'Tj', operands: [s('ab')] };
    expect(fmt(splitShowOp(op, [b('a'), b('c'), f('W'), b('d'), b('b')], R)))
      .toEqual(['Tj(ac)', 'Tf F9 12', 'Tj(W)', 'Tf F1 12', 'Tj(db)']);
  });

  it('keeps TJ kerns on the side they sat on', () => {
    const op: ContentOp = { operator: 'TJ', operands: [[s('aX'), -50, s('b')]] };
    const pieces: ShowPiece[] = [b('a'), f('W'), { kind: 'kern', value: -50 }, b('b')];
    expect(fmt(splitShowOp(op, pieces, R))).toEqual(['TJ[(a)]', 'Tf F9 12', 'Tj(W)', 'Tf F1 12', 'TJ[-50 (b)]']);
  });

  it("keeps the line move of ' on the first piece, even when it is empty", () => {
    const op: ContentOp = { operator: "'", operands: [s('X')] };
    expect(fmt(splitShowOp(op, [b(''), f('W'), b('b')], R))).toEqual(["'()", 'Tf F9 12', 'Tj(W)', 'Tf F1 12', 'Tj(b)']);
  });

  it('keeps the spacing operands of " on the first piece only', () => {
    const op: ContentOp = { operator: '"', operands: [2, 1, s('aX')] };
    expect(fmt(splitShowOp(op, [b('a'), f('W')], R))).toEqual(['"2 1 (a)', 'Tf F9 12', 'Tj(W)', 'Tf F1 12']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/showsplit.test.ts`
Expected: FAIL — cannot resolve `../src/showsplit.js`.

- [ ] **Step 3: Implement**

Create `src/showsplit.ts`:

```ts
// One show operator rewritten so a run in another font can sit inside it
// (u3l5.2). Pure over ContentOps: the caller has already chosen fonts,
// encoded every piece and registered every foreign font's resource key.
import type { ContentOp } from './content.js';
import { isString, name, type PdfObject } from './types.js';

/** What one show operator draws, in order, once its edits are applied. */
export type ShowPiece =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'kern'; value: PdfObject }
  | { kind: 'foreign'; key: string; bytes: Uint8Array };

/** The `Tf` that puts the original font back: its resource key and size. */
export interface FontRestore { key: string; size: number }

/**
 * Rewrite `op` as `pieces`, switching font around every foreign piece with
 * `/key size Tf … Tj /restore.key size Tf`.
 *
 * **Invariant:** a foreign run is drawn at the ORIGINAL size and every other
 * text-state parameter carries on, so it takes the replaced text's spacing and
 * colour. The original font is restored after EACH foreign run, so whatever
 * follows in the text object is drawn as before.
 *
 * **Invariant:** the line move of `'` and `"` belongs to the operator, so the
 * FIRST piece keeps the original operator — with `"`'s `aw ac` operands, and
 * even when its string is empty — and everything after is written as `Tj`/`TJ`,
 * so the move and the spacing apply once. An empty `Tj` piece is omitted (it
 * would draw and move nothing); a `TJ` piece holding only kerns is kept, since
 * a kern moves the pen.
 */
export function splitShowOp(op: ContentOp, pieces: ShowPiece[], restore: FontRestore): ContentOp[] {
  const out: ContentOp[] = [];
  let cur: PdfObject[] = [];
  let first = true;
  const str = (bytes: Uint8Array): PdfObject => ({ kind: 'string', bytes });
  const bytesOf = (els: PdfObject[]): Uint8Array => {
    const parts = els.filter(isString).map((e) => e.bytes);
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { joined.set(p, at); at += p.length; }
    return joined;
  };
  const flush = (): void => {
    if (first && op.operator === "'") out.push({ operator: "'", operands: [str(bytesOf(cur))] });
    else if (first && op.operator === '"') out.push({ operator: '"', operands: [op.operands[0], op.operands[1], str(bytesOf(cur))] });
    else if (op.operator === 'TJ') { if (cur.length > 0) out.push({ operator: 'TJ', operands: [cur] }); }
    else { const t = bytesOf(cur); if (t.length > 0) out.push({ operator: 'Tj', operands: [str(t)] }); }
    cur = [];
    first = false;
  };
  for (const p of pieces) {
    if (p.kind === 'foreign') {
      flush();
      out.push(
        { operator: 'Tf', operands: [name(p.key), restore.size] },
        { operator: 'Tj', operands: [str(p.bytes)] },
        { operator: 'Tf', operands: [name(restore.key), restore.size] },
      );
    } else if (p.kind === 'kern') {
      cur.push(p.value);
    } else if (p.bytes.length > 0) {
      const last = cur[cur.length - 1];
      if (last !== undefined && isString(last)) {
        const joined = new Uint8Array(last.bytes.length + p.bytes.length);
        joined.set(last.bytes); joined.set(p.bytes, last.bytes.length);
        cur[cur.length - 1] = str(joined);
      } else cur.push(str(p.bytes));
    }
  }
  flush();
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/showsplit.test.ts`
Expected: PASS (6). `npm run typecheck` — no errors.

- [ ] **Step 5: Mutation checks**

1. Restore with the foreign key (`name(p.key)` in the third op) → the Tj split case reddens.
2. Drop the `first &&` special cases (always flush as Tj) → both quote cases redden.
3. Emit an empty Tj (drop `if (t.length > 0)`) → the empty-omission case reddens.

- [ ] **Step 6: Commit**

```bash
git add src/showsplit.ts test/showsplit.test.ts
git commit -m "feat(u3l5.2): split a show operator around a run in another font"
```

---

### Task 6: Plan and apply in `textedit.ts`; options on page and document

**Files:**
- Modify: `src/textedit.ts` (the S2 section, lines 146-end)
- Modify: `src/page.ts:585-591` (`ReplaceText`)
- Modify: `src/document.ts:3741-3747` (`ReplaceText`)
- Test: `test/replace-fallback.test.ts` (create)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 1-5 (`g.tfKey`, `g.tfSize`, `TextFont.drawCode`, `registerFontIn`, `driverFor`, `Document.fontByPostScriptName`, `checkReplaceOptions`, `assignRuns`, `pushRun`, `Run`, `ReplaceTextOptions`, `UndrawableText`, `splitShowOp`, `ShowPiece`, `FontRestore`).
- Produces: `interface ReplacePlan { count: number; apply(): void }`; `function planReplace(doc: Document, page: Page, pageNumber: number, find: string | RegExp, replacement: string, opts: ReplaceTextOptions): ReplacePlan`; `replaceText(doc, page, find, replacement, opts?: ReplaceTextOptions): number`; `Page.ReplaceText(find, replacement, options?: ReplaceTextOptions)`; `Document.ReplaceText(find, replacement, options?: ReplaceTextOptions)`.

- [ ] **Step 1: Write the failing tests**

Create `test/replace-fallback.test.ts` with the Write tool:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseContentStream, type ContentOp } from '../src/content.js';
import { isDict, name, type PdfObject } from '../src/types.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import type { UndrawableText } from '../src/replacefont.js';
import { buildSimpleTextPdf, buildFormTextPdf } from './helpers/build-text-pdf.js';
import { buildSimpleTtfPdf } from './helpers/build-optimize-pdf.js';

const DIR = fileURLToPath(new URL('./fixtures/fonts/', import.meta.url));
const NIMBUS = new Uint8Array(readFileSync(new URL('./fixtures/fonts/NimbusSans-Regular.otf', import.meta.url)));
const LIB = new Uint8Array(readFileSync(new URL('./fixtures/fonts/LiberationSans-Regular.woff2', import.meta.url)));
const OMEGA = '\u03A9';

const plain = (stream: string) => Document.Open(buildSimpleTextPdf(stream));
const ops = (doc: Document): ContentOp[] => parseContentStream(doc.Pages[0].Contents);
const shape = (doc: Document): string[] => ops(doc)
  .filter((op) => ['Tj', 'TJ', 'Tf', "'", '"'].includes(op.operator))
  .map((op) => op.operator === 'Tf' ? `Tf ${(op.operands[0] as { name: string }).name}` : op.operator);
/** A page drawn in a Nimbus Sans SUBSET (Type0 Identity-H), reopened from bytes. */
const nimbusDoc = (text: string): Document => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddText(text, 50, 700, { font: d.AddFont(NIMBUS) });
  return Document.Open(d.Save());
};

describe('ReplaceText tier A: the original font, verified', () => {
  it('refuses a glyph a subset blanked instead of drawing nothing', () => {
    const d = Document.Open(buildSimpleTtfPdf({ encoding: name('WinAnsiEncoding'), content: '(A)' }));
    d.Optimize();
    const doc = Document.Open(d.Save());
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('A', 'B')).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });

  it('refuses a character the embedded program does not map', () => {
    const doc = Document.Open(buildSimpleTtfPdf({ encoding: name('WinAnsiEncoding'), content: '(A)' }));
    expect(() => doc.Pages[0].ReplaceText('A', 'C')).toThrow(/page 1/);
  });

  it('re-encodes Type0 subset text from glyphs the subset holds', () => {
    const doc = nimbusDoc('Draft');
    expect(doc.Pages[0].ReplaceText('Draft', 'tfarD')).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('tfarD');
  });
});

describe('ReplaceText tier B: fallback fonts', () => {
  it('writes only the characters the original cannot draw in the fallback', () => {
    const doc = plain('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    const lib = doc.AddFont(LIB);
    expect(doc.Pages[0].ReplaceText('X', `c${OMEGA}d`, { fallbackFonts: [lib] })).toBe(1);
    expect(doc.Pages[0].GetText()).toBe(`ac${OMEGA}db`);
    expect(shape(doc)).toEqual(['Tf F1', 'Tj', 'Tf F0', 'Tj', 'Tf F1', 'Tj']);
  });

  it('is byte-identical to before when the original draws everything', () => {
    const a = plain('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    const b = plain('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    a.Pages[0].ReplaceText('X', 'c');
    b.Pages[0].ReplaceText('X', 'c', { fallbackFonts: [b.AddFont(LIB)] });
    expect(b.Pages[0].Contents).toEqual(a.Pages[0].Contents);
  });

  it('draws text after the replacement in the original font again', () => {
    const doc = plain('BT /F1 12 Tf 20 250 Td (aX) Tj (tail) Tj ET');
    doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] });
    const [m] = doc.Pages[0].Search('tail');
    expect(m.hits[0].font.name).toBe('Helvetica');
    expect(m.hits[0].tfKey).toBe('F1');
  });

  it('accepts a Standard-14 fallback for a Type0 subset', () => {
    const doc = nimbusDoc('Draft');
    expect(doc.Pages[0].ReplaceText('Draft', 'Draft!', { fallbackFonts: ['Helvetica'] })).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('Draft!');
  });

  it('splits a TJ, keeping its kerns', () => {
    const doc = plain('BT /F1 12 Tf 20 250 Td [(aX) -50 (b)] TJ ET');
    doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] });
    expect(shape(doc)).toEqual(['Tf F1', 'TJ', 'Tf F0', 'Tj', 'Tf F1', 'TJ']);
    const last = ops(doc).filter((op) => op.operator === 'TJ').pop()!.operands[0] as PdfObject[];
    expect(last[0]).toBe(-50);
  });

  it("keeps the line move of ' on its first piece", () => {
    const doc = plain("BT /F1 12 Tf 14 TL 20 250 Td (aXb) ' ET");
    doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] });
    expect(shape(doc)).toEqual(['Tf F1', "'", 'Tf F0', 'Tj', 'Tf F1', 'Tj']);
  });

  it('registers the fallback in a Form XObject’s own resources', () => {
    const doc = Document.Open(buildFormTextPdf('q /Fm0 Do Q', 'BT /F1 12 Tf 20 250 Td (aXb) Tj ET'));
    doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] });
    expect(doc.Pages[0].GetText()).toBe(`a${OMEGA}b`);
    const pageFonts = doc.resolve(doc.Pages[0].Resources!.get('Font'));
    expect(isDict(pageFonts) && pageFonts.has('F0')).toBe(false);
  });
});

describe('ReplaceText: scopes that cannot switch font', () => {
  it('cannot switch in a form whose font is inherited from the page', () => {
    const doc = Document.Open(buildFormTextPdf('BT /F1 12 Tf ET /Fm0 Do', 'BT 20 250 Td (aXb) Tj ET', { formFont: false }));
    expect(doc.Pages[0].GetText()).toBe('aXb');
    expect(() => doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] }))
      .toThrow(UnsupportedFeatureError);
  });

  it('cannot switch in a form with no resources of its own', () => {
    const doc = Document.Open(buildFormTextPdf('q /Fm0 Do Q', 'BT /F1 12 Tf 20 250 Td (aXb) Tj ET', { formResources: false }));
    expect(doc.Pages[0].GetText()).toBe('aXb');
    expect(() => doc.Pages[0].ReplaceText('X', OMEGA, { fallbackFonts: [doc.AddFont(LIB)] }))
      .toThrow(UnsupportedFeatureError);
  });
});

describe('ReplaceText tier C: the same face from registered folders', () => {
  it('switches to the registered face the subset was cut from', () => {
    const doc = nimbusDoc('Draft');
    doc.RegisterFontFolder(DIR);
    expect(() => doc.Pages[0].ReplaceText('Draft', 'Fixed')).toThrow(UnsupportedFeatureError);
    expect(doc.Pages[0].ReplaceText('Draft', 'Fixed', { matchRegisteredFonts: true })).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('Fixed');
  });
});

describe('ReplaceText reporting and atomicity', () => {
  it('reports what nothing could draw and leaves it out', () => {
    const doc = plain('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    const seen: UndrawableText[] = [];
    expect(doc.Pages[0].ReplaceText('X', `${OMEGA}c`, { onUndrawable: (r) => seen.push(r) })).toBe(1);
    expect(seen).toEqual([{ page: 1, match: 'X', missing: [OMEGA] }]);
    expect(doc.Pages[0].GetText()).toBe('acb');
  });

  it('refuses document-wide when a later page cannot draw', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddText('Hello', 50, 700);
    d.AddPage(PageFormat.A4).page.AddText('Hello', 50, 700, { font: d.AddFont(NIMBUS) });
    const doc = Document.Open(d.Save());
    expect(() => doc.ReplaceText('Hello', 'Q')).toThrow(/page 2/);
    expect(doc.Pages[0].GetText()).toBe('Hello');
  });

  it('takes the same options on the document', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddText('Hello', 50, 700);
    d.AddPage(PageFormat.A4).page.AddText('Hello', 50, 700, { font: d.AddFont(NIMBUS) });
    const doc = Document.Open(d.Save());
    expect(doc.ReplaceText('Hello', 'Q', { fallbackFonts: ['Helvetica'] })).toBe(2);
    expect(doc.Pages.map((p) => p.GetText())).toEqual(['Q', 'Q']);
  });

  it('validates options before reading any page', () => {
    const doc = plain('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    expect(() => doc.ReplaceText('X', 'c', { fallbackFonts: 'Helvetica' as never })).toThrow(TypeError);
    expect(doc.Pages[0].GetText()).toBe('aXb');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/replace-fallback.test.ts`
Expected: FAIL broadly — option fields are ignored (the old `replaceText` takes `SearchOptions`), the blanked-glyph case does NOT throw (it silently writes 0x42), Type0 re-encoding throws, and `doc.ReplaceText` rejects a third argument at the type level only (vitest strips types, so it runs and ignores it). Note which cases already pass; any that pass are fences for byte-identity, not evidence.

- [ ] **Step 3: Implement the plan/apply split in `src/textedit.ts`**

Imports at the top — add:

```ts
import type { ReplaceTextOptions, Run, UndrawableText } from './replacefont.js';
import { assignRuns, checkReplaceOptions, pushRun } from './replacefont.js';
import { splitShowOp, type FontRestore, type ShowPiece } from './showsplit.js';
import { driverFor, registerFontIn, type AuthoringFont } from './stamp.js';
import { ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';
import type { EmbeddedFont } from './embeddedfont.js';
import { UnsupportedFeatureError } from './errors.js';
import { isDict, isStream, type PdfDict } from './types.js';
```

(merge with the existing `./types.js` import rather than duplicating it).

Change `StrEdit` and `StreamEdits`:

```ts
/** A byte-range edit on one show string: replace [start,end) with `runs`. */
interface StrEdit { elementIndex: number; start: number; end: number; runs: Run[]; }

/** Every edit planned for one content stream, keyed by operator index, with the
 *  `Tf` that restores each operator's original font after a foreign run. */
interface StreamEdits {
  addr: ContentAddr;
  perOp: Map<number, StrEdit[]>;
  kerns: Map<number, KernSpan[]>;
  restore: Map<number, FontRestore>;
}

const hasForeign = (e: StrEdit): boolean => e.runs.some((r) => r.font !== 'original');
/** The bytes an edit inserts when every run is in the original font. */
function insertOf(e: StrEdit): Uint8Array {
  const parts = e.runs.map((r) => (r.font === 'original' ? r.bytes : EMPTY));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
```

In `spliceElement`, change `out.push(...e.insert);` to `out.push(...insertOf(e));`.

Replace `replaceText` with `replaceText` + `planReplace`:

```ts
/** A planned replacement on one page: nothing is mutated until `apply`. */
export interface ReplacePlan { count: number; apply(): void }

export function replaceText(
  doc: Document, page: Page, find: string | RegExp, replacement: string,
  opts?: ReplaceTextOptions,
): number {
  const o = checkReplaceOptions(opts);
  const pageNumber = doc.Pages.findIndex((p) => p.Dict === page.Dict) + 1;
  const plan = planReplace(doc, page, pageNumber, find, replacement, o);
  plan.apply();
  return plan.count;
}

/** Plan a replacement on one page, mutating NOTHING (u3l5.2): search, assign
 *  each written character a font, encode what is in the original font.
 *  `doc.ReplaceText` plans every page before applying any, so a refusal on one
 *  page leaves the others untouched. */
export function planReplace(
  doc: Document, page: Page, pageNumber: number, find: string | RegExp, replacement: string,
  opts: ReplaceTextOptions,
): ReplacePlan {
  // (body: see below)
}
```

`planReplace`'s body is the current `replaceText` body from `const { text, refs } = pageText(...)` through the kern loop, with these changes:

1. `if (ranges.length === 0) return 0;` becomes `if (ranges.length === 0) return { count: 0, apply: () => {} };`.
2. Before the glyph loop, add the tier machinery:

```ts
  // Per match: the characters no font could draw, reported or refused below.
  const missing: string[][] = anchored.map(() => []);
  const fallbacks = opts.fallbackFonts ?? [];
  const registeredByName = new Map<string, EmbeddedFont | undefined>();
  const switchable = new Map<string, boolean>();
  /** Whether this glyph's scope can take a font switch: it holds its own
   *  /Resources (a form inheriting its parent's would lose them all to a fresh
   *  dict) whose /Font maps the glyph's `Tf` key to the glyph's own font, so
   *  the restoring `Tf` names what was drawn. */
  const canSwitch = (g: GlyphEvent): boolean => {
    const key = `${g.addr.path.join('\0')}|${g.tfKey}`;
    let ok = switchable.get(key);
    if (ok === undefined) {
      const fonts = scopeFonts(doc, page, g.addr.path);
      ok = fonts !== undefined && g.tfKey !== '' && doc.resolve(fonts.get(g.tfKey)) === g.font.dict;
      switchable.set(key, ok);
    }
    return ok;
  };
  const tiersFor = (g: GlyphEvent) => {
    if (!canSwitch(g)) return { original: g.font, fallbacks: [] as AuthoringFont[] };
    let registered: EmbeddedFont | undefined;
    if (opts.matchRegisteredFonts && g.font.name) {
      const ps = g.font.name.replace(/^[A-Z]{6}\+/, '');
      if (!registeredByName.has(ps)) registeredByName.set(ps, doc.fontByPostScriptName(ps));
      registered = registeredByName.get(ps);
    }
    return { original: g.font, registered, fallbacks };
  };
```

3. Inside the glyph loop, replace the `let out = ''` … `const insert = …` block with:

```ts
      // Each written piece is attributed to a match: a replacement to the match
      // anchored at that position, residue to the first match touching the glyph.
      let owner = -1;
      for (let p = gs; p < ge && owner === -1; p++) owner = matchAt[p];
      const tiers = tiersFor(g);
      const runs: Run[] = [];
      let residue = '';
      const flushResidue = (): void => {
        if (residue) { assignRuns(residue, tiers, runs, missing[owner]); residue = ''; }
      };
      for (let p = gs; p < ge; p++) {
        const ins = insertAt.get(p);
        if (ins !== undefined) { flushResidue(); assignRuns(ins, tiers, runs, missing[matchAt[p]]); }
        if (!covered[p]) residue += text[p];
      }
      // Layout trims whitespace at a line's end, so a glyph's span may be only a
      // PREFIX of its text; the trimmed tail is unmatched and is kept.
      residue += g.text.slice(ge - gs);
      flushResidue();
      if (runs.some((r) => r.font !== 'original')) {
        streamFor(g.addr).restore.set(g.addr.opIndex, { key: g.tfKey, size: g.tfSize });
      }
```

and the open/extend block becomes:

```ts
      if (open && matchAt[openEnd - 1] !== -1 && matchAt[openEnd - 1] === matchAt[gs]) {
        for (const r of runs) pushRun(open.runs, r);
        open.end = g.byteStart + g.byteLen;
      } else {
        open = { elementIndex: g.elementIndex, start: g.byteStart, end: g.byteStart + g.byteLen, runs };
        editsFor(g.addr).push(open);
      }
```

4. `streamFor` initialises `restore: new Map()` beside `kerns`.
5. After the kern loop, replace `applyEdits(doc, page, streams.values()); return ranges.length;` with:

```ts
  const undrawable: UndrawableText[] = [];
  anchored.forEach(([s, e], k) => {
    if (missing[k].length > 0) undrawable.push({ page: pageNumber, match: text.slice(s, e), missing: [...new Set(missing[k])] });
  });
  if (undrawable.length > 0 && !opts.onUndrawable) {
    const chars = [...new Set(undrawable.flatMap((u) => u.missing))];
    throw new UnsupportedFeatureError(
      `ReplaceText: page ${pageNumber}: no available font can draw ${chars.map((c) => JSON.stringify(c)).join(', ')}`);
  }
  return {
    count: ranges.length,
    apply: () => {
      applyEdits(doc, page, streams.values());
      for (const u of undrawable) opts.onUndrawable?.({ ...u, missing: [...u.missing] });
    },
  };
```

Add the scope helper (below `pageText`):

```ts
/** The /Font dict of the scope at `path`, or `undefined` when that scope holds
 *  no /Resources of its OWN (a form without one uses its parent's, 7.8.3, and
 *  registering a font there would need a fresh dict that hides the rest). */
function scopeFonts(doc: Document, page: Page, path: readonly string[]): PdfDict | undefined {
  let res = page.Resources;
  for (const n of path) {
    const xobjs = doc.resolve(res?.get('XObject'));
    const xo = isDict(xobjs) ? doc.resolve(xobjs.get(n)) : undefined;
    if (!isStream(xo)) return undefined;
    const own = doc.resolve(xo.dict.get('Resources'));
    if (!isDict(own)) return undefined;
    res = own;
  }
  const fonts = doc.resolve(res?.get('Font'));
  return isDict(fonts) ? fonts : undefined;
}
```

Replace `applyEdits` with the foreign-aware version:

```ts
/** Write the planned edits through one `EditableContent` and commit it. An
 *  operator whose edits carry a run in another font is SPLIT around it
 *  (`splitShowOp`); every other operator takes u3l5.1's byte splice, which is
 *  what keeps a replacement the original font can draw byte-identical. */
function applyEdits(doc: Document, page: Page, streams: Iterable<StreamEdits>): void {
  const ec = new EditableContent(doc, page);
  let any = false;
  for (const { addr, perOp, kerns, restore } of streams) {
    any = true;
    const ops = addr.path.length === 0 ? ec.topOps(addr.streamIndex) : ec.xobjectOps(addr.path);
    let fonts: PdfDict | undefined;
    // The scope's own /Font dict, made writable once. A form is reached through
    // the EditableContent, never a dict captured before its copy-on-write.
    const keyFor = (font: AuthoringFont): string => {
      if (!fonts) {
        const res = addr.path.length === 0 ? ensureOwnResources(doc, page) : ec.ownXObjectResources(addr.path);
        fonts = ensureOwnSubdict(doc, res, 'Font');
      }
      return registerFontIn(doc, fonts, font);
    };
    const out: ContentOp[] = [];
    ops.forEach((op, i) => {
      const e = perOp.get(i) ?? [], k = kerns.get(i) ?? [];
      if (e.length === 0 && k.length === 0) { out.push(op); return; }
      if (e.some(hasForeign)) { out.push(...splitShowOp(op, showPieces(op, e, k, keyFor), restore.get(i)!)); return; }
      const next = spliceShowOp(op, e, k);
      if (!emptiedTj(op, next)) out.push(next);
    });
    if (addr.path.length === 0) ec.setTopOps(addr.streamIndex, out);
    else ec.setXobjectOps(addr.path, out);
  }
  if (any) ec.commit();
}

/** What a show operator draws after its edits, as `splitShowOp` pieces. A
 *  foreign run is encoded HERE, at apply time, so a refused plan records no
 *  glyph usage on an embedded fallback. */
function showPieces(
  op: ContentOp, edits: StrEdit[], kerns: KernSpan[], keyFor: (f: AuthoringFont) => string,
): ShowPiece[] {
  const els: PdfObject[] = op.operator === 'TJ'
    ? (isArray(op.operands[0]) ? op.operands[0] : [])
    : [op.operands[op.operator === '"' ? 2 : 0]];
  const drop = op.operator === 'TJ' ? droppedKerns(els, kerns) : new Set<number>();
  const pieces: ShowPiece[] = [];
  els.forEach((el, idx) => {
    if (!isString(el)) { if (!drop.has(idx)) pieces.push({ kind: 'kern', value: el }); return; }
    const mine = edits.filter((x) => x.elementIndex === idx).sort((a, b) => a.start - b.start);
    let pos = 0;
    for (const x of mine) {
      pieces.push({ kind: 'bytes', bytes: el.bytes.subarray(pos, x.start) });
      for (const r of x.runs) {
        pieces.push(r.font === 'original'
          ? { kind: 'bytes', bytes: r.bytes }
          : { kind: 'foreign', key: keyFor(r.font), bytes: driverFor(r.font).encode(r.text) });
      }
      pos = x.end;
    }
    pieces.push({ kind: 'bytes', bytes: el.bytes.subarray(pos) });
  });
  return pieces;
}
```

Update `replaceText`'s doc comment: append

```ts
 *  **Invariant (u3l5.2):** each written character goes to the first font that
 *  can draw it — the original (verified by `TextFont.drawCode`), then with
 *  `matchRegisteredFonts` the same face from registered folders, then
 *  `fallbackFonts` — and only a scope whose own /Resources map the glyph's
 *  `Tf` key may switch at all. A character nothing draws throws, or with
 *  `onUndrawable` is left out and reported.
```

- [ ] **Step 4: Page and document entry points**

`src/page.ts` — `ReplaceText(find: string | RegExp, replacement: string, options?: ReplaceTextOptions): number`, importing `type ReplaceTextOptions` from `./replacefont.js`. Replace its doc comment's last two sentences with: "Characters the matched font cannot draw go to `options.fallbackFonts` (and, with `matchRegisteredFonts`, the same face from registered folders); one nothing can draw throws `UnsupportedFeatureError`, or with `options.onUndrawable` is left out and reported. Returns the number of occurrences found."

`src/document.ts`:

```ts
  /** Replace every occurrence of `find` with `replacement` across all pages; see
   *  `Page.ReplaceText`, whose options it takes. Every page is PLANNED before
   *  any is changed, so a refusal leaves the whole document untouched. Returns
   *  the total number of occurrences found. */
  ReplaceText(find: string | RegExp, replacement: string, options?: ReplaceTextOptions): number {
    const o = checkReplaceOptions(options);
    const plans = this.Pages.map((p, i) => planReplace(this, p, i + 1, find, replacement, o));
    for (const p of plans) p.apply();
    return plans.reduce((n, p) => n + p.count, 0);
  }
```

importing `planReplace` from `./textedit.js` and `checkReplaceOptions`, `type ReplaceTextOptions` from `./replacefont.js`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/replace-fallback.test.ts test/text-replace-ligature.test.ts test/text-replace.test.ts test/replace-api.test.ts test/search-astral.test.ts test/optional-content-extract.test.ts test/import-cycles.test.ts`
Expected: PASS, the four pre-existing replace files UNEDITED. If `import-cycles` reports a new 2-cycle, it names the pair: break it by moving the offending value import to a type import, never by updating the asserted set.

Run: `npm run typecheck` — no errors.

- [ ] **Step 6: Mutation checks**

Each followed by `npx vitest run test/replace-fallback.test.ts` and a restore; record counts:
1. `canSwitch` always true → both "cannot switch" cases redden.
2. Drop the own-/Resources requirement in `scopeFonts` (`if (!isDict(own)) continue;`) → the no-resources case reddens.
3. Restore to the wrong font: in `showsplit.ts` emit `name(p.key)` instead of `name(restore.key)` in the third op → the "text after" case reddens (re-run `test/replace-fallback.test.ts`).
4. Apply page-by-page in `Document.ReplaceText` (`plans.forEach` replaced by plan-then-apply per page) → the document-wide refusal case reddens.
5. Call `onUndrawable` during planning instead of `apply` → expect GREEN on these fixtures (no later refusal follows a report); record as held by reasoning.
6. Encode foreign runs at plan time → expect GREEN (no assertion reads `usedGids`); record as held by reasoning.

- [ ] **Step 7: CHANGELOG**

Under `## [Unreleased]`: `### Added` (first such section):

```markdown
- **`ReplaceText` falls back to other fonts for characters the matched font cannot draw.** `page.ReplaceText(find, replacement, { fallbackFonts })` and now `doc.ReplaceText(..., options)` write each character in the first font that can draw it: the matched glyph's own font, then — with `matchRegisteredFonts: true` — the same face found by PostScript name in folders registered with `RegisterFontFolder`/`RegisterSystemFonts` (the subset tag stripped from `/BaseFont`), then each fallback in order, Standard-14 names or `AddFont`/`LoadFontByName` handles. The decision is per character, so only what the original cannot draw changes face. A foreign run is written by splitting the show operator and switching font with `Tf`, at the original size, spacing and colour, and the original font is restored straight after, so the rest of the line is drawn as before. A replacement the original font can fully draw is byte-identical to before. A character no font can draw throws `UnsupportedFeatureError` naming it and the page, or, with `onUndrawable`, is left out and reported as `{ page, match, missing }`. A scope that cannot take a switch — a Form XObject without its own `/Resources`, or one whose font was set on the page and inherited — gets no fallback. `GlyphEvent` (and so `TextMatch.hits`) gains `tfKey` and `tfSize`, the `Tf` in force. Re-subsetting the document's own embedded font to add glyphs is not done. (u3l5.2)
```

`### Fixed` (first such section):

```markdown
- **`ReplaceText` no longer writes a character a subset font cannot draw.** A subset font's encoding still maps characters whose glyphs were never embedded, so a replacement using one encoded happily and drew nothing, or `.notdef`, with no error. A character now counts as drawable in the original font only when its code decodes back to that character and, for an embedded font, selects a glyph the program defines (a glyph slot a subsetter emptied counts as missing, except for whitespace). Otherwise it falls back or is refused. (u3l5.2)
```

`### Changed` (first such section):

```markdown
- **`ReplaceText` re-encodes text in Type0 fonts where it can, and `doc.ReplaceText` is all-or-nothing.** Writing into a Type0 (composite) font always threw; a font under `/Identity-H` or `/Identity-V` now takes any character its `/ToUnicode` maps to a glyph the program holds, so a subset can be rewritten with the letters it already contains. `doc.ReplaceText` now plans every page before changing any, so an error on page 3 leaves pages 1 and 2 as they were, where before they were already rewritten. (u3l5.2)
```

- [ ] **Step 8: Commit**

```bash
git add src/textedit.ts src/page.ts src/document.ts test/replace-fallback.test.ts CHANGELOG.md
git commit -m "feat(u3l5.2): ReplaceText falls back to registered and caller fonts"
```

---

### Task 7: Exports, documentation, full verification, close

**Files:**
- Modify: `src/index.ts:102-103`
- Modify: `README.md` (Text replace bullet ~187, the `ReplaceText` example ~1582-1592, API rows ~3835 and the document `ReplaceText` row, the types table)
- Modify: `CLAUDE.md` (the `**textedit.ts**` paragraph; Source list entries for `replacefont.ts` and `showsplit.ts`)

- [ ] **Step 1: Exports**

`src/index.ts`, beside the textedit type export:

```ts
export type { ReplaceTextOptions, UndrawableText } from './replacefont.js';
```

- [ ] **Step 2: README**

- Text replace bullet: replace "throws `UnsupportedFeatureError` when text must be written in a Type0/composite font (which cannot be re-encoded) or a character the encoding can't represent." with: "writes each character in the first font that can draw it — the matched glyph's own (verified against its embedded program, and through `/ToUnicode` for an `/Identity-H` Type0 font), then with `matchRegisteredFonts` the same face from registered folders, then `options.fallbackFonts` — switching font with `Tf` around foreign runs. A character no font can draw throws `UnsupportedFeatureError`, or with `options.onUndrawable` is left out and reported. `doc.ReplaceText` takes the same options and changes nothing unless every page succeeds."
- The longer `ReplaceText` passage (~1586-1592): add a short example after the existing two lines:

```ts
const lib = doc.AddFont(readFileSync('LiberationSans-Regular.ttf'));
doc.ReplaceText('Draft', 'Ωmega', { fallbackFonts: [lib, 'Helvetica'] });
doc.RegisterFontFolder('./fonts');
doc.ReplaceText('Draft', 'Final', { matchRegisteredFonts: true });   // the subset's own face
```

- API rows: `page.ReplaceText(find, replacement, options?)` — "Replace matches in place → count. `options` is `ReplaceTextOptions`: `region`, `fallbackFonts`, `matchRegisteredFonts`, `onUndrawable`". Same for `doc.ReplaceText`, adding "all pages planned before any changes".
- Types table: rows for `ReplaceTextOptions` and `UndrawableText` in the run where neighbouring `R`/`U` names sit (find the run by locating an existing type row starting with `R` and one starting with `U`).

- [ ] **Step 3: CLAUDE.md**

Add Source-list entries (place them after the `**textedit.ts**` paragraph):

```markdown
- **replacefont.ts**, **showsplit.ts** — which font each character of a
  replacement is written in, and one show operator rewritten around a run in
  another font (u3l5.2). Both pure: `replacefont.ts` takes a `TextFont` and
  authoring fonts, `showsplit.ts` takes `ContentOp`s and already-encoded
  pieces; `textedit.ts` holds the `Document`.
  **Invariant:** tier A is `TextFont.drawCode` — a code qualifies only when it
  DECODES back to the character and, for an embedded program, selects a glyph
  the program defines (`glyphDefined` in font.ts: gid 0 is missing except in a
  Type 1 program; an empty `glyf` slot is missing except for whitespace). That
  is what stops a subset font drawing a blank for a character its encoding
  maps and its program dropped.
  **Invariant:** only a scope whose OWN /Resources map the glyph's `Tf` key to
  the glyph's font may switch. A form without /Resources inherits its
  parent's, so registering a font there means a fresh dict that hides the rest;
  a font inherited from the page (mih4) has a `tfKey` the form cannot name.
  **Invariant:** a foreign run is encoded at APPLY time, never in the plan —
  `EmbeddedFont.encode` records glyph usage for subsetting, and a refused plan
  must record nothing. `doc.ReplaceText` plans every page before applying any.
  **Note, measured:** [fill from the ledger — N of M mutations redden; list
  each green one and what holds it instead.]
```

and in the `**textedit.ts**` paragraph, append one line: "`ReplaceText` is PLAN then APPLY since u3l5.2; see `replacefont.ts`."

Run the CLAUDE.md sweep from its Conventions section and confirm it prints nothing.

- [ ] **Step 4: Full verification**

Run: `npm run typecheck` — no errors.
Run: `npm test` — all files pass, `test/readme-api.test.ts` included (it checks every export has a README row and the intro counts; copy the counts it reports into README's intro if it says they changed).

- [ ] **Step 5: Commit, close, push**

```bash
git add src/index.ts README.md CLAUDE.md
git commit -m "docs(u3l5.2): replacement font fallback"
bd close u3l5.2
git pull --rebase
git push
git status
```
Expected: `git status` up to date with origin.
