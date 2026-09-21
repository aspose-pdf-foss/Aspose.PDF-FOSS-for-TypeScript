import ts from 'typescript';
import { readFileSync } from 'node:fs';

/** Every name `src/index.ts` exports, split by whether it exists at RUNTIME.
 *
 *  Asked of the TypeScript compiler rather than read off the source with a
 *  regex: `index.ts` mixes `export { … } from`, `export type { … } from` and
 *  re-exports of re-exports, and `k738` records what a hand-rolled import
 *  regex cost this repo — a sweep that parsed zero edges and was believed.
 *  A symbol is a VALUE when its resolved declaration has one (a function, a
 *  class, a const, an enum), and a TYPE otherwise (an interface or alias). */
export function publicExports(): { types: string[]; values: string[] } {
  const program = ts.createProgram(['src/index.ts'], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile('src/index.ts');
  if (sf === undefined) throw new Error('src/index.ts not found');
  const mod = checker.getSymbolAtLocation(sf);
  if (mod === undefined) throw new Error('src/index.ts is not a module');
  const types: string[] = [];
  const values: string[] = [];
  for (const s of checker.getExportsOfModule(mod)) {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    (target.flags & ts.SymbolFlags.Value ? values : types).push(s.name);
  }
  return { types: types.sort(), values: values.sort() };
}

/** The `## API Reference` section of README.md, up to the next `## `. */
export function readmeApiSection(): string {
  const readme = readFileSync('README.md', 'utf8');
  const start = readme.indexOf('\n## API Reference\n');
  if (start < 0) throw new Error('README has no ## API Reference');
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end < 0 ? undefined : end);
}

/** Every table row's FIRST cell, the cell that names what the row documents.
 *  Split on a `|` that is not escaped, so a row that spells a union as
 *  `` `a` \| `b` `` stays one cell. */
export function readmeFirstCells(api: string): string[] {
  const cells: string[] = [];
  for (const line of api.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const m = /^\|((?:\\\||[^|])*)\|/.exec(line);
    if (m !== null) cells.push(m[1].trim());
  }
  return cells;
}

/** The names a row documents: each backticked identifier its first cell OPENS
 *  with — `` `Name` ``, the call form `` `name(args)` `` and the generic
 *  `` `Name<T>` `` — so a combined row (`` `isMdBlock(n)` / `isMdInline(n)` ``)
 *  documents both. A member path such as `` `doc.PageMode` `` names a member,
 *  not the exported TYPE `PageMode`, and does not count; nor does a name that
 *  appears only in prose or in a description cell. */
export function readmeRowNames(api: string): Set<string> {
  const names = new Set<string>();
  for (const cell of readmeFirstCells(api))
    for (const m of cell.matchAll(/`([A-Za-z_$][\w$]*)[`(<]/g)) names.add(m[1]);
  return names;
}

/** Every name README's code examples import from the package itself. */
export function readmeImportedNames(): string[] {
  const readme = readFileSync('README.md', 'utf8');
  const out: string[] = [];
  for (const m of readme.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'@asposefoss\/pdf'/g))
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
      if (name !== '') out.push(name);
    }
  return out;
}
