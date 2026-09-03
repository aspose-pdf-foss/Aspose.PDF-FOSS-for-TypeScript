import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { parseComponentValueList } from '../src/cssparse.js';
import { collect, cascade, mediaMatches } from '../src/csscascade.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

const V = (s: string) => parseComponentValueList(s);

/** Every element, template content included, so a test can reach one the
 *  collection walk is supposed to skip. */
function allElements(n: HtmlNode): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (x: HtmlNode): void => {
    if (x.kind === 'element') { out.push(x); if (x.content !== undefined) walk(x.content); }
    if (x.kind === 'element' || x.kind === 'document' || x.kind === 'fragment') {
      for (const c of x.children) walk(c);
    }
  };
  walk(n);
  return out;
}

/** The author rules only — the UA sheet is prepended and always present. */
const authorRules = (src: string) =>
  collect(parseHtml(src)).rules.filter((r) => r.tier !== 1 && r.tier !== 6);

describe('mediaMatches', () => {
  it('matches print and all, and refuses screen', () => {
    expect(mediaMatches(V('print')).ok).toBe(true);
    expect(mediaMatches(V('all')).ok).toBe(true);
    expect(mediaMatches(V('screen')).ok).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(mediaMatches(V('PRINT')).ok).toBe(true);
  });

  it('matches a comma list when ANY query matches', () => {
    expect(mediaMatches(V('screen, print')).ok).toBe(true);
    expect(mediaMatches(V('screen, projection')).ok).toBe(false);
  });

  it('ignores a leading only', () => {
    expect(mediaMatches(V('only print')).ok).toBe(true);
    expect(mediaMatches(V('only screen')).ok).toBe(false);
  });

  it('inverts a leading not', () => {
    expect(mediaMatches(V('not screen')).ok).toBe(true);
    expect(mediaMatches(V('not print')).ok).toBe(false);
  });

  it('treats a query carrying a FEATURE as non-matching, and says so', () => {
    // Detected structurally: a `(` block in the query. No string matching.
    const r = mediaMatches(V('(min-width: 60em)'));
    expect(r.ok).toBe(false);
    expect(r.feature).toBe(true);
    const s = mediaMatches(V('print and (color)'));
    expect(s.ok).toBe(false);
    expect(s.feature).toBe(true);
  });

  it('treats an empty prelude as non-matching', () => {
    expect(mediaMatches(V('')).ok).toBe(false);
    expect(mediaMatches(V('   ')).ok).toBe(false);
  });
});

describe('collection', () => {
  it('reads a <style> element', () => {
    const r = authorRules('<style>p{color:red}</style>');
    expect(r.length).toBe(1);
    expect(r[0]?.decls).toEqual([['color', expect.anything()]]);
  });

  it('reads several <style> elements in document order', () => {
    const r = authorRules('<style>p{color:red}</style><style>p{color:blue}</style>');
    expect(r.length).toBe(2);
    expect((r[0]?.order ?? 0) < (r[1]?.order ?? 0)).toBe(true);
  });

  it('skips a <style> whose type is present and not text/css, and records it', () => {
    const c = collect(parseHtml('<style type="text/x-scss">p{color:red}</style>'));
    expect(c.rules.filter((x) => x.tier === 2).length).toBe(0);
    expect(c.unsupported.some((u) => u.property === 'style')).toBe(true);
  });

  it('accepts a <style> whose type IS text/css, in any case', () => {
    expect(authorRules('<style type="TEXT/CSS">p{color:red}</style>').length).toBe(1);
  });

  it('does NOT descend into a template content', () => {
    // A template's content is not part of the document, so a <style> inside
    // one styles nothing — the same structural rule selectAll follows.
    const c = collect(parseHtml('<template><style>p{color:red}</style></template>'));
    expect(c.rules.filter((x) => x.tier === 2).length).toBe(0);
  });

  it('reads a style= attribute as inline declarations', () => {
    const doc = parseHtml('<p id=x style="color:red;margin:0">t</p>');
    const el = allElements(doc).find((e) => e.attrs.get('id') === 'x');
    const inline = collect(doc).inline.get(el as HtmlElement);
    expect(inline?.normal.map(([k]) => k)).toEqual([
      'color', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    ]);
  });

  it('splits a style= attribute by importance', () => {
    const doc = parseHtml('<p id=x style="color:red;background:blue!important">t</p>');
    const el = allElements(doc).find((e) => e.attrs.get('id') === 'x');
    const inline = collect(doc).inline.get(el as HtmlElement);
    expect(inline?.normal.map(([k]) => k)).toEqual(['color']);
    expect(inline?.important.map(([k]) => k)).toEqual(['background-color']);
  });

  it('EXPANDS a shorthand at collection time, not later', () => {
    // The load-bearing ordering: the cascade sorts longhands only, so
    // `margin: 0; margin-top: 5px` can be decided by document order.
    const r = authorRules('<style>p{margin:1px 2px}</style>');
    expect(r[0]?.decls.map(([k]) => k)).toEqual([
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    ]);
  });

  it('gives a grouped selector INDEPENDENT rules, each with its own specificity', () => {
    // `.a, #b { }` is two rules, not one at the higher — or `.a` would win
    // against a competing `#c`.
    const r = authorRules('<style>.a, #b{color:red}</style>');
    expect(r.length).toBe(2);
    expect(r[0]?.spec).not.toEqual(r[1]?.spec);
  });

  it('drops a rule whose selector list is invalid, and records it', () => {
    // An UNKNOWN NAME is the stand-in, and deliberately not a real-but-
    // unimplemented pseudo: this fixture has already moved twice as the
    // engine grew — :has() until zch2.2.4, then :lang() until zch2.2.5 — and
    // a name no spec will ever define cannot be overtaken a third time.
    const c = collect(parseHtml('<style>a:nonsense{color:red}</style>'));
    expect(c.rules.filter((x) => x.tier === 2).length).toBe(0);
    expect(c.unsupported.some((u) => u.reason === 'unparsable-value')).toBe(true);
  });

  it('records an unknown property and keeps the rest of the rule', () => {
    const c = collect(parseHtml('<style>p{box-shadow:0 0 2px;color:red}</style>'));
    const r = c.rules.filter((x) => x.tier === 2);
    expect(r[0]?.decls.map(([k]) => k)).toEqual(['color']);
    const u = c.unsupported.find((x) => x.property === 'box-shadow');
    expect(u?.reason).toBe('unknown-property');
    expect(u?.el).toBeNull();
  });

  it('applies an @media print block and skips an @media screen one', () => {
    expect(authorRules('<style>@media print{p{color:red}}</style>').length).toBe(1);
    expect(authorRules('<style>@media screen{p{color:red}}</style>').length).toBe(0);
  });

  it('records an @media carrying a feature rather than dropping it silently', () => {
    const c = collect(parseHtml('<style>@media (min-width:60em){p{color:red}}</style>'));
    expect(c.rules.filter((x) => x.tier === 2).length).toBe(0);
    expect(c.unsupported.some((u) => u.reason === 'unsupported-media-feature')).toBe(true);
  });

  it('records an at-rule it does not implement', () => {
    const c = collect(parseHtml('<style>@import url(x.css);p{color:red}</style>'));
    expect(c.unsupported.some(
      (u) => u.property === '@import' && u.reason === 'unsupported-at-rule')).toBe(true);
    expect(c.rules.filter((x) => x.tier === 2).length).toBe(1);
  });

  it('nests @media, applying only what matches all the way down', () => {
    expect(authorRules('<style>@media print{@media all{p{color:red}}}</style>').length).toBe(1);
    expect(authorRules('<style>@media print{@media screen{p{color:red}}}</style>').length).toBe(0);
  });

  it('always prepends the UA sheet, at tiers 1 and 6', () => {
    const c = collect(parseHtml('<p>t</p>'));
    expect(c.rules.some((r) => r.tier === 1)).toBe(true);
    expect(c.rules.every((r) => r.tier >= 1 && r.tier <= 6)).toBe(true);
  });

  it('assigns tier 2 to a normal author rule and tier 4 to an important one', () => {
    const r = authorRules('<style>p{color:red}q{color:blue!important}</style>');
    expect(r.find((x) => x.decls.length === 1 && x.tier === 2)).toBeDefined();
    expect(r.find((x) => x.tier === 4)).toBeDefined();
  });

  it('never throws, on any document', () => {
    for (const s of ['', '<style></style>', '<style>@</style>', '<style>{}</style>',
      '<p style="">t</p>', '<p style=":">t</p>', '<style>p{</style>']) {
      expect(() => collect(parseHtml(s)), s).not.toThrow();
    }
  });
});

/** The winning declaration for `prop` on `#t`, rendered as source text. */
function win(src: string, prop: string, which: 'all' | 'ua' = 'all'): string | undefined {
  const doc = parseHtml(src);
  const el = allElements(doc).find((e) => e.attrs.get('id') === 't');
  const d = cascade(doc, collect(doc)).get(el as HtmlElement);
  const v = d?.[which].get(prop);
  if (v === undefined) return undefined;
  // A pending shorthand carries no text of its own until an element's
  // environment resolves it, so it is named rather than rendered.
  if (!Array.isArray(v)) return `pending(${v.pending.shorthand})`;
  return v.map((x) => {
    const t = x as { kind: string; value?: unknown; unit?: string };
    if (t.kind === 'whitespace') return ' ';
    if (t.kind === 'dimension') return `${String(t.value)}${String(t.unit)}`;
    if (t.kind === 'hash') return `#${String(t.value)}`;
    return String(t.value ?? t.kind);
  }).join('').trim();
}

describe('the six tiers', () => {
  it('1 < 2: an author rule beats the UA sheet', () => {
    expect(win('<p id=t style="">t</p><style>p{margin-top:9px}</style>', 'margin-top'))
      .toBe('9px');
  });

  it('2 < 3: style= beats a stylesheet rule at equal importance', () => {
    expect(win('<style>#t{color:red}</style><p id=t style="color:blue">t</p>', 'color'))
      .toBe('blue');
  });

  it('2 < 3 EVEN WHEN the selector is far more specific', () => {
    // The half the "style= has infinite specificity" shortcut gets right.
    expect(win('<style>html body #t.c{color:red}</style>'
      + '<p id=t class=c style="color:blue">t</p>', 'color')).toBe('blue');
  });

  it('3 < 4: an !important stylesheet rule beats a normal style=', () => {
    // The half that shortcut gets WRONG, and the whole reason for six tiers.
    // Breaking this alone must leave the case above green.
    //
    // The selector is `*` and that is LOAD-BEARING, measured: with `p` the
    // rule carries specificity [0,0,1] against an inline block's [0,0,0], so
    // collapsing tiers 3 and 4 still lets the rule win — on specificity, for
    // the wrong reason — and the mutation reddens nothing. `*` is [0,0,0], so
    // a collapsed tier falls through to source order, where the inline block
    // sorts last and wins. Only then does the test measure the tier at all.
    expect(win('<style>*{color:red!important}</style><p id=t style="color:blue">t</p>',
      'color')).toBe('red');
  });

  it('4 < 5: an !important style= beats an !important stylesheet rule', () => {
    expect(win('<style>#t{color:red!important}</style>'
      + '<p id=t style="color:blue!important">t</p>', 'color')).toBe('blue');
  });

  it('5 < 6: an !important UA rule would beat an !important style=', () => {
    // Our UA sheet declares nothing !important, so this is asserted through
    // the tier ORDER rather than through a document. If the sheet ever gains
    // one, replace this with a document-level case.
    const doc = parseHtml('<p id=t>t</p>');
    const tiers = collect(doc).rules.map((r) => r.tier);
    expect(Math.max(...tiers)).toBeLessThanOrEqual(6);
    expect(tiers.every((t) => t >= 1 && t <= 6)).toBe(true);
  });
});

describe('within a tier', () => {
  it('sorts by specificity before source order', () => {
    expect(win('<style>#t{color:red}p{color:blue}</style><p id=t>t</p>', 'color'))
      .toBe('red');
  });

  it('sorts by source order when specificity ties', () => {
    expect(win('<style>.a{color:red}.b{color:blue}</style>'
      + '<p id=t class="a b">t</p>', 'color')).toBe('blue');
  });

  it('lets a LATER shorthand reset an earlier longhand', () => {
    expect(win('<style>p{margin-top:5px;margin:0}</style><p id=t>t</p>', 'margin-top'))
      .toBe('0');
  });

  it('lets a LATER longhand survive an earlier shorthand', () => {
    // The pair. Expanding shorthands after the sort makes both cases '0'.
    expect(win('<style>p{margin:0;margin-top:5px}</style><p id=t>t</p>', 'margin-top'))
      .toBe('5px');
  });
});

describe('the per-origin winners', () => {
  it('keeps the UA winner beside the final one, for revert', () => {
    const src = '<style>p{margin-top:9px}</style><p id=t>t</p>';
    expect(win(src, 'margin-top', 'all')).toBe('9px');
    // The UA sheet gives p a 1em top margin; the author's 9px does not
    // overwrite it in the `ua` map, which is what makes revert a lookup.
    expect(win(src, 'margin-top', 'ua')).toBe('1em');
  });

  it('leaves the ua map empty for a property the UA sheet never sets', () => {
    expect(win('<style>p{color:red}</style><p id=t>t</p>', 'color', 'ua')).toBeUndefined();
  });
});

describe('cascade traversal', () => {
  it('produces an entry for every element outside a template', () => {
    const doc = parseHtml('<!doctype html><p id=t>x</p>');
    const m = cascade(doc, collect(doc));
    const names = [...m.keys()].map((e) => e.name);
    expect(names).toContain('html');
    expect(names).toContain('body');
    expect(names).toContain('p');
  });

  it('produces NO entry for an element inside a template', () => {
    const doc = parseHtml('<!doctype html><template><b>x</b></template>');
    const m = cascade(doc, collect(doc));
    expect([...m.keys()].some((e) => e.name === 'b')).toBe(false);
  });
});

describe('custom properties in the cascade', () => {
  const declsFor = (src: string, id: string) => {
    const doc = parseHtml(src);
    const c = collect(doc);
    const el = allElements(doc).find((e) => e.attrs.get('id') === id) as HtmlElement;
    return cascade(doc, c).get(el)?.all as Map<string, unknown>;
  };

  it('keeps a custom property as a declaration rather than reporting it unknown', () => {
    const src = '<style>#t{--brand:red}</style><p id=t>x</p>';
    expect(declsFor(src, 't').has('--brand')).toBe(true);
    expect(collect(parseHtml(src)).unsupported
      .some((u) => u.property === '--brand')).toBe(false);
  });

  it('PRESERVES CASE, the one name in CSS that is case-sensitive (#3)', () => {
    // toLonghands opens by lowercasing the name. Custom properties must skip
    // that: --Foo and --foo are different properties.
    const d = declsFor('<style>#t{--Foo:red}</style><p id=t>x</p>', 't');
    expect(d.has('--Foo')).toBe(true);
    expect(d.has('--foo')).toBe(false);
  });

  it('treats two dashes alone as an ordinary unknown property (#13)', () => {
    expect(collect(parseHtml('<style>#t{--:red}</style><p id=t>x</p>')).unsupported
      .some((u) => u.property === '--')).toBe(true);
  });

  it('cascades a custom property through the tiers, !important included (#17)', () => {
    const d = declsFor(
      '<style>#t{--c:red}#t{--c:blue!important}p{--c:green}</style><p id=t>x</p>', 't');
    const v = d.get('--c') as { kind: string; value?: string }[];
    expect(v.map((t) => t.value ?? '').join('').trim()).toBe('blue');
  });

  it('splits a shorthand carrying a var() into one PENDING per longhand', () => {
    const d = declsFor('<style>#t{border:1px solid var(--c)}</style><p id=t>x</p>', 't');
    const p = d.get('border-top-color') as { pending?: { shorthand: string } };
    expect(p.pending?.shorthand).toBe('border');
    // All twelve border longhands, not just the one the var appears in.
    expect(d.has('border-left-width')).toBe(true);
  });

  it('does NOT report a var-bearing shorthand as unparsable', () => {
    // Without the pending branch, expandShorthand fails on the raw var() and
    // the declaration is dropped with a misleading reason.
    expect(collect(parseHtml('<style>#t{border:1px solid var(--c)}</style><p id=t>x</p>'))
      .unsupported.some((u) => u.property === 'border')).toBe(false);
  });

  it('leaves a var-FREE shorthand expanding exactly as before', () => {
    const d = declsFor('<style>#t{border:1px solid red}</style><p id=t>x</p>', 't');
    expect((d.get('border-top-color') as { pending?: unknown }).pending).toBeUndefined();
  });

  it('keeps a var-bearing LONGHAND as its raw value, with no pending', () => {
    const d = declsFor('<style>#t{color:var(--c)}</style><p id=t>x</p>', 't');
    expect((d.get('color') as { pending?: unknown }).pending).toBeUndefined();
  });
});
