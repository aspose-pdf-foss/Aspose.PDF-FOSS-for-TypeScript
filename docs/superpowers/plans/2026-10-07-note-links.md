# Internal Links Between Note Marks and Notes (v9j3.3.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every footnote/endnote citation mark is a GoTo link to its note, and every note's gutter mark is a GoTo link back to its first citation, on by default.

**Architecture:** A mark run carries an internal `DeferredLink` in `TextRun.link`. `stamp.ts` lays it out like any linked run, and `runlink.ts` reports its box (and its tagged `/Link` element) instead of making an annotation. A `NoteLinks` collector (`flownotes.ts`), created per placement, records citation boxes and drawn notes, and `finish()` writes every annotation once all placement is done.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` specifiers), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-note-links-design.md`

## Global Constraints

- Zero runtime dependencies; no new value-import 2-cycle (`npx vitest run test/import-cycles.test.ts`). `flownotes.ts` gains a value import of `annotation.ts` (`addLink`): verify it.
- Every `catch` in `src/` calls `rethrowLimit(caught)` first — this plan adds none.
- Default ON; `FlowNoteOptions.links: false` (per kind) turns it off, validated as a boolean (`TypeError` `footnotes.links must be a boolean`).
- `links: false` output is byte-identical to v9j3.3.3's, tagged included: the Task 2 fence twins assert the EXISTING hashes in `test/flow-notes-identity.test.ts`. With links on, the two UNTAGGED hashes there must not move; the TAGGED one moves and is re-recorded under a ledgered ruling.
- `TextRun.link`'s public type stays `string`. The deferred value is internal (`@internal`).
- No annotation is ever written with a placeholder target: all GoTo annotations are created in `NoteLinks.finish()`.
- No `/Contents` on the new annotations (as for URI run links); `border: 0`.
- **Ruling (planner):** the spec says `lowerNotes` stops copying `body.link` onto the mark when links are on. `lowerNotes` runs in the builders, which have no Flow and so no `links` option; the deferred link is therefore set by `NoteNumberer.assign`, which holds the resolved options, OVERWRITING the copied URI. With links off nothing is overwritten — the copied URI stays, today's behaviour.
- `test/flow-notes-tagged.test.ts:24` asserts a `/Note`'s children are `['P']`; with links on, the gutter mark is inside a `/Link` child, so it becomes `['P', 'Link']` — a ledgered ruling, since the spec moves the mark under `/Link`.

## Review Focus

1. **A note on a different page from its citation** (an endnote with `newPage`): the citation link on page 1 goes to page 2, the back link on page 2 goes to page 1. → Task 2.
2. **A repeated citation**: two citation links, both to the one note; ONE back link, to the first citation. → Task 2.
3. **A tagged flow with notes**: `ValidatePdfUa` reports no new issue, and each `/Link` element holds the mark's content and its `/OBJR`. → Task 2.
4. **`links: false`**: no annotation, and the fence hashes unchanged. → Task 2.
5. **A cited run that is itself a URI link**: its words still open the URI; its mark goes to the note. → Task 2.

---

### Task 1: Deferred run links (`runlink.ts`, `stamp.ts`, `tableauthor.ts`)

**Files:**
- Modify: `src/runlink.ts` (`DeferredLink`, `isDeferredLink`, `RunLinkBox.target`, `placeRunLinks`)
- Modify: `src/stamp.ts:528-529` (`ResolvedRun.link`), `:561` (validation), `:921-925` (`runLinkBoxes`)
- Modify: `src/tableauthor.ts:791` (cell run validation)
- Test: `test/runlink-deferred.test.ts` (new)

**Interfaces:**
- Produces: `interface DeferredLink { readonly deferred: true; onBox(page: Page, rect: [number, number, number, number], elem?: StructElement): void }` and `isDeferredLink(v: unknown): v is DeferredLink`, both exported from `src/runlink.ts`, `@internal`.
- Produces: a run whose `link` is a `DeferredLink` is laid out, given its own marked content when tagged, and reported through `onBox` (page, the same rect a URI box would get, and — when tagged — the `/Link` element holding its MCID). NO annotation is made for it.

- [ ] **Step 1: Write the failing test**

```ts
// test/runlink-deferred.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { createTable } from '../src/tableauthor.js';
import type { DeferredLink } from '../src/runlink.js';
import type { StructElement } from '../src/struct.js';

function deferred() {
  const got: Array<{ page: number; rect: [number, number, number, number]; elem?: StructElement }> = [];
  const link: DeferredLink = {
    deferred: true,
    onBox: (page, rect, elem) => { got.push({ page: page.Number, rect, ...(elem ? { elem } : {}) }); },
  };
  return { link: link as unknown as string, got };
}

describe('deferred run links', () => {
  it('report their box and make no annotation (untagged)', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const { link, got } = deferred();
    page.AddTextBlock([{ text: 'see ' }, { text: 'HERE', link }, { text: ' now' }], [72, 600, 300, 100], { fontSize: 12 });
    expect(page.Annotations).toHaveLength(0);
    expect(got).toHaveLength(1);
    expect(got[0].page).toBe(page.Number);
    expect(got[0].elem).toBeUndefined();
    const [x0, y0, x1, y1] = got[0].rect;
    expect(x0).toBeCloseTo(72 + page.MeasureText('see ', 12), 1);
    expect(x1 - x0).toBeCloseTo(page.MeasureText('HERE', 12), 1);
    expect(y1).toBeGreaterThan(y0);
  });

  it('a tagged block gives the run a /Link element holding its glyphs', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const p = doc.CreateStructTree().Append('P');
    const { link, got } = deferred();
    page.AddTextBlock([{ text: 'see ' }, { text: 'HERE', link }], [72, 600, 300, 100], { fontSize: 12, tag: p });
    expect(page.Annotations).toHaveLength(0);
    expect(got).toHaveLength(1);
    const el = got[0].elem!;
    expect(el.Type).toBe('Link');
    expect(el.Parent!.Dict).toBe(p.Dict);
    expect(el.GetText()).toContain('HERE');
  });

  it('a URI link beside it still makes its annotation', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const { link, got } = deferred();
    page.AddTextBlock([{ text: 'web', link: 'https://example.com/' }, { text: ' and ' }, { text: 'mark', link }], [72, 600, 300, 100]);
    expect(page.Annotations).toHaveLength(1);
    expect(got).toHaveLength(1);
  });

  it('a table cell accepts a deferred link', () => {
    const { link, got } = deferred();
    const t = createTable();
    t.addRow().addCell([{ text: 'cell ' }, { text: 'M', link }]);
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    flow.Render();
    expect(got).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/runlink-deferred.test.ts`
Expected: FAIL — `TypeError: run 1: link must be a non-empty string` (stamp) and `cell run 1: link must be a non-empty string` (table).

- [ ] **Step 3: `src/runlink.ts`**

Above `RunLinkBox`:

```ts
/** A link whose target is not known when its run is laid out (v9j3.3.4): a
 *  note mark, whose note is placed later. The run is laid out and tagged like
 *  any linked run, but no annotation is made: its box (and, when tagged, the
 *  /Link element holding its glyphs) is handed to `onBox`, and whoever made
 *  the link writes the annotation once the target exists. @internal */
export interface DeferredLink {
  readonly deferred: true;
  onBox(page: Page, rect: [number, number, number, number], elem?: StructElement): void;
}

/** Whether `v` is a {@link DeferredLink}. @internal */
export function isDeferredLink(v: unknown): v is DeferredLink {
  return typeof v === 'object' && v !== null && (v as DeferredLink).deferred === true
    && typeof (v as DeferredLink).onBox === 'function';
}
```

In `RunLinkBox`, rename `uri: string;` to:

```ts
  /** The /URI this box links to, or a deferred target (v9j3.3.4). */
  target: string | DeferredLink;
```

Rewrite the loop of `placeRunLinks` (the group compares targets by identity, which for strings is the value comparison it did before):

```ts
  const out: LinkAnnotation[] = [];
  let group: { target: string | DeferredLink; elem: StructElement } | undefined;
  for (const b of boxes) {
    if (!(b.rect[2] > b.rect[0]) || !(b.rect[3] > b.rect[1])) continue;
    const deferred = isDeferredLink(b.target);
    const annot = deferred ? undefined : addLink(doc, page, {
      rect: b.rect,
      action: { type: 'uri', uri: b.target as string },
      border: 0,
    });
    if (annot !== undefined) out.push(annot);
    let elem: StructElement | undefined;
    if (parent !== undefined) {
      if (group === undefined || group.target !== b.target)
        group = { target: b.target, elem: parent.Append('Link') };
      elem = group.elem;
      // The glyphs first, then the annotation: /K is reading order, and the words
      // are what a reader meets before the link target.
      if (b.mcid !== undefined) {
        // The id was reserved against the block being laid out, because the /Link
        // did not exist yet; point the parent tree at its real owner.
        retargetMcid(doc, elem, page, b.mcid);
        appendContentKid(doc, elem.Dict, b.mcid, doc.pageRef(page.Number));
      }
      if (annot !== undefined) elem.AddAnnotation(annot);
    }
    // A deferred target's annotation is written by its owner, later.
    if (deferred) (b.target as DeferredLink).onBox(page, b.rect, elem);
  }
  return out;
```

Keep the function's doc comment; add one sentence: "A deferred box (v9j3.3.4) gets its /Link element and marked content here, and its annotation from the owner of the link."

- [ ] **Step 4: `src/stamp.ts`**

Import: `import { placeRunLinks, isDeferredLink, type RunLinkBox, type DeferredLink } from './runlink.js';`.

`ResolvedRun.link` (line ~528):

```ts
  /** The /URI this run links to, a deferred note link (v9j3.3.4), or undefined. */
  link: string | DeferredLink | undefined;
```

Validation (line ~561):

```ts
    if (r.link !== undefined && !isDeferredLink(r.link) && (typeof r.link !== 'string' || r.link === ''))
      throw new TypeError(`run ${i}: link must be a non-empty string`);
```

In `runLinkBoxes`, `uri: r.link,` becomes `target: r.link,`.

- [ ] **Step 5: `src/tableauthor.ts:791`**

Add `import { isDeferredLink } from './runlink.js';` (stamp.ts already imports runlink.ts and tableauthor.ts imports stamp.ts, so this closes no cycle) and change the check to:

```ts
            if (run.link !== undefined && !isDeferredLink(run.link)
                && (typeof run.link !== 'string' || run.link === ''))
```

- [ ] **Step 6: Run, expect PASS**

Run: `npx vitest run test/runlink-deferred.test.ts test/rich-runs-link-tagged.test.ts test/rich-runs-identity.test.ts test/import-cycles.test.ts` then `npx tsc -p tsconfig.json --noEmit; echo tsc=$?`
Expected: PASS, `tsc=0`. (If `rich-runs-link-tagged.test.ts` does not exist, run `npx vitest run test/rich-runs` instead — every URI-link test must stay green unedited.)

- [ ] **Step 7: Commit**

```bash
git add src/runlink.ts src/stamp.ts src/tableauthor.ts test/runlink-deferred.test.ts
git commit -m "feat(v9j3.3.4): deferred run links — laid out and tagged like a link, annotation left to its owner"
```

---

### Task 2: `NoteLinks` — marks link to notes and back

**Files:**
- Modify: `src/flownotes.ts` (`FlowNoteOptions.links`, `ResolvedNoteOptions.links`, `normalizeNoteOptions`, `NoteLinks`, `NoteNumberer`, `NoteHolder`, `NoteElement.place`, `notesAsTrailing`)
- Modify: `src/flow.ts:1615` (numberer gets the collector) and the end of `Render` (`finish()`)
- Modify: `src/page.ts:699-716` (`trailingNotes`)
- Modify: `test/flow-notes-identity.test.ts` (twins first; tagged hash re-record later), `test/flow-notes-tagged.test.ts:24`
- Test: `test/flow-note-links.test.ts` (new)

**Interfaces:**
- Consumes: `DeferredLink` (Task 1).
- Produces: `class NoteLinks { constructor(doc: Document); linkFor(ref: NoteRef): DeferredLink; noteDrawn(ref: NoteRef, box: { page: Page; x: number; top: number; rect: [number, number, number, number]; elem?: StructElement }): void; finish(): void }`, exported `@internal` from `flownotes.ts`.
- Produces: `new NoteNumberer(foot, end, makeBody, links?: NoteLinks)`; `notesAsTrailing(elements, foot, end, makeBody, tagging?, links?: NoteLinks)`.

- [ ] **Step 1: Fence twins, BEFORE any change**

Append to the `describe` in `test/flow-notes-identity.test.ts`, copying each existing case with `links: false` on both kinds and asserting the SAME inline snapshot string that case has:

```ts
  it('footnotes across pages, links off', () => {
    const flow = Document.New().NewFlow({ footnotes: { links: false } });
    for (let i = 0; i < 6; i++)
      flow.AddParagraph([{ text: filler(25) }, { text: '', footnote: { content: `Note ${i}. ${filler(3)}` } }]);
    expect(sha(flow.Render())).toBe('8e4d00555b556318');
  });
  it('endnotes, a repeat and a custom mark, links off', () => {
    const n = { content: 'Shared.' };
    const flow = Document.New().NewFlow({ footnotes: { links: false }, endnotes: { newPage: true, links: false } });
    flow.AddParagraph([{ text: 'a' }, { text: '', endnote: n }, { text: ' b' }, { text: '', endnote: n }]);
    flow.AddParagraph([{ text: 'c' }, { text: '', footnote: { content: 'Star.', mark: '*' } }]);
    expect(sha(flow.Render())).toBe('2127fbed745c37b0');
  });
  it('tagged two-column flow with footnotes, links off', () => {
    const flow = Document.New().NewFlow({ tagged: true, columns: 2, footnotes: { links: false } });
    for (let i = 0; i < 4; i++)
      flow.AddParagraph([{ text: filler(12) }, { text: '', footnote: { content: `Col note ${i}.` } }]);
    expect(sha(flow.Render())).toBe('c7d4624205a307fc');
  });
```

(Confirm the three literals equal the three existing inline snapshots in the file before committing.) Run `npx vitest run test/flow-notes-identity.test.ts` — PASS (an unknown key is ignored today). Commit:

```bash
git add test/flow-notes-identity.test.ts
git commit -m "test(v9j3.3.4): links-off twins of the note fence, asserting today's hashes"
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/flow-note-links.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { createTable } from '../src/tableauthor.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';
import type { StructElement } from '../src/struct.js';
import type { PdfObject } from '../src/types.js';

type Frag = { text: string; fontSize: number; quad: number[] };
type Pg = { Number: number; GetTextFragments(): Frag[]; GetText(): string; Annotations: unknown[] };
type Goto = { rect: [number, number, number, number]; page: number; left?: number | null; top?: number | null };
type Uri = { rect: [number, number, number, number]; uri: string };

function gotos(pg: Pg): Goto[] {
  return (pg.Annotations as Array<{ Rect?: [number, number, number, number]; Action?: { type: string; page?: number; view?: { left?: number | null; top?: number | null } } }>)
    .filter((a) => a.Action?.type === 'goto')
    .map((a) => ({ rect: a.Rect!, page: a.Action!.page!, left: a.Action!.view?.left, top: a.Action!.view?.top }));
}
function uris(pg: Pg): Uri[] {
  return (pg.Annotations as Array<{ Rect?: [number, number, number, number]; Action?: { type: string; uri?: string } }>)
    .filter((a) => a.Action?.type === 'uri').map((a) => ({ rect: a.Rect!, uri: a.Action!.uri! }));
}
/** A fragment's left edge lies in the rect and its baseline in its band. */
const covers = (rect: number[], f: Frag) =>
  f.quad[0] >= rect[0] - 0.5 && f.quad[0] < rect[2] && f.quad[1] >= rect[1] - 2 && f.quad[1] <= rect[3];
const small = (pg: Pg, t: string) => pg.GetTextFragments().filter((f) => f.text.trim() === t && f.fontSize < 8);
const all = (el: { Children: StructElement[] }): StructElement[] => el.Children.flatMap((c) => [c, ...all(c)]);

describe('note links', () => {
  it('the mark links to its note, the note’s mark links back (same page)', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'A claim' }, { text: '', footnote: { content: 'NOTEBODY' } }]);
    const [pg] = flow.Render() as unknown as Pg[];
    const links = gotos(pg);
    expect(links).toHaveLength(2);
    const [cite, gutter] = small(pg, '1').sort((a, b) => b.quad[1] - a.quad[1]);   // citation is higher
    const body = pg.GetTextFragments().find((f) => f.text.includes('NOTEBODY'))!;
    const toNote = links.find((l) => covers(l.rect, cite))!;
    expect(toNote.page).toBe(pg.Number);
    expect(toNote.top!).toBeGreaterThanOrEqual(body.quad[1]);
    expect(toNote.top!).toBeLessThan(body.quad[1] + 20);
    const back = links.find((l) => covers(l.rect, gutter))!;
    expect(back.page).toBe(pg.Number);
    expect(back.top!).toBeGreaterThanOrEqual(cite.quad[1]);
    expect(back.top!).toBeLessThan(cite.quad[1] + 20);
  });

  it('links cross pages: an endnote on a new page (Review Focus 1)', () => {
    const flow = Document.New().NewFlow({ endnotes: { newPage: true } });
    flow.AddParagraph([{ text: 'cited here' }, { text: '', endnote: { content: 'ENDBODY' } }]);
    const pages = flow.Render() as unknown as Pg[];
    expect(pages.length).toBe(2);
    expect(gotos(pages[0]).map((l) => l.page)).toEqual([pages[1].Number]);
    expect(gotos(pages[1]).map((l) => l.page)).toEqual([pages[0].Number]);
  });

  it('a repeated citation: two links to the note, one back link to the first (Review Focus 2)', () => {
    const n = { content: 'SHARED' };
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'first' }, { text: '', footnote: n }]);
    flow.AddParagraph('x '.repeat(40));
    flow.AddParagraph([{ text: 'again' }, { text: '', footnote: n }]);
    const [pg] = flow.Render() as unknown as Pg[];
    const links = gotos(pg);
    expect(links).toHaveLength(3);
    const firstY = pg.GetTextFragments().find((f) => f.text.includes('first'))!.quad[1];
    const shared = pg.GetTextFragments().find((f) => f.text.includes('SHARED'))!.quad[1];
    const toNote = links.filter((l) => l.top! < firstY - 50);          // targets at the foot
    expect(toNote).toHaveLength(2);
    const back = links.filter((l) => l.rect[3] < shared + 15);          // the one on the note's line
    expect(back).toHaveLength(1);
    expect(back[0].top!).toBeGreaterThanOrEqual(firstY);
    expect(back[0].top!).toBeLessThan(firstY + 20);
  });

  it('a table-cell mark links to its note', () => {
    const t = createTable();
    t.addRow().addCell([{ text: 'cell' }, { text: '', footnote: { content: 'CELLNOTE' } }]);
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const [pg] = flow.Render() as unknown as Pg[];
    expect(gotos(pg)).toHaveLength(2);
  });

  it('page.AddMarkdown (one rect) links both ways', () => {
    const doc = Document.New();
    const page = doc.AddPage().page as unknown as Pg & { AddMarkdown: Function };
    page.AddMarkdown('A claim.[^1]\n\n[^1]: THE NOTE\n', [72, 72, 450, 700], { gfm: true });
    expect(gotos(page)).toHaveLength(2);
  });

  it('a cited URI run keeps its URI; its mark goes to the note (Review Focus 5)', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'docs', link: 'https://example.com/d', footnote: { content: 'N' } }, { text: ' after' }]);
    const [pg] = flow.Render() as unknown as Pg[];
    const u = uris(pg);
    expect(u).toHaveLength(1);
    expect(covers(u[0].rect, pg.GetTextFragments().find((f) => f.text.includes('docs'))!)).toBe(true);
    const cite = small(pg, '1').sort((a, b) => b.quad[1] - a.quad[1])[0];
    expect(u.some((l) => covers(l.rect, cite))).toBe(false);
    expect(gotos(pg).some((l) => covers(l.rect, cite))).toBe(true);
  });

  it('links: false writes no annotation (Review Focus 4)', () => {
    const flow = Document.New().NewFlow({ footnotes: { links: false }, endnotes: { links: false } });
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: { content: 'F' } }, { text: ' b' }, { text: '', endnote: { content: 'E' } }]);
    for (const pg of flow.Render() as unknown as Pg[]) expect(pg.Annotations).toHaveLength(0);
  });

  it('links is per kind', () => {
    const flow = Document.New().NewFlow({ endnotes: { links: false } });
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: { content: 'F' } }, { text: ' b' }, { text: '', endnote: { content: 'E' } }]);
    const pages = flow.Render() as unknown as Pg[];
    expect(pages.flatMap(gotos)).toHaveLength(2);
  });

  it('refuses a links option that is not a boolean', () => {
    expect(() => Document.New().NewFlow({ footnotes: { links: 'yes' as never } })).toThrow(/footnotes.links must be a boolean/);
  });

  it('tagged: each link is a /Link with the mark and its /OBJR; PDF/UA reports nothing new (Review Focus 3)', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true, lang: 'en' });
    flow.AddParagraph([{ text: 'A claim' }, { text: '', footnote: { content: 'NOTEBODY' } }]);
    flow.Render();
    const linkEls = all(doc.GetStructTree()!).filter((e) => e.Type === 'Link');
    expect(linkEls.map((e) => e.Parent!.Type).sort()).toEqual(['Note', 'P']);
    for (const el of linkEls) {
      expect(el.GetText()).toContain('1');
      const k = doc.resolve(el.Dict.get('K') ?? null);
      const kids = (Array.isArray(k) ? k : [k]).map((x: PdfObject) => doc.resolve(x));
      expect(kids.some((x) => x instanceof Map && (x.get('Type') as { name?: string } | undefined)?.name === 'OBJR')).toBe(true);
    }
    const report = doc.ValidatePdfUa();
    expect(report.Issues.filter((i) => i.rule === 'UntaggedContent' || /Link|Annot/i.test(i.rule))).toEqual([]);
  });

  it('Markdown and DOCX documents link their notes', () => {
    const md = Document.New().AddMarkdown('A claim.[^1]\n\n[^1]: NOTE\n', { gfm: true });
    expect((md.pages as unknown as Pg[]).flatMap(gotos)).toHaveLength(2);
    const bytes = buildDocx(p(r('A claim.') + '<w:r><w:footnoteReference w:id="1"/></w:r>'),
      { footnotes: '<w:footnote w:id="1">' + p(r('NOTE')) + '</w:footnote>' });
    const dx = Document.New().AddDocx(bytes);
    expect((dx.pages as unknown as Pg[]).flatMap(gotos)).toHaveLength(2);
  });
});
```

(Read `doc.resolve`'s and `PdfObject`'s exact names in `src/document.ts`/`src/types.ts` and adapt the OBJR helper's access only — e.g. `isDict`/`isName` from `types.js` if a name is not `{ name }`. If `report.Issues` items name their rule under another key, read `src/validation.ts` and adapt the filter only.)

- [ ] **Step 3: Run, expect FAIL**

Run: `npx vitest run test/flow-note-links.test.ts`
Expected: FAIL — no goto annotations (0 where 2 are expected); the non-boolean `links` is not refused.

- [ ] **Step 4: Options in `src/flownotes.ts`**

In `FlowNoteOptions`, after `restart`:

```ts
  /** Link each citation mark to its note and the note's mark back to the
   *  first citation, as GoTo annotations (v9j3.3.4). Default true. */
  links?: boolean;
```

In `ResolvedNoteOptions` add `links: boolean;`. In `normalizeNoteOptions`, before the `return`:

```ts
  const links = v.links ?? true;
  if (typeof links !== 'boolean') throw new TypeError(`${p}.links must be a boolean`);
```

and return `{ format, start, markScale, fontSize, separator, spacing, newPage, restart, links }`.

- [ ] **Step 5: `NoteLinks` in `src/flownotes.ts`**

Imports: `import { addLink } from './annotation.js';`, `import { vmetricsFor } from './textdecor.js';`, `import type { DeferredLink } from './runlink.js';` (keep `TextRun` from `textdecor.js` in the same import). Then, before `NoteNumberer`:

```ts
type NoteRect = [number, number, number, number];
interface LinkFrom { page: Page; rect: NoteRect; elem?: StructElement }

/** The GoTo links between citation marks and notes (v9j3.3.4), one per
 *  placement (`Flow.Render`, or one rect). A mark run carries `linkFor(ref)`;
 *  its laid-out boxes arrive through the deferred link, the note's gutter mark
 *  through `noteDrawn`, and `finish()` writes every annotation once all is
 *  placed — so no annotation ever names a target that does not exist yet.
 *  A citation whose note never placed gets no link. @internal */
export class NoteLinks {
  private readonly cites = new Map<NoteRef, LinkFrom[]>();
  private readonly notes = new Map<NoteRef, LinkFrom & { x: number; top: number }>();

  constructor(private readonly doc: Document) {}

  /** The deferred link a mark run carries: its boxes are recorded against `ref`. */
  linkFor(ref: NoteRef): DeferredLink {
    return {
      deferred: true,
      onBox: (page, rect, elem) => {
        const list = this.cites.get(ref) ?? [];
        list.push({ page, rect, ...(elem !== undefined ? { elem } : {}) });
        this.cites.set(ref, list);
      },
    };
  }

  /** A note's gutter mark was drawn: its own box, and the note's anchor. */
  noteDrawn(ref: NoteRef, box: LinkFrom & { x: number; top: number }): void {
    if (!this.notes.has(ref)) this.notes.set(ref, box);
  }

  /** Write every annotation. Citation → the note's first line; the note's
   *  mark → its FIRST citation (a repeat resolves to its first). */
  finish(): void {
    for (const [ref, boxes] of this.cites) {
      const n = this.notes.get(ref.repeatOf ?? ref);
      if (n === undefined) continue;
      for (const b of boxes) this.link(b, n.page, n.x, n.top);
    }
    for (const [ref, n] of this.notes) {
      const first = this.cites.get(ref)?.[0];
      if (first !== undefined) this.link(n, first.page, first.rect[0], first.rect[3]);
    }
  }

  private link(from: LinkFrom, to: Page, left: number, top: number): void {
    const annot = addLink(this.doc, from.page, {
      rect: from.rect,
      action: { type: 'goto', page: to.Number, view: { type: 'XYZ', left, top, zoom: null } },
      border: 0,
    });
    // Glyphs first, then the annotation: the order runlink.ts keeps.
    from.elem?.AddAnnotation(annot);
  }
}
```

- [ ] **Step 6: The numberer and the note element**

`NoteHolder` gains `links?: NoteLinks;`. `NoteNumberer`'s constructor gains a fourth parameter `private readonly links?: NoteLinks,`. In `assign`, in the REPEAT branch after `ref.repeatOf = prior;`:

```ts
      if (this.links !== undefined && p.links) ref.markRun.link = this.links.linkFor(ref) as unknown as string;
```

and in the first-citation branch after `ref.markRun.rise = ref.baseSize * MARK_RISE;`:

```ts
    // Overwrites a URI lowerNotes copied from the cited run: the words keep
    // the URI, the mark goes to the note (v9j3.3.4).
    if (this.links !== undefined && o.links) ref.markRun.link = this.links.linkFor(ref) as unknown as string;
```

and in the `holder` literal add `...(this.links !== undefined && o.links ? { links: this.links } : {}),`.

In `NoteElement.place`, replace the gutter-mark block:

```ts
    if (res.drew && !this.h.drawn) {
      // The mark is the /Note's OWN content, not a /Lbl: this library's
      // PDF/UA rule (and PDF 1.7's Table 336) keeps /Lbl to list items, so a
      // /Lbl here failed ValidatePdfUa on every tagged flow with notes. With
      // links (v9j3.3.4) it sits in a /Link child of the /Note.
      const links = this.h.links;
      const linkEl = links !== undefined && note !== undefined ? note.Append('Link') : undefined;
      const tag = linkEl ?? note;
      const y = ctx.top - this.h.fontSize + this.h.fontSize * MARK_RISE;
      stampText(ctx.doc, ctx.page, this.h.ref.mark, ctx.x, y,
        { font: 'Helvetica', fontSize: this.h.markSize, ...(tag ? { tag } : {}) });
      if (links !== undefined) {
        const w = measureText(this.h.ref.mark, this.h.markSize, 'Helvetica');
        const vm = vmetricsFor('Helvetica');
        links.noteDrawn(this.h.ref, {
          page: ctx.page, x: ctx.x, top: ctx.top,
          rect: [ctx.x, y + vm.descent * this.h.markSize, ctx.x + w, y + vm.ascent * this.h.markSize],
          ...(linkEl !== undefined ? { elem: linkEl } : {}),
        });
      }
      this.h.drawn = true;
    }
```

(Check `vmetricsFor`'s return: `descent` negative, as `runLinkBoxes` uses it. If it is positive there, subtract it.)

`notesAsTrailing` gains a trailing parameter `links?: NoteLinks` and constructs `new NoteNumberer(foot, end, makeBody, links)`.

- [ ] **Step 7: Wire the two placements**

`src/flow.ts`: add `NoteLinks` to the `./flownotes.js` import; at line ~1615 create `const noteLinks = new NoteLinks(this.doc);` and pass it as the numberer's fourth argument; immediately before `if (structRoot !== undefined) registerStructIds(...)` near the end of `Render`, call `noteLinks.finish();`.

`src/page.ts` `trailingNotes`: create `const links = new NoteLinks(this.doc);`, pass it as `notesAsTrailing`'s last argument (after `tagging`), and in `done()` call `links.finish();` first. Add `NoteLinks` to page.ts's `flownotes.js` import.

- [ ] **Step 8: Run, expect PASS — and record the rulings**

Run: `npx vitest run test/flow-note-links.test.ts test/flow-notes-identity.test.ts test/flow-notes-tagged.test.ts test/runlink-deferred.test.ts test/import-cycles.test.ts`

Expected: `flow-note-links` PASS; `flow-notes-identity`'s three twins PASS and its two UNTAGGED original cases PASS; its TAGGED original case FAILS with a new hash; `flow-notes-tagged.test.ts:24` FAILS with `['P', 'Link']`. Both are the planner's rulings (Global Constraints): replace the tagged inline snapshot with the new hash (`npx vitest run test/flow-notes-identity.test.ts -u` touches ONLY that file; confirm with `git diff` that exactly one hash string changed and the twins did not), and change line 24 to `expect(note.Children.map((c) => c.Type)).toEqual(['P', 'Link']);`. If either UNTAGGED hash moves, STOP: content bytes changed — debug, do not re-record.

Then run every note and link test: `npx vitest run test/flow-notes test/flownotes test/markdown-footnotes.test.ts test/docx-notes.test.ts test/flow-table-notes.test.ts test/table-notes-frontends.test.ts test/markdown-pdfua.test.ts test/rich-runs` — PASS. A test elsewhere that counts a page's annotations on a flow with notes is a ruling of the same kind; record each.

- [ ] **Step 9: Commit**

```bash
git add src/flownotes.ts src/flow.ts src/page.ts test/flow-note-links.test.ts test/flow-notes-identity.test.ts test/flow-notes-tagged.test.ts
git commit -m "feat(v9j3.3.4): note marks link to their notes and back"
```

---

### Task 3: Mutation sweep, docs, verification

**Files:**
- Modify: `README.md` (the Flow footnotes paragraph ~1132: links both ways, `links: false`; the one-rect overflow limitation; the `FlowNoteOptions` API row if it lists fields)
- Modify: `CHANGELOG.md` (`### Added`: note links, on by default; `### Changed`: a cited URI run's mark now goes to the note; tagged notes gain a `/Link`)
- Modify: `CLAUDE.md` (`runlink.ts` entry: `DeferredLink`; `flownotes.ts` entry: `NoteLinks` invariants)

- [ ] **Step 1: Mutation sweep** (strip ANSI, judge by exit status, every pattern applied exactly once or NOT-APPLIED, LOAD-ERROR and TIMEOUT never GREEN). Test set: `test/flow-note-links.test.ts test/runlink-deferred.test.ts test/flow-notes-identity.test.ts test/flow-notes-tagged.test.ts`. Each expected RED:
1. `placeRunLinks` makes an annotation for a deferred box too → runlink-deferred (no-annotation cases).
2. `onBox` not called → runlink-deferred, every note-links case.
3. tagged deferred box gets no `/Link` element (elem undefined) → tagged cases.
4. `isDeferredLink` dropped from stamp's validation → runlink-deferred throws.
5. `finish()` never called in `Flow.Render` → note-links cases.
6. `finish()` never called in `trailingNotes` → one-rect case.
7. back link targets the note instead of the first citation → back-link assertions.
8. citation link targets the citation instead of the note → same-page case.
9. a repeat's boxes resolved against itself (`ref` not `ref.repeatOf ?? ref`) → repeat case (repeat gets no link: 2 instead of 3).
10. back link to the LAST citation (`.at(-1)`) → repeat case.
11. `links` default false → note-links cases.
12. numberer ignores `o.links` → links-off cases and the twins.
13. the URI not overwritten (mark keeps the cited run's URI) → URI case.
14. gutter mark tagged under `/Note` even with links → tagged case.
15. `AddAnnotation` not called in `NoteLinks.link` → tagged OBJR case.
Record results in CLAUDE.md, naming equivalent mutants and rules held only by hand-built cases.

- [ ] **Step 2: Docs**, house style (bold lead-in, what it does, why, what was measured, issue id):
  - README Flow footnotes section: marks link to their notes and the note's mark back to the first citation, GoTo annotations, on by default; `footnotes: { links: false }` / `endnotes: { links: false }`; a note that overflows a single rect (`page.AddMarkdown`/`page.AddDocx`) is not placed and its citation gets no link; a cited URI run keeps its URI on its words.
  - CHANGELOG **Added** (`v9j3.3.4`); **Changed**: a cited run that is a URI link used to make its mark a second URI link — the mark now goes to the note; a tagged note's mark sits in a `/Link`.
  - CLAUDE.md: `DeferredLink` (why the annotation is the owner's: the target does not exist at layout time), `NoteLinks` (one pass at the end, nothing half-written; repeats resolve to their first; the URI overwrite happens in `assign` because lowering has no options), and the sweep results.
  Run `npx vitest run test/readme-api.test.ts` (no new public export is expected: `DeferredLink`, `isDeferredLink` and `NoteLinks` are not exported from `src/index.ts`) and the module sweep (`for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done`) — must print nothing.

- [ ] **Step 3: Full verification**

Run: `npx tsc -p tsconfig.json --noEmit; echo tsc=$?` then `npm test > <scratchpad>/full.txt 2>&1; echo test=$?` and read the tail. Expected: `tsc=0`, `test=0`.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs(v9j3.3.4): note links — README, CHANGELOG, CLAUDE.md"
```
