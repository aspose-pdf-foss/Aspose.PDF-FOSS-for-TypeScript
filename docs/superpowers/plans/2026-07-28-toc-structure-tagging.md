# TOC structure tagging (`/TOC` + `/TOCI`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `page.AddTOC` an opt-in `tagged` mode that emits `/TOC` → `/TOCI` → `/Reference` → `/Link` logical structure, with the dot leader marked as an artifact and `entry.level` mapped onto nested `/TOC` elements.

**Architecture:** A new `src/tocstruct.ts` owns the structure subtree and the level stack; `src/tocrender.ts` calls it around the stamps it already emits. Marked content is produced by the existing `wrapMarkedContent` plus a new no-MCID sibling `wrapArtifact`, reached through a new `@internal artifact` flag on `StampOptions`. All validation stays in `measureTOC`, preserving the "a throwing call leaves the document byte-identical" invariant.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, zero runtime dependencies.

Spec: `docs/superpowers/specs/2026-07-28-toc-structure-tagging-design.md`. Issue: `aspose-pdf-foss-for-ts-1gg0.5`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension (`import { Page } from './page.js'`).
- **`tagged: false` (the default) must stay byte-identical to today.** No `BDC`/`BMC` in the content stream, no `/StructTreeRoot`, no `/MarkInfo`.
- **Validate before drawing.** Every new option is checked in `measureTOC`, which runs to completion before `drawTOC` paints anything.
- **Lazy allocation.** No structure object is created until the first row is actually painted.
- **Issue tracking is `bd`.** Do NOT use TodoWrite or markdown TODO lists.
- **Before closing the issue:** `npm run typecheck` and `npm test` must both be green.
- Commit after every task. Do not push until the whole plan is done and the session-close protocol in `CLAUDE.md` runs.

---

### Task 1: `artifact` marked content in the stamping layer

Marks a stamp as `/Artifact BMC … EMC` — content that belongs to no structure element. Needed for the dot leader, reusable by any later authoring code.

**Files:**
- Modify: `src/pagecontent.ts` (add `wrapArtifact` beside `wrapMarkedContent`, ~line 30)
- Modify: `src/stamp.ts` (`StampOptions`, ~line 56; the four wrap sites at ~248, ~261, ~486, ~501)
- Test: `test/stamp.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `wrapMarkedContent(tag: string, mcid: number, body: Uint8Array): Uint8Array` from `src/pagecontent.ts`.
- Produces:
  - `wrapArtifact(body: Uint8Array): Uint8Array` from `src/pagecontent.ts`
  - `StampOptions.artifact?: boolean` — mutually exclusive with `StampOptions.tag`; inherited by `TextBlockOptions` (which is `Omit<StampOptions, 'align' | 'rotate'>`) and therefore by `TOCOptions`.

- [ ] **Step 1: Write the failing test**

Append to `test/stamp.test.ts`:

```ts
describe('stampText — artifact marked content', () => {
  it('wraps the stamp in /Artifact BMC … EMC', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('decoration', 100, 700, { artifact: true } as any);
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain('/Artifact BMC');
    expect(content).toContain('EMC');
    // No MCID: an artifact belongs to no element.
    expect(content).not.toContain('/MCID');
  });

  it('reads back as an artifact fragment', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('plain', 100, 700);
    page.AddText('decoration', 100, 680, { artifact: true } as any);
    const frags = page.GetTextFragments();
    const art = frags.filter((f) => f.artifact);
    expect(art.map((f) => f.text).join('')).toContain('decoration');
    expect(art.map((f) => f.text).join('')).not.toContain('plain');
  });

  it('rejects artifact together with tag', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const el = doc.CreateStructTree().Append('P');
    expect(() => page.AddText('x', 100, 700, { artifact: true, tag: el } as any))
      .toThrow(TypeError);
    // Nothing drawn.
    expect(new TextDecoder('latin1').decode(page.Contents)).not.toContain('(x) Tj');
  });
});
```

`buildStampTarget` is already imported by `test/stamp.test.ts`; if not, add
`import { buildStampTarget } from './helpers/build-stamp-target.js';`. Keep the
`as any` casts only if `AddText`'s public option type does not surface the
`@internal` flag — check after Step 3 and drop them if they compile without.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stamp.test.ts -t "artifact"`
Expected: FAIL — no `/Artifact BMC` in the content stream (the flag is ignored).

- [ ] **Step 3: Write minimal implementation**

In `src/pagecontent.ts`, directly below `wrapMarkedContent`:

```ts
/** Wrap `body` in an /Artifact marked-content sequence: content that belongs to
 *  no structure element. The no-MCID sibling of {@link wrapMarkedContent} — in a
 *  tagged page every piece of content must be tagged or marked as an artifact. */
export function wrapArtifact(body: Uint8Array): Uint8Array {
  const head = enc('/Artifact BMC\n');
  const tail = enc('\nEMC');
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}
```

In `src/stamp.ts`, extend the `pagecontent.js` import with `wrapArtifact`, then
add to `StampOptions` directly under `tag`:

```ts
  /** @internal Mark this stamp as an /Artifact: content that belongs to no
   *  structure element (`/Artifact BMC … EMC`). Mutually exclusive with `tag`. */
  artifact?: boolean;
```

Add these two module-level helpers (place them next to `ContentSplice`, before
`stampText`):

```ts
/** Reject the one nonsensical combination up front: content is either some
 *  element's or no one's. Called before anything is drawn. */
function validateMarking(options: StampOptions | TextBlockOptions): void {
  if (options.artifact && options.tag)
    throw new TypeError('artifact and tag are mutually exclusive');
}

/** Apply the caller's marked-content choice to a built stamp body. */
function markContent(
  doc: Document, page: Page, options: StampOptions | TextBlockOptions, body: Uint8Array,
): Uint8Array {
  if (options.artifact) return wrapArtifact(body);
  return options.tag
    ? wrapMarkedContent(options.tag.Type, allocContentMcid(doc, options.tag, page), body)
    : body;
}
```

Call `validateMarking(options);` as the first statement of both `stampText` and
`flowTextBlock`, then replace each of the four

```ts
    const tagged = options.tag
      ? wrapMarkedContent(options.tag.Type, allocContentMcid(doc, options.tag, page), body)
      : body;
    put(doc, page, tagged);
```

blocks with

```ts
    put(doc, page, markContent(doc, page, options, body));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/stamp.test.ts test/toc.test.ts test/toc-decoration.test.ts`
Expected: PASS (the four call sites were behaviourally identical for `tag`, so the existing tagging tests must stay green).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pagecontent.ts src/stamp.ts test/stamp.test.ts
git commit -m "feat(stamp): /Artifact marked content for stamps (1gg0.5)"
```

---

### Task 2: `TocTagger` — the structure subtree and level stack

Pure structure authoring: no painting, no measurement. Testable on its own because it only touches the struct tree.

**Files:**
- Create: `src/tocstruct.ts`
- Test: `test/tocstruct.test.ts`

**Interfaces:**
- Consumes: `Document.CreateStructTree(): StructTreeRoot`; `StructElement.Append(type: string, opts?: ElemOpts): StructElement`; `StructElement.AddAnnotation(annotation: Annotation): void`; `StructElement.Type: string`.
- Produces, from `src/tocstruct.ts`:
  - `class TocTagger`
    - `constructor(doc: Document, opts: { links: boolean; structParent?: StructElement })`
    - `readonly toc: StructElement` — the root `/TOC` this tagger fills
    - `beginRow(level: number): StructElement` — opens `TOCI > Reference [> Link]` and returns the element the row's content is tagged into
    - `finishRow(annotation: Annotation): void` — attaches the row's link annotation to the element `beginRow` returned

- [ ] **Step 1: Write the failing test**

Create `test/tocstruct.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import type { StructElement } from '../src/struct.js';
import { TocTagger } from '../src/tocstruct.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

/** A letter-size document with `n` pages; page 1 is the TOC page. */
function docWith(n: number): Document {
  const doc = Document.Open(buildBlankPage());
  while (doc.Pages.length < n) doc.AddPage();
  return doc;
}

/** Structure types of an element's child elements, in order. */
const childTypes = (e: StructElement): string[] => e.Children.map((c) => c.Type);

describe('TocTagger — subtree shape', () => {
  it('builds TOCI > Reference > Link per row under one /TOC', () => {
    const doc = docWith(3);
    const t = new TocTagger(doc, { links: true });
    const a = t.beginRow(1);
    const b = t.beginRow(1);
    expect(a.Type).toBe('Link');
    expect(b.Type).toBe('Link');
    expect(t.toc.Type).toBe('TOC');
    expect(childTypes(t.toc)).toEqual(['TOCI', 'TOCI']);
    expect(childTypes(t.toc.Children[0])).toEqual(['Reference']);
    expect(childTypes(t.toc.Children[0].Children[0])).toEqual(['Link']);
  });

  it('omits the /Link when links are off', () => {
    const doc = docWith(3);
    const t = new TocTagger(doc, { links: false });
    const content = t.beginRow(1);
    expect(content.Type).toBe('Reference');
    expect(childTypes(t.toc.Children[0])).toEqual(['Reference']);
    expect(childTypes(content)).toEqual([]);
  });

  it('attaches the /TOC at the struct tree root by default', () => {
    const doc = docWith(2);
    const t = new TocTagger(doc, { links: true });
    t.beginRow(1);
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['TOC']);
    expect(t.toc.Parent).toBeUndefined();   // its parent IS the root
  });

  it('attaches under a caller-supplied structParent', () => {
    const doc = docWith(2);
    const sect = doc.CreateStructTree().Append('Sect');
    const t = new TocTagger(doc, { links: true, structParent: sect });
    t.beginRow(1);
    expect(childTypes(sect)).toEqual(['TOC']);
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['Sect']);
  });

  it('reuses a structParent that is itself a /TOC', () => {
    const doc = docWith(2);
    const first = new TocTagger(doc, { links: true });
    first.beginRow(1);
    const second = new TocTagger(doc, { links: true, structParent: first.toc });
    second.beginRow(1);
    expect(second.toc.Ref!.num).toBe(first.toc.Ref!.num);
    expect(childTypes(first.toc)).toEqual(['TOCI', 'TOCI']);
    expect(doc.GetStructTree()!.Children.map((c) => c.Type)).toEqual(['TOC']);
  });
});

describe('TocTagger — level nesting', () => {
  it('nests a deeper row in a child /TOC under the previous TOCI', () => {
    const doc = docWith(4);
    const t = new TocTagger(doc, { links: true });
    t.beginRow(1); t.beginRow(2); t.beginRow(2); t.beginRow(1);
    // root TOC: TOCI(A) [with nested TOC], TOCI(B)
    expect(childTypes(t.toc)).toEqual(['TOCI', 'TOCI']);
    const a = t.toc.Children[0];
    expect(childTypes(a)).toEqual(['Reference', 'TOC']);
    expect(childTypes(a.Children[1])).toEqual(['TOCI', 'TOCI']);
    expect(childTypes(t.toc.Children[1])).toEqual(['Reference']);
  });

  it('clamps a level jump to one level deeper (1 -> 3 lands at depth 2)', () => {
    const doc = docWith(3);
    const t = new TocTagger(doc, { links: true });
    t.beginRow(1); t.beginRow(3);
    const a = t.toc.Children[0];
    expect(childTypes(a)).toEqual(['Reference', 'TOC']);
    expect(childTypes(a.Children[1])).toEqual(['TOCI']);
    // and no third level was opened
    expect(childTypes(a.Children[1].Children[0])).toEqual(['Reference']);
  });

  it('clamps a first row that starts deep to depth 1', () => {
    const doc = docWith(2);
    const t = new TocTagger(doc, { links: true });
    t.beginRow(3);
    expect(childTypes(t.toc)).toEqual(['TOCI']);
    expect(childTypes(t.toc.Children[0])).toEqual(['Reference']);
  });

  it('does not reuse a stale deeper TOCI after popping back', () => {
    const doc = docWith(5);
    const t = new TocTagger(doc, { links: true });
    t.beginRow(1); t.beginRow(2); t.beginRow(1); t.beginRow(2);
    const [a, b] = t.toc.Children;
    expect(childTypes(a.Children[1])).toEqual(['TOCI']);   // A's sub-TOC: one row
    expect(childTypes(b)).toEqual(['Reference', 'TOC']);   // B opened its own
    expect(childTypes(b.Children[1])).toEqual(['TOCI']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tocstruct.test.ts`
Expected: FAIL — `Cannot find module '../src/tocstruct.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/tocstruct.ts`:

```ts
// The /TOC + /TOCI structure subtree behind `page.AddTOC({ tagged: true })`
// (issue 1gg0.5). Structure only: no measurement, no painting. tocrender.ts
// calls beginRow before a row's stamps and finishRow after its link annotation,
// which is why this is its own module — threading a level stack through
// paintRow would blur "where the ink goes".
import type { Document } from './document.js';
import type { Annotation } from './annotation.js';
import type { StructElement } from './struct.js';

export interface TocTaggerOptions {
  /** Whether rows carry link annotations; when false no /Link element is made. */
  links: boolean;
  /** Element to append the /TOC under; a /TOC element is reused rather than
   *  nested. Default: the structure tree root. */
  structParent?: StructElement;
}

export class TocTagger {
  /** The root /TOC element this tagger fills. */
  readonly toc: StructElement;

  /** Open /TOC elements, shallowest first: stack[i] is the TOC at depth i + 1. */
  private readonly stack: StructElement[];
  /** lastTOCI[i] is the most recent /TOCI appended to stack[i], if any. */
  private readonly lastTOCI: (StructElement | undefined)[] = [];
  /** The element the current row's content is tagged into. */
  private current: StructElement | undefined;

  constructor(private readonly doc: Document, private readonly opts: TocTaggerOptions) {
    const parent = opts.structParent;
    // A /TOC parent is continuation, not nesting: a manual-pagination loop hands
    // back the previous call's element so a three-page TOC is one TOC.
    this.toc = parent && parent.Type === 'TOC'
      ? parent
      : (parent ?? doc.CreateStructTree()).Append('TOC');
    this.stack = [this.toc];
  }

  /** Open the row's subtree at `level` and return the element its content is
   *  tagged into: the /Link when links are on, else the /Reference. */
  beginRow(level: number): StructElement {
    // A row descends at most one level, and only when the current depth has a
    // /TOCI to hang the child /TOC from — so a 1 -> 3 jump, or a TOC whose first
    // row is level 3, clamps rather than inventing empty intermediate TOCIs.
    const open = this.stack.length;
    const maxDepth = open + (this.lastTOCI[open - 1] ? 1 : 0);
    const d = Math.min(Math.max(level, 1), maxDepth);
    if (d === open + 1) {
      this.stack.push(this.lastTOCI[open - 1]!.Append('TOC'));
    } else if (d < open) {
      this.stack.length = d;
      this.lastTOCI.length = d;   // drop stale deeper TOCIs
    }
    const toci = this.stack[d - 1].Append('TOCI');
    this.lastTOCI[d - 1] = toci;
    const reference = toci.Append('Reference');
    this.current = this.opts.links ? reference.Append('Link') : reference;
    return this.current;
  }

  /** Attach the row's link annotation (an OBJR) to the element beginRow opened. */
  finishRow(annotation: Annotation): void {
    if (this.current === undefined) throw new Error('finishRow before beginRow');
    this.current.AddAnnotation(annotation);
  }
}
```

Note `this.doc` is stored but only used via `CreateStructTree` in the
constructor; if TypeScript's `noUnusedLocals` complains, drop the `private
readonly doc` parameter property and use a plain constructor parameter.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tocstruct.test.ts`
Expected: PASS (12 assertions across 9 tests).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/tocstruct.ts test/tocstruct.test.ts
git commit -m "feat(toc): TocTagger — /TOC + /TOCI subtree and level stack (1gg0.5)"
```

---

### Task 3: `tagged` / `structParent` options and their validation

Adds the public options and validates them where every other TOC option is validated — before anything is drawn.

**Files:**
- Modify: `src/toc.ts` (`TOCOptions` ~line 42, `TOCLayout` ~line 89, `measureTOC` ~line 175)
- Test: `test/tocstruct.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `measureTOC(doc, entries, rect, opts): TOCLayout` from `src/toc.ts`; `Document.GetStructTree(): StructTreeRoot | null`; `StructElement.Ref: PdfRef | undefined`; `StructElement.Root: StructTreeRoot`.
- Produces:
  - `TOCOptions.tagged?: boolean` and `TOCOptions.structParent?: StructElement`
  - `TOCLayout.tagged: boolean` and `TOCLayout.structParent?: StructElement` — how Task 4 reads them

- [ ] **Step 1: Write the failing test**

Append to `test/tocstruct.test.ts` (extend the existing import line with
`measureTOC`: `import { measureTOC } from '../src/toc.js';`):

```ts
describe('TOC tagging options — validation', () => {
  const RECT: [number, number, number, number] = [72, 400, 400, 300];
  const ENTRIES = [{ title: 'One', page: 1 }];

  it('defaults to untagged', () => {
    const doc = docWith(2);
    const L = measureTOC(doc, ENTRIES, RECT);
    expect(L.tagged).toBe(false);
    expect(L.structParent).toBeUndefined();
  });

  it('rejects a non-boolean tagged', () => {
    const doc = docWith(2);
    expect(() => measureTOC(doc, ENTRIES, RECT, { tagged: 'yes' as any })).toThrow(TypeError);
  });

  it('rejects structParent without tagged', () => {
    const doc = docWith(2);
    const sect = doc.CreateStructTree().Append('Sect');
    expect(() => measureTOC(doc, ENTRIES, RECT, { structParent: sect })).toThrow(TypeError);
  });

  it('rejects a structParent from another document', () => {
    const doc = docWith(2);
    const other = docWith(2);
    const foreign = other.CreateStructTree().Append('Sect');
    expect(() => measureTOC(doc, ENTRIES, RECT, { tagged: true, structParent: foreign }))
      .toThrow(TypeError);
  });

  it('rejects a structParent with no indirect ref', () => {
    const doc = docWith(2);
    const sect = doc.CreateStructTree().Append('Sect');
    const refless = Object.create(Object.getPrototypeOf(sect),
      Object.getOwnPropertyDescriptors(sect));
    Object.defineProperty(refless, 'Ref', { value: undefined });
    expect(() => measureTOC(doc, ENTRIES, RECT, { tagged: true, structParent: refless }))
      .toThrow(TypeError);
  });

  it('accepts a well-formed structParent', () => {
    const doc = docWith(2);
    const sect = doc.CreateStructTree().Append('Sect');
    const L = measureTOC(doc, ENTRIES, RECT, { tagged: true, structParent: sect });
    expect(L.tagged).toBe(true);
    expect(L.structParent).toBe(sect);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tocstruct.test.ts -t "tagging options"`
Expected: FAIL — `L.tagged` is `undefined` and no call throws.

- [ ] **Step 3: Write minimal implementation**

In `src/toc.ts`, add to the imports:

```ts
import type { StructElement } from './struct.js';
```

Add to `TOCOptions`, after `autoPaginate`:

```ts
  /** Emit /TOC + /TOCI logical structure into the document structure tree.
   *  Default false, in which case output is byte-identical to an untagged call.
   *  Each row becomes `TOCI > Reference > Link` holding the title and label
   *  marked content plus the link annotation's OBJR; `level` maps onto nested
   *  /TOC elements; the dot leader is marked as an /Artifact. */
  tagged?: boolean;
  /** Element to append the /TOC under. Default: the structure tree root. When
   *  this element is itself a /TOC it is *reused* rather than nested, which is
   *  how a manual-pagination loop keeps one TOC across pages — pass back
   *  {@link AddTOCResult.struct}. Requires `tagged: true`. */
  structParent?: StructElement;
```

Add to `TOCLayout`, after `autoPaginate`:

```ts
  tagged: boolean;
  structParent?: StructElement;
```

In `measureTOC`, directly after the `autoPaginate` line:

```ts
  const tagged = opts.tagged ?? false;
  if (typeof tagged !== 'boolean') throw new TypeError('tagged must be a boolean');
  const structParent = opts.structParent;
  if (structParent !== undefined) {
    // Explicit rejection rather than implying `tagged`: an unused option must
    // never silently change output.
    if (!tagged) throw new TypeError('structParent requires tagged: true');
    if (structParent.Ref === undefined)
      throw new TypeError('structParent must be a structure element with an indirect ref');
    const root = doc.GetStructTree();
    if (!root || structParent.Root.Dict !== root.Dict)
      throw new TypeError('structParent belongs to a different document');
  }
```

and extend the returned object:

```ts
  return {
    rows, numberLeft, rowRight, rowGap, leader, leaderGap, links, view, autoPaginate,
    tagged, structParent,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tocstruct.test.ts test/toc.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/toc.ts test/tocstruct.test.ts
git commit -m "feat(toc): tagged/structParent options with up-front validation (1gg0.5)"
```

---

### Task 4: Wire the tagger into painting

Where structure meets ink: the tagger is built on the first painted row, the title and label stamps carry `tag`, the leader carries `artifact`, and the link annotation becomes an OBJR.

**Files:**
- Modify: `src/tocrender.ts` (`AddTOCResult` ~line 19, `paintRow` ~line 34, `drawTOC` ~line 77)
- Test: `test/tocstruct.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `TocTagger` (Task 2); `TOCLayout.tagged` / `TOCLayout.structParent` (Task 3); `StampOptions.artifact` (Task 1); `addLink(doc, page, opts): LinkAnnotation` from `src/annotation.ts`; `rowStampOptions(style, opts, align): StampOptions` from `src/toc.ts`.
- Produces: `AddTOCResult.struct?: StructElement` — the `/TOC` element, `undefined` when untagged or when nothing was drawn.

- [ ] **Step 1: Write the failing test**

Append to `test/tocstruct.test.ts`:

```ts
describe('page.AddTOC — tagged output', () => {
  const RECT: [number, number, number, number] = [72, 400, 400, 300];

  it('adds no structure by default', () => {
    const doc = docWith(3);
    const r = doc.Pages[0].AddTOC([{ title: 'One', page: 2 }], RECT);
    expect(r.struct).toBeUndefined();
    expect(doc.GetStructTree()).toBeNull();
    expect(doc.IsTagged).toBe(false);
    const content = new TextDecoder('latin1').decode(doc.Pages[0].Contents);
    expect(content).not.toContain('BDC');
    expect(content).not.toContain('BMC');
  });

  it('emits one TOCI per entry with the row text under its /Link', () => {
    const doc = docWith(4);
    const r = doc.Pages[0].AddTOC(
      [{ title: 'Alpha', page: 2 }, { title: 'Beta', page: 3 }], RECT, { tagged: true });
    expect(r.struct!.Type).toBe('TOC');
    expect(doc.IsTagged).toBe(true);
    const tocis = r.struct!.Children;
    expect(tocis.map((c) => c.Type)).toEqual(['TOCI', 'TOCI']);
    const link = tocis[0].Children[0].Children[0];
    expect(link.Type).toBe('Link');
    // GetText joins each marked-content run with '\n': title line, then label.
    expect(link.GetText()).toBe('Alpha\n2');
    expect(tocis[1].Children[0].Children[0].GetText()).toBe('Beta\n3');
  });

  it('puts every line of a wrapped title under the same /Link', () => {
    const doc = docWith(3);
    const title = 'A rather long chapter title that will not fit on one line at all';
    const r = doc.Pages[0].AddTOC([{ title, page: 2 }], [72, 400, 200, 300], { tagged: true });
    const link = r.struct!.Children[0].Children[0].Children[0];
    const text = link.GetText();
    expect(text.split('\n').length).toBeGreaterThan(2);       // >1 title line + label
    expect(text.split('\n').join(' ')).toContain('A rather long');
    expect(text.endsWith('\n2')).toBe(true);
    expect(r.struct!.Children).toHaveLength(1);               // still one entry
  });

  it('marks the dot leader as an artifact, outside the structure', () => {
    const doc = docWith(3);
    const r = doc.Pages[0].AddTOC([{ title: 'Alpha', page: 2 }], RECT, { tagged: true });
    const dots = doc.Pages[0].GetTextFragments().filter((f) => f.text.includes('..'));
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.every((f) => f.artifact)).toBe(true);
    expect(r.struct!.GetText()).not.toContain('..');
  });

  it('attaches the link annotation as an OBJR under the /Link', () => {
    const doc = docWith(3);
    const r = doc.Pages[0].AddTOC([{ title: 'Alpha', page: 2 }], RECT, { tagged: true });
    const link = r.struct!.Children[0].Children[0].Children[0];
    const kids = doc.resolve(link.Dict.get('K')) as any[];
    const objr = kids.map((k) => doc.resolve(k))
      .find((k: any) => k instanceof Map && (doc.resolve(k.get('Type')) as any)?.name === 'OBJR');
    expect(objr).toBeDefined();
    const annot = doc.Pages[0].Annotations[0];
    expect(doc.resolve(objr.get('Obj'))).toBe(annot.Dict);
    expect(doc.resolve(annot.Dict.get('StructParent'))).toEqual(expect.any(Number));
  });

  it('drops the /Link when links are off', () => {
    const doc = docWith(3);
    const r = doc.Pages[0].AddTOC(
      [{ title: 'Alpha', page: 2 }], RECT, { tagged: true, links: false });
    const reference = r.struct!.Children[0].Children[0];
    expect(reference.Type).toBe('Reference');
    expect(reference.Children).toEqual([]);
    expect(reference.GetText()).toBe('Alpha\n2');
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });

  it('nests a level-2 row under the previous entry', () => {
    const doc = docWith(4);
    const r = doc.Pages[0].AddTOC(
      [{ title: 'Alpha', page: 2 }, { title: 'Alpha.1', page: 3, level: 2 }],
      RECT, { tagged: true });
    const alpha = r.struct!.Children[0];
    expect(alpha.Children.map((c) => c.Type)).toEqual(['Reference', 'TOC']);
    expect(alpha.Children[1].Children[0].GetText()).toBe('Alpha.1\n3');
  });

  it('creates no structure when nothing is drawn', () => {
    const doc = docWith(2);
    const r = doc.Pages[0].AddTOC([], RECT, { tagged: true });
    expect(r.struct).toBeUndefined();
    expect(doc.GetStructTree()).toBeNull();
  });

  it('round-trips through Save', () => {
    const doc = docWith(3);
    doc.Pages[0].AddTOC([{ title: 'Alpha', page: 2 }], RECT, { tagged: true });
    const re = Document.Open(doc.Save());
    const toc = re.GetStructTree()!.Children[0];
    expect(toc.Type).toBe('TOC');
    expect(toc.Children[0].Children[0].Children[0].GetText()).toBe('Alpha\n2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tocstruct.test.ts -t "tagged output"`
Expected: FAIL — `r.struct` is `undefined` for every tagged call (the option is validated but never acted on).

- [ ] **Step 3: Write minimal implementation**

In `src/tocrender.ts`, extend the imports:

```ts
import type { StructElement } from './struct.js';
import { TocTagger } from './tocstruct.js';
```

Add to `AddTOCResult`:

```ts
  /** The /TOC element, when `tagged` and at least one row was drawn. Pass it
   *  back as `structParent` on a continuation call so a paginated TOC stays a
   *  single /TOC. */
  struct?: StructElement;
```

Change `paintRow`'s signature to take the tagger and use it:

```ts
function paintRow(
  doc: Document, page: Page, row: MeasuredRow, L: TOCLayout, opts: TOCOptions, rowTop: number,
  tagger: TocTagger | undefined,
): void {
  const { style } = row;
  // Open this row's TOCI > Reference > Link before any of its stamps, so the
  // MCIDs land under it in draw order: title lines, then the label.
  const content = tagger?.beginRow(row.entry.level ?? 1);
  const tag = content ? { tag: content } : {};
  const left = { ...rowStampOptions(style, opts, 'left'), ...tag };
  const right = { ...rowStampOptions(style, opts, 'right'), ...tag };
```

Leave the title loop as it is (it already uses `left`). In the leader branch,
replace the `stampText` call with an artifact-marked one:

```ts
    if (count > 0)
      stampText(doc, page, '.'.repeat(count), L.numberLeft - L.leaderGap, lastBaseline,
        // Decoration, not content: in a tagged page it must be an artifact, or a
        // screen reader reads a run of dots aloud.
        tagger ? { ...rowStampOptions(style, opts, 'right'), artifact: true } : right);
```

Keep the label stamp on `right` (tagged). Finally, in the link branch:

```ts
  if (L.links) {
    const link = addLink(doc, page, {
      rect: [row.titleLeft, rowTop - row.height, L.rowRight, rowTop],
      action: { type: 'goto', page: row.entry.page, view: L.view },
      border: 0,
    });
    tagger?.finishRow(link);
  }
```

In `drawTOC`, declare the tagger and build it lazily:

```ts
  let tagger: TocTagger | undefined;
```

right before the row loop, then immediately before the `paintRow` call:

```ts
    // Built on the first PAINTED row, so a tagged call that draws nothing
    // bootstraps no structure tree and leaves the document untouched.
    if (L.tagged && tagger === undefined)
      tagger = new TocTagger(doc, { links: L.links, structParent: L.structParent });
    paintRow(doc, current, row, L, opts, rowTop, tagger);
```

and add `struct: tagger?.toc` to **both** `return` statements that follow the
early `if (L.rows.length === 0)` guard — the manual-mode remainder return and
the final one:

```ts
      if (!L.autoPaginate)
        return {
          pages, drawn, endY: rowTop + L.rowGap, remainder: entries.slice(i),
          struct: tagger?.toc,
        };
```

```ts
  return { pages, drawn, endY: rowTop + L.rowGap, struct: tagger?.toc };
```

The `L.rows.length === 0` early return keeps `struct` absent, which is correct.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tocstruct.test.ts test/toc.test.ts test/toc-decoration.test.ts`
Expected: PASS — including the untagged geometry tests in `toc.test.ts`, which prove the drawn bytes did not move.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/tocrender.ts test/tocstruct.test.ts
git commit -m "feat(toc): emit /TOC + /TOCI structure from AddTOC (1gg0.5)"
```

---

### Task 5: Pagination, atomicity, validator coverage, docs

The cases that only appear across calls and pages, plus the mutation check the repo's testing rules require and the README update.

**Files:**
- Test: `test/tocstruct.test.ts` (append two `describe`s)
- Modify: `README.md` (the `AddTOC` entry in the authoring section)

**Interfaces:**
- Consumes: everything from Tasks 1–4. No new production code unless a test exposes a defect.

- [ ] **Step 1: Write the failing test**

Append to `test/tocstruct.test.ts`:

```ts
describe('AddTOC tagging — pagination and atomicity', () => {
  const RECT: [number, number, number, number] = [72, 400, 400, 300];
  const SHORT: [number, number, number, number] = [72, 600, 400, 40];

  it('keeps one /TOC across a manual pagination loop', () => {
    const doc = docWith(12);
    const entries = Array.from({ length: 8 }, (_, i) => ({ title: `Row ${i}`, page: i + 2 }));
    let r = doc.Pages[0].AddTOC(entries, SHORT, { tagged: true });
    expect(r.remainder?.length).toBeGreaterThan(0);
    let guard = 0;
    while (r.remainder?.length) {
      if (++guard > 20) throw new Error('pagination did not advance');
      r = doc.AddPage().page.AddTOC(r.remainder, SHORT,
        { tagged: true, structParent: r.struct });
    }
    const tops = doc.GetStructTree()!.Children;
    expect(tops.map((c) => c.Type)).toEqual(['TOC']);
    expect(tops[0].Children).toHaveLength(8);
  });

  it('spans pages with MCR content refs under autoPaginate', () => {
    const doc = docWith(12);
    const entries = Array.from({ length: 8 }, (_, i) => ({ title: `Row ${i}`, page: i + 2 }));
    const r = doc.Pages[0].AddTOC(entries, SHORT, { tagged: true, autoPaginate: true });
    expect(r.pages.length).toBeGreaterThan(1);
    expect(r.struct!.Children).toHaveLength(8);
    // Every page drawn onto gets its own /StructParents key.
    const keys = r.pages.map((p) => doc.resolve(p.Dict.get('StructParents')));
    expect(new Set(keys).size).toBe(r.pages.length);
    // A row on page 2 reads back its text, which only works if the MCR carries
    // the right /Pg.
    const last = r.struct!.Children[7].Children[0].Children[0];
    expect(last.GetText()).toBe('Row 7\n9');
  });

  it('leaves the document byte-identical when a tagged call throws', () => {
    const doc = docWith(3);
    doc.Pages[0].AddText('existing', 72, 720);
    const before = doc.Save();
    const foreign = docWith(2).CreateStructTree().Append('Sect');
    expect(() => doc.Pages[0].AddTOC([{ title: 'Alpha', page: 2 }], RECT,
      { tagged: true, structParent: foreign })).toThrow(TypeError);
    expect(() => doc.Pages[0].AddTOC([{ title: 'Alpha', page: 99 }], RECT,
      { tagged: true })).toThrow(RangeError);
    // Same idiom as the existing "TOC atomicity" suite in test/toc.test.ts.
    expect(doc.Save()).toEqual(before);
    expect(doc.GetStructTree()).toBeNull();
  });
});

describe('AddTOC tagging — PDF/UA', () => {
  it('reports no structure-type issues for a tagged TOC', () => {
    const doc = docWith(4);
    doc.Lang = 'en-US';
    doc.SetMetadata({ title: 'Tagged TOC' });
    doc.Pages[0].AddTOC(
      [{ title: 'Alpha', page: 2 }, { title: 'Alpha.1', page: 3, level: 2 }],
      [72, 400, 400, 300], { tagged: true });
    const report = doc.ValidatePdfUa();
    const rules = report.Issues.map((i) => i.rule);
    expect(rules).not.toContain('StandardType');
    expect(rules).not.toContain('NaturalLanguage');
  });
});
```

`ValidationReport.Issues` is the public array (`src/validation.ts:27`); `Errors`
and `Warnings` are severity-filtered views of it. Do not change the validator to
fit the test.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/tocstruct.test.ts`
Expected: these may pass on the first run — Tasks 1–4 were written against the
same spec. **That is not evidence.** Proceed to Step 3.

- [ ] **Step 3: Prove the new assertions are load-bearing (mutation check)**

The repo's testing rule: a test that has never been seen to fail has not been
shown to test anything. Break each mechanism, confirm red, restore:

1. In `src/tocrender.ts`, drop `artifact: true` from the leader stamp.
   Run `npx vitest run test/tocstruct.test.ts` → the artifact test must FAIL.
   Restore.
2. In `src/tocrender.ts`, remove `tagger?.finishRow(link);`.
   Run → the OBJR test must FAIL. Restore.
3. In `src/tocstruct.ts` `beginRow`, replace the clamp with `const d = level;`.
   Run → the "clamps a first row that starts deep" test must FAIL (an
   out-of-range `stack[d - 1]`). Restore.
4. In `src/tocstruct.ts`, drop the `parent.Type === 'TOC'` reuse branch so a
   `/TOC` parent nests instead.
   Run → the manual-pagination test must FAIL. Restore.

Record the four results in the commit message.

- [ ] **Step 4: Update the README and run the full suite**

`README.md` mentions `AddTOC` in three places. Update two of them.

1. In the **"Table of contents"** section (~line 420), append a paragraph after
   the one that ends "…leaves the document byte-identical.":

```markdown
Pass `{ tagged: true }` to emit logical structure alongside the drawing: one
`/TOC` element with a `/TOCI` per entry (`TOCI > Reference > Link`, holding the
title and page-label marked content plus the link annotation as an OBJR),
`level` mapped onto nested `/TOC` elements, and the dot leader marked as an
`/Artifact` so a screen reader does not read it aloud. `structParent` places the
`/TOC` under an existing element; `result.struct` is that `/TOC`, and passing it
back as the next call's `structParent` keeps a manually paginated TOC a single
table of contents.
```

   Also add `tagged`, `structParent` to that section's "Options:" list, after
   `autoPaginate`.

2. In the API table (~line 1368), append to the `page.AddTOC` cell's
   description: `; \`{ tagged: true }\` also emits /TOC + /TOCI logical
   structure`.

Leave the feature bullet near line 21 alone — it is a one-line summary.

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: the full suite green.

- [ ] **Step 5: Commit**

```bash
git add test/tocstruct.test.ts README.md
git commit -m "test(toc): pagination, atomicity and PDF/UA coverage for TOC tagging (1gg0.5)

Mutation-checked: dropping the leader artifact, the finishRow OBJR, the level
clamp, and the /TOC reuse branch each turn the suite red."
```

- [ ] **Step 6: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-1gg0.5
```

Then follow the session-close protocol in `CLAUDE.md`: file follow-ups for
anything left (the spec's documented limitation — nesting depth not carried
across a continuation call — is a candidate), `git pull --rebase`, `git push`,
and confirm `git status` shows the branch up to date with origin.
