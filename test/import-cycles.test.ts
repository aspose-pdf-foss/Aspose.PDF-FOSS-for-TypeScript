import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

// The import graph of src/, and the value-import 2-cycles in it.
//
// This replaces the shell one-liner CLAUDE.md used to carry, which was wrong
// in THREE independent ways and had been trusted for it (k738):
//
//   1. it matched `from "./x.js"` with DOUBLE quotes while every import in
//      src/ uses single ones, so it parsed ZERO edges and could not report a
//      cycle on any tree whatever — a permanent false NEGATIVE, the inverse of
//      the module-doc sweep's permanent false positives (67mt). A session that
//      ran it reported "no cycles" and was believed;
//   2. its `[a-z0-9]+` name class dropped ccitt-tables.ts, object-parser.ts
//      and unicode-data.ts as targets, so "a sweep over every module in src/"
//      was not one;
//   3. its `[\s\S]*?` crossed STATEMENT boundaries, so a `node:` import could
//      anchor `^import` and reach the NEXT statement's `from` clause. That
//      turned type-only imports into phantom value edges — which is why the
//      issue's own count of 18 was three too high: document.ts's three
//      partners each import `type { Document }` and nothing else.
//
// So the check is a test rather than prose, and it asks the TypeScript
// compiler rather than a fourth regex — a hand-rolled pattern is exactly what
// was wrong here, and `import { type X }` (the inline modifier, erased like
// `import type`) is one more spelling a regex gets wrong. Measured: over src/
// as it stands the two agree on every cycle and on all but one edge, that one
// being pdfaconvert.ts's `import { type ValidationIssue }`.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** The `./x.js` specifiers `text` imports for their VALUES, as `x.ts` names. */
export function valueImports(fileName: string, text: string): Set<string> {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true);
  const out = new Set<string>();
  for (const st of sf.statements) {
    const imp = ts.isImportDeclaration(st);
    const exp = ts.isExportDeclaration(st);
    if (!imp && !exp) continue;
    const spec = st.moduleSpecifier;
    if (!spec || !ts.isStringLiteral(spec)) continue;
    if (!spec.text.startsWith('./') || !spec.text.endsWith('.js')) continue;

    // `import type {…}` / `export type {…}` are erased and close no cycle.
    const clause = imp ? st.importClause : st;
    if (clause?.isTypeOnly) continue;

    // Nor does a named list every one of whose specifiers carries the INLINE
    // `type` modifier. A default binding beside them is still a value.
    const named = imp ? st.importClause?.namedBindings : st.exportClause;
    if (named && (ts.isNamedImports(named) || ts.isNamedExports(named))) {
      const anyValue = named.elements.some((e) => !e.isTypeOnly);
      const hasDefault = imp && st.importClause?.name !== undefined;
      if (!anyValue && !hasDefault) continue;
    }
    // Everything else reaches the module at runtime: a namespace import, a
    // default, a bare side-effect import, and `export * from`.
    out.add(spec.text.slice(2, -3) + '.ts');
  }
  return out;
}

function graph(): Map<string, Set<string>> {
  const g = new Map<string, Set<string>>();
  for (const f of readdirSync(SRC).filter((x) => x.endsWith('.ts'))) {
    g.set(f, valueImports(f, readFileSync(join(SRC, f), 'utf8')));
  }
  return g;
}

/** Every unordered pair that imports the other's values, as `a <-> b`. */
function twoCycles(g = graph()): string[] {
  const out: string[] = [];
  for (const [a, targets] of g) {
    for (const b of targets) if (a < b && g.get(b)?.has(a)) out.push(`${a} <-> ${b}`);
  }
  return out.sort();
}

// Every one of these is the same shape: a facade owning the primitive that the
// modules it delegates to build back — jbig2.ts's `newBitmap`/`combine`,
// jpeg.ts's `ZIGZAG`/`forEachBlockInScan`, jpx.ts's `Codestream`,
// svgfilterfx.ts's `makeSurface`, html.ts's `escapeHtml`, flow.ts's element
// builders, page.ts's `Page` class. They are recorded rather than endorsed:
// CLAUDE.md documents the opposite extraction for colornames.ts, preformat.ts,
// bordersides.ts, datauri.ts and resprune.ts, and that rule still governs any
// edge added from here on.
const KNOWN = [
  'cms.ts <-> rfc3161.ts',
  'flow.ts <-> mdflow.ts',
  'html.ts <-> htmlfixed.ts',
  'html.ts <-> htmlsemantic.ts',
  'jbig2.ts <-> jbig2generic.ts',
  'jbig2.ts <-> jbig2halftone.ts',
  'jbig2.ts <-> jbig2refine.ts',
  'jbig2.ts <-> jbig2symbol.ts',
  'jbig2.ts <-> jbig2text.ts',
  'jpeg.ts <-> jpegarith.ts',
  'jpeg.ts <-> jpeghier.ts',
  'jpeg.ts <-> jpeglossless.ts',
  'jpx.ts <-> jpxt2.ts',
  'page.ts <-> raster.ts',
  'svgfilterfx.ts <-> svgfilterlight.ts',
].sort();

describe('the import graph of src/', () => {
  // The whole point of the baseline: a 16th pair means the edge you just added
  // closed a cycle, and a missing one means an extraction landed and this list
  // should shrink. Either way it is a red build rather than a discovery years
  // later — which is what the prose one-liner could never be.
  it('holds exactly the known value-import 2-cycles', () => {
    expect(twoCycles()).toEqual(KNOWN);
  });

  // k738's own failure mode, asserted directly. A parse that matches nothing
  // reports a perfectly clean tree, so the count above is only evidence if the
  // graph is non-degenerate first. The floor is far below the ~1,260 measured
  // on 2026-09-10, so ordinary growth never touches it.
  it('parses a graph rather than reporting a clean tree by matching nothing', () => {
    const g = graph();
    let edges = 0;
    for (const targets of g.values()) edges += targets.size;
    expect(g.size).toBeGreaterThan(300);
    expect(edges).toBeGreaterThan(1000);
  });

  // Defect 3, pinned on a synthetic source so it cannot drift when the real
  // files move. The `node:` import ahead of the type-only one is the shape
  // that manufactured the phantom document.ts cycles.
  //
  // Measured, and this case is NOT redundant with the baseline above: of the
  // five mutations run against this file, only dropping the `isTypeOnly` skip
  // reddens the real tree as well (2 cases), and parsing nothing reddens all
  // three. Dropping the INLINE-`type` check and ignoring `export … from` each
  // redden THIS CASE ALONE — pdfaconvert.ts's `import { type ValidationIssue }`
  // closes no cycle, and the 64 re-export edges close none either, so the real
  // tree provably cannot see either rule. Do not read the baseline as covering
  // them, and do not delete this case as duplicative.
  it('counts an erased import as no edge, in all three spellings', () => {
    const src = [
      "import { createHash } from 'node:crypto';",
      "import type { Document } from './document.js';",
      "import { type PdfStream } from './types.js';",
      "export type { Page } from './page.js';",
      "import { isArray, type PdfDict } from './mixed.js';",
      "import * as ns from './ns.js';",
      "export * from './star.js';",
    ].join('\n');
    expect([...valueImports('probe.ts', src)].sort()).toEqual(
      ['mixed.ts', 'ns.ts', 'star.ts'],
    );
  });
});
