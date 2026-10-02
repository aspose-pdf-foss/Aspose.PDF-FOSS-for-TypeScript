/**
 * Text comparison of two documents (`aq4a.2`): `Document.CompareText`.
 *
 * Each page is laid out by the SAME pipeline `Search` uses — glyphs filtered
 * by region, `layoutLines`, a glyph reference per character — so a change is
 * placed on the page by `buildMatch`, the function that places a search hit.
 * A changed word and the same word found by `Search` therefore have identical
 * quads, which the suite asserts. The diff itself is `textdiff.ts`'s.
 *
 * Imports `Document` as a TYPE only; `document.ts` imports this module.
 */
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { GlyphEvent, Rect, RefRun } from './text.js';
import { visitContent, layoutLines, runFromGlyph, walkOpts } from './text.js';
import { buildMatch, centroidIn } from './textedit.js';
import { diffSequences, diffStats, type DiffStats, type DiffRun } from './textdiff.js';

export interface CompareTextOptions {
  /** `'document'` (the default) reads each document as one text, so text that
   *  moves across a page break is no change. `'pages'` compares page 1 with
   *  page 1, page 2 with page 2 and so on, reporting a page only one document
   *  has as wholly inserted or deleted. */
  mode?: 'document' | 'pages';
  /** `'word'` (the default) compares whitespace-separated words;
   *  `'character'` compares character by character. */
  granularity?: 'word' | 'character';
  /** Character granularity only. `'collapse'` (the default) treats any run of
   *  whitespace — a line break, a page break — as one space, so reflowed text
   *  is no change; `'ignore'` drops whitespace entirely, so `data base` and
   *  `database` compare equal. Word granularity has no whitespace to choose
   *  about, and refuses the option rather than ignoring it. */
  whitespace?: 'collapse' | 'ignore';
  /** Compare letters case-insensitively. Changes still report each side's own
   *  text. */
  ignoreCase?: boolean;
  /** Compare only text inside this page-space rectangle, on every page of both
   *  documents. A glyph is in by its quad's centroid — `SearchOptions.region`'s
   *  rule. */
  region?: Rect;
  /** Skip text inside any of these page-space rectangles, by the same rule. */
  exclude?: Rect[];
  /** Also compare text the default optional-content configuration hides.
   *  Default false: a comparison is of what the pages show. */
  includeHidden?: boolean;
  /** Inside one change, report the deletion first (the default) or the
   *  insertion first. */
  order?: 'delete-first' | 'insert-first';
  /** `'semantic'` (the default) folds a short stretch two rewritten passages
   *  happen to share — a lone `of` between a deleted sentence and an inserted
   *  paragraph — into one change, so a rewrite reads as one deletion and one
   *  insertion. `'none'` reports the smallest diff, which splits such a
   *  rewrite around every word it has in common with its replacement. */
  cleanup?: 'semantic' | 'none';
  /** Search budget per comparison, in diagonal steps. Past it a stretch is
   *  reported as one whole deletion plus one whole insertion and `minimal` is
   *  false. Default 50,000,000. */
  maxCost?: number;
}

/** Where a change lies in one document: the text it covers on one page and a
 *  page-space box per line, as `Search` would report the same text. */
export interface TextSpan {
  /** 1-based page number. */
  page: number;
  text: string;
  quads: Rect[];
}

export interface TextChange {
  op: 'equal' | 'delete' | 'insert';
  /** The text on the first document's side (empty for an insertion). Words
   *  are joined by single spaces; characters are joined as they are. */
  oldText: string;
  /** The text on the second document's side (empty for a deletion). */
  newText: string;
  /** Where `oldText` lies, one span per page it touches. */
  old: TextSpan[];
  /** Where `newText` lies. */
  new: TextSpan[];
}

export interface TextComparisonStats extends DiffStats {
  /** Words (or characters) compared in each document. */
  oldTokens: number;
  newTokens: number;
  /** 2 × equal / (oldTokens + newTokens): 1 for identical text, 0 for nothing
   *  in common. 1 when both are empty. */
  similarity: number;
}

export interface PageTextComparison {
  /** 1-based page in the first document; undefined when only the second
   *  document has this page. */
  oldPage?: number;
  newPage?: number;
  changes: TextChange[];
  stats: TextComparisonStats;
  minimal: boolean;
}

export interface TextComparison {
  /** What a token was, which also says how runs join: words with a space,
   *  characters with nothing (whitespace there is its own token). */
  granularity: 'word' | 'character';
  /** Every run in reading order, equal ones included. In `'pages'` mode the
   *  pages' changes one after another. */
  changes: TextChange[];
  stats: TextComparisonStats;
  /** False when the search budget cut a comparison short. True means the
   *  search finished; `cleanup: 'semantic'` may then still report more than
   *  the fewest words, deliberately. */
  minimal: boolean;
  /** One entry per page pair, in `'pages'` mode only. */
  pages?: PageTextComparison[];
}

/** One page's text and the glyph behind each character. */
interface PageText { page: number; text: string; refs: (GlyphEvent | undefined)[] }
/** A word or character: a [start, end) range of one page's text. A page break
 *  in character-collapse mode is a token with an EMPTY range. */
interface Tok { page: number; start: number; end: number; text: string }

type Resolved = Required<Pick<CompareTextOptions, 'mode' | 'granularity' | 'whitespace' | 'order' | 'ignoreCase' | 'includeHidden' | 'cleanup'>>
  & Pick<CompareTextOptions, 'region' | 'exclude' | 'maxCost'>;

/** Compare the text of `a` against `b`. */
export function compareText(a: Document, b: Document, options: CompareTextOptions = {}): TextComparison {
  if (!b || typeof b !== 'object' || !Array.isArray((b as Document).Pages)) {
    throw new TypeError('CompareText: other must be a Document');
  }
  const o = resolve(options);
  const key = (t: Tok): string => {
    const s = t.text.normalize('NFC');
    return o.ignoreCase ? s.toLowerCase() : s;
  };

  if (o.mode === 'document') {
    const ta = documentTokens(a, o), tb = documentTokens(b, o);
    return { granularity: o.granularity, ...finish(ta.tokens, tb.tokens, ta.pages, tb.pages, key, o) };
  }

  const pages: PageTextComparison[] = [];
  const n = Math.max(a.Pages.length, b.Pages.length);
  for (let i = 0; i < n; i++) {
    const pa = a.Pages[i], pb = b.Pages[i];
    const ta = pa ? pageTokens(a, pa, i + 1, o) : { tokens: [], pages: new Map<number, PageText>() };
    const tb = pb ? pageTokens(b, pb, i + 1, o) : { tokens: [], pages: new Map<number, PageText>() };
    pages.push({ oldPage: pa ? i + 1 : undefined, newPage: pb ? i + 1 : undefined, ...finish(ta.tokens, tb.tokens, ta.pages, tb.pages, key, o) });
  }
  const changes = pages.flatMap((p) => p.changes);
  const sum = (f: (s: TextComparisonStats) => number): number => pages.reduce((t, p) => t + f(p.stats), 0);
  const stats = withSimilarity({
    equal: sum((s) => s.equal), deleted: sum((s) => s.deleted), inserted: sum((s) => s.inserted),
    changes: sum((s) => s.changes), oldTokens: sum((s) => s.oldTokens), newTokens: sum((s) => s.newTokens),
  });
  return { granularity: o.granularity, changes, stats, minimal: pages.every((p) => p.minimal), pages };
}

function finish(
  ta: Tok[], tb: Tok[], pa: Map<number, PageText>, pb: Map<number, PageText>,
  key: (t: Tok) => string, o: Resolved,
): { changes: TextChange[]; stats: TextComparisonStats; minimal: boolean } {
  const { runs, minimal } = diffSequences(ta, tb, key, { order: o.order, maxCost: o.maxCost, cleanup: o.cleanup });
  const sep = o.granularity === 'word' ? ' ' : '';
  const changes = runs.map((r: DiffRun<Tok>): TextChange => ({
    op: r.op,
    oldText: r.old.map((t) => t.text).join(sep),
    newText: r.new.map((t) => t.text).join(sep),
    old: spans(r.old, pa),
    new: spans(r.new, pb),
  }));
  const s = diffStats(runs);
  return { changes, stats: withSimilarity({ ...s, oldTokens: ta.length, newTokens: tb.length }), minimal };
}

function withSimilarity(s: Omit<TextComparisonStats, 'similarity'>): TextComparisonStats {
  const total = s.oldTokens + s.newTokens;
  return { ...s, similarity: total === 0 ? 1 : (2 * s.equal) / total };
}

/** Group a run's tokens by page and place each group as `Search` places a
 *  match: `buildMatch` over the range from the first token to the last, which
 *  skips the separators layout inserted and yields one quad per line. */
function spans(toks: Tok[], pages: Map<number, PageText>): TextSpan[] {
  const out: TextSpan[] = [];
  let i = 0;
  while (i < toks.length) {
    const page = toks[i].page;
    let start = Infinity, end = -Infinity;
    for (; i < toks.length && toks[i].page === page; i++) {
      if (toks[i].start === toks[i].end) continue; // a page break holds no text
      start = Math.min(start, toks[i].start); end = Math.max(end, toks[i].end);
    }
    if (start >= end) continue;
    const pt = pages.get(page)!;
    const m = buildMatch(pt.text, pt.refs, start, end);
    out.push({ page, text: m.text, quads: m.quads });
  }
  return out;
}

function documentTokens(doc: Document, o: Resolved): { tokens: Tok[]; pages: Map<number, PageText> } {
  const tokens: Tok[] = [];
  const pages = new Map<number, PageText>();
  doc.Pages.forEach((page, i) => {
    const t = pageTokens(doc, page, i + 1, o);
    for (const [k, v] of t.pages) pages.set(k, v);
    if (t.tokens.length === 0) return;
    // In character-collapse mode a page break is whitespace, which a word or
    // an ignored-whitespace comparison has no token for.
    const last = tokens[tokens.length - 1];
    if (last && o.granularity === 'character' && o.whitespace === 'collapse' && last.text !== ' ' && t.tokens[0].text !== ' ') {
      const prev = pages.get(last.page)!;
      tokens.push({ page: last.page, start: prev.text.length, end: prev.text.length, text: ' ' });
    }
    for (const tok of t.tokens) tokens.push(tok);
  });
  return { tokens, pages };
}

function pageTokens(doc: Document, page: Page, num: number, o: Resolved): { tokens: Tok[]; pages: Map<number, PageText> } {
  const runs: RefRun<GlyphEvent>[] = [];
  visitContent(doc, page, {
    glyph: (e) => {
      if (!e.text) return;
      if (o.region && !centroidIn(o.region, e.quad)) return;
      if (o.exclude && o.exclude.some((r) => centroidIn(r, e.quad))) return;
      runs.push(runFromGlyph(e, e));
    },
  }, walkOpts({ includeHidden: o.includeHidden }));
  const { text, refs } = layoutLines(runs);
  const pt: PageText = { page: num, text, refs };
  const tokens: Tok[] = [];
  if (o.granularity === 'word') {
    for (const m of text.matchAll(/\S+/gu)) {
      tokens.push({ page: num, start: m.index, end: m.index + m[0].length, text: m[0] });
    }
  } else {
    for (const m of text.matchAll(/\s+|[^\s]/gsu)) {
      const ws = /\s/u.test(m[0]);
      if (ws && o.whitespace === 'ignore') continue;
      tokens.push({ page: num, start: m.index, end: m.index + m[0].length, text: ws ? ' ' : m[0] });
    }
  }
  return { tokens, pages: new Map([[num, pt]]) };
}

function resolve(o: CompareTextOptions): Resolved {
  const oneOf = <T extends string>(name: string, v: unknown, allowed: readonly T[], dflt: T): T => {
    if (v === undefined) return dflt;
    if (!allowed.includes(v as T)) throw new RangeError(`CompareText: ${name} must be one of ${allowed.join(', ')}`);
    return v as T;
  };
  const rect = (name: string, v: unknown): Rect => {
    if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new TypeError(`CompareText: ${name} must be [x0, y0, x1, y1] of finite numbers`);
    }
    return v as Rect;
  };
  const granularity = oneOf('granularity', o.granularity, ['word', 'character'] as const, 'word');
  if (granularity === 'word' && o.whitespace !== undefined) {
    throw new RangeError('CompareText: whitespace applies to character granularity only');
  }
  const whitespace = oneOf('whitespace', o.whitespace, ['collapse', 'ignore'] as const, 'collapse');
  if (o.exclude !== undefined && !Array.isArray(o.exclude)) throw new TypeError('CompareText: exclude must be an array of rectangles');
  if (o.maxCost !== undefined && !(Number.isInteger(o.maxCost) && o.maxCost > 0)) {
    throw new RangeError('CompareText: maxCost must be a positive integer');
  }
  return {
    mode: oneOf('mode', o.mode, ['document', 'pages'] as const, 'document'),
    granularity,
    whitespace,
    order: oneOf('order', o.order, ['delete-first', 'insert-first'] as const, 'delete-first'),
    cleanup: oneOf('cleanup', o.cleanup, ['semantic', 'none'] as const, 'semantic'),
    ignoreCase: o.ignoreCase === true,
    includeHidden: o.includeHidden === true,
    region: o.region === undefined ? undefined : rect('region', o.region),
    exclude: o.exclude?.map((r, i) => rect(`exclude[${i}]`, r)),
    maxCost: o.maxCost,
  };
}
